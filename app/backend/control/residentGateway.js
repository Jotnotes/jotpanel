'use strict';

// ── The Resident gateway (Stage 2) ───────────────────────────────
//
// Every orchestrated chat turn passes through here before any model is called.
// The server works out what kind of work the turn is (the browser's task is a
// hint), picks the role that does that work, and writes a dispatch record in
// the project ledger naming the route and why, before the call leaves the box.
//
// Routing targets roles, not model names (settled item J). The defaults below
// are decision 3's current preference and are data: a host's routing_table
// overrides them by role or by the older task names.

// Refreshed 2026-09-25 from the same provider documentation as
// control/modelCatalogue.json. These named gpt-4o, gemini-2.0-flash and
// gemini-1.5-pro for two generations after they were superseded, and nothing
// complained: a preference for a model that no longer exists is skipped rather
// than raised, so the list silently shortened instead of breaking.
const ROLE_ROUTES = Object.freeze({
  design:     [['openai', 'gpt-6-astra'], ['anthropic', 'claude-sonnet-5'], ['gemini', 'gemini-3.8-flash']],
  reasoning:  [['openai', 'gpt-6-astra'], ['anthropic', 'claude-sonnet-5'], ['anthropic', 'claude-opus-5'], ['xai', 'grok-4.7']],
  coding:     [['anthropic', 'claude-sonnet-5'], ['openai', 'gpt-6-sol'], ['groq', 'llama-3.3-70b-versatile']],
  research:   [['gemini', 'gemini-3.8-flash'], ['openai', 'gpt-6-sol'], ['anthropic', 'claude-sonnet-5']],
  mechanical: [['gemini', 'gemini-3.5-flash-lite'], ['groq', 'llama-3.3-70b-versatile'], ['openai', 'gpt-6-luna'], ['anthropic', 'claude-haiku-4-5']],
  chat:       [['groq', 'llama-3.3-70b-versatile'], ['gemini', 'gemini-3.5-flash-lite'], ['anthropic', 'claude-haiku-4-5'], ['openai', 'gpt-6-luna']],
});

// The task names the rest of the panel already uses, and the role each one is.
const TASK_ROLE = Object.freeze({
  code: 'coding', build: 'coding', reason: 'reasoning', creative: 'design',
  design: 'design', research: 'research', summarize: 'mechanical', chat: 'chat',
});

