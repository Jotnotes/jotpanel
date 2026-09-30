'use strict';

// The project ledger (Resident Stage 1), proved three ways:
//   - behaviour: rules change only through a person's recorded approval,
//     knowledge never becomes or overrides a rule, a conversation's project
//     decides its context, nothing sent or secret is kept as text;
//   - kill -9 at every write point of a full project script, then recovery;
//   - every defence removed in turn, each time a named test must fail.

const assert = require('assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const MODULE = path.join(__dirname, 'projectLedger.js');
const BASE = Date.parse('2026-09-16T09:00:00Z');
const OWNER = 'acct_owner';
const STEVE = 'person:steve';

function refuses(fn, code, what) {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, `${what}: went through`);
  assert.equal(error.code, code, `${what}: refused for the wrong reason (${error.message})`);
}

function blocked(db, sql, args, what) {
  let error = null;
  try { db.prepare(sql).run(...args); } catch (caught) { error = caught; }
  assert.ok(error, `${what}: the database allowed it`);
  assert.match(String(error.code), /^SQLITE_CONSTRAINT/, `${what}: refused for the wrong reason (${error.message})`);
}

function memory(create, extra = {}) {
  const db = new Database(':memory:');
  return { db, ledger: create({ db, ...extra }) };
}

function rowOf(db, id) {
  return db.prepare('SELECT * FROM ledger_items WHERE id=?').get(id);
}

function eventCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n;
}

function bring(ledger, id, status = 'settled', approvedBy = STEVE) {
  const item = ledger.get(OWNER, id);
  const approval = ledger.approve(OWNER, id, { seenHash: item.hash, approvedBy });
  return ledger.move(OWNER, id, status, { actor: approvedBy, approvalId: approval.id });
}

function settledDecision(ledger, name = 'Invoice tracker') {
  const project = ledger.createProject(OWNER, { name, stack: ['node', 'sqlite'] }, { actor: STEVE });
  const proposed = ledger.record(OWNER, project.id, 'decision', { title: 'Storage', text: 'SQLite, plain SQL' }, { actor: 'model:openai/design' });
  return { project, decision: bring(ledger, proposed.id) };
}

// ── Behaviour ──────────────────────────────────────────────────────

function testSettlingNeedsAPersonsApproval(create) {
  const { db, ledger } = memory(create);
  const project = ledger.createProject(OWNER, { name: 'Invoice tracker' }, { actor: STEVE });
  const decision = ledger.record(OWNER, project.id, 'decision', { title: 'Storage', text: 'SQLite' }, { actor: 'model:openai/design' });
  assert.equal(decision.status, 'proposed');
  refuses(() => ledger.settle(OWNER, decision.id, { actor: 'model:openai/design' }), 'APPROVAL_REQUIRED', 'a model settling its own proposal');
  refuses(() => ledger.settle(OWNER, decision.id, { actor: STEVE }), 'APPROVAL_REQUIRED', 'a person settling with no recorded approval');
  refuses(() => ledger.approve(OWNER, decision.id, { seenHash: decision.hash, approvedBy: 'model:openai/design' }), 'NOT_A_PERSON', 'a model approving');
  refuses(() => ledger.approve(OWNER, decision.id, { seenHash: decision.hash, approvedBy: 'resident' }), 'NOT_A_PERSON', 'the Resident approving');
  refuses(() => ledger.move(OWNER, decision.id, 'rejected', { actor: 'resident' }), 'NOT_A_PERSON', 'the Resident turning a proposal down');
  assert.equal(ledger.get(OWNER, decision.id).status, 'proposed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger_approvals').get().n, 0);

  const approval = ledger.approve(OWNER, decision.id, { seenHash: decision.hash, approvedBy: STEVE });
  const settled = ledger.settle(OWNER, decision.id, { actor: STEVE, approvalId: approval.id });
  assert.equal(settled.status, 'settled');
  assert.equal(settled.approval.by, STEVE);
  assert.equal(ledger.approvals(OWNER, decision.id)[0].usedBy, settled.version);

  const constraint = ledger.record(OWNER, project.id, 'constraint', { title: 'Money is whole cents' }, { actor: 'resident' });
  refuses(() => ledger.move(OWNER, constraint.id, 'active', { actor: STEVE }), 'APPROVAL_REQUIRED', 'a constraint coming into force unapproved');
  assert.equal(bring(ledger, constraint.id, 'active').status, 'active');
  refuses(() => ledger.move(OWNER, constraint.id, 'lifted', { actor: 'model:anthropic/code' }), 'APPROVAL_REQUIRED', 'a model lifting a constraint');
  const lift = ledger.approve(OWNER, constraint.id, { change: 'lift', seenHash: ledger.get(OWNER, constraint.id).hash, approvedBy: STEVE });
  assert.equal(ledger.move(OWNER, constraint.id, 'lifted', { actor: STEVE, approvalId: lift.id }).status, 'lifted');
  const verdict = ledger.verify();
  assert.ok(verdict.ok, verdict.problems.join('; '));
}

