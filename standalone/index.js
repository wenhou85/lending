// env vars
require('dotenv').config()
global.Promise = require('bluebird');
const GCOOL_URL = process.env.GCOOL_URL;
const GCOOL_TOKEN = process.env.GCOOL_TOKEN;
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const SLACK_VERIFICATION_TOKEN = process.env.SLACK_VERIFICATION_TOKEN;
const PORT = process.env.PORT || 3000;

//health check for elastic beanstalk
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const helmet = require('helmet');

app.use(helmet());
app.use(bodyParser.json({strict: true}));
app.use(bodyParser.urlencoded({extended: true}));

//health check
app.get('/health', (req, res, next) => {
  res.send('ok');
});

// used by microservice for client accounts
const GraphQLClient = require('graphql-request').GraphQLClient;

const gcool = new GraphQLClient(GCOOL_URL, {
  headers: {
    Authorization: `Bearer ${GCOOL_TOKEN}`,
  },
})

//for maintenance start and end
const BFX = require('bitfinex-api-node');

const bfx = new BFX({
  apiKey: process.env.PUBLIC_KEY,
  apiSecret: process.env.PRIVATE_KEY,
  ws: {
    autoReconnect: true,
    seqAudit: false,
    packetWDDelay: 10 * 1000
  }
});

const bfxConfig = {
  public: process.env.PUBLIC_KEY,
  private: process.env.PRIVATE_KEY
};

const bws2 = bfx.ws(2, {
  transform: false
});

//services
const LendingRateService = require('./src/LendingRateService');
const LendingService = require('./src/LendingService');

gcool.request(`{
  Account(
    id: "${process.env.IBB_ACCOUNT_ID}"
  ) {
    id
  }
}`)
.then(res => {
  if (!res.Account) {
    throw 'No IBB Account';
  }
  console.log('Start up!')
  console.log(res.Account)
  const lendingRateService = new LendingRateService(bfxConfig, gcool);
  const lendingService = new LendingService({bfxConfig, gcool, period: Number(process.env.LENDING_PERIOD), accountId: res.Account.id});
  lendingRateService.subscribe({
    next: (newRate) => {
      lendingService.changePeriod(lendingRateService.getPeriod());
      lendingService.onUpdateRate(newRate);
    },
    error: console.log
  });

  //control routes
  app.post('/slash', (req, res, next) => {
    const token = req.body.token;
    const cmd = req.body.text && req.body.text.toLowerCase();

    if (SLACK_VERIFICATION_TOKEN !== token) {
      return res.status(403).send('Not valid token');
    }

    if (cmd === 'on' && !lendingService.isOn) {
      //turn on
      lendingService.start();
    } else if (cmd === 'off' && lendingService.isOn) {
      //turn off
      lendingService.stop();
    }

    return res.status(200).send(`Lending Service ${lendingService.isOn ? 'on' : 'off'}.`);
  });

  lendingService.start();
})
.catch(err => {
  console.log(err);
})

/*handle maintenance*/
bws2.onMaintenanceStart(() => {
  console.log('info: maintenance period started')
  // pause activity untill further notice
  lendingService.stop();
})

bws2.onMaintenanceEnd(() => {
  console.log('info: maintenance period ended')
  // resume activity
  lendingService.start();
})

bws2.onServerRestart(() => {
  console.log('info: bitfinex ws server restarted')
  // ws.reconnect() // if not using autoReconnect
})
/**/

app.listen(PORT, () => {
  console.log(`express server listening on port ${PORT}`);
})
