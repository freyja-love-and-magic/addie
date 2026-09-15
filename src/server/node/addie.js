import express from 'express';
import cors from 'cors';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import user from './src/user/user.js';
import processors from './src/processors/processors.js';
import MAGIC from './src/magic/magic.js';
import db from './src/persistence/db.js';
import fount from 'fount-js';
import bdo from 'bdo-js';
import sessionless from 'sessionless-node';
import _stripe from 'stripe';
import stripeConnectedTransfers from './src/processors/stripe-connected-transfers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const addieStripeURL = process.env.ADDIE_STRIPE_URL;
const stripe = processors.stripe;
const stripeSDK = _stripe(process.env.STRIPE_KEY);

const allowedTimeDifference = 300000; // keep this relaxed for now

const app = express();
app.use(express.static(join(__dirname, '../../../public'))); // Serve static files FIRST - before timestamp check
app.use(cors());
app.use(express.json());

const SUBDOMAIN = process.env.SUBDOMAIN || 'dev';
fount.baseURL = process.env.LOCALHOST ? 'http://localhost:3006/' : `${SUBDOMAIN}.fount.allyabase.com/`;
bdo.baseURL = process.env.LOCALHOST ? 'http://localhost:3003/' : `${SUBDOMAIN}.bdo.allyabase.com/`;
const bdoHashInput = `${SUBDOMAIN}addie`;

const bdoHash = createHash('sha256').update(bdoHashInput).digest('hex');

const repeat = (func) => {
  setTimeout(func, 2000);
};

const bootstrap = async () => {
  try {
    const fountUser = await fount.createUser(db.saveKeys, db.getKeys);
console.log('f', fountUser);
    const bdoUUID = await bdo.createUser(bdoHash, {}, () => {}, db.getKeys);
console.log('b', bdoUUID);
    const spellbooks = await bdo.getSpellbooks(bdoUUID, bdoHash);
    const addie = {
      uuid: 'addie',
      fountUUID: fountUser.uuid,
      fountPubKey: fountUser.pubKey,
      bdoUUID,
      spellbooks
    };

    if(!addie.fountUUID || !addie.bdoUUID || !spellbooks) {
      throw new Error('bootstrap failed');
    }

    await db.saveUser(addie);
  } catch(err) {
console.warn(err);
    repeat(bootstrap);
  }
};

// Skip Fount/BDO bootstrap if SKIP_BOOTSTRAP is set (for standalone/Mutopia mode)
if (process.env.SKIP_BOOTSTRAP !== 'true') {
  repeat(bootstrap);
} else {
  console.log('Skipping Fount/BDO bootstrap (SKIP_BOOTSTRAP=true)');
}

app.use((req, res, next) => {
  const requestTime = +req.query.timestamp || +req.body.timestamp;
  const now = new Date().getTime();
  if(Math.abs(now - requestTime) > allowedTimeDifference) {
    return res.send({error: 'no time like the present'});
  }
  next();
});

app.use((req, res, next) => {
  console.log('\n\n', req.body, '\n\n');
  next();
});

app.put('/user/create', async (req, res) => {
  try {
    const pubKey = req.body.pubKey;
    const message = req.body.timestamp +  pubKey;
    const signature = req.body.signature;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
console.log('auth error');
      res.status(403);
      return res.send({error: 'auth error'});
    }

    // Check if user already exists with this pubKey
    let foundUser;
    try {
      foundUser = await user.getUserByPublicKey(pubKey);
    }
    catch(err) {
console.log('no user found. Creating a new one');
    }

    // If user doesn't exist, create new one
    if(!foundUser) {
      foundUser = await user.putUser({ pubKey });
console.log('Created new user:', foundUser.uuid);
    } else {
console.log('Found existing user:', foundUser.uuid);
    }

    res.send(foundUser);
  } catch(err) {
console.warn(err);
    res.status(404);
    res.send({error: 'not found'});
  }
});

app.get('/user/:uuid', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    const timestamp = req.query.timestamp;
    const signature = req.query.signature;
    const message = timestamp + uuid;

    const foundUser = await user.getUserByUUID(req.params.uuid);

    if(!signature || !sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'auth error'});
    }

    res.send(foundUser);
  } catch(err) {
    res.status(404);
    res.send({error: 'not found'});
  }
});

