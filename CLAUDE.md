# Addie - Payment Processing Service

## Overview

Addie is a Planet Nine allyabase microservice that handles payment processing and financial transactions.

**Location**: `/addie/`
**Port**: **3005** (`addie.js` ends in `app.listen(3005)`; this file said 3004, which is Joan's in allyabase's port map)

## Core Features

### 💳 **Payment Processing**
- **Multiple Processors**: Supports various payment processors (Stripe, simulated, etc.)
- **Sessionless Authentication**: All transactions require cryptographic signatures
- **Transaction Tracking**: Complete audit trail of all payment operations

## API Endpoints

### Payment Operations
- `POST /payment` - Process a payment transaction
- `POST /payment/:paymentIntentId/process-transfers` - Process instant transfers to payout cards after payment

### Stripe Payout Cards (November 2025)
- `POST /payout-card/save` - Save debit card for receiving affiliate payouts
- `GET /payout-card/status` - Get payout card status

### Stripe Payment Methods
- `POST /processor/stripe/setup-intent` - Create SetupIntent for saving cards
- `GET /processor/stripe/payment-methods` - Get saved payment methods
- `DELETE /processor/stripe/payment-method/:id` - Delete saved payment method

### Stripe Payment Intents
- `POST /processor/stripe/payment-intent` - Create payment intent with affiliate splits
- `POST /processor/stripe/payment-intent-without-splits` - Create simple payment intent

### Embedded Stripe Connect onboarding (September 2026)
- `POST /user/:uuid/processor/stripe/account-session` - Mint an **Account Session** for Stripe's embedded components
- `GET /user/:uuid/processor/stripe/account` - Real onboarding/capability status for that account

Both answer **503 when Stripe keys are unset**, so an environment without keys presents itself as "not configured" rather than as a broken payment path. See "Embedded Connect onboarding" below.

### Stripe Issuing (Virtual Cards for the Unbanked)
- `POST /issuing/cardholder` - Create Stripe Issuing cardholder with KYC information
- `POST /processor/stripe/issue-virtual-card` - Issue virtual debit card
- `GET /processor/stripe/issued-cards` - Get user's issued cards
- `GET /processor/stripe/transactions` - Get card transactions
- `PUT /processor/stripe/card/:id/status` - Update card status (freeze/unfreeze/cancel)

### MAGIC Protocol
- `POST /magic/spell/:spellName` - Execute MAGIC spells for payment operations

### Health & Status
- `GET /health` - Service health check (if available)

## MAGIC Protocol Integration

### Available Spells

#### `signInMoney`
Processes a payment and signs a Covenant contract step to record the transaction.

**Spell Components**:
- `contractUuid` - UUID of the contract to sign
- `stepId` - ID of the contract step (typically the first step: "Payment Completed")
- `amount` - Payment amount in cents
- `processor` - Payment processor name (e.g., 'stripe', 'simulated')
- `paymentDetails` - Processor-specific payment details (optional)
- `pubKey` - Public key of the payer
- `contractSignature` - Pre-signed signature for contract authentication (message: `timestamp + userUUID + contractUUID`)
- `stepSignature` - Pre-signed signature for step signing (message: `timestamp + userUUID + contractUUID + stepId`)

**Process**:
1. Validates required spell components
2. Processes payment through the specified processor
3. Signs the specified contract step via Covenant's `/contract/:uuid/sign` endpoint using pre-signed signatures
4. Returns payment and signing results

**Returns**:
```javascript
{
  success: true,
  payment: {
    success: true,
    transactionId: "txn_...",
    amount: 1999,
    processor: "simulated"
  },
  contractSign: { /* Covenant sign response */ }
}
```

**Error Response**:
```javascript
{
  success: false,
  error: "Error description"
}
```

**Important Notes**:
- Currently uses simulated payment processing (TODO: integrate real processors)
- Requires valid spell caster signature for authentication
- **Critical**: Spell resolvers don't have access to private keys, so spell casters must pre-sign BOTH signatures:
  - `contractSignature` for Covenant endpoint authentication
  - `stepSignature` for the actual contract step signing
- Works in conjunction with Covenant's purchaseLesson spell for lesson purchases

### Other Spells

#### `joinup`
Registers a user with Addie's payment system.

