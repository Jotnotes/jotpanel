'use strict';

// Changing your own password must not become the route that was deleted.
//
// The route that used to do this took an account id and set whichever account
// the caller named. These checks are written against that failure first and the
// happy path second: the thing worth proving is that there is no input at all
// through which one signed-in person reaches another person's row, and that a
// session on its own is not enough to replace the credential it was issued
// against.
//
// Runs as `node control/changePassword.test.js` with no server and no network.

const assert = require('assert');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createChangePassword, MIN_LENGTH } = require('./changePassword');

const SECRET = 'test-secret-for-change-password';

const ALICE = { id: 'u_alice', name: 'Alice', email: 'alice@example.invalid', password: 'alice-original-passphrase' };
const BOB   = { id: 'u_bob',   name: 'Bob',   email: 'bob@example.invalid',   password: 'bob-original-passphrase' };

// The columns this route reads and writes, and nothing else. A smaller schema
// than the real one on purpose: if the handler ever starts needing another
// table, this suite should fail rather than quietly pass against a fixture
// somebody enlarged.
function freshMachine() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (
             id TEXT PRIMARY KEY, name TEXT, email TEXT, plan TEXT,
             password TEXT, suspended INTEGER DEFAULT 0);
           CREATE TABLE audit_log (
             id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, ip TEXT, details TEXT);`);
  const insert = db.prepare('INSERT INTO users (id,name,email,plan,password) VALUES (?,?,?,?,?)');
  // Cost 4 for the fixtures only. The handler's own write is asserted to be
  // cost 12 further down; this is the setup, not the thing under test, and at
  // 12 this suite would spend half a minute making users.
  for (const u of [ALICE, BOB]) insert.run(u.id, u.name, u.email, 'starter', bcrypt.hashSync(u.password, 4));

  const audits = [];
  const twoFactorOn = new Set();
  const liveCode = new Map();     // user -> the one code checkCode will accept
  const recoveryCode = new Map(); // user -> the one recovery code, spendable once

  const twoFactor = {
    isEnabled: id => twoFactorOn.has(id),
    checkCode(id, code) {
      const clean = String(code || '').replace(/\s/g, '');
      if (!/^\d{6}$/.test(clean)) return { ok: false, reason: 'A code is six digits' };
      if (clean !== liveCode.get(id)) return { ok: false, reason: 'That code is not right, or it has already been used' };
      return { ok: true, step: 1 };
    },
    useRecoveryCode(id, code) {
      const clean = String(code || '').trim().toUpperCase();
      if (!clean || clean !== recoveryCode.get(id)) return { ok: false, reason: 'That is not a recovery code for this account' };
      recoveryCode.delete(id);
      return { ok: true, recovery_codes_left: 0 };
    },
  };

  const audit = (userId, action, req, details = '') => {
    audits.push({ userId, action, details });
    db.prepare('INSERT INTO audit_log (user_id,action,ip,details) VALUES (?,?,?,?)')
      .run(userId || null, action, 'this machine', details);
  };

  const handler = createChangePassword({ db, bcrypt, jwt, JWT_SECRET: SECRET, twoFactor, audit });

  return { db, audits, twoFactorOn, liveCode, recoveryCode, handler };
}

// What `auth` would have left on the request, and nothing a caller could have
// written. There is no account id parameter here because the handler takes
// none: that is the property under test, not an omission in the fixture.
function call(m, session, body, extra = {}) {
  return new Promise(resolve => {
    const res = {
      code: 200,
      status(c) { this.code = c; return this; },
      json(payload) { resolve({ status: this.code, body: payload }); },
    };
    const req = { user: session, body, headers: {}, ip: '203.0.113.9', t: s => s, ...extra };
    m.handler(req, res);
  });
}

function hashOf(m, id) { return m.db.prepare('SELECT password FROM users WHERE id=?').get(id).password; }
function signsIn(m, id, password) { return bcrypt.compareSync(password, hashOf(m, id)); }
function sessionFor(u) { return { id: u.id, name: u.name, email: u.email }; }
function actions(m) { return m.audits.map(a => a.action); }

const NEW = 'a-brand-new-passphrase';

// ── 1. The ordinary case ─────────────────────────────────────────────
async function testACorrectChangeSucceeds() {
  const m = freshMachine();
  const before = hashOf(m, ALICE.id);
  const r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW });

  assert.strictEqual(r.status, 200, 'a correct change is accepted');
  assert.strictEqual(r.body.ok, true);
  assert.notStrictEqual(hashOf(m, ALICE.id), before, 'the stored hash really changed');
  assert.ok(actions(m).includes('password_changed'), 'the change is in the record');

  // The record says what happened and nothing more. Neither password, neither
  // hash, and no length that would narrow a guess.
  const row = m.db.prepare("SELECT * FROM audit_log WHERE action='password_changed'").get();
  const written = JSON.stringify(row);
  for (const secret of [ALICE.password, NEW, before, hashOf(m, ALICE.id)]) {
    assert.ok(!written.includes(secret), 'the audit row must not carry a password or a hash');
  }
  assert.ok(!/\b22\b|\b25\b/.test(String(row.details || '')), 'the audit row must not carry a length either');
  console.log('ok  a signed-in person can replace their own password, and it is recorded without the secret');
}

// ── 2. The new password works and the old one does not ───────────────
async function testTheNewPasswordIsTheOneThatSignsIn() {
  const m = freshMachine();
  await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW });

  assert.strictEqual(signsIn(m, ALICE.id, NEW), true, 'the new password signs in afterwards');
  assert.strictEqual(signsIn(m, ALICE.id, ALICE.password), false, 'the old password does not');

  // And the old one is refused by this route too, which is the same question
  // asked of the live compare rather than of bcrypt directly.
  const again = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: 'yet-another-passphrase' });
  assert.strictEqual(again.status, 401, 'the superseded password proves nothing');
  assert.strictEqual(signsIn(m, ALICE.id, NEW), true, 'and the refused attempt changed nothing');
  console.log('ok  the new password is the one that signs in, and the old one is dead');
}

// ── 3. The current password has to be proved ─────────────────────────
async function testTheWrongCurrentPasswordIsRefused() {
  const m = freshMachine();
  const before = hashOf(m, ALICE.id);
  const r = await call(m, sessionFor(ALICE), { current_password: 'not-the-right-one', new_password: NEW });

  assert.strictEqual(r.status, 401, 'a wrong current password is refused');
  assert.strictEqual(hashOf(m, ALICE.id), before, 'and nothing was written');
  assert.strictEqual(signsIn(m, ALICE.id, ALICE.password), true, 'the real password still works');
  assert.ok(actions(m).includes('password_change_failed'), 'the refusal is in the record');

  // A missing current password is not an empty one that might match something.
  const empty = await call(m, sessionFor(ALICE), { new_password: NEW });
  assert.strictEqual(empty.status, 400, 'no current password at all is a refusal, not a change');
  assert.strictEqual(hashOf(m, ALICE.id), before);
  console.log('ok  the current password must be proved in the same request');
}

// ── 4. The product's floor, not a new one ────────────────────────────
async function testAShortNewPasswordIsRefused() {
  const m = freshMachine();
  const before = hashOf(m, ALICE.id);
  assert.strictEqual(MIN_LENGTH, 12, 'the floor is the twelve `account.create` and the installer apply');

  // Eleven characters, written out rather than derived from the constant, so
  // that lowering the floor in the module is caught by behaviour here and not
  // only by the assertion above.
  const r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: 'elevenchars' });
  assert.strictEqual(r.status, 400, 'eleven characters is refused');
  assert.match(r.body.error, /12 characters/);
  assert.strictEqual(hashOf(m, ALICE.id), before, 'and nothing was written');

  // And eight, which is what the closed public sign-up path still accepts. If
  // this route ever starts accepting it, that outlier has leaked inwards.
  const eight = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: 'eightchr' });
  assert.strictEqual(eight.status, 400, 'the eight of /api/register is not the rule here');
  assert.strictEqual(hashOf(m, ALICE.id), before);

  // Exactly the floor is allowed, so the rule is "at least twelve" and not
  // "more than twelve".
  const exact = 'y'.repeat(MIN_LENGTH);
  const ok = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: exact });
  assert.strictEqual(ok.status, 200, 'twelve exactly is accepted');
  assert.strictEqual(signsIn(m, ALICE.id, exact), true);
  console.log('ok  the floor is the product\'s twelve characters, inclusive');
}

// ── 5. The bug that deleted the old route ────────────────────────────
async function testItCannotReachAnotherAccount() {
  const m = freshMachine();
  const bobBefore = hashOf(m, BOB.id);
  const aliceSession = sessionFor(ALICE);

  // Every shape a caller could try to name somebody else: a body field, a
  // route parameter, a query string, an id spoofed next to the session's own.
  const attempts = [
    [{ current_password: ALICE.password, new_password: NEW, id: BOB.id }, {}],
    [{ current_password: ALICE.password, new_password: NEW, user_id: BOB.id }, {}],
    [{ current_password: ALICE.password, new_password: NEW, email: BOB.email }, {}],
    [{ current_password: ALICE.password, new_password: NEW }, { params: { id: BOB.id } }],
    [{ current_password: ALICE.password, new_password: NEW }, { query: { id: BOB.id } }],
    // And the one that actually matters: Bob's password offered as the proof.
    [{ current_password: BOB.password, new_password: NEW, id: BOB.id }, { params: { id: BOB.id } }],
  ];

  for (const [body, extra] of attempts) {
    const r = await call(m, aliceSession, body, extra);
    assert.strictEqual(hashOf(m, BOB.id), bobBefore,
      `Bob's password was changed by a request naming him ${JSON.stringify({ ...body, current_password: '<redacted>', new_password: '<redacted>' })}`);
    assert.strictEqual(signsIn(m, BOB.id, BOB.password), true, 'Bob still signs in with his own password');
    // Whatever happened, it happened to Alice or to nobody.
    if (r.status === 200) assert.strictEqual(signsIn(m, ALICE.id, NEW), true, 'a success can only ever be the caller\'s own row');
  }
  console.log('ok  no input of any shape reaches another account\'s password');
}

