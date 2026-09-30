'use strict';

// ── The supervisor and the progress monitor (Stage 5) ────────────
//
// Plain code, not a model (ORCHESTRATION §5). The supervisor checks each
// answer against the project's rules in force and the step's acceptance
// criteria. The monitor watches a step's attempts for a model repeating
// itself, flipping between two answers, or saying "done" when the criteria say
// otherwise, and answers in order: narrow the task, switch model, stop and ask.
//
// A rule is checkable when it carries `forbid`: patterns the person approved
// along with the rule. A step is checkable when it carries `criteria`, each a
// name and a pattern the answer must contain.

const RECOMMENDS = /\b(recommend|suggest|propose|should (switch|move|use|consider)|would be better|consider (switching|moving|using))\b/i;
const CLAIMS_DONE = /\b(done|complete[d]?|finished|all set|implemented)\b/i;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'has', 'have', 'been', 'now', 'are', 'was', 'you', 'your', 'our', 'its', 'into', 'from', 'will', 'here']);

function patterns(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map(source => {
    try { return String(source).length <= 200 ? new RegExp(source, 'i') : null; } catch { return null; }
  }).filter(Boolean);
}

function split(output) {
  const code = [];
  const prose = String(output || '').replace(/```[\s\S]*?```/g, block => { code.push(block); return ' '; });
  return { code: code.join('\n'), prose };
}

// One answer against the rules and the criteria.
function review(output, { rules = [], criteria = [] } = {}) {
  const text = String(output || '');
  const { code, prose } = split(text);
  const breaches = [];
  const proposals = [];
  for (const rule of rules) {
    for (const pattern of patterns(rule.forbid)) {
      if (pattern.test(code)) { breaches.push({ ruleId: rule.id, title: rule.title, found: code.match(pattern)[0] }); break; }
      const sentence = prose.split(/(?<=[.!?])\s+/).find(line => pattern.test(line) && RECOMMENDS.test(line));
      if (sentence) { proposals.push({ ruleId: rule.id, title: rule.title, text: sentence.trim().slice(0, 500) }); break; }
    }
  }
  const unmet = criteria.filter(item => !patterns([item.pattern]).some(p => p.test(text))).map(item => item.name);
  const empty = !text.trim();
  return {
    verdict: !empty && !breaches.length && !unmet.length ? 'accept' : 'reject',
    empty, breaches, proposals, unmet,
    met: criteria.length - unmet.length,
    claimsDone: CLAIMS_DONE.test(prose),
  };
}

// The correction, citing the rules by name.
function correctionBrief(result) {
  const lines = [];
  if (result.empty) lines.push('Your last answer was empty.');
  for (const breach of result.breaches) lines.push(`It broke a settled rule: "${breach.title}" (it used ${breach.found}). Keep to the rule.`);
  if (result.unmet.length) lines.push(`It did not yet meet: ${result.unmet.join(', ')}.`);
  return lines.join('\n');
}

function words(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9_]+/).filter(word => word.length > 2 && !STOPWORDS.has(word)));
}

function similar(a, b, threshold = 0.7) {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return true;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared) >= threshold;
}

// Looks at a step's attempts, oldest first: { output, review }. A signal needs
// no progress as well as the pattern, so an honest build that keeps adding to
// the same answer is never flagged for looking like its last attempt.
function assess(attempts) {
  const last = attempts[attempts.length - 1];
  if (!last || last.review.verdict === 'accept') return null;
  const recent = attempts.slice(-4);
  const progress = recent.length > 1 ? last.review.met > recent[0].review.met : last.review.met > 0;
  if (progress) return null;
  if (last.review.claimsDone && last.review.unmet.length) {
    return { signal: 'claims done', detail: `said it was done with ${last.review.unmet.join(', ')} still unmet` };
  }
  const outs = attempts.map(item => item.output);
  const n = outs.length;
  if (n >= 3 && similar(outs[n - 1], outs[n - 2]) && similar(outs[n - 2], outs[n - 3])) {
    return { signal: 'repeating', detail: 'the last three answers say the same thing' };
  }
  if (n >= 4 && similar(outs[n - 1], outs[n - 3]) && similar(outs[n - 2], outs[n - 4]) && !similar(outs[n - 1], outs[n - 2])) {
    return { signal: 'going in circles', detail: 'it keeps switching between the same two answers' };
  }
  return null;
}