#### `linkup`
Links a user's payment account with external services.

### Implementation Details

The MAGIC endpoint (`/magic/spell/:spellName`) allows other services to trigger payment operations through the spell protocol. All payment operations require proper sessionless authentication.

**Location**: `/src/server/node/src/magic/magic.js`

## Integration Patterns

### Lesson Purchase Flow
1. Student casts `purchaseLesson` spell to Covenant
2. Covenant creates SODOTO contract
3. Student casts `signInMoney` spell to Addie
4. Addie processes payment and signs contract step
5. Contract progresses through remaining steps

## Security Model

- **Sessionless Authentication**: All operations require cryptographic signatures
- **No Stored Credentials**: Payment processor credentials managed securely
- **Transaction Verification**: All payments verified before contract signing

## Future Enhancements

### Payment Features
- **Real Payment Processors**: Full Stripe integration
- **Multi-Currency Support**: Handle various currencies
- **Refund Processing**: Automated refund workflows
- **Subscription Management**: Recurring payment handling

### MAGIC Features
- **Automated Refunds**: Spell-based refund processing
- **Payment Verification**: Multi-step payment confirmation
- **Escrow Services**: Hold payments until contract completion

## MAGIC Route Conversion (October 2025)

All Addie REST endpoints have been converted to MAGIC protocol spells:

### Converted Spells (7 total)
1. **addieUserCreate** - Create payment processing user
2. **addieUserProcessor** - Set up payment processor for user
3. **addieUserProcessorIntentWithoutSplits** - Create payment intent without revenue splits
4. **addieChargeSavedMethod** - Charge a saved payment method
5. **addiePaymentMethodsIntent** - Get saved payment methods and create intent
6. **addieSavedPaymentMethodDelete** - Delete saved payment method
7. **addieMoneyProcessor** - Process money through payment processor

**Testing**: Comprehensive MAGIC spell tests available in `/test/mocha/magic-spells.js` (10 tests covering success and error cases)

**Documentation**: See `/MAGIC-ROUTES.md` for complete spell specifications and migration guide

## Stripe Payout Cards Integration (November 2025)

### Overview

Addie provides direct debit card payout functionality for The Advancement iOS and Android apps, enabling users to receive instant affiliate commissions (30 minutes) without complex KYC onboarding. This replaces the previous Connected Accounts approach with a simpler, faster payout method.

### Architecture

```
┌────────────────────────────────────────────────────────┐
│  The Advancement App                                   │
│  - Selects debit card for payouts                      │
│  - Checks payout card status                           │
└───────────────────┬────────────────────────────────────┘
                    │ Sessionless Auth
                    ▼
┌────────────────────────────────────────────────────────┐
│  Addie Backend                                         │
│  /payout-card/save                                     │
│  /payout-card/status                                   │
│  /payment/:id/process-transfers                        │
└───────────────────┬────────────────────────────────────┘
                    │ Stripe API
                    ▼
┌────────────────────────────────────────────────────────┐
│  Stripe Platform                                       │
│  - Direct Debit Card Transfers                         │
│  - Instant Payouts (~30 minutes)                       │
│  - Works with Stripe Issued Cards                      │
└────────────────────────────────────────────────────────┘
```

### Endpoints

#### POST /payout-card/save

Saves a debit card payment method as the user's payout destination for receiving affiliate commissions.

**Request**:
```json
{
  "timestamp": "1234567890",
  "pubKey": "02a1b2c3...",
  "signature": "3045022100...",
  "paymentMethodId": "pm_1AbCdEfGhIjKlMn"
}
```

**Response (Success)**:
```json
{
  "success": true,
  "payoutCardId": "pm_1AbCdEfGhIjKlMn",
  "last4": "4242",
  "brand": "visa",
  "expMonth": 12,
  "expYear": 2025
}
```

**Response (Error - Not Debit Card)**:
```json
{
  "success": false,
  "error": "Only debit cards can be used as payout destinations"
}
```

**Implementation** (`src/server/node/src/processors/stripe.js:681-717`):
- Validates payment method is a debit card (or issued card)
- Saves payment method ID to user record as `stripePayoutCardId`
- Returns card details for confirmation

**Signature**: `timestamp + pubKey + paymentMethodId`

