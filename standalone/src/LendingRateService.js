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
    this.period = 2;
    this.getRate = this.getRate.bind(this);
    //every 10 seconds calc best rate
    this.rateSubject = new Rx.BehaviorSubject(null);
    Rx.Observable.interval(60000).flatMap(() => {
      return this.getRate();
    }).subscribe(r => {
      this.rate = r;
      this.rateSubject.next(r);
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
      //lend at a rate right below the threshold || 100k usd
      let bookThreshold = Big(process.env.BOOK_THRESHOLD || 300000);

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
      if (bestRate.minus(0.01825).valueOf() >  Big(process.env.MAX_PERIOD_RATE).valueOf()) {
        this.setPeriod(30);
      } else {
        this.setPeriod(Big(process.env.LENDING_PERIOD).valueOf());
      }
      return bestRate.minus(0.01825).valueOf();
    });
  }
  setPeriod(period){
    this.period = period;
  }
  getPeriod(){
    return this.period;
  }
  subscribe(subObj) {
    return this.rateSubject.subscribe(subObj);
  }
}

module.exports = LendingRateService;
