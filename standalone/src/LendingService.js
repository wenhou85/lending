const utils = require('./utils')
const Big = require('big.js');
const BFX = require('bitfinex-api-node');
const bird = require('bluebird');
const { Map } = require('immutable');

const defaultErrorHandler = (id, e) => {
  console.log(`Error on ${id}`);
  console.log(e);
};

class LendingService {
  constructor({bfxConfig, gcool, accountId = '1', direction = 'lend', errorHandler = defaultErrorHandler}) {
    this.isOn = false;
    this.accountId = accountId;
    this.direction = direction;
    this.bfx = new BFX({
      apiKey: bfxConfig.public,
      apiSecret: bfxConfig.private,
      ws: {
        autoReconnect: true,
        seqAudit: false,
        packetWDDelay: process.env.REFRESH_TIMER
      }
    });

    this.gcool = gcool;
    this.bws2 = this.bfx.ws(2, {
      transform: false
    });
    this.rest1 = Promise.promisifyAll(this.bfx.rest(1, {
      transform: true
    }));
    this.rest2 = Promise.promisifyAll(this.bfx.rest(2, {
      transform: true
    }));

    this.wallet = {
      type: 'funding',
      currency: 'USD',
      balance: '0',
      unsettledInterest: '0',
      balanceAvailable: '0'
    };
    this.currency = 'USD';
    this.errorHandler = errorHandler;
    this.dailyTimer = null;

    this.fundingOffers = Map();
  }