#### GET /payout-card/status

Retrieves the user's current payout card status and details.

**Request (Query Parameters)**:
```
?timestamp=1234567890&pubKey=02a1b2c3...&signature=3045022100...
```

**Response (Has Payout Card)**:
```json
{
  "success": true,
  "hasPayoutCard": true,
  "payoutCardId": "pm_1AbCdEfGhIjKlMn",
  "last4": "4242",
  "brand": "visa",
  "expMonth": 12,
  "expYear": 2025
}
```

**Response (No Payout Card)**:
```json
{
  "success": true,
  "hasPayoutCard": false
}
```

**Implementation** (`src/server/node/src/processors/stripe.js:724-751`):
- Checks user record for `stripePayoutCardId`
- Fetches payment method details from Stripe if exists
- Returns card information

**Signature**: `timestamp + pubKey`

#### POST /payment/:paymentIntentId/process-transfers

Processes instant transfers to payout cards after payment confirmation.

**Request**:
```json
{
  "timestamp": "1234567890",
  "pubKey": "02a1b2c3...",
  "signature": "3045022100..."
}
```

**Response**:
```json
{
  "success": true,
  "transfers": [
    {
      "pubKey": "02a1b2c3...",
      "amount": 500,
      "transferId": "tr_1AbCdEfGhIjKlMn",
      "destination": "pm_card_visa_debit"
    },
    {
      "pubKey": "02d4e5f6...",
      "amount": 4500,
      "transferId": "tr_2XyZaBcDeFgHiJk",
      "destination": "pm_card_mastercard_debit"
    }
  ],
  "paymentIntentId": "pi_1AbCdEfGhIjKlMn",
  "totalTransfers": 2,
  "failedTransfers": 0
}
```

**Implementation** (`src/server/node/src/processors/stripe.js:801-834`):
1. Retrieves payment intent by ID
2. Checks payment status is `succeeded`
3. Reads payee metadata from payment intent
4. Looks up each payee's saved payout card (`stripePayoutCardId`)
5. Creates direct Stripe transfers to debit cards (instant payout)
6. Returns transfer results

**Metadata Format** (stored in payment intent):
```json
{
  "payee_count": "2",
  "payee_0_pubkey": "02a1b2c3...",
  "payee_0_amount": "500",
  "payee_1_pubkey": "02d4e5f6...",
  "payee_1_amount": "4500"
}
```

### Affiliate Commission Flow

**Complete Alice → Bob → Carl Flow**:

1. **Setup Phase**:
```
Bob saves payout card (debit card or issued card)
→ POST /payout-card/save with paymentMethodId
→ Instant setup, no KYC required
→ Can use external debit card or Planet Nine issued card

Carl saves payout card
→ Same process
→ Both can now receive instant payouts
```

2. **Purchase Phase**:
```
Carl creates $50 product
→ Bob duplicates with 10% affiliate commission
→ Alice purchases via Bob's link

Payment intent created with metadata:
{
  "payee_count": "2",
  "payee_0_pubkey": "<Bob's pubKey>",
  "payee_0_amount": "500",      // $5 (10% commission)
  "payee_1_pubkey": "<Carl's pubKey>",
  "payee_1_amount": "4500"      // $45 (90% revenue)
}
```

3. **Transfer Phase**:
```
Alice confirms payment via Stripe
→ Payment status: succeeded
→ POST /payment/pi_xxx/process-transfers
→ Direct transfer $5 to Bob's payout card
→ Direct transfer $45 to Carl's payout card
→ Funds arrive in ~30 minutes (instant payout)
```

### Storage

Payout card IDs are stored in Addie user records:

```javascript
{
  uuid: "user-uuid",
  pubKey: "02a1b2c3...",
  stripeCustomerId: "cus_...",      // For making purchases
  stripePayoutCardId: "pm_...",     // For receiving payouts (debit card)
  stripeCardholderId: "ich_..."     // For virtual cards
}
```

### Testing

Comprehensive integration tests available in Sharon:

```bash
cd sharon
npm run test:the-advancement
```

**Test Coverage**:
- ✅ Check payout card status
- ✅ Save debit cards as payout destinations
- ✅ Validate debit-only restriction
- ✅ Create payment intents with splits
- ✅ Process instant transfers to payout cards
- ✅ Handle missing payout cards gracefully