app.put('/user/:uuid/processor/:processor', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    const processor = req.params.processor;
    const body = req.body;
    const timestamp = body.timestamp;
    const country = body.country;
    const name = body.name;
    const email = body.email;
    const signature = body.signature;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid + name + email;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    let updatedUser = foundUser;

    switch(processor) {
      case 'stripe': 
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}user/${uuid}/processor/stripe`, 
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          updatedUser = await stripe.putStripeAccount(foundUser, country, name, email, ip);
        }
        break;
      default: throw new Error('processor not found');
    }

    res.send(updatedUser);
  } catch(err) {
console.warn(err);
    res.status(404);
console.log('set status');
    res.send({error: err});
  }
});

app.put('/user/:uuid/processor/:processor/express', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    const processor = req.params.processor;
    const body = req.body;
    const timestamp = body.timestamp;
    const country = body.country;
    const email = body.email;
    const refreshUrl = body.refreshUrl;
    const returnUrl = body.returnUrl;
    const signature = body.signature;

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid + email;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    let updatedUser = foundUser;

    switch(processor) {
      case 'stripe': 
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}user/${uuid}/processor/stripe/express`, 
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          updatedUser = await stripe.putStripeExpressAccount(foundUser, country, email, refreshUrl, returnUrl);
        }
        break;
      default: throw new Error('processor not found');
    }

    res.send(updatedUser);
  } catch(err) {
console.warn(err);
    res.status(404);
console.log('set status');
    res.send({error: err});
  }
});

app.post('/user/:uuid/processor/:processor/intent', async (req, res) => {
  try {
console.log('trying to get payment intent');
    const uuid = req.params.uuid;
    const processor = req.params.processor;
    const body = req.body;
    const timestamp = body.timestamp;
    const amount = body.amount;
    const currency = body.currency;
    const nonce = body.nonce;
    const payees = body.payees;
    const merchant = body.merchant;
    const savePaymentMethod = body.savePaymentMethod;
    const signature = body.signature;

    // Extract product info from request body (optional)
    const productInfo = {
      productName: body.productName,
      productId: body.productId,
      contractUuid: body.contractUuid,
      emojicode: body.emojicode
    };

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid + amount + currency;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }
console.log('past auth');

    foundUser.nonce = nonce;

    let paymentTokenResponse;

    switch(processor) {
      case 'stripe': 
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}user/${uuid}/processor/stripe/intent`, 
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          paymentTokenResponse = await stripe.getStripePaymentIntent(foundUser, amount, currency, payees, savePaymentMethod, productInfo, merchant);
        }
        break;
      case 'square': paymentTokenResponse = await square.getSquarePaymentIntent(foundUser, amount, currency, payees, savePaymentMethod);
        break;
      default: throw new Error('processor not found');
    }

console.log('paymentTokenResponse', paymentTokenResponse);

    res.send(paymentTokenResponse);
  } catch(err) {
console.log(err);
    res.status(404);
    res.send({error: err});
  }
});

app.post('/user/:uuid/processor/:processor/intent-without-splits', async (req, res) => {
  try {
console.log('trying to get payment intent');
    const uuid = req.params.uuid;
    const processor = req.params.processor;
    const body = req.body;
    const timestamp = body.timestamp;
    const amount = body.amount;
    const currency = body.currency;
    const savePaymentMethod = body.savePaymentMethod;
    const signature = body.signature;

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid + amount + currency;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }
console.log('past auth');

    let paymentTokenResponse;

    switch(processor) {
      case 'stripe': 
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}user/${uuid}/processor/stripe/intent-without-splits`, 
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          paymentTokenResponse = await stripe.getStripePaymentIntentWithoutSplits(foundUser, amount, currency, savePaymentMethod);
        }
        break;
      default: throw new Error('processor not found');
    }

console.log('paymentTokenResponse', paymentTokenResponse);

    res.send(paymentTokenResponse);
  } catch(err) {
console.log(err);
    res.status(404);
    res.send({error: err});
  }
});

