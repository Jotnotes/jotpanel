'use strict';

// A guest that had to regenerate a secret must not read as healthy.
//
// The repair itself is proven by app/deploy/firstboot-env.test.sh. This is the
// other half: that the marker it leaves reaches the health report, with the
// severity the loss deserves, and that it stops reaching it once an operator
// has cleared it. Without this the repair is something only the journal knows,
// and a pool host would draw a green row for a guest whose encrypted fields
// cannot be read.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { secretsRepairedConcerns, installRootFrom, MARKER, UNRECOVERABLE } = require('./secretsRepaired');

let passed = 0;
const check = (what, fn) => { fn(); passed++; console.log(`  ok  ${what}`); };

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-repaired-'));
const marker = (dir, body) => fs.writeFileSync(path.join(dir, MARKER), body);

// ── A box nothing happened to ───────────────────────────────────────
check('a box with no marker raises nothing, so an ordinary guest stays healthy', () => {
  const dir = root();
  assert.deepEqual(secretsRepairedConcerns({ installRoot: dir }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('no install root raises nothing rather than guessing at one', () => {
  assert.deepEqual(secretsRepairedConcerns({ installRoot: null }), []);
});

check('an empty marker raises nothing, because a touched file is not a repair', () => {
  const dir = root();
  marker(dir, '   \n');
  assert.deepEqual(secretsRepairedConcerns({ installRoot: dir }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── The loss that cannot be undone ──────────────────────────────────
check('losing the encryption secret is CRITICAL, so the verdict cannot read healthy', () => {
  const dir = root();
  marker(dir, `2026-10-05T07:55:05Z jotpanel-firstboot repaired ${dir}/.env\n`
    + `missing and regenerated: JWT_SECRET ${UNRECOVERABLE}\n`);
  const [concern, ...rest] = secretsRepairedConcerns({ installRoot: dir });
  assert.equal(rest.length, 0, 'one concern, not a list per name');
  assert.equal(concern.severity, 'critical');
  assert.match(concern.what, /Encryption secret was regenerated/);
  // The operator has to be told the three things that matter: what cannot be
  // read, that it is gone rather than mislaid, and what to do instead.
  assert.match(concern.why, /cannot be read/);
  assert.match(concern.why, /gone rather than mislaid/);
  assert.match(concern.why, /Restore from a backup/);
  assert.match(concern.why, /2026-10-05T07:55:05Z/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── The repairs that cost inconvenience rather than data ────────────
check('a repair that kept the encryption secret is a WARNING, not a critical', () => {
  const dir = root();
  marker(dir, '2026-10-05T07:55:05Z jotpanel-firstboot repaired /opt/jotpanel/.env\n'
    + 'missing and regenerated: JWT_SECRET ADMIN_KEY\n');
  const [concern] = secretsRepairedConcerns({ installRoot: dir });
  assert.equal(concern.severity, 'warn');
  assert.match(concern.what, /Secrets were repaired at first boot/);
  assert.match(concern.why, /JWT_SECRET/);
  assert.match(concern.why, /ADMIN_KEY/);
  // And it says plainly that the irrecoverable thing did NOT happen, because
  // "secrets were repaired" would otherwise read as the worse case.
  assert.match(concern.why, /Nothing encrypted was lost/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('several repairs across several boots are read together', () => {
  const dir = root();
  marker(dir, '2026-10-04T01:00:00Z jotpanel-firstboot repaired /opt/jotpanel/.env\n'
    + 'missing and regenerated: JWT_SECRET\n'
    + '2026-10-05T02:00:00Z jotpanel-firstboot repaired /opt/jotpanel/.env\n'
    + `missing and regenerated: ${UNRECOVERABLE}\n`);
  const [concern] = secretsRepairedConcerns({ installRoot: dir });
  assert.equal(concern.severity, 'critical', 'the worst of them decides the severity');
  assert.match(concern.why, /2026-10-05T02:00:00Z/, 'and the most recent repair is the one dated');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── It can be turned off, by dealing with it ────────────────────────
check('the concern says how to clear it, and naming the file is how', () => {
  const dir = root();
  marker(dir, `missing and regenerated: ${UNRECOVERABLE}\n`);
  const [concern] = secretsRepairedConcerns({ installRoot: dir });
  assert.match(concern.why, new RegExp(`remove ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('removing the marker clears the concern, so it is a state and not a memory', () => {
  const dir = root();
  marker(dir, `missing and regenerated: ${UNRECOVERABLE}\n`);
  assert.equal(secretsRepairedConcerns({ installRoot: dir }).length, 1);
  fs.rmSync(path.join(dir, MARKER));
  assert.deepEqual(secretsRepairedConcerns({ installRoot: dir }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── It must never be the thing that breaks a health report ──────────
check('a marker that cannot be read is absent rather than an exception', () => {
  const thrower = {
    existsSync: () => true,
    readFileSync: () => { throw new Error('EACCES'); },
  };
  assert.deepEqual(secretsRepairedConcerns({ installRoot: '/opt/jotpanel', fs: thrower }), []);
});

// ── Where the install is, asked the way the rest of the backend asks ─
check('the install root comes from the job root when it is set', () => {
  assert.equal(installRootFrom({ env: { JOTPANEL_JOB_ROOT: '/opt/jotpanel' } }), '/opt/jotpanel');
  assert.equal(installRootFrom({ env: { ARCA_JOB_ROOT: '/opt/arca' } }), '/opt/arca');
});

check('and otherwise from the parent of the data directory, which is the real layout', () => {
  assert.equal(installRootFrom({ env: {}, dataDir: '/opt/jotpanel/data' }), '/opt/jotpanel');
  assert.equal(installRootFrom({ env: {} }), null);
});

console.log(`\nsecrets-repaired health checks passed — ${passed} checks`);
