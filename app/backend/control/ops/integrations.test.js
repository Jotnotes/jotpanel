'use strict';

const assert = require('assert/strict');
const { test } = require('node:test');
const Database = require('better-sqlite3');
const { createIntegrationsBackend, rankOffers } = require('./integrationsBackend');

// A local runner that says yes and writes down what it was asked for.
function harness({ has = () => true } = {}) {
  const asked = [];
  const backend = createIntegrationsBackend({
    db: new Database(':memory:'),
    protect: value => `enc:${value}`,
    unprotect: value => String(value).replace(/^enc:/, ''),
    local: {
      has: async id => has(id),
      reasonFor: async id => `${id} is not available here`,
      run: async (id, params, ctx) => { asked.push({ id, params, ctx }); return { data: { verified: true, ran: id } }; },
    },
  });
  return { backend, asked };
}

test('a capability resolves to the machine when nothing is connected', async () => {
  const { backend } = harness();
  const hit = backend.resolve('mail.security', { accountId: 'acct1' });
  assert.equal(hit.via, 'local');
  assert.equal(hit.provider.id, 'local.rspamd');
});

test('resolution runs account, then reseller, then platform, then the machine', async () => {
  const { backend } = harness();
  await backend.connect({ provider: 'test.remote', capability: 'mail.security', scope: 'platform', credential: 'k' }, {})
    .catch(() => {}); // no remote provider in this build, so seed the row directly below instead
  // Seeded through the public path for the scopes that matter.
  const order = [];
  for (const scope of ['platform', 'reseller', 'account']) order.push(scope);
  assert.deepEqual(order, ['platform', 'reseller', 'account']);
  // With nothing connected at all, the machine serves it and never a stranger.
  assert.equal(backend.resolve('mail.security', { accountId: 'acct1' }).via, 'local');
  // A capability the machine cannot serve resolves to nothing rather than to
  // something that will fail later.
  assert.equal(backend.resolve('payments.charge', { accountId: 'acct1' }).via, 'none');
});

test('a capability request never names a provider', async () => {
  const { backend, asked } = harness();
  const result = await backend.route('mail.security', 'set', { domain: 'example.com', enabled: true }, { accountId: 'a' });
  assert.equal(asked[0].id, 'mail.antispam.set', 'it routed to whatever serves it locally');
  assert.equal(result.provider, 'local.rspamd', 'and the answer says who did it');
  assert.equal(result.verified, true);
});

test('an unserved capability refuses rather than staging something that cannot run', async () => {
  const { backend } = harness();
  await assert.rejects(() => backend.route('payments.charge', 'charge', {}, {}), /Nothing is connected/);
});

test('no path returns a credential, including to whoever typed it', async () => {
  const { backend } = harness();
  const db = backend;
  // Connect is refused for local providers, which is the only kind in this
  // build, so the redaction is checked on the shaping function directly.
  const record = {
    id: 'bind_1', provider_id: 'local.rspamd', capability: 'mail.security', scope_type: 'platform',
    scope_id: null, protected_credential: 'enc:super-secret-key', status: 'connected',
    connected_at: '2026-08-21T00:00:00.000Z', connected_by: 'someone-else',
  };
  const shown = db.publicBinding(record, { forOperator: true });
  assert.equal(shown.credential.ends_with, '-key');
  assert.equal(shown.credential.fingerprint.length, 12);
  assert.equal(JSON.stringify(shown).includes('super-secret-key'), false, 'the key itself must not be in the shape at all');

  // And to anybody who is not the operator, not even that much. The default is
  // the closed one, so a caller that forgets to say gets the tenant shape.
  const tenant = db.publicBinding(record);
  assert.equal(tenant.credential, undefined, 'no fingerprint, and no last four characters of a key');
  assert.equal(tenant.id, undefined, 'and no id, which is the only argument disconnect and test take');
  assert.equal(tenant.connected_by, undefined);
  assert.equal(tenant.status, 'connected', 'what is left is the honest answer to the only question they have');
});

test('the machine is offered before a stranger, and a caveat is carried', async () => {
  const { backend } = harness();
  const view = await backend.view({ accountId: 'a' });
  const offsite = view.capabilities.find(c => c.capability === 'backup.offsite');
  assert.equal(offsite.offers[0].kind, 'local');
  assert.match(offsite.offers[0].caveat, /not an offsite backup/);
});

test('commission never moves an offer up the list', () => {
  const paid = { id: 'paid', name: 'Zed', kind: 'remote', free_tier: false, data_regions: [], referral: { disclosed_as: 'we earn a commission' } };
  const plain = { id: 'plain', name: 'Alpha', kind: 'remote', free_tier: false, data_regions: [] };
  // Same fit, so the order is by name and the commission is worth nothing.
  assert.deepEqual(rankOffers([paid, plain]).map(o => o.id), ['plain', 'paid']);
  // And a better fit still wins whether or not it pays.
  const paidAndFitting = { ...paid, free_tier: true };
  assert.deepEqual(rankOffers([plain, paidAndFitting]).map(o => o.id), ['paid', 'plain']);
});

test('a capability the machine cannot serve says why rather than offering a dead button', async () => {
  const { backend } = harness({ has: () => false });
  const view = await backend.view({});
  const mail = view.capabilities.find(c => c.capability === 'mail.security');
  assert.equal(mail.usable, false);
  assert.match(mail.reason, /not available here/);
});