See `/sharon/tests/the-advancement/README.md` for complete documentation.

### Integration with The Advancement App

The Advancement iOS and Android apps use these endpoints for:

**iOS** (`PaymentMethodViewController.swift`):
- `savePayoutCard()` - Saves debit card for payouts
- `getPayoutCardStatus()` - Checks payout card status

**Android** (`PaymentMethodActivity.kt`):
- Same two methods with Kotlin coroutines
- SharedPreferences for payout card ID storage

Both apps provide a "Receive Payments" tab with two-state UI:
1. **Not Setup**: List of available debit cards with "Use for Payouts" buttons
2. **Setup**: Payout card details with instant payout messaging

### Security

- **Sessionless Authentication**: All requests require cryptographic signatures
- **Card Ownership**: Payout card IDs linked to user's public key
- **Debit-Only Validation**: Only debit cards accepted as payout destinations
- **Transfer Validation**: Only transfers to verified payout cards
- **Metadata Security**: Payee data stored in payment intent metadata

### Benefits over Connected Accounts

1. **Instant Setup**: No KYC onboarding required
2. **Faster Payouts**: ~30 minutes vs 2-3 business days
3. **Works with Issued Cards**: Planet Nine virtual cards can receive payouts
4. **Simpler UX**: 2-state UI vs 3-state (not setup/pending/active)
5. **Lower Barrier**: Unbanked users with issued cards can receive payouts immediately

### Trade-offs

- **Higher Fees**: 1.5% per payout vs 0.25% for Connected Accounts
- **US-Only**: Direct debit card transfers only work in the US (acceptable for beta)

## Product Metadata in Stripe Dashboard (November 2025)

### Overview

All payment intents and transfers now include product metadata that appears in the Stripe Dashboard, making it easy to identify which products generated revenue and track affiliate commissions.

### What Shows Up in Stripe

**Payment Intent**:
- **Description** (most visible): "Purchase: Advanced React Course (with affiliate commission)"
- **Metadata**:
  - `product_name`: "Advanced React Course"
  - `product_id`: "prod_abc123" (optional)
  - `contract_uuid`: "uuid-..." (optional)
  - `emojicode`: "🌍🔑💎🌟💎🎨🐉📌" (optional)
  - `payee_count`: "2"
  - `payee_0_pubkey`: "02a1b2c3..."
  - `payee_0_amount`: "500"
  - `payee_1_pubkey`: "02d4e5f6..."
  - `payee_1_amount`: "4500"

**Transfer** (to payout cards):
- **Description**: "Advanced React Course - Affiliate payout"
- **Metadata**:
  - `product_name`: "Advanced React Course"
  - `commission_type`: "affiliate" or "creator"
  - `payee_pubkey`: "02a1b2c3..." (truncated to 20 chars)
  - `original_payment_intent`: "pi_abc123"
  - `product_id`: "prod_abc123" (if provided)
  - `contract_uuid`: "uuid-..." (if provided)
  - `emojicode`: "🌍🔑💎..." (if provided)

### API Usage

When creating a payment intent, include product information in the request body:

```javascript
POST /user/:uuid/processor/stripe/intent

{
  "timestamp": "1234567890",
  "amount": 5000,
  "currency": "usd",
  "payees": [
    { "pubKey": "02a1b2c3...", "amount": 500 },   // Affiliate
    { "pubKey": "02d4e5f6...", "amount": 4500 }   // Creator
  ],
  "signature": "...",

  // Product metadata (all optional)
  "productName": "Advanced React Course",
  "productId": "prod_abc123",
  "contractUuid": "uuid-...",
  "emojicode": "🌍🔑💎🌟💎🎨🐉📌"
}
```

### Implementation Details