function testARuleCannotChangeWithoutApproval(create) {
  const { db, ledger } = memory(create);
  const { project, decision } = settledDecision(ledger);
  const before = rowOf(db, decision.id);
  const events = eventCount(db);
  refuses(() => ledger.amend(OWNER, decision.id, { text: 'Postgres' }, { actor: 'model:anthropic/code' }), 'APPROVAL_REQUIRED', 'a model amending a settled decision');
  refuses(() => ledger.amend(OWNER, decision.id, { text: 'Postgres' }, { actor: STEVE }), 'APPROVAL_REQUIRED', 'a person amending with no recorded approval');
  refuses(() => ledger.move(OWNER, decision.id, 'superseded', { actor: STEVE }), 'NOT_ALLOWED', 'superseding directly');
  refuses(() => ledger.amend(OWNER, decision.id, { status: 'proposed' }, { actor: STEVE }), 'INVALID', 'resetting the status through a patch');
  assert.deepEqual(rowOf(db, decision.id), before, 'the settled decision is byte-identical');
  assert.equal(eventCount(db), events, 'nothing was written');

  const shown = ledger.get(OWNER, decision.id);
  const approval = ledger.approve(OWNER, decision.id, { change: 'amend', patch: { text: 'SQLite, plain SQL, WAL' }, seenHash: shown.hash, approvedBy: STEVE });
  const amended = ledger.amend(OWNER, decision.id, { text: 'SQLite, plain SQL, WAL' }, { actor: STEVE, approvalId: approval.id });
  assert.equal(amended.text, 'SQLite, plain SQL, WAL');
  assert.equal(amended.status, 'settled');
  assert.equal(amended.approval.id, approval.id);

  const replacement = ledger.record(OWNER, project.id, 'decision', { title: 'Storage', text: 'Postgres', supersedes: [decision.id] }, { actor: 'model:anthropic/code' });
  refuses(() => ledger.settle(OWNER, replacement.id, { actor: 'model:anthropic/code' }), 'APPROVAL_REQUIRED', 'a model superseding a settled decision');
  assert.equal(ledger.get(OWNER, decision.id).status, 'settled');
  bring(ledger, replacement.id);
  const old = ledger.get(OWNER, decision.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, replacement.id);
  refuses(() => ledger.amend(OWNER, decision.id, { text: 'SQLite again' }, { actor: STEVE }), 'NOT_ALLOWED', 'amending a superseded decision');
  const verdict = ledger.verify();
  assert.ok(verdict.ok, verdict.problems.join('; '));
}

function testAnApprovalCoversExactlyWhatWasApproved(create) {
  const { ledger } = memory(create);
  const project = ledger.createProject(OWNER, { name: 'Invoice tracker' }, { actor: STEVE });
  const decision = ledger.record(OWNER, project.id, 'decision', { title: 'Sign-in', text: 'Passkeys' }, { actor: 'model:openai/design' });
  refuses(() => ledger.approve(OWNER, decision.id, { seenHash: 'what-the-screen-showed-last-week', approvedBy: STEVE }), 'CHANGED', 'approving something other than what is stored');

  const approval = ledger.approve(OWNER, decision.id, { seenHash: decision.hash, approvedBy: STEVE });
  ledger.amend(OWNER, decision.id, { text: 'Passwords' }, { actor: 'model:openai/design' });
  refuses(() => ledger.settle(OWNER, decision.id, { actor: STEVE, approvalId: approval.id }), 'APPROVAL_REQUIRED', 'settling text that changed after it was approved');

  // Two proposals with the same words: the approval still belongs to one of them.
  const twin = ledger.record(OWNER, project.id, 'decision', { title: 'Sign-in', text: 'Passwords' }, { actor: 'model:openai/design' });
  const shown = ledger.get(OWNER, decision.id);
  assert.equal(shown.hash, twin.hash);
  const fresh = ledger.approve(OWNER, decision.id, { seenHash: shown.hash, approvedBy: STEVE });
  refuses(() => ledger.settle(OWNER, twin.id, { actor: STEVE, approvalId: fresh.id }), 'APPROVAL_REQUIRED', "using one decision's approval on its twin");
  ledger.settle(OWNER, decision.id, { actor: STEVE, approvalId: fresh.id });

  const settled = ledger.get(OWNER, decision.id);
  const yes = ledger.approve(OWNER, decision.id, { change: 'amend', patch: { text: 'Passkeys only' }, seenHash: settled.hash, approvedBy: STEVE });
  refuses(() => ledger.amend(OWNER, decision.id, { text: 'Passwords too' }, { actor: 'model:anthropic/code', approvalId: yes.id }), 'APPROVAL_REQUIRED', 'an amendment other than the one approved');
  ledger.amend(OWNER, decision.id, { text: 'Passkeys only' }, { actor: STEVE, approvalId: yes.id });
  refuses(() => ledger.amend(OWNER, decision.id, { text: 'Passkeys only' }, { actor: STEVE, approvalId: yes.id }), 'APPROVAL_REQUIRED', 'using an approval twice');
}