app.get('/saved-payment-methods', async (req, res) => {
  try {
    const uuid = req.query.uuid;
    const timestamp = req.query.timestamp;
    const processor = req.query.processor;
    const signature = req.query.signature;

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    switch(processor) {
      case 'stripe':
        // Get both saved payment methods and issued cards
        const savedMethods = await stripe.getSavedPaymentMethods(foundUser);
        const issuedCards = await stripe.getIssuedCards(foundUser);

        // Combine the results
        const combinedResult = {
          paymentMethods: savedMethods.paymentMethods || [],
          issuedCards: issuedCards.cards || []
        };

console.log('Combined payment methods and issued cards:',
  combinedResult.paymentMethods.length, 'payment methods,',
  combinedResult.issuedCards.length, 'issued cards');

        res.json(combinedResult);
        break;
      default: throw new Error('processor not found');
    }
  } catch(err) {
console.log(err);
    res.status(404);
    res.send({error: err});
  }
});

app.post('/charge-with-saved-method', async (req, res) => {
  try {
    const body = req.body;
    const uuid = body.uuid;
    const timestamp = body.timestamp;
    const signature = body.signature;
    const amount = body.amount;
    const currency = body.currency;
    const paymentMethodId = body.paymentMethodId;
    const payees = body.payees || [];

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid + amount + paymentMethodId;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const result = await stripe.chargeWithSavedPaymentMethod(
      foundUser, 
      amount, 
      currency, 
      paymentMethodId,
      payees || []
    );

    res.send(result);
  } catch(err) {
console.error(err);
    res.status(404);
    res.send({error: err});
  }
});

app.post('/payment-methods-and-intent', async (req, res) => {
  try {
    const body = req.body;
    const uuid = body.uuid;
    const amount = body.amount;
    const currency = body.currency;
    const paymentMethodId = body.paymentMethodId;
    const payees = body.payees || [];

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid + amount + paymentMethodId;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const savedMethods = await stripe.getSavedPaymentMethods(foundUser);
    const paymentIntent = await stripe.getStripePaymentIntent(foundUser, amount, currency, payees, savePaymentMethod);
    
    res.send({
      savedMethods,
      paymentIntent
    });
  } catch(err) {
console.error(err);
    res.status(404);
    res.send({error: err});
  }
});

app.delete('/saved-payment-methods/:paymentMethodId', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    const timestamp = req.params.timestamp;
    const processor = req.params.processor;
    const paymentMethodId = req.params.paymentMethodId;
    const signature = req.params.signature;

    const foundUser = await user.getUserByUUID(uuid);

    const message = timestamp + uuid;

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const result = await stripe.removeSavedPaymentMethod(foundUser, paymentMethodId);
    res.json(result);
  } catch (error) {
console.error(err);
    res.status(404);
    res.send({error: err});
  }
});

app.post('/processor/:processor/setup-intent', async (req, res) => {
  try {
    const processor = req.params.processor;
    const body = req.body;
    const timestamp = body.timestamp;
    const customerId = body.customerId;
    const pubKey = body.pubKey;
    const signature = body.signature;

    // Message for authentication
    const message = timestamp + (pubKey || '');

    let foundUser;

    // If pubKey provided, authenticate
    if(pubKey) {
      if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
        res.status(403);
        return res.send({error: 'Auth error'});
      }

      foundUser = await user.getUserByPublicKey(pubKey);
      if(!foundUser) {
        // Create user if doesn't exist
        foundUser = await user.putUser({ pubKey });
      }
    } else {
      // For unauthenticated setup intents (anonymous users)
      // Create a temporary user record
      foundUser = { stripeCustomerId: customerId };
    }

    let setupIntentResponse;

    switch(processor) {
      case 'stripe':
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}processor/stripe/setup-intent`, 
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          setupIntentResponse = await stripe.createSetupIntent(foundUser, customerId);
        }
        break;
      default:
        throw new Error('processor not found');
    }

console.log('SetupIntent created:', setupIntentResponse.clientSecret);

    res.send(setupIntentResponse);
  } catch(err) {
console.error('Error creating SetupIntent:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to create SetupIntent'});
  }
});

// Update payment method to set allow_redisplay = 'always'
app.post('/processor/:processor/payment-method/:paymentMethodId/allow-redisplay', async (req, res) => {
  try {
    const processor = req.params.processor;
    const paymentMethodId = req.params.paymentMethodId;
    const body = req.body;
    const timestamp = body.timestamp;
    const pubKey = body.pubKey;
    const signature = body.signature;

    // Message for authentication: timestamp + pubKey + paymentMethodId
    const message = timestamp + pubKey + paymentMethodId;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    let result;

    switch(processor) {
      case 'stripe':
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}processor/stripe/payment-method/${paymentMethodId}/allow-redisplay`, 
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          result = await stripe.updatePaymentMethodAllowRedisplay(paymentMethodId);
        }
        break;
      default:
        throw new Error('processor not found');
    }

