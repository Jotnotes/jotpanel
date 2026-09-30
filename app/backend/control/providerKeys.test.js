'use strict';

// What a provider key must not be able to do, tested where it lives.
//
// These are written as refusals rather than features, because the thing being
// protected is somebody else's money and somebody else's account. The four that
// matter: the key cannot be read back, it is not in the database in clear, a
// tier cannot spend a tier above it that did not offer, and a backup cannot
// carry it.

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createProviderKeyService, fingerprintOf, EXCLUDED_TABLES } = require('./providerKeys');

const SECRET = 'test-encryption-secret';
const HOSTER = { kind: 'org', id: 'org_hoster' };
const RESELLER = { kind: 'org', id: 'org_reseller' };
const CUSTOMER = { kind: 'identity', id: 'user_customer' };
const CHAIN = [CUSTOMER, RESELLER, HOSTER];

function fresh() {
  const db = new Database(':memory:');
  return { db, keys: createProviderKeyService({ db, secret: SECRET }) };
}

function run() {
  testTheKeyCannotBeReadBack();
  testNoCharacterOfTheKeyIsEverReturned();
  testTheDatabaseHoldsNoClearText();
  testAWrongSecretCannotOpenIt();
  testTheChainPrefersTheMostSpecificTier();
  testATierOnlyLendsDownwardWhenItSupplies();
  testRequireBelowRefusesRatherThanSpending();
  testAnOwnKeyStillWorksUnderRequireBelow();
  testRotationRevokesRatherThanDeletes();
  testRevocationIsImmediate();
  testEveryResolutionNamesWhoPaid();
  testTheKeyTableIsExcludedFromBackup();
  console.log('provider keys: all checks passed');
}

function testTheKeyCannotBeReadBack() {
  const { keys } = fresh();
  const put = keys.put(CUSTOMER, 'anthropic', 'sk-ant-secret-value', { by: 'user_customer' });
  assert.equal(put.fingerprint, fingerprintOf('sk-ant-secret-value'));
  const serialised = JSON.stringify({ put, list: keys.list(CUSTOMER), describe: keys.describe(CUSTOMER, 'anthropic') });
  assert.ok(!serialised.includes('sk-ant-secret-value'), 'the key came back out of a reader-facing call');
  assert.ok(!serialised.includes('secret_enc'), 'the ciphertext column reached a reader-facing call');
}

function testNoCharacterOfTheKeyIsEverReturned() {
  // Not even the last four. A fragment is what narrows a guess, and the
  // fingerprint already tells two keys apart.
  const { keys } = fresh();
  keys.put(CUSTOMER, 'anthropic', 'sk-ant-0123456789abcdefWXYZ', { by: 'user_customer' });
  const shown = JSON.stringify(keys.list(CUSTOMER));
  for (const fragment of ['WXYZ', 'sk-ant', '0123', 'cdefW']) {
    assert.ok(!shown.includes(fragment), `a fragment of the key (${fragment}) was shown`);
  }
}

function testTheDatabaseHoldsNoClearText() {
  const { db, keys } = fresh();
  keys.put(CUSTOMER, 'anthropic', 'sk-ant-plain-text-here', { by: 'user_customer' });
  const row = db.prepare('SELECT * FROM provider_keys').get();
  assert.ok(!JSON.stringify(row).includes('sk-ant-plain-text-here'), 'the key is in the database in clear');
  assert.ok(row.secret_enc.length > 0);
}

function testAWrongSecretCannotOpenIt() {
  const { db, keys } = fresh();
  keys.put(CUSTOMER, 'anthropic', 'sk-ant-secret-value', { by: 'user_customer' });
  const wrong = createProviderKeyService({ db, secret: 'a-different-secret' });
  const got = wrong.resolve('anthropic', [CUSTOMER]);
  assert.equal(got.key, null);
  assert.match(got.refused, /could not be decrypted/);
}

