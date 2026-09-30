'use strict';

// The rules a machine credential has to hold, tested where they live.
//
// This is a new front door, so the tests are about what a key cannot do rather
// than what it can: it cannot be reproduced from what is stored, it cannot
// outlive its revocation, it cannot widen its own scope, and it cannot be told
// apart by an attacker guessing at halves of it.

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createApiKeyService, looksLikeApiKey } = require('./apiKeys');

function fresh(now) {
  const db = new Database(':memory:');
  return { db, keys: createApiKeyService({ db, now: now || (() => new Date()) }) };
}

const SCOPES = ['mail.*', 'site.list'];

function run() {
  testTheSecretIsShownOnceAndKeptNowhere();
  testAKeyIsRecognisedByItsOwnShape();
  testScopesNarrowAndNeverWiden();
  testAGroupScopeStopsAtTheDot();
  testRevocationIsImmediateAndIdempotent();
  testAnExpiredKeyIsRefused();
  testAWrongSecretOnARealPrefixIsRefused();
  testListingNeverCarriesTheSecretOrThePredicate();
  testAKeyWithNoScopeIsNotIssued();
  console.log('api-key tests passed');
}

function testTheSecretIsShownOnceAndKeptNowhere() {
  const { db, keys } = fresh();
  const issued = keys.issue({ name: 'billing', identityId: 'owner', orgId: 'org_1', capabilities: SCOPES, createdBy: 'owner' });
  assert.match(issued.token, /^jotpanel_[a-f0-9]{12}_[a-f0-9]{48}$/);

  // Everything the panel keeps, searched for the secret it was just handed.
  const stored = JSON.stringify(db.prepare('SELECT * FROM api_keys').all());
  const secret = issued.token.split('_')[2];
  assert.equal(stored.includes(secret), false, 'the secret must not be recoverable from what is stored');
  assert.equal(stored.includes(issued.token), false);
  // The prefix is public on purpose: it is how a key is recognised, listed and
  // revoked without the panel ever holding the part that proves it.
  assert.equal(stored.includes(issued.prefix), true);

  assert.equal(keys.verify(issued.token).id, issued.id);
  assert.equal(keys.verify(issued.token.replace(/^jotpanel_/, 'arca_')).id, issued.id,
    'keys issued before the rename remain valid');
}

function testAKeyIsRecognisedByItsOwnShape() {
  assert.equal(looksLikeApiKey('jotpanel_aabbccddeeff_' + 'a'.repeat(48)), true);
  assert.equal(looksLikeApiKey('arca_aabbccddeeff_' + 'a'.repeat(48)), true);
  assert.equal(looksLikeApiKey('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.x.y'), false);
  assert.equal(looksLikeApiKey(''), false);
  assert.equal(looksLikeApiKey(null), false);
  const { keys } = fresh();
  // Nothing that is not a key is ever a key, and none of these throw.
  for (const rubbish of ['arca_', 'arca_zzz_zzz', 'arca_aabbccddeeff_short', null, undefined, 42, {}]) {
    assert.equal(keys.verify(rubbish), null);
  }
}

function testScopesNarrowAndNeverWiden() {
  const { keys } = fresh();
  const issued = keys.issue({ name: 'mail only', identityId: 'owner', capabilities: SCOPES, createdBy: 'owner' });
  const key = keys.verify(issued.token);

  assert.equal(key.permits('mail.mailbox.create'), true);
  assert.equal(key.permits('site.list'), true);
  // The capability it was not given, even though the identity behind the key
  // may do it. A scope only ever narrows what its holder could already do.
  assert.equal(key.permits('site.delete'), false);
  assert.equal(key.permits('system.reboot'), false);
  assert.equal(key.permits(''), false);
  assert.equal(key.permits(undefined), false);

  // And a star is a star only when it was issued as one.
  const wide = keys.verify(keys.issue({ name: 'everything', identityId: 'owner', capabilities: ['*'], createdBy: 'owner' }).token);
  assert.equal(wide.permits('system.reboot'), true);
}

