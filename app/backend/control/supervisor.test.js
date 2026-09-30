'use strict';

// Audit scenarios F1 (a model drifts from settled decisions) and F4 (a model
// repeats itself, goes in circles, or claims done), with scripted specialists
// that record what they receive, a control run of honest builds to count false
// alarms, and each defence removed in turn.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createProjectLedger } = require('./projectLedger');

const A = 'u1';
const STEVE = 'person:steve';
const RULES = [
  ['Storage is SQLite', ['postgres', '\\bpg\\b']],
  ['No TypeScript', ['typescript', '\\binterface\\s+\\w+\\s*\\{', ':\\s*(string|number|boolean)\\b']],
  ['Sign-in is passkeys', ['bcrypt', 'password_hash']],
  ['API paths live under /api/v1', ["['\"]/api/(?!v1/)"]],
  ['Money is whole cents', ['\\b(REAL|FLOAT|DOUBLE|DECIMAL)\\b', 'parseFloat']],
];
const GOOD = '```sql\nCREATE TABLE invoices (id INTEGER PRIMARY KEY, amount_cents INTEGER NOT NULL);\n```\n```js\napp.post("/api/v1/invoices", handler);\n```';
const DRIFT = '```sql\nCREATE TABLE invoices (id SERIAL, amount DOUBLE PRECISION); -- postgres\n```\n```ts\ninterface Invoice { amount: number }\napp.post("/api/v1/invoices", handler);\n```';

function build() {
  const db = new Database(':memory:');
  const ledger = createProjectLedger({ db });
  const project = ledger.createProject(A, { name: 'Invoice tracker' }, { actor: STEVE });
  const rules = RULES.map(([title, forbid]) => {
    const d = ledger.record(A, project.id, 'decision', { title, forbid }, { actor: STEVE });
    const yes = ledger.approve(A, d.id, { seenHash: d.hash, approvedBy: STEVE });
    return ledger.settle(A, d.id, { actor: STEVE, approvalId: yes.id });
  });
  const step = ledger.record(A, project.id, 'plan_step', {
    title: 'Step 7: invoices table and route',
    criteria: [{ name: 'invoices table', pattern: 'CREATE TABLE invoices' }, { name: 'v1 invoices route', pattern: '/api/v1/invoices' }],
  }, { actor: 'resident' });
  const ruleRows = () => JSON.stringify(db.prepare("SELECT * FROM ledger_items WHERE entity='decision' AND status='settled' ORDER BY id").all());
  return { db, ledger, project, rules, step, ruleRows };
}

const brief = ({ step, rules, correction }) => `Rules:\n${rules.map(r => `- ${r.title}`).join('\n')}\nTask: ${step.title}${correction ? `\nCorrection:\n${correction}` : ''}`;

function scripted(id, replies) {
  const seen = [];
  let i = 0;
  return { id, seen, call: async ({ brief: b }) => { seen.push(b); const r = typeof replies === 'function' ? replies(i) : replies[Math.min(i, replies.length - 1)]; i += 1; return r; } };
}

async function testF1ModelDrifts(sup) {
  const { ledger, step, ruleRows, rules } = build();
  const before = ruleRows();
  const coder = scripted('anthropic/claude-sonnet-5', [DRIFT, DRIFT]);
  const other = scripted('openai/gpt-4o', [GOOD]);
  const run = await sup.superviseStep({ ledger, accountId: A, stepId: step.id, specialists: [coder, other], runId: 'run-1', prepareBrief: brief });
  assert.equal(run.outcome, 'done', 'step 7 completes');
  assert.equal(run.attempts, 3, 'two failures on the drifting model, then the other model');
  assert.equal(ruleRows(), before, 'the settled decisions are byte-identical');
  const artifacts = ledger.list(A, step.projectId, { entity: 'artifact' });
  assert.deepEqual(artifacts.map(a => a.status), ['rejected', 'rejected', 'accepted'], 'the drifting patches are kept, marked rejected');
  assert.equal(artifacts[0].content, DRIFT);
  const firstChecks = ledger.list(A, step.projectId, { entity: 'dispatch' })[0].result.checks.filter(c => c.name.startsWith('rule:') && !c.passed).map(c => c.name);
  assert.deepEqual(firstChecks.sort(), ['rule: Money is whole cents', 'rule: No TypeScript', 'rule: Storage is SQLite'], 'the supervisor names the three decisions breached');
  assert.match(coder.seen[1], /Storage is SQLite/);
  assert.match(coder.seen[1], /No TypeScript/);
  assert.match(coder.seen[1], /Money is whole cents/);
  assert.match(coder.seen[1], /broke a settled rule/, 'the correction brief cites the decisions');
  assert.equal(other.seen.length, 1, 'after two failures the step went to a different model');
  assert.equal(ledger.get(A, step.id).status, 'done');
  assert.equal(rules.length, 5);
  assert.ok(ledger.verify().ok);
}

