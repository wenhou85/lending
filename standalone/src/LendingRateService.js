const Rx = require('rxjs/Rx');
const Big = require('big.js');
const BFX = require('bitfinex-api-node');

class LendingRateService {
  constructor(bfxConfig, gcool) {
    this.bfx = new BFX({
      apiKey: bfxConfig.public,
      apiSecret: bfxConfig.private,
      ws: {
        autoReconnect: true,
        seqAudit: false,
        packetWDDelay: 10 * 1000
      }
    });
    this.rest1 = Promise.promisifyAll(this.bfx.rest(1, {
      transform: true
    }));
    this.gcool = gcool;
    this.rate = null;
    this.period = process.env.LENDING_PERIOD || 2;
    this.size = 1;
    this.getRate = this.getRate.bind(this);
    //every 10 seconds calc best rate
    this.rateSubject = new Rx.BehaviorSubject({rate: this.rate, period: this.period, size: this.size});
    Rx.Observable.interval(10000).flatMap(() => {
      return this.getRate();
    }).subscribe(rec => {
      this.rate = rec.rate;
      this.period = rec.period;
      this.size = rec.size;
      this.rateSubject.next(rec);
    });
  }

  getRate() {
    return this.rest1.fundingbookAsync('usd', {})
    .then(book => {
      const highBid = Big(book.bids[0].rate);
      const lowAsk = Big(book.asks[0].rate);
      let bestRate = Big(book.asks[0].rate);

      //minimum rate which bot is willing to lend.
      const minAcceptableRate = Big(process.env.MIN_ACCEPTABLE_RATE || 3.65);
      const maxPeriodRate = Big(process.env.MAX_PERIOD_RATE || 100.00);
      const frontRunMargin = Big(process.env.FRONT_RUN_MARGIN || 0.01825);
      const maxPeriod = 30;

      //lend at a rate right below the threshold || 100k usd
      let bookThreshold = Big(process.env.BOOK_THRESHOLD || 100000);

      let bookCounter = Big(0);
      book.asks.some(ask => {
        //check if counter is less than threshold
        //catch the rate below threshold not inclusive (add counter first)
        bookCounter = bookCounter.plus(ask.amount);
        if (bookCounter.cmp(bookThreshold) === -1) {
          bestRate = Big(ask.rate);
          return false;
        }

        //best rate is already set to lowest ask
        return true;
      });

      //0.00005*365 rate to front run the big order.
      const finalRate = bestRate.minus(frontRunMargin);
      let finalPeriod = Big(this.period);

      if (finalRate.cmp(maxPeriodRate) === 1) {
        finalPeriod = Big(maxPeriod);
      }

      return {
        rate: finalRate.valueOf(),
        period: finalPeriod.valueOf(),
        size: this.size
      };
    });
  }

  subscribe(subObj) {
    return this.rateSubject.subscribe(subObj);
  }
}

module.exports = LendingRateService;
