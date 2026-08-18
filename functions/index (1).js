/**
 * Dominion Home Hub — Paystack payment functions.
 *
 * WHY THIS EXISTS ON A SEPARATE TRACK:
 * Real payments cannot run in client-side JavaScript talking directly to
 * Firebase Realtime Database — creating a subaccount, verifying a bank
 * account, and confirming a webhook all require a secret key that must
 * never reach the browser. These Cloud Functions are that trusted server.
 *
 * BEFORE DEPLOYING, YOU NEED:
 *   1. A Paystack account — https://dashboard.paystack.com/#/signup
 *      Test-mode API keys work immediately, no business verification
 *      needed until you're ready to go live and move real money.
 *   2. Firebase project upgraded to the Blaze (pay-as-you-go) plan —
 *      Cloud Functions do not run on the free Spark plan. This is
 *      required regardless of which payment provider you use.
 *   3. Your Paystack secret key set as function config (see DEPLOY.md).
 *
 * CURRENCY NOTE: property prices and offer amounts are stored as plain
 * numbers with no currency field. This code treats that number as NGN
 * when charging via Paystack. If you want USD-priced properties to
 * actually charge in USD, properties need a real currency field added —
 * that's not built yet. See the note left with the team on this.
 *
 * PLATFORM_FEE_RATE below must match the rate used in admin-dashboard.html's
 * manual "Confirm sale" flow, so the numbers stay consistent whichever path
 * a sale went through.
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.database();

const PAYSTACK_SECRET_KEY = functions.config().paystack.secret_key;
const PLATFORM_FEE_RATE = 0.05; // 5% — keep in sync with admin-dashboard.html

// Every price in this app (offer.amount, property.price) is a plain number
// meant as USD — that's what formatPrice() across every page assumes when
// displaying it. Paystack charges in NGN. This fixed rate converts USD to
// NGN at charge time, then converts the confirmed NGN payment back to USD
// when recording the transaction, so transactions.amount stays USD like
// everything else in the app (including the admin's manual "Confirm sale"
// flow, which uses offer.amount directly with no conversion).
//
// This is a MANUAL PEG, not a live exchange rate — it matches the same
// fixed rate already used for display-only currency conversion on the
// homepage (CURRENCY_RATES.NGN in index.html). Update both together if you
// change it, and consider swapping this for a live FX rate API before
// handling real transaction volume, since a stale peg either overcharges
// buyers or undercharges — i.e. underpays — sellers as rates drift.
const USD_TO_NGN_RATE = 1550;

async function paystackRequest(path, options = {}) {
  const resp = await fetch(`https://api.paystack.co${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const json = await resp.json();
  if (!json.status) {
    throw new functions.https.HttpsError('internal', json.message || 'Paystack request failed.');
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// 1. List banks — populates the bank dropdown in dashboard.html's payout
//    setup form. No auth required; this is public reference data.
// ---------------------------------------------------------------------------
exports.listBanks = functions.https.onCall(async () => {
  const banks = await paystackRequest('/bank?country=nigeria&currency=NGN');
  return { banks: banks.map(b => ({ name: b.name, code: b.code })) };
});

// ---------------------------------------------------------------------------
// 2. Resolve bank account — verifies an account number against a bank code
//    and returns the account holder's name, so the seller can confirm it's
//    really their account before we create a subaccount around it.
// ---------------------------------------------------------------------------
exports.resolveBankAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }
  const { accountNumber, bankCode } = data;
  if (!accountNumber || !bankCode) {
    throw new functions.https.HttpsError('invalid-argument', 'Account number and bank are required.');
  }
  const result = await paystackRequest(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  return { accountName: result.account_name };
});

// ---------------------------------------------------------------------------
// 3. Create seller subaccount — this is Paystack's equivalent of Stripe
//    Connect. percentage_charge is the cut Paystack routes to the MAIN
//    (platform) account on every split payment; the rest settles straight
//    to the seller's bank account automatically. Call this from
//    dashboard.html's Profile tab, after resolveBankAccount has confirmed
//    the account name.
// ---------------------------------------------------------------------------
exports.createSellerSubaccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }
  const uid = context.auth.uid;
  const userSnap = await db.ref(`users/${uid}`).get();
  if (!userSnap.exists() || userSnap.val().role !== 'seller') {
    throw new functions.https.HttpsError('permission-denied', 'Only sellers can set up a payout account.');
  }
  const user = userSnap.val();
  const { accountNumber, bankCode, accountName } = data;
  if (!accountNumber || !bankCode || !accountName) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing account details.');
  }

  const subaccount = await paystackRequest('/subaccount', {
    method: 'POST',
    body: JSON.stringify({
      business_name: user.displayName || accountName,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: PLATFORM_FEE_RATE * 100
    })
  });

  await db.ref(`users/${uid}`).update({
    paystackSubaccountCode: subaccount.subaccount_code,
    paystackAccountName: accountName,
    paystackAccountNumberLast4: accountNumber.slice(-4)
  });

  return { subaccountCode: subaccount.subaccount_code };
});

// ---------------------------------------------------------------------------
// 4. Initialize transaction — called when a buyer clicks "Pay now" on an
//    accepted offer. Starts a split payment: Paystack takes the platform's
//    percentage automatically and settles the rest to the seller's
//    subaccount, no manual transfer step needed on our end.
// ---------------------------------------------------------------------------
exports.initializeTransaction = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Must be signed in.');
  }
  const { offerId, callbackUrl } = data;
  const offerSnap = await db.ref(`offers/${offerId}`).get();
  if (!offerSnap.exists()) throw new functions.https.HttpsError('not-found', 'Offer not found.');
  const offer = offerSnap.val();

  if (offer.buyerId !== context.auth.uid) {
    throw new functions.https.HttpsError('permission-denied', 'This is not your offer.');
  }
  if (offer.status !== 'accepted') {
    throw new functions.https.HttpsError('failed-precondition', 'This offer has not been accepted yet.');
  }

  const sellerSnap = await db.ref(`users/${offer.sellerId}`).get();
  const seller = sellerSnap.exists() ? sellerSnap.val() : null;
  if (!seller || !seller.paystackSubaccountCode) {
    throw new functions.https.HttpsError('failed-precondition', 'This seller has not connected a payout account yet.');
  }

  const buyerSnap = await db.ref(`users/${context.auth.uid}`).get();
  const buyer = buyerSnap.exists() ? buyerSnap.val() : {};
  if (!buyer.email) {
    throw new functions.https.HttpsError('failed-precondition', 'Your account is missing an email address.');
  }

  // offer.amount is USD (see USD_TO_NGN_RATE note above) — convert before charging.
  const amountNgn = offer.amount * USD_TO_NGN_RATE;
  const amountKobo = Math.round(amountNgn * 100);

  const transaction = await paystackRequest('/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: buyer.email,
      amount: amountKobo,
      subaccount: seller.paystackSubaccountCode,
      callback_url: callbackUrl,
      metadata: { offerId, propertyId: offer.propertyId, buyerId: offer.buyerId, sellerId: offer.sellerId }
    })
  });

  return { authorizationUrl: transaction.authorization_url };
});

// ---------------------------------------------------------------------------
// 5. Webhook — Paystack calls this when payment actually completes. This
//    replaces the admin's manual "Confirm sale" button once payments are
//    live: it writes the same transactions/{id} shape (plus the userTransactions
//    index entries), so nothing else in the app needs to change.
//
//    Register this URL in the Paystack dashboard under Settings > API Keys
//    & Webhooks. Paystack signs every webhook with your secret key — no
//    separate webhook secret to configure, unlike Stripe.
// ---------------------------------------------------------------------------
exports.paystackWebhook = functions.https.onRequest(async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY).update(req.rawBody).digest('hex');
  if (hash !== signature) {
    console.error('Webhook signature mismatch.');
    res.status(401).send('Invalid signature');
    return;
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const { offerId, propertyId, buyerId, sellerId } = event.data.metadata || {};
    if (!offerId || !propertyId || !buyerId || !sellerId) {
      console.error('Webhook missing expected metadata:', event.data.metadata);
      res.status(200).send('OK'); // acknowledge anyway — don't make Paystack retry a malformed event forever
      return;
    }
    const amountNgnCharged = event.data.amount / 100;
    const amount = Math.round((amountNgnCharged / USD_TO_NGN_RATE) * 100) / 100; // back to USD, matching transactions.amount everywhere else in the app
    const fee = Math.round(amount * PLATFORM_FEE_RATE * 100) / 100;

    const newTxRef = db.ref('transactions').push();
    const txId = newTxRef.key;
    const updates = {};
    // amount/platformFee/sellerPayout are USD-equivalent, for display
    // consistency with the rest of the app. The actual money movement is
    // in NGN and is computed + settled by Paystack itself from
    // percentage_charge on the subaccount — these fields don't drive any
    // real payout, they're just what shows up on screen.
    updates[`transactions/${txId}`] = {
      offerId, propertyId, buyerId, sellerId,
      amount, platformFee: fee, sellerPayout: amount - fee,
      amountNgnCharged, exchangeRateUsed: USD_TO_NGN_RATE,
      status: 'completed', method: 'paystack',
      paystackReference: event.data.reference,
      createdAt: Date.now()
    };
    updates[`userTransactions/${buyerId}/${txId}`] = true;
    updates[`userTransactions/${sellerId}/${txId}`] = true;
    updates[`properties/${propertyId}/status`] = 'sold';
    await db.ref().update(updates);
  }

  res.status(200).send('OK');
});