**stripe.js** (`getStripePaymentIntent` function):
```javascript
// Accepts optional productInfo parameter
getStripePaymentIntent: async (foundUser, amount, currency, payees, savePaymentMethod = false, productInfo = {}) => {
  // Build description for dashboard
  let description = 'Product purchase';
  if(productInfo.productName) {
    description = `Purchase: ${productInfo.productName}`;
    if(payeeMetadata.payee_count > 1) {
      description += ' (with affiliate commission)';
    }
  }

  // Add product fields to metadata
  if(productInfo.productName) payeeMetadata.product_name = productInfo.productName;
  if(productInfo.productId) payeeMetadata.product_id = productInfo.productId;
  if(productInfo.contractUuid) payeeMetadata.contract_uuid = productInfo.contractUuid;
  if(productInfo.emojicode) payeeMetadata.emojicode = productInfo.emojicode;

  // Create payment intent with description + metadata
  const paymentIntent = await stripeSDK.paymentIntents.create({
    description: description, // Shows prominently in dashboard
    metadata: payeeMetadata,
    // ... other fields
  });
}
```

**Transfer Creation** (`processPaymentTransfers` function):
```javascript
// Read product info from payment intent metadata
const productName = metadata.product_name || 'Product';
const commissionType = i === 0 ? 'Affiliate' : 'Creator';

// Create descriptive transfer
const transfer = await stripeSDK.transfers.create({
  description: `${productName} - ${commissionType} payout`,
  metadata: {
    product_name: metadata.product_name,
    commission_type: commissionType.toLowerCase(),
    payee_pubkey: pubKey.substring(0, 20),
    original_payment_intent: paymentIntentId,
    // Optional fields copied from payment intent
    product_id: metadata.product_id,
    contract_uuid: metadata.contract_uuid,
    emojicode: metadata.emojicode
  }
});
```

### Benefits

1. **Easy Reconciliation**: See exactly which product generated each payment
2. **Debugging**: Trace payments from purchase → transfers using metadata
3. **Reporting**: Filter Stripe Dashboard by product name or ID
4. **Transparency**: Clear descriptions for all parties involved
5. **Contract Linking**: Connect payments to Covenant contracts via UUID

### Example Dashboard Flow

1. **Payment List**: "Purchase: Advanced React Course (with affiliate commission)"
2. **Click Payment**: See full metadata with product details and payee split
3. **View Transfers**: Two transfers show:
   - "Advanced React Course - Affiliate payout" ($5)
   - "Advanced React Course - Creator payout" ($45)
4. **Search**: Search for "Advanced React Course" to see all related transactions

## Stripe Issuing Cardholder Creation (November 2025)

### Overview

Addie provides a complete Stripe Issuing cardholder creation endpoint that collects KYC information from The Advancement apps and creates Stripe cardholders with proper TOS acceptance tracking.

### Endpoint

#### POST /issuing/cardholder

Creates a Stripe Issuing cardholder for users without traditional bank accounts.

**Request**:
```json
{
  "timestamp": "1234567890",
  "pubKey": "02a1b2c3...",
  "signature": "3045022100...",
  "individualInfo": {
    "firstName": "Jenny",
    "lastName": "Rosen",
    "name": "Jenny Rosen",
    "email": "jenny.rosen@example.com",
    "phoneNumber": "+18888675309",
    "dob": {
      "month": 1,
      "day": 1,
      "year": 1990
    },
    "address": {
      "line1": "1234 Main Street",
      "line2": "Apt 4B",
      "city": "San Francisco",
      "state": "CA",
      "postal_code": "94111",
      "country": "US"
    }
  }
}
```

**Response (Success)**:
```json
{
  "success": true,
  "cardholderId": "ich_1AbCdEfGhIjKlMn",
  "status": "active"
}
```

**Response (Error)**:
```json
{
  "success": false,
  "error": "The cardholder must provide a first and last name."
}
```

**Implementation** (`src/server/node/addie.js:422-443`):
```javascript
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
```

**Signature**: `timestamp + pubKey`

### Stripe Processor Function

**createCardholder** (`src/server/node/src/processors/stripe.js:400-444`):
```javascript
createCardholder: async (foundUser, individualInfo, ip) => {
  try {
    const { name, email, phoneNumber, address } = individualInfo;

    // Build billing address, only including line2 if it exists
    const billingAddress = {
      line1: address.line1,
      city: address.city,
      state: address.state,
      postal_code: address.postal_code,
      country: address.country || 'US'
    };

    // Only include line2 if it's not empty (Stripe requirement)
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
      tos_acceptance: tosAcceptance,
      status: 'active'
    });

    // Save cardholder ID to user record
    foundUser.stripeCardholderId = cardholder.id;
    await user.saveUser(foundUser);

    return {
      success: true,
      cardholderId: cardholder.id,
      status: cardholder.status
    };
  } catch(err) {
    console.error('Error creating cardholder:', err);
    return { success: false, error: err.message };
  }
}
```

