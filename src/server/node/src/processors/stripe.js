import user from '../user/user.js';
import db from '../persistence/db.js';
import sessionless from 'sessionless-node';
import _stripe from 'stripe';
const stripeKey = process.env.STRIPE_KEY;
const stripePublishingKey = process.env.STRIPE_PUBLISHING_KEY;

// need to think through this case a bit more
if(!stripeKey) {
  const processors = {
    putStripeAccount: async (foundUser, name, email, ip) => {
      foundUser.stripeAccountId = 'ff33ee';
      return foundUser;
    },
    getStripePaymentIntent: async (foundUser, amount, currency, payees) => {
      const response = {
	paymentIntent: 'foo',
	ephemeralKey: 'bar',
	customer: 'baz',
	publishableKey: stripePublishingKey
      };
    
      return response;
    }
  };
}

const stripeSDK = _stripe(stripeKey);

// Standard US Stripe processing fee: 2.9% + $0.30
const calculateStripeFee = (amount) => Math.round(amount * 0.029) + 30;

// Build payee metadata for payment intent.
// merchant (optional) receives 91% of amount.
// payees (each with a percent field ≤9) split the remaining pool after the Stripe fee.
const buildPayeeMetadata = (payees, merchant, amount) => {
  const stripeFee = calculateStripeFee(amount);
  const net = Math.max(0, amount - stripeFee);
  const merchantAmount = merchant ? Math.min(Math.round(amount * 0.91), net) : 0;
  const distributable = Math.max(0, net - merchantAmount);

  const metadata = {};

  if (merchant) {
    metadata.merchant_pubkey = merchant.pubKey;
    metadata.merchant_amount = merchantAmount.toString();
  }

  const validPayees = (payees || []).filter(p => p.pubKey && p.percent > 0 && p.percent <= 9);
  const totalPercent = validPayees.reduce((s, p) => s + p.percent, 0) || 1;

  let count = 0;
  for (const payee of validPayees) {
    const payeeAmount = distributable > 0
      ? Math.round(distributable * payee.percent / Math.max(9, totalPercent))
      : 0;
    if (payeeAmount <= 0) continue;
    metadata[`payee_${count}_pubkey`] = payee.pubKey;
    metadata[`payee_${count}_amount`] = payeeAmount.toString();
    metadata[`payee_${count}_percent`] = payee.percent.toString();
    if (payee.addieURL) metadata[`payee_${count}_addieurl`] = payee.addieURL;
    if (payee.signature) metadata[`payee_${count}_signature`] = payee.signature.substring(0, 450);
    count++;
  }
  metadata.payee_count = count.toString();
  metadata.stripe_fee = stripeFee.toString();

  return metadata;
};

