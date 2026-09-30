'use strict';

// Passkeys, tested against a real software authenticator rather than a mock.
//
// Every response below is built the way an authenticator builds one: a real
// P-256 signature over real authenticator data and a real clientDataJSON. The
// verifier under test is the product's own. That is what makes the negative
// cases worth anything: each one produces a well-formed response that is wrong
// in exactly one way, which is the case a broken verifier accepts.

const assert = require('assert');
const Database = require('better-sqlite3');
const { createPasskeyService, isRegistrableDomain } = require('./passkeys');
const { createSoftwareAuthenticator } = require('./softwareAuthenticator');

const RP_ID = 'panel.example';
const ORIGIN = `https://${RP_ID}`;
const env = { DOMAIN: RP_ID, ARCA_PANEL_PORT: '7443' };

const db = new Database(':memory:');
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT);`);
db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run('u_alice', 'alice@example.com');
db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run('u_bob', 'bob@example.com');

let clock = new Date('2026-08-28T10:00:00Z');
const service = createPasskeyService({ db, env, now: () => clock });

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };
const refuses = async (name, fn, pattern) => {
  let threw = null;
  try { await fn(); } catch (error) { threw = error; }
  assert.ok(threw, `${name}: expected a refusal and got none`);
  if (pattern) assert.match(threw.message, pattern, `${name}: refused with "${threw.message}"`);
  passed++; console.log(`ok  ${name} — refused: ${threw.message}`);
};

(async () => {
  // ── The relying party ───────────────────────────────────────────
  await check('an IP address cannot be a relying party, so passkeys are unavailable there', async () => {
    const onIp = createPasskeyService({ db: new Database(':memory:'), env: { DOMAIN: '203.0.113.7' } });
    assert.strictEqual(onIp.available(), false);
    assert.match(onIp.whyUnavailable(), /address rather than a name/);
    assert.strictEqual(isRegistrableDomain('203.0.113.7'), false);
    assert.strictEqual(isRegistrableDomain('panel.example'), true);
    assert.strictEqual(isRegistrableDomain('panel.example:7443'), false);
  });

  await check('the recovery port is an allowed origin for the same relying party', async () => {
    const rp = service.relyingParty();
    assert.strictEqual(rp.rpID, RP_ID);
    assert.ok(rp.origins.includes(`https://${RP_ID}`));
    assert.ok(rp.origins.includes(`https://${RP_ID}:7443`), 'the recovery port must still be able to sign in');
  });

  // ── Challenges ──────────────────────────────────────────────────
  await check('a registration challenge is long and random, and never repeats', async () => {
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
      const raw = Buffer.from(options.challenge, 'base64url');
      assert.ok(raw.length >= 16, `challenge was only ${raw.length} bytes`);
      assert.ok(!seen.has(options.challenge), 'a challenge repeated');
      seen.add(options.challenge);
    }
  });

  // ── Registration ────────────────────────────────────────────────
  const authenticator = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  let aliceFirst = null;

  await check('a valid registration stores the credential', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    const stored = await service.verifyRegistration({ userId: 'u_alice', response, name: 'Laptop' });
    aliceFirst = stored.credential_id;
    assert.strictEqual(stored.name, 'Laptop');
    assert.strictEqual(service.countFor('u_alice'), 1);
    const listed = service.listFor('u_alice');
    assert.strictEqual(listed[0].name, 'Laptop');
    assert.ok(listed[0].created_at, 'a credential records when it was made');
    assert.strictEqual(listed[0].last_used_at, null, 'a credential that has never signed in says so');
  });

  await refuses('a registration challenge cannot be used twice', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    await service.verifyRegistration({ userId: 'u_alice', response, name: 'First use' });
    const again = authenticator.register({ challenge: options.challenge });
    await service.verifyRegistration({ userId: 'u_alice', response: again, name: 'Second use' });
  }, /already been used/);

  await refuses('a challenge this server never issued is refused', async () => {
    const response = authenticator.register({ challenge: Buffer.from('invented-challenge').toString('base64url') });
    await service.verifyRegistration({ userId: 'u_alice', response, name: 'Invented' });
  }, /not one this server started/);

  await refuses('an expired challenge is refused', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    clock = new Date(clock.getTime() + service.CHALLENGE_TTL_MS + 1000);
    try { await service.verifyRegistration({ userId: 'u_alice', response, name: 'Late' }); }
    finally { clock = new Date('2026-08-28T10:00:00Z'); }
  }, /took too long/);

  await refuses('a registration signed for another origin is refused', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge, origin: 'https://evil.example' });
    await service.verifyRegistration({ userId: 'u_alice', response, name: 'Wrong origin' });
  }, /.+/);

  await refuses('a registration signed for another relying party is refused', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge, rpId: 'evil.example' });
    await service.verifyRegistration({ userId: 'u_alice', response, name: 'Wrong RP' });
  }, /.+/);

  await refuses('a malformed attestation is refused rather than stored', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    response.response.attestationObject = Buffer.from('not an attestation').toString('base64url');
    await service.verifyRegistration({ userId: 'u_alice', response, name: 'Malformed' });
  }, /.+/);

  // A different device on purpose. Registering the same credential id on the
  // same authenticator would replace its own key pair, which is the
  // authenticator behaving normally and would leave the server holding a public
  // key whose private half no longer exists. That is a test destroying its own
  // fixture rather than an attack, and it cost a debugging pass to notice.
  await refuses('another account cannot claim a credential already registered', async () => {
    const attackerDevice = createSoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const options = await service.registrationOptions({ userId: 'u_bob', userName: 'bob@example.com' });
    const response = attackerDevice.register({ challenge: options.challenge, credentialId: Buffer.from(aliceFirst, 'base64url') });
    await service.verifyRegistration({ userId: 'u_bob', response, name: 'Stolen' });
  }, /already registered/);

  await refuses('a registration started by one account cannot be finished by another', async () => {
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    await service.verifyRegistration({ userId: 'u_bob', response, name: 'Hijacked' });
  }, /different account/);

  // ── Many credentials on one account ─────────────────────────────
  let aliceSecond = null;
  await check('one account holds several passkeys, which is the whole point', async () => {
    const before = service.countFor('u_alice');
    const options = await service.registrationOptions({ userId: 'u_alice', userName: 'alice@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    const stored = await service.verifyRegistration({ userId: 'u_alice', response, name: 'Security key' });
    aliceSecond = stored.credential_id;
    assert.strictEqual(service.countFor('u_alice'), before + 1);
    assert.ok(service.listFor('u_alice').some(c => c.name === 'Security key'));
  });

  // ── Assertion ───────────────────────────────────────────────────
  await check('a valid assertion signs the right account in', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceFirst });
    const result = await service.verifyAuthentication({ response });
    assert.strictEqual(result.userId, 'u_alice');
    const used = service.listFor('u_alice').find(c => c.name === 'Laptop');
    assert.ok(used.last_used_at, 'signing in records when the passkey was last used');
  });

  await check('the second passkey signs the same account in', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceSecond });
    const result = await service.verifyAuthentication({ response });
    assert.strictEqual(result.userId, 'u_alice');
  });

  await refuses('an assertion signed over a different challenge is refused', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({
      challenge: options.challenge,
      signChallenge: Buffer.from('a different challenge entirely').toString('base64url'),
      credential: aliceFirst,
    });
    await service.verifyAuthentication({ response });
  }, /.+/);

  await refuses('a tampered signature is refused', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceFirst, tamperSignature: true });
    await service.verifyAuthentication({ response });
  }, /.+/);

  await refuses('replaying a whole successful assertion is refused', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceFirst });
    await service.verifyAuthentication({ response });
    await service.verifyAuthentication({ response });
  }, /already been used/);

  await refuses('an assertion for another relying party is refused', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceFirst, rpId: 'evil.example' });
    await service.verifyAuthentication({ response });
  }, /.+/);

  await refuses('an assertion from another origin is refused', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceFirst, origin: 'https://evil.example' });
    await service.verifyAuthentication({ response });
  }, /.+/);

  // Two things refuse this and the library gets there first, which is why the
  // expected message is either. The check in `passkeys.js` stays as the
  // backstop: it is the one that would still fire if the library ever stopped
  // comparing counters, and a counter that does not move is the signature of a
  // cloned authenticator.
  await refuses('a counter that went backwards reads as a cloned authenticator', async () => {
    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceFirst, counter: 1 });
    await service.verifyAuthentication({ response });
  }, /lower than expected|copy of one this server has seen/);

  // ── Removal ─────────────────────────────────────────────────────
  await check('a removed passkey stops working and the other one still does', async () => {
    const listed = service.listFor('u_alice');
    const second = listed.find(c => c.name === 'Security key');
    const gone = service.remove({ userId: 'u_alice', id: second.id, accountHasOtherLogin: true });
    assert.strictEqual(gone.ok, true);

    const options = await service.authenticationOptions();
    const response = authenticator.authenticate({ challenge: options.challenge, credential: aliceSecond });
    await assert.rejects(() => service.verifyAuthentication({ response }), /not registered here/);

    const stillGood = await service.authenticationOptions();
    const good = authenticator.authenticate({ challenge: stillGood.challenge, credential: aliceFirst });
    const result = await service.verifyAuthentication({ response: good });
    assert.strictEqual(result.userId, 'u_alice');
  });

  await check('one account cannot remove another account\'s passkey', async () => {
    const alices = service.listFor('u_alice');
    const attempt = service.remove({ userId: 'u_bob', id: alices[0].id, accountHasOtherLogin: true });
    assert.strictEqual(attempt.ok, false);
    assert.strictEqual(service.countFor('u_alice'), alices.length, 'nothing was removed');
  });

  await check('the last way into an account cannot be removed', async () => {
    const alices = service.listFor('u_alice');
    const onlyOne = alices.filter(c => c.name === 'Laptop' || c.name === 'First use');
    // Reduce to a single credential, then try to remove it with no password.
    for (const c of alices.slice(1)) service.remove({ userId: 'u_alice', id: c.id, accountHasOtherLogin: true });
    assert.strictEqual(service.countFor('u_alice'), 1);
    const refused = service.remove({ userId: 'u_alice', id: service.listFor('u_alice')[0].id, accountHasOtherLogin: false });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.reason, /only way into this account/);
    assert.strictEqual(service.countFor('u_alice'), 1, 'and it is still there');

    // With a password on the account, the same removal is allowed.
    const allowed = service.remove({ userId: 'u_alice', id: service.listFor('u_alice')[0].id, accountHasOtherLogin: true });
    assert.strictEqual(allowed.ok, true);
    assert.strictEqual(service.countFor('u_alice'), 0);
  });

  await check('renaming is scoped to the owner', async () => {
    const options = await service.registrationOptions({ userId: 'u_bob', userName: 'bob@example.com' });
    const response = authenticator.register({ challenge: options.challenge });
    const stored = await service.verifyRegistration({ userId: 'u_bob', response, name: 'Bob phone' });
    assert.strictEqual(service.rename({ userId: 'u_alice', id: stored.id, name: 'Mine now' }).ok, false);
    assert.strictEqual(service.rename({ userId: 'u_bob', id: stored.id, name: 'Bob new phone' }).ok, true);
    assert.strictEqual(service.listFor('u_bob')[0].name, 'Bob new phone');
  });

  console.log(`\n${passed} checks passed`);
})().catch(error => { console.error('\nFAILED:', error.message); process.exit(1); });
