'use strict';

// ── Plans and the job runner (Stage 6) ───────────────────────────
//
// A build is a plan: steps recorded in the ledger and a plan decision that
// lists them. The plan is a proposal until a person approves it (settled
// decision 4: a rough plan from the Resident is labelled rough and approved
// before any work starts), and changing an approved plan is a new plan that
// supersedes it, which needs approval too.
//
// Running a plan takes the project's lock, so one run writes to a project at a
// time, then supervises each step in order. Everything durable is in the
// ledger, so a run that dies is picked up at the next start: its in-flight
// dispatch is already marked interrupted and is never sent again, and the step
// it was on starts over with a fresh brief and says it resumed.

const { superviseStep } = require('./supervisor');

class RunnerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function createJobRunner({ db, ledger, now = () => new Date() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resident_runs (
      plan_id    TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      state      TEXT NOT NULL,
      run_id     TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resident_runs_one_writer
      ON resident_runs (project_id) WHERE state = 'running';
  `);

  // The queue is deliberately in-process: durable work and crash recovery stay
  // in resident_runs and the ledger, while this small scheduler only decides
  // which two builds may use the box now. One active slot per account keeps a
  // second account from waiting behind two builds owned by the first.
  const waiting = new Map();
  const accountOrder = [];
  const activeAccounts = new Set();
  let active = 0;

  function drain() {
    while (active < 2 && accountOrder.length) {
      let picked = null;
      const turns = accountOrder.length;
      for (let i = 0; i < turns; i += 1) {
        const accountId = accountOrder.shift();
        const queue = waiting.get(accountId);
        if (!queue || !queue.length) { waiting.delete(accountId); continue; }
        if (activeAccounts.has(accountId)) { accountOrder.push(accountId); continue; }
        picked = queue.shift();
        if (queue.length) accountOrder.push(accountId); else waiting.delete(accountId);
        break;
      }
      if (!picked) break;
      active += 1;
      activeAccounts.add(picked.accountId);
      try {
        const claimed = db.prepare("UPDATE resident_runs SET state='running', updated_at=? WHERE plan_id=? AND state='queued'")
          .run(now().toISOString(), picked.planId);
        if (claimed.changes !== 1) throw new RunnerError('LOCKED', 'This queued build no longer owns its slot');
        picked.resolve();
      } catch (error) {
        active -= 1;
        activeAccounts.delete(picked.accountId);
        picked.reject(error);
      }
    }
  }

  function enterQueue(plan) {
    return new Promise((resolve, reject) => {
      const accountId = String(plan.accountId);
      if (!waiting.has(accountId)) { waiting.set(accountId, []); accountOrder.push(accountId); }
      waiting.get(accountId).push({ accountId, planId: plan.id, resolve, reject });
      drain();
    });
  }

  function leaveQueue(accountId) {
    active = Math.max(0, active - 1);
    activeAccounts.delete(String(accountId));
    drain();
  }

  // Steps come from a planner: [{ title, mustContain: [text] }]. Each literal a
  // step must contain becomes a criterion the supervisor checks.
  async function planBuild({ accountId, projectId, goal, planner, plannerId, rough, actor }) {
    const project = ledger.get(accountId, projectId);
    if (!project || project.entity !== 'project') throw new RunnerError('NOT_FOUND', 'No such project');
    const snap = ledger.snapshot(accountId, projectId);
    const rules = [...snap.decisions.filter(d => d.status === 'settled' && d.kind !== 'plan'), ...snap.constraints.filter(c => c.status === 'active')];
    const drafted = await planner({ goal, rules });
    if (!Array.isArray(drafted) || !drafted.length || drafted.length > 30) throw new RunnerError('BAD_PLAN', 'The planner did not return a usable list of steps');
    const escape = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const steps = drafted.map((item, index) => {
      const title = String((item && item.title) || '').trim().slice(0, 300);
      if (!title) throw new RunnerError('BAD_PLAN', `Step ${index + 1} has no title`);
      // A check is a short single line the answer must contain, matched with
      // loose spacing. A planner that writes a whole block of code as a check
      // makes a step no answer can pass, so anything longer is dropped.
      const criteria = (Array.isArray(item.mustContain) ? item.mustContain : []).slice(0, 5)
        .map(text => String(text).trim())
        .filter(text => text && !/\n/.test(text) && text.length <= 60)
        .map(text => ({ name: text, pattern: escape(text).replace(/\s+/g, '\\s*') }));
      return ledger.record(accountId, projectId, 'plan_step', { title: `${index + 1}. ${title}`, criteria, goal: String(goal).slice(0, 300) }, { actor });
    });
    return ledger.record(accountId, projectId, 'decision', {
      title: `${rough ? 'Rough plan' : 'Plan'}: ${String(goal).slice(0, 200)}`,
      text: steps.map(s => s.title).join('\n'),
      kind: 'plan', rough: !!rough, planner: plannerId || null, steps: steps.map(s => s.id),
    }, { actor });
  }

  // A material change to an approved plan is a new plan that supersedes it,
  // waiting for the person's approval like the first one.
  function proposePlanChange({ accountId, planId, keep, reason, actor }) {
    const plan = requireApprovedPlan(accountId, planId);
    const steps = plan.steps.map(id => ledger.get(accountId, id));
    const kept = steps.filter(step => keep(step));
    if (kept.length === steps.length || !kept.length) return null;
    return ledger.record(accountId, plan.projectId, 'decision', {
      title: `${plan.title} (changed)`,
      text: kept.map(s => s.title).join('\n'),
      kind: 'plan', rough: plan.rough, planner: plan.planner, steps: kept.map(s => s.id), supersedes: [plan.id],
      change: String(reason || '').slice(0, 300),
    }, { actor });
  }

  function requireApprovedPlan(accountId, planId) {
    const plan = ledger.get(accountId, planId);
    if (!plan || plan.entity !== 'decision' || plan.kind !== 'plan') throw new RunnerError('NOT_FOUND', 'No such plan');
    if (plan.status !== 'settled') throw new RunnerError('NOT_APPROVED', 'This plan has not been approved, so no work starts');
    return plan;
  }

  // Reserve the project's writer before entering the box-wide queue. Queued
  // work owns the same project lock, so a later plan cannot jump in front of
  // it while it waits for a fair turn.
  function queue(plan, runId) {
    const at = now().toISOString();
    return db.transaction(() => {
      const mine = db.prepare('SELECT * FROM resident_runs WHERE plan_id=?').get(plan.id);
      const other = db.prepare("SELECT * FROM resident_runs WHERE project_id=? AND state IN ('queued','running') AND plan_id<>?").get(plan.projectId, plan.id);
      if (other) throw new RunnerError('LOCKED', 'Another plan is already running on this project');
      if (mine && ['queued', 'running'].includes(mine.state) && mine.run_id !== runId) throw new RunnerError('LOCKED', 'This plan is already running');
      db.prepare(`INSERT INTO resident_runs (plan_id,account_id,project_id,state,run_id,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(plan_id) DO UPDATE SET state='queued', run_id=excluded.run_id, updated_at=excluded.updated_at`)
        .run(plan.id, plan.accountId, plan.projectId, 'queued', runId, at);
    })();
  }

  function settleRun(planId, state) {
    db.prepare('UPDATE resident_runs SET state=?, updated_at=? WHERE plan_id=?').run(state, now().toISOString(), planId);
  }

  async function runBuild({ accountId, planId, runId, specialistsFor, prepareBrief, onStep = () => {}, onOutcome = () => {} }) {
    const plan = requireApprovedPlan(accountId, planId);
    queue(plan, runId);
    await enterQueue(plan);
    const notices = [];
    try {
      for (const stepId of plan.steps) {
        const step = ledger.get(accountId, stepId);
        if (!step || step.status === 'done' || step.status === 'skipped') continue;
        if (step.status === 'in_progress') {
          ledger.amend(accountId, stepId, { resumedAt: now().toISOString() }, { actor: 'resident' });
          notices.push(`Resumed ${step.title}`);
        }
        onStep(step);
        const result = await superviseStep({ ledger, accountId, stepId, specialists: await specialistsFor(step), runId, prepareBrief, onOutcome });
        notices.push(...result.notices);
        if (result.outcome !== 'done') {
          settleRun(planId, 'blocked');
          return { outcome: 'blocked', stepId, reason: result.reason, notices };
        }
      }
      settleRun(planId, 'done');
      return { outcome: 'done', notices };
    } catch (error) {
      settleRun(planId, 'failed');
      throw error;
    } finally {
      leaveQueue(plan.accountId);
    }
  }

  // At start: every run still marked running belonged to a process that is
  // gone. This process takes them over and hands them back to be resumed.
  function runsToResume({ runId }) {
    if (!runId) throw new RunnerError('INVALID', 'Taking over runs needs the id of this process');
    const rows = db.prepare("SELECT plan_id, account_id FROM resident_runs WHERE state IN ('queued','running') AND (run_id IS NULL OR run_id<>?) ORDER BY updated_at").all(String(runId));
    const adopt = db.prepare('UPDATE resident_runs SET run_id=?, updated_at=? WHERE plan_id=?');
    for (const row of rows) adopt.run(String(runId), now().toISOString(), row.plan_id);
    return rows.map(row => ({ planId: row.plan_id, accountId: row.account_id }));
  }

  function status(accountId, planId) {
    const plan = ledger.get(accountId, planId);
    if (!plan || plan.kind !== 'plan') throw new RunnerError('NOT_FOUND', 'No such plan');
    const run = db.prepare('SELECT state, updated_at FROM resident_runs WHERE plan_id=?').get(planId);
    return {
      plan: { id: plan.id, title: plan.title, status: plan.status, rough: plan.rough, hash: plan.hash },
      run: run ? { state: run.state, updatedAt: run.updated_at } : { state: 'not started' },
      steps: plan.steps.map(id => ledger.get(accountId, id)).map(s => ({ id: s.id, title: s.title, status: s.status, blockedReason: s.blockedReason || null, resumedAt: s.resumedAt || null, acceptedArtifact: s.acceptedArtifact || null })),
    };
  }

  return { planBuild, runBuild, runsToResume, status, requireApprovedPlan, proposePlanChange };
}

module.exports = { createJobRunner, RunnerError };
