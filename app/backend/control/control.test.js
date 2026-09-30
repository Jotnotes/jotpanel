'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createActionStore } = require('./actionStore');
const { createZip, readZip } = require('./archiveFormat');
const { createPortabilityService, detectForeignSource, foreignInventory, openWithPassphrase } = require('./portability');
const { createScheduledJobsService, cronMatches } = require('./scheduledJobs');
const { createUsageService } = require('./usage');
const { createStatisticsService } = require('./statistics');
const { parseListeners } = require('./localEngineSecurity');
const { redact, holdsSecret, SECRET_PARAM } = require('./secrets');

async function run() {
  await testActionStoreIsDurableAndProtected();
  testZipRoundTripAndSafety();
  testPortableExportVerifiesItself();
  await testActionStoreSpendsTheSecretItUsed();
  testAProofSurvivesPastTheEndOfTheList();
  testTheOperationsNameIsNotTreatedAsASecret();
  await testScheduledJobNoteAndRunRecord();
  testUsageSeparatesPlatformAndCustomerKey();
  testStatisticsAvoidRawIps();
  testForeignDetection();
  testLocalEngineListenerDetection();
  console.log('control-plane tests passed');
}

async function testActionStoreIsDurableAndProtected() {
  const db = new Database(':memory:');
  const protect = value => Buffer.from(value).toString('base64');
  const unprotect = value => Buffer.from(value, 'base64').toString('utf8');
  const store = createActionStore({ db, protect, unprotect });
  const item = store.enqueue({ accountId: 'owner', kind: 'mail.create', label: 'Create mailbox', call: { password: 'do-not-leak' } });
  assert.equal(item.status, 'pending');
  const raw = db.prepare('SELECT protected_body FROM control_actions WHERE id=?').get(item.id).protected_body;
  assert.doesNotMatch(raw, /do-not-leak/);
  store.approve(item.id, { approvedBy: 'owner' });
  store.markFailed(item.id, new Error('mail service unavailable'));
  const reopened = createActionStore({ db, protect, unprotect });
  assert.equal(reopened.get(item.id).status, 'failed');
  assert.match(reopened.get(item.id).error, /unavailable/);
}

// A proof from months ago still reads as a proof after a busy session.
//
// The checklist is built from what the box says has run there. It used to page
// the action list, which is capped at a thousand rows newest first, so running
// a few hundred proofs pushed the earlier ones past the cap and they came back
// as never run. The checklist total went down on 24 August for exactly that
// reason, with nothing having regressed.
//
// So: one verified run, then more actions than the list will ever show, and the
// question is asked both ways. The list cannot see the proof any more. The
// summary can, because it groups rather than pages.
function testAProofSurvivesPastTheEndOfTheList() {
  const db = new Database(':memory:');
  let clock = new Date('2026-06-01T00:00:00.000Z');
  const store = createActionStore({ db, now: () => clock });

  const proof = store.enqueue({ accountId: 'owner', kind: 'server_ops.database.grant', label: 'Grant on a database' });
  store.approve(proof.id, { approvedBy: 'owner' });
  store.markExecuted(proof.id, { verified: true, name: 'arca_proof' });

  for (let i = 0; i < 1100; i += 1) {
    clock = new Date(Date.UTC(2026, 7, 24, 0, 0, 0, i));
    const filler = store.enqueue({ accountId: 'owner', kind: 'server_ops.mail.mailbox.create', label: `noise ${i}` });
    store.approve(filler.id, { approvedBy: 'owner' });
    store.markExecuted(filler.id, { verified: true });
  }

  const listed = store.list({ accountId: 'owner', limit: 5000 });
  assert.equal(listed.length, 1000, 'the list is capped, which is the whole problem');
  assert.ok(!listed.some(action => action.id === proof.id), 'the proof has fallen off the back of the list');

  const summary = store.summarizeByKind({ accountId: 'owner', prefix: 'server_ops.' });
  const grant = summary.find(row => row.kind === 'server_ops.database.grant');
  assert.ok(grant, 'the operation is still in the summary');
  assert.equal(grant.verifiedAt.slice(0, 10), '2026-06-01', 'and it still says when it was proved');

  // A later failure does not erase that it once worked, and does not hide either.
  const broke = store.enqueue({ accountId: 'owner', kind: 'server_ops.database.grant', label: 'Grant on a database' });
  store.approve(broke.id, { approvedBy: 'owner' });
  store.markFailed(broke.id, new Error('the grant did not read back'));
  const after = store.summarizeByKind({ accountId: 'owner' }).find(row => row.kind === 'server_ops.database.grant');
  assert.equal(after.verifiedAt.slice(0, 10), '2026-06-01');
  assert.match(after.lastError, /did not read back/);
  assert.ok(after.lastFailedAt > after.verifiedAt, 'the failure is the more recent fact and is reported as such');

  // A run that finished and read nothing back is not a proof of anything.
  const unchecked = store.enqueue({ accountId: 'owner', kind: 'server_ops.database.password', label: 'Change a password' });
  store.approve(unchecked.id, { approvedBy: 'owner' });
  store.markExecuted(unchecked.id, { changed: true });
  const password = store.summarizeByKind({ accountId: 'owner' }).find(row => row.kind === 'server_ops.database.password');
  assert.equal(password.verifiedAt, null, 'nothing checked it, so nothing may tick it');

  // And it is one holder's record, not the machine's.
  assert.equal(store.summarizeByKind({ accountId: 'somebody-else' }).length, 0);
}

