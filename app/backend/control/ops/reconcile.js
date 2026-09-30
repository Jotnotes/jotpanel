'use strict';

// What the record says when the panel dies in the middle of an action.
//
// The panel promises that every change leaves a record either way. It broke
// that promise in one specific place: `execute` ran the work in the web
// process, so anything that outlived the process left the row saying approved
// and never executed while the work had in fact completed. It was watched
// happening — needrestart restarted jotpanel.service during the panel's own update
// run, the machine came back fully updated, and the record was wrong.
//
// Two pieces close it. The action is claimed as `executing` and stamped with
// the id of the process running it, so an interrupted execution is recognisable
// rather than indistinguishable from one merely waiting its turn. And on
// startup every row left executing by a process that is not this one is
// resolved here.
//
// Resolution is deliberately narrow about what it will assert:
//
//   - Work that ran in a privileged oneshot writes a verified result to
//     /var/lib/jotpanel-ops/oneshot-*.json as its last act. That file is a real
//     outcome and the record takes it, executed or failed.
//   - A oneshot still running is not interrupted at all; only the process
//     watching it died. That action is adopted and watched to its end.
//   - Everything else becomes `interrupted`: not executed, not failed, because
//     neither is known. It names the operation and what to look at. Recording
//     it as failed would assert the change did not happen, and in the case
//     that produced this whole problem that assertion would have been false.

// Which actions leave something durable behind. Nothing else does, and the
// mapping is derived from the operation rather than guessed, so an operation
// that grows a oneshot later has to be added here on purpose.
function oneshotInstanceFor(action) {
  const kind = String(action?.kind || '');
  if (!kind.startsWith('server_ops.')) return null;
  const operation = kind.slice('server_ops.'.length);
  const params = (action.call && action.call.params) || {};
  if (operation === 'packages.apply') return params.securityOnly === false ? 'packages-all' : 'packages-security';
  if (operation.startsWith('stack.install.')) return `stack-${operation.slice('stack.install.'.length)}`;
  return null;
}

function describe(action) {
  return action?.label || String(action?.kind || 'the action').replace(/^server_ops\./, '');
}

function isFresherThan(finishedAt, startedAt) {
  if (!finishedAt) return false;
  if (!startedAt) return true;
  const finished = Date.parse(finishedAt);
  const started = Date.parse(startedAt);
  if (!Number.isFinite(finished) || !Number.isFinite(started)) return false;
  // Whole seconds either side, because the two stamps are written by two
  // processes and a result that lands in the same second as the claim is that
  // claim's result, not a leftover from before it.
  return finished >= started - 1000;
}

/**
 * @param actionStore     the durable action store
 * @param oneshotResult   async instance => { present, active, ok, finished_at, result, error }
 * @param waitForService  async () => boolean, true once the privileged service answers
 * @param log             where the pass narrates itself
 * @param watchMs         how long a still-running oneshot is watched before it is called interrupted
 * @param pollMs          how often it is asked
 */
