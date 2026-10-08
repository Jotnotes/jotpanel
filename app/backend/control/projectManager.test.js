'use strict';

// The Resident as project manager, proved three ways:
//   - behaviour: a handoff cannot exist without its reason, spend is grouped
//     by AI, by kind of work and by project, a cap refuses before the money is
//     spent, and a brief stays the same size as the project grows;
//   - arithmetic: the totals are read from the ledger's own dispatch results,
//     so a cost recorded there and a cost reported here are the same number;
//   - every defence removed in turn, each time a named test must fail.

const assert = require('assert/strict');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'projectManager.js');
const { createProjectManager, explainChoice, money, providerName } = require(MODULE);
const { createProjectLedger } = require(path.join(__dirname, 'projectLedger.js'));

const OWNER = 'acct_owner';
const STEVE = 'person:steve';
const BASE = Date.parse('2026-10-02T09:00:00Z');

function fresh() {
  const db = new Database(':memory:');
  let tick = 0;
  const now = () => new Date(BASE + (tick++) * 1000);
  const ledger = createProjectLedger({ db, now, runId: 'run-pm' });
  const pm = createProjectManager({ db, ledger, now });
  return { db, ledger, pm };
}

// A finished handoff worth a known number of micro-dollars.
function ran(ledger, pm, projectId, { purpose, role, route, micro, outcome = 'completed', considered = [] }) {
  const { dispatch, sentence } = pm.handoff(OWNER, projectId, { purpose, role, route, considered, intent: 'the request reads as ' + role + ' work' });
  ledger.startDispatch(OWNER, dispatch.id, { runId: 'run-pm', sent: { brief: purpose } });
  ledger.finishDispatch(OWNER, dispatch.id, { outcome, costMicro: micro, latencyMs: 400 });
  return { id: dispatch.id, sentence };
}

// ── A handoff always carries its reason ──────────────────────────────────────
{
  const { ledger, pm } = fresh();
  const project = ledger.createProject(OWNER, { name: 'Shop rebuild' }, { actor: STEVE });
  const step = ledger.record(OWNER, project.id, 'plan_step', { title: 'Landing page' }, { actor: 'resident' });

  const { dispatch, sentence } = pm.handoff(OWNER, project.id, {
    purpose: 'Design the landing page', stepId: step.id, task: 'creative', role: 'design',
    route: { providerId: 'openai', model: 'gpt-6-astra' },
    considered: [['openai', 'gpt-6-astra'], ['anthropic', 'claude-sonnet-5']],
    intent: 'the request reads as design work',
  });

  const stored = ledger.get(OWNER, dispatch.id);
  assert.equal(stored.entity, 'dispatch', 'a handoff is a dispatch in the ledger');
  // The shape residentGateway and supervisor already write, not a second one
  // beside it, so everything already reading `route` keeps working.
  assert.equal(stored.route.provider, 'openai', 'the handoff records who it went to');
  assert.equal(stored.route.model, 'gpt-6-astra', 'the handoff records which model');
  assert.equal(stored.route.role, 'design', 'the handoff records the kind of work');
  assert.ok(stored.why && stored.why.sentence, 'the handoff records why');
  assert.match(sentence, /ChatGPT/, 'the sentence names the AI by the name a person knows');
  assert.match(sentence, /look and feel/, 'the sentence says what kind of work went');
  assert.match(sentence, /Claude/, 'the sentence says who it was ahead of');
  assert.throws(() => pm.handoff(OWNER, project.id, { role: 'design', route: { providerId: 'openai', model: 'x' } }),
    /says what it is for/, 'a handoff with no purpose');
  console.log('  handoff: recorded with who, what and why');
}