// A spent credential does not stay in the record.
//
// `call.params` has to hold the real key until the work happens and must not
// hold it afterwards. The check is deliberately made on the encrypted column
// rather than on the hydrated object: what matters is that the bytes on disk no
// longer contain it, not that a getter declines to show it.
async function testActionStoreSpendsTheSecretItUsed() {
  const secret = 'smtps://user:tops3cret@mail.example.com:465';
  const db = new Database(':memory:');
  const protect = value => Buffer.from(value).toString('base64');
  const unprotect = value => Buffer.from(value, 'base64').toString('utf8');
  const store = createActionStore({ db, protect, unprotect });
  const bodyOf = id => Buffer.from(db.prepare('SELECT protected_body FROM control_actions WHERE id=?').get(id).protected_body, 'base64').toString('utf8');

  const propose = () => store.enqueue({
    accountId: 'owner', kind: 'server_ops.integration.connect', label: 'Connect a provider',
    call: { capability: 'integration.connect', params: { provider: 'smtp.generic', scope: 'platform', credential: secret } },
    metadata: { params: { provider: 'smtp.generic', scope: 'platform', credential: '[protected]' } },
  });

  // While it is pending it has to still be there, or the operation cannot run.
  const pending = propose();
  assert.match(bodyOf(pending.id), /tops3cret/, 'a pending action still needs the key it will use');

  // Executed.
  store.approve(pending.id, { approvedBy: 'owner' });
  store.markExecuted(pending.id, { ok: true });
  assert.doesNotMatch(bodyOf(pending.id), /tops3cret/, 'an executed action has spent it');
  const done = store.get(pending.id);
  assert.equal(done.call.params.credential, '[scrubbed]');
  assert.equal(done.call.params.provider, 'smtp.generic', 'what it did is kept');
  assert.equal(done.metadata.params.credential, '[protected]', 'the audit summary is untouched');
  assert.ok(done.credentialScrubbedAt, 'and the record says when it stopped holding it');

  // Failed. A key the far end refused is still a key that was sent.
  const failed = propose();
  store.approve(failed.id, { approvedBy: 'owner' });
  store.markFailed(failed.id, new Error('that mail server did not accept the connection'));
  assert.doesNotMatch(bodyOf(failed.id), /tops3cret/, 'a failed action has spent it too');

  // Rejected. It never ran, and somebody still typed a real key into it.
  const rejected = propose();
  store.reject(rejected.id, { rejectedBy: 'owner', reason: 'thought better of it' });
  assert.doesNotMatch(bodyOf(rejected.id), /tops3cret/, 'a rejected action does not keep what was typed into it');
  assert.equal(store.get(rejected.id).status, 'rejected');
  assert.equal(store.get(rejected.id).rejectedReason, 'thought better of it');

  // Interrupted. Nothing can pick it up again, so nothing needs the key.
  const interrupted = propose();
  store.approve(interrupted.id, { approvedBy: 'owner' });
  store.markExecuting(interrupted.id, { runId: 'run1' });
  store.markInterrupted(interrupted.id, { reason: 'the panel stopped' });
  assert.doesNotMatch(bodyOf(interrupted.id), /tops3cret/, 'an interrupted action cannot run again, so it holds nothing');

  // Scrubbing must not reach back into the caller's own parameters. The panel
  // hands a generated mailbox password to its owner once, after the record is
  // written, out of the params object it executed with. If `spend` mutated that
  // object rather than copying it, the mailbox would exist and the password
  // that opens it would be gone.
  const live = { provider: 'smtp.generic', credential: secret };
  const held = store.enqueue({ accountId: 'owner', kind: 'server_ops.integration.connect', label: 'Connect',
    call: { capability: 'integration.connect', params: live } });
  store.approve(held.id, { approvedBy: 'owner' });
  store.markExecuted(held.id, { ok: true });
  assert.equal(live.credential, secret, 'the caller still holds what it passed in');

  // An action with nothing secret in it is left exactly as it was.
  const plain = store.enqueue({ accountId: 'owner', kind: 'server_ops.backup.create', label: 'Back up',
    call: { capability: 'backup.create', params: { domain: 'example.com', keep: 7 } } });
  store.approve(plain.id, { approvedBy: 'owner' });
  store.markExecuted(plain.id, { ok: true });
  const kept = store.get(plain.id);
  assert.deepEqual(kept.call.params, { domain: 'example.com', keep: 7 });
  assert.equal(kept.credentialScrubbedAt, undefined, 'nothing was spent, so nothing is claimed to have been');
}


