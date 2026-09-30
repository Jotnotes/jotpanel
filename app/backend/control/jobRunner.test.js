'use strict';

// Audit scenario F3: a 15-step build, killed with kill -9 while step 9's model
// call is in flight and a proposal waits for the person. Plus: no work before a
// plan is approved, one writer per project, and each defence removed in turn.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { createProjectLedger } = require('./projectLedger');

const A = 'u1';
const STEVE = 'person:steve';
const STEPS = 15;
const brief = ({ step, correction }) => `${step.title}${correction ? `\n${correction}` : ''}`;
const good = step => `\`\`\`js\n// ${step.title}\nexport const part${step.title.split('.')[0]} = true; // STEP-${step.title.split('.')[0]}\n\`\`\``;

function open(file, runnerPath = path.join(__dirname, 'jobRunner.js')) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const ledger = createProjectLedger({ db });
  const { createJobRunner } = require(runnerPath);
  return { db, ledger, runner: createJobRunner({ db, ledger }) };
}

async function setup(ledger, runner) {
  const project = ledger.createProject(A, { name: 'Invoice tracker' }, { actor: STEVE, id: 'p1', idempotencyKey: 'p1' });
  const rule = ledger.record(A, project.id, 'decision', { title: 'Storage is SQLite', forbid: ['postgres'] }, { actor: STEVE, id: 'd1' });
  ledger.settle(A, rule.id, { actor: STEVE, approvalId: ledger.approve(A, rule.id, { seenHash: rule.hash, approvedBy: STEVE }).id });
  const planner = async () => Array.from({ length: STEPS }, (_, i) => ({ title: `Part ${i + 1}`, mustContain: [`STEP-${i + 1}`] }));
  const plan = await runner.planBuild({ accountId: A, projectId: project.id, goal: 'Invoice tracker', planner, plannerId: 'resident', rough: true, actor: 'resident' });
  return { project, plan };
}

const approve = (ledger, plan) => ledger.settle(A, plan.id, { actor: STEVE, approvalId: ledger.approve(A, plan.id, { seenHash: plan.hash, approvedBy: STEVE }).id });

// The child: runs the build; step 8's answer recommends a rule change; step
// 9's call never returns. It says so, and waits to be killed.
async function child(file) {
  const { ledger, runner } = open(file);
  const { plan } = await setup(ledger, runner);
  approve(ledger, plan);
  const specialist = {
    id: 'scripted/coder',
    call: async ({ brief: b }) => {
      const n = Number(b.split('.')[0]);
      if (n === 8) return `${good({ title: b.split('\n')[0] })}\nFor scale I recommend we switch to Postgres.`;
      if (n === 9) { fs.writeSync(1, 'IN FLIGHT\n'); return new Promise(() => {}); }
      return good({ title: b.split('\n')[0] });
    },
  };
  await runner.runBuild({ accountId: A, planId: plan.id, runId: 'run-a', specialistsFor: () => [specialist], prepareBrief: brief });
}

