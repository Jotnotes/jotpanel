'use strict';

// The interrupted-action pass. Every test here is the same shape: a panel
// process claims an action, dies without finishing it, and a second process
// starts up and has to say something true about what happened.

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createActionStore } = require('../actionStore');
const { createReconciler, oneshotInstanceFor } = require('./reconcile');
const { runPrivilegedOneshot } = require('./privilegedJobs');

async function run() {
  testTheStoreCanTellInterruptedFromMerelyApproved();
  testAnUpgradedTableGainsTheNewColumns();
  testOnlyOneshotBackedActionsHaveSomewhereToLook();
  await testACompletedUpdateIsRecordedAsExecuted();
  await testAFailedOneshotIsRecordedAsFailed();
  await testAStaleResultFileIsNotMistakenForThisRun();
  await testAnActionWithNothingDurableIsInterruptedNotFailed();
  await testAStillRunningOneshotIsAdoptedAndFinishedLater();
  await testAnAdoptedOneshotThatDiesIsInterrupted();
  await testAnUnreachableServiceIsRecordedAsNotObserved();
  await testThisProcessOwnActionsAreLeftAlone();
  await testLosingDbusMidUpgradeIsNotAFailedUpdate();
  await testAOneshotThatReallyDidNotStartStillFails();
  await testAWatcherSettledSuccessReachesTheAccountAuditTrail();
  await testTheSettledEndingIsAuditedExactlyOnce();
  await testAWatcherSettledFailureAndInterruptionAreAuditedToo();
  console.log('interrupted-action tests passed');
}

// ── Fixtures ───────────────────────────────────────────────────────
function store() {
  return createActionStore({ db: new Database(':memory:') });
}

function claimed(actionStore, { kind = 'server_ops.packages.apply', params = { securityOnly: true }, runId = 'dead-process' } = {}) {
  const action = actionStore.enqueue({
    accountId: 'owner', kind, label: 'Install the waiting security updates',
    call: { api: 'jotpanel-ops', capability: 'packages.apply', params },
  });
  actionStore.approve(action.id, { approvedBy: 'owner' });
  return actionStore.markExecuting(action.id, { runId });
}

// A hand-driven clock, so a watch that would take forty-five minutes on a real
// box takes none here.
function timers() {
  const queue = [];
  return {
    setTimer: fn => queue.push(fn),
    async drain(times = 1) {
      for (let i = 0; i < times; i += 1) {
        const next = queue.shift();
        if (!next) return;
        await next();
      }
    },
    get pending() { return queue.length; },
  };
}

// ── The state itself ───────────────────────────────────────────────
function testTheStoreCanTellInterruptedFromMerelyApproved() {
  const actionStore = store();
  const waiting = actionStore.enqueue({ accountId: 'owner', kind: 'server_ops.service.restart', label: 'Restart nginx', call: { params: {} } });
  actionStore.approve(waiting.id, { approvedBy: 'owner' });
  const running = claimed(actionStore);

  assert.equal(actionStore.get(waiting.id).status, 'approved');
  assert.equal(actionStore.get(running.id).status, 'executing');
  assert.ok(running.startedAt, 'a claimed action records when it started');
  assert.equal(running.runId, 'dead-process');

  // Only the claimed one is a candidate, which is the entire point of the
  // extra state: an approved row may simply be waiting for the owner to run it.
  const stale = actionStore.listExecuting({ exceptRunId: 'this-process' });
  assert.deepEqual(stale.map(a => a.id), [running.id]);

  // And an interrupted action is terminal: it cannot be quietly re-executed.
  actionStore.markInterrupted(running.id, { reason: 'the panel stopped' });
  assert.equal(actionStore.get(running.id).status, 'interrupted');
  assert.match(actionStore.get(running.id).interruptionReason, /the panel stopped/);
  assert.ok(actionStore.get(running.id).interruptedAt);
  assert.equal(actionStore.get(running.id).error, null, 'interrupted is not failed and must not carry an error');
  assert.throws(() => actionStore.markExecuted(running.id, { verified: true }), /must be approved/);
}

