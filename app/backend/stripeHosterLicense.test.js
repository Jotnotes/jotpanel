'use strict';

// The Stripe side of the hoster licence: checkout validation, webhook
// signature verification, and turning a paid subscription into the same
// allocation shape the vendor can hand out by hand. Broken by trying each way
// a bad or replayed webhook could create seats nobody paid for.
//
// /checkout/success is not exercised here: it calls Stripe's API to look up
// the session, which needs a real network call this offline suite does not
// make. It is covered instead by a live run against Stripe's own test mode.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Stripe = require('stripe');

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arca-stripe-')), 'licenses.db');
process.env.LICENSE_DB = DB;
process.env.LICENSE_ADMIN_KEY = 'test-admin-key-for-stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_offline_fake_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_offline_fake_secret';
process.env.STRIPE_HOSTER_PRICE_ID = 'price_offline_fake';

const { app, db } = require('./license-server');

const JSON_HEADERS = { 'Content-Type': 'application/json' };
let base = '';

async function call(method, route, body, headers = JSON_HEADERS) {
  const res = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* html or empty */ }
  return { status: res.status, body: parsed || {} };
}

function signedWebhook(payloadObject) {
  const payload = JSON.stringify(payloadObject);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return { payload, header };
}

async function postWebhook(payloadObject, headerOverride) {
  const { payload, header } = signedWebhook(payloadObject);
  const res = await fetch(`${base}/webhook/stripe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': headerOverride || header },
    body: payload,
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* */ }
  return { status: res.status, body: parsed || {} };
}

function checkoutCompletedEvent({ id, subscriptionId, customerId, email, name, seats }) {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        mode: 'subscription',
        subscription: subscriptionId,
        customer: customerId,
        customer_email: email,
        metadata: { holder_email: email, holder_name: name || '', seats: String(seats) },
      },
    },
  };
}

async function run() {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    // ── Checkout validation, no network needed: these all return before Stripe is called ──
    {
      const bad = await call('POST', '/checkout/hoster', { email: 'not-an-email', seats: 3 });
      assert.equal(bad.status, 400, 'a malformed email is refused before Stripe is ever asked');
    }
    {
      const bad = await call('POST', '/checkout/hoster', { email: 'host@example.com', seats: 0 });
      assert.equal(bad.status, 400, 'zero seats is refused');
    }
    console.log('ok  checkout validation refuses a bad email and zero seats without touching Stripe');

    // ── Webhook signature verification ──
    {
      const forged = await postWebhook(
        checkoutCompletedEvent({ id: 'evt_forged', subscriptionId: 'sub_x', customerId: 'cus_x', email: 'a@b.com', seats: 3 }),
        'v1=not-a-real-signature'
      );
      assert.equal(forged.status, 400, 'a forged signature is rejected');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allocations').get().n, 0, 'a forged event creates nothing');
    }
    console.log('ok  a webhook with a forged signature is refused and creates no allocation');

    // ── A genuine paid checkout becomes an allocation ──
    {
      const evt = checkoutCompletedEvent({ id: 'evt_1', subscriptionId: 'sub_1', customerId: 'cus_1', email: 'hoster@example.com', name: 'Example Hosting', seats: 6 });
      const res = await postWebhook(evt);
      assert.equal(res.status, 200);
      const row = db.prepare('SELECT * FROM allocations WHERE stripe_subscription_id=?').get('sub_1');
      assert.ok(row, 'the paid subscription produced an allocation');
      assert.equal(row.holder_email, 'hoster@example.com');
      assert.equal(row.seats, 6, 'seats come from the metadata set at checkout time, not re-derived later');
      assert.equal(row.parent_id, null, 'a Stripe-paid allocation is a root allocation, same as one the vendor hands out');
      assert.ok(row.pending_reveal_token, 'a token is waiting to be revealed on the success page');
      assert.equal(row.status, 'active');
    }
    console.log('ok  a completed checkout creates a root allocation sized to the seats that were paid for');

    // ── Stripe redelivers the same event: must not double-issue ──
    {
      const evt = checkoutCompletedEvent({ id: 'evt_1', subscriptionId: 'sub_1', customerId: 'cus_1', email: 'hoster@example.com', seats: 6 });
      const res = await postWebhook(evt);
      assert.equal(res.status, 200);
      assert.equal(res.body.duplicate, true);
      const count = db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE stripe_subscription_id=?').get('sub_1').n;
      assert.equal(count, 1, 'a redelivered event id is a no-op, not a second allocation');
    }
    console.log('ok  a redelivered webhook event is a no-op rather than a second allocation');

    // ── Same subscription, a different event id (the crash-between-insert-and-200 case) ──
    {
      const evt = checkoutCompletedEvent({ id: 'evt_1_retry_different_id', subscriptionId: 'sub_1', customerId: 'cus_1', email: 'hoster@example.com', seats: 6 });
      await postWebhook(evt);
      const count = db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE stripe_subscription_id=?').get('sub_1').n;
      assert.equal(count, 1, 'idempotency holds on the subscription id even under a fresh event id');
    }
    console.log('ok  idempotency is keyed on the subscription, not only the event id');

    // ── A seat-count change on the subscription updates the allocation ──
    {
      const res = await postWebhook({
        id: 'evt_2', type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', items: { data: [{ quantity: 12 }] } } },
      });
      assert.equal(res.status, 200);
      const row = db.prepare('SELECT seats FROM allocations WHERE stripe_subscription_id=?').get('sub_1');
      assert.equal(row.seats, 12, 'a quantity change on the Stripe subscription updates the allocation seat count');
    }
    console.log('ok  a subscription quantity update changes the allocation\'s seat count');

    // ── Cancelling the subscription revokes the allocation ──
    {
      const res = await postWebhook({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
      assert.equal(res.status, 200);
      const row = db.prepare('SELECT status FROM allocations WHERE stripe_subscription_id=?').get('sub_1');
      assert.equal(row.status, 'revoked', 'a cancelled subscription revokes the allocation, freeing its seats');
    }
    console.log('ok  a cancelled Stripe subscription revokes the allocation');

    // ── A revoked allocation cannot still issue keys ──
    {
      const row = db.prepare('SELECT token_prefix FROM allocations WHERE stripe_subscription_id=?').get('sub_1');
      // The token was already revealed and discarded by design; reach the
      // allocation as the vendor instead, to check revocation itself holds.
      const view = await call('GET', `/allocations/${db.prepare('SELECT id FROM allocations WHERE stripe_subscription_id=?').get('sub_1').id}`, undefined, { 'x-admin-key': process.env.LICENSE_ADMIN_KEY });
      assert.equal(view.body.usable, false, 'a revoked, Stripe-cancelled allocation is not usable, same rule as any other');
    }
    console.log('ok  a Stripe-cancelled allocation is unusable through the same admin view as any other');

    console.log('stripe hoster licence tests passed');
  } finally {
    server.close();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