### Key Implementation Details

**1. Real User IP Extraction**:
- Backend extracts IP from request headers: `req.headers['x-forwarded-for'] || req.socket.remoteAddress`
- IP is required for TOS acceptance compliance
- Handles both direct connections and proxied requests

**2. Conditional line2 Field**:
- Stripe rejects optional fields with null or empty string values
- Backend only includes `line2` in billingAddress if not empty
- Pattern: Build base object first, conditionally add optional fields

**3. TOS Acceptance**:
- Constructed by backend with real user IP and timestamp
- Frontend validates checkbox, but doesn't send tosAcceptance object
- Backend controls TOS data to ensure compliance

**4. Required Fields**:
- `firstName` and `lastName` - Required by Stripe Issuing
- `name` - Full name for cardholder
- `email` - Contact information
- `phoneNumber` - Contact information
- `dob` - Date of birth with day, month, year
- `address` - Billing address with line1, city, state, postal_code, country

**5. Storage**:
- Cardholder ID saved to user record as `stripeCardholderId`
- Enables future card issuance and management

### Error Handling

**Empty line2 Error**:
```
You passed an empty string for 'billing[address][line2]'. We assume empty values are an attempt to unset a parameter; however 'billing[address][line2]' cannot be unset.
```
**Fix**: Conditionally build billingAddress object, only include line2 if not empty string.

**Missing firstName/lastName Error**:
```
The cardholder must provide a first and last name.
```
**Fix**: Ensure The Advancement app extracts and forwards firstName/lastName fields.

**Missing TOS Acceptance Error**:
```
The cardholder must agree to the user terms and privacy policy.
```
**Fix**: Backend constructs tosAcceptance with real user IP from request headers.

### Integration with The Advancement

The Advancement iOS and Android apps call this endpoint after collecting KYC information through HTML forms:

**iOS** (`PaymentMethodViewController.swift`):
```swift
private func createCardholder(params: [String: Any], messageId: Any) {
    // Extract firstName, lastName from individualInfo
    // Forward to POST /issuing/cardholder
}
```

**Android** (`PaymentMethodActivity.kt`):
```kotlin
suspend fun createCardholder(paramsJson: String): String {
    // Extract fields from params
    // POST to /issuing/cardholder
}
```

### Benefits

1. **Financial Inclusion**: Users without bank accounts can receive virtual debit cards
2. **Real KYC**: Proper identity verification with required fields
3. **TOS Compliance**: Legally binding acceptance with IP and timestamp tracking
4. **Multi-Platform**: Same backend endpoint for iOS and Android
5. **Instant Issuance**: Cards can be issued immediately after cardholder creation

## Stripe Connected Accounts for Platform Revenue Splits (November 2025)

### Overview

