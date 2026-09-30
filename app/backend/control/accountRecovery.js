'use strict';

// Account recovery codes. The ones you keep in case you lose everything else.
//
// These are not the recovery codes in `twoFactor.js`, and the distinction is
// the reason this file exists. Those answer the *second* factor: they exist
// only once TOTP is enrolled, and they help somebody who has lost their phone
// and still knows their password. They do nothing for somebody who has lost the
// password itself, and an account with no TOTP has none at all. Calling them
// account recovery, which several documents did, described a safety net that
// was not underneath anybody.
//
// These belong to the account. They exist whether or not there is a second
// factor, whether or not there is a passkey, and they are the proof a person
// can hold on paper when every device they own is gone.
//
// The mechanism is deliberately the same shape as the two-factor set, because
// that one is correct: hashed, single-use, burnt atomically, and replaced as a
// whole set. What is different is the entropy and what they are for.
//
// **Entropy.** The two-factor codes are 40 bits. That is defensible behind
// bcrypt and a rate limit for a second factor, and it is too little for the
// last way into an account, so these are 100 bits: twenty characters from a
// twenty-six letter alphabet, in groups of five. Read aloud over a phone,
// written on paper, typed by somebody who is already having a bad day. The
// alphabet leaves out the characters people confuse when copying by hand.
//
// **What they are not.** A recovery factor is a secret the account holder
// chose to keep. Card digits, a phone number's last four, an invoice number, a
// licence number and a mother's maiden name are none of them secrets: they are
// facts about a person that other people also hold. Any of those may one day be
// worth something to a human being deciding whether a recovery request looks
// genuine. None of them is ever a factor, and nothing here should grow one.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// No I, O, S or Z: the four that go wrong between paper and keyboard.
const ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXY';
const CODE_LENGTH = 20;
const GROUP = 5;
const CODE_COUNT = 10;

// Rejection sampling rather than modulo, so every letter is equally likely.
// Modulo over a 22-letter alphabet would quietly favour the first ten.
function randomCode() {
  const letters = [];
  while (letters.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      letters.push(ALPHABET[byte % ALPHABET.length]);
      if (letters.length === CODE_LENGTH) break;
    }
  }
  return letters.join('').replace(new RegExp(`(.{${GROUP}})(?=.)`, 'g'), '$1-');
}

// Typed by a person, so the comparison is forgiving about what a person does:
// lower case, missing dashes, spaces, and the four confusable letters mapped
// back to what the alphabet actually uses.
function normalise(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/0/g, 'O').replace(/1/g, 'I')
    .replace(/[IOSZ]/g, ch => ({ I: 'J', O: 'Q', S: '5', Z: '2' }[ch] || ch));
}

function createAccountRecoveryService({ db, now = () => new Date() }) {
  if (!db) throw new Error('the account recovery service requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_recovery_codes (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      used_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS account_recovery_codes_user ON account_recovery_codes (user_id);
  `);

  function status(userId) {
    const total = db.prepare('SELECT COUNT(*) AS n FROM account_recovery_codes WHERE user_id=?').get(userId).n;
    const left = db.prepare('SELECT COUNT(*) AS n FROM account_recovery_codes WHERE user_id=? AND used_at IS NULL').get(userId).n;
    const oldest = db.prepare('SELECT MIN(created_at) AS at FROM account_recovery_codes WHERE user_id=?').get(userId).at;
    return { generated: total > 0, codes_left: left, generated_at: oldest || null };
  }

  // Generating replaces. There is no adding one to the pile: a set is a set,
  // and somebody who has printed the old sheet needs to know that sheet is
  // dead rather than half alive.
  function generate(userId) {
    const codes = Array.from({ length: CODE_COUNT }, randomCode);
    const at = now().toISOString();
    db.transaction(() => {
      db.prepare('DELETE FROM account_recovery_codes WHERE user_id=?').run(userId);
      const insert = db.prepare('INSERT INTO account_recovery_codes (id,user_id,code_hash,created_at,used_at) VALUES (?,?,?,?,NULL)');
      for (const code of codes) {
        insert.run(`arc_${crypto.randomBytes(8).toString('hex')}`, userId, bcrypt.hashSync(normalise(code), 10), at);
      }
    })();
    // The only time these exist in a readable form. What is kept is a hash, so
    // nothing here can show them again, and a screen that offers to is lying.
    return { codes, count: codes.length, generated_at: at };
  }

  // Burnt atomically. Two callers racing the same code produce one row change
  // and one refusal, rather than both reading "unused" and both being let in.
  function consume(userId, presented) {
    const clean = normalise(presented);
    if (!clean) return { ok: false, reason: 'Enter one of your recovery codes' };
    const rows = db.prepare('SELECT id, code_hash, used_at FROM account_recovery_codes WHERE user_id=?').all(userId);
    for (const row of rows) {
      if (!bcrypt.compareSync(clean, row.code_hash)) continue;
      if (row.used_at) return { ok: false, reason: 'That recovery code has already been used' };
      const burnt = db.prepare('UPDATE account_recovery_codes SET used_at=? WHERE id=? AND used_at IS NULL').run(now().toISOString(), row.id);
      if (burnt.changes !== 1) return { ok: false, reason: 'That recovery code has already been used' };
      const left = db.prepare('SELECT COUNT(*) AS n FROM account_recovery_codes WHERE user_id=? AND used_at IS NULL').get(userId).n;
      return { ok: true, codes_left: left };
    }
    return { ok: false, reason: 'That is not a recovery code for this account' };
  }

  return { status, generate, consume, normalise, randomCode, CODE_COUNT, CODE_LENGTH, ALPHABET };
}

module.exports = { createAccountRecoveryService, normalise, randomCode, ALPHABET, CODE_LENGTH };
