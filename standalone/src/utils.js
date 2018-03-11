exports.serialize = (obj, type) => {
  switch (type) {
    case 'FundingOffer':
      return [
        obj.id,
        obj.symbol,
        obj.mtsCreate,
        obj.mtsUpdate,
        obj.amount,
        obj.amountOrig,
        obj.type,
        null,
        null,
        obj.flags,
        obj.status,
        null,
        null,
        null,
        obj.rate,
        obj.period,
        obj.notify ? 1 : 0,
        obj.hidden ? 1 : 0,
        null,
        obj.insure ? 1 : 0,
        obj.renew ? 1 : 0,
        obj.rateReal
      ]
      break;
    case 'Wallet':
      return [
        obj.type,
        obj.currency,
        obj.balance,
        obj.unsettledInterest,
        obj.balanceAvailable
      ];
      break;
    default:
    return [];
  }
}

exports.deserialize = (arr, type) => {
  switch (type) {
    case 'FundingOffer':
      return {
        id: arr[0],
        symbol: arr[1],
        mtsCreate: arr[2],
        mtsUpdate: arr[3],
        amount: arr[4],
        amountOrig: arr[5],
        type: arr[6],
        _placeholder7: arr[7],
        _placeholder8: arr[8],
        flags: arr[9],
        status: arr[10],
        _placeholder11: arr[11],
        _placeholder12: arr[12],
        _placeholder13: arr[13],
        rate: arr[14],
        period: arr[15],
        notify: arr[16] === 1,
        hidden: arr[17] === 1,
        insure: arr[18] === 1,
        renew: arr[19] === 1,
        rateReal: arr[20]
      }
      break;
    case 'Wallet':
      return {
        type: arr[0],
        currency: arr[1],
        balance: arr[2],
        unsettledInterest: arr[3],
        balanceAvailable: arr[4]
      };
      break;
    default:
    return {};
  }
}