function testAnUpgradedTableGainsTheNewColumns() {
  // A panel installed before this existed has the table without the columns,
  // and CREATE TABLE IF NOT EXISTS will not add them.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE control_actions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'standard', status TEXT NOT NULL DEFAULT 'pending',
    protected_body TEXT NOT NULL, created_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT,
    rejected_at TEXT, rejected_by TEXT, rejected_reason TEXT, executed_at TEXT, failed_at TEXT, error TEXT)`);
  db.prepare('INSERT INTO control_actions (id,user_id,kind,label,risk_level,status,protected_body,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('act_old', 'owner', 'server_ops.service.restart', 'Restart nginx', 'standard', 'approved',
      JSON.stringify({ id: 'act_old', label: 'Restart nginx' }), '2026-08-01T00:00:00.000Z');

  const actionStore = createActionStore({ db });
  const columns = new Set(db.prepare('PRAGMA table_info(control_actions)').all().map(r => r.name));
  for (const name of ['started_at', 'run_id', 'interrupted_at']) assert.ok(columns.has(name), `${name} was not added`);
  assert.equal(actionStore.get('act_old').status, 'approved', 'the existing history survives the migration');
  assert.equal(actionStore.get('act_old').startedAt, null);
}

// ── Where the answer comes from ────────────────────────────────────
function testOnlyOneshotBackedActionsHaveSomewhereToLook() {
  assert.equal(oneshotInstanceFor({ kind: 'server_ops.packages.apply', call: { params: { securityOnly: true } } }), 'packages-security');
  assert.equal(oneshotInstanceFor({ kind: 'server_ops.packages.apply', call: { params: { securityOnly: false } } }), 'packages-all');
  assert.equal(oneshotInstanceFor({ kind: 'server_ops.stack.install.mail', call: { params: { stack: 'mail' } } }), 'stack-mail');
  assert.equal(oneshotInstanceFor({ kind: 'server_ops.stack.install.php', call: { params: { stack: 'php' } } }), 'stack-php');

  // Three lists have to agree or a stack is installable and unreconcilable, or
  // worse, askable and unrunnable. They have drifted before.
  const { ONESHOT_INSTANCES } = require('./privilegedJobs');
  const catalogued = require('./catalogue').OPERATIONS
    .filter(op => op.id.startsWith('stack.install.'))
    .map(op => `stack-${op.id.slice('stack.install.'.length)}`);
  for (const name of catalogued) assert.ok(ONESHOT_INSTANCES.includes(name), `${name} is offered but has no oneshot`);
  for (const name of ONESHOT_INSTANCES.filter(n => n.startsWith('stack-'))) {
    assert.ok(catalogued.includes(name), `${name} has a oneshot but is offered nowhere`);
  }
  assert.equal(oneshotInstanceFor({ kind: 'server_ops.service.restart', call: { params: { unit: 'nginx' } } }), null);
  assert.equal(oneshotInstanceFor({ kind: 'server_ops.system.reboot', call: { params: {} } }), null);
  assert.equal(oneshotInstanceFor({ kind: 'mail.create', call: {} }), null);
}

// ── The case that produced all of this ─────────────────────────────
async function testACompletedUpdateIsRecordedAsExecuted() {
  // needrestart restarted the panel in the middle of the panel's own update
  // run. The machine finished updating. The record said approved, never
  // executed. It must now say executed, from the file the unit left behind.
  const actionStore = store();
  const action = claimed(actionStore);
  const reconciler = createReconciler({
    actionStore,
    oneshotResult: async instance => ({
      instance, present: true, active: false, unit_state: 'inactive', ok: true,
      finished_at: new Date(Date.parse(action.startedAt) + 90_000).toISOString(),
      result: { installed: ['libc6', 'openssl'], remaining: 0, reboot_required: true, verified: true },
    }),
  });

  const summary = await reconciler.reconcile({ runId: 'live-process' });
  assert.deepEqual(summary, { checked: 1, executed: 1, failed: 0, interrupted: 0, watching: 0 });

  const record = actionStore.get(action.id);
  assert.equal(record.status, 'executed');
  assert.equal(record.executionResult.verified, true);
  assert.equal(record.executionResult.reconciled, true);
  assert.equal(record.executionResult.reconciled_from, 'oneshot-packages-security.json');
  assert.deepEqual(record.executionResult.installed, ['libc6', 'openssl']);
}

async function testAFailedOneshotIsRecordedAsFailed() {
  const actionStore = store();
  const action = claimed(actionStore, { kind: 'server_ops.stack.install.mail', params: { stack: 'mail' } });
  const reconciler = createReconciler({
    actionStore,
    oneshotResult: async instance => ({
      instance, present: true, active: false, unit_state: 'failed', ok: false,
      finished_at: new Date(Date.parse(action.startedAt) + 5_000).toISOString(),
      error: 'The mail stack did not install: dpkg was interrupted',
    }),
  });

  const summary = await reconciler.reconcile({ runId: 'live-process' });
  assert.equal(summary.failed, 1);
  const record = actionStore.get(action.id);
  assert.equal(record.status, 'failed');
  assert.match(record.error, /dpkg was interrupted/);
}

async function testAStaleResultFileIsNotMistakenForThisRun() {
  // A result written by an earlier run of the same job says nothing about this
  // one, and reading it as this one's outcome would be a confident lie.
  const actionStore = store();
  const action = claimed(actionStore);
  const reconciler = createReconciler({
    actionStore,
    oneshotResult: async instance => ({
      instance, present: true, active: false, unit_state: 'inactive', ok: true,
      finished_at: new Date(Date.parse(action.startedAt) - 3600_000).toISOString(),
      result: { installed: ['some-earlier-package'], verified: true },
    }),
  });

  await reconciler.reconcile({ runId: 'live-process' });
  const record = actionStore.get(action.id);
  assert.equal(record.status, 'interrupted');
  assert.equal(record.executionResult?.installed, undefined, 'an older run’s package list must not be attached to this action');
}

async function testAnActionWithNothingDurableIsInterruptedNotFailed() {
  const actionStore = store();
  const action = claimed(actionStore, { kind: 'server_ops.service.restart', params: { unit: 'nginx', verb: 'restart' } });
  let asked = 0;
  const reconciler = createReconciler({ actionStore, oneshotResult: async () => { asked += 1; return {}; } });

  const summary = await reconciler.reconcile({ runId: 'live-process' });
  assert.equal(summary.interrupted, 1);
  assert.equal(asked, 0, 'there is nowhere to look for a service restart, so nothing is asked');

  const record = actionStore.get(action.id);
  assert.equal(record.status, 'interrupted');
  assert.equal(record.error, null, 'recording it as failed would assert the restart did not happen');
  assert.match(record.interruptionReason, /was not observed/);
  assert.match(record.interruptionReason, /will not guess/);
}

// ── Still running, which is not the same as interrupted ────────────
async function testAStillRunningOneshotIsAdoptedAndFinishedLater() {
  // This is the real needrestart shape: the panel is restarted while the
  // privileged unit carries on updating. Nothing was interrupted except the
  // process watching, so the action is adopted rather than written off.
  const actionStore = store();
  const action = claimed(actionStore);
  const clock = timers();
  let finished = false;
  const reconciler = createReconciler({
    actionStore,
    setTimer: clock.setTimer,
    oneshotResult: async instance => (finished
      ? { instance, present: true, active: false, unit_state: 'inactive', ok: true, finished_at: new Date(Date.parse(action.startedAt) + 120_000).toISOString(), result: { installed: ['libc6'], verified: true } }
      : { instance, present: false, active: true, unit_state: 'active', ok: null, finished_at: null }),
  });

  const summary = await reconciler.reconcile({ runId: 'live-process' });
  assert.deepEqual(summary, { checked: 1, executed: 0, failed: 0, interrupted: 0, watching: 1 });
  assert.equal(actionStore.get(action.id).status, 'executing', 'work still in flight is still in flight');
  assert.equal(actionStore.get(action.id).runId, 'live-process', 'and this process now owns it');

  await clock.drain();
  assert.equal(actionStore.get(action.id).status, 'executing', 'still running, still nothing to say');

  finished = true;
  await clock.drain();
  const record = actionStore.get(action.id);
  assert.equal(record.status, 'executed');
  assert.deepEqual(record.executionResult.installed, ['libc6']);
}

async function testAnAdoptedOneshotThatDiesIsInterrupted() {
  const actionStore = store();
  const action = claimed(actionStore);
  const clock = timers();
  let alive = true;
  const reconciler = createReconciler({
    actionStore,
    setTimer: clock.setTimer,
    oneshotResult: async instance => ({ instance, present: false, active: alive, unit_state: alive ? 'active' : 'failed', ok: null, finished_at: null }),
  });

  await reconciler.reconcile({ runId: 'live-process' });
  alive = false;
  await clock.drain();

  const record = actionStore.get(action.id);
  assert.equal(record.status, 'interrupted');
  assert.match(record.interruptionReason, /no longer running and left no result/);
  assert.equal(record.executionResult.unit_state, 'failed');
}

async function testAnUnreachableServiceIsRecordedAsNotObserved() {
  const actionStore = store();
  const action = claimed(actionStore);
  const reconciler = createReconciler({
    actionStore,
    waitForService: async () => false,
    oneshotResult: async () => { throw new Error('should not be asked'); },
  });

  const summary = await reconciler.reconcile({ runId: 'live-process' });
  assert.equal(summary.interrupted, 1);
  assert.match(actionStore.get(action.id).interruptionReason, /did not come back/);
}

async function testThisProcessOwnActionsAreLeftAlone() {
  // An action this very process is executing right now must survive the pass,
  // or a slow update would reconcile itself into being interrupted.
  const actionStore = store();
  const mine = claimed(actionStore, { runId: 'live-process' });
  const theirs = claimed(actionStore, { runId: 'dead-process' });
  const reconciler = createReconciler({
    actionStore,
    oneshotResult: async instance => ({ instance, present: false, active: false, unit_state: 'inactive', ok: null, finished_at: null }),
  });

  const summary = await reconciler.reconcile({ runId: 'live-process' });
  assert.equal(summary.checked, 1);
  assert.equal(actionStore.get(mine.id).status, 'executing');
  assert.equal(actionStore.get(theirs.id).status, 'interrupted');
}

// ── The client is not the job ──────────────────────────────────────
async function testLosingDbusMidUpgradeIsNotAFailedUpdate() {
  // Watched on a real Ubuntu box: the security set upgraded systemd, D-Bus
  // restarted, `systemctl start` exited with "Warning! D-Bus connection
  // terminated", and the unit carried on for another thirty-five seconds and
  // installed all thirty-three packages. The panel recorded that as a failed
  // update. Recording a successful update as failed is worse than recording
  // nothing, so the unit is the authority and the file it writes is the answer.
  let ticks = 0;
  const result = await runPrivilegedOneshot('packages-security', 'The update run', {
    pollMs: 0,
    sleep: async () => {},
    remove: () => {},
    run: async (file, args) => {
      if (args[0] === 'start') return { ok: false, code: 1, stdout: '', stderr: 'Warning! D-Bus connection terminated.', error: 'Warning! D-Bus connection terminated.' };
      // Still working for three polls, then gone.
      ticks += 1;
      return { ok: true, stdout: ticks < 4 ? 'active\n' : 'inactive\n', stderr: '' };
    },
    // The file appears only once the unit has actually finished.
    exists: () => ticks >= 4,
    read: () => ({ ok: true, result: { installed: ['libc6', 'systemd'], remaining_security: 0, verified: true }, finished_at: '2026-08-17T09:14:33.201Z' }),
  });

  assert.deepEqual(result.installed, ['libc6', 'systemd']);
  assert.equal(result.verified, true);
  assert.ok(ticks >= 4, 'it has to keep asking the unit rather than trusting the client that died');
}

async function testAOneshotThatReallyDidNotStartStillFails() {
  // The other half: when the unit genuinely is not running and left nothing,
  // that is a failure and it still says why.
  await assert.rejects(() => runPrivilegedOneshot('packages-all', 'The update run', {
    pollMs: 0,
    sleep: async () => {},
    remove: () => {},
    run: async (file, args) => (args[0] === 'start'
      ? { ok: false, code: 5, stdout: '', stderr: 'Unit jotpanel-oneshot@packages-all.service not found.', error: 'not found' }
      : { ok: false, stdout: 'inactive\n', stderr: '' }),
    exists: () => false,
    read: () => null,
  }), /could not be started|not found/);
}

run().catch(error => { console.error(error); process.exit(1); });

// ── The owner's own trail ──────────────────────────────────────────
//
// The watcher settles an action with nobody present. Until 2026-09-25 it wrote
// the outcome to the action row and the server journal and nothing to the
// account's audit trail, so the owner's trail ended at
// `control_action_still_running` for work that had in fact finished — the one
// path where no person is there to see it end is the one path that did not say
// how it ended. Proved live on the box that day: the record read `executed`,
// `verified=yes`, and the last audit line still said the job was running.

function auditSpy() {
  const rows = [];
  const fn = (userId, action, req, details) => rows.push({ userId, action, details });
  fn.rows = rows;
  fn.of = name => rows.filter(row => row.action === name);
  return fn;
}

// A oneshot that is still going, then finishes — the shape the live proof took.
function adoptable(action, finishedRef) {
  return async instance => (finishedRef.done
    ? { instance, present: true, active: false, unit_state: 'inactive', ok: finishedRef.ok, error: finishedRef.error || null, finished_at: new Date(Date.parse(action.startedAt) + 120_000).toISOString(), result: { installed: ['roundcube'], verified: true } }
    : { instance, present: false, active: true, unit_state: 'active', ok: null, finished_at: null });
}

async function testAWatcherSettledSuccessReachesTheAccountAuditTrail() {
  const actionStore = store();
  const action = claimed(actionStore);
  const clock = timers();
  const audit = auditSpy();
  const finished = { done: false, ok: true };
  const reconciler = createReconciler({ actionStore, audit, setTimer: clock.setTimer, oneshotResult: adoptable(action, finished) });

  await reconciler.reconcile({ runId: 'live-process' });
  await clock.drain();
  assert.equal(audit.of('control_action_executed').length, 0, 'nothing may be claimed before the unit has said how it ended');

  finished.done = true;
  await clock.drain();

  assert.equal(actionStore.get(action.id).status, 'executed');
  const written = audit.of('control_action_executed');
  assert.equal(written.length, 1, 'the owner must be told the work finished');
  assert.equal(written[0].userId, 'owner', 'and it belongs in their own record');
  assert.match(written[0].details, /oneshot-packages-security\.json/, 'saying where the answer was read from');
  assert.match(written[0].details, /no person was present/, 'and that nobody was there to see it');
}

async function testTheSettledEndingIsAuditedExactlyOnce() {
  const actionStore = store();
  const action = claimed(actionStore);
  const clock = timers();
  const audit = auditSpy();
  const finished = { done: true, ok: true };
  const reconciler = createReconciler({ actionStore, audit, setTimer: clock.setTimer, oneshotResult: adoptable(action, finished) });

  await reconciler.reconcile({ runId: 'live-process' });
  assert.equal(actionStore.get(action.id).status, 'executed');

  // A second pass, a restart, a stray timer: whatever runs again must find the
  // action already terminal and add nothing. A duplicate ending is its own
  // untruth — it reads as the work having happened twice.
  await reconciler.reconcile({ runId: 'live-process' });
  await clock.drain(3);

  assert.equal(audit.of('control_action_executed').length, 1, 'one ending, recorded once');
  assert.equal(audit.rows.length, 1, 'and nothing else invented alongside it');
}

async function testAWatcherSettledFailureAndInterruptionAreAuditedToo() {
  // A failure the unit reported is as much the owner's business as a success.
  const failed = store();
  const failedAction = claimed(failed);
  const failAudit = auditSpy();
  await createReconciler({
    actionStore: failed, audit: failAudit, setTimer: timers().setTimer,
    oneshotResult: adoptable(failedAction, { done: true, ok: false, error: 'dpkg was interrupted' }),
  }).reconcile({ runId: 'live-process' });
  assert.equal(failed.get(failedAction.id).status, 'failed');
  assert.equal(failAudit.of('control_action_failed').length, 1, 'a failure read back is still an ending');
  assert.match(failAudit.of('control_action_failed')[0].details, /dpkg was interrupted/);

  // And an outcome nobody can know is recorded as exactly that, not as either.
  const lost = store();
  const lostAction = claimed(lost, { kind: 'server_ops.mail.mailbox.create', params: { address: 'info@example.com' } });
  const lostAudit = auditSpy();
  await createReconciler({ actionStore: lost, audit: lostAudit, setTimer: timers().setTimer }).reconcile({ runId: 'live-process' });
  assert.equal(lost.get(lostAction.id).status, 'interrupted');
  assert.equal(lostAudit.of('control_action_interrupted').length, 1, 'not observed is a fact, and the owner is told it');
  assert.equal(lostAudit.of('control_action_executed').length, 0);
  assert.equal(lostAudit.of('control_action_failed').length, 0);
}
