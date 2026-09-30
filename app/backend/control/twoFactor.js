'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Two-factor authentication, for the accounts that can change a machine.
//
// A control panel's owner login is root on somebody's server by another
// route: it can create a site, read a customer's files, restore a backup over
// a live database and turn the firewall off. A password alone in front of that
// is the objection every buyer raises and they are right to raise it.
//
// TOTP (RFC 6238) is written here rather than pulled in, for the same reason
// the rest of the privileged half is: this is the code that decides whether
// somebody gets in, and a dependency in that position is a supply chain that
// can grant logins. It is a HMAC, a truncation and a modulo, and the whole
// algorithm is below in twenty lines where it can be read.
//
// Three things this file refuses to do, each of which is how panel 2FA is
// usually got wrong:
//
// 1. **A secret is never live until a code from it has been checked.** Enrolling
//    writes an unconfirmed secret and nothing else. If somebody scans a code
//    into an authenticator that then loses it, or scans nothing at all and
//    closes the tab, the account is exactly as it was. A panel that switches
//    2FA on at the moment the QR is drawn locks people out of their own server.
// 2. **A code is accepted once.** The step it belonged to is recorded, and any
//    code from that step or earlier is refused afterwards. Without this, a code
//    read over somebody's shoulder or out of a proxy log stays good for the
//    rest of its thirty seconds, which is exactly long enough.
// 3. **A recovery code is stored the way a password is.** Hashed, never
//    readable back, single use, and burnt in the same transaction that accepts
//    it. Recovery codes sitting in a column in the clear are a second password
//    database that nobody thinks of as one.

const DIGITS = 6;
const PERIOD = 30;      // seconds per step, the value every authenticator app assumes
const SKEW = 1;         // one step either side, for clocks that disagree a little
const RECOVERY_COUNT = 10;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0; let value = 0; const out = [];
  for (const char of String(text).toUpperCase().replace(/[=\s]/g, '')) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('That is not a valid authenticator secret');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// The whole of TOTP. The counter is the number of thirty-second steps since