console.log('Payment method updated with allow_redisplay: always');

    res.send(result);
  } catch(err) {
console.error('Error updating payment method:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to update payment method'});
  }
});

// Card Issuing Endpoints

app.post('/issuing/cardholder', async (req, res) => {
  try {
    const body = req.body;
    const timestamp = body.timestamp;
    const pubKey = body.pubKey;
    const signature = body.signature;
    const individualInfo = body.individualInfo;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    let foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      foundUser = await user.putUser({ pubKey });
    }

    const result = await stripe.createCardholder(foundUser, individualInfo, ip);

console.log('Cardholder created:', result.cardholderId);

    res.send(result);
  } catch(err) {
console.error('Error creating cardholder:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to create cardholder'});
  }
});

app.get('/issuing/cardholder/status', async (req, res) => {
  try {
    const timestamp = req.query.timestamp;
    const pubKey = req.query.pubKey;
    const signature = req.query.signature;

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const hasCardholder = !!foundUser.stripeCardholderId;

console.log('Cardholder status:', hasCardholder);

    res.send({ hasCardholder });
  } catch(err) {
console.error('Error checking cardholder status:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to check cardholder status'});
  }
});

app.post('/issuing/card/virtual', async (req, res) => {
  try {
    const body = req.body;
    const timestamp = body.timestamp;
    const pubKey = body.pubKey;
    const signature = body.signature;
    const currency = body.currency || 'usd';
    const spendingLimit = body.spendingLimit;

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.issueVirtualCard(foundUser, currency, spendingLimit);

console.log('Virtual card issued:', result.cardId);

    res.send(result);
  } catch(err) {
console.error('Error issuing virtual card:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to issue virtual card'});
  }
});

app.post('/issuing/card/physical', async (req, res) => {
  try {
    const body = req.body;
    const timestamp = body.timestamp;
    const pubKey = body.pubKey;
    const signature = body.signature;
    const shippingAddress = body.shippingAddress;
    const currency = body.currency || 'usd';

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.issuePhysicalCard(foundUser, shippingAddress, currency);

console.log('Physical card issued:', result.cardId);

    res.send(result);
  } catch(err) {
console.error('Error issuing physical card:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to issue physical card'});
  }
});

app.get('/issuing/cards', async (req, res) => {
  try {
    const timestamp = req.query.timestamp;
    const pubKey = req.query.pubKey;
    const signature = req.query.signature;

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.getIssuedCards(foundUser);

    res.send(result);
  } catch(err) {
console.error('Error getting issued cards:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to get issued cards'});
  }
});

app.get('/issuing/card/:cardId/details', async (req, res) => {
  try {
    const cardId = req.params.cardId;
    const timestamp = req.query.timestamp;
    const pubKey = req.query.pubKey;
    const signature = req.query.signature;

    const message = timestamp + pubKey + cardId;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.getVirtualCardDetails(foundUser, cardId);

console.log('Retrieved virtual card details:', cardId);

    res.send(result);
  } catch(err) {
console.error('Error getting card details:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to get card details'});
  }
});

app.patch('/issuing/card/:cardId/status', async (req, res) => {
  try {
    const cardId = req.params.cardId;
    const body = req.body;
    const timestamp = body.timestamp;
    const pubKey = body.pubKey;
    const signature = body.signature;
    const status = body.status;

    const message = timestamp + pubKey + cardId + status;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.updateCardStatus(foundUser, cardId, status);

console.log('Updated card status:', cardId, status);

    res.send(result);
  } catch(err) {
console.error('Error updating card status:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to update card status'});
  }
});

app.get('/issuing/transactions', async (req, res) => {
  try {
    const timestamp = req.query.timestamp;
    const pubKey = req.query.pubKey;
    const signature = req.query.signature;
    const limit = parseInt(req.query.limit) || 10;

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.getTransactions(foundUser, limit);

console.log('Retrieved transactions:', result.transactions.length);

    res.send(result);
  } catch(err) {
console.error('Error getting transactions:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to get transactions'});
  }
});

// Payout Card Endpoints (for receiving affiliate commissions)