async function testF1ModelRecommendsAChange(sup) {
  const { ledger, step, ruleRows, rules } = build();
  const before = ruleRows();
  const coder = scripted('anthropic/claude-sonnet-5', [`${GOOD}\nThis works. For scale I recommend we switch to Postgres later.`]);
  const run = await sup.superviseStep({ ledger, accountId: A, stepId: step.id, specialists: [coder], runId: 'run-1', prepareBrief: brief });
  assert.equal(run.outcome, 'done');
  assert.equal(ruleRows(), before, 'the rule is untouched');
  const proposals = ledger.list(A, step.projectId, { entity: 'decision', status: 'proposed' });
  assert.equal(proposals.length, 1, 'the recommendation is an open proposal for the person');
  assert.deepEqual(proposals[0].supersedes, [rules[0].id]);
  assert.match(run.notices.join(' '), /waiting for you/);
}

async function testF4Repeating(sup) {
  const { ledger, step } = build();
  const words = ['I added the invoices table.', 'The invoices table has been added.', 'Added the invoices table now.'];
  const models = ['m1', 'm2', 'm3'].map(id => scripted(id, i => words[i % 3]));
  const run = await sup.superviseStep({ ledger, accountId: A, stepId: step.id, specialists: models, runId: 'run-1', prepareBrief: brief });
  assert.equal(run.outcome, 'blocked');
  assert.match(run.reason, /say the same thing/);
  assert.ok(run.attempts <= 6, `stopped within the limit (${run.attempts} attempts)`);
  assert.match(models[1].seen.join('\n'), /Do only this one thing now/, 'the task was narrowed before stopping');
  assert.ok(models[2].seen.length >= 1, 'a different model was tried before stopping');
  assert.equal(ledger.get(A, step.id).status, 'blocked');
  assert.match(ledger.get(A, step.id).blockedReason, /say the same thing/);
}

async function testF4Circles(sup) {
  const { ledger, step } = build();
  let n = 0;
  const flip = () => (n++ % 2 ? 'Use a JSON file per invoice stored in a folder on disk.' : 'Keep invoices in memory inside a global array object.');
  const models = ['m1', 'm2', 'm3'].map(id => scripted(id, flip));
  const run = await sup.superviseStep({ ledger, accountId: A, stepId: step.id, specialists: models, runId: 'run-1', prepareBrief: brief });
  assert.equal(run.outcome, 'blocked');
  assert.match(run.reason, /switching between the same two answers/);
}

async function testF4ClaimsDone(sup) {
  const { ledger, step } = build();
  const models = ['m1', 'm2'].map(id => scripted(id, ['All done, the invoices feature is complete.']));
  const run = await sup.superviseStep({ ledger, accountId: A, stepId: step.id, specialists: models, runId: 'run-1', prepareBrief: brief });
  assert.equal(run.outcome, 'blocked');
  assert.match(run.reason, /said it was done with invoices table, v1 invoices route still unmet/);
  assert.ok(run.attempts <= 3, `stopped quickly (${run.attempts})`);
}

