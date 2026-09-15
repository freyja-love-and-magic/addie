import sessionless from 'sessionless-node';

const get = async (url) => {
  return await fetch(url);
};

const post = async (url, payload) => {
  return await fetch(url, {
    method: 'post',
    body: JSON.stringify(payload),
    headers: {'Content-Type': 'application/json'}
  });
};

const put = async (url, payload) => {
  return await fetch(url, {
    method: 'put',
    body: JSON.stringify(payload),
    headers: {'Content-Type': 'application/json'}
  });
};

const _delete = async (url, payload) => {
  return await fetch(url, {
    method: 'delete',
    body: JSON.stringify(payload),
    headers: {'Content-Type': 'application/json'}
  });
};

const patch = async (url, payload) => {
  return await fetch(url, {
    method: 'patch',
    body: JSON.stringify(payload),
    headers: {'Content-Type': 'application/json'}
  });
};

const addie = {
  baseURL: 'https://dev.addie.allyabase.com/',

  /**
   * Configure the Addie client for different environments
   * @param {Object} config - Configuration options
   * @param {string} config.baseURL - Direct base URL (e.g., 'http://127.0.0.1:5116/')
   * @param {string} config.wikiBaseURL - Wiki proxy base URL (e.g., 'http://127.0.0.1:5124')
   *                                      Will construct URL as: {wikiBaseURL}/plugin/allyabase/addie/
   */
  configure: (config) => {
    if (config.wikiBaseURL) {
      // Wiki proxy mode: route through wiki plugin
      addie.baseURL = `${config.wikiBaseURL.replace(/\/$/, '')}/plugin/allyabase/addie/`;
    } else if (config.baseURL) {
      // Direct mode: use base URL as-is
      addie.baseURL = config.baseURL.endsWith('/') ? config.baseURL : config.baseURL + '/';
    }
  },

  createUser: async (saveKeys, getKeys) => {
    const keys = (await getKeys()) || (await sessionless.generateKeys(saveKeys, getKeys))
    sessionless.getKeys = getKeys;

    const payload = {
      timestamp: new Date().getTime() + '',
      pubKey: keys.pubKey
    };
console.log('signing', payload.timestamp + payload.pubKey);

    payload.signature = await sessionless.sign(payload.timestamp + payload.pubKey);

    const res = await put(`${addie.baseURL}user/create`, payload);
    const user = await res.json();
console.log('response from addie', user);
    const uuid = user.uuid;

    return uuid;
  },

  getUserByUUID: async (uuid) => {
    const timestamp = new Date().getTime() + '';
    
    const message = timestamp + uuid;
    
    const signature = await sessionless.sign(message);

    const res = await get(`${addie.baseURL}user/${uuid}?signature=${signature}&timestamp=${timestamp}`);
    const user = await res.json();
    
    return user;
  },

  addProcessorAccount: async (uuid, processor, country, name, email) => {
    const timestamp = new Date().getTime() + '';
    const message = timestamp + uuid + name + email;
    const signature = await sessionless.sign(message);

    const payload = {
      timestamp,
      country,
      name,
      email,
      signature
    };

    const url = `${addie.baseURL}user/${uuid}/processor/${processor}`;
    const res = await put(url, payload);
    const user = await res.json();

    return user;
  },

  getPaymentIntent: async (uuid, processor, amount, currency, payees) => {
    const timestamp = new Date().getTime() + '';
    const message = timestamp + uuid + amount + currency;
    const signature = await sessionless.sign(message);

    const payload = {
	timestamp,
	amount,
	currency,
	"payees": payees,
	"signature": signature
    };

    const url = `${addie.baseURL}user/${uuid}/processor/${processor}/intent`;
    const res = await post(url, payload);   //  Start here
    const intent = await res.json();

    return intent;
  },

  getPaymentIntentWithoutSplits: async (uuid, processor, amount, currency, savePaymentMethod = false) => {
    const timestamp = new Date().getTime() + '';
    const message = timestamp + uuid + amount + currency;
    const signature = await sessionless.sign(message);

    const payload = {
	timestamp,
	amount,
	currency,
	savePaymentMethod,
	"signature": signature
    };

    const url = `${addie.baseURL}user/${uuid}/processor/${processor}/intent-without-splits`;
    const res = await post(url, payload);
    const intent = await res.json();

    return intent;
  },

  // Payment Method Management
  createSetupIntent: async (processor = 'stripe') => {
    const timestamp = new Date().getTime() + '';
    const keys = await sessionless.getKeys();
    const message = timestamp + (keys.pubKey || '');
    const signature = await sessionless.sign(message);

    const payload = {
      timestamp,
      pubKey: keys.pubKey,
      signature
    };

    const url = `${addie.baseURL}processor/${processor}/setup-intent`;
    const res = await post(url, payload);
    const setupIntent = await res.json();

    return setupIntent;
  },

  getSavedPaymentMethods: async (uuid, processor = 'stripe') => {
    const timestamp = new Date().getTime() + '';
    const message = timestamp + uuid;
    const signature = await sessionless.sign(message);

    const url = `${addie.baseURL}saved-payment-methods?uuid=${uuid}&timestamp=${timestamp}&processor=${processor}&signature=${signature}`;
    const res = await get(url);
    const result = await res.json();

    return result;
  },

  deleteSavedPaymentMethod: async (uuid, paymentMethodId, processor = 'stripe') => {
    const timestamp = new Date().getTime() + '';
    const message = timestamp + uuid;
    const signature = await sessionless.sign(message);

    const payload = {
      timestamp,
      signature
    };

    const url = `${addie.baseURL}saved-payment-methods/${paymentMethodId}`;
    const res = await _delete(url, payload);
    const result = await res.json();

    return result;
  },

  // Stripe Issuing (Virtual Cards)
  createCardholder: async (individualInfo) => {
    const timestamp = new Date().getTime() + '';
    const keys = await sessionless.getKeys();
    const message = timestamp + keys.pubKey;
    const signature = await sessionless.sign(message);

    const payload = {
      timestamp,
      pubKey: keys.pubKey,
      signature,
      individualInfo
    };

    const url = `${addie.baseURL}issuing/cardholder`;
    const res = await post(url, payload);
    const result = await res.json();

    return result;
  },

  issueVirtualCard: async (currency = 'usd', spendingLimit) => {
    const timestamp = new Date().getTime() + '';
    const keys = await sessionless.getKeys();
    const message = timestamp + keys.pubKey;
    const signature = await sessionless.sign(message);

    const payload = {
      timestamp,
      pubKey: keys.pubKey,
      signature,
      currency,
      spendingLimit
    };

    const url = `${addie.baseURL}issuing/card/virtual`;
    const res = await post(url, payload);
    const result = await res.json();

    return result;
  },

  getIssuedCards: async () => {
    const timestamp = new Date().getTime() + '';
    const keys = await sessionless.getKeys();
    const message = timestamp + keys.pubKey;
    const signature = await sessionless.sign(message);

    const url = `${addie.baseURL}issuing/cards?timestamp=${timestamp}&pubKey=${keys.pubKey}&signature=${signature}`;
    const res = await get(url);
    const result = await res.json();

    return result;
  },

  getCardTransactions: async (limit = 10) => {
    const timestamp = new Date().getTime() + '';
    const keys = await sessionless.getKeys();
    const message = timestamp + keys.pubKey;
    const signature = await sessionless.sign(message);

    const url = `${addie.baseURL}issuing/transactions?timestamp=${timestamp}&pubKey=${keys.pubKey}&signature=${signature}&limit=${limit}`;
    const res = await get(url);
    const result = await res.json();

    return result;
  },

  updateCardStatus: async (cardId, status) => {
    const timestamp = new Date().getTime() + '';
    const keys = await sessionless.getKeys();
    const message = timestamp + keys.pubKey + cardId + status;
    const signature = await sessionless.sign(message);

    const payload = {
      timestamp,
      pubKey: keys.pubKey,
      signature,
      status
    };

    const url = `${addie.baseURL}issuing/card/${cardId}/status`;
    const res = await patch(url, payload);
    const result = await res.json();

    return result;
  },

  // Transfer Processing
  processPaymentTransfers: async (paymentIntentId) => {
    const url = `${addie.baseURL}payment/${paymentIntentId}/process-transfers`;
    const res = await post(url, {});
    const result = await res.json();

    return result;
  },

  // Distinct from processPaymentTransfers above: that one moves funds to
  // payout *cards* (Stripe Issuing), this one settles splits to Stripe
  // Connected Accounts. Two different server routes, two different
  // processors on Addie's side — a Connect payout has to use this one.
  processConnectedTransfers: async (paymentIntentId) => {
    const url = `${addie.baseURL}payment/${paymentIntentId}/process-connected-transfers`;
    const res = await post(url, {});
    const result = await res.json();

    return result;
  },

  deleteUser: async (uuid) => {
    const timestamp = new Date().getTime() + '';

    const signature = await sessionless.sign(timestamp + uuid);
    const payload = {timestamp, uuid, signature};


    const res = await _delete(`${addie.baseURL}user/${uuid}`, payload);
    return res.status === 200;
  }
};

export default addie;