// 1970, HMAC-SHA1 of it under the secret, then the dynamic truncation RFC 4226
// specifies: the low nibble of the last byte picks where to read four bytes,
// the top bit is masked off, and the result is taken modulo a million.
function codeForStep(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 0x100000000), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Compared byte by byte in constant time. A digit-by-digit compare that stops
// at the first difference tells an attacker how much of the code was right,
// and six digits guessed one at a time is not six digits.
function sameCode(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createTwoFactorService({ db, now = () => new Date(), issuer = 'JotPanel', secret: encryptionSecret = null } = {}) {
  if (!db) throw new Error('the two-factor service requires a database');

  // The seed is stored sealed. A TOTP seed in clear is a second factor that
  // does not survive a copy of the database: anyone holding one can generate
  // valid codes for every enrolled account for as long as the seed lives, and
  // unlike a password there is nothing the person can do about it because they
  // never see it. Sealed, a database copy yields a blob.
  //
  // `encryptionSecret` is optional so this service still works standalone in a
  // test, and rows written without it stay readable: `openSeed` returns
  // anything that is not sealed unchanged, which is also what carries existing
  // clear-text rows through the migration below.
  const SEALED = 'gcm:';
  let _seedKey = null;
  const seedKey = () => {
    if (!_seedKey) _seedKey = crypto.scryptSync(encryptionSecret, 'arca-deploy-salt', 32);
    return _seedKey;
  };
  function sealSeed(value) {
    if (!encryptionSecret) return value;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', seedKey(), iv);
    const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return SEALED + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }
  function openSeed(stored) {
    if (typeof stored !== 'string' || !stored.startsWith(SEALED)) return stored;
    if (!encryptionSecret) throw new Error('this two-factor seed is sealed and no encryption secret was given');
    const buf = Buffer.from(stored.slice(SEALED.length), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', seedKey(), buf.slice(0, 12));
    d.setAuthTag(buf.slice(12, 28));
    return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS two_factor (
      user_id      TEXT PRIMARY KEY,
      secret       TEXT NOT NULL,
      confirmed_at TEXT,
      last_step    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS two_factor_recovery (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS two_factor_recovery_user ON two_factor_recovery (user_id);
  `);

  // Anything enrolled before the seed was sealed is re-sealed once, here, so a
  // box does not keep a clear seed for an account nobody happens to sign into.
  if (encryptionSecret) {
    const stale = db.prepare("SELECT user_id, secret FROM two_factor WHERE secret NOT LIKE 'gcm:%'").all();
    for (const row of stale) {
      db.prepare('UPDATE two_factor SET secret=? WHERE user_id=?').run(sealSeed(row.secret), row.user_id);
    }
    if (stale.length) console.log(`[2fa] sealed ${stale.length} authenticator seed(s) that were stored in clear`);
  }

  const record = id => db.prepare('SELECT * FROM two_factor WHERE user_id=?').get(id) || null;
  const isEnabled = id => !!record(id)?.confirmed_at;

  function status(userId) {
    const row = record(userId);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM two_factor_recovery WHERE user_id=? AND used_at IS NULL').get(userId).n;
    return {
      enabled: !!row?.confirmed_at,
      enrolling: !!row && !row.confirmed_at,
      recovery_codes_left: row?.confirmed_at ? remaining : 0,
      confirmed_at: row?.confirmed_at || null,
    };
  }

  // Hands back the secret and the otpauth:// URI an authenticator reads. It is
  // deliberately refused once 2FA is on: re-enrolling has to go through
  // disable, which asks for the password and a live code, so an unattended
  // session cannot quietly swap the second factor for one it owns.
  function beginEnrolment(userId, label) {
    if (isEnabled(userId)) throw new Error('Two-factor authentication is already on for this account. Turn it off first if you want to move it to another device.');
    const secret = base32Encode(crypto.randomBytes(20));
    db.prepare('INSERT INTO two_factor (user_id,secret,confirmed_at,last_step,created_at) VALUES (?,?,NULL,0,?) '
      + 'ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret, confirmed_at=NULL, last_step=0, created_at=excluded.created_at')
      .run(userId, sealSeed(secret), now().toISOString());
    const account = encodeURIComponent(label || userId);
    return {
      secret,
      uri: `otpauth://totp/${encodeURIComponent(issuer)}:${account}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`,
    };
  }

  // A code is good if it matches this step or one either side, and if that step
  // has not been used before. The step is written down before the caller is
  // told yes, so two requests racing with the same code cannot both win.
  function checkCode(userId, code, { commit = true } = {}) {
    const row = record(userId);
    if (!row) return { ok: false, reason: 'Two-factor authentication is not set up for this account' };
    const clean = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return { ok: false, reason: 'A code is six digits' };
    const current = Math.floor(now().getTime() / 1000 / PERIOD);
    for (let drift = -SKEW; drift <= SKEW; drift += 1) {
      const step = current + drift;
      if (step <= row.last_step) continue; // already used, or older than one that was
      if (!sameCode(clean, codeForStep(openSeed(row.secret), step))) continue;
      if (commit) db.prepare('UPDATE two_factor SET last_step=? WHERE user_id=?').run(step, userId);
      return { ok: true, step };
    }
    // Distinguishing "wrong code" from "right code, already used" would tell
    // somebody replaying a stolen code that they had the right one, so both
    // answer the same way.
    return { ok: false, reason: 'That code is not right, or it has already been used' };
  }

  // Turning it on. Returns the recovery codes once and never again: they are
  // hashed on the way in and there is nothing left to show a second time.
  function confirmEnrolment(userId, code) {
    const row = record(userId);
    if (!row) throw new Error('Start setting up two-factor authentication before confirming it');
    if (row.confirmed_at) throw new Error('Two-factor authentication is already on for this account');
    const checked = checkCode(userId, code);
    if (!checked.ok) throw new Error(checked.reason);
    const codes = Array.from({ length: RECOVERY_COUNT }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
    const insert = db.prepare('INSERT INTO two_factor_recovery (id,user_id,code_hash,used_at) VALUES (?,?,?,NULL)');
    db.transaction(() => {
      db.prepare('DELETE FROM two_factor_recovery WHERE user_id=?').run(userId);
      for (const value of codes) insert.run(`rc_${crypto.randomBytes(8).toString('hex')}`, userId, bcrypt.hashSync(value, 10));
      db.prepare('UPDATE two_factor SET confirmed_at=? WHERE user_id=?').run(now().toISOString(), userId);
    })();
    return { enabled: true, recovery_codes: codes };
  }

  // A recovery code is burnt whether or not the caller does anything else with
  // the result, and it is burnt before the yes is returned, so the same code
  // arriving twice wins once.
  function useRecoveryCode(userId, code) {
    const clean = String(code || '').trim().toUpperCase();
    if (!clean) return { ok: false, reason: 'Enter the six-digit code from your app, or one of your recovery codes' };
    // Used codes are looked at as well as unused ones, so somebody who types a
    // code they have already spent is told that, rather than being told it was
    // never theirs and sent hunting for a different piece of paper. Whoever is
    // holding the code already knows it was real.
    const rows = db.prepare('SELECT id, code_hash, used_at FROM two_factor_recovery WHERE user_id=?').all(userId);
    for (const row of rows) {
      if (!bcrypt.compareSync(clean, row.code_hash)) continue;
      if (row.used_at) return { ok: false, reason: 'That recovery code has already been used' };
      const burnt = db.prepare('UPDATE two_factor_recovery SET used_at=? WHERE id=? AND used_at IS NULL').run(now().toISOString(), row.id);
      if (burnt.changes !== 1) return { ok: false, reason: 'That recovery code has already been used' };
      const left = db.prepare('SELECT COUNT(*) AS n FROM two_factor_recovery WHERE user_id=? AND used_at IS NULL').get(userId).n;
      return { ok: true, recovery_codes_left: left };
    }
    return { ok: false, reason: 'That is not a recovery code for this account' };
  }

  // Turning it off takes a live code or a recovery code as well as the password
  // the caller has already proved. Somebody who has walked up to an unlocked
  // session still cannot remove the second factor without the second factor.
  function disable(userId, proof) {
    if (!isEnabled(userId)) throw new Error('Two-factor authentication is not on for this account');
    const byCode = /^\d{6}$/.test(String(proof || '').replace(/\s/g, ''))
      ? checkCode(userId, proof)
      : useRecoveryCode(userId, proof);
    if (!byCode.ok) throw new Error(byCode.reason);
    db.transaction(() => {
      db.prepare('DELETE FROM two_factor_recovery WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM two_factor WHERE user_id=?').run(userId);
    })();
    return { enabled: false };
  }

  // Fresh recovery codes, replacing whatever is left. Same proof as disabling,
  // for the same reason.
  function regenerateRecoveryCodes(userId, proof) {
    if (!isEnabled(userId)) throw new Error('Two-factor authentication is not on for this account');
    const checked = /^\d{6}$/.test(String(proof || '').replace(/\s/g, ''))
      ? checkCode(userId, proof)
      : useRecoveryCode(userId, proof);
    if (!checked.ok) throw new Error(checked.reason);
    const codes = Array.from({ length: RECOVERY_COUNT }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
    const insert = db.prepare('INSERT INTO two_factor_recovery (id,user_id,code_hash,used_at) VALUES (?,?,?,NULL)');
    db.transaction(() => {
      db.prepare('DELETE FROM two_factor_recovery WHERE user_id=?').run(userId);
      for (const value of codes) insert.run(`rc_${crypto.randomBytes(8).toString('hex')}`, userId, bcrypt.hashSync(value, 10));
    })();
    return { recovery_codes: codes };
  }

  return { status, isEnabled, beginEnrolment, confirmEnrolment, checkCode, useRecoveryCode, disable, regenerateRecoveryCodes };
}

module.exports = { createTwoFactorService, codeForStep, base32Encode, base32Decode, PERIOD, DIGITS };