// Plain rules, run first and fast (decision 6). Stage 3 adds the model step.
const RULES = [
  ['code', /```|\b(code|function|bug|error|exception|stack ?trace|regex|sql|javascript|typescript|python|css|html|api endpoint|compile|refactor)\b/i],
  ['creative', /\b(design|layout|logo|colou?r scheme|palette|typography|brand|mock-?up|wireframe|landing page look)\b/i],
  ['research', /\b(research|look up|find out|compare|sources?|latest|news|market|competitors?)\b/i],
  ['summarize', /\b(summari[sz]e|tl;?dr|rewrite|reword|translate|proofread|format (this|it)|bullet points)\b/i],
  ['reason', /\b(why|should (i|we)|plan|strategy|trade-?offs?|pros and cons|decide|which is better)\b/i],
];

const MODE_TASK = Object.freeze({ build: 'build' });
const ROLE_TASK = Object.freeze({ design: 'creative', reasoning: 'reason', coding: 'code', research: 'research', mechanical: 'summarize', chat: 'chat' });

// How the person seems (bundle 3, state-tags.md). It changes the register of
// the answer, never what anyone is allowed to do.
const STATES = Object.freeze(['frustrated', 'confused', 'skeptical', 'ready-to-act', 'curious', 'neutral']);
const STATE_RULES = [
  ['frustrated', /\b(wtf|ffs|what the (hell|fuck)|damn|dammit|god ?dammit|shit|crap|useless|ridiculous|annoying|sick of|fed up|still (not|doesn'?t|isn'?t|broken))\b|!{2,}/i],
  ['confused', /\b(what am i looking at|what is this|i don'?t (get|understand)|confused|lost|makes no sense|no idea what)\b|\?{2,}/i],
  ['skeptical', /\b(why (not|would i|should i) (just )?use|don'?t trust|do i (even |really )?need|is (this|it) (even )?worth|are you sure|really\?)\b/i],
  ['ready-to-act', /\b(go ahead|do it|let'?s (go|do it|start)|start now|ship it|set it up|yes please|make it happen)\b/i],
  ['curious', /\b(how does|what if|curious|i wonder|explain how|tell me (about|how))\b/i],
];

function readState(text = '') {
  for (const [state, pattern] of STATE_RULES) if (pattern.test(String(text))) return state;
  return 'neutral';
}

// The model is asked for the role only. On the labelled set it read the
// person's state worse than the plain rules do, so state stays with the rules.
const MODEL_BRIEF = [
  'Which one role fits the job in this message?',
  'design: how something looks, such as layout, colours, branding, a page that looks dated.',
  'reasoning: deciding what to do, such as plans, choices, trade-offs, advice.',
  'coding: making or fixing something technical, such as code, errors, config, DNS, email setup, databases, servers.',
  'research: finding facts out in the world, such as comparing hosts, prices, products, what is current.',
  'mechanical: reworking text the person already has, such as summarise, shorten, rewrite, translate, list, extract, format.',
  'chat: greetings, thanks, questions about the assistant itself, anything else.',
  'Reply with JSON only and exactly one role, for example {"role":"coding","confidence":0.8}',
].join('\n');

function parseModelRead(output) {
  const found = String(output || '').match(/\{[^{}]*\}/);
  if (!found) return null;
  let value;
  try { value = JSON.parse(found[0]); } catch { return null; }
  const confidence = Number(value && value.confidence);
  if (!value || !ROLE_TASK[value.role] || !(confidence >= 0 && confidence <= 1)) return null;
  return { role: value.role, confidence };
}

// Rules first; then, if a local model is there, a short cached call inside the
// time budget. Over budget or unreadable, the turn keeps the rules' reading and
// says so (decision 6).
function createUnderstanding({ callModel = null, budgetMs = 2000, cacheSize = 500, slowLimit = 3, restMs = 10 * 60000, now = () => Date.now() } = {}) {
  const cache = new Map();
  // A machine too slow for the model inside the budget would otherwise make
  // every turn wait the whole budget before using the rules. After a few misses
  // in a row the model is left alone for a while, then tried again.
  let slowRun = 0;
  let restUntil = 0;
  return async function understand({ text = '', mode = null, taskHint = null } = {}) {
    const rules = { ...interpret({ text, mode, taskHint }), state: readState(text), confidence: null, how: 'rules' };
    if (MODE_TASK[mode] || !callModel || !String(text).trim()) return rules;
    const key = `${mode || ''}\n${String(text).slice(0, 2000)}`;
    let read = cache.get(key);
    if (read === undefined) {
      if (now() < restUntil) return { ...rules, how: 'rules (model too slow on this machine)' };
      let timer;
      const budget = typeof budgetMs === 'function' ? await budgetMs() : budgetMs;
      const late = new Promise(resolve => { timer = setTimeout(() => resolve('over budget'), budget); });
      const answer = await Promise.race([Promise.resolve().then(() => callModel(MODEL_BRIEF, String(text).slice(0, 2000))).catch(() => 'model failed'), late]);
      clearTimeout(timer);
      if (answer === 'over budget') {
        slowRun += 1;
        if (slowRun >= slowLimit) { restUntil = now() + restMs; slowRun = 0; }
      } else {
        slowRun = 0;
      }
      if (answer === 'over budget' || answer === 'model failed') return { ...rules, how: `rules (${answer})` };
      read = parseModelRead(answer);
      if (cache.size >= cacheSize) cache.delete(cache.keys().next().value);
      cache.set(key, read);
    }
    if (!read) return { ...rules, how: 'rules (model output unreadable)' };
    const task = ROLE_TASK[read.role];
    return {
      task, role: read.role, reason: `Echo read it as ${read.role} work`,
      state: rules.state,
      confidence: read.confidence, how: 'model',
    };
  };
}

function interpret({ text = '', mode = null, taskHint = null } = {}) {
  if (MODE_TASK[mode]) return { task: MODE_TASK[mode], role: TASK_ROLE[MODE_TASK[mode]], reason: `${mode} mode` };
  for (const [task, pattern] of RULES) {
    if (pattern.test(String(text))) return { task, role: TASK_ROLE[task], reason: `the request reads as ${TASK_ROLE[task]} work` };
  }
  if (taskHint && TASK_ROLE[taskHint]) return { task: taskHint, role: TASK_ROLE[taskHint], reason: `no signal in the words; the screen suggested ${taskHint}` };
  return { task: 'chat', role: 'chat', reason: 'conversation' };
}

// The ordered candidates for a turn: a host's own table first (by task, then by
// role), then the role defaults.
function candidatesFor(task, hostRoutes = {}) {
  const role = TASK_ROLE[task] || 'chat';
  return hostRoutes[task] || hostRoutes[role] || ROLE_ROUTES[role];
}

function createResidentGateway({ ledger, runId, understand = createUnderstanding() }) {
  if (!ledger || !runId) throw new Error('the local-model gateway needs the ledger and a run id');

  // Every conversation belongs to a project. One that names none goes to the
  // account's General project, created the first time it is needed.
  function projectFor(accountId, conversationId) {
    const bound = conversationId ? ledger.projectFor(accountId, conversationId) : null;
    if (bound) return bound;
    const general = ledger.createProject(accountId, { name: 'General' }, { actor: 'resident', idempotencyKey: 'general-project' });
    if (conversationId) ledger.bindConversation(accountId, conversationId, general.id, { actor: 'resident' });
    return general.id;
  }

  async function open(accountId, { conversationId = null, mode = null, taskHint = null, text = '' } = {}) {
    const reading = await understand({ text, mode, taskHint });
    return { accountId: String(accountId), projectId: projectFor(accountId, conversationId), conversationId, mode, ...reading };
  }

  // Recorded and marked in flight before the call. `sent` is kept as hashes.
  function dispatch(turn, route, { explicit = false, sent = {} } = {}) {
    const record = ledger.recordDispatch(turn.accountId, turn.projectId, {
      purpose: `${turn.mode || 'direct'} turn`,
      route: {
        role: turn.role, task: turn.task, provider: route.providerId, model: route.model, source: route.source || null,
        reason: explicit ? 'the person chose this model' : turn.reason,
        understood: { state: turn.state, how: turn.how, confidence: turn.confidence },
      },
    });
    ledger.startDispatch(turn.accountId, record.id, { runId, sent });
    return record.id;
  }

  function finish(turn, dispatchId, { error = null, costMicro = null, latencyMs = null, usage = null, checks = [] } = {}) {
    return ledger.finishDispatch(turn.accountId, dispatchId, {
      outcome: error ? 'failed' : 'completed', error, costMicro, latencyMs, usage, checks,
    });
  }

  // The project slice a brief is written from: the rules in force and what is
  // still required.
  function projectContext(turn) {
    const snap = ledger.snapshot(turn.accountId, turn.projectId);
    return {
      name: snap.project.name,
      rules: { decisions: snap.decisions.filter(item => item.status === 'settled' && item.kind !== 'plan'), constraints: snap.constraints.filter(item => item.status === 'active') },
      requirements: snap.requirements.filter(item => item.status === 'open'),
    };
  }

  return { open, dispatch, finish, projectContext, projectFor };
}

module.exports = { createResidentGateway, createUnderstanding, interpret, readState, parseModelRead, candidatesFor, ROLE_ROUTES, TASK_ROLE, MODEL_BRIEF };