function testRawSqlCannotChangeARule(create) {
  const { db, ledger } = memory(create);
  const { project, decision } = settledDecision(ledger);
  const constraint = ledger.record(OWNER, project.id, 'constraint', { title: 'No TypeScript' }, { actor: STEVE });
  bring(ledger, constraint.id, 'active');
  const note = ledger.record(OWNER, project.id, 'knowledge', { title: 'TypeScript would catch bugs' }, { actor: 'model:anthropic/code' });
  const snapshot = () => JSON.stringify([
    db.prepare('SELECT * FROM ledger_items ORDER BY id').all(),
    db.prepare('SELECT * FROM ledger_events ORDER BY seq').all(),
    db.prepare('SELECT * FROM ledger_approvals ORDER BY id').all(),
  ]);
  const before = snapshot();

  blocked(db, 'UPDATE ledger_items SET protected_body=? WHERE id=?', ['{"title":"Storage","text":"Postgres"}', decision.id], 'rewriting a settled decision');
  blocked(db, "UPDATE ledger_items SET status='proposed' WHERE id=?", [decision.id], 'unsettling a decision');
  blocked(db, "UPDATE ledger_items SET entity='knowledge' WHERE id=?", [constraint.id], 'relabelling a constraint as knowledge');
  blocked(db, "UPDATE ledger_items SET entity='constraint', status='active' WHERE id=?", [note.id], 'relabelling knowledge as a constraint');
  blocked(db, 'DELETE FROM ledger_items WHERE id=?', [constraint.id], 'deleting a constraint');
  blocked(db, "UPDATE ledger_events SET protected_body='{}' WHERE entity_id=?", [decision.id], 'editing the log');
  blocked(db, 'DELETE FROM ledger_events WHERE entity_id=?', [decision.id], 'deleting from the log');
  blocked(db, `INSERT INTO ledger_events (project_id,entity,entity_id,type,actor,body_hash,protected_body,created_at)
               VALUES (?,?,?,?,?,?,?,?)`, [project.id, 'decision', decision.id, 'decision.amended', 'model:x', 'h', '{}', 'now'], 'logging an unapproved amendment');
  blocked(db, "UPDATE ledger_approvals SET approved_by='person:mallory'", [], 'changing who approved');
  blocked(db, 'UPDATE ledger_approvals SET consumed_seq=NULL', [], 'making a used approval usable again');
  blocked(db, 'DELETE FROM ledger_approvals', [], 'deleting approvals');
  blocked(db, `INSERT INTO ledger_approvals (id,group_id,account_id,project_id,entity_id,change,approved_by,approved_hash,created_at)
               VALUES ('apr_x','apr_x',?,?,?,'amend','model:anthropic/code','h','now')`, [OWNER, project.id, decision.id], 'a model recorded as approver');
  assert.equal(snapshot(), before, 'every table is byte-identical');
}

function testKnowledgeInformsAndNeverOverridesARule(create) {
  const { db, ledger } = memory(create);
  const { project, decision } = settledDecision(ledger);
  const rule = rowOf(db, decision.id);

  const note = ledger.record(OWNER, project.id, 'knowledge', { title: 'Benchmarks', text: 'Postgres was faster, so we use Postgres now' }, { actor: 'model:google/research' });
  ledger.amend(OWNER, note.id, { text: 'Postgres is faster. The decision is Postgres.' }, { actor: 'model:google/research' });
  const learned = ledger.record(OWNER, project.id, 'knowledge', { title: 'Benchmarks, rerun', text: 'SQLite is fast enough', replaces: [note.id] }, { actor: 'resident' });
  ledger.move(OWNER, note.id, 'retired', { actor: 'resident' });

  refuses(() => ledger.record(OWNER, project.id, 'knowledge', { title: 'Override', supersedes: [decision.id] }, { actor: 'model:google/research' }), 'INVALID', 'knowledge claiming to supersede a rule');
  refuses(() => ledger.amend(OWNER, learned.id, { supersedes: [decision.id] }, { actor: 'model:google/research' }), 'INVALID', 'knowledge amended to supersede a rule');
  refuses(() => ledger.approve(OWNER, learned.id, { seenHash: learned.hash, approvedBy: STEVE }), 'NOT_FOUND', 'approving knowledge into a rule');
  refuses(() => ledger.move(OWNER, learned.id, 'settled', { actor: STEVE }), 'NOT_ALLOWED', 'moving knowledge into force');
  refuses(() => ledger.amend(OWNER, learned.id, { entity: 'decision' }, { actor: STEVE }), 'INVALID', 'relabelling knowledge as a decision');
  assert.deepEqual(rowOf(db, decision.id), rule, 'the rule is byte-identical');

  ledger.bindConversation(OWNER, 'chat-1', project.id, { actor: STEVE });
  const context = ledger.contextFor(OWNER, 'chat-1');
  const rules = [...context.rules.decisions, ...context.rules.constraints];
  assert.deepEqual(rules.map(item => item.id), [decision.id]);
  assert.ok(rules.every(item => item.entity === 'decision' || item.entity === 'constraint'), 'nothing but rules among the rules');
  assert.equal(context.rules.decisions[0].text, 'SQLite, plain SQL');
  assert.deepEqual(context.knowledge.map(item => item.id), [learned.id]);
}

