'use strict';
// An outage of the registration service never stops a classroom: the last
// good answer stands for a week, marked stale; a denied key is never extended.
const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createLicenseClient } = require('./licenseClient');
function client(lastStatus, lastChecked, nowIso) {
  const db = new Database(':memory:');
  const c = createLicenseClient({ db, dataDir: '/tmp', serverUrl: 'https://license.example', encrypt: x => x, decrypt: x => x,
    now: () => new Date(nowIso), fetchImpl: async () => { throw new Error('timeout'); } });
  db.prepare("INSERT INTO panel_registration(id,email,protected_license_key,registered_at,last_status,last_checked) VALUES(1,'x@y','k','2026-09-01T00:00:00Z',?,?)").run(lastStatus, lastChecked);
  return c;
}
(async () => {
  let v = await client('active', '2026-09-11T10:00:00Z', '2026-09-12T10:00:00Z').thinkingAccess();
  assert.equal(v.allowed, true, 'a day-old good answer stands through an outage'); assert.equal(v.stale, true);
  v = await client('active', '2026-09-01T10:00:00Z', '2026-09-12T10:00:00Z').thinkingAccess();
  assert.equal(v.allowed, false, 'eleven days is past the grace');
  v = await client('suspended', '2026-09-12T09:00:00Z', '2026-09-12T10:00:00Z').thinkingAccess();
  assert.equal(v.allowed, false, 'a suspension is never extended by an outage');
  console.log('licence grace tests passed (3)');
})().catch(e => { console.error(e); process.exit(1); });