For **platform-to-platform revenue splits** (like Mutopia's Mirlo/Jam.coop/Sanora integration), Addie uses **Stripe Connected Accounts** instead of payout cards. This enables automatic payment distribution to multiple music platforms when users purchase mixtapes.

**Use Case**: Platform revenue sharing (not individual affiliate commissions)
**Payout Speed**: 2-3 business days
**Fees**: 0.25% per transfer
**Setup**: Requires proper business information to enable transfers capability

### Critical Setup Requirements

Creating Stripe Connected Accounts that can receive transfers requires **specific business information**:

```javascript
// CORRECT - Enables transfers capability
putStripeAccount: async (foundUser, country, name, email, ip) => {
  const account = await stripeSDK.accounts.create({
    country: country,
    email: email,
    business_type: 'company',  // NOT 'individual'!
    company: {
      name: name,
      tax_id: '000000000',  // Stripe test tax ID (NOT tax_id_provided: true)
      address: {
        line1: 'address_full_match',  // Special Stripe test value
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94102',
        country: country
      }
    },
    business_profile: {
      mcc: '5734',  // Merchant category code
      url: 'https://allyabase.com'  // Real URL (NOT 'https://example.com')
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
      fees: { payer: 'application' },
      losses: { payments: 'application' },
      requirement_collection: 'application',
      stripe_dashboard: { type: 'none' }
    }
  });
}
```

### Common Errors and Fixes

#### Error: "Your destination account needs to have at least one enabled: transfers"

**Symptoms**:
```javascript
{
  failedTransfers: 3,
  transfers: [{
    error: "Your destination account needs to have at least one enabled: transfers, crypto_transfers, legacy_payments"
  }]
}
```

**Root Cause**: Connected Account's transfers capability is not active.

**Diagnosis**:
```bash
# Check capability status
const account = await stripe.accounts.retrieve('acct_xxx');
console.log(account.capabilities.transfers);  // Should be 'active', not 'inactive'
console.log(account.business_type);  // Should be 'company', not 'individual'
```

**Fix**: Update account with proper business information:
```javascript
await stripe.accounts.update('acct_xxx', {
  business_type: 'company',
  company: {
    name: 'Platform Name',
    tax_id: '000000000',  // Stripe test tax ID
    address: {
      line1: 'address_full_match',  // Bypasses verification in test mode
      city: 'San Francisco',
      state: 'CA',
      postal_code: '94102',
      country: 'US'
    }
  },
  business_profile: {
    mcc: '5734',
    url: 'https://allyabase.com'  // Must be real, valid URL
  },
  capabilities: {
    transfers: {
      requested: true
    }
  }
});
```

#### Error: "Received unknown parameter: company[tax_id_provided]"

**Cause**: Using `tax_id_provided: true` instead of providing actual tax ID.

**Fix**: Use `tax_id: '000000000'` (Stripe test value) instead.

#### Error: "Not a valid URL"

**Cause**: Using `'https://example.com'` which Stripe rejects.

**Fix**: Use a real URL like `'https://allyabase.com'`.

### Key Differences from Payout Cards

| Feature | Connected Accounts | Payout Cards |
|---------|-------------------|--------------|
| **Use Case** | Platform revenue splits | Individual affiliate commissions |
| **User Field** | `stripeAccountId` | `stripePayoutCardId` |
| **Endpoint** | `/process-connected-transfers` | `/process-transfers` |
| **Business Type** | `'company'` required | N/A |
| **Setup Complexity** | Business info + external account | Just save debit card |
| **Payout Speed** | 2-3 business days | ~30 minutes |
| **Fees** | 0.25% per transfer | 1.5% per payout |
| **Best For** | Large platforms (Mirlo, Jam.coop) | Individual creators/affiliates |

### Testing Connected Accounts

**1. Verify Capability Activation**:
```javascript
const account = await stripe.accounts.retrieve('acct_xxx');
console.log('Transfers:', account.capabilities.transfers);  // Should be 'active'
console.log('Charges:', account.charges_enabled);  // Should be true
console.log('Payouts:', account.payouts_enabled);  // Should be true
console.log('Requirements:', account.requirements.currently_due);  // Should be []
```

**2. Add External Bank Account** (test mode):
```javascript
await stripe.accounts.createExternalAccount('acct_xxx', {
  external_account: {
    object: 'bank_account',
    country: 'US',
    currency: 'usd',
    account_holder_name: 'Platform Name',
    account_holder_type: 'company',
    routing_number: '110000000',  // Stripe test routing
    account_number: '000123456789'  // Stripe test account
  }
});
```

**3. Test Transfer**:
```javascript
const transfer = await stripe.transfers.create({
  amount: 500,
  currency: 'usd',
  destination: 'acct_xxx',  // Connected Account ID
  description: 'Test platform payout'
});
```

### Implementation Files

- **Account Creation**: `/addie/src/server/node/src/processors/stripe.js` (putStripeAccount)
- **Transfer Processing**: `/addie/src/server/node/src/processors/stripe-connected-transfers.js`
- **Mutopia Integration**: `/mutopia/seed-platforms.js`, `/mutopia/CONNECTED-ACCOUNT-TRANSFERS.md`

### Documentation

See `/mutopia/CONNECTED-ACCOUNT-TRANSFERS.md` for complete implementation details, troubleshooting, and testing procedures.

## Embedded Connect onboarding, and the payout path (September 2026)

Written up after getting one real payment from a card to a creator's Stripe
balance, which took five stacked fixes. Four of them were here.

### Account Session, not Account Link

Stripe's **embedded** Connect components (what the getpayed iOS app now
presents in-app, instead of opening hosted onboarding in a browser) need a
session token from `accountSessions.create`. That is a different call from
the Account Link used for hosted onboarding, and the two are not
interchangeable.