// ── The reason is the real reason, in the right order ────────────────────────
{
  assert.equal(explainChoice({ role: 'coding', route: { providerId: 'anthropic', model: 'claude-sonnet-5', chosenBy: 'person' } }).code,
    'you_chose', 'a model the person pinned is explained as their choice');
  assert.equal(explainChoice({ role: 'coding', route: { providerId: 'byog', model: 'qwen2.5-coder:14b', source: 'device', byog: { name: 'Studio' } } }).code,
    'your_machine', 'the user\'s own machine is explained as theirs');
  assert.equal(explainChoice({ role: 'coding', route: { providerId: 'anthropic', model: 'claude-haiku-4-5', chosenBy: 'demoted' } }).code,
    'demoted', 'a demotion is explained as a demotion');
  assert.equal(explainChoice({ role: 'chat', route: { providerId: 'ollama', model: 'qwen2.5:7b', resident: true } }).code,
    'free_resident', 'the local fallback says why it is local');
  assert.equal(explainChoice({ role: 'mechanical', route: { providerId: 'gemini', model: 'gemini-3.5-flash-lite' }, budgetState: 'warn' }).code,
    'cheaper_for_budget', 'near the limit, the cheaper pick is explained by the limit');
  assert.equal(explainChoice({ role: 'coding', route: null }).code, 'nothing_available', 'nothing available says so');

  // A pinned model on the person's own machine is still their choice of machine,
  // not a silent default: the device branch must not swallow an explicit pick
  // without saying the work costs nothing.
  const own = explainChoice({ role: 'coding', route: { providerId: 'byog', source: 'device', byog: { name: 'Studio' } } });
  assert.match(own.sentence, /costs nothing/, 'the own-machine sentence says it is free');
  assert.match(own.sentence, /Studio/, 'the own-machine sentence names the machine');
  console.log('  reasons: six distinct explanations, explicit choice before any default');
}

// ── Work recorded by the live writers is counted ─────────────────────────────
//
// residentGateway has written a dispatch for every chat turn since stage 2, and
// supervisor writes one for every build step. Neither knows this file exists.
// If spend only understood the shape `handoff` writes, every number on every
// screen would read zero against the only data a real box has.
{
  const { ledger, pm } = fresh();
  const project = ledger.createProject(OWNER, { name: 'Real traffic' }, { actor: STEVE });

  // Exactly what residentGateway.dispatch writes.
  const turn = ledger.recordDispatch(OWNER, project.id, {
    purpose: 'build turn',
    route: {
      role: 'coding', task: 'code', provider: 'anthropic', model: 'claude-sonnet-5', source: 'byok',
      reason: 'the request reads as coding work',
      understood: { state: 'neutral', how: 'model', confidence: 0.9 },
    },
  });
  ledger.startDispatch(OWNER, turn.id, { runId: 'run-pm', sent: { brief: 'x' } });
  ledger.finishDispatch(OWNER, turn.id, { outcome: 'completed', costMicro: 1_500_000 });

  // Exactly what supervisor writes: a role and a model, and no provider at all.
  const step = ledger.record(OWNER, project.id, 'plan_step', { title: 'Schema' }, { actor: 'resident' });
  const build = ledger.recordDispatch(OWNER, project.id, {
    purpose: 'Schema', stepId: step.id,
    route: { role: 'coding', model: 'qwen2.5-coder:14b', reason: 'first attempt' },
  });
  ledger.startDispatch(OWNER, build.id, { runId: 'run-pm', sent: { brief: 'y' } });
  ledger.finishDispatch(OWNER, build.id, { outcome: 'completed', costMicro: 0 });

  const costs = pm.spend(OWNER, { projectId: project.id });
  assert.equal(costs.totalMicro, 1_500_000, 'a gateway turn was not counted');
  assert.equal(costs.calls, 2, 'both live writers are counted');
  assert.equal(costs.byProvider[0].name, 'Claude', 'the provider from a route was not read');
  assert.equal(costs.byRole[0].work, 'the code', 'the role from a route was not read');
  // A supervisor record names no provider, which is a gap in the record and not
  // a reason to drop the call from the tally.
  assert.ok(costs.byProvider.some(row => row.providerId === 'unknown'),
    'a dispatch with no provider was dropped instead of counted as unknown');

  const brief = pm.brief(OWNER, project.id);
  assert.equal(brief.handoffs.total, 2, 'the brief did not see the live handoffs');
  assert.equal(brief.handoffs.recent[0].to.providerId, 'unknown', 'the brief did not read the route');
  assert.match(brief.summary, /Spent \$1\.50 across 2 calls/, 'the summary did not total the live work');
  console.log('  live writers: gateway turns and build steps are counted, provider read from route');
}