  start() {
    //setup 5 minute wallet balance timer in case walletUpdate doesn't trigger
    this.dailyTimer = setInterval(() => {
      this.rest1.wallet_balancesAsync()
      .then(res => {
        const foundWallet = res.find(w => {
          return (w.type === 'deposit' && w.currency === 'usd');
        });

        if (foundWallet) {
          this.wallet.balance = foundWallet.amount;
          this.wallet.balanceAvailable = foundWallet.available;
        }
      })
    }, (5 * 60 * 1000))

    //setup listeners
    this.bws2.on('error', (err) => {
      console.log(`error on account: ${this.accountId}`, err);
      if (this.errorHandler) {
        this.errorHandler(this.accountId, err);
      }
    });

    this.bws2.on('open', () => {
      console.log(`connected: ${this.accountId}`);
      this.bws2.auth();
    });

    this.bws2.on('close', () => {
      console.log(`disconnected: ${this.accountId}`);
    })

    this.bws2.once('auth', () => {
      console.log('authenticated');

      //wallet on startup
      this.bws2.onWalletSnapshot({cbGID: this.accountId}, (res) => {
        console.log(`wallet snapshot for ${this.accountId}`)
        res = res.map(r => utils.deserialize(r, 'Wallet'));
        const wallet = res.find(w => {
          return (w.type === 'funding' && w.currency === 'USD');
        });

        if (wallet) {
          this.wallet = wallet;
          //get available balance from rest1 because ws2 returns null
          this.rest1.wallet_balancesAsync()
          .then(wallets => {
            const rest1Wallet = wallets.find(w => {
              return (w.type === 'deposit' && w.currency === 'usd');
            });

            if (rest1Wallet) {
              this.wallet.balanceAvailable = Number(rest1Wallet.available);
            }

            console.log(this.wallet)
          })
          .catch(err => {
            this.errorHandler(this.accountId, err);
          });
        };

      });

      //wallet updates
      this.bws2.onWalletUpdate({cbGID: this.accountId}, (res) => {
        console.log(`wallet update for ${this.accountId}`)
        res = utils.deserialize(res, 'Wallet');
        if (res.type === 'funding' && res.currency === 'USD') {
          this.wallet = res;
          //get available balance from rest1 because ws2 returns null
          this.rest1.wallet_balancesAsync()
          .then(wallets => {
            const rest1Wallet = wallets.find(w => {
              return (w.type === 'deposit' && w.currency === 'usd');
            });

            if (rest1Wallet) {
              this.wallet.balanceAvailable = Number(rest1Wallet.available);
            }

            console.log(this.wallet)
          })
          .catch(err => {
            this.errorHandler(this.accountId, err);
          });
        }
      });

      //once at startup
      //this does not catch manually canceled offers from UI before it starts up
      //its ok because it will create a new offer if one doesn't exist anyway.
      //if one exists then it will be added to db and canceled at the next loop
      this.bws2.onFundingOfferSnapshot({symbol: 'fUSD', cbGID: this.accountId}, (res) => {
        console.log(`offer snapshot for ${this.accountId}`)
        res = res.map(r => utils.deserialize(r, 'FundingOffer'))
        console.log(res)
        bird.map(res, r => {
          this.fundingOffers = this.fundingOffers.set(r.id, r);
          if (r.status.startsWith('EXECUTED')) {
            return this.gcool.request(`{
              FundingOffer(
                offerId: "${r.id}"
              ) {
                id
              }
            }`)
            .then(resFund => {
              if (!resFund.FundingOffer) {
                //create an offer in gcool
                return this.gcool.request(`mutation {
                  createFundingOffer(
                    offerId: "${r.id}",
                    accountId: "${this.accountId}",
                    amount: ${r.amount},
                    rate: ${r.rateReal},
                    period: ${r.period},
                    status: "${r.status}"
                  ) {
                    id
                  }
                }`);
              }

              return this.gcool.request(`mutation {
                updateFundingOffer(
                  id: "${resFund.FundingOffer.id}",
                  amount: ${r.amount},
                  rate: ${r.rateReal},
                  period: ${r.period},
                  status: "${r.status}"
                ) {
                  id
                }
              }`);
            });
          }

          return Promise.resolve(r)
        })
        .catch(err => {
          this.errorHandler(this.accountId, err);
        })
      });

      //everytime a new offer is made or modified (happens twice)
      this.bws2.onFundingOfferNew({symbol: 'fUSD', cbGID: this.accountId}, (res) => {
        console.log(`offer new for ${this.accountId}`)
        res = utils.deserialize(res, 'FundingOffer')
        this.fundingOffers = this.fundingOffers.set(res.id, res);
        if (res.status.startsWith('EXECUTED')) {
          return this.gcool.request(`mutation {
            createFundingOffer(
              offerId: "${res.id}",
              accountId: "${this.accountId}",
              amount: ${res.amount},
              rate: ${res.rateReal},
              period: ${res.period},
              status: "${res.status}"
            ) {
              id
            }
          }`)
          .then(gcoolRes => {

          })
          .catch(err => {
            this.errorHandler(this.accountId, err);
          })
        }

        return Promise.resolve(res);
      })

      //everytime an offer is modified (changes state)
      this.bws2.onFundingOfferUpdate({symbol: 'fUSD', cbGID: this.accountId}, (res) => {
        console.log(`offer update for ${this.accountId}`)
        res = utils.deserialize(res, 'FundingOffer')
        this.fundingOffers = this.fundingOffers.set(res.id, res);
        if (res.status.startsWith('EXECUTED')) {
          return this.gcool.request(`mutation {
            createFundingOffer(
              offerId: "${res.id}",
              accountId: "${this.accountId}",
              amount: ${res.amount},
              rate: ${res.rateReal},
              period: ${res.period},
              status: "${res.status}"
            ) {
              id
            }
          }`)
          .then(gcoolRes => {

          })
          .catch(err => {
            this.errorHandler(this.accountId, err);
          })
        }

        return Promise.resolve(res);
      });

      //everytime offer is cancelled or modified (new order is made)
      this.bws2.onFundingOfferClose({symbol: 'fUSD', cbGID: this.accountId}, (res) => {
        console.log(`offer close for ${this.accountId}`)
        res = utils.deserialize(res, 'FundingOffer')
        console.log(res)
        try {
          this.fundingOffers = this.fundingOffers.delete(res.id);
          //NOTE no wallet update event is triggered by bitfinex
          //update balance manually
          this.rest1.wallet_balancesAsync()
          .then(wallets => {
            const rest1Wallet = wallets.find(w => {
              return (w.type === 'deposit' && w.currency === 'usd');
            });

            if (rest1Wallet) {
              this.wallet.balance = Number(rest1Wallet.amount);
              this.wallet.balanceAvailable = Number(rest1Wallet.available);
            }

            console.log(this.wallet)
          })
          .catch(err => {
            this.errorHandler(this.accountId, err);
          });
        } catch (err) {
          this.errorHandler(this.accountId, err);
        }
      })

      this.bws2.onFundingInfoUpdate({symbol: 'fUSD', cbGID: this.accountId}, (res) => {
        console.log(`funding info update for ${this.accountId}`)
        console.log(res)
      })

    });

    if (!this.bws2.isOpen()) {
      this.bws2.open();
    }

    this.isOn = true;
  }