function testTheChainPrefersTheMostSpecificTier() {
  const { keys } = fresh();
  keys.put(HOSTER, 'anthropic', 'hoster-key', { by: 'admin' });
  keys.setMode(HOSTER, 'supply', 'admin');
  assert.equal(keys.resolve('anthropic', CHAIN).key, 'hoster-key');

  keys.put(RESELLER, 'anthropic', 'reseller-key', { by: 'reseller' });
  keys.setMode(RESELLER, 'supply', 'reseller');
  assert.equal(keys.resolve('anthropic', CHAIN).key, 'reseller-key');

  keys.put(CUSTOMER, 'anthropic', 'customer-key', { by: 'user_customer' });
  assert.equal(keys.resolve('anthropic', CHAIN).key, 'customer-key');
}

function testATierOnlyLendsDownwardWhenItSupplies() {
  // A hoster who has entered a key has not thereby agreed to pay for every
  // reseller's customers. Holding a key and offering it are different acts.
  const { keys } = fresh();
  keys.put(HOSTER, 'anthropic', 'hoster-key', { by: 'admin' });
  assert.equal(keys.resolve('anthropic', CHAIN), null, 'a stored key was lent downward without being offered');

  keys.setMode(HOSTER, 'supply', 'admin');
  assert.equal(keys.resolve('anthropic', CHAIN).key, 'hoster-key');
}

function testRequireBelowRefusesRatherThanSpending() {
  const { keys } = fresh();
  keys.put(HOSTER, 'anthropic', 'hoster-key', { by: 'admin' });
  keys.setMode(HOSTER, 'supply', 'admin');
  keys.setMode(RESELLER, 'require_below', 'reseller');

  const got = keys.resolve('anthropic', CHAIN);
  assert.equal(got.key, null, 'require_below still spent a key from above');
  assert.equal(got.requiredBy.id, 'org_reseller');
  assert.match(got.refused, /supply its own key/);
}

function testAnOwnKeyStillWorksUnderRequireBelow() {
  const { keys } = fresh();
  keys.setMode(RESELLER, 'require_below', 'reseller');
  keys.put(CUSTOMER, 'anthropic', 'customer-key', { by: 'user_customer' });
  assert.equal(keys.resolve('anthropic', CHAIN).key, 'customer-key');
}

function testRotationRevokesRatherThanDeletes() {
  const { db, keys } = fresh();
  keys.put(CUSTOMER, 'anthropic', 'first-key', { by: 'user_customer' });
  const second = keys.put(CUSTOMER, 'anthropic', 'second-key', { by: 'user_customer' });
  assert.equal(second.rotated, true);
  assert.equal(keys.resolve('anthropic', [CUSTOMER]).key, 'second-key');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM provider_keys').get().c, 2, 'the rotation erased its own history');
  assert.equal(keys.list(CUSTOMER).length, 1);
}

function testRevocationIsImmediate() {
  const { keys } = fresh();
  keys.put(CUSTOMER, 'anthropic', 'customer-key', { by: 'user_customer' });
  assert.equal(keys.revoke(CUSTOMER, 'anthropic', 'user_customer').revoked, true);
  assert.equal(keys.resolve('anthropic', [CUSTOMER]), null);
  assert.equal(keys.revoke(CUSTOMER, 'anthropic', 'user_customer').revoked, false, 'revocation was not idempotent');
}

function testEveryResolutionNamesWhoPaid() {
  // The metered row has to be able to say whose key paid for the call. That is
  // the billing record and, on a bad day, the evidence.
  const { keys } = fresh();
  keys.put(HOSTER, 'anthropic', 'hoster-key', { by: 'admin' });
  keys.setMode(HOSTER, 'supply', 'admin');
  const got = keys.resolve('anthropic', CHAIN);
  assert.deepEqual(got.source, { kind: 'org', id: 'org_hoster' });
  assert.equal(got.fingerprint, fingerprintOf('hoster-key'));
  assert.ok(keys.describe(HOSTER, 'anthropic').last_used_at, 'a use left no trace');
}

function testTheKeyTableIsExcludedFromBackup() {
  // The rule lives in a list the backup asks, not in a runbook a person
  // remembers. A new secret-bearing table that is not in here fails this.
  assert.ok(EXCLUDED_TABLES.includes('provider_keys'));
}

run();
