'use strict';

// Read one action back out of the durable record, decrypted, and answer the two
// questions a credential proof has to ask of it: does it still say a password
// where a password was, and is a particular secret anywhere inside it.
//
//   cd /opt/jotpanel/app/backend
//   node maintenance/inspect-action-body.js act_abc123 <sha256-of-the-secret>
//
// The secret is passed as a hash and never as itself. Everything under here is
// hashed the same way and compared, so a run that proves a password was removed
// does not put that password into a terminal, a scrollback or a log on the way.
//
// Read-only, in every sense: the database is opened readonly and nothing is
// printed except the redacted parameter names and two booleans. It is JSON on
// stdout because a verification script reads it.

const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { holdsSecret, isSecretName, HIDDEN, SCRUBBED } = require('../control/secrets');

const [, , ACTION_ID, NEEDLE_HASH] = process.argv;
if (!ACTION_ID) { console.error('usage: node maintenance/inspect-action-body.js <action-id> [sha256-of-secret]'); process.exit(1); }

const DB_PATH = (process.env.JOTPANEL_DB ?? process.env.ARCA_DB) || '/opt/jotpanel/data/jotpanel.db';
const ENV_PATH = (process.env.JOTPANEL_ENV ?? process.env.ARCA_ENV) || '/opt/jotpanel/.env';

// The same derivation server.js uses, read from the same file it reads. Copied
// deliberately rather than imported, for the reason the scrub backfill gives:
// requiring server.js would start a panel.
function envValue(name) {
  const match = fs.readFileSync(ENV_PATH, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}
function decryptField(b64, secret) {
  const key = crypto.scryptSync(secret, 'arca-deploy-salt', 32);
  const buf = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.slice(0, 12));
  d.setAuthTag(buf.slice(12, 28));
  return Buffer.concat([d.update(buf.slice(28)), d.final()]).toString('utf8');
}

const base = (process.env.JOTPANEL_ENCRYPT_SECRET ?? process.env.ARCA_ENCRYPT_SECRET) || envValue('ARCA_ENCRYPT_SECRET') || envValue('JWT_SECRET');
if (!base) { console.error('no encryption secret found in', ENV_PATH); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true });
const row = db.prepare('SELECT id, kind, status, protected_body FROM control_actions WHERE id=?').get(ACTION_ID);
if (!row) { console.error(`no action ${ACTION_ID}`); process.exit(1); }
const body = JSON.parse(decryptField(row.protected_body, `${base}_control_actions`));

// Every string anywhere under the row, hashed. Not just the call parameters:
// the point is to find a copy somewhere nobody thought to look, which is the
// only kind that matters.
let found = false;
const walk = node => {
  if (found) return;
  if (typeof node === 'string') { if (NEEDLE_HASH && crypto.createHash('sha256').update(node).digest('hex') === NEEDLE_HASH) found = true; return; }
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node && typeof node === 'object') Object.values(node).forEach(walk);
};
walk(body);

// What is stored under each parameter now, said without saying it. The two
// markers are passed through as themselves, because telling them apart is the
// whole question: [protected] means you are not being shown it, [scrubbed]
// means it is not there any more. Anything else under a secret-shaped name is
// reported as still held rather than printed, so an inspector run against a
// pending card cannot be the thing that leaks one.
function describe(params) {
  if (!params || typeof params !== 'object') return null;
  const out = {};
  for (const [name, value] of Object.entries(params)) {
    if (!isSecretName(name) || value == null || value === '') out[name] = value;
    else if (value === HIDDEN || value === SCRUBBED) out[name] = value;
    else out[name] = '[still held]';
  }
  return out;
}

console.log(JSON.stringify({
  id: row.id,
  kind: row.kind,
  status: row.status,
  // Parameter names with their values replaced by what is actually stored there
  // now, which for a spent credential should be the scrub marker.
  call_params: describe(body.call && body.call.params),
  credential_scrubbed_at: body.credentialScrubbedAt || null,
  holds_needle: NEEDLE_HASH ? found : null,
  holds_secret: body.call && body.call.params ? holdsSecret(body.call.params) : false,
}, null, 2));
