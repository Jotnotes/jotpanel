'use strict';

// Audit scenario F5: (a) a misread destructive request, (b) a bad route that
// must change for the next similar task, (c) invalid local output (proved in
// residentGateway.test.js). Each defence removed in turn.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createProjectLedger } = require('./projectLedger');
const { createJobRunner } = require('./jobRunner');
const { createRoutingFit } = require('./routingFit');
const { superviseStep } = require('./supervisor');

const A = 'u1';
const STEVE = `person:${A}`;

async function world() {
  const db = new Database(':memory:');
  const ledger = createProjectLedger({ db });
  const runner = createJobRunner({ db, ledger });
  const fit = createRoutingFit({ db });
  const project = ledger.createProject(A, { name: 'Invoice tracker' }, { actor: STEVE });
  const plan = await runner.planBuild({ accountId: A, projectId: project.id, goal: 'Invoices', rough: true, actor: 'resident',
    planner: async () => [{ title: 'Create the users table' }, { title: 'Create the invoices table' }, { title: 'Invoice route' }] });
  ledger.settle(A, plan.id, { actor: STEVE, approvalId: ledger.approve(A, plan.id, { seenHash: plan.hash, approvedBy: STEVE }).id });
  return { db, ledger, runner, fit, project, plan };
}

async function testMisreadRequest(mod) {
  const { db, ledger, runner, fit, project, plan } = await world();
  const guard = mod.createConversationGuard({ ledger, jobRunner: runner, fit });
  const rows = () => JSON.stringify(db.prepare("SELECT id, status, protected_body FROM ledger_items WHERE entity IN ('plan_step','decision') ORDER BY id").all());
  const before = rows();

  const first = guard.before({ accountId: A, projectId: project.id, text: 'Drop the users table from the plan' });
  assert.equal(first.proceed, false, 'a destructive-sounding request goes no further on this turn');
  assert.equal(first.kind, 'confirm', 'it reaches a risk confirmation');
  assert.match(first.reply, /Nothing has been changed/);
  assert.equal(rows(), before, 'nothing executed');

  const second = guard.before({ accountId: A, projectId: project.id, text: 'No, I meant the plan' });
  assert.equal(second.kind, 'correction');
  assert.match(second.reply, /Nothing was deleted/);
  assert.equal(ledger.list(A, project.id, { entity: 'knowledge' }).filter(k => k.title === 'Correction').length, 1, 'the correction is recorded');
  const proposed = ledger.list(A, project.id, { entity: 'decision', status: 'proposed' }).filter(d => d.kind === 'plan');
  assert.equal(proposed.length, 1, 'the plan change is drafted');
  assert.deepEqual(proposed[0].steps, plan.steps.slice(1), 'without the users table step');
  assert.equal(ledger.get(A, plan.id).status, 'settled', 'the approved plan stays until the person approves the change');

  // A yes goes on to the normal path, where a real operation still needs its own approval.
  guard.before({ accountId: A, projectId: project.id, text: 'delete the old backups' });
  const yes = guard.before({ accountId: A, projectId: project.id, text: 'yes, go ahead' });
  assert.equal(yes.proceed, true);
  assert.equal(yes.kind, 'confirmed');
  guard.before({ accountId: A, projectId: project.id, text: 'delete the users table, the db password: hunter2secret' });
  assert.ok(!JSON.stringify(db.prepare('SELECT protected_body FROM ledger_items').all()).includes('hunter2secret'), 'a secret typed into a risky request is not kept');
  assert.ok(ledger.verify().ok);
}