function createReconciler({
  actionStore,
  oneshotResult = null,
  waitForService = async () => true,
  // The account's own trail. Everything here settles an action with no person
  // present, and until 2026-09-25 none of it was written down where the owner
  // could see it: the record said `executed` while their audit trail stopped at
  // `control_action_still_running`, which reads as a job that never came back.
  // The server journal had the answer and the person had no way to reach it.
  //
  // Written only after the state actually changed, never before the unit's own
  // result is known, and once — the transitions below refuse a second attempt,
  // so there is no path that records the same ending twice.
  audit = () => {},
  log = () => {},
  now = () => new Date(),
  watchMs = 45 * 60 * 1000,
  pollMs = 10 * 1000,
  setTimer = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  if (!actionStore) throw new Error('the reconciler requires an action store');

  const watching = new Set();

  async function askOneshot(instance) {
    if (!oneshotResult) throw new Error('no privileged operations client is attached to this panel');
    return oneshotResult(instance);
  }

  function interrupt(action, reason, evidence = null) {
    const record = actionStore.markInterrupted(action.id, { reason, evidence });
    audit(action.accountId, 'control_action_interrupted', null, `${describe(action)}: ${reason}`);
    log(`[reconcile] ${action.id} interrupted: ${reason}`);
    return record;
  }

  function finishFromResult(action, state) {
    if (state.ok === true) {
      const record = actionStore.markExecuted(action.id, {
        ...(state.result || {}),
        verified: true,
        reconciled: true,
        reconciled_from: `oneshot-${state.instance}.json`,
        finished_at: state.finished_at || null,
      });
      audit(action.accountId, 'control_action_executed', null,
        `${describe(action)}: read back from oneshot-${state.instance}.json after the panel stopped watching; no person was present`);
      log(`[reconcile] ${action.id} executed after all, from oneshot-${state.instance}.json`);
      return record;
    }
    const record = actionStore.markFailed(action.id, state.error || 'The privileged job reported a failure', {
      reconciled: true,
      reconciled_from: `oneshot-${state.instance}.json`,
      finished_at: state.finished_at || null,
    });
    audit(action.accountId, 'control_action_failed', null,
      `${describe(action)}: ${state.error || 'the privileged job reported a failure'} (read back from oneshot-${state.instance}.json; no person was present)`);
    log(`[reconcile] ${action.id} failed, from oneshot-${state.instance}.json`);
    return record;
  }

  // A oneshot that is still running was never interrupted; the process watching
  // it was. The action stays executing under this process's run id and is
  // finished from the same durable file the moment the unit writes it.
  function watch(action, instance, runId) {
    if (watching.has(action.id)) return;
    watching.add(action.id);
    const deadline = now().getTime() + watchMs;
    const tick = async () => {
      let state;
      try { state = { instance, ...(await askOneshot(instance)) }; }
      catch (error) {
        watching.delete(action.id);
        interrupt(action, `The panel restarted while ${describe(action)} was running, and the privileged operations service then stopped answering: ${error.message}`);
        return;
      }
      const current = actionStore.get(action.id);
      if (!current || current.status !== 'executing') { watching.delete(action.id); return; }
      if (state.present && isFresherThan(state.finished_at, action.startedAt)) {
        watching.delete(action.id);
        finishFromResult(action, state);
        return;
      }
      if (!state.active) {
        watching.delete(action.id);
        interrupt(action, `The panel restarted while ${describe(action)} was running. The privileged unit is no longer running and left no result, so whether the change took effect was not observed. Check the machine before running it again.`, { unit_state: state.unit_state || null });
        return;
      }
      if (now().getTime() >= deadline) {
        watching.delete(action.id);
        interrupt(action, `The panel restarted while ${describe(action)} was running, and the privileged unit was still running ${Math.round(watchMs / 60000)} minutes later without leaving a result.`, { unit_state: state.unit_state || null });
        return;
      }
      setTimer(tick, pollMs);
    };
    setTimer(tick, pollMs);
    log(`[reconcile] ${action.id} is still running as jotpanel-oneshot@${instance}; adopted and being watched`);
  }

  async function reconcile({ runId = null } = {}) {
    const stale = actionStore.listExecuting({ exceptRunId: runId });
    const summary = { checked: stale.length, executed: 0, failed: 0, interrupted: 0, watching: 0 };
    if (!stale.length) return summary;

    log(`[reconcile] ${stale.length} action${stale.length === 1 ? ' was' : 's were'} left mid-execution by a previous run`);
    const serviceReady = await waitForService();

    for (const action of stale) {
      const instance = oneshotInstanceFor(action);
      if (!instance) {
        interrupt(action, `The panel stopped while ${describe(action)} was running, so whether it took effect was not observed. Nothing durable is written for this operation, and the panel will not guess.`);
        summary.interrupted += 1;
        continue;
      }
      if (!serviceReady) {
        interrupt(action, `The panel stopped while ${describe(action)} was running, and the privileged operations service did not come back, so its result could not be read.`);
        summary.interrupted += 1;
        continue;
      }
      let state;
      try { state = { instance, ...(await askOneshot(instance)) }; }
      catch (error) {
        interrupt(action, `The panel stopped while ${describe(action)} was running, and its result could not be read back: ${error.message}`);
        summary.interrupted += 1;
        continue;
      }
      if (state.present && isFresherThan(state.finished_at, action.startedAt)) {
        finishFromResult(action, state);
        if (state.ok === true) summary.executed += 1; else summary.failed += 1;
        continue;
      }
      if (state.active) {
        actionStore.adoptExecuting(action.id, { runId });
        watch(actionStore.get(action.id), instance, runId);
        summary.watching += 1;
        continue;
      }
      interrupt(action, `The panel stopped while ${describe(action)} was running. The privileged unit is not running and left no result for this run, so whether the change took effect was not observed.`, { unit_state: state.unit_state || null });
      summary.interrupted += 1;
    }

    log(`[reconcile] ${summary.executed} executed, ${summary.failed} failed, ${summary.interrupted} interrupted, ${summary.watching} still running`);
    return summary;
  }

  // The same watch, entered from the live path instead of at startup.
  //
  // The panel gave up waiting on a job; the job did not give up. Where the work
  // runs as a privileged oneshot it writes its verified result to disk when it
  // finishes, so the row stays `executing` and the watcher above settles it
  // from that file, exactly as it would after a restart. Nothing is asserted
  // here, which is the point: recording `failed` at this moment asserts the
  // change did not happen, and on 2026-09-25 that assertion was false — the
  // mail stack was installed and running while the record called it a failure.
  //
  // Returns the oneshot instance being watched, or null for an operation that
  // leaves nothing durable behind, where the caller must fall back to its own
  // honest answer rather than this one.
  function adoptTimedOut(action, { runId = null } = {}) {
    const instance = oneshotInstanceFor(action);
    if (!instance) return null;
    const current = actionStore.get(action.id);
    if (!current || current.status !== 'executing') return null;
    watch(current, instance, runId);
    return instance;
  }

  return { reconcile, adoptTimedOut, oneshotInstanceFor, isFresherThan };
}

module.exports = { createReconciler, oneshotInstanceFor, isFresherThan };