// ── Spend, grouped the three ways a person asks ──────────────────────────────
{
  const { ledger, pm } = fresh();
  const shop = ledger.createProject(OWNER, { name: 'Shop rebuild' }, { actor: STEVE });
  const blog = ledger.createProject(OWNER, { name: 'Blog' }, { actor: STEVE });

  ran(ledger, pm, shop.id, { purpose: 'Design', role: 'design', route: { providerId: 'openai', model: 'gpt-6-astra' }, micro: 2_400_000 });
  ran(ledger, pm, shop.id, { purpose: 'Code', role: 'coding', route: { providerId: 'anthropic', model: 'claude-sonnet-5' }, micro: 1_100_000 });
  ran(ledger, pm, shop.id, { purpose: 'Copy', role: 'mechanical', route: { providerId: 'gemini', model: 'gemini-3.5-flash-lite' }, micro: 4_000 });
  ran(ledger, pm, blog.id, { purpose: 'Research', role: 'research', route: { providerId: 'gemini', model: 'gemini-3.8-flash' }, micro: 300_000, outcome: 'failed' });

  const all = pm.spend(OWNER);
  assert.equal(all.totalMicro, 3_804_000, 'the account total is the sum of every finished dispatch');
  assert.equal(all.calls, 4, 'every finished dispatch is a call');
  assert.equal(all.failedCalls, 1, 'a failed call still cost money and is counted as failed');

  const perShop = pm.spend(OWNER, { projectId: shop.id });
  assert.equal(perShop.totalMicro, 3_504_000, 'a project total excludes the other project');
  assert.equal(perShop.byProvider[0].name, 'ChatGPT', 'the biggest spender is first');
  assert.equal(perShop.byProvider[0].spent, '$2.40', 'spend per AI is readable money');
  assert.equal(perShop.byRole[0].work, 'the look and feel', 'spend per kind of work is in plain words');
  assert.equal(perShop.byProvider.at(-1).spent, 'under a cent', 'a fraction of a cent is not reported as zero');

  const queued = pm.handoff(OWNER, shop.id, { purpose: 'Not sent yet', role: 'coding', route: { providerId: 'anthropic', model: 'claude-sonnet-5' } });
  assert.equal(pm.spend(OWNER, { projectId: shop.id }).totalMicro, 3_504_000, 'a queued handoff has not spent anything');
  assert.ok(queued.dispatch.id, 'the queued handoff still exists');
  console.log('  spend: by AI, by kind of work, by project; queued work costs nothing');
}

// ── A cap refuses before the money is spent ──────────────────────────────────
{
  const { ledger, pm } = fresh();
  const project = ledger.createProject(OWNER, { name: 'Capped' }, { actor: STEVE });
  pm.setBudget(OWNER, { projectId: project.id, capMicro: 5_000_000, warnAtMicro: 4_000_000 });

  assert.equal(pm.guard(OWNER, { projectId: project.id, estimateMicro: 1_000_000 }).state, 'ok', 'well inside the cap');
  ran(ledger, pm, project.id, { purpose: 'Code', role: 'coding', route: { providerId: 'anthropic', model: 'claude-sonnet-5' }, micro: 3_900_000 });

  const warned = pm.guard(OWNER, { projectId: project.id, estimateMicro: 200_000 });
  assert.equal(warned.state, 'warn', 'crossing the warning point warns');
  assert.equal(warned.allow, true, 'a warning does not stop the work');
  assert.match(warned.sentence, /\$3\.90 of the \$5\.00/, 'the warning says how much of the limit is gone');

  const refused = pm.guard(OWNER, { projectId: project.id, estimateMicro: 2_000_000 });
  assert.equal(refused.allow, false, 'work that would breach the cap is refused');
  assert.equal(refused.state, 'over', 'and is reported as over');
  assert.match(refused.sentence, /stopped before spending/, 'the refusal says it stopped first');
  assert.match(refused.sentence, /Raise the limit/, 'the refusal says how to carry on');

  // The refusal is about the money this call would add, not only what is spent.
  assert.equal(pm.spend(OWNER, { projectId: project.id }).totalMicro < 5_000_000, true,
    'the cap was never actually exceeded, which is the point');

  assert.throws(() => pm.setBudget(OWNER, { projectId: project.id, capMicro: 1_000_000, warnAtMicro: 2_000_000 }),
    /never be seen/, 'a warning above the cap');

  // A project limit wins over the account one; without a project limit the
  // account ceiling still applies.
  pm.setBudget(OWNER, { capMicro: 1_000 });
  assert.equal(pm.guard(OWNER, { projectId: project.id, estimateMicro: 1 }).budget.scope, 'project', 'the project limit wins where it exists');
  const other = ledger.createProject(OWNER, { name: 'Uncapped project' }, { actor: STEVE });
  assert.equal(pm.guard(OWNER, { projectId: other.id, estimateMicro: 1 }).budget.scope, 'account', 'a project with no limit of its own uses the account one');
  console.log('  budget: warns, then refuses before the spend, project limit over account limit');
}