async function testF3RestartMidBuild(runnerPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-f3-'));
  const file = path.join(dir, 'build.db');
  try {
    const proc = spawn(process.execPath, [__filename, '--child', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', d => { err += d; });
    await new Promise((resolve, reject) => { proc.stdout.on('data', resolve); proc.on('exit', () => reject(new Error(`child stopped: ${err}`))); });
    proc.kill('SIGKILL');
    await new Promise(resolve => proc.on('exit', resolve));

    const { db, ledger, runner } = open(file, runnerPath);
    const before = JSON.stringify(db.prepare("SELECT id, status, protected_body FROM ledger_items WHERE entity IN ('decision','constraint','artifact') OR (entity='plan_step' AND status='done') ORDER BY id").all());
    const plan = db.prepare("SELECT id FROM ledger_items WHERE entity='decision' AND status='settled' AND id<>'d1'").get();
    const step9 = ledger.get(A, runner.status(A, plan.id).steps[8].id);
    assert.equal(step9.status, 'in_progress', 'the crash left step 9 in progress');
    const inFlight = ledger.list(A, 'p1', { entity: 'dispatch', status: 'in_flight' });
    assert.equal(inFlight.length, 1, 'one call was in flight at the crash');
    // The restart, as the server does it.
    ledger.recoverInterrupted({ runId: 'run-b' });
    assert.deepEqual(runner.runsToResume({ runId: 'run-b' }).map(r => r.planId), [plan.id], 'the run is found and taken over at start');
    const seen = [];
    const specialist = { id: 'scripted/coder', call: async ({ brief: b }) => { seen.push(b); return good({ title: b.split('\n')[0] }); } };
    let result;
    try { result = await runner.runBuild({ accountId: A, planId: plan.id, runId: 'run-b', specialistsFor: () => [specialist], prepareBrief: brief }); }
    catch (error) { assert.fail(`the resumed build did not finish: ${error.message}`); }

    assert.equal(result.outcome, 'done', 'the build finishes');
    assert.equal(ledger.get(A, inFlight[0].id).status, 'interrupted', 'the in-flight call is marked interrupted');
    assert.equal(ledger.history(A, inFlight[0].id).filter(e => e.type === 'dispatch.in_flight').length, 1, 'and never sent again');
    assert.match(seen[0], /^9\. Part 9/, 'the restart begins at step 9, with a fresh brief');
    assert.equal(seen.length, 7, 'steps 9 to 15, nothing earlier redone');
    assert.ok(ledger.get(A, step9.id).resumedAt, 'step 9 says it resumed');
    assert.ok(result.notices.some(n => /Resumed 9\./.test(n)));
    const accepted = ledger.list(A, 'p1', { entity: 'artifact', status: 'accepted' });
    assert.equal(accepted.length, STEPS, 'exactly one applied answer per step');
    assert.equal(new Set(accepted.map(a => a.stepId)).size, STEPS);
    const waiting = ledger.list(A, 'p1', { entity: 'decision', status: 'proposed' });
    assert.equal(waiting.length, 1, 'the proposal is still waiting for the person');
    const after = JSON.parse(JSON.stringify(db.prepare("SELECT id, status, protected_body FROM ledger_items WHERE entity IN ('decision','constraint','artifact') OR (entity='plan_step' AND status='done') ORDER BY id").all()));
    const kept = JSON.parse(before);
    for (const row of kept) assert.deepEqual(after.find(r => r.id === row.id), row, `${row.id} changed across the restart`);
    assert.ok(ledger.verify().ok);
    assert.deepEqual(runner.runsToResume({ runId: 'run-c' }), [], 'nothing left to resume');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function testNoWorkBeforeApprovalAndOneWriter(runnerPath) {
  const { ledger, runner } = open(':memory:', runnerPath);
  const { plan } = await setup(ledger, runner);
  let calls = 0;
  const specialist = { id: 's', call: async ({ brief: b }) => { calls += 1; await new Promise(r => setTimeout(r, 5)); return good({ title: b.split('\n')[0] }); } };
  const run = runId => runner.runBuild({ accountId: A, planId: plan.id, runId, specialistsFor: () => [specialist], prepareBrief: brief });
  await assert.rejects(run('r1'), error => error.code === 'NOT_APPROVED', 'no work starts before the plan is approved');
  assert.equal(calls, 0);
  approve(ledger, plan);
  // A second plan for the same project, approved too, started at the same time.
  const other = await runner.planBuild({ accountId: A, projectId: 'p1', goal: 'Same project, another plan', planner: async () => [{ title: 'Other', mustContain: ['STEP-Other'] }], rough: true, actor: 'resident' });
  approve(ledger, other);
  const runOther = runId => runner.runBuild({ accountId: A, planId: other.id, runId, specialistsFor: () => [specialist], prepareBrief: brief });
  const results = await Promise.allSettled([run('r1'), runOther('r2')]);
  assert.deepEqual(results.map(r => r.status).sort(), ['fulfilled', 'rejected'], 'a second writer on the same project is refused');
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'LOCKED', 'refused by name, as a locked project');
  assert.equal(ledger.list(A, 'p1', { entity: 'artifact', status: 'accepted' }).length, STEPS, 'each step applied once');

}

async function testAnAcceptedAnswerIsNotRedone(runnerPath) {
  // The crash between accepting an answer and marking the step done.
  const { ledger } = open(':memory:', runnerPath);
  const { plan } = await setup(ledger, require(runnerPath).createJobRunner({ db: new Database(':memory:'), ledger }));
  const stepId = plan.steps[0];
  ledger.move(A, stepId, 'in_progress', { actor: 'resident' });
  const art = ledger.record(A, 'p1', 'artifact', { title: 'answer', stepId, content: 'STEP-1' }, { actor: 'model:x' });
  ledger.move(A, art.id, 'accepted', { actor: 'resident' });
  const supervisor = require(path.join(path.dirname(runnerPath), 'supervisor.js'));
  let calls = 0;
  const out = await supervisor.superviseStep({ ledger, accountId: A, stepId, specialists: [{ id: 's', call: async () => { calls += 1; return 'STEP-1'; } }], runId: 'r', prepareBrief: brief });
  assert.equal(calls, 0, 'the step is finished from the record, not run again');
  assert.equal(out.outcome, 'done');
  assert.equal(ledger.list(A, 'p1', { entity: 'artifact', status: 'accepted' }).length, 1);
}

async function testPlannerChecksArePassable(runnerPath) {
  const { ledger, runner } = open(':memory:', runnerPath);
  const project = ledger.createProject(A, { name: 'x' }, { actor: STEVE });
  const plan = await runner.planBuild({ accountId: A, projectId: project.id, goal: 'add', rough: true, actor: 'resident', planner: async () => [
    { title: 'Add', mustContain: ['function add(a, b) {\n    return a + b;\n}', 'function add(a, b)', 'x'.repeat(200)] },
  ] });
  const step = ledger.get(A, plan.steps[0]);
  assert.deepEqual(step.criteria.map(c => c.name), ['function add(a, b)'], 'multi-line and very long checks are dropped');
  assert.ok(new RegExp(step.criteria[0].pattern, 'i').test('function add(a,b){ return a + b }'), 'spacing is matched loosely');
}

if (process.argv[2] === '--child') {
  child(process.argv[3]).catch(error => { console.error(error); process.exit(1); });
} else {
  (async () => {
    const runnerPath = path.join(__dirname, 'jobRunner.js');
    await testF3RestartMidBuild(runnerPath);
    await testNoWorkBeforeApprovalAndOneWriter(runnerPath);
    await testAnAcceptedAnswerIsNotRedone(runnerPath);
    await testPlannerChecksArePassable(runnerPath);

    // Each defence removed. Mutants of both files are written beside each other
    // so the runner loads the mutated supervisor.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mutants-'));
    const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
    // Skipping finished steps on restart and finishing a step from its accepted
    // answer cover each other, so removing one alone changes nothing; removing
    // both must fail F3.
    const mutants = [
      ['one writer per project', [['jobRunner.js', "if (other) throw new RunnerError('LOCKED'", "if (false) throw new RunnerError('LOCKED'"]], testNoWorkBeforeApprovalAndOneWriter],
      ['no work before approval', [['jobRunner.js', "if (plan.status !== 'settled') throw", 'if (false) throw']], testNoWorkBeforeApprovalAndOneWriter],
      ['an accepted answer is not redone', [['supervisor.js', '  if (kept) {', '  if (false) {']], testAnAcceptedAnswerIsNotRedone],
      ['finished work is not redone after a restart (both layers)', [
        ['jobRunner.js', "if (!step || step.status === 'done' || step.status === 'skipped') continue;", 'if (!step) continue;'],
        ['supervisor.js', '  if (kept) {', '  if (false) {'],
      ], testF3RestartMidBuild],
    ];
    try {
      for (const [i, [name, edits, test]] of mutants.entries()) {
        const sub = path.join(dir, `m${i}`);
        fs.mkdirSync(sub);
        for (const f of ['jobRunner.js', 'supervisor.js']) {
          let text = read(f);
          for (const [file, find, replace] of edits.filter(e => e[0] === f)) { assert.equal(text.split(find).length - 1, 1, name); text = text.replace(find, () => replace); }
          fs.writeFileSync(path.join(sub, f), text);
        }
        let outcome = 'STILL PASSES';
        try { await test(path.join(sub, 'jobRunner.js')); } catch (error) { outcome = error instanceof assert.AssertionError ? 'CAUGHT' : `COULD NOT COMPLETE (${error.message})`; }
        console.log(`  ${outcome === 'CAUGHT' ? 'ok ' : 'BAD'} ${outcome.padEnd(12)} ${name}`);
        assert.equal(outcome, 'CAUGHT', name);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log('job runner tests passed (F3 kill -9 at step 9 of 15, approval before work, one writer, no answer applied twice; 4 defences caught when removed)');
  })().catch(error => { console.error(error); process.exit(1); });
}