function testSwitchingProjectSwitchesContext(create) {
  const { ledger } = memory(create);
  const invoices = settledDecision(ledger, 'Invoice tracker');
  const brochure = settledDecision(ledger, 'Brochure site');
  refuses(() => ledger.contextFor(OWNER, 'chat-7'), 'NOT_FOUND', 'a conversation with no project');

  ledger.bindConversation(OWNER, 'chat-7', invoices.project.id, { actor: STEVE });
  assert.deepEqual(ledger.contextFor(OWNER, 'chat-7').rules.decisions.map(item => item.id), [invoices.decision.id]);
  const moved = ledger.bindConversation(OWNER, 'chat-7', brochure.project.id, { actor: STEVE });
  assert.equal(moved.projectId, brochure.project.id);
  assert.equal(moved.from, invoices.project.id);
  const context = ledger.contextFor(OWNER, 'chat-7');
  assert.equal(context.project.id, brochure.project.id);
  assert.deepEqual(context.rules.decisions.map(item => item.id), [brochure.decision.id], "only the new project's rules");
  assert.deepEqual(ledger.history(OWNER, moved.id).map(event => event.type), ['conversation.bound', 'conversation.switched']);

  // Another account using the same conversation id has its own conversation.
  const theirs = ledger.createProject('acct_other', { name: 'Theirs' }, { actor: 'person:them' });
  refuses(() => ledger.bindConversation('acct_other', 'chat-7', brochure.project.id, { actor: 'person:them' }), 'NOT_FOUND', "binding into another account's project");
  refuses(() => ledger.contextFor('acct_other', 'chat-7'), 'NOT_FOUND', "reading another account's conversation");
  ledger.bindConversation('acct_other', 'chat-7', theirs.id, { actor: 'person:them' });
  assert.equal(ledger.contextFor(OWNER, 'chat-7').project.id, brochure.project.id, "their binding leaves this account's conversation alone");

  ledger.move(OWNER, invoices.project.id, 'archived', { actor: STEVE });
  refuses(() => ledger.bindConversation(OWNER, 'chat-8', invoices.project.id, { actor: STEVE }), 'NOT_ALLOWED', 'a conversation joining an archived project');
  const verdict = ledger.verify();
  assert.ok(verdict.ok, verdict.problems.join('; '));
}