// Runs one plan step to an outcome with the specialists given, best first,
// writing everything to the ledger: a dispatch per attempt, every answer as an
// artifact (accepted or rejected), a model's recommendation to change a rule as
// a proposal for the person, and the step done or blocked with its reason. The
// rules are only read, never written.
async function superviseStep({ ledger, accountId, stepId, specialists, runId, prepareBrief, maxAttempts = 8, failuresPerModel = 2, onOutcome = () => {} }) {
  const step = ledger.get(accountId, stepId);
  if (!step || step.entity !== 'plan_step') throw new Error('No such plan step');
  const projectId = step.projectId;
  // A crash between accepting an answer and marking the step done leaves the
  // answer accepted. The step is finished from the record, never run again.
  const kept = ledger.list(accountId, projectId, { entity: 'artifact', status: 'accepted' }).find(item => item.stepId === stepId);
  if (kept) {
    if (step.status === 'pending' || step.status === 'blocked') ledger.move(accountId, stepId, 'in_progress', { actor: 'resident' });
    if (step.status !== 'done') ledger.move(accountId, stepId, 'done', { actor: 'resident', patch: { acceptedArtifact: kept.id } });
    return { outcome: 'done', artifactId: kept.id, attempts: 0, recovered: true, notices: [] };
  }
  if (step.status === 'pending' || step.status === 'blocked') ledger.move(accountId, stepId, 'in_progress', { actor: 'resident' });
  const attempts = [];
  let model = 0;
  let failuresHere = 0;
  let interventions = 0;
  let correction = '';
  const notices = [];

  const block = reason => {
    ledger.move(accountId, stepId, 'blocked', { actor: 'resident', patch: { blockedReason: reason } });
    notices.push(reason);
    return { outcome: 'blocked', reason, attempts: attempts.length, notices };
  };

  while (attempts.length < maxAttempts) {
    const specialist = specialists[model];
    if (!specialist) return block(`No model left to try after ${attempts.length} attempts. ${correction}`.trim());
    const snap = ledger.snapshot(accountId, projectId);
    const rules = [...snap.decisions.filter(item => item.status === 'settled' && item.kind !== 'plan'), ...snap.constraints.filter(item => item.status === 'active')];
    const brief = prepareBrief({ step, rules, correction });
    const dispatch = ledger.recordDispatch(accountId, projectId, { purpose: step.title, stepId, route: { role: specialist.role || null, model: specialist.id, reason: attempts.length ? 'retry after review' : 'first attempt' } });
    ledger.startDispatch(accountId, dispatch.id, { runId, sent: { brief } });
    let output = '';
    try {
      output = String(await specialist.call({ brief, attempt: attempts.length + 1 }) || '');
    } catch (error) {
      ledger.finishDispatch(accountId, dispatch.id, { outcome: 'failed', error: error.message });
      failuresHere += 1;
      if (failuresHere >= failuresPerModel) { model += 1; failuresHere = 0; }
      attempts.push({ output: '', review: review('', { rules, criteria: step.criteria || [] }) });
      continue;
    }
    const result = review(output, { rules, criteria: step.criteria || [] });
    attempts.push({ output, review: result });
    const artifact = ledger.record(accountId, projectId, 'artifact', { title: `${step.title}, attempt ${attempts.length}`, stepId, dispatchId: dispatch.id, content: output }, { actor: `model:${specialist.id}` });
    ledger.move(accountId, artifact.id, result.verdict === 'accept' ? 'accepted' : 'rejected', { actor: 'resident' });
    try { onOutcome({ specialist, step, accepted: result.verdict === 'accept' }); } catch { /* learning never stops the step */ }
    const checks = [
      ...result.breaches.map(item => ({ name: `rule: ${item.title}`, passed: false, detail: item.found })),
      ...(step.criteria || []).map(item => ({ name: `criterion: ${item.name}`, passed: !result.unmet.includes(item.name) })),
    ];
    ledger.finishDispatch(accountId, dispatch.id, { outcome: 'completed', checks, artifactIds: [artifact.id] });
    for (const proposal of result.proposals) {
      ledger.record(accountId, projectId, 'decision', { title: `Change "${proposal.title}"?`, text: proposal.text, supersedes: [proposal.ruleId] }, { actor: `model:${specialist.id}` });
      notices.push(`${specialist.id} suggests changing "${proposal.title}". It is waiting for you; nothing was changed.`);
    }

    if (result.verdict === 'accept') {
      ledger.move(accountId, stepId, 'done', { actor: 'resident', patch: { acceptedArtifact: artifact.id } });
      return { outcome: 'done', artifactId: artifact.id, attempts: attempts.length, notices };
    }

    const stuck = assess(attempts);
    if (stuck) {
      interventions += 1;
      if (interventions === 1) {
        correction = `${correctionBrief(result)}\nYour answers are ${stuck.signal === 'repeating' ? 'repeating' : stuck.signal}. Do only this one thing now: ${result.unmet[0] || 'fix the rule breaches'}.`;
        continue;
      }
      if (interventions === 2 && specialists[model + 1]) {
        model += 1; failuresHere = 0; correction = correctionBrief(result);
        continue;
      }
      return block(`Stopped: ${stuck.detail}. Last check: ${correctionBrief(result).replace(/\n/g, ' ')}`);
    }
    correction = correctionBrief(result);
    // An answer that met more of the step than the last one, breaking nothing,
    // is progress and not a failure.
    const before = attempts[attempts.length - 2];
    const progressed = before && result.met > before.review.met && !result.breaches.length;
    if (!progressed) failuresHere += 1;
    if (failuresHere >= failuresPerModel) { model += 1; failuresHere = 0; }
  }
  return block(`Stopped after ${maxAttempts} attempts. ${correction.replace(/\n/g, ' ')}`);
}

module.exports = { review, correctionBrief, assess, similar, superviseStep };
