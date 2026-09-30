'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createTwoFactorService, codeForStep, base32Encode, base32Decode, PERIOD } = require('./twoFactor');

// The clock is handed in so the replay and drift rules can be tested at a
// known step rather than by sleeping through real thirty-second windows.
function fresh(startSeconds = 1_700_000_000) {
  let seconds = startSeconds;
  const db = new Database(':memory:');
  const svc = createTwoFactorService({ db, now: () => new Date(seconds * 1000) });
  return { db, svc, at: value => { seconds = value; }, get seconds() { return seconds; } };
}
const stepOf = seconds => Math.floor(seconds / PERIOD);

// RFC 4226's own test vector, so the algorithm is checked against the standard
// rather than against itself.
{
  const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  expected.forEach((code, counter) => assert.equal(codeForStep(secret, counter), code, `RFC 4226 counter ${counter}`));
  console.log('  ok  the code generator matches RFC 4226\'s published test vector');
}

{
  const round = base32Decode(base32Encode(Buffer.from([0, 1, 127, 128, 255, 42])));
  assert.deepEqual([...round], [0, 1, 127, 128, 255, 42]);
  console.log('  ok  a secret survives being encoded and decoded');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  assert.equal(t.svc.status('user1').enabled, false, 'enrolling must not switch it on');
  assert.equal(t.svc.status('user1').enrolling, true);
  // A login attempt at this point must not be let through by a valid code
  // either: the secret is not live until it has been confirmed.
  assert.equal(t.svc.isEnabled('user1'), false);
  const result = t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  assert.equal(result.enabled, true);
  assert.equal(result.recovery_codes.length, 10);
  assert.equal(t.svc.status('user1').enabled, true);
  assert.equal(t.svc.status('user1').recovery_codes_left, 10);
  console.log('  ok  a secret is only live once a code from it has been checked');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  assert.throws(() => t.svc.confirmEnrolment('user1', '000000'), /not right/);
  assert.equal(t.svc.status('user1').enabled, false);
  assert.equal(t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds))).enabled, true);
  console.log('  ok  a wrong code during setup leaves it off');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  // Move on a step so the confirmation's own code is behind us.
  t.at(t.seconds + PERIOD);
  const code = codeForStep(secret, stepOf(t.seconds));
  assert.equal(t.svc.checkCode('user1', code).ok, true);
  const again = t.svc.checkCode('user1', code);
  assert.equal(again.ok, false, 'the same code must not work twice');
  assert.match(again.reason, /not right, or it has already been used/);
  console.log('  ok  a code is accepted once and refused the second time');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  t.at(t.seconds + PERIOD * 5);
  // One step either side is allowed for clocks that disagree a little.
  assert.equal(t.svc.checkCode('user1', codeForStep(secret, stepOf(t.seconds) + 1)).ok, true);
  t.at(t.seconds + PERIOD * 5);
  assert.equal(t.svc.checkCode('user1', codeForStep(secret, stepOf(t.seconds) - 1)).ok, true);
  t.at(t.seconds + PERIOD * 5);
  assert.equal(t.svc.checkCode('user1', codeForStep(secret, stepOf(t.seconds) + 3)).ok, false, 'three steps out is not drift');
  console.log('  ok  one step of clock drift is allowed and three is not');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  t.at(t.seconds + PERIOD * 10);
  // An old code is refused even though it is genuinely a code this secret
  // produced, because the step it belongs to is behind the last one accepted.
  assert.equal(t.svc.checkCode('user1', codeForStep(secret, stepOf(t.seconds) - 20)).ok, false);
  console.log('  ok  a code from an earlier step is refused, not just a reused one');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  const { recovery_codes: codes } = t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  const stored = t.db.prepare('SELECT code_hash FROM two_factor_recovery WHERE user_id=?').all('user1');
  assert.equal(stored.length, 10);
  assert.ok(stored.every(row => !codes.includes(row.code_hash)), 'recovery codes must not be stored readable');
  assert.ok(stored.every(row => row.code_hash.startsWith('$2')), 'recovery codes must be hashed the way a password is');

  const first = t.svc.useRecoveryCode('user1', codes[0]);
  assert.equal(first.ok, true);
  assert.equal(first.recovery_codes_left, 9);
  const second = t.svc.useRecoveryCode('user1', codes[0]);
  assert.equal(second.ok, false, 'a recovery code is single use');
  assert.match(second.reason, /already been used/, 'a spent code says it is spent, not that it was never yours');
  assert.equal(t.svc.useRecoveryCode('user1', 'NOTACODE').ok, false);
  // Case does not matter, because somebody typing one off paper will not match
  // the case and refusing them at that point is a lockout for no security.
  assert.equal(t.svc.useRecoveryCode('user1', codes[1].toLowerCase()).ok, true);
  console.log('  ok  recovery codes are hashed, single use and case insensitive');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  assert.throws(() => t.svc.beginEnrolment('user1', 'owner@example.com'), /already on/);
  t.at(t.seconds + PERIOD);
  assert.throws(() => t.svc.disable('user1', '000000'), /not right/);
  assert.equal(t.svc.status('user1').enabled, true, 'a failed disable must leave it on');
  assert.equal(t.svc.disable('user1', codeForStep(secret, stepOf(t.seconds))).enabled, false);
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM two_factor_recovery WHERE user_id=?').get('user1').n, 0,
    'disabling must not leave recovery codes behind that would still work');
  console.log('  ok  it cannot be re-enrolled or switched off without a live code');
}

