// How a payment with a merchant is split, kept free of the Stripe SDK so it
// can be tested on its own.
//
// Order of deductions: Stripe's processing fee comes off the charge first,
// the platform takes PLATFORM_FEE_PERCENT of the invoice amount, and the
// merchant (the invoice's creator) receives the rest. At the default 0.9%, a
// $100.00 invoice is Stripe $3.20, platform $0.90, merchant $95.90.
//
// Until October 2026 the merchant got a flat 91% and the platform's 9%
// absorbed Stripe's fee. A share that small can't absorb the fee any more,
// which is why the fee now comes off first and the merchant bears it.
//
// Affiliate payees (each with a percent of at most 9) still split the
// platform's part, as before.

export const DEFAULT_PLATFORM_FEE_PERCENT = 0.9;

// Read per call, so tests can pass their own; a running server picks up a
// changed environment only on restart (pm2 restart addie --update-env).
export const platformFeePercent = (raw = process.env.PLATFORM_FEE_PERCENT) => {
  if (raw === undefined || raw === '') return DEFAULT_PLATFORM_FEE_PERCENT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 50) {
    console.warn(`PLATFORM_FEE_PERCENT=${raw} isn't a percentage between 0 and 50; using ${DEFAULT_PLATFORM_FEE_PERCENT}.`);
    return DEFAULT_PLATFORM_FEE_PERCENT;
  }
  return n;
};

// Standard US Stripe processing fee: 2.9% + $0.30.
export const calculateStripeFee = (amount) => Math.round(amount * 0.029) + 30;

// Payment intent metadata naming who gets what, in cents.
export const buildPayeeMetadata = (payees, merchant, amount, feePercent = platformFeePercent()) => {
  const stripeFee = calculateStripeFee(amount);
  const net = Math.max(0, amount - stripeFee);
  const platformFee = merchant ? Math.min(net, Math.round(amount * feePercent / 100)) : 0;
  const merchantAmount = merchant ? Math.max(0, net - platformFee) : 0;
  const distributable = Math.max(0, net - merchantAmount);

  const metadata = {};

  if (merchant) {
    metadata.merchant_pubkey = merchant.pubKey;
    metadata.merchant_amount = merchantAmount.toString();
    metadata.platform_fee = platformFee.toString();
    metadata.platform_fee_percent = feePercent.toString();
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