// The name of the operation survives redaction.
//
// The secret rule matches a bare `key`, on purpose, because that is what an SSH
// key and a licence key are called. It also matched `actionKey`, which is the
// identifier of the operation itself, so every card the panel handed back said
// its own name was [protected] and a reader could not tell what they were being
// asked to approve. The exemption is for the identifier only: everything the
// broad rule was there to catch still has to be caught.
function testTheOperationsNameIsNotTreatedAsASecret() {
  const action = {
    id: 'act_1',
    kind: 'server_ops.mail.mailbox.delete',
    actionKey: 'mail.mailbox.delete',
    label: 'Delete a mailbox',
    call: {
      capability: 'mail.mailbox.delete',
      params: {
        domain: 'example.com',
        account: 'sales',
        password: 'tops3cret',
        apiKey: 'ak_live_1',
        key: 'ssh-ed25519 AAAAC3Nza',
        credential: 'smtps://user:pw@mail.example.com:465',
      },
    },
  };
  const shown = redact(action);

  assert.equal(shown.actionKey, 'mail.mailbox.delete', 'the reader can see which operation this is');
  assert.equal(shown.kind, 'server_ops.mail.mailbox.delete');
  assert.equal(shown.label, 'Delete a mailbox');
  assert.equal(shown.call.params.domain, 'example.com', 'and what it acts on');

  // The exemption is exactly one name wide.
  assert.equal(shown.call.params.password, '[protected]');
  assert.equal(shown.call.params.apiKey, '[protected]');
  assert.equal(shown.call.params.key, '[protected]', 'a bare key is still a key');
  assert.equal(shown.call.params.credential, '[protected]');
  assert.ok(!JSON.stringify(shown).includes('tops3cret'));
  assert.ok(!JSON.stringify(shown).includes('ssh-ed25519'));

  // The check that a body came out clean has to agree with the redactor, or the
  // scrub tooling would count an identifier as an unspent secret for ever.
  assert.equal(holdsSecret({ actionKey: 'mail.mailbox.delete' }), false);
  assert.equal(holdsSecret({ actionKey: 'mail.mailbox.delete', password: 'x' }), true);
  assert.equal(holdsSecret({ key: 'ssh-ed25519 AAAAC3Nza' }), true);

  // Nothing that merely contains the word is exempt: the rule is an exact name.
  assert.equal(redact({ actionKeyring: 'k' }).actionKeyring, '[protected]');
  assert.equal(SECRET_PARAM.test('actionKey'), true, 'the broad rule itself is unchanged');
}

function testZipRoundTripAndSafety() {
  const zip = createZip([{ name: 'manifest.json', data: Buffer.from('{"ok":true}') }, { name: 'files/hello.txt', data: Buffer.from('hello') }]);
  const entries = readZip(zip);
  assert.equal(entries.get('files/hello.txt').toString(), 'hello');
  assert.throws(() => createZip([{ name: '../outside', data: Buffer.from('bad') }]), /escapes/);
}