async function testBadRouteChanges(fitPath) {
  const { ledger, project, runner } = await world();
  const fit = require(fitPath).createRoutingFit({ db: new Database(':memory:') });
  const local = { id: 'ollama/qwen2.5:7b', call: async () => 'Here is some text about colours.' };
  const designer = { id: 'openai/gpt-4o', call: async () => 'Palette: #1F3A5F #F4F1EA #C2A878. PALETTE-OK' };
  const step = title => ledger.record(A, project.id, 'plan_step', { title, criteria: [{ name: 'palette', pattern: 'PALETTE-OK' }] }, { actor: 'resident' });
  const onOutcome = ({ specialist, accepted }) => fit.record(A, 'design', specialist.id, accepted ? 'accepted' : 'rejected');
  const order = () => fit.order(A, 'design', [local, designer], s => s.id);

  const first = step('Design a palette for the invoice page');
  assert.deepEqual(order().map(s => s.id), ['ollama/qwen2.5:7b', 'openai/gpt-4o'], 'the local model is tried first at the start');
  const run1 = await superviseStep({ ledger, accountId: A, stepId: first.id, specialists: order(), runId: 'r', prepareBrief: ({ step: s }) => s.title, onOutcome });
  assert.equal(run1.outcome, 'done', 'recovered within a bounded number of steps');
  assert.equal(run1.attempts, 3, 'two failures on the local model, then the designer');

  const next = order();
  assert.deepEqual(next.map(s => s.id), ['openai/gpt-4o', 'ollama/qwen2.5:7b'], 'the next similar route measurably changes');
  const second = step('Design a palette for the receipts page');
  const run2 = await superviseStep({ ledger, accountId: A, stepId: second.id, specialists: next, runId: 'r', prepareBrief: ({ step: s }) => s.title, onOutcome });
  assert.equal(run2.attempts, 1, 'and the next similar task is right first time');
  assert.deepEqual(fit.order(A, 'coding', [local, designer], s => s.id).map(s => s.id), ['ollama/qwen2.5:7b', 'openai/gpt-4o'], 'other kinds of work are unaffected');
  assert.equal(order().length, 2, 'reordering never adds or drops a candidate');
}

(async () => {
  const conversation = path.join(__dirname, 'residentConversation.js');
  const fitFile = path.join(__dirname, 'routingFit.js');
  await testMisreadRequest(require(conversation));
  await testBadRouteChanges(fitFile);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-mutants-'));
  const mutants = [
    ['destructive requests get a question', conversation, "    if (readRisk(said)) {", '    if (false) {', file => testMisreadRequest(require(file))],
    ['a correction is recorded', conversation, "    if (waiting && CORRECTION.test(said)) {", '    if (false) {', file => testMisreadRequest(require(file))],
    ['a correction to the plan drafts a change', conversation, "if (/\\bplan\\b/i.test(said) && jobRunner) {", 'if (false) {', file => testMisreadRequest(require(file))],
    ['failing models move down', fitFile, '.sort((a, b) => ((a.s <= -2) - (b.s <= -2)) || a.index - b.index)', '.sort((a, b) => a.index - b.index)', file => testBadRouteChanges(file)],
  ];
  try {
    for (const [i, [name, source, find, replace, test]] of mutants.entries()) {
      const text = fs.readFileSync(source, 'utf8');
      assert.equal(text.split(find).length - 1, 1, name);
      const file = path.join(dir, `m${i}.js`);
      fs.writeFileSync(file, text.replace(find, () => replace).replace("require('./egressGuard')", () => `require(${JSON.stringify(path.join(__dirname, 'egressGuard.js'))})`));
      let outcome = 'STILL PASSES';
      try { await test(file); } catch (error) { outcome = error instanceof assert.AssertionError ? 'CAUGHT' : `COULD NOT COMPLETE (${error.message})`; }
      console.log(`  ${outcome === 'CAUGHT' ? 'ok ' : 'BAD'} ${outcome.padEnd(12)} ${name}`);
      assert.equal(outcome, 'CAUGHT', name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('F5 tests passed (misread destructive request, bad route learns; 4 defences caught when removed; invalid local output in residentGateway.test.js)');
})().catch(error => { console.error(error); process.exit(1); });
