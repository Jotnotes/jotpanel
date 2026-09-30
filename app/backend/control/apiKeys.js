'use strict';

// Credentials a machine can hold.
//
// Everything in this panel is already an HTTP call: 103 catalogue operations and
// 50 readings, all through the same propose, approve, execute path. What was
// missing was a way for something other than a person to make those calls. There
// were two doors and neither fits: a sign-in token, which belongs to a human and
// expires with their session, and one shared `ADMIN_KEY` header, which is a
// password rather than an identity. It protects everything equally for anybody
// holding it, it cannot be revoked for one integration, and the audit log can
// only ever say that somebody with the key did something.
//
// The rules this file exists to hold:
//
// - A key never exceeds the person who made it. It carries their identity and
//   their organization, and every ownership and entitlement check downstream is
//   the same one that would run for them. A scope can only narrow.
// - The scope is read off the stored row, never off the request. Nothing a
//   caller sends can widen what its own key may do.
// - The secret is shown once and stored nowhere. What is kept is a hash and a
//   short public prefix, so a key can be recognised, listed and revoked without
//   the panel ever being able to reproduce it.
// - A revoked or expired key is refused on the next call, not the next restart.
// - A key is not a person. Anything it approves is recorded as approved by that
//   key, never under the name of whoever created it, because a machine's
//   decision wearing a person's name is worse than no record at all.

const crypto = require('crypto');

// `jotpanel_<prefix>_<secret>`. Pre-rename `arca_` keys remain valid forever.
// The prefix is public and indexed, so a lookup is one
// row rather than a scan of every hash on the box, and the secret is compared in
// constant time against that row.
const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;
const TOKEN = /^(?:jotpanel|arca)_([a-f0-9]{12})_([a-f0-9]{48})$/;

function looksLikeApiKey(value) {
  return typeof value === 'string' && (value.startsWith('jotpanel_') || value.startsWith('arca_'));
}

function createApiKeyService({ db, now = () => new Date() }) {
  if (!db) throw new Error('the api key service requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id              TEXT PRIMARY KEY,
      prefix          TEXT NOT NULL UNIQUE,
      secret_hash     TEXT NOT NULL,
      name            TEXT NOT NULL,
      identity_id     TEXT NOT NULL,
      org_id          TEXT,
      capabilities    TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      created_by      TEXT NOT NULL,
      expires_at      TEXT,
      last_used_at    TEXT,
      revoked_at      TEXT,
      revoked_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_identity ON api_keys(identity_id);
  `);

  const hash = secret => crypto.createHash('sha256').update(secret).digest('hex');

  // A scope is a capability name, or a group with a trailing star, or a bare
  // star. Matched against the capability the catalogue declares, which is the
  // same string the engine resolves, so a scope cannot drift away from what it
  // is scoping. `mail.*` covers `mail.mailbox.create`; it does not cover
  // `mailauth.setup`, because the boundary is the dot and not the letters.
  function permits(capabilities, capability) {
    const wanted = String(capability || '');
    if (!wanted) return false;
    return capabilities.some(scope => {
      if (scope === '*') return true;
      if (scope === wanted) return true;
      if (scope.endsWith('.*')) {
        const group = scope.slice(0, -2);
        return wanted === group || wanted.startsWith(`${group}.`);
      }
      return false;
    });
  }

  function cleanCapabilities(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    for (const entry of list) {
      const scope = String(entry || '').trim().toLowerCase();
      if (!scope || !/^[a-z0-9.*_-]+$/.test(scope) || scope.length > 80) continue;
      if (!out.includes(scope)) out.push(scope);
    }
    if (!out.length) throw new Error('A key with no scope can do nothing, so it is not issued');
    if (out.length > 100) throw new Error('That is more scopes than one key should carry');
    return out;
  }

  // The secret exists in this return value and nowhere else, ever again. The
  // caller hands it to the person once, the same way a generated mailbox
  // password is handed back once, and the panel cannot answer for it afterwards.
  function issue({ name, identityId, orgId, capabilities, expiresAt = null, createdBy }) {
    if (!identityId) throw new Error('a key belongs to an identity');
    const scopes = cleanCapabilities(capabilities);
    const label = String(name || '').trim().slice(0, 80) || 'unnamed key';
    const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
    const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    const id = `key_${crypto.randomBytes(8).toString('hex')}`;
    const at = now().toISOString();
    db.prepare(`INSERT INTO api_keys (id, prefix, secret_hash, name, identity_id, org_id, capabilities, created_at, created_by, expires_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, prefix, hash(secret), label, identityId, orgId || null, JSON.stringify(scopes), at,
        createdBy || identityId, expiresAt || null);
    return { id, name: label, prefix, capabilities: scopes, created_at: at, expires_at: expiresAt || null, token: `jotpanel_${prefix}_${secret}` };
  }

  // Returns the key, or null. Never throws on a bad token: a caller cannot be
  // told which half was wrong.
  function verify(presented) {
    const match = TOKEN.exec(String(presented || ''));
    if (!match) return null;
    const row = db.prepare('SELECT * FROM api_keys WHERE prefix=?').get(match[1]);
    if (!row) return null;
    const expected = Buffer.from(row.secret_hash, 'utf8');
    const given = Buffer.from(hash(match[2]), 'utf8');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (row.revoked_at) return null;
    if (row.expires_at && new Date(row.expires_at).getTime() <= now().getTime()) return null;
    // Written on use so a key nobody has touched in a year can be found and
    // taken away. Deliberately not part of what decides the answer above.
    try { db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now().toISOString(), row.id); } catch { /* a read must not fail on its own bookkeeping */ }
    return present(row);
  }

  function present(row) {
    let capabilities = [];
    try { capabilities = JSON.parse(row.capabilities); } catch { capabilities = []; }
    return {
      id: row.id, name: row.name, prefix: row.prefix,
      identityId: row.identity_id, orgId: row.org_id,
      capabilities,
      createdAt: row.created_at, createdBy: row.created_by,
      expiresAt: row.expires_at, lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at, revokedBy: row.revoked_by,
      permits: capability => permits(capabilities, capability),
    };
  }

  // What a person is shown. There is no route and no argument that returns the
  // secret, because the panel does not have it.
  function list(identityIds) {
    const ids = Array.isArray(identityIds) ? identityIds : [identityIds];
    if (!ids.length) return [];
    const rows = db.prepare(`SELECT * FROM api_keys WHERE identity_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`).all(...ids);
    return rows.map(row => {
      const { permits: _permits, ...rest } = present(row);
      return rest;
    });
  }

  function get(id) {
    const row = db.prepare('SELECT * FROM api_keys WHERE id=?').get(id);
    return row ? present(row) : null;
  }

  // Immediate, and idempotent. Revoking a key that is already revoked is not an
  // error: the caller wanted it dead and it is dead.
  function revoke(id, revokedBy) {
    const row = db.prepare('SELECT * FROM api_keys WHERE id=?').get(id);
    if (!row) throw new Error('There is no key with that id');
    if (!row.revoked_at) {
      db.prepare('UPDATE api_keys SET revoked_at=?, revoked_by=? WHERE id=?').run(now().toISOString(), revokedBy || null, id);
    }
    return get(id);
  }

  return { issue, verify, list, get, revoke, permits, looksLikeApiKey };
}

module.exports = { createApiKeyService, looksLikeApiKey };
