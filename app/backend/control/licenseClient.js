'use strict';
// A week: how long the last good licence answer stands when the service cannot be reached.
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createLicenseClient({
  db,
  dataDir,
  serverUrl = (process.env.JOTPANEL_LICENSE_URL ?? process.env.ARCA_LICENSE_URL) || '',
  version = (process.env.JOTPANEL_VERSION ?? process.env.ARCA_VERSION) || 'dev',
  encrypt,
  decrypt,
  now = () => new Date(),
  fetchImpl = global.fetch,
} = {}) {
  if (!db || !dataDir) throw new Error('license client is missing required dependencies');
  if (typeof encrypt !== 'function' || typeof decrypt !== 'function') throw new Error('license client requires encrypted storage callbacks');
  const base = String(serverUrl || '').replace(/\/$/, '');
  const machineId = installationMachineId(dataDir);
  let cache = null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_registration (
      id                    INTEGER PRIMARY KEY CHECK (id=1),
      email                 TEXT NOT NULL,
      newsletter_opt_in     INTEGER NOT NULL DEFAULT 0,
      consent_text          TEXT,
      protected_license_key TEXT NOT NULL,
      registered_at         TEXT NOT NULL,
      last_status           TEXT,
      last_reason           TEXT,
      last_checked          TEXT
    );
  `);

  function localStatus() {
    const row = db.prepare('SELECT * FROM panel_registration WHERE id=1').get();
    if (!row) {
      return {
        registered: false,
        status: 'unregistered',
        assistant_available: false,
        panel_available: true,
        call_home: false,
        message: 'The panel is complete and working. Register free to connect the assistant.',
      };
    }
    return {
      registered: true,
      email: row.email,
      newsletter_opt_in: !!row.newsletter_opt_in,
      status: row.last_status || 'unchecked',
      reason: row.last_reason || null,
      last_checked: row.last_checked || null,
      assistant_available: row.last_status === 'active',
      panel_available: true,
      call_home: true,
    };
  }

  async function register({ email, newsletterOptIn = false, consentText = '' } = {}) {
    if (!base) throw new Error('This installation has no registration service configured');
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(cleanEmail)) throw new Error('A valid email address is required');
    const response = await fetchImpl(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cleanEmail,
        newsletter_opt_in: newsletterOptIn === true,
        consent_text: String(consentText || '').slice(0, 500),
      }),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.key) throw new Error(data.error || `Registration failed (${response.status})`);
    db.prepare(`INSERT INTO panel_registration
      (id,email,newsletter_opt_in,consent_text,protected_license_key,registered_at,last_status,last_reason,last_checked)
      VALUES (1,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,newsletter_opt_in=excluded.newsletter_opt_in,
        consent_text=excluded.consent_text,protected_license_key=excluded.protected_license_key,
        registered_at=excluded.registered_at,last_status=excluded.last_status,last_reason=NULL,last_checked=excluded.last_checked`)
      .run(cleanEmail, newsletterOptIn ? 1 : 0, String(consentText || '').slice(0, 500), encrypt(data.key),
        now().toISOString(), 'unchecked', null, now().toISOString());
    cache = null;
    return validate({ force: true });
  }

  async function validate({ force = false } = {}) {
    const row = db.prepare('SELECT * FROM panel_registration WHERE id=1').get();
    if (!row) return localStatus(); // no network request: unregistered means no call home
    if (!base) return { ...localStatus(), status: 'configuration_error', reason: 'Registration service is not configured', assistant_available: false };
    if (!force && cache && now().getTime() - cache.at < 5 * 60 * 1000) return cache.value;
    try {
      const response = await fetchImpl(`${base}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: decrypt(row.protected_license_key), machine_id: machineId, version }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await response.json().catch(() => ({}));
      // A licence server that lives on another machine sits behind a reverse
      // proxy, and it does not fail by refusing the connection. It fails as a
      // 502 from the proxy, which is a perfectly good HTTP response carrying no
      // licence decision at all. The loopback deployment this was written
      // against could never produce one, so an outage arrived here looking like
      // an answer, got reported as `unavailable` with a bare HTTP number, and
      // was written into the panel's own record on the way past. Treated as the
      // outage it is: same path as a refused connection, nothing written down.
      if (response.status >= 500 || typeof data.valid !== 'boolean') {
        throw new Error(`it answered ${response.status} with no licence decision`);
      }
      const status = data.valid ? 'active' : (data.status || 'unavailable');
      const reason = data.reason || (response.ok ? null : `Registration service returned ${response.status}`);
      db.prepare('UPDATE panel_registration SET last_status=?,last_reason=?,last_checked=? WHERE id=1')
        .run(status, reason, now().toISOString());
      const value = {
        registered: true,
        email: row.email,
        newsletter_opt_in: !!row.newsletter_opt_in,
        status,
        reason,
        ban_category: data.ban_category || null,
        contact: data.contact || null,
        assistant_available: data.valid === true,
        panel_available: true,
        call_home: true,
        last_checked: now().toISOString(),
      };
      cache = { at: now().getTime(), value };
      return value;
    } catch (error) {
      // An outage on our side must never stop a working panel. The last answer the
      // service gave is written on the registration row; while that answer was
      // "active" and is less than a week old, it stands, marked stale, and the
      // assistant keeps working. Found on the demo box, 2026-09-12: the licence
      // server went quiet and every account was refused within minutes. A
      // denied or suspended key is a different thing and is never extended.
      const local = localStatus();
      const lastGood = local.status === 'active' && local.last_checked && (now().getTime() - Date.parse(local.last_checked)) < GRACE_MS;
      const value = {
        ...local,
        status: lastGood ? 'active' : 'unreachable',
        stale: true,
        reason: lastGood ? `The registration service could not be reached (${error.message}); the last good answer from ${local.last_checked} stands.` : `The thinking service could not be reached: ${error.message}`,
        assistant_available: lastGood,
        panel_available: true,
      };
      // An outage is not written as a suspension. Keep the distinction visible.
      cache = { at: now().getTime(), value };
      return value;
    }
  }

  async function thinkingAccess() {
    // Steve's own development/thinking-service deployment has no upstream
    // licence URL. Customer installers set one explicitly. This keeps local
    // development testable without turning an absent service into a fake call.
    if (!base) return { allowed: true, managed: false, status: 'service_mode' };
    const state = await validate();
    return { allowed: state.assistant_available === true, managed: true, ...state };
  }

  function keyForProxy() {
    const row = db.prepare('SELECT protected_license_key FROM panel_registration WHERE id=1').get();
    return row ? decrypt(row.protected_license_key) : null;
  }

  return { localStatus, register, validate, thinkingAccess, keyForProxy, machineId, serverUrl: base };
}

function installationMachineId(dataDir) {
  let raw = '';
  try { raw = fs.readFileSync('/etc/machine-id', 'utf8').trim(); } catch {}
  const localPath = path.join(dataDir, 'machine-id');
  if (!raw) {
    try { raw = fs.readFileSync(localPath, 'utf8').trim(); } catch {}
  }
  if (!raw) {
    raw = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(localPath, `${raw}\n`, { mode: 0o600 });
  }
  // The licence server needs a stable binding, not the OS identifier itself.
  return crypto.createHash('sha256').update(`arca-machine\0${raw}`).digest('hex');
}

module.exports = { createLicenseClient, installationMachineId };
