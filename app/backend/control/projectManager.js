'use strict';

// The Resident as project manager.
//
// Routing already decides which model does a piece of work, the ledger already
// records every handoff as a dispatch with what it cost, and routing fit already
// demotes a model that keeps getting corrected. What none of them did was tell
// the person any of it. A route was a fact in a table with no reason attached,
// spend was a number per account rather than per AI or per project, and
// answering "where are we" meant reading the whole ledger back.
//
// This file is the part that explains and totals. It holds no routing policy of
// its own: it is handed the decision routing already made and turns it into a
// sentence, a running total and a bounded brief. If it disagreed with the router
// there would be two policies and the explanation would eventually be a lie.
//
// The rules this file exists to hold:
//
// - Money is counted from the ledger's own dispatch results and nowhere else.
//   A second tally would drift from the first, and the one with the approval
//   trail behind it has to win.
// - A budget refuses before the call, not after. A cap that reports an overspend
//   once the money is gone is a report, not a cap.
// - A brief is bounded. The whole point of a project manager is that asking it
//   where things stand costs a predictable, small amount, so `brief` takes the
//   newest few handoffs and counts the rest rather than returning everything.
// - Every sentence names the model and the reason together. "Design went to
//   GPT-6 Astra" without the because is not an explanation.

// What each role means in plain words, for sentences a person reads. These are
// descriptions of the existing ROLE_ROUTES roles in residentGateway, not a
// second opinion about them.
const ROLE_WORK = Object.freeze({
  design: 'the look and feel',
  reasoning: 'the hard thinking',
  coding: 'the code',
  research: 'the looking-up',
  mechanical: 'the bulk wording',
  chat: 'the conversation',
});

// Model and provider ids are wire values. These are the names to show.
const PROVIDER_NAMES = Object.freeze({
  anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', xai: 'Grok',
  deepseek: 'DeepSeek', groq: 'Groq', ollama: 'the Resident on this box',
  byog: 'your own machine',
});

function providerName(providerId) {
  return PROVIDER_NAMES[providerId] || String(providerId || 'an unnamed provider');
}

// Micro-dollars in, something a person reads out. Under a cent is said as such
// rather than rounded to $0.00, because "it cost nothing" and "it cost less
// than a cent" are different claims.
function money(micro) {
  const value = Number(micro);
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  const dollars = value / 1e6;
  if (dollars < 0.01) return 'under a cent';
  if (dollars < 1) return `${Math.round(dollars * 100)}c`;
  return `$${dollars.toFixed(2)}`;
}

// Why this model and not another. `code` is for screens and tests, `sentence`
// is for the conversation. The order matters: the first branch that matches is
// the real reason, so an explicit choice by the person is never explained away
// as a default.
function explainChoice({ task, role, intent = null, route, considered = [], budgetState = null } = {}) {
  if (!route) {
    return {
      code: 'nothing_available',
      sentence: 'Nothing can do this work right now: no key answered, your machine is not connected, and this box has no local model.',
    };
  }
  const who = providerName(route.providerId);
  const work = ROLE_WORK[role] || 'this';
  const model = route.model ? ` (${route.model})` : '';
  const because = intent ? `, because ${intent}` : '';
  const alsoRan = considered
    .filter(pair => `${pair[0]}/${pair[1]}` !== `${route.providerId}/${route.model}`)
    .map(pair => providerName(pair[0]));
  const ahead = alsoRan.length ? ` It was ahead of ${[...new Set(alsoRan)].join(' and ')} for this.` : '';

  if (route.source === 'device' || route.providerId === 'byog') {
    return {
      code: 'your_machine',
      sentence: `I'm sending ${work} to ${who}${route.byog && route.byog.name ? ` (${route.byog.name})` : ''}${because}. It runs on hardware you already own, so this part costs nothing.`,
    };
  }
  if (route.chosenBy === 'person') {
    return { code: 'you_chose', sentence: `I'm sending ${work} to ${who}${model} because you told me to use it for ${work}.` };
  }
  if (route.chosenBy === 'demoted') {
    return {
      code: 'demoted',
      sentence: `I'm sending ${work} to ${who}${model}${because}. The model I'd normally use for this has been corrected by you too often to keep first place.`,
    };
  }
  if (route.resident) {
    return {
      code: 'free_resident',
      sentence: `I'm doing ${work} on ${who}${model}${because}. No key you've added can take it, so this runs locally and free rather than not at all.`,
    };
  }
  if (budgetState === 'warn' || budgetState === 'over') {
    return {
      code: 'cheaper_for_budget',
      sentence: `I'm sending ${work} to ${who}${model} because this project is close to the limit you set, and this is the cheapest model that can still do it.`,
    };
  }
  return { code: 'best_for_the_job', sentence: `I'm sending ${work} to ${who}${model}${because}.${ahead}` };
}