app.post('/payout-card/save', async (req, res) => {
  try {
    const body = req.body;
    const timestamp = body.timestamp;
    const pubKey = body.pubKey;
    const signature = body.signature;
    const paymentMethodId = body.paymentMethodId;

    const message = timestamp + pubKey + paymentMethodId;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    let foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      foundUser = await user.putUser({ pubKey });
    }

    const result = await stripe.savePayoutCard(foundUser, paymentMethodId);

console.log('Payout card saved:', result);

    res.send(result);
  } catch(err) {
console.error('Error saving payout card:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to save payout card'});
  }
});

app.get('/payout-card/status', async (req, res) => {
  try {
    const timestamp = req.query.timestamp;
    const pubKey = req.query.pubKey;
    const signature = req.query.signature;

    const message = timestamp + pubKey;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }

    const foundUser = await user.getUserByPublicKey(pubKey);
    if(!foundUser) {
      res.status(404);
      return res.send({error: 'User not found'});
    }

    const result = await stripe.getPayoutCard(foundUser);

console.log('Payout card status:', result);

    res.send(result);
  } catch(err) {
console.error('Error checking payout card status:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to check payout card status'});
  }
});

app.post('/verify-payee', async (req, res) => {
  try {
    const body = req.body;
    const pubKey = body.pubKey;
    const addieURL = body.addieURL;
    const percent = body.percent;
    const signature = body.signature;

    // Verify signature: pubKey + addieURL + percent
    const message = pubKey + addieURL + percent;

    if(!signature || !sessionless.verifySignature(signature, message, pubKey)) {
      res.status(403);
      return res.send({error: 'Invalid payee signature'});
    }

    // Fetch Addie user by pubKey
    const addieUser = await user.getUserByPublicKey(pubKey);
    if(!addieUser) {
      res.status(404);
      return res.send({error: 'Payee not found in Addie'});
    }

console.log('✅ Verified payee:', pubKey.substring(0, 16) + '...');

    res.send({
      success: true,
      addieUser: addieUser
    });
  } catch(err) {
console.error('❌ Error verifying payee:', err);
    res.status(404);
    res.send({error: err.message || 'Failed to verify payee'});
  }
});

// Demo endpoint for Mutopia mixtape creator (no auth required for prototype)
// Creates real Stripe payment intent with split metadata
// Note: Transfers are created AFTER payment succeeds via webhook or manual trigger
app.post('/demo/payment/create', async (req, res) => {
  try {
    const { amount, currency, description, payees } = req.body;

    if(!amount || !payees || payees.length === 0) {
      res.status(400);
      return res.send({error: 'Missing required fields: amount, payees'});
    }

    console.log(`🎵 Creating Mutopia mixtape payment: $${amount/100} with ${payees.length} platform splits`);

    // Build payee metadata for Stripe Dashboard
    const metadata = {
      payee_count: payees.length.toString(),
      product_name: description || 'Mutopia Mixtape'
    };

    payees.forEach((payee, i) => {
      metadata[`payee_${i}_pubkey`] = payee.pubKey;
      metadata[`payee_${i}_amount`] = payee.amount.toString();
      metadata[`payee_${i}_name`] = payee.name || `Platform ${i+1}`;
    });

    // Create transfer group for linking payment to transfers
    const transferGroup = 'mutopia_' + Date.now();

    // Create Stripe payment intent with split metadata and transfer group
    const paymentIntent = await stripeSDK.paymentIntents.create({
      amount: amount,
      currency: currency || 'usd',
      description: description || 'Mutopia Mixtape Purchase',
      metadata: metadata,
      transfer_group: transferGroup,
      automatic_payment_methods: {
        enabled: true,
      },
      // Set application fee (optional - platform can take a cut)
      // application_fee_amount: Math.floor(amount * 0.05), // 5% platform fee
    });

    console.log(`✅ Payment intent created: ${paymentIntent.id}`);
    console.log(`💰 Split metadata stored for ${payees.length} platforms - visible in Stripe Dashboard`);
    console.log(`🔗 Transfer group: ${transferGroup}`);
    console.log(`⏳ Transfers will be created after payment confirmation`);
    console.log(`   Call POST /payment/${paymentIntent.id}/process-transfers after payment succeeds`);

    res.send({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      transferGroup: transferGroup
    });
  } catch(err) {
    console.error('❌ Demo payment error:', err);
    res.status(500);
    res.send({error: err.message || 'Failed to create payment intent'});
  }
});

