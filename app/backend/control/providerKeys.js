'use strict';

// Where a provider key lives, and the four things that must be true of it.
//
// Before this file, a customer's own provider key was a field in the settings
// blob: `settings.data` held `aiKeys[provider].key` as plain text, `PUT
// /api/settings` wrote whatever the browser sent, and `GET /api/settings`
// handed the whole blob back. That meant the key could be read back in full by
// anything holding a session, it sat in clear text in the database, and every
// database backup carried it. A backup is the one that matters: once customer
// files and system configuration are in the same backup and restore system, a
// key inside a snapshot is an exfiltration path the customer can trigger
// themselves by restoring and downloading.
//
// So a provider key is held here and nowhere else, and four rules hold it:
//
// - Write only. A key goes in and is never returned. What can be read back is a
//   fingerprint and a label, never any characters of the key itself, not even
//   the last four. Showing a fragment is how a guess gets narrowed, and a
//   fingerprint tells two keys apart just as well while telling an attacker
//   nothing.
// - Encrypted at rest, with the same AES-256-GCM field encryption the rest of
//   the panel's credentials use, so a copy of the database on its own yields
//   nothing.
// - Excluded from backup by name. `EXCLUDED_TABLES` is the list a backup asks,
//   rather than a rule written down in a runbook and remembered by a person.
// - Gone when revoked. Revoking or replacing a key blanks its ciphertext, so a
//   later leak of the encryption secret cannot open keys the person removed.
// - Attributable. Every resolution names the tier it came from, so a metered
//   row can say whose key paid for a call, which is the billing record and, on
//   a bad day, the evidence.
//
// The chain, which is the part that did not exist at all. `resolveKey` in
// server.js knew two levels: the caller's own key, then a platform env var. The
// ladder has four tiers and the reseller sat in a gap. The rule that makes all
// of it fall out of one mechanism is that at every tier the choice is inherit,
// supply, or require the tier below to supply.

const crypto = require('crypto');

// Tables a backup must never copy. Asked by the backup path rather than
// remembered, and asserted by the test, so adding a secret-bearing table
// without adding it here fails a suite rather than shipping quietly.
const EXCLUDED_TABLES = ['provider_keys'];

// What a tier may do about keys. `inherit` takes whatever the tier above
// resolved to. `supply` uses this tier's own key. `require_below` refuses to
// lend this tier's key downward, so the tier beneath has to bring its own.
const MODES = new Set(['inherit', 'supply', 'require_below']);

const FINGERPRINT_CHARS = 16;
const MAX_ACTIVE_KEYS = 3;

function fingerprintOf(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, FINGERPRINT_CHARS);
}