// ── 6. A request with no proved identity ─────────────────────────────
async function testAnUnauthenticatedRequestIsRefused() {
  const m = freshMachine();
  const before = hashOf(m, ALICE.id);

  // `auth` refuses before the handler is reached, so what is proved here is
  // that the handler is not a second door: with no `req.user` it must not
  // invent one out of the body.
  for (const session of [undefined, null, {}, { id: null }, { id: '' }]) {
    let answered;
    try {
      answered = await call(m, session, { current_password: ALICE.password, new_password: NEW, id: ALICE.id, email: ALICE.email });
    } catch (error) {
      answered = { status: 'threw', body: { error: error.message } }; // a throw is a refusal too, as long as nothing was written
    }
    assert.notStrictEqual(answered.status, 200, `an unauthenticated request was answered 200 with session ${JSON.stringify(session)}`);
    assert.strictEqual(hashOf(m, ALICE.id), before, 'and no password was written');
  }
  assert.strictEqual(signsIn(m, ALICE.id, ALICE.password), true);
  console.log('ok  with no proved identity nothing is changed, whatever the body claims');
}

// ── 7. A machine credential is not a person ──────────────────────────
async function testAnApiKeyCannotRotateAPassword() {
  const m = freshMachine();
  const before = hashOf(m, ALICE.id);
  const r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW },
    { apiKey: { prefix: 'jpk_abc', identityId: ALICE.id } });

  assert.strictEqual(r.status, 403, 'a key is refused on this route');
  assert.strictEqual(hashOf(m, ALICE.id), before, 'and nothing was written');
  assert.ok(actions(m).includes('password_change_refused'), 'the refusal is in the record');
  console.log('ok  an API key cannot change the password of the person who issued it');
}