// ── A brief does not grow with the project ──────────────────────────────────
{
  const { ledger, pm } = fresh();
  const project = ledger.createProject(OWNER, { name: 'Shop rebuild' }, { actor: STEVE });
  const a = ledger.record(OWNER, project.id, 'plan_step', { title: 'Landing page' }, { actor: 'resident' });
  const b = ledger.record(OWNER, project.id, 'plan_step', { title: 'Checkout' }, { actor: 'resident' });
  const c = ledger.record(OWNER, project.id, 'plan_step', { title: 'Mail' }, { actor: 'resident' });
  ledger.move(OWNER, a.id, 'in_progress', { actor: 'resident' });
  ledger.move(OWNER, a.id, 'done', { actor: 'resident' });
  ledger.move(OWNER, c.id, 'blocked', { actor: 'resident' });
  ledger.record(OWNER, project.id, 'question', { title: 'Which payment provider?' }, { actor: 'resident' });

  for (let i = 0; i < 30; i += 1) {
    ran(ledger, pm, project.id, { purpose: `Chunk ${i}`, role: 'mechanical', route: { providerId: 'gemini', model: 'gemini-3.5-flash-lite' }, micro: 10_000 });
  }

  const brief = pm.brief(OWNER, project.id);
  assert.equal(brief.handoffs.total, 30, 'the brief counts every handoff');
  assert.equal(brief.handoffs.recent.length, 5, 'but returns only the newest few');
  assert.equal(brief.handoffs.recent[0].purpose, 'Chunk 29', 'newest first');
  assert.equal(brief.plan.total, 3, 'the plan is counted');
  assert.equal(brief.plan.done, 1, 'done steps are counted');
  assert.equal(brief.plan.next.title, 'Checkout', 'the next step is the one to do now, not a blocked one');
  assert.equal(brief.plan.blocked[0].title, 'Mail', 'blocked steps are named');
  assert.equal(brief.questions[0].title, 'Which payment provider?', 'what it is waiting on is named');
  assert.equal(brief.spend.totalMicro, 300_000, 'the brief totals the money');
  assert.match(brief.summary, /1 of 3 steps done/, 'the summary leads with progress');
  assert.match(brief.summary, /Next: Checkout/, 'the summary says what is next');
  assert.match(brief.summary, /Blocked: Mail/, 'the summary says what is stuck');
  assert.match(brief.summary, /Waiting on you/, 'the summary says what needs the person');
  assert.match(brief.summary, /Spent 30c across 30 calls/, 'the summary says the money');

  const grown = (() => {
    for (let i = 0; i < 40; i += 1) {
      ran(ledger, pm, project.id, { purpose: `More ${i}`, role: 'mechanical', route: { providerId: 'gemini', model: 'gemini-3.5-flash-lite' }, micro: 10_000 });
    }
    return pm.brief(OWNER, project.id);
  })();
  assert.equal(grown.handoffs.recent.length, 5, 'more than twice the work, same number of handoffs returned');
  assert.ok(JSON.stringify(grown).length < JSON.stringify(brief).length * 1.6,
    'the brief is bounded: 70 handoffs is not meaningfully bigger than 30');
  console.log('  brief: one bounded answer to "where are we", summary in plain words');
}