function testPortableExportVerifiesItself() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-portability-test-'));
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(path.join(uploads, 'owner'), { recursive: true });
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,email TEXT,password TEXT,plan TEXT,subdomain TEXT,storage_gb INTEGER,created_at TEXT);
    CREATE TABLE files (id TEXT PRIMARY KEY,user_id TEXT,name TEXT,size INTEGER,mime TEXT,folder TEXT,disk_path TEXT,added_at TEXT);
    CREATE TABLE sites (id TEXT PRIMARY KEY,user_id TEXT,name TEXT,domain TEXT,status TEXT,echo_context TEXT,created_at TEXT,updated_at TEXT);
  `);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)').run('owner', 'Owner', 'owner@example.test', 'hash', 'owner', null, 10, new Date().toISOString());
  const filePath = path.join(uploads, 'owner', 'hello.txt');
  fs.writeFileSync(filePath, 'portable');
  db.prepare('INSERT INTO files VALUES (?,?,?,?,?,?,?,?)').run('f1', 'owner', 'hello.txt', 8, 'text/plain', 'root', filePath, new Date().toISOString());
  const store = createActionStore({ db });
  const service = createPortabilityService({
    db, actionStore: store, uploadsDir: uploads, importsDir: path.join(root, 'imports'),
    decryptDeploy: x => x, encryptDeploy: x => x, decryptMail: x => x, encryptMail: x => x,
  });
  const proposal = service.proposeExport('owner');
  store.approve(proposal.id, { approvedBy: 'owner' });
  const built = service.executeExport(proposal.id, 'owner', 'a-correct-horse-passphrase');
  assert.equal(built.report.verified, true);
  assert.equal(built.manifest.counts.files, 1);
  const packagePath = path.join(root, 'account.zip');
  fs.writeFileSync(packagePath, built.buffer);
  const inspected = service.inspectArchive(packagePath);
  assert.equal(inspected.source, 'jotpanel');
  assert.equal(inspected.counts.files, 1);
  const entries = readZip(built.buffer);
  assert.throws(() => openWithPassphrase(entries.get('account/secrets.enc'), 'wrong-passphrase-000'), /wrong|damaged/);

  const legacyManifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  legacyManifest.format = 'arca-account';
  const legacyPath = path.join(root, 'legacy-account.zip');
  fs.writeFileSync(legacyPath, createZip([...entries].map(([name, data]) => ({
    name,
    data: name === 'manifest.json' ? Buffer.from(JSON.stringify(legacyManifest)) : data,
  }))));
  assert.equal(service.inspectArchive(legacyPath).source, 'arca', 'pre-rename account packages remain readable');

  // The founding promise is the round trip, not just ZIP creation. Change the
  // live account, then restore the approved package and verify both the row and
  // the bytes that came back under a freshly mapped id.
  db.prepare('UPDATE files SET name=? WHERE id=?').run('changed.txt', 'f1');
  fs.writeFileSync(filePath, 'changed');
  const restore = service.acceptImportUpload('owner', packagePath, 'account.zip');
  store.approve(restore.action.id, { approvedBy: 'owner', confirmText: 'RESTORE' });
  const report = service.executeRestore(restore.action.id, 'owner', 'a-correct-horse-passphrase');
  assert.equal(report.ok, true);
  assert.equal(report.verified, true);
  assert.deepEqual(report.failures, []);
  assert.equal(report.restored.files, 1);
  const restored = db.prepare('SELECT * FROM files WHERE user_id=?').get('owner');
  assert.equal(restored.name, 'hello.txt');
  assert.equal(fs.readFileSync(restored.disk_path, 'utf8'), 'portable');
  assert.equal(store.get(restore.action.id).status, 'executed');
  fs.rmSync(root, { recursive: true, force: true });
}

async function testScheduledJobNoteAndRunRecord() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT)');
  const store = createActionStore({ db });
  const jobs = createScheduledJobsService({ db, actionStore: store, jobRoot: os.tmpdir() });
  const proposal = jobs.propose('owner', { operation: 'create', name: 'Clear cache', note: 'Safe cache only; no customer files', schedule: '0 3 * * *', command: 'printf cache-ok' });
  store.approve(proposal.id, { approvedBy: 'owner' });
  const created = await jobs.execute(proposal.id, 'owner');
  assert.equal(created.executionResult.verified, true);
  const row = jobs.list('owner')[0];
  assert.equal(row.note, 'Safe cache only; no customer files');
  const runProposal = jobs.propose('owner', { operation: 'run', id: row.id });
  store.approve(runProposal.id, { approvedBy: 'owner' });
  await jobs.execute(runProposal.id, 'owner');
  assert.equal(jobs.history('owner', row.id)[0].status, 'succeeded');
  assert.match(jobs.history('owner', row.id)[0].output, /cache-ok/);
  assert.equal(cronMatches('0 3 * * *', new Date(2026, 7, 13, 3, 0, 0)), true);
}

function testUsageSeparatesPlatformAndCustomerKey() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,email TEXT,plan TEXT,storage_gb INTEGER,created_at TEXT,suspended INTEGER);
    CREATE TABLE files (user_id TEXT,size INTEGER);
    CREATE TABLE pub_files (user_id TEXT,size INTEGER);
    CREATE TABLE sites (id TEXT PRIMARY KEY,user_id TEXT);
    CREATE TABLE site_files (site_id TEXT,content TEXT);
    CREATE TABLE ai_usage (user_id TEXT,ts TEXT,in_tok INTEGER,out_tok INTEGER,cost REAL,byok INTEGER);
  `);
  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('owner', 'Owner', 'o@example.test', 'owner', 1, '2026-08-01T00:00:00.000Z', 0);
  db.prepare('INSERT INTO files VALUES (?,?)').run('owner', 1000);
  db.prepare('INSERT INTO ai_usage VALUES (?,?,?,?,?,?)').run('owner', '2026-08-13T00:00:00.000Z', 100, 50, 0.01, 0);
  db.prepare('INSERT INTO ai_usage VALUES (?,?,?,?,?,?)').run('owner', '2026-08-13T00:00:00.000Z', 200, 100, 0.02, 1);
  const usage = createUsageService({ db, now: () => new Date('2026-08-14T00:00:00.000Z') });
  const report = usage.reportForAccount('owner', { period: '2026-08' });
  assert.equal(report.assistant.platform.cost_usd, 0.01);
  assert.equal(report.assistant.customer_key.provider_cost_usd, 0.02);
  assert.equal(report.assistant.customer_key.billable_by_arca, false);
  assert.equal(report.storage.end_bytes, 1000);
  assert.equal(report.period.to, '2026-08-14T00:00:00.000Z');
  assert.equal(report.account_state.live_seconds, 13 * 86400);
  assert.equal(report.account_state.inactive_seconds, 0);

  db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('new-owner', 'New Owner', 'n@example.test', 'owner', 1, '2026-08-13T00:00:00.000Z', 0);
  db.prepare('INSERT INTO account_lifecycle (id,user_id,event,reason,ts) VALUES (?,?,?,?,?)')
    .run('new-created', 'new-owner', 'created', 'test account created', '2026-08-13T00:00:00.000Z');
  const newReport = usage.reportForAccount('new-owner', { period: '2026-08' });
  assert.equal(newReport.account_state.inactive_seconds, 12 * 86400);
  assert.equal(newReport.account_state.live_seconds, 86400);
}