function createProviderKeyService({ db, secret, now = () => new Date() }) {
  if (!db) throw new Error('the provider key service requires a database');
  if (!secret) throw new Error('the provider key service requires an encryption secret');

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_keys (
      id            TEXT PRIMARY KEY,
      scope_kind    TEXT NOT NULL,
      scope_id      TEXT NOT NULL,
      provider_id   TEXT NOT NULL,
      secret_enc    TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      label         TEXT,
      created_at    TEXT NOT NULL,
      created_by    TEXT NOT NULL,
      last_used_at  TEXT,
      revoked_at    TEXT,
      revoked_by    TEXT
    );
    DROP INDEX IF EXISTS idx_provider_keys_live;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_keys_live_label
      ON provider_keys(scope_kind, scope_id, provider_id, COALESCE(label, '')) WHERE revoked_at IS NULL;
    CREATE TABLE IF NOT EXISTS provider_key_policy (
      scope_kind    TEXT NOT NULL,
      scope_id      TEXT NOT NULL,
      mode          TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      updated_by    TEXT NOT NULL,
      PRIMARY KEY (scope_kind, scope_id)
    );
  `);

  db.prepare("UPDATE provider_keys SET secret_enc='' WHERE revoked_at IS NOT NULL AND secret_enc != ''").run();

  // The same construction as the panel's other encrypted credential fields:
  // scrypt is slow on purpose, so the derived key is made once and kept.
  let _derived = null;
  function derivedKey() {
    if (!_derived) _derived = crypto.scryptSync(secret, 'arca-deploy-salt', 32);
    return _derived;
  }

  function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', derivedKey(), iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  }

  function open(b64) {
    const buf = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', derivedKey(), buf.slice(0, 12));
    d.setAuthTag(buf.slice(12, 28));
    return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
  }

  const stamp = () => now().toISOString();

  function normaliseScope(scope) {
    if (!scope || !scope.kind || !scope.id) throw new Error('a provider key needs a scope');
    if (scope.kind !== 'identity' && scope.kind !== 'org') {
      throw new Error(`unknown scope kind ${scope.kind}`);
    }
    return { kind: scope.kind, id: String(scope.id) };
  }

  // A label is the stable slot for one of at most three live keys. Calls from
  // before labels existed still replace the provider's keys as one legacy
  // slot, which keeps their rotation semantics intact.
  function put(scope, providerId, keyText, { label = null, by } = {}) {
    const s = normaliseScope(scope);
    if (!providerId) throw new Error('a provider key needs a provider');
    const value = typeof keyText === 'string' ? keyText.trim() : '';
    if (!value) throw new Error('an empty provider key is not a key');
    if (!by) throw new Error('storing a provider key has to name who did it');

    const named = typeof label === 'string' ? label.trim() : null;
    if (label != null && (!named || named.length > 80)) throw new Error('a provider key label is 1 to 80 characters');

    return db.transaction(() => {
      const at = stamp();
      const existing = named
        ? db.prepare(`SELECT id FROM provider_keys WHERE scope_kind=? AND scope_id=? AND provider_id=?
            AND label=? AND revoked_at IS NULL`).all(s.kind, s.id, providerId, named)
        : db.prepare(`SELECT id FROM provider_keys WHERE scope_kind=? AND scope_id=? AND provider_id=?
            AND revoked_at IS NULL`).all(s.kind, s.id, providerId);
      const live = db.prepare(`SELECT COUNT(*) count FROM provider_keys
        WHERE scope_kind=? AND scope_id=? AND provider_id=? AND revoked_at IS NULL`).get(s.kind, s.id, providerId).count;
      if (!existing.length && live >= MAX_ACTIVE_KEYS) {
        const error = new Error(`a provider can have at most ${MAX_ACTIVE_KEYS} active keys`);
        error.code = 'KEY_LIMIT';
        throw error;
      }
      for (const row of existing) {
        db.prepare("UPDATE provider_keys SET revoked_at=?, revoked_by=?, secret_enc='' WHERE id=?").run(at, by, row.id);
      }

      const id = crypto.randomBytes(12).toString('hex');
      const fingerprint = fingerprintOf(value);
      db.prepare(`INSERT INTO provider_keys
        (id, scope_kind, scope_id, provider_id, secret_enc, fingerprint, label, created_at, created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, s.kind, s.id, providerId, seal(value), fingerprint, named, at, by);

      return { id, provider_id: providerId, fingerprint, label: named, created_at: at, rotated: existing.length > 0 };
    })();
  }

  // What a person may see. No characters of the key, by construction: the
  // column holding it is not selected here at all.
  function list(scope) {
    const s = normaliseScope(scope);
    return db.prepare(`SELECT id, provider_id, fingerprint, label, created_at, created_by, last_used_at
      FROM provider_keys WHERE scope_kind=? AND scope_id=? AND revoked_at IS NULL ORDER BY provider_id, created_at, rowid`)
      .all(s.kind, s.id);
  }

  function revoke(scope, providerId, by, { label = null } = {}) {
    const s = normaliseScope(scope);
    if (!by) throw new Error('revoking a provider key has to name who did it');
    const named = typeof label === 'string' ? label.trim() : null;
    if (label != null && !named) throw new Error('a provider key label cannot be empty');
    const info = named
      ? db.prepare(`UPDATE provider_keys SET revoked_at=?, revoked_by=?, secret_enc=''
          WHERE scope_kind=? AND scope_id=? AND provider_id=? AND label=? AND revoked_at IS NULL`)
        .run(stamp(), by, s.kind, s.id, providerId, named)
      : db.prepare(`UPDATE provider_keys SET revoked_at=?, revoked_by=?, secret_enc=''
          WHERE scope_kind=? AND scope_id=? AND provider_id=? AND revoked_at IS NULL`)
        .run(stamp(), by, s.kind, s.id, providerId);
    return { revoked: info.changes > 0 };
  }

  function modeFor(scope) {
    const s = normaliseScope(scope);
    const row = db.prepare('SELECT mode FROM provider_key_policy WHERE scope_kind=? AND scope_id=?')
      .get(s.kind, s.id);
    return row ? row.mode : 'inherit';
  }

  function setMode(scope, mode, by) {
    const s = normaliseScope(scope);
    if (!MODES.has(mode)) throw new Error(`unknown key mode ${mode}`);
    if (!by) throw new Error('changing a key mode has to name who did it');
    db.prepare(`INSERT INTO provider_key_policy (scope_kind, scope_id, mode, updated_at, updated_by)
      VALUES (?,?,?,?,?) ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
      mode=excluded.mode, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .run(s.kind, s.id, mode, stamp(), by);
    return { mode };
  }

  // Walk the ladder from the most specific tier upward and return the first
  // usable key, with the tier it came from. `chain` is ordered most specific
  // first, so [identity, reseller org, hoster org].
  //
  // A tier set to `require_below` will not lend its key downward. Reaching such
  // a tier while walking up means the tier beneath it was supposed to bring its
  // own and did not, so the walk stops there and says so rather than quietly
  // spending somebody else's money.
  function resolveAll(providerId, chain) {
    if (!providerId) return null;
    const tiers = (chain || []).map(normaliseScope);

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      const mode = modeFor(tier);

      // Only a tier above the one asking can refuse to lend downward.
      if (i > 0 && mode === 'require_below') {
        return [{
          key: null,
          source: null,
          refused: 'the tier above requires this account to supply its own key',
          requiredBy: tier,
        }];
      }

      const rows = db.prepare(`SELECT id, secret_enc, fingerprint, label FROM provider_keys
        WHERE scope_kind=? AND scope_id=? AND provider_id=? AND revoked_at IS NULL
        ORDER BY created_at, rowid`).all(tier.kind, tier.id, providerId);
      if (!rows.length) continue;
      if (mode === 'inherit' && i > 0) {
        // A tier holding a key it has not chosen to supply is a stored key, not
        // an offered one. Only `supply` lends downward.
        continue;
      }

      const found = [];
      for (const row of rows) {
        let key;
        try { key = open(row.secret_enc); }
        catch { return [{ key: null, source: null, refused: 'the stored key could not be decrypted' }]; }
        found.push({ key, source: tier, fingerprint: row.fingerprint, label: row.label, refused: null });
      }
      return found;
    }
    return [];
  }

  function resolve(providerId, chain, options = {}) {
    const found = resolveAll(providerId, chain);
    const first = found && found.length ? found[0] : null;
    if (first && first.key && options.markUsed !== false) {
      db.prepare(`UPDATE provider_keys SET last_used_at=? WHERE scope_kind=? AND scope_id=?
        AND provider_id=? AND fingerprint=? AND revoked_at IS NULL`)
        .run(stamp(), first.source.kind, first.source.id, providerId, first.fingerprint);
    }
    return first;
  }

  // Everything a caller may know about a key without being told the key.
  function describe(scope, providerId) {
    const s = normaliseScope(scope);
    return db.prepare(`SELECT id, provider_id, fingerprint, label, created_at, last_used_at
      FROM provider_keys WHERE scope_kind=? AND scope_id=? AND provider_id=? AND revoked_at IS NULL
      ORDER BY created_at, rowid`)
      .get(s.kind, s.id, providerId) || null;
  }

  return { put, list, revoke, resolve, resolveAll, describe, modeFor, setMode, fingerprintOf, EXCLUDED_TABLES };
}

module.exports = { createProviderKeyService, fingerprintOf, EXCLUDED_TABLES, MODES, MAX_ACTIVE_KEYS };