// ── 8. The second factor is still the second factor ──────────────────
async function testASecondFactorIsAskedForAndKept() {
  const m = freshMachine();
  m.twoFactorOn.add(ALICE.id);
  m.liveCode.set(ALICE.id, '123456');
  m.recoveryCode.set(ALICE.id, 'ABCDE-FGHIJ');
  const before = hashOf(m, ALICE.id);

  // The right password and no code is a session somebody walked up to.
  let r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW });
  assert.strictEqual(r.status, 401, 'with 2FA on, the password alone is half the answer');
  assert.strictEqual(hashOf(m, ALICE.id), before);

  r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW, code: '000000' });
  assert.strictEqual(r.status, 401, 'a wrong code is refused');
  assert.strictEqual(hashOf(m, ALICE.id), before);

  r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW, code: '123456' });
  assert.strictEqual(r.status, 200, 'password plus a live code is accepted');
  assert.strictEqual(signsIn(m, ALICE.id, NEW), true);

  // And the factor is still on afterwards. A password change that quietly
  // lowered the account's protection would be the hole /api/2fa/disable exists
  // to keep shut.
  assert.strictEqual(m.twoFactorOn.has(ALICE.id), true, 'the second factor survives a password change');

  // A recovery code is accepted in its place, as it is everywhere else.
  const second = 'a-third-distinct-passphrase';
  r = await call(m, sessionFor(ALICE), { current_password: NEW, new_password: second, code: 'ABCDE-FGHIJ' });
  assert.strictEqual(r.status, 200, 'a recovery code stands in for the live code');
  assert.strictEqual(signsIn(m, ALICE.id, second), true);
  console.log('ok  with a second factor on, both halves are required and the factor is left enrolled');
}