// ── Said once, not every turn ────────────────────────────────────────────────
//
// The first version of this rule said an interesting reason is always worth
// repeating. On a box with no keys at all, every single turn is "no key could
// take it, so this ran locally", so the person was told the same thing before
// every reply. Proved on a running server: three plain chat turns narrated
// three times. The signal is what changed, not what category it falls into.
{
  const { shouldNarrate, handKey } = require(MODULE);
  const chat = { providerId: 'ollama', model: 'qwen2.5:7b' };
  const code = { providerId: 'ollama', model: 'qwen2.5-coder:14b' };
  const said = (role, c, route) => handKey({ role, code: c, route });

  assert.equal(shouldNarrate({ role: 'chat', code: 'free_resident', route: chat, previous: null }), true,
    'the first hand in a conversation is not announced');
  assert.equal(shouldNarrate({ role: 'chat', code: 'free_resident', route: chat, previous: said('chat', 'free_resident', chat) }), false,
    'the same hand announces itself twice');
  assert.equal(shouldNarrate({ role: 'coding', code: 'free_resident', route: code, previous: said('chat', 'free_resident', chat) }), true,
    'the work changing kind is not announced');
  assert.equal(shouldNarrate({ role: 'coding', code: 'free_resident', route: code, previous: said('coding', 'free_resident', code) }), false,
    'three coding turns in a row say it three times');
  assert.equal(shouldNarrate({ role: 'coding', code: 'you_chose', route: code, previous: said('coding', 'free_resident', code) }), true,
    'the reason changing is not announced');
  assert.equal(shouldNarrate({ role: 'coding', code: 'best_for_the_job', route: null, previous: said('coding', 'x', code) }), true,
    'nothing being available is not announced');
  console.log('  narration: said when the hand changes, silent when it has not');
}

// ── Money reads like money ───────────────────────────────────────────────────
{
  assert.equal(money(0), '$0.00', 'nothing is nothing');
  assert.equal(money(null), '$0.00', 'a missing cost is nothing');
  assert.equal(money(4_000), 'under a cent', 'a fraction of a cent says so');
  assert.equal(money(300_000), '30c', 'cents are cents');
  assert.equal(money(2_400_000), '$2.40', 'dollars are dollars');
  assert.equal(providerName('xai'), 'Grok', 'providers are named the way a person knows them');
  assert.equal(providerName('deepseek'), 'DeepSeek', 'DeepSeek is named');
  assert.equal(providerName('nobody'), 'nobody', 'an unknown provider falls back to its id');
  console.log('  money and names: readable, and never rounds a real cost to zero');
}

// ── Every defence removed in turn must fail a named test ─────────────────────
{
  const source = fs.readFileSync(MODULE, 'utf8');
  const sabotage = [
    ['a handoff without its reason', 'why: { code: choice.code, sentence: choice.sentence },', 'why: null,'],
    ['spend blind to the shape the live writers use', 'route.provider || to.providerId', 'to.providerId'],
    ['a cap that reports instead of refusing', 'if (projected > budget.capMicro) {', 'if (false) {'],
    ['a cap that ignores the cost of this call', 'const projected = already + estimate;', 'const projected = already;'],
    ['a brief that returns everything', 'dispatches.slice(-Math.max(0, handoffs))', 'dispatches.slice(0)'],
    ['a default explanation that outranks the person\'s own choice', "if (route.chosenBy === 'person') {", 'if (false) {'],
    ['a sub-cent cost rounded away', "if (dollars < 0.01) return 'under a cent';", ''],
    ['counting queued work as spent', "item.status === 'completed' || item.status === 'failed'", 'true'],
    ['narrating the same hand on every turn', 'return handKey({ role, code, route }) !== previous;', 'return true;'],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-break-'));
  for (const [what, from, to] of sabotage) {
    assert.ok(source.includes(from), `${what}: the line to remove is not there any more (${from})`);
    const broken = path.join(tmp, 'projectManager.js');
    fs.writeFileSync(broken, source.replace(from, to));
    const probe = path.join(tmp, 'probe.js');
    fs.writeFileSync(probe, fs.readFileSync(__filename, 'utf8')
      .replace("const MODULE = path.join(__dirname, 'projectManager.js');", `const MODULE = ${JSON.stringify(broken)};`)
      .replace("path.join(__dirname, 'projectLedger.js')", JSON.stringify(path.join(__dirname, 'projectLedger.js')))
      .replace(/\n\/\/ ── Every defence removed[\s\S]*$/, '\n'));
    const run = spawnSync(process.execPath, [probe], { cwd: __dirname, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `${what}: removed it and every test still passed`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  break tests: ${sabotage.length} defences removed, each one failed a test`);
}

console.log('project manager tests passed');