- `ensureStripeExpressAccount` — creates or finds the user's Express account
- `createAccountSession` — mints the session the SDK consumes
- `getAccountStatus` — the real state, because account creation reports
  "connected" immediately and onboarding may be nowhere near finished

All three live in `src/processors/stripe.js`, exposed by the two routes
listed above. The client side (`addie-rs`:
`create_stripe_account_session`, `get_stripe_account_status`) treats **any
`{error}` body as a failure** regardless of status code — `json_or_error` —
because a 200 carrying an error body was being read as success.

### `transfers` needs `card_payments` next to it

Stripe refuses the `transfers` capability on its own without special platform
approval: *"you have requested the transfers capability without the
card_payments capability"*. **Both account-creation paths now request both.**
`card_payments` goes unused — nothing charges these accounts — but it is the
price of being able to transfer. The November 2025 example above shows
`capabilities: { transfers: { requested: true } }` alone; that is no longer
sufficient, and it does ask for more business detail during onboarding.

### Transfers must be funded from the charge

A transfer draws on the platform's **available** balance by default, which in
test mode is empty, so every payout failed with insufficient funds while the
charge had obviously succeeded. `stripe-connected-transfers.js` now passes
**`source_transaction`** (the PaymentIntent's `latest_charge`), which funds
the transfer from that charge directly and sidesteps the platform balance
entirely.

If you want the other behaviour, `pm_card_bypassPending` is the test card
that settles straight to available balance.

### The merchant has to be in the recipients list

`stripe-connected-transfers.js` builds a `recipients` list, and the merchant
was not in it: their `merchant_pubkey` / `merchant_amount` now go in
alongside the affiliate splits. Before that, knowing who the merchant was
changed nothing — nothing was transferred to them.

### addie-js 0.0.8 is the floor for eumachia

`getPaymentIntent` took five parameters and silently dropped the `merchant`
argument eumachia passes as its sixth. The intent then carried no
`merchant_pubkey`, the payout step found nobody to pay, and **the charge
succeeded while the creator's money stayed on the platform account** — the
worst possible failure shape, since every visible signal said paid.
Published as 0.0.8 with the sixth parameter. Don't relax that pin in
eumachia.

### Still missing

**No webhook or dispute handling anywhere in this stack** — not here, not in
eumachia, not in the apps. Payment outcomes are established by the payer's
browser reporting success and by polling, which is documented as acceptable
at this scale in getpayed's `CLAUDE.md` but is the first thing to fix if
money volume grows.

### Related

- **allyabase/CLAUDE.md** → "How the apps and services fit together" has the
  whole money path end to end, plus the rest of the integration seams.
- **eumachia/CLAUDE.md** — the caller: what it expects from
  `processConnectedTransfers`, and its 31-case Stripe test-mode suite, whose
  `test/README.md` names the card or token that triggers each failure.
- **getpayed/CLAUDE.md** — the app: the `PayoutRecord` states and reasons the
  payout leg is reported through, and why the Stripe iOS SDK links into the
  app target rather than the Tauri plugin.

## Last Updated
September 24, 2026 - Documented embedded Connect onboarding (Account
Sessions, the two new routes, 503 without keys) and the four fixes on the
payout path: `card_payments` alongside `transfers`, `source_transaction`
funding, the merchant in the recipients list, and addie-js 0.0.8. Corrected
the stated port to 3005. Nothing else in this file was re-verified; the
November 2025 material below predates all of it, and its Connected Accounts
example is missing `card_payments`.

November 19, 2025 - Added comprehensive Stripe Connected Accounts documentation for platform revenue splits. Documented critical setup requirements (business_type: 'company', tax_id, valid URL), common errors and fixes, and differences from payout cards. Includes complete code examples for account creation, capability troubleshooting, and transfer processing. Ready for production platform integrations.