{
  const t = fresh();
  const { secret } = t.svc.beginEnrolment('user1', 'owner@example.com');
  const { recovery_codes: codes } = t.svc.confirmEnrolment('user1', codeForStep(secret, stepOf(t.seconds)));
  const replaced = t.svc.regenerateRecoveryCodes('user1', codes[0]);
  assert.equal(replaced.recovery_codes.length, 10);
  assert.ok(replaced.recovery_codes.every(code => !codes.includes(code)), 'new codes must be new');
  assert.equal(t.svc.useRecoveryCode('user1', codes[1]).ok, false, 'the old codes must stop working');
  assert.equal(t.svc.useRecoveryCode('user1', replaced.recovery_codes[0]).ok, true);
  console.log('  ok  regenerating recovery codes retires the old ones');
}

{
  const t = fresh();
  assert.equal(t.svc.checkCode('nobody', '123456').ok, false);
  assert.equal(t.svc.status('nobody').enabled, false);
  assert.throws(() => t.svc.disable('nobody', '123456'), /not on/);
  console.log('  ok  an account with no second factor answers plainly rather than throwing');
}

{
  // The seed is what a second factor is. In clear, a copy of the database mints
  // valid codes for every enrolled account and the account holder cannot even
  // know, because they never see the seed.
  const SECRET = 'a-test-encryption-secret';
  const db = new Database(':memory:');
  const svc = createTwoFactorService({ db, secret: SECRET, now: () => new Date(1_700_000_000 * 1000) });
  const started = svc.beginEnrolment('user_a', 'a@example.com');
  const stored = db.prepare('SELECT secret FROM two_factor WHERE user_id=?').get('user_a').secret;
  assert.ok(stored.startsWith('gcm:'), 'the seed was stored unsealed');
  assert.ok(!stored.includes(started.secret), 'the seed is in the database in clear');
  // And it still works, which is the other half of the claim.
  const step = Math.floor(1_700_000_000 / PERIOD);
  assert.ok(svc.confirmEnrolment('user_a', codeForStep(started.secret, step)).recovery_codes.length > 0);
  console.log('  ok  an authenticator seed is sealed at rest and still verifies');
}

{
  // A box that already holds clear seeds re-seals them on the next start,
  // rather than keeping one for every account nobody happens to sign into.
  const SECRET = 'a-test-encryption-secret';
  const db = new Database(':memory:');
  const plain = createTwoFactorService({ db, now: () => new Date(1_700_000_000 * 1000) });
  const started = plain.beginEnrolment('user_b', 'b@example.com');
  assert.equal(db.prepare('SELECT secret FROM two_factor WHERE user_id=?').get('user_b').secret, started.secret);

  const sealed = createTwoFactorService({ db, secret: SECRET, now: () => new Date(1_700_000_000 * 1000) });
  const after = db.prepare('SELECT secret FROM two_factor WHERE user_id=?').get('user_b').secret;
  assert.ok(after.startsWith('gcm:'), 'an existing clear seed was left in clear');
  const step = Math.floor(1_700_000_000 / PERIOD);
  assert.ok(sealed.confirmEnrolment('user_b', codeForStep(started.secret, step)).recovery_codes.length > 0,
    'the migrated seed stopped working');
  console.log('  ok  a seed stored in clear is sealed on the next start');
}

console.log('two-factor tests passed');
