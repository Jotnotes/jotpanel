'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');
const { createAccountRecoveryService, ALPHABET, CODE_LENGTH } = require('./accountRecovery');

const db = new Database(':memory:');
let clock = new Date('2026-08-28T10:00:00Z');
const service = createAccountRecoveryService({ db, now: () => clock });

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

check('an account with no codes says so', () => {
  const before = service.status('u1');
  assert.strictEqual(before.generated, false);
  assert.strictEqual(before.codes_left, 0);
});

let issued = null;
check('generating gives a set, once, and reports how many', () => {
  issued = service.generate('u1');
  assert.strictEqual(issued.codes.length, 10);
  assert.strictEqual(service.status('u1').codes_left, 10);
});

check('each code carries about 100 bits, from an alphabet without confusable letters', () => {
  for (const code of issued.codes) {
    const letters = code.replace(/-/g, '');
    assert.strictEqual(letters.length, CODE_LENGTH);
    for (const ch of letters) assert.ok(ALPHABET.includes(ch), `${ch} is not in the alphabet`);
  }
  const bits = CODE_LENGTH * Math.log2(ALPHABET.length);
  assert.ok(bits > 89, `only ${bits.toFixed(1)} bits per code`);
});

check('codes do not repeat within a set or between sets', () => {
  const seen = new Set(issued.codes);
  assert.strictEqual(seen.size, issued.codes.length);
  const second = service.generate('u_other');
  for (const code of second.codes) assert.ok(!seen.has(code), 'a code repeated across sets');
});

check('nothing readable is stored, only hashes', () => {
  const rows = db.prepare('SELECT code_hash FROM account_recovery_codes WHERE user_id=?').all('u1');
  assert.strictEqual(rows.length, 10);
  for (const row of rows) {
    assert.ok(row.code_hash.startsWith('$2'), 'not a bcrypt hash');
    for (const code of issued.codes) {
      assert.ok(!row.code_hash.includes(code.replace(/-/g, '')), 'the code itself is in the row');
    }
  }
});

check('a code works once and never again', () => {
  const first = service.consume('u1', issued.codes[0]);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.codes_left, 9);
  const again = service.consume('u1', issued.codes[0]);
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /already been used/);
});

check('a code is accepted however a person types it', () => {
  const raw = issued.codes[1];
  const messy = raw.toLowerCase().replace(/-/g, ' ');
  assert.strictEqual(service.consume('u1', messy).ok, true);
});

check('another account\'s code is refused', () => {
  const mine = service.generate('u_a');
  service.generate('u_b');
  assert.strictEqual(service.consume('u_b', mine.codes[0]).ok, false);
  assert.strictEqual(service.consume('u_a', mine.codes[0]).ok, true);
});

check('nonsense is refused without saying anything useful', () => {
  const outcome = service.consume('u1', 'not-a-code-at-all');
  assert.strictEqual(outcome.ok, false);
  assert.match(outcome.reason, /not a recovery code/);
});

check('regenerating kills every code in the previous set, used or not', () => {
  const before = service.generate('u_reissue');
  assert.strictEqual(service.consume('u_reissue', before.codes[0]).ok, true);
  const after = service.generate('u_reissue');
  assert.strictEqual(service.status('u_reissue').codes_left, 10);
  // The old sheet is dead, including the codes on it nobody had used.
  for (const old of before.codes) {
    assert.strictEqual(service.consume('u_reissue', old).ok, false, 'an old code still worked');
  }
  assert.strictEqual(service.consume('u_reissue', after.codes[0]).ok, true);
});

check('these are independent of two-factor: no TOTP table is consulted', () => {
  // The service is constructed against a database with no two-factor tables at
  // all, which is the property that distinguishes these from the TOTP set.
  const bare = new Database(':memory:');
  const standalone = createAccountRecoveryService({ db: bare });
  const set = standalone.generate('u_no_totp');
  assert.strictEqual(set.codes.length, 10);
  assert.strictEqual(standalone.consume('u_no_totp', set.codes[0]).ok, true);
});

console.log(`\n${passed} checks passed`);