  stop() {
    this.bws2.removeListeners(this.accountId);
    if (this.dailyTimer) {
      clearInterval(this.dailyTimer);
    }

    if (this.bws2.isOpen()) {
      this.bws2.close();
    }
    this.isOn = false;
  }

  onUpdateRate({ rate, period, size}) {
    if (!this.isOn) {
      console.log(`Lending service is ${this.isOn ? 'on' : 'off'}.`);
      return;
    }
    //handle new rate
    //check available balance over 50.00 (minimum offer size)
    const availableAmount = Big(this.wallet.balanceAvailable);
    const newRate = Big(rate);
    const offerSize = availableAmount.times(size).round(2, 0);

    console.log(`${this.accountId} | new daily rate: ${newRate.div(365).valueOf()} | new annual rate: ${newRate.valueOf()} | available amount: ${availableAmount.valueOf()} | offer size: ${offerSize.valueOf()} | period: ${period}`);
    console.log(`current funding offers for ${this.accountId}`, this.fundingOffers.toJS())

    if (offerSize.cmp(50.00) === 1 || this.fundingOffers.size > 0) {
      let cancelPromise;
      if (this.fundingOffers.size < 1) {
        cancelPromise = Promise.resolve();
      } else {
        const currOffers = this.fundingOffers.entrySeq()
        cancelPromise = Promise.map(currOffers, ([key, val]) => {
          return this.cancelOffer({offerId: key})
          .catch(cancelErr => {
            //if an error were manually canceled
            //it might be missed by listeners
            //it will try to cancel again in next newRate (its ok)
            this.errorHandler(this.accountId, cancelErr);
            return cancelErr
          });
        })
        .then(() => {
          //get new available amount
          this.rest1.wallet_balancesAsync()
          .then(res => {
            const foundWallet = res.find(w => {
              return (w.type === 'deposit' && w.currency === 'usd');
            });

            if (foundWallet) {
              this.wallet.balance = foundWallet.amount;
              this.wallet.balanceAvailable = foundWallet.available;
            }
          })
        })
      }

      cancelPromise
      .then(() => {
        const offerObj = {
          currency: this.currency,
          amount: offerSize.valueOf(),
          rate: newRate.round(2, 0).valueOf(),
          period: Number(period),
          direction: this.direction
        };
        console.log(`create new offer for ${this.accountId}`, offerObj);
        return this.createOffer(offerObj);
      });
    }
  }

  createOffer({currency, amount, rate, period, direction}) {
    return this.rest1.new_offerAsync(currency, amount, rate, period, direction)
    .then(res => {
      //success create
    })
    .catch(err => {
      this.errorHandler(this.accountId, err);
    });
  }

  cancelOffer({offerId}) {
    return this.rest1.cancel_offerAsync(offerId)
    .then(res => {
      //success cancel
    })
    .catch(err => {
      this.errorHandler(this.accountId, err);
    });
  }
}
module.exports = LendingService;