function testSecretsAndSentTextStayOut(create) {
  const { db, ledger } = memory(create);
  const project = ledger.createProject(OWNER, { name: 'Invoice tracker' }, { actor: STEVE });
  const requirement = ledger.record(OWNER, project.id, 'requirement', { title: 'Connect Stripe', apiKey: 'sk_live_51Hleak', notes: { password: 'hunter2-leak' } }, { actor: STEVE });
  assert.equal(requirement.apiKey, '[scrubbed]');
  const step = ledger.record(OWNER, project.id, 'plan_step', { title: 'Migration', requirementIds: [requirement.id] }, { actor: 'resident' });
  const dispatch = ledger.recordDispatch(OWNER, project.id, { purpose: 'Write the migration', stepId: step.id, route: { role: 'coding', reason: 'coding role' } });
  const brief = 'Client Jane Roe, 12 Rue Leak, jane@leak.example, and some venting about Bob';
  ledger.startDispatch(OWNER, dispatch.id, { runId: 'run-a', sent: { brief, objective: 'Invoices' } });
  const everything = JSON.stringify(['ledger_items', 'ledger_events', 'ledger_approvals'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  for (const needle of ['sk_live_51Hleak', 'hunter2-leak', 'Jane Roe', 'jane@leak.example', 'Rue Leak']) {
    assert.ok(!everything.includes(needle), `${needle} reached the database`);
  }
  const started = ledger.get(OWNER, dispatch.id);
  assert.deepEqual(started.sent.map(item => item.field), ['brief', 'objective']);
  assert.equal(started.sent[0].sha256, crypto.createHash('sha256').update(brief).digest('hex'));
  refuses(() => ledger.recordDispatch(OWNER, project.id, { purpose: 'Sneak', sent: { brief } }), 'INVALID', 'a caller writing sent text directly');

  const sealed = memory(create, {
    protect: value => Buffer.from(value).toString('base64'),
    unprotect: value => Buffer.from(value, 'base64').toString('utf8'),
  });
  const other = sealed.ledger.createProject(OWNER, { name: 'Sealed name' }, { actor: STEVE });
  sealed.ledger.record(OWNER, other.id, 'decision', { title: 'Sealed decision' }, { actor: STEVE });
  const raw = JSON.stringify(['ledger_items', 'ledger_events'].map(table => sealed.db.prepare(`SELECT * FROM ${table}`).all()));
  assert.ok(!raw.includes('Sealed'), 'bodies are protected at rest');
  assert.equal(sealed.ledger.get(OWNER, other.id).name, 'Sealed name');
}

function testInterruptedDispatchesAreNeverRepeated(create) {
  const { db, ledger } = memory(create);
  const project = ledger.createProject(OWNER, { name: 'Invoice tracker' }, { actor: STEVE });
  const step = ledger.record(OWNER, project.id, 'plan_step', { title: 'Schema' }, { actor: 'resident' });
  const dispatch = ledger.recordDispatch(OWNER, project.id, { purpose: 'Write the schema', stepId: step.id }, { idempotencyKey: 'dispatch-1' });
  let events = eventCount(db);
  let again;
  assert.doesNotThrow(() => { again = ledger.recordDispatch(OWNER, project.id, { purpose: 'Write the schema', stepId: step.id }, { idempotencyKey: 'dispatch-1' }); }, 'a retried record');
  assert.equal(again.id, dispatch.id);
  assert.equal(eventCount(db), events, 'a retried record writes nothing');

  ledger.startDispatch(OWNER, dispatch.id, { runId: 'run-a', sent: { brief: 'Write the schema' }, idempotencyKey: 'start-1' });
  events = eventCount(db);
  assert.doesNotThrow(() => ledger.startDispatch(OWNER, dispatch.id, { runId: 'run-a', sent: { brief: 'Write the schema' }, idempotencyKey: 'start-1' }), 'a retried start');
  assert.equal(eventCount(db), events, 'a retried start writes nothing');

  assert.deepEqual(ledger.recoverInterrupted({ runId: 'run-a' }), [], 'the running process keeps its own work');
  const recovered = ledger.recoverInterrupted({ runId: 'run-b' });
  assert.deepEqual(recovered.map(item => [item.id, item.status]), [[dispatch.id, 'interrupted']]);
  refuses(() => ledger.finishDispatch(OWNER, dispatch.id, { outcome: 'completed' }), 'NOT_ALLOWED', 'finishing an interrupted dispatch');
  refuses(() => ledger.startDispatch(OWNER, dispatch.id, { runId: 'run-b', sent: {} }), 'NOT_ALLOWED', 'sending an interrupted dispatch again');
  assert.deepEqual(ledger.recoverInterrupted({ runId: 'run-c' }), [], 'an interrupted dispatch is not interrupted twice');
  assert.deepEqual(ledger.history(OWNER, dispatch.id).map(event => event.type), ['dispatch.recorded', 'dispatch.in_flight', 'dispatch.interrupted']);

  const resume = ledger.recordDispatch(OWNER, project.id, { purpose: 'Write the schema', stepId: step.id, resumes: dispatch.id });
  refuses(() => ledger.move(OWNER, resume.id, 'in_flight', { actor: 'resident', patch: { note: 'by hand' } }), 'NOT_ALLOWED', 'starting a dispatch by hand, around the fingerprint');
  ledger.startDispatch(OWNER, resume.id, { runId: 'run-b', sent: { brief: 'Write the schema, resumed' } });
  const artifact = ledger.record(OWNER, project.id, 'artifact', { title: 'schema.sql', stepId: step.id, dispatchId: resume.id }, { actor: 'resident' });
  const done = ledger.finishDispatch(OWNER, resume.id, { outcome: 'completed', costMicro: 1200, latencyMs: 850, usage: { in: 400, out: 900 }, checks: [{ name: 'parses', passed: true }], artifactIds: [artifact.id] });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result.artifactIds, [artifact.id]);
  const verdict = ledger.verify();
  assert.ok(verdict.ok, verdict.problems.join('; '));
}

function testTenantsLinksAndLedgerFields(create) {
  const { ledger } = memory(create);
  const mine = ledger.createProject(OWNER, { name: 'Mine' }, { actor: STEVE });
  const theirs = ledger.createProject('acct_other', { name: 'Theirs' }, { actor: 'person:them' });
  const secret = ledger.record('acct_other', theirs.id, 'decision', { title: 'Their plan' }, { actor: 'person:them' });
  assert.equal(ledger.get(OWNER, secret.id), null);
  assert.deepEqual(ledger.projects(OWNER).map(item => item.id), [mine.id]);
  refuses(() => ledger.record(OWNER, theirs.id, 'objective', { title: 'Mine now' }, { actor: STEVE }), 'NOT_FOUND', "writing into another account's project");
  refuses(() => ledger.approve(OWNER, secret.id, { seenHash: secret.hash, approvedBy: STEVE }), 'NOT_FOUND', "approving another account's decision");
  refuses(() => ledger.amend(OWNER, secret.id, { text: 'changed' }, { actor: STEVE }), 'NOT_FOUND', "amending another account's decision");
  refuses(() => ledger.history(OWNER, secret.id), 'NOT_FOUND', "reading another account's history");

  refuses(() => ledger.record(OWNER, mine.id, 'requirement', { title: 'Orphan', objectiveId: 'obj_missing' }, { actor: STEVE }), 'INVALID', 'a link to nothing');
  refuses(() => ledger.record(OWNER, mine.id, 'plan_step', { title: 'Borrowed', deps: [secret.id] }, { actor: STEVE }), 'INVALID', 'a link into another project');
  refuses(() => ledger.record(OWNER, mine.id, 'objective', { title: 'Forged', approval: { by: STEVE } }, { actor: 'model:x' }), 'INVALID', 'a caller writing the approval stamp');
  refuses(() => ledger.record(OWNER, mine.id, 'objective', { title: 'Nobody' }, { actor: 'someone' }), 'INVALID', 'an actor that names nobody');
  refuses(() => ledger.record(OWNER, mine.id, 'objective', {}, { actor: STEVE }), 'INVALID', 'a record with no title');

  const artifact = ledger.record(OWNER, mine.id, 'artifact', { title: 'logo.svg' }, { actor: 'resident' });
  ledger.move(OWNER, artifact.id, 'accepted', { actor: STEVE });
  refuses(() => ledger.move(OWNER, artifact.id, 'proposed', { actor: 'resident' }), 'NOT_ALLOWED', 'reopening an accepted artifact');
}

// ── kill -9 ────────────────────────────────────────────────────────

const FINISH_STEP = 20;

function crashScript(ledger, runId) {
  const A = OWNER;
  const hash = id => ledger.get(A, id).hash;
  return [
    () => ledger.createProject(A, { name: 'Invoice tracker', stack: ['node', 'sqlite'] }, { actor: STEVE, id: 'p1', idempotencyKey: 's1' }),
    () => ledger.bindConversation(A, 'chat-1', 'p1', { actor: STEVE, idempotencyKey: 's2' }),
    () => ledger.record(A, 'p1', 'objective', { title: 'Send invoices' }, { actor: STEVE, id: 'o1', idempotencyKey: 's3' }),
    () => ledger.record(A, 'p1', 'requirement', { title: 'Money in whole cents', objectiveId: 'o1' }, { actor: STEVE, id: 'r1', idempotencyKey: 's4' }),
    () => ledger.record(A, 'p1', 'constraint', { title: 'No TypeScript' }, { actor: 'resident', id: 'c1', idempotencyKey: 's5' }),
    () => ledger.approve(A, 'c1', { seenHash: hash('c1'), approvedBy: STEVE, id: 'ac1', idempotencyKey: 's6' }),
    () => ledger.move(A, 'c1', 'active', { actor: STEVE, approvalId: 'ac1', idempotencyKey: 's7' }),
    () => ledger.record(A, 'p1', 'decision', { title: 'Storage', text: 'SQLite' }, { actor: 'model:openai/design', id: 'd1', idempotencyKey: 's8' }),
    () => ledger.approve(A, 'd1', { seenHash: hash('d1'), approvedBy: STEVE, id: 'ad1', idempotencyKey: 's9' }),
    () => ledger.settle(A, 'd1', { actor: STEVE, approvalId: 'ad1', idempotencyKey: 's10' }),
    () => ledger.record(A, 'p1', 'decision', { title: 'Storage', text: 'SQLite with WAL', supersedes: ['d1'] }, { actor: 'model:anthropic/code', id: 'd2', idempotencyKey: 's11' }),
    () => ledger.amend(A, 'd2', { rationale: 'survives a crash' }, { actor: 'model:anthropic/code', idempotencyKey: 's12' }),
    () => ledger.approve(A, 'd2', { seenHash: hash('d2'), approvedBy: STEVE, id: 'ad2', idempotencyKey: 's13' }),
    () => ledger.settle(A, 'd2', { actor: STEVE, approvalId: 'ad2', idempotencyKey: 's14' }),
    () => ledger.record(A, 'p1', 'knowledge', { title: 'WAL keeps committed writes' }, { actor: 'resident', id: 'k1', idempotencyKey: 's15' }),
    () => ledger.record(A, 'p1', 'plan_step', { title: 'Schema', requirementIds: ['r1'] }, { actor: 'resident', id: 't1', idempotencyKey: 's16' }),
    () => ledger.move(A, 't1', 'in_progress', { actor: 'resident', idempotencyKey: 's17' }),
    () => ledger.recordDispatch(A, 'p1', { purpose: 'Write the schema', stepId: 't1', route: { role: 'coding' } }, { id: 'x1', idempotencyKey: 's18' }),
    () => ledger.startDispatch(A, 'x1', { runId, sent: { brief: 'Write the schema' }, idempotencyKey: 's19' }),
    () => ledger.record(A, 'p1', 'artifact', { title: 'schema.sql', stepId: 't1', dispatchId: 'x1' }, { actor: 'resident', id: 'f1', idempotencyKey: 's20' }),
    () => ledger.finishDispatch(A, 'x1', { outcome: 'completed', latencyMs: 900, checks: [{ name: 'parses', passed: true }], artifactIds: ['f1'], idempotencyKey: 's21' }),
    () => ledger.record(A, 'p1', 'question', { title: 'Which currency first?' }, { actor: 'resident', id: 'q1', idempotencyKey: 's22' }),
    () => ledger.move(A, 'q1', 'answered', { actor: STEVE, patch: { answer: 'EUR' }, idempotencyKey: 's23' }),
  ];
}

// Startup recovery, then the whole script. A step already applied is a replay
// and writes nothing; finishing a dispatch that recovery marked interrupted is
// refused, which is the point.
function runScript(ledger, runId, clock, onStep = () => {}) {
  clock.t = 0;
  ledger.recoverInterrupted({ runId });
  crashScript(ledger, runId).forEach((step, index) => {
    clock.t = index + 1;
    try { step(); } catch (error) {
      if (!(index === FINISH_STEP && error.code === 'NOT_ALLOWED')) throw error;
    }
    onStep(index);
  });
}

function openLedger(create, file, extra = {}) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const clock = { t: 0 };
  return { db, clock, ledger: create({ db, now: () => new Date(BASE + clock.t * 1000), ...extra }) };
}