// Process transfers to payout cards (for affiliate commissions)
app.post('/payment/:paymentIntentId/process-transfers', async (req, res) => {
  try {
    const paymentIntentId = req.params.paymentIntentId;

    console.log(`📡 Received request to process payout card transfers for payment: ${paymentIntentId}`);

    const result = await stripe.processPaymentTransfers(paymentIntentId);

    if(result.success) {
      res.send(result);
    } else {
      res.status(400);
      res.send(result);
    }
  } catch(err) {
    console.error('❌ Error in process-transfers endpoint:', err);
    res.status(500);
    res.send({error: err.message || 'Failed to process transfers'});
  }
});

// Process transfers to Connected Accounts (for platform revenue splits)
app.post('/payment/:paymentIntentId/process-connected-transfers', async (req, res) => {
  try {
    const paymentIntentId = req.params.paymentIntentId;

    console.log(`📡 Received request to process Connected Account transfers for payment: ${paymentIntentId}`);

    const result = await stripeConnectedTransfers.processConnectedAccountTransfers(paymentIntentId);

    if(result.success) {
      res.send(result);
    } else {
      res.status(400);
      res.send(result);
    }
  } catch(err) {
    console.error('❌ Error in process-connected-transfers endpoint:', err);
    res.status(500);
    res.send({error: err.message || 'Failed to process Connected Account transfers'});
  }
});

app.post('/magic/spell/:spellName', async (req, res) => {
console.log('got spell req');
  try {
    const spellName = req.params.spellName;
    const spell = req.body;

    if(!MAGIC[spellName]) {
console.log('sending this back');
      res.status(404);
      return res.send({error: 'spell not found'});
    }

    let spellResp = {};
    spellResp = await MAGIC[spellName](spell);
console.log('spellResp', spellResp);
    res.status(spellResp.success ? 200 : 900);
    return res.send(spellResp);
  } catch(err) {
console.warn(err);
    res.status(404);
    res.send({error: 'not found'});
  }
});

app.post('/money/processor/:processor/user/:uuid', async (req, res) => {
  try {
    const processor = req.params.processor;
    const uuid = req.params.uuid;
    const timestamp = req.body.timestamp;
    const caster = req.body.caster;
    const spell = req.body.spell;
    const gatewayUsers = req.body.gatewayUsers;
    const signature = req.body.signature;
    const message = timestamp + uuid;
    let payees = spell.gateways;

    const foundUser = await user.getUserByUUID(uuid);

    if(!sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'Auth error'});
    }
console.log('past auth');
console.log('caster', caster);
    const addieCaster = await user.getUserByPublicKey(caster.pubKey);
console.log('addieCaster', addieCaster);

    if(!addieCaster[processor] || addieCaster[processor].stored < spell.totalCost) {
      return res.send({success: false});
    }

    payees = payees.map(payee => {
      payee.pubKey = gatewayUsers.find($ => $.uuid === payee.uuid).pubKey;
      return payee;
    });

    const groupName = 'group_' + addieCaster.uuid;

    let paidOutResult;
    switch(processor) {
      case 'stripe': 
        if(addieStripeURL) {
          const forwardResponse = await fetch(`${addieStripeURL}money/processor/stripe/user/${uuid}`, 
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(req.body)
            }
          );
          return res.status(forwardResponse.status).send(await forwardResponse.json());
        } else {
          paidOutResult = await stripe.payPayees(payees, groupName, spell.totalCost);
        }
        break;
      default: throw new Error('processor not found');
    }
    
    res.send({success: paidOutResult});  

  } catch(err) {
console.warn(err);
    res.status(404);
    res.send({error: 'not found'});
  }
});

app.delete('/user/:uuid', async (req, res) => {
  try {
    const uuid = req.params.uuid;
    const timestamp = req.body.timestamp;
    const signature = req.body.signature;
    const message = timestamp + uuid;

    const foundUser = await user.getUserByUUID(uuid);

    if(!signature || !sessionless.verifySignature(signature, message, foundUser.pubKey)) {
      res.status(403);
      return res.send({error: 'auth error'});
    }

    const result = await user.deleteUser(foundUser);

    res.send({success: result});
  } catch(err) {
console.warn(err);
    res.status(404);
    res.send({error: 'not found'});
  }
});

app.listen(3005);
console.log('Let\'s add it up');
