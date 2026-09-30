'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createBackupHealthStore, createBackupHealthBackend } = require('./backupHealth');
const { createActionStore } = require('./actionStore');
const { createOwnershipService } = require('./ownership');
const { createServerOpsService } = require('./serverOps');
const { createOpsEngine } = require('./ops/engine');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT,email TEXT,created_at TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY,name TEXT,created_at TEXT);
    CREATE TABLE memberships (identity_id TEXT PRIMARY KEY,org_id TEXT,role TEXT,created_at TEXT);
    CREATE TABLE provisioning_accounts (user_id TEXT PRIMARY KEY,primary_domain TEXT);
  `);
  for (const name of ['failed', 'overdue', 'never', 'running', 'healthy']) {
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(`user-${name}`, title(name), `${name}@example.test`, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO organizations VALUES (?,?,?)').run(`org-${name}`, title(name), '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO memberships VALUES (?,?,?,?)').run(`user-${name}`, `org-${name}`, 'end_user', '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO provisioning_accounts VALUES (?,?)').run(`user-${name}`, `${name}.example.test`);
  }
  let clock = new Date('2026-08-25T12:00:00.000Z');
  const store = createBackupHealthStore({ db, now: () => clock });
  return { db, store, setClock: value => { clock = new Date(value); } };
}

function truth(runId, domain, at, status = 'succeeded', failure = null) {
  return {
    run_id: runId,
    domain,
    trigger: 'manual',
    status,
    stage: status === 'succeeded' ? 'local_verify' : 'database',
    started_at: at,
    finished_at: new Date(Date.parse(at) + 60000).toISOString(),
    source_observed_at: at,
    verified_at: status === 'succeeded' ? new Date(Date.parse(at) + 60000).toISOString() : null,
    bytes_total: status === 'succeeded' ? 4096 : 0,
    failure_code: failure?.code || null,
    failure_summary: failure?.summary || null,
    requested_components: ['files'],
    components: status === 'succeeded' ? [{ component: 'files', status: 'verified', artifact_count: 1, bytes: 4096 }] : [],
    artifacts: status === 'succeeded' ? [{ id: 'files-1', component: 'files', bytes: 4096, sha256: 'abc', created_at: at, state: 'verified' }] : [],
    events: [{ key: 'worker-start', event_type: 'component_started', stage: 'files', status: 'running', occurred_at: at }],
  };
}

function complete(store, account, runId, at) {
  store.completeRun({
    identityId: `user-${account}`,
    operationRecordId: `act-${runId}`,
    truth: truth(runId, `${account}.example.test`, at),
  });
}

function testEventsAreAppendOnlyAndCanRebuildEveryProjection() {
  const { db, store } = fixture();
  complete(store, 'healthy', 'run-healthy', '2026-08-25T11:00:00.000Z');
  assert.throws(() => db.prepare("UPDATE backup_run_events SET status='failed'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM backup_run_events').run(), /append-only/);

  db.prepare('DELETE FROM backup_runs').run();
  const rebuilt = store.rebuildRuns();
  assert.equal(rebuilt.runs, 1);
  const run = store.getRun('run-healthy');
  assert.equal(run.status, 'succeeded');
  assert.equal(run.bytes_total, 4096);
  assert.equal(run.components[0].component, 'files');
}

function testAFailedAttemptDoesNotEraseTheLastVerifiedRecoveryPoint() {
  const { store } = fixture();
  complete(store, 'failed', 'run-good', '2026-08-25T08:00:00.000Z');
  store.failRun({
    identityId: 'user-failed', operationRecordId: 'act-bad', runId: 'run-bad',
    domain: 'failed.example.test', error: 'dump failed at /private/database.sql',
    failureCode: 'DATABASE_OBJECT_SET_MISMATCH',
    truth: truth('run-bad', 'failed.example.test', '2026-08-25T10:00:00.000Z', 'failed', {
      code: 'DATABASE_OBJECT_SET_MISMATCH', summary: '22 of 80 tables were captured at /private/database.sql',
    }),
  });
  const row = store.listHealth().find(item => item.account_id === 'org-failed');
  assert.equal(row.status, 'failed');
  assert.equal(row.last_attempt_run_id, 'run-bad');
  assert.equal(row.last_verified_run_id, 'run-good', 'the failed latest attempt must leave the known recovery point visible');
  assert.doesNotMatch(row.failure_summary, /private|database\.sql/, 'operator summaries do not expose worker paths');
}

function testTheGridHasFiveDistinctStatesAndFailuresComeFirst() {
  const { store, setClock, db } = fixture();
  complete(store, 'healthy', 'run-healthy', '2026-08-25T11:00:00.000Z');

  complete(store, 'failed', 'run-failed-good', '2026-08-25T08:00:00.000Z');
  store.failRun({
    identityId: 'user-failed', operationRecordId: 'act-failed', runId: 'run-failed',
    domain: 'failed.example.test', error: 'database object mismatch', failureCode: 'DATABASE_OBJECT_SET_MISMATCH',
    truth: truth('run-failed', 'failed.example.test', '2026-08-25T10:00:00.000Z', 'failed', {
      code: 'DATABASE_OBJECT_SET_MISMATCH', summary: 'database object mismatch',
    }),
  });
  store.completeRun({
    identityId: 'user-failed', operationRecordId: 'act-other-domain',
    truth: truth('run-other-domain', 'another.example.test', '2026-08-25T11:00:00.000Z'),
  });

  setClock('2026-08-20T00:00:00.000Z');
  store.recordPolicyAction({
    identityId: 'user-overdue', operation: 'backup.schedule.set',
    params: { domain: 'overdue.example.test', when: 'daily', parts: ['files'], keep: 7 },
    result: { set_at: '2026-08-20T00:00:00.000Z', armed: true },
  });
  setClock('2026-08-25T12:00:00.000Z');

  store.startRun({
    runId: 'run-running', identityId: 'user-running', domain: 'running.example.test',
    operationRecordId: 'act-running', trigger: 'manual', requestedComponents: ['files'],
  });

  const rows = store.listHealth();
  assert.deepEqual(rows.map(row => row.status), ['failed', 'overdue', 'never_backed_up', 'running', 'healthy']);
  assert.match(rows.find(row => row.status === 'healthy').status_label, /^Healthy, verified/);
  assert.match(rows.find(row => row.status === 'failed').status_label, /^Failed,/);
  assert.equal(rows.find(row => row.account_id === 'org-failed').failure_code, 'DATABASE_OBJECT_SET_MISMATCH',
    'a newer healthy run for another domain must not hide the account domain that is still broken');
  assert.match(rows.find(row => row.status === 'running').status_label, /^Running,/);
  assert.equal(new Set(rows.map(row => row.status)).size, 5, 'a green tick cannot collapse the operator states');

  const version = db.prepare('SELECT id FROM backup_policy_versions LIMIT 1').get();
  assert.throws(() => db.prepare('UPDATE backup_policy_versions SET retention_count=1 WHERE id=?').run(version.id), /immutable/);
}

async function testTheOperationPathRecordsRunningSuccessAndFailure() {
  const { db, store } = fixture();
  const actionStore = createActionStore({ db });
  const ownership = createOwnershipService({ db });
  db.prepare("UPDATE memberships SET role='hosting_company' WHERE identity_id='user-failed'").run();
  ownership.claim('site', 'healthy.example.test', 'org-healthy', 'user-healthy');
  let fail = false;
  const engine = createOpsEngine({
    backends: [{
      name: 'backup-fixture',
      capabilities: async () => ({
        capabilities: new Map([['backup.create', {
          id: 'backup.create', kind: 'write', backend: 'backup-fixture',
          run: async params => {
            const running = store.listHealth().find(row => row.account_id === 'org-healthy');
            assert.equal(running.status, 'running', 'the account changes before the privileged call returns');
            const evidence = truth(params.runId, params.domain, fail ? '2026-08-25T11:45:00.000Z' : '2026-08-25T11:30:00.000Z', fail ? 'failed' : 'succeeded',
              fail ? { code: 'ARTIFACT_EMPTY', summary: 'the archive is empty' } : null);
            if (fail) {
              const error = new Error('the archive is empty');
              error.code = 'ARTIFACT_EMPTY';
              error.backupRun = evidence;
              throw error;
            }
            return { verified: true, bytes_total: 4096, run_truth: evidence };
          },
        }]]),
        missing: new Map(), state: {},
      }),
    }, createBackupHealthBackend({ store })],
  });
  const service = createServerOpsService({ engine, actionStore, ownership, backupHealth: store, log: () => {} });

  const proposal = await service.propose('user-failed', 'backup.create', {
    domain: 'healthy.example.test', parts: ['files'], keep: 7,
  });
  actionStore.approve(proposal.id, { approvedBy: 'user-failed' });
  const executed = await service.execute(proposal.id, 'user-failed');
  const runId = executed.executionResult.run_id || store.listHealth().find(row => row.account_id === 'org-healthy').last_attempt_run_id;
  const recorded = store.getRun(runId);
  assert.equal(recorded.status, 'succeeded');
  assert.equal(recorded.operation_record_id, proposal.id);
  assert.equal(executed.executionResult.run_truth, undefined, 'the action does not keep a second copy of the run evidence');

  fail = true;
  const broken = await service.propose('user-failed', 'backup.create', {
    domain: 'healthy.example.test', parts: ['files'], keep: 7,
  });
  actionStore.approve(broken.id, { approvedBy: 'user-failed' });
  await assert.rejects(() => service.execute(broken.id, 'user-failed'), /archive is empty/);
  const row = store.listHealth().find(item => item.account_id === 'org-healthy');
  assert.equal(row.status, 'failed');
  assert.equal(row.failure_code, 'ARTIFACT_EMPTY');
  assert.equal(actionStore.get(broken.id).status, 'failed');
  assert.equal(ownership.resolveOwner('backup', 'healthy.example.test').orgId, 'org-healthy',
    'the hoster pressed the button and the customer still owns the recovery point');
  const reading = await service.read('backup-health', {}, { accountId: 'user-failed' });
  assert.equal(reading.health.find(item => item.account_id === 'org-healthy').status, 'failed');
  await assert.rejects(() => service.read('backup-health', {}, { accountId: 'user-healthy' }), /reserved to the account that runs this box/,
    'the central account grid is a hoster reading, not another customer list');
}

// ── Offsite is part of whether a backup is real ──────────────────
//
// The defect these cover: an account whose local archive verified and whose
// offsite copy never arrived read as healthy, because the health record had no
// concept of an offsite copy at all. Every one of these was made to fail before
// it was kept.

// A partial run's local half is a clean local run: the archive was made,
// verified, and has real bytes. Only the copy that was meant to leave the
// machine is missing, so the body is built as a success and the status is the
// one thing overridden.
function offsiteTruth(runId, domain, at, offsite, status = 'succeeded') {
  return { ...truth(runId, domain, at, 'succeeded'), status, offsite };
}

function testLocalOnlyBackupWithNoDestinationIsHealthy() {
  const { store } = fixture();
  store.completeRun({
    identityId: 'user-healthy', operationRecordId: 'act-1',
    truth: truth('run-local-only', 'healthy.example.test', '2026-08-25T11:00:00.000Z'),
  });
  const row = store.listHealth().find(item => item.account_id === 'org-healthy');
  assert.equal(row.status, 'healthy', 'a backup with no destination configured is not failing at anything');
  assert.equal(row.offsite_state, 'not_configured', 'nothing may claim a copy it never tried to make');
  assert.match(row.status_label, /^Healthy/);
}

function testLocalAndRemoteBothSucceedReadsHealthyAndSaysWhereTheCopyIs() {
  const { store } = fixture();
  store.completeRun({
    identityId: 'user-healthy', operationRecordId: 'act-2',
    truth: offsiteTruth('run-both', 'healthy.example.test', '2026-08-25T11:00:00.000Z', {
      state: 'succeeded', destination: 'backups@offsite.example:22/backups',
      verified_at: '2026-08-25T11:02:00.000Z', parts_stored: 2, parts_expected: 2,
    }),
  });
  const row = store.listHealth().find(item => item.account_id === 'org-healthy');
  assert.equal(row.status, 'healthy');
  assert.equal(row.offsite_state, 'succeeded');
  assert.equal(row.last_offsite_verified_at, '2026-08-25T11:02:00.000Z');
}

function testRemoteFailureCannotReadAsHealthyAndKeepsTheLocalRecoveryPoint() {
  const { db, store } = fixture();
  store.completeRun({
    identityId: 'user-healthy', operationRecordId: 'act-3',
    truth: offsiteTruth('run-partial', 'healthy.example.test', '2026-08-25T11:00:00.000Z', {
      state: 'failed', destination: 'backups@offsite.example:22/backups',
      summary: '1 of 2 parts reached the destination. mail: connection refused',
      parts_stored: 1, parts_expected: 2,
    }, 'partial'),
  });
  const row = store.listHealth().find(item => item.account_id === 'org-healthy');

  // The defect, stated as an assertion.
  assert.notEqual(row.status, 'healthy', 'a backup with no offsite copy must never read as healthy');
  assert.equal(row.status, 'offsite_failed');
  assert.equal(row.offsite_state, 'failed');

  // And the half that did work is still true and still usable, because telling
  // somebody to go and make a backup they already have is its own failure.
  assert.ok(row.last_verified_at, 'the verified local artifact is still a recovery point');
  assert.equal(row.bytes_total, 4096, 'the local archive still counts its bytes');
  assert.match(row.status_label, /local copy verified/,
    'the label has to say the local copy is good or the operator cannot triage it');
  assert.match(row.status_label, /connection refused/, 'and it has to say what actually went wrong');

  const run = db.prepare('SELECT * FROM backup_runs WHERE id=?').get('run-partial');
  assert.equal(run.status, 'partial', 'not failed: there is a verified archive on this machine');
  assert.equal(run.offsite_parts_stored, 1);
  assert.equal(run.offsite_parts_expected, 2);
}

function testLocalVerificationFailureIsStillAPlainFailure() {
  const { store } = fixture();
  store.failRun({
    identityId: 'user-healthy', operationRecordId: 'act-4', runId: 'run-badlocal',
    domain: 'healthy.example.test', trigger: 'manual',
    error: new Error('the archive is empty'), failureCode: 'ARTIFACT_EMPTY',
  });
  const row = store.listHealth().find(item => item.account_id === 'org-healthy');
  assert.equal(row.status, 'failed', 'a local verification failure is a failed backup, not an offsite problem');
  assert.equal(row.failure_code, 'ARTIFACT_EMPTY');
}

function testAGoodRunAfterAnOffsiteFailureClearsIt() {
  const { store } = fixture();
  store.completeRun({
    identityId: 'user-healthy', operationRecordId: 'act-5',
    truth: offsiteTruth('run-bad', 'healthy.example.test', '2026-08-25T10:00:00.000Z', {
      state: 'failed', destination: 'x', summary: 'refused', parts_stored: 0, parts_expected: 1,
    }, 'partial'),
  });
  assert.equal(store.listHealth().find(item => item.account_id === 'org-healthy').status, 'offsite_failed');
  store.completeRun({
    identityId: 'user-healthy', operationRecordId: 'act-6',
    truth: offsiteTruth('run-good', 'healthy.example.test', '2026-08-25T11:00:00.000Z', {
      state: 'succeeded', destination: 'x', verified_at: '2026-08-25T11:01:00.000Z', parts_stored: 1, parts_expected: 1,
    }),
  });
  const row = store.listHealth().find(item => item.account_id === 'org-healthy');
  assert.equal(row.status, 'healthy', 'a later run that did reach the destination closes it');
  assert.equal(row.offsite_state, 'succeeded');
}

function testAnUnknownOffsiteStateIsNeverInvented() {
  const { db, store } = fixture();
  store.completeRun({
    identityId: 'user-healthy', operationRecordId: 'act-7',
    truth: offsiteTruth('run-junk', 'healthy.example.test', '2026-08-25T11:00:00.000Z', { state: 'probably fine' }),
  });
  const run = db.prepare('SELECT offsite_state FROM backup_runs WHERE id=?').get('run-junk');
  assert.equal(run.offsite_state, 'not_configured', 'a state this does not recognise is not a state');
}

function title(value) { return value[0].toUpperCase() + value.slice(1); }

async function run() {
  for (const test of [
    testEventsAreAppendOnlyAndCanRebuildEveryProjection,
    testAFailedAttemptDoesNotEraseTheLastVerifiedRecoveryPoint,
    testTheGridHasFiveDistinctStatesAndFailuresComeFirst,
    testTheOperationPathRecordsRunningSuccessAndFailure,
    testLocalOnlyBackupWithNoDestinationIsHealthy,
    testLocalAndRemoteBothSucceedReadsHealthyAndSaysWhereTheCopyIs,
    testRemoteFailureCannotReadAsHealthyAndKeepsTheLocalRecoveryPoint,
    testLocalVerificationFailureIsStillAPlainFailure,
    testAGoodRunAfterAnOffsiteFailureClearsIt,
    testAnUnknownOffsiteStateIsNeverInvented,
  ]) {
    await test();
    console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`);
  }
  console.log('backup health tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });

// ── Incidents: an operator has to be told, once ──────────────────
{
  const t = fixture();
  const fail = stage => t.store.recordFailure({
    accountId: 'org-healthy', accountName: 'Healthy', domain: 'healthy.example.test',
    stage, failureCode: stage === 'offsite' ? 'OFFSITE_TRANSFER_FAILED' : 'ARTIFACT_EMPTY',
    failureSummary: 'connection refused', runId: `r-${stage}`,
  });

  const first = fail('offsite');
  assert.equal(first.notify, true, 'the first failure always speaks');
  t.store.markNotified(first.incident.id);

  const second = fail('offsite');
  assert.equal(second.notify, false, 'the same failure again does not send a second message');
  assert.equal(second.incident.occurrences, 2);

  const third = fail('offsite');
  assert.equal(third.notify, true, 'the third consecutive failure speaks again');
  t.store.markNotified(third.incident.id);
  assert.equal(fail('offsite').notify, false, 'and then it goes quiet again');

  // A different failure on the same account is a different problem needing a
  // different action, so it is its own incident and speaks straight away.
  const other = fail('backup');
  assert.equal(other.notify, true, 'a different failure is a different incident');
  assert.notEqual(other.incident.id, first.incident.id);
  assert.equal(t.store.listIncidents({ state: 'open' }).length, 2);

  // A success closes them, and says so once because somebody was told.
  const recovered = t.store.recordSuccess({ accountId: 'org-healthy', domain: 'healthy.example.test', runId: 'r-good' });
  assert.equal(recovered.closed.length, 2);
  assert.equal(recovered.notify, true);
  assert.equal(t.store.listIncidents({ state: 'open' }).length, 0);

  // An incident nobody was ever told about closes silently: announcing the end
  // of a problem nobody heard about is noise.
  const quiet = fixture();
  quiet.store.recordFailure({ accountId: 'org-healthy', accountName: 'Healthy', domain: 'healthy.example.test', stage: 'offsite', failureCode: 'X', failureSummary: 'x', runId: 'r1' });
  assert.equal(quiet.store.recordSuccess({ accountId: 'org-healthy', domain: 'healthy.example.test', runId: 'r2' }).notify, false);

  console.log('  ok  incidents open once, repeat rarely, split by cause, and close on recovery');
}

// A local-only schedule that works is not an incident and must never speak.
{
  const t = fixture();
  const quiet = t.store.recordSuccess({ accountId: 'org-healthy', domain: 'healthy.example.test', runId: 'r-clean' });
  assert.equal(quiet.notify, false);
  assert.equal(t.store.listIncidents({ state: 'all' }).length, 0,
    'a backup that worked, with no destination configured, raises nothing at all');
  console.log('  ok  a successful local-only backup raises nothing');
}