// Honest builds that improve each time, including ones that mention a
// forbidden word in plain prose. Nothing may be flagged, switched or blocked.
async function testHonestBuildsAreNeverFlagged(sup) {
  const cases = [
    ['```sql\nCREATE TABLE invoices (id INTEGER PRIMARY KEY);\n```', GOOD],
    ['Starting with the table.\n```sql\nCREATE TABLE invoices (id INTEGER PRIMARY KEY, amount_cents INTEGER);\n```', `We are not using Postgres here, as decided.\n${GOOD}`],
    ['Here is a plan first.', '```sql\nCREATE TABLE invoices (id INTEGER PRIMARY KEY, amount_cents INTEGER);\n```', GOOD],
    ['```js\napp.post("/api/v1/invoices", handler);\n```', `${GOOD}\nDone, both parts are in.`],
    [GOOD],
    ['```sql\nCREATE TABLE invoices (id INTEGER PRIMARY KEY, amount_cents INTEGER);\n```\nDone with the table, the route comes next.', GOOD],
  ];
  let falseAlarms = 0;
  for (const replies of cases) {
    const { ledger, step } = build();
    const one = scripted('m1', replies);
    const two = scripted('m2', [GOOD]);
    const run = await sup.superviseStep({ ledger, accountId: A, stepId: step.id, specialists: [one, two], runId: 'run-1', prepareBrief: brief });
    if (run.outcome !== 'done' || two.seen.length || one.seen.some(b => /Do only this one thing/.test(b))) falseAlarms += 1;
  }
  assert.equal(falseAlarms, 0, `${falseAlarms} of ${cases.length} honest builds were flagged`);
  return cases.length;
}

const TESTS = [testF1ModelDrifts, testF1ModelRecommendsAChange, testF4Repeating, testF4Circles, testF4ClaimsDone, testHonestBuildsAreNeverFlagged];

const MUTANTS = [
  ['rule check on answers', 'for (const rule of rules) {', 'for (const rule of []) {', testF1ModelDrifts],
  ['recommendations become proposals, not silence', 'if (sentence) { proposals.push(', 'if (false) { proposals.push(', testF1ModelRecommendsAChange],
  ['switching model after repeated failures', 'if (failuresHere >= failuresPerModel) { model += 1; failuresHere = 0; }\n  }\n  return block', 'if (false) { model += 1; failuresHere = 0; }\n  }\n  return block', testF1ModelDrifts],
  ['repeat detection', "return { signal: 'repeating'", "if (0) return { signal: 'repeating'", testF4Repeating],
  ['circle detection', "return { signal: 'going in circles'", "if (0) return { signal: 'going in circles'", testF4Circles],
  ['claims-done detection', "return { signal: 'claims done'", "if (0) return { signal: 'claims done'", testF4ClaimsDone],
  ['progress is not a failure', '  if (progress) return null;\n', '', testHonestBuildsAreNeverFlagged],
];

(async () => {
  const sup = require('./supervisor');
  for (const test of TESTS) await test(sup);
  const source = fs.readFileSync(path.join(__dirname, 'supervisor.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-mutants-'));
  let caught = 0;
  try {
    for (const [i, [name, find, replace, test]] of MUTANTS.entries()) {
      const count = source.split(find).length - 1;
      assert.equal(count, 1, `mutant "${name}": the code to remove was found ${count} times`);
      const file = path.join(dir, `m${i}.js`);
      fs.writeFileSync(file, source.replace(find, () => replace));
      let outcome;
      try { await test(require(file)); outcome = 'STILL PASSES'; } catch (error) { outcome = error instanceof assert.AssertionError ? 'CAUGHT' : `COULD NOT COMPLETE (${error.message})`; }
      console.log(`  ${outcome === 'CAUGHT' ? 'ok ' : 'BAD'} ${outcome.padEnd(12)} ${name}`);
      assert.equal(outcome, 'CAUGHT', name);
      caught += 1;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`supervisor tests passed (F1, F1 recommendation, F4 repeating, circles, claims done; 6 honest builds, 0 false alarms; ${caught} defences caught when removed)`);
})().catch(error => { console.error(error); process.exit(1); });