// Whether this handoff is worth saying out loud, which is a different question
// from whether it was recorded. Every turn is recorded; narrating every turn
// would mean telling somebody "I'm doing the conversation on Groq" before each
// reply, and a running commentary nobody asked for is noise that teaches people
// to ignore the thing that matters.
//
// The signal is novelty, not category. The first attempt here said an
// interesting reason is always worth repeating, which on a box with no keys at
// all means every single turn is "no key could take it, so this ran locally"
// and the person is told the same thing forever. What a person wants to know is
// what CHANGED: the kind of work, the model, or the reason it went there.
//
// So the hand is a key of all three, and it is said when the key differs from
// the last thing said in this conversation. First time always, repeats never,
// any change yes. Three coding questions in a row that all go to the same model
// for the same reason say it once.
function handKey({ role = 'chat', code = null, route = null } = {}) {
  return `${role}|${code || '-'}|${route ? `${route.providerId}/${route.model}` : '-'}`;
}

function shouldNarrate({ role = 'chat', code = null, route = null, previous = null } = {}) {
  if (!route) return true;
  return handKey({ role, code, route }) !== previous;
}

function createProjectManager({ db, ledger, now = () => new Date() } = {}) {
  if (!db || !ledger) throw new Error('the project manager needs the database and the ledger');

  // A limit is per account, and optionally per project. The project row wins
  // where it exists, so "no more than $40 on the shop rebuild" can sit inside a
  // looser account-wide ceiling.
  db.exec(`
    CREATE TABLE IF NOT EXISTS resident_budget (
      account_id   TEXT NOT NULL,
      project_id   TEXT NOT NULL DEFAULT '',
      cap_micro    INTEGER,
      warn_micro   INTEGER,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (account_id, project_id)
    );
  `);

  function setBudget(accountId, { projectId = '', capMicro = null, warnAtMicro = null } = {}) {
    const cap = capMicro == null ? null : Math.max(0, Math.round(Number(capMicro)));
    const warn = warnAtMicro == null ? null : Math.max(0, Math.round(Number(warnAtMicro)));
    if (cap != null && warn != null && warn > cap) throw new Error('A warning above the cap would never be seen before the refusal');
    db.prepare(`INSERT INTO resident_budget (account_id, project_id, cap_micro, warn_micro, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(account_id, project_id) DO UPDATE SET cap_micro=excluded.cap_micro, warn_micro=excluded.warn_micro, updated_at=excluded.updated_at`)
      .run(String(accountId), String(projectId || ''), cap, warn, now().toISOString());
    return getBudget(accountId, projectId);
  }

  function getBudget(accountId, projectId = '') {
    const row = (projectId && db.prepare('SELECT * FROM resident_budget WHERE account_id=? AND project_id=?').get(String(accountId), String(projectId)))
      || db.prepare("SELECT * FROM resident_budget WHERE account_id=? AND project_id=''").get(String(accountId));
    if (!row) return null;
    return {
      scope: row.project_id ? 'project' : 'account',
      projectId: row.project_id || null,
      capMicro: row.cap_micro,
      warnAtMicro: row.warn_micro,
      updatedAt: row.updated_at,
    };
  }

  // Only dispatches that finished, because a queued one has not spent anything
  // and an in-flight one has not reported yet. The entity filter is done in SQL
  // by the ledger, so this reads one project's handoffs and not its whole tree.
  function finishedDispatches(accountId, projectId) {
    return ledger.list(accountId, projectId, { entity: 'dispatch' })
      .filter(item => item.status === 'completed' || item.status === 'failed');
  }

  function costOf(dispatch) {
    const micro = dispatch && dispatch.result && dispatch.result.costMicro;
    return Number.isFinite(Number(micro)) ? Number(micro) : 0;
  }

  // Who did this piece of work, out of the record the ledger already keeps.
  // `route` is what residentGateway has written on every chat turn since stage
  // 2 and what supervisor writes for every build step, so it is the shape, and
  // this reads it rather than asking for a new one. A second shape beside those
  // would have meant reporting zero against the only data that exists.
  // `to` is still accepted because an earlier version of `handoff` wrote it and
  // a ledger is append-only.
  function whoDid(dispatch) {
    const route = (dispatch && dispatch.route) || {};
    const to = (dispatch && dispatch.to) || {};
    return {
      providerId: route.provider || to.providerId || 'unknown',
      model: route.model || to.model || null,
      role: route.role || (dispatch && dispatch.role) || 'chat',
      source: route.source || to.source || null,
      reason: route.reason || null,
    };
  }

  // Spend for one project, or for every project when none is named. Grouped the
  // three ways a person actually asks: which AI, which kind of work, which
  // project.
  function spend(accountId, { projectId = null } = {}) {
    const ids = projectId ? [String(projectId)] : ledger.projects(accountId).map(project => project.id);
    const byProvider = new Map();
    const byRole = new Map();
    const byProject = [];
    let totalMicro = 0;
    let calls = 0;
    let failed = 0;

    for (const id of ids) {
      let projectMicro = 0;
      let projectCalls = 0;
      for (const dispatch of finishedDispatches(accountId, id)) {
        const micro = costOf(dispatch);
        const { providerId: provider, model, role } = whoDid(dispatch);
        const keyed = `${provider}/${model || '-'}`;
        const seen = byProvider.get(keyed) || { providerId: provider, name: providerName(provider), model, micro: 0, calls: 0 };
        seen.micro += micro; seen.calls += 1;
        byProvider.set(keyed, seen);
        const seenRole = byRole.get(role) || { role, work: ROLE_WORK[role] || role, micro: 0, calls: 0 };
        seenRole.micro += micro; seenRole.calls += 1;
        byRole.set(role, seenRole);
        totalMicro += micro; calls += 1; projectMicro += micro; projectCalls += 1;
        if (dispatch.status === 'failed') failed += 1;
      }
      byProject.push({ projectId: id, micro: projectMicro, calls: projectCalls, spent: money(projectMicro) });
    }

    const descending = (a, b) => b.micro - a.micro;
    return {
      totalMicro,
      spent: money(totalMicro),
      calls,
      failedCalls: failed,
      byProvider: [...byProvider.values()].sort(descending).map(row => ({ ...row, spent: money(row.micro) })),
      byRole: [...byRole.values()].sort(descending).map(row => ({ ...row, spent: money(row.micro) })),
      byProject: projectId ? byProject : byProject.sort(descending),
    };
  }

  // Asked before a call is made, never after. `estimateMicro` is what the caller
  // thinks this dispatch will cost; a cap is breached by what is already spent
  // plus what is about to be.
  function guard(accountId, { projectId = null, estimateMicro = 0 } = {}) {
    const budget = getBudget(accountId, projectId || '');
    const already = spend(accountId, { projectId }).totalMicro;
    const estimate = Math.max(0, Number(estimateMicro) || 0);
    if (!budget || budget.capMicro == null) {
      return { allow: true, state: 'no_limit', budget, spentMicro: already, sentence: null };
    }
    const projected = already + estimate;
    if (projected > budget.capMicro) {
      return {
        allow: false,
        state: 'over',
        budget,
        spentMicro: already,
        sentence: `I've stopped before spending anything more. ${budget.scope === 'project' ? 'This project' : 'This account'} has a limit of ${money(budget.capMicro)}, ${money(already)} of it is spent, and this next piece of work would take it past that. Raise the limit or tell me to use a cheaper model and I'll carry on.`,
      };
    }
    if (budget.warnAtMicro != null && projected >= budget.warnAtMicro) {
      return {
        allow: true,
        state: 'warn',
        budget,
        spentMicro: already,
        sentence: `Heads up: ${money(already)} of the ${money(budget.capMicro)} limit is spent. I'll keep going and start preferring cheaper models for the mechanical work.`,
      };
    }
    return { allow: true, state: 'ok', budget, spentMicro: already, sentence: null };
  }

  // Record a handoff and the reason for it, in one place, so a dispatch can
  // never exist without the explanation that goes with it. The returned
  // sentence is what the Resident says out loud.
  function handoff(accountId, projectId, { stepId = null, purpose, task = null, role = 'chat', route, considered = [], intent = null, budgetState = null, actor = 'resident', idempotencyKey = null } = {}) {
    if (!purpose) throw new Error('A handoff says what it is for');
    const choice = explainChoice({ task, role, intent, route, considered, budgetState });
    const fields = {
      purpose: String(purpose).slice(0, 500),
      ...(stepId ? { stepId: String(stepId) } : {}),
      // The established shape, so /api/resident/dispatches and everything else
      // already reading `route` keeps working. `why` is additive: `route.reason`
      // is a short phrase and this is the sentence a person reads.
      route: {
        role: String(role),
        ...(task ? { task: String(task) } : {}),
        provider: route ? route.providerId : null,
        model: route ? (route.model || null) : null,
        source: route ? (route.source || null) : null,
        reason: intent || null,
      },
      why: { code: choice.code, sentence: choice.sentence },
    };
    const dispatch = ledger.recordDispatch(accountId, projectId, fields, { actor, idempotencyKey });
    return { dispatch, sentence: choice.sentence, code: choice.code };
  }

  // One bounded answer to "where are we". Counts everything and returns only
  // the newest few handoffs, so the size of this does not grow with the size of
  // the project.
  function brief(accountId, projectId, { handoffs = 5 } = {}) {
    const snapshot = ledger.snapshot(accountId, projectId);
    const tally = (items, status) => items.filter(item => item.status === status).length;
    const dispatches = ledger.list(accountId, projectId, { entity: 'dispatch' });
    const recent = dispatches.slice(-Math.max(0, handoffs)).reverse().map(dispatch => ({
      id: dispatch.id,
      purpose: dispatch.purpose,
      to: (({ providerId, model }) => ({ providerId, model }))(whoDid(dispatch)),
      status: dispatch.status,
      why: (dispatch.why && dispatch.why.sentence) || null,
      spent: money(costOf(dispatch)),
    }));
    const costs = spend(accountId, { projectId });
    const limit = guard(accountId, { projectId });
    const plan = snapshot.plan || [];
    const next = plan.find(step => step.status === 'in_progress') || plan.find(step => step.status === 'pending') || null;
    const blocked = plan.filter(step => step.status === 'blocked');
    const openQuestions = (snapshot.questions || []).filter(question => question.status === 'open');

    const lines = [];
    lines.push(`${snapshot.project.name}: ${tally(plan, 'done')} of ${plan.length} steps done.`);
    if (next) lines.push(`Next: ${next.title}.`);
    if (blocked.length) lines.push(`Blocked: ${blocked.map(step => step.title).join('; ')}.`);
    if (openQuestions.length) lines.push(`Waiting on you: ${openQuestions.map(question => question.title).join('; ')}.`);
    lines.push(costs.byProvider.length
      ? `Spent ${costs.spent} across ${costs.calls} calls — ${costs.byProvider.map(row => `${row.name} ${row.spent}`).join(', ')}.`
      : 'Nothing spent yet.');
    if (limit.sentence) lines.push(limit.sentence);

    return {
      project: snapshot.project,
      plan: {
        total: plan.length,
        done: tally(plan, 'done'),
        inProgress: tally(plan, 'in_progress'),
        pending: tally(plan, 'pending'),
        blocked: blocked.map(step => ({ id: step.id, title: step.title })),
        next: next && { id: next.id, title: next.title, status: next.status },
      },
      objectives: { open: tally(snapshot.objectives || [], 'open'), met: tally(snapshot.objectives || [], 'met') },
      questions: openQuestions.map(question => ({ id: question.id, title: question.title })),
      rules: {
        decisions: (snapshot.decisions || []).filter(item => item.status === 'settled').length,
        constraints: (snapshot.constraints || []).filter(item => item.status === 'active').length,
      },
      handoffs: { total: dispatches.length, recent },
      spend: costs,
      budget: { ...limit, sentence: limit.sentence },
      // The thing to read aloud. Everything above is for a screen.
      summary: lines.join(' '),
    };
  }

  return { setBudget, getBudget, spend, guard, handoff, brief, explainChoice, shouldNarrate, handKey, money, providerName };
}

module.exports = { createProjectManager, explainChoice, shouldNarrate, handKey, ROLE_WORK, PROVIDER_NAMES, providerName, money };