function crashChild(file, modulePath, killAt, runId) {
  let points = 0;
  const { ledger, clock } = openLedger(require(modulePath).createProjectLedger, file, {
    checkpoint: () => {
      points += 1;
      if (points === killAt) process.kill(process.pid, 'SIGKILL');
    },
  });
  runScript(ledger, runId, clock);
  fs.writeSync(1, String(points));
}

function counts(db) {
  return {
    events: db.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n,
    approvals: db.prepare('SELECT COUNT(*) AS n FROM ledger_approvals').get().n,
  };
}

// Read with the unmodified module, so a mutant cannot weaken its own check.
function inspect(file) {
  const db = new Database(file);
  try {
    const verdict = require(MODULE).createProjectLedger({ db }).verify();
    return {
      integrity: db.pragma('integrity_check', { simple: true }),
      verdict,
      events: db.prepare('SELECT entity_id, type, actor, approval_id, idempotency_key, body_hash FROM ledger_events ORDER BY seq').all(),
      approvals: db.prepare('SELECT id, entity_id, change, approved_by, approved_hash FROM ledger_approvals ORDER BY rowid').all(),
      items: db.prepare('SELECT id, entity, project_id, account_id, status, approval_id, protected_body FROM ledger_items ORDER BY id').all(),
    };
  } finally {
    db.close();
  }
}

