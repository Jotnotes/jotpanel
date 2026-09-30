'use strict';

// One-time backfill: take the spent credentials out of actions that were
// already terminal before the store learned to do it on its own.
//
// From now on `actionStore` scrubs the call body on the write that records the
// outcome, so nothing new needs this. It exists for the rows written before
// that, and it is written down here rather than typed at a prompt because it
// rewrites the durable record and that should be reviewable afterwards.
//
//   node maintenance/scrub-spent-credentials.js            # report only
//   node maintenance/scrub-spent-credentials.js --write    # rewrite
//
// It must run from /opt/jotpanel/app/backend on the box, or better-sqlite3 will not
// resolve. It takes a timestamped copy of the database before writing anything.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { redact, holdsSecret, SCRUBBED } = require('../control/secrets');

const WRITE = process.argv.includes('--write');
const DB_PATH = (process.env.JOTPANEL_DB ?? process.env.ARCA_DB) || '/opt/jotpanel/data/jotpanel.db';
const ENV_PATH = (process.env.JOTPANEL_ENV ?? process.env.ARCA_ENV) || '/opt/jotpanel/.env';

// The same derivation server.js uses, read from the same file it reads. Copied
// deliberately rather than imported: requiring server.js would start a panel.
function envValue(name) {
  const match = fs.readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}
const _keys = new Map();
function fieldKey(secret) {
  let k = _keys.get(secret);
  if (!k) { k = crypto.scryptSync(secret, 'arca-deploy-salt', 32); _keys.set(secret, k); }
  return k;
}
function encryptField(text, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', fieldKey(secret), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decryptField(b64, secret) {
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', fieldKey(secret), buf.slice(0, 12));
  d.setAuthTag(buf.slice(12, 28));
  return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
}

const base = (process.env.JOTPANEL_ENCRYPT_SECRET ?? process.env.ARCA_ENCRYPT_SECRET) || envValue('ARCA_ENCRYPT_SECRET') || envValue('JWT_SECRET');
if (!base) { console.error('no encryption secret found in', ENV_PATH); process.exit(1); }
const SECRET = `${base}_control_actions`;

const db = new Database(DB_PATH, { readonly: !WRITE });
const rows = db.prepare('SELECT id, kind, status, protected_body FROM control_actions').all();

const holding = [];
const unreadable = [];
for (const row of rows) {
  let body;
  try { body = JSON.parse(decryptField(row.protected_body, SECRET)); }
  catch { unreadable.push(row.id); continue; }
  // Only terminal rows. A pending or approved action still needs its key, and
  // taking it now would break the operation the owner is about to approve.
  const terminal = ['executed', 'failed', 'rejected', 'interrupted'].includes(row.status);
  if (!terminal) continue;
  if (!body.call || !body.call.params) continue;
  if (!holdsSecret(body.call.params)) continue;
  holding.push({ row, body });
}

console.log(`${rows.length} actions, ${unreadable.length} unreadable, ${holding.length} terminal rows still holding a credential`);
for (const { row } of holding) console.log(`  ${row.id}  ${row.status.padEnd(11)}  ${row.kind}`);

if (!holding.length) { console.log('nothing to do'); process.exit(0); }
if (!WRITE) { console.log('\nreport only. re-run with --write to rewrite these rows'); process.exit(0); }

const backup = `${DB_PATH}.before-scrub-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(DB_PATH, backup);
console.log(`\ncopied the database to ${backup} first`);

const at = new Date().toISOString();
const update = db.prepare('UPDATE control_actions SET protected_body=? WHERE id=?');
const run = db.transaction(items => {
  for (const { row, body } of items) {
    const next = {
      ...body,
      call: { ...body.call, params: redact(body.call.params, { replacement: SCRUBBED }) },
      credentialScrubbedAt: at,
    };
    update.run(encryptField(JSON.stringify(next), SECRET), row.id);
  }
});
run(holding);

// Read back. The whole product is built on not reporting a success it has not
// checked, and a backfill over the durable record is the last place to make an
// exception.
let stillHolding = 0;
for (const { row } of holding) {
  const after = db.prepare('SELECT protected_body FROM control_actions WHERE id=?').get(row.id);
  const body = JSON.parse(decryptField(after.protected_body, SECRET));
  if (holdsSecret(body.call.params || {})) stillHolding += 1;
}
console.log(`rewrote ${holding.length} rows, ${stillHolding} still holding after read-back`);
process.exit(stillHolding ? 1 : 0);