const stripe = {
  putStripeAccount: async (foundUser, country, name, email, ip) => {
    const account = await stripeSDK.accounts.create({
      country: country,
      email: email,
      business_type: 'company',
      company: {
        name: name,
        tax_id: '000000000',  // Stripe test tax ID
        address: {
          line1: 'address_full_match',  // Stripe test value that bypasses verification
          city: 'San Francisco',
          state: 'CA',
          postal_code: '94102',
          country: country
        }
      },
      business_profile: {
        mcc: '5734',  // Computer software stores
        url: 'https://allyabase.com'
      },
      tos_acceptance: {
        date: Math.floor((new Date().getTime()) / 1000),
        ip: ip,
        service_agreement: 'full'
      },
      capabilities: {
        transfers: {
          requested: true
        }
      },
      controller: {
	fees: {
	  payer: 'application',
	},
	losses: {
	  payments: 'application',
	},
        requirement_collection: 'application',
	stripe_dashboard: {
	  type: 'none',
	},
      },
    });

    foundUser.stripeAccountId = account.id;
    await user.saveUser(foundUser);

    return foundUser;
  },

  putStripeExpressAccount: async (foundUser, country, email, refreshUrl, returnUrl) => {
    const existingAccountId = await db.getExpressAccountByEmail(email);

    if (existingAccountId) {
      foundUser.stripeAccountId = existingAccountId;
      await user.saveUser(foundUser);
      foundUser.alreadyConnected = true;
      return foundUser;
    }

    const account = await stripeSDK.accounts.create({
      type: 'express',
      country: country,
      email: email,
      capabilities: {
        transfers: {
          requested: true
        }
      }
    });

    await db.saveExpressAccountByEmail(email, account.id);
    foundUser.stripeAccountId = account.id;
    await user.saveUser(foundUser);

    const accountLink = await stripeSDK.accountLinks.create({
      account: account.id,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    foundUser.stripeOnboardingUrl = accountLink.url;

    return foundUser;
  },

  getStripePaymentIntent: async (foundUser, amount, currency, payees, savePaymentMethod = false, productInfo = {}, merchant = null) => {
    const customerId = foundUser.stripeCustomerId || (await stripeSDK.customers.create()).id;
    if(foundUser.stripeCustomerId !== customerId) {
      foundUser.stripeCustomerId = customerId;
      await user.saveUser(foundUser);
    }

    const ephemeralKey = await stripeSDK.ephemeralKeys.create(
      {customer: customerId},
      {apiVersion: '2024-06-20'}
    );

    const groupName = 'group_' + foundUser.uuid;
    const payeeMetadata = buildPayeeMetadata(payees, merchant, amount);

    // Add product information to metadata (if provided)
    if(productInfo.productName) {
      payeeMetadata.product_name = productInfo.productName;
    }
    if(productInfo.productId) {
      payeeMetadata.product_id = productInfo.productId;
    }
    if(productInfo.contractUuid) {
      payeeMetadata.contract_uuid = productInfo.contractUuid;
    }
    if(productInfo.emojicode) {
      payeeMetadata.emojicode = productInfo.emojicode;
    }

    // Build description for Stripe Dashboard (most visible field)
    let description = 'Product purchase';
    if(productInfo.productName) {
      description = `Purchase: ${productInfo.productName}`;
      if(parseInt(payeeMetadata.payee_count) > 0) {
        description += ' (with affiliate commission)';
      }
    }

    const paymentIntentData = {
      amount: amount,
      currency: currency,
      customer: customerId,
      description: description,
      automatic_payment_methods: {
	enabled: true,
      },
      transfer_group: groupName,
      metadata: payeeMetadata
    };

    if(savePaymentMethod) {
      paymentIntentData.setup_future_usage = 'off_session';
    }

    const paymentIntent = await stripeSDK.paymentIntents.create(paymentIntentData);

    // Create CustomerSession so the Payment Element can display saved payment methods
    // and offer Apple Pay / Google Pay wallets
    const customerSession = await stripeSDK.customerSessions.create({
      customer: customerId,
      components: {
        payment_element: {
          enabled: true,
          features: {
            payment_method_redisplay: 'enabled',
            payment_method_save: 'enabled',
            payment_method_save_usage: 'on_session',
            payment_method_remove: 'enabled',
          }
        }
      }
    });

    const response = {
      paymentIntent: paymentIntent.client_secret,
      customerSessionClientSecret: customerSession.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customerId,
      publishableKey: stripePublishingKey
    };

    return response;
  },

  getStripePaymentIntentWithoutSplits: async (foundUser, amount, currency, savePaymentMethod = false) => {
    const customerId = foundUser.stripeCustomerId || (await stripeSDK.customers.create()).id;
    if(foundUser.stripeCustomerId !== customerId) {
      foundUser.stripeCustomerId = customerId;
      await user.saveUser(foundUser);
    }

    const ephemeralKey = await stripeSDK.ephemeralKeys.create(
      {customer: customerId},
      {apiVersion: '2024-06-20'}
    );

    const groupName = 'group_' + foundUser.uuid;

    const paymentIntentData = {
      amount: amount,
      currency: currency,
      customer: customerId,
      // In the latest version of the API, specifying the `automatic_payment_methods` parameter
      // is optional because Stripe enables its functionality by default.
      automatic_payment_methods: {
	enabled: true,
      },
      transfer_group: groupName
    };

    if(savePaymentMethod) {
      paymentIntentData.setup_future_usage = 'off_session';
    }

    const paymentIntent = await stripeSDK.paymentIntents.create(paymentIntentData);

    const response = {
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customerId,
      publishableKey: stripePublishingKey
    };

    return response;
  },

  getSubscriptionPaymentIntent:  async (foundUser, amount, currency, subscriptionId, payees) => {
    const customerId = foundUser.stripeCustomerId || (await stripeSDK.customers.create()).id;
    if(foundUser.stripeCustomerId !== customerId) {
      foundUser.stripeCustomerId = customerId;
      await user.saveUser(foundUser);
    }

    const ephemeralKey = await stripeSDK.ephemeralKeys.create(
      {customer: customerId},
      {apiVersion: '2024-06-20'}
    );

    const groupName = 'group_' + foundUser.uuid;

    const paymentIntent = await stripeSDK.paymentIntents.create({
      amount: amount,
      currency: currency,
      customer: customerId,
      setup_future_usage: 'off_session',
      // In the latest version of the API, specifying the `automatic_payment_methods` parameter
      // is optional because Stripe enables its functionality by default.
      automatic_payment_methods: {
	enabled: true,
      },
      metadata: {
        subscription_id: subscriptionId
      },
      transfer_group: groupName
    });

    let accountsAndAmounts = [];
    for(var i = 0; i < payees.length; i++) {
      const payee = payees[i];

      // Fetch Addie user from payee's addieURL (supports cross-base commerce)
      let payeeUser = null;
      if(payee.addieURL && payee.signature) {
        try {
          // Verify payee signature and get Addie user from their base
          const verifyResponse = await fetch(`${payee.addieURL}/verify-payee`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              pubKey: payee.pubKey,
              addieURL: payee.addieURL,
              percent: payee.percent,
              signature: payee.signature
            })
          });

          if(verifyResponse.ok) {
            const result = await verifyResponse.json();
            payeeUser = result.addieUser;
          }
        } catch(err) {
          console.warn(`⚠️ Failed to fetch payee from ${payee.addieURL}:`, err.message);
        }
      }

      // Fallback to local database lookup
      if(!payeeUser) {
        payeeUser = await user.getUserByPublicKey(payee.pubKey);
      }

      if(payeeUser && payeeUser.stripeAccountId) {
        accountsAndAmounts.push({
          account: payeeUser.stripeAccountId,
          amount: payee.amount
        });
      } else {
        console.warn(`⚠️ Payee ${payee.pubKey} has no Stripe account, skipping`);
      }
    }

    const transferPromises = accountsAndAmounts.map(accountAndAmount => {
      return stripeSDK.transfers.create({
	amount: accountAndAmount.amount,
	currency: 'usd',
	destination: accountAndAmount.account,
	transfer_group: groupName
      });
    });
    await Promise.all(transferPromises);

    const response = {
      paymentIntent: paymentIntent.client_secret,
      ephemeralKey: ephemeralKey.secret,
      customer: customerId,
      publishableKey: stripePublishingKey
    };

    return response;
  },

  getSavedPaymentMethods: async (foundUser, type = 'card') => {
    if(!foundUser.stripeCustomerId) {
      return { paymentMethods: [] };
    }

    try {
      const allPaymentMethods = await stripeSDK.paymentMethods.list({
        customer: foundUser.stripeCustomerId,
        type: type
      });

      const paymentMethods = allPaymentMethods.data.filter(pm => {
        return pm.allow_redisplay === 'always';
      });

      return {
        paymentMethods,
        customerId: foundUser.stripeCustomerId
      };
    } catch(error) {
console.error('Error fetching payment methods:', error);
      throw error;
    }
  },

  chargeWithSavedPaymentMethod: async (foundUser, amount, currency, paymentMethodId, payees = []) => {
    if(!foundUser.stripeCustomerId) {
      throw new Error('Customer not found');
    }

    const groupName = 'group_' + foundUser.uuid;

    try {
      const paymentIntentData = {
        amount,
        currency,
        customer: foundUser.stripeCustomerId,
        payment_method: paymentMethodId,
        confirmation_method: 'manual',
        confirm: true,
        off_session: true,
        transfer_group: groupName
      };

      const paymentIntent = await stripeSDK.paymentIntents.create(paymentIntentData);

      if(payees.length > 0) {
        let accountsAndAmounts = [];
        for(var i = 0; i < payees.length; i++) {
          const payee = payees[i];

          // Fetch Addie user from payee's addieURL (supports cross-base commerce)
          let payeeUser = null;
          if(payee.addieURL && payee.signature) {
            try {
              // Verify payee signature and get Addie user from their base
              const verifyResponse = await fetch(`${payee.addieURL}/verify-payee`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  pubKey: payee.pubKey,
                  addieURL: payee.addieURL,
                  percent: payee.percent,
                  signature: payee.signature
                })
              });

              if(verifyResponse.ok) {
                const result = await verifyResponse.json();
                payeeUser = result.addieUser;
              }
            } catch(err) {
              console.warn(`⚠️ Failed to fetch payee from ${payee.addieURL}:`, err.message);
            }
          }

          // Fallback to local database lookup
          if(!payeeUser) {
            payeeUser = await user.getUserByPublicKey(payee.pubKey);
          }

          if(payeeUser && payeeUser.stripeAccountId) {
            accountsAndAmounts.push({
              account: payeeUser.stripeAccountId,
              amount: payee.amount
            });
          } else {
            console.warn(`⚠️ Payee ${payee.pubKey} has no Stripe account, skipping`);
          }
        }
      
        const transferPromises = accountsAndAmounts.map(accountAndAmount => {
	  return stripeSDK.transfers.create({
	    amount: accountAndAmount.amount,
	    currency: 'usd',
	    destination: accountAndAmount.account,
	    transfer_group: groupName
	  });
	});
        await Promise.all(transferPromises);
      }

      return {
        success: true,
        paymentIntent,
        status: paymentIntent.status
      };
    } catch(err) {
      if(err.code === 'authentication_required') {
        return {
          success: false,
          requiresAuthentication: true,
          paymentIntent: {
            id: err.payment_intent.id,
            client_secret: err.payment_intent.client_secret
          }
        };
      }
console.error('Error charging saved payment method', err);
      throw err;
    }
  },

  removeSavedPaymentMethod: async (foundUser, paymentMethodId) => {
    try {
      const paymentMethod = await stripeSDK.paymentMethods.detach(paymentMethodId);

      return {
        success: true
      }
    } catch(err) {
console.error('error removing payment method', err);
      throw err;
    }
  },

  createSetupIntent: async (foundUser, customerId = null) => {
    try {
      // Create or use existing customer
      const actualCustomerId = customerId || foundUser.stripeCustomerId || (await stripeSDK.customers.create()).id;

      // Save customer ID if new
      if(foundUser.stripeCustomerId !== actualCustomerId) {
        foundUser.stripeCustomerId = actualCustomerId;
        await user.saveUser(foundUser);
      }

      // Create SetupIntent
      // Note: allow_redisplay cannot be set here - must be updated after payment method is attached
      const setupIntent = await stripeSDK.setupIntents.create({
        customer: actualCustomerId,
        payment_method_types: ['card'],
        usage: 'off_session' // For future payments
      });

      console.log('✅ SetupIntent created:', setupIntent.id);

      // CRITICAL: After SetupIntent is confirmed and payment method is attached,
      // the iOS app calls POST /processor/stripe/payment-method/:id/allow-redisplay
      // to update the payment method with allow_redisplay = 'always'

      return {
        clientSecret: setupIntent.client_secret,
        customerId: actualCustomerId,
        publishableKey: stripePublishingKey
      };
    } catch(err) {
console.error('Error creating SetupIntent:', err);
      throw err;
    }
  },

  updatePaymentMethodAllowRedisplay: async (paymentMethodId) => {
    try {
      console.log(`🔄 Updating payment method ${paymentMethodId} to allow_redisplay: always`);

      // Update the payment method to set allow_redisplay = 'always'
      const paymentMethod = await stripeSDK.paymentMethods.update(paymentMethodId, {
        allow_redisplay: 'always'
      });

      console.log(`✅ Payment method updated: ${paymentMethodId}`);

      return {
        success: true,
        paymentMethodId: paymentMethod.id,
        allow_redisplay: paymentMethod.allow_redisplay
      };
    } catch(err) {
      console.error('❌ Error updating payment method:', err);
      return {
        success: false,
        error: err.message
      };
    }
  },

  // Stripe Issuing - Create a cardholder for the unbanked
  createCardholder: async (foundUser, individualInfo, ip) => {
    try {
      const { name, email, phoneNumber, address } = individualInfo;

      // Build billing address, only including line2 if it exists (Stripe requirement)
      const billingAddress = {
        line1: address.line1,
        city: address.city,
        state: address.state,
        postal_code: address.postal_code,
        country: address.country || 'US'
      };

      // Only include line2 if it's not empty (Stripe doesn't allow null or empty string)
      if (address.line2 && address.line2.trim()) {
        billingAddress.line2 = address.line2;
      }

      // Build TOS acceptance with actual user IP
      const tosAcceptance = {
        date: Math.floor(Date.now() / 1000),
        ip: ip || '0.0.0.0'
      };

      // Create Stripe Issuing Cardholder
      const cardholder = await stripeSDK.issuing.cardholders.create({
        type: 'individual',
        name: name,
        email: email,
        phone_number: phoneNumber,
        billing: {
          address: billingAddress
        },
        individual: {
          first_name: individualInfo.firstName,
          last_name: individualInfo.lastName,
          dob: {
            day: individualInfo.dob.day,
            month: individualInfo.dob.month,
            year: individualInfo.dob.year
          }
        },
        status: 'active'
      });

      // Save cardholder ID to user
      foundUser.stripeCardholderId = cardholder.id;
      await user.saveUser(foundUser);

console.log('Created Stripe Issuing cardholder:', cardholder.id);

      return {
        cardholderId: cardholder.id,
        status: cardholder.status
      };
    } catch(err) {
console.error('Error creating cardholder:', err);
      throw err;
    }
  },

  // Issue a virtual card
  issueVirtualCard: async (foundUser, currency = 'usd', spendingLimit = null) => {
    try {
      if(!foundUser.stripeCardholderId) {
        throw new Error('User must have a cardholder account first');
      }

      // Default spending limit: $1000/month
      const monthlyLimit = spendingLimit || 100000; // in cents

      const card = await stripeSDK.issuing.cards.create({
        cardholder: foundUser.stripeCardholderId,
        currency: currency,
        type: 'virtual',
        status: 'active',
        spending_controls: {
          spending_limits: [
            {
              amount: monthlyLimit,
              interval: 'monthly'
            }
          ]
        }
      });

console.log('Issued virtual card:', card.id, 'with limit:', monthlyLimit);

      return {
        cardId: card.id,
        last4: card.last4,
        brand: card.brand,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        status: card.status,
        type: 'virtual',
        spendingLimit: monthlyLimit,
        // Virtual card details (number, CVC, etc.) can be retrieved via API
        cardNumber: card.number, // Only available immediately after creation
        cvc: card.cvc
      };
    } catch(err) {
console.error('Error issuing virtual card:', err);
      throw err;
    }
  },

  // Issue a physical card
  issuePhysicalCard: async (foundUser, shippingAddress, currency = 'usd') => {
    try {
      if(!foundUser.stripeCardholderId) {
        throw new Error('User must have a cardholder account first');
      }

      const card = await stripeSDK.issuing.cards.create({
        cardholder: foundUser.stripeCardholderId,
        currency: currency,
        type: 'physical',
        status: 'active',
        shipping: {
          name: shippingAddress.name,
          address: {
            line1: shippingAddress.line1,
            line2: shippingAddress.line2 || null,
            city: shippingAddress.city,
            state: shippingAddress.state,
            postal_code: shippingAddress.postal_code,
            country: shippingAddress.country || 'US'
          },
          service: 'standard' // or 'express', 'priority'
        },
        spending_controls: {
          spending_limits: [
            {
              amount: 100000, // $1000 per month default limit
              interval: 'monthly'
            }
          ]
        }
      });

console.log('Issued physical card:', card.id);

      return {
        cardId: card.id,
        last4: card.last4,
        brand: card.brand,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        status: card.status,
        type: 'physical',
        shipping: card.shipping
      };
    } catch(err) {
console.error('Error issuing physical card:', err);
      throw err;
    }
  },

  // Get issued cards for a user
  getIssuedCards: async (foundUser) => {
    try {
      if(!foundUser.stripeCardholderId) {
        return { cards: [] };
      }

      const cards = await stripeSDK.issuing.cards.list({
        cardholder: foundUser.stripeCardholderId,
        limit: 100
      });

      return {
        cards: cards.data.map(card => ({
          cardId: card.id,
          last4: card.last4,
          brand: card.brand,
          expMonth: card.exp_month,
          expYear: card.exp_year,
          status: card.status,
          type: card.type,
          spendingLimit: card.spending_controls?.spending_limits?.[0]?.amount
        }))
      };
    } catch(err) {
console.error('Error fetching issued cards:', err);
      throw err;
    }
  },

  // Retrieve virtual card details (number, CVC) - sensitive operation
  getVirtualCardDetails: async (foundUser, cardId) => {
    try {
      const card = await stripeSDK.issuing.cards.retrieve(cardId);

      if(card.cardholder !== foundUser.stripeCardholderId) {
        throw new Error('Card does not belong to this user');
      }

      if(card.type !== 'virtual') {
        throw new Error('Can only retrieve details for virtual cards');
      }

      return {
        cardId: card.id,
        number: card.number,
        cvc: card.cvc,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        last4: card.last4,
        brand: card.brand
      };
    } catch(err) {
console.error('Error retrieving virtual card details:', err);
      throw err;
    }
  },

  // Cancel/freeze a card
  updateCardStatus: async (foundUser, cardId, status) => {
    try {
      const card = await stripeSDK.issuing.cards.retrieve(cardId);

      if(card.cardholder !== foundUser.stripeCardholderId) {
        throw new Error('Card does not belong to this user');
      }

      const updatedCard = await stripeSDK.issuing.cards.update(cardId, {
        status: status // 'active', 'inactive', 'canceled'
      });

console.log('Updated card status:', cardId, status);

      return {
        cardId: updatedCard.id,
        status: updatedCard.status
      };
    } catch(err) {
console.error('Error updating card status:', err);
      throw err;
    }
  },

  // Get transactions for all user's cards
  getTransactions: async (foundUser, limit = 10) => {
    try {
      if(!foundUser.stripeCardholderId) {
        return { transactions: [] };
      }

      const transactions = await stripeSDK.issuing.transactions.list({
        cardholder: foundUser.stripeCardholderId,
        limit: limit
      });

console.log('Retrieved transactions:', transactions.data.length);

      return {
        transactions: transactions.data.map(tx => ({
          id: tx.id,
          amount: tx.amount,
          merchant: tx.merchant_data?.name || 'Unknown merchant',
          category: tx.merchant_data?.category || 'other',
          status: tx.status,
          created: tx.created,
          cardId: tx.card,
          currency: tx.currency
        }))
      };
    } catch(err) {
console.error('Error fetching transactions:', err);
      throw err;
    }
  },

  /**
   * Save a debit card as payout destination (for receiving affiliate commissions)
   * Works with both external debit cards AND issued cards
   * @param {Object} foundUser - User object
   * @param {string} paymentMethodId - Stripe payment method ID (card token)
   * @returns {Object} Result with saved card details
   */
  savePayoutCard: async (foundUser, paymentMethodId) => {
    try {
      console.log(`💳 Saving payout card for user: ${foundUser.pubKey?.substring(0, 10)}...`);

      // Retrieve the payment method to validate it's a debit card
      const paymentMethod = await stripeSDK.paymentMethods.retrieve(paymentMethodId);

      // Check if it's a debit card (or issued card)
      if(paymentMethod.card.funding !== 'debit' && !paymentMethod.card.issuer) {
        return {
          success: false,
          error: 'Only debit cards can be used as payout destinations'
        };
      }

      // Save the payment method ID to user record
      foundUser.stripePayoutCardId = paymentMethodId;
      await user.saveUser(foundUser);

      console.log(`✅ Payout card saved: ${paymentMethod.card.brand} ending in ${paymentMethod.card.last4}`);

      return {
        success: true,
        payoutCardId: paymentMethodId,
        last4: paymentMethod.card.last4,
        brand: paymentMethod.card.brand,
        expMonth: paymentMethod.card.exp_month,
        expYear: paymentMethod.card.exp_year
      };
    } catch(err) {
      console.error('❌ Error saving payout card:', err);
      return {
        success: false,
        error: err.message
      };
    }
  },

  /**
   * Get saved payout card details
   * @param {Object} foundUser - User object
   * @returns {Object} Payout card details or null
   */
  getPayoutCard: async (foundUser) => {
    try {
      if(!foundUser.stripePayoutCardId) {
        return {
          success: true,
          hasPayoutCard: false
        };
      }

      const paymentMethod = await stripeSDK.paymentMethods.retrieve(foundUser.stripePayoutCardId);

      return {
        success: true,
        hasPayoutCard: true,
        payoutCardId: foundUser.stripePayoutCardId,
        last4: paymentMethod.card.last4,
        brand: paymentMethod.card.brand,
        expMonth: paymentMethod.card.exp_month,
        expYear: paymentMethod.card.exp_year
      };
    } catch(err) {
      console.error('❌ Error getting payout card:', err);
      return {
        success: false,
        error: err.message
      };
    }
  },

  /**
   * Process transfers after payment confirmation
   * Called from webhook or client-side after payment succeeds
   * @param {string} paymentIntentId - Stripe payment intent ID
   * @returns {Object} Result with transfer details
   */
  processPaymentTransfers: async (paymentIntentId) => {
    try {
      console.log(`💰 Processing transfers for payment: ${paymentIntentId}`);

      // Retrieve the payment intent to get metadata and transfer group
      const paymentIntent = await stripeSDK.paymentIntents.retrieve(paymentIntentId);

      // Check payment status
      if(paymentIntent.status !== 'succeeded') {
        console.warn(`⚠️ Payment ${paymentIntentId} has not succeeded (status: ${paymentIntent.status})`);
        return {
          success: false,
          error: `Payment not succeeded (status: ${paymentIntent.status})`
        };
      }

      const metadata = paymentIntent.metadata;
      const transferGroup = paymentIntent.transfer_group;
      const productName = metadata.product_name || 'Product';
      const payeeCount = parseInt(metadata.payee_count || '0');

      let transfers = [];

      // Transfer to merchant (creator/tenant) first — uses Connected Account (stripeAccountId)
      const merchantPubKey = metadata.merchant_pubkey;
      const merchantAmount = parseInt(metadata.merchant_amount || '0');

      if (merchantPubKey && merchantAmount > 0) {
        try {
          const merchantUser = await user.getUserByPublicKey(merchantPubKey);
          const destination = merchantUser && (merchantUser.stripeAccountId || merchantUser.stripePayoutCardId);
          if (destination) {
            const transfer = await stripeSDK.transfers.create({
              amount: merchantAmount,
              currency: 'usd',
              destination: destination,
              transfer_group: transferGroup,
              description: `${productName} - Creator payout`,
              metadata: {
                product_name: productName,
                commission_type: 'creator',
                payee_pubkey: merchantPubKey.substring(0, 20),
                original_payment_intent: paymentIntentId,
                ...(metadata.product_id && { product_id: metadata.product_id }),
                ...(metadata.contract_uuid && { contract_uuid: metadata.contract_uuid }),
                ...(metadata.emojicode && { emojicode: metadata.emojicode })
              }
            });
            transfers.push({ pubKey: merchantPubKey, amount: merchantAmount, transferId: transfer.id, destination });
          } else {
            console.warn(`⚠️ Merchant ${merchantPubKey} has no Stripe destination, skipping`);
          }
        } catch(err) {
          console.error(`❌ Failed to transfer to merchant ${merchantPubKey}:`, err.message);
          transfers.push({ pubKey: merchantPubKey, amount: merchantAmount, error: err.message });
        }
      }

      // Transfer to payees (platform commission, affiliates)
      for(let i = 0; i < payeeCount; i++) {
        const pubKey = metadata[`payee_${i}_pubkey`];
        const amount = parseInt(metadata[`payee_${i}_amount`]);
        const addieURL = metadata[`payee_${i}_addieurl`];
        const signature = metadata[`payee_${i}_signature`];
        const percent = metadata[`payee_${i}_percent`] ? parseInt(metadata[`payee_${i}_percent`]) : undefined;

        if(!pubKey || !amount) {
          console.warn(`⚠️ Missing payee data for index ${i}`);
          continue;
        }

        try {
          let payeeUser = null;

          // Try remote base first (cross-base commerce)
          if(addieURL && signature && percent !== undefined) {
            try {
              const verifyResponse = await fetch(`${addieURL}/verify-payee`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pubKey, addieURL, percent, signature })
              });
              if(verifyResponse.ok) {
                const result = await verifyResponse.json();
                payeeUser = result.addieUser;
              }
            } catch(err) {
              console.warn(`⚠️ Failed to fetch payee from ${addieURL}:`, err.message);
            }
          }

          if(!payeeUser) {
            payeeUser = await user.getUserByPublicKey(pubKey);
          }

          const destination = payeeUser && (payeeUser.stripeAccountId || payeeUser.stripePayoutCardId);
          if(!destination) {
            console.warn(`⚠️ Payee ${pubKey} has no Stripe destination, skipping`);
            continue;
          }

          const transfer = await stripeSDK.transfers.create({
            amount: amount,
            currency: 'usd',
            destination: destination,
            transfer_group: transferGroup,
            description: `${productName} - Affiliate payout`,
            metadata: {
              product_name: productName,
              commission_type: 'affiliate',
              payee_pubkey: pubKey.substring(0, 20),
              original_payment_intent: paymentIntentId,
              ...(metadata.product_id && { product_id: metadata.product_id }),
              ...(metadata.contract_uuid && { contract_uuid: metadata.contract_uuid }),
              ...(metadata.emojicode && { emojicode: metadata.emojicode })
            }
          });

          transfers.push({ pubKey, amount, transferId: transfer.id, destination });
        } catch(err) {
          console.error(`❌ Failed to transfer to ${pubKey}:`, err.message);
          transfers.push({ pubKey, amount, error: err.message });
        }
      }

      return {
        success: true,
        transfers: transfers,
        paymentIntentId: paymentIntentId,
        totalTransfers: transfers.filter(t => t.transferId).length,
        failedTransfers: transfers.filter(t => t.error).length
      };
    } catch(err) {
      console.error('❌ Error processing payment transfers:', err);
      return {
        success: false,
        error: err.message
      };
    }
  }
};

export default stripe;
