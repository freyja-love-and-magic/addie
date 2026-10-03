import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayeeMetadata, calculateStripeFee, platformFeePercent } from '../src/processors/payee-split.js';

const merchant = { pubKey: '02aa' };

test('Stripe fee first, then 0.9% to the platform, the rest to the merchant', () => {
  const m = buildPayeeMetadata([], merchant, 10000, 0.9);
  assert.equal(m.stripe_fee, '320');       // 2.9% + 30c of $100
  assert.equal(m.platform_fee, '90');      // 0.9% of $100
  assert.equal(m.merchant_amount, '9590'); // $100 - $3.20 - $0.90
  assert.equal(m.merchant_pubkey, '02aa');
});

test('the eumachia test invoice: $25.00', () => {
  const m = buildPayeeMetadata([], merchant, 2500, 0.9);
  assert.equal(calculateStripeFee(2500), 103);
  assert.equal(m.platform_fee, '23');
  assert.equal(m.merchant_amount, '2374');
});

test('the parts never add up to more than the charge', () => {
  for (const amount of [50, 100, 999, 2500, 123456]) {
    const m = buildPayeeMetadata([], merchant, amount, 0.9);
    const total = Number(m.stripe_fee) + Number(m.platform_fee) + Number(m.merchant_amount);
    assert.ok(total <= Math.max(amount, Number(m.stripe_fee)), `${amount}: ${total}`);
    assert.ok(Number(m.merchant_amount) >= 0);
  }
});

test('a payment too small to cover Stripe pays nobody a negative amount', () => {
  const m = buildPayeeMetadata([], merchant, 25, 0.9);
  assert.equal(m.merchant_amount, '0');
  assert.equal(m.platform_fee, '0');
});

test('affiliates split the platform part, as before', () => {
  const m = buildPayeeMetadata([{ pubKey: '03bb', percent: 9 }], merchant, 10000, 0.9);
  assert.equal(m.payee_count, '1');
  assert.equal(m.payee_0_amount, '90');
});

test('no merchant: unchanged, payees share the net', () => {
  const m = buildPayeeMetadata([{ pubKey: '03bb', percent: 9 }], null, 10000, 0.9);
  assert.equal(m.merchant_pubkey, undefined);
  assert.equal(m.payee_0_amount, '9680');
});

test('PLATFORM_FEE_PERCENT', () => {
  assert.equal(platformFeePercent(undefined), 0.9);
  assert.equal(platformFeePercent(''), 0.9);
  assert.equal(platformFeePercent('2.5'), 2.5);
  assert.equal(platformFeePercent('0'), 0);
  assert.equal(platformFeePercent('nine'), 0.9);
  assert.equal(platformFeePercent('80'), 0.9);
});