function testStatisticsAvoidRawIps() {
  const db = new Database(':memory:');
  const stats = createStatisticsService({ db, secret: 'test-secret', now: () => new Date('2026-08-13T12:00:00.000Z') });
  stats.record({ userId: 'owner', siteId: 'site-main', siteName: 'main', requestPath: '/', referrer: 'https://search.example/result', userAgent: 'Mozilla/5.0 iPhone Mobile', ip: '203.0.113.77' });
  const raw = db.prepare('SELECT * FROM web_events').get();
  assert.equal(Object.prototype.hasOwnProperty.call(raw, 'ip'), false);
  assert.notEqual(raw.visitor_hash, '203.0.113.77');
  const report = stats.report('owner', { days: 7 });
  assert.equal(report.totals.pageviews, 1);
  assert.equal(report.totals.sites, 1);
  assert.equal(report.sites[0].id, 'site-main');
  assert.equal(report.devices[0].device, 'Mobile');
}

function testForeignDetection() {
  assert.equal(detectForeignSource(new Map([['backup/homedir/public_html/index.html', Buffer.from('x')]])), 'cpanel');
  assert.equal(detectForeignSource(new Map([['domains/example.test/public_html/index.html', Buffer.from('x')]])), 'directadmin');
  const plesk = new Map([['dump.xml', Buffer.from('<x/>')], ['httpdocs/index.html', Buffer.from('x')]]);
  assert.equal(detectForeignSource(plesk), 'plesk');
  assert.equal(foreignInventory(plesk, 'plesk').counts.webFiles, 1);
}

function testLocalEngineListenerDetection() {
  const rows = parseListeners('LISTEN 0 4096 127.0.0.1:11434 0.0.0.0:*\nLISTEN 0 4096 0.0.0.0:11434 0.0.0.0:*\n', 11434);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].exposed, false);
  assert.equal(rows[1].exposed, true);
}

run().catch(error => { console.error(error); process.exit(1); });