function testKillNineAtEveryWrite(create, modulePath = MODULE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-crash-'));
  try {
    const referenceFile = path.join(dir, 'reference.db');
    const boundaries = [];
    let points = 0;
    const reference = openLedger(create, referenceFile, { checkpoint: () => { points += 1; } });
    boundaries.push(counts(reference.db));
    runScript(reference.ledger, 'run-a', reference.clock, () => boundaries.push(counts(reference.db)));
    reference.db.close();
    const expected = inspect(referenceFile);
    assert.ok(expected.verdict.ok && points > 40, `the uninterrupted run is sound and has write points (${points})`);

    let interruptedRuns = 0;
    for (let killAt = 1; killAt <= points; killAt += 1) {
      const file = path.join(dir, `kill-${killAt}.db`);
      const child = spawnSync(process.execPath, [__filename, '--crash-child', file, modulePath, String(killAt), 'run-a'], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', `write point ${killAt}: the process did not die there (${child.status} ${String(child.stderr).slice(0, 400)})`);

      const after = inspect(file);
      const where = `kill -9 at write point ${killAt} of ${points}`;
      assert.equal(after.integrity, 'ok', `${where}: database integrity`);
      assert.ok(after.verdict.ok, `${where}: ${after.verdict.problems.join('; ')}`);
      assert.deepEqual(after.events, expected.events.slice(0, after.events.length), `${where}: the log is not a prefix of the uninterrupted run`);
      assert.deepEqual(after.approvals, expected.approvals.slice(0, after.approvals.length), `${where}: approvals are not a prefix of the uninterrupted run`);
      assert.ok(boundaries.some(b => b.events === after.events.length && b.approvals === after.approvals.length),
        `${where}: half a change survived (${after.events.length} events, ${after.approvals.length} approvals)`);

      // Restart as a new process and run the same script again.
      const resumed = openLedger(create, file);
      const inFlight = (resumed.db.prepare("SELECT status FROM ledger_items WHERE id='x1'").get() || {}).status === 'in_flight';
      runScript(resumed.ledger, 'run-b', resumed.clock);
      resumed.db.close();
      const final = inspect(file);
      assert.ok(final.verdict.ok, `${where}, after restart: ${final.verdict.problems.join('; ')}`);
      const others = rows => rows.filter(row => row.id !== 'x1');
      assert.deepEqual(others(final.items), others(expected.items), `${where}, after restart: the project differs from the uninterrupted run`);
      assert.deepEqual(final.approvals, expected.approvals, `${where}, after restart: approvals differ`);
      const x1 = final.items.find(row => row.id === 'x1');
      assert.equal(x1.status, inFlight ? 'interrupted' : 'completed', `${where}, after restart: dispatch outcome`);
      assert.equal(final.events.filter(event => event.entity_id === 'x1' && event.type === 'dispatch.in_flight').length, 1, `${where}: the dispatch was sent once`);
      if (inFlight) interruptedRuns += 1;
    }
    assert.ok(interruptedRuns > 0, 'at least one kill left a dispatch in flight');
    return { points, interruptedRuns };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Each defence removed in turn ───────────────────────────────────

const GUARD_OFF = ['    if (guarded) requireApproval(', '    if (false) requireApproval('];

const MUTANTS = [
  { name: 'service: a rule change uses an approval', test: testSettlingNeedsAPersonsApproval, edits: [GUARD_OFF] },
  { name: 'service and database approval checks together', test: testARuleCannotChangeWithoutApproval,
    edits: [GUARD_OFF, ['  ruleEvents: `', '  ruleEvents: false && `'], ['  ruleItems: `', '  ruleItems: false && `']] },
  { name: 'approval bound to the content approved', test: testAnApprovalCoversExactlyWhatWasApproved,
    edits: [['    if (approval.approved_hash !== approvedHash)', '    if (false)']] },
  { name: 'only a person approves', test: testSettlingNeedsAPersonsApproval,
    edits: [["      if (!PERSON.test(String(approvedBy || '')))", '      if (false)']] },
  { name: 'database: the log is never edited', test: testRawSqlCannotChangeARule, edits: [['  eventsKeep: `', '  eventsKeep: false && `']] },
  { name: 'database: a rule row needs an approval', test: testRawSqlCannotChangeARule, edits: [['  ruleItems: `', '  ruleItems: false && `']] },
  { name: 'rules and knowledge kept apart', test: testKnowledgeInformsAndNeverOverridesARule,
    edits: [["    if (entity !== 'decision' && body.supersedes != null)", '    if (false)']] },
  { name: 'switching moves the conversation', test: testSwitchingProjectSwitchesContext,
    edits: [["  if (payload.op === 'bind') next.projectId = event.project_id;\n", '']] },
  { name: 'what was sent kept as hashes', test: testSecretsAndSentTextStayOut, edits: [['sent: fingerprint(sent)', 'sent']] },
  { name: 'recovery spares the running process', test: testInterruptedDispatchesAreNeverRepeated, edits: [['run_id <> ?)', 'run_id <> ? OR 1)']] },
  { name: 'every change is one transaction', test: testKillNineAtEveryWrite, edits: [['db.transaction(work)()', 'work()']] },
];

async function testEachDefenceHasATestThatFails() {
  const source = fs.readFileSync(MODULE, 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-mutants-'));
  const report = [];
  try {
    for (const [index, mutant] of MUTANTS.entries()) {
      let text = source;
      let why = null;
      for (const [find, replace] of mutant.edits) {
        const found = text.split(find).length - 1;
        if (found !== 1) { why = `the code to remove was found ${found} times`; break; }
        text = text.replace(find, () => replace);
      }
      let outcome;
      if (why) {
        outcome = 'COULD NOT COMPLETE';
      } else {
        const file = path.join(dir, `mutant-${index}.js`);
        fs.writeFileSync(file, text.replace("require('./secrets')", () => `require(${JSON.stringify(path.join(__dirname, 'secrets.js'))})`));
        try {
          await mutant.test(require(file).createProjectLedger, file);
          outcome = 'STILL PASSES';
        } catch (error) {
          outcome = error instanceof assert.AssertionError ? 'CAUGHT' : 'COULD NOT COMPLETE';
          why = error.message.split('\n')[0].slice(0, 110);
        }
      }
      const expected = mutant.redundant ? 'STILL PASSES' : 'CAUGHT';
      report.push({ ...mutant, outcome, why: mutant.redundant && outcome === 'STILL PASSES' ? `redundant: ${mutant.redundant}` : why, ok: outcome === expected });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const line of report) console.log(`  ${line.ok ? 'ok ' : 'BAD'} ${line.outcome.padEnd(18)} ${line.name}${line.why ? `  (${line.why})` : ''}`);
  const bad = report.filter(line => !line.ok);
  assert.equal(bad.length, 0, `${bad.length} defences without a failing test: ${bad.map(line => line.name).join(', ')}`);
  return report;
}

async function run() {
  const { createProjectLedger } = require(MODULE);
  const tests = [
    testSettlingNeedsAPersonsApproval, testARuleCannotChangeWithoutApproval, testAnApprovalCoversExactlyWhatWasApproved,
    testRawSqlCannotChangeARule, testKnowledgeInformsAndNeverOverridesARule, testSwitchingProjectSwitchesContext,
    testSecretsAndSentTextStayOut, testInterruptedDispatchesAreNeverRepeated, testTenantsLinksAndLedgerFields,
  ];
  for (const test of tests) test(createProjectLedger);
  const crash = testKillNineAtEveryWrite(createProjectLedger);
  console.log(`  kill -9 at each of ${crash.points} write points: log intact, no half change, restart finishes the project (${crash.interruptedRuns} left a dispatch in flight, each marked interrupted and sent once)`);
  const report = await testEachDefenceHasATestThatFails();
  const caught = report.filter(line => line.outcome === 'CAUGHT').length;
  console.log(`project ledger tests passed (${tests.length} behaviour tests, ${caught} defences caught when removed, ${report.length - caught} redundant by design)`);
}

if (process.argv[2] === '--crash-child') {
  crashChild(process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[6]);
} else {
  run().catch(error => { console.error(error); process.exit(1); });
}