function testAGroupScopeStopsAtTheDot() {
  const { keys } = fresh();
  const key = keys.verify(keys.issue({ name: 'mail', identityId: 'owner', capabilities: ['mail.*'], createdBy: 'owner' }).token);
  assert.equal(key.permits('mail.mailbox.create'), true);
  assert.equal(key.permits('mail'), true);
  // `mailauth.setup` begins with the same five letters and is a different thing.
  // A prefix match on the letters rather than on the dot would hand a mail key
  // the DKIM and SPF setup nobody scoped it for.
  assert.equal(key.permits('mailauth.setup'), false);
}

function testRevocationIsImmediateAndIdempotent() {
  const { keys } = fresh();
  const issued = keys.issue({ name: 'temporary', identityId: 'owner', capabilities: SCOPES, createdBy: 'owner' });
  assert.ok(keys.verify(issued.token));

  keys.revoke(issued.id, 'owner');
  assert.equal(keys.verify(issued.token), null, 'a revoked key is refused on the next call, not the next restart');

  // Asking twice is not an error: the caller wanted it dead and it is dead.
  const again = keys.revoke(issued.id, 'owner');
  assert.ok(again.revokedAt);
  assert.throws(() => keys.revoke('key_nothing', 'owner'), /no key with that id/);
}

function testAnExpiredKeyIsRefused() {
  let clock = new Date('2026-08-24T10:00:00.000Z');
  const { keys } = fresh(() => clock);
  const issued = keys.issue({
    name: 'short lived', identityId: 'owner', capabilities: SCOPES, createdBy: 'owner',
    expiresAt: '2026-08-24T11:00:00.000Z',
  });
  assert.ok(keys.verify(issued.token));

  clock = new Date('2026-08-24T11:00:00.000Z');
  assert.equal(keys.verify(issued.token), null, 'expiry is at the moment stated, not after it');
  clock = new Date('2026-08-25T09:00:00.000Z');
  assert.equal(keys.verify(issued.token), null);
}

function testAWrongSecretOnARealPrefixIsRefused() {
  const { keys } = fresh();
  const issued = keys.issue({ name: 'billing', identityId: 'owner', capabilities: SCOPES, createdBy: 'owner' });
  const wrong = `jotpanel_${issued.prefix}_${'b'.repeat(48)}`;
  assert.equal(keys.verify(wrong), null, 'knowing the public half proves nothing');
  // The real one still works afterwards: a failed attempt does not spend a key.
  assert.ok(keys.verify(issued.token));
}

function testListingNeverCarriesTheSecretOrThePredicate() {
  const { keys } = fresh();
  const issued = keys.issue({ name: 'billing', identityId: 'owner', capabilities: SCOPES, createdBy: 'owner' });
  const [listed] = keys.list('owner');
  assert.equal(listed.prefix, issued.prefix);
  assert.deepEqual(listed.capabilities, SCOPES);
  assert.equal('token' in listed, false);
  assert.equal('secret_hash' in listed, false);
  // `permits` is a function and a listing is JSON on its way to a browser. It is
  // left off rather than serialised into nothing.
  assert.equal('permits' in listed, false);
  assert.deepEqual(keys.list('somebody-else'), []);
}

function testAKeyWithNoScopeIsNotIssued() {
  const { keys } = fresh();
  // A key that can do nothing is not a safe default, it is a support ticket.
  assert.throws(() => keys.issue({ name: 'empty', identityId: 'owner', capabilities: [], createdBy: 'owner' }), /can do nothing/);
  assert.throws(() => keys.issue({ name: 'rubbish', identityId: 'owner', capabilities: ['../etc/passwd'], createdBy: 'owner' }), /can do nothing/);
  assert.throws(() => keys.issue({ name: 'nobody', identityId: '', capabilities: SCOPES, createdBy: 'owner' }), /belongs to an identity/);
}

run();
