'use strict';

// ── Before a turn goes anywhere (Stage 7) ────────────────────────
//
// Audit scenario F5(a): a request that sounds destructive gets a question back,
// written here without a model, and nothing else happens on that turn. The
// person's answer decides: a yes carries on to the normal path, where any real
// operation still needs its own approval; a "no, I meant ..." is recorded as a
// correction, and when it points at the plan, the plan change is drafted for
// approval. Any other correction after an answer counts against the model that
// gave it, for that kind of work.

// Strong verbs on anything that holds data; "remove" only on stores, so that
// "remove the banner from the website" is a design request and not a question.
const DESTRUCTIVE = /\b(drop|delete|remove|wipe|erase|destroy|truncate|purge)\b/i;
const STRONG = /\b(drop|delete|wipe|erase|destroy|truncate|purge)\b/i;
const DATA = /\b(tables?|databases?|db|users?|accounts?|files?|folders?|sites?|websites?|mailbox(es)?|emails?|backups?|records?|domains?)\b/i;
const STORES = /\b(tables?|databases?|db|users?|accounts?|mailbox(es)?|backups?|records?|domains?)\b/i;
const CORRECTION = /^\s*(no\b|nope|not that|that'?s not|wrong|i meant|i mean\b|not what i)/i;
const YES = /^\s*(yes|yep|yeah|correct|do it|go ahead|i'?m sure|confirm)/i;
const QUESTION_MINUTES = 30;
const { scrubSecrets } = require('./egressGuard');

function readRisk(text) {
  const said = String(text);
  return (STRONG.test(said) && DATA.test(said)) || (/\bremove\b/i.test(said) && STORES.test(said)) ? 'destructive' : null;
}

function createConversationGuard({ ledger, jobRunner, fit, now = () => new Date() }) {
  function openRiskQuestion(accountId, projectId) {
    const cutoff = now().getTime() - QUESTION_MINUTES * 60000;
    return ledger.list(accountId, projectId, { entity: 'question', status: 'open' })
      .filter(q => q.askedFor === 'destructive request' && Date.parse(q.createdAt) >= cutoff)
      .pop() || null;
  }

  function words(text) {
    return String(text).toLowerCase().replace(DESTRUCTIVE, ' ').split(/[^a-z0-9]+/).filter(w => w.length > 3 && !['from', 'plan', 'list', 'please', 'that', 'this', 'with'].includes(w));
  }

  function before({ accountId, projectId, text, role = 'chat' }) {
    // What the person typed is kept only with secrets removed.
    const said = scrubSecrets(String(text || ''));
    const waiting = openRiskQuestion(accountId, projectId);

    if (waiting && CORRECTION.test(said)) {
      ledger.move(accountId, waiting.id, 'answered', { actor: `person:${accountId}`, patch: { answer: said.slice(0, 500) } });
      ledger.record(accountId, projectId, 'knowledge', { title: 'Correction', text: `"${waiting.request}" did not mean deleting anything. The person said: "${said.slice(0, 300)}"` }, { actor: `person:${accountId}` });
      let reply = 'Understood. Nothing was deleted.';
      if (/\bplan\b/i.test(said) && jobRunner) {
        const target = words(waiting.request);
        const plans = ledger.list(accountId, projectId, { entity: 'decision', status: 'settled' }).filter(d => d.kind === 'plan');
        for (const plan of plans) {
          const change = jobRunner.proposePlanChange({
            accountId, planId: plan.id, actor: 'resident', reason: said,
            keep: step => !target.every(word => step.title.toLowerCase().includes(word)),
          });
          if (change) { reply = `Understood, you meant the plan. Nothing was deleted. I have drafted the plan without that step; it changes nothing until you approve it.`; break; }
        }
      }
      return { proceed: false, kind: 'correction', reply };
    }
    if (waiting && YES.test(said)) {
      ledger.move(accountId, waiting.id, 'answered', { actor: `person:${accountId}`, patch: { answer: said.slice(0, 500) } });
      return { proceed: true, kind: 'confirmed', confirmedRequest: waiting.request };
    }
    if (readRisk(said)) {
      const question = 'Before anything changes: do you want that data deleted for good, or only taken out of a plan or a list? Nothing has been changed.';
      ledger.record(accountId, projectId, 'question', { title: question, askedFor: 'destructive request', request: said.slice(0, 500) }, { actor: 'resident' });
      return { proceed: false, kind: 'confirm', reply: question };
    }
    if (CORRECTION.test(said) && fit) {
      const last = ledger.list(accountId, projectId, { entity: 'dispatch', status: 'completed' }).pop();
      if (last && last.route) fit.record(accountId, last.route.role || role, `${last.route.provider}/${last.route.model}`, 'corrected');
      return { proceed: true, kind: 'corrected' };
    }
    return { proceed: true, kind: 'normal' };
  }

  return { before };
}

module.exports = { createConversationGuard, readRisk };