// ── 9. What is written, and how ──────────────────────────────────────
async function testTheWriteMatchesEveryOtherPasswordWrite() {
  const m = freshMachine();
  const r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: NEW });
  const stored = hashOf(m, ALICE.id);

  assert.strictEqual(stored.startsWith('$2'), true, 'stored as a bcrypt hash, not plaintext');
  assert.strictEqual(stored.includes(NEW), false, 'the password itself is nowhere in the row');
  // Cost 12, the same as public registration, the owner bootstrap route and
  // `account.create`. A cheaper hash here would make this the softest password
  // write on the machine.
  assert.strictEqual(stored.split('$')[2], '12', `bcrypt cost must be 12, found ${stored.split('$')[2]}`);

  // The caller is handed a session minted after the change, with the claims a
  // sign-in issues and no extra authority.
  const claim = jwt.verify(r.body.token, SECRET);
  assert.strictEqual(claim.id, ALICE.id);
  assert.strictEqual(claim.purpose, undefined, 'a session token carries no purpose, or `auth` would refuse it');
  assert.ok(claim.exp - claim.iat > 29 * 24 * 3600, 'the same thirty days a sign-in issues');
  assert.strictEqual(JSON.stringify(r.body).includes(NEW), false, 'the answer does not echo the password back');
  console.log('ok  the write is bcrypt at cost 12 and the answer carries no secret');
}

// ── 10. Refusing rather than guessing ────────────────────────────────
async function testItRefusesToBeBuiltWrong() {
  assert.throws(() => createChangePassword({}), /needs a database/);
  assert.throws(() => createChangePassword({ db: 1, bcrypt, jwt, JWT_SECRET: SECRET }), /needs a database/);

  const m = freshMachine();
  // The same password again is not a change, and should not spend a bcrypt
  // round pretending it was one.
  const before = hashOf(m, ALICE.id);
  const r = await call(m, sessionFor(ALICE), { current_password: ALICE.password, new_password: ALICE.password });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(hashOf(m, ALICE.id), before);

  // A session for an account that is no longer there must not create one.
  const ghost = await call(m, { id: 'u_gone', name: 'Gone', email: 'gone@example.invalid' },
    { current_password: 'anything-at-all', new_password: NEW });
  assert.strictEqual(ghost.status, 401, 'a session for a deleted account proves nothing');
  assert.strictEqual(m.db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'and no row was created');
  console.log('ok  called wrong it refuses, and a vanished account is not a password it can set');
}

(async () => {
  await testACorrectChangeSucceeds();
  await testTheNewPasswordIsTheOneThatSignsIn();
  await testTheWrongCurrentPasswordIsRefused();
  await testAShortNewPasswordIsRefused();
  await testItCannotReachAnotherAccount();
  await testAnUnauthenticatedRequestIsRefused();
  await testAnApiKeyCannotRotateAPassword();
  await testASecondFactorIsAskedForAndKept();
  await testTheWriteMatchesEveryOtherPasswordWrite();
  await testItRefusesToBeBuiltWrong();
  console.log('change password tests passed');
})().catch(e => { console.error(e); process.exit(1); });
