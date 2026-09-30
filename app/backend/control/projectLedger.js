'use strict';

const crypto = require('crypto');
const { redact, SCRUBBED } = require('./secrets');

// ── The project ledger ───────────────────────────────────────────
//
// Stage 1 of the Resident (docs: ARCA_RESIDENT_RECOVERY_AUDIT D2). The thread of
// a project, held on the customer's side so that no model, and no restart, can
// lose it or quietly rewrite it: what the project is for, what it needs, what
// was decided and by whom, the plan, what was produced, what is still open, and
// every piece of work sent out to a model.
//
// Two tables do the work, the same shape the action store settled on:
//
//   ledger_events   append-only. Every change is a row and no row is ever
//                   edited or removed.
//   ledger_items    the current state of each thing, folded from its events by
//                   `reduce`. It is a view kept on the same transaction as the
//                   event that moved it, and `verify` rebuilds it from the log
//                   to prove the two agree.
//
// A third, ledger_approvals, is the record of a person saying yes. A rule (a
// settled decision or an active constraint) comes into force, is amended, is
// superseded or is lifted only by using up one of those rows, and the row names
// the person and the exact content they approved.
//
// Every conversation belongs to a project (settled item G). The binding is a
// ledger record like any other, so switching a conversation to another project
// is recorded, and `contextFor` hands back that project's rules, knowledge and
// plan and nothing from the project it left.
//
// The shape follows CodeTrack (arca-webos.jsx, `ctLoad`): a project with a
// stack, modules with status and dependencies (here plan steps), the files a
// module produced (artifacts) and the notes carried between conversations
// (questions and decisions), moved off the browser and onto the box.
//
// Bodies are protected at rest with the caller's protect/unprotect, exactly as
// the action store's are, and pass through the shared secrets redactor first.
// A dispatch keeps what was sent as field names, sizes and hashes, never the
// text (settled decision 5).

const ENTITIES = Object.freeze({
  project:     { prefix: 'prj', initial: 'active',   moves: { active: ['paused', 'archived'], paused: ['active', 'archived'], archived: [] } },
  objective:   { prefix: 'obj', initial: 'open',     moves: { open: ['met', 'dropped'], met: ['open'], dropped: [] } },
  requirement: { prefix: 'req', initial: 'open',     moves: { open: ['met', 'dropped'], met: ['open'], dropped: [] } },
  constraint:  { prefix: 'con', initial: 'proposed', moves: { proposed: ['active', 'rejected'], active: ['lifted'], lifted: [], rejected: [] } },
  decision:    { prefix: 'dec', initial: 'proposed', moves: { proposed: ['settled', 'rejected'], settled: ['superseded'], superseded: [], rejected: [] } },
  plan_step:   { prefix: 'stp', initial: 'pending',  moves: { pending: ['in_progress', 'blocked', 'skipped'], in_progress: ['done', 'blocked', 'pending'], blocked: ['pending', 'in_progress', 'skipped'], done: ['in_progress'], skipped: ['pending'] } },
  artifact:    { prefix: 'art', initial: 'proposed', moves: { proposed: ['accepted', 'rejected'], accepted: [], rejected: [] } },
  question:    { prefix: 'qst', initial: 'open',     moves: { open: ['answered', 'dropped'], answered: ['open'], dropped: [] } },
  knowledge:   { prefix: 'knw', initial: 'current',  moves: { current: ['retired'], retired: ['current'] } },
  conversation:{ prefix: 'cnv', initial: 'bound',    moves: { bound: [] } },
  dispatch:    { prefix: 'dsp', initial: 'queued',   moves: { queued: ['in_flight', 'cancelled'], in_flight: ['completed', 'failed', 'interrupted'], completed: [], failed: [], interrupted: [], cancelled: [] } },
});

// Fields that name other things in the same project, and what they must be.
const REFS = Object.freeze({
  requirement: { objectiveId: 'objective' },
  plan_step:   { deps: 'plan_step', requirementIds: 'requirement', objectiveIds: 'objective' },
  artifact:    { stepId: 'plan_step', dispatchId: 'dispatch' },
  decision:    { supersedes: 'decision' },
  question:    { stepId: 'plan_step' },
  knowledge:   { replaces: 'knowledge' },
  dispatch:    { stepId: 'plan_step' },
});

// Rules bind and knowledge informs (settled item H). Settled decisions and
// active constraints are the rules: each comes into force, changes and leaves
// only by using up a person's recorded approval. Knowledge (reference facts,
// notes, what was learned) is updated freely and has no path into a rule.
const RULES = Object.freeze({
  decision:   { inForce: 'settled', locked: ['settled', 'superseded'],
    changes: { 'decision.settled': 'settle', 'decision.superseded': 'supersede', 'decision.amended': 'amend' } },
  constraint: { inForce: 'active', locked: ['active', 'lifted'],
    changes: { 'constraint.active': 'settle', 'constraint.lifted': 'lift', 'constraint.amended': 'amend' } },
});

// Written by the ledger and never by a caller.
const RESERVED = new Set(['id', 'accountId', 'projectId', 'entity', 'status', 'version', 'hash', 'createdAt', 'updatedAt',
  'approval', 'supersededBy', 'run', 'sent', 'result', 'interruption', 'conversationId', 'from']);

// Whether this event changes a rule and so must use up an approval.
function needsApproval(entity, type, prevStatus) {
  const rule = RULES[entity];
  if (!rule) return false;
  if (rule.changes[type] && !type.endsWith('.amended')) return true;
  return prevStatus != null && rule.locked.includes(prevStatus);
}

const ACTOR = /^(person:\S+|model:\S+|resident|system)$/;
const PERSON = /^person:\S+$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 256 * 1024;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ledger_events (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL,
    entity          TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    type            TEXT NOT NULL,
    actor           TEXT NOT NULL,
    approval_id     TEXT,
    idempotency_key TEXT,
    body_hash       TEXT NOT NULL,
    protected_body  TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_events_key ON ledger_events (project_id, idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_ledger_events_entity ON ledger_events (entity_id, seq);

  CREATE TABLE IF NOT EXISTS ledger_approvals (
    id              TEXT PRIMARY KEY,
    group_id        TEXT NOT NULL,
    account_id      TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    change          TEXT NOT NULL CHECK (change IN ('settle', 'supersede', 'amend', 'lift')),
    approved_by     TEXT NOT NULL CHECK (substr(approved_by, 1, 7) = 'person:' AND length(approved_by) > 7),
    approved_hash   TEXT NOT NULL,
    idempotency_key TEXT,
    created_at      TEXT NOT NULL,
    consumed_seq    INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_approvals_key ON ledger_approvals (project_id, idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_ledger_approvals_group ON ledger_approvals (group_id);

  CREATE TABLE IF NOT EXISTS ledger_items (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    entity          TEXT NOT NULL,
    status          TEXT NOT NULL,
    version         INTEGER NOT NULL,
    run_id          TEXT,
    approval_id     TEXT,
    protected_body  TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_items_project ON ledger_items (account_id, project_id, entity, status);
  CREATE INDEX IF NOT EXISTS idx_ledger_items_inflight ON ledger_items (entity, status, run_id);
`;

// The same rules held by the database, for any code that writes these tables
// without going through the service.
const GUARDS = {
  eventsKeep: `
    CREATE TRIGGER IF NOT EXISTS ledger_events_no_update BEFORE UPDATE ON ledger_events
    BEGIN SELECT RAISE(ABORT, 'ledger events are never changed'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_events_no_delete BEFORE DELETE ON ledger_events
    BEGIN SELECT RAISE(ABORT, 'ledger events are never removed'); END;`,
  approvalsKeep: `
    CREATE TRIGGER IF NOT EXISTS ledger_approvals_no_delete BEFORE DELETE ON ledger_approvals
    BEGIN SELECT RAISE(ABORT, 'approvals are never removed'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_approvals_used_once BEFORE UPDATE ON ledger_approvals
    WHEN OLD.consumed_seq IS NOT NULL OR NEW.consumed_seq IS NULL
      OR NEW.id IS NOT OLD.id OR NEW.group_id IS NOT OLD.group_id OR NEW.account_id IS NOT OLD.account_id
      OR NEW.project_id IS NOT OLD.project_id OR NEW.entity_id IS NOT OLD.entity_id OR NEW.change IS NOT OLD.change
      OR NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_hash IS NOT OLD.approved_hash
      OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.created_at IS NOT OLD.created_at
      OR NOT EXISTS (SELECT 1 FROM ledger_events WHERE seq = NEW.consumed_seq AND approval_id = NEW.id AND entity_id = NEW.entity_id)
    BEGIN SELECT RAISE(ABORT, 'an approval is recorded once and used once'); END;`,
  ruleEvents: `
    CREATE TRIGGER IF NOT EXISTS ledger_events_rule_approval BEFORE INSERT ON ledger_events
    WHEN NEW.entity IN ('decision', 'constraint')
      AND (NEW.type IN ('decision.settled', 'decision.superseded', 'constraint.active', 'constraint.lifted')
           OR EXISTS (SELECT 1 FROM ledger_items i WHERE i.id = NEW.entity_id AND (((i.entity = 'decision' AND i.status IN ('settled', 'superseded')) OR (i.entity = 'constraint' AND i.status IN ('active', 'lifted'))))))
      AND NOT EXISTS (SELECT 1 FROM ledger_approvals a
                       WHERE a.id = NEW.approval_id AND a.project_id = NEW.project_id AND a.entity_id = NEW.entity_id
                         AND a.consumed_seq IS NULL
                         AND a.change = CASE NEW.type WHEN 'decision.settled' THEN 'settle' WHEN 'constraint.active' THEN 'settle'
                                                      WHEN 'decision.superseded' THEN 'supersede' WHEN 'constraint.lifted' THEN 'lift'
                                                      WHEN 'decision.amended' THEN 'amend' WHEN 'constraint.amended' THEN 'amend' END)
    BEGIN SELECT RAISE(ABORT, 'a rule changes only through a recorded approval'); END;`,
  ruleItems: `
    CREATE TRIGGER IF NOT EXISTS ledger_items_rule_insert BEFORE INSERT ON ledger_items
    WHEN (((NEW.entity = 'decision' AND NEW.status IN ('settled', 'superseded')) OR (NEW.entity = 'constraint' AND NEW.status IN ('active', 'lifted'))))
      AND NOT EXISTS (SELECT 1 FROM ledger_events e JOIN ledger_approvals a ON a.id = e.approval_id AND a.consumed_seq = e.seq
                       WHERE e.seq = NEW.version AND e.entity_id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'a rule changes only through a recorded approval'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_items_rule_update BEFORE UPDATE ON ledger_items
    WHEN ((((OLD.entity = 'decision' AND OLD.status IN ('settled', 'superseded')) OR (OLD.entity = 'constraint' AND OLD.status IN ('active', 'lifted')))) OR (((NEW.entity = 'decision' AND NEW.status IN ('settled', 'superseded')) OR (NEW.entity = 'constraint' AND NEW.status IN ('active', 'lifted')))))
      AND (NEW.id IS NOT OLD.id OR NEW.entity IS NOT OLD.entity OR NEW.account_id IS NOT OLD.account_id
           OR NEW.project_id IS NOT OLD.project_id OR NEW.version <= OLD.version
           OR NEW.version IS NOT (SELECT MAX(seq) FROM ledger_events WHERE entity_id = NEW.id)
           OR NOT EXISTS (SELECT 1 FROM ledger_events e JOIN ledger_approvals a ON a.id = e.approval_id AND a.consumed_seq = e.seq
                           WHERE e.seq = NEW.version AND e.entity_id = NEW.id))
    BEGIN SELECT RAISE(ABORT, 'a rule changes only through a recorded approval'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_items_rule_delete BEFORE DELETE ON ledger_items
    WHEN (((OLD.entity = 'decision' AND OLD.status IN ('settled', 'superseded')) OR (OLD.entity = 'constraint' AND OLD.status IN ('active', 'lifted'))))
    BEGIN SELECT RAISE(ABORT, 'a rule changes only through a recorded approval'); END;`,
};

class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function refuse(code, message) {
  return new LedgerError(code, message);
}

// Stable JSON, so a hash of a body means the same thing every time it is taken.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hashOf(body) {
  return sha(canonical(body));
}

// What a person approves: the content they were shown, plus the change if any.
function approvalHash(body, patch) {
  return sha(canonical({ from: hashOf(body), patch: patch || null }));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Folds one event into the current state of the thing it changed. The live
// write and `verify` both go through here, so the view and the log cannot be
// computed two different ways.
function reduce(prev, event, payload) {
  const base = prev || {
    id: event.entity_id,
    accountId: payload.accountId,
    projectId: event.project_id,
    entity: event.entity,
    status: ENTITIES[event.entity].initial,
    runId: null,
    approvalId: null,
    body: {},
    createdAt: event.created_at,
  };
  const next = {
    ...base,
    body: { ...base.body, ...(payload.body || {}), ...(payload.patch || {}) },
    version: event.seq,
    updatedAt: event.created_at,
  };
  if (payload.status) next.status = payload.status;
  if (payload.op === 'bind') next.projectId = event.project_id;
  if (event.approval_id) next.approvalId = event.approval_id;
  if (next.body.run && next.body.run.id) next.runId = next.body.run.id;
  return next;
}

function createProjectLedger({
  db,
  now = () => new Date(),
  protect = (value) => value,
  unprotect = (value) => value,
  // Called with (accountId, action, details) after an approval-bearing change
  // commits. Details carry ids only. server.js passes its audit_log writer.
  audit = () => {},
  // Called after each statement of a write and after the commit. Production
  // leaves it alone; the crash tests stop the process here.
  checkpoint = () => {},
} = {}) {
  if (!db) throw new Error('project ledger requires a database');

  db.exec(SCHEMA);
  for (const sql of Object.values(GUARDS)) if (sql) db.exec(sql);

  const q = {
    item: db.prepare('SELECT * FROM ledger_items WHERE id=?'),
    insertItem: db.prepare(`INSERT INTO ledger_items
      (id,account_id,project_id,entity,status,version,run_id,approval_id,protected_body,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    updateItem: db.prepare(`UPDATE ledger_items
      SET project_id=?, status=?, version=?, run_id=?, approval_id=?, protected_body=?, updated_at=? WHERE id=?`),
    insertEvent: db.prepare(`INSERT INTO ledger_events
      (project_id,entity,entity_id,type,actor,approval_id,idempotency_key,body_hash,protected_body,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    eventByKey: db.prepare('SELECT * FROM ledger_events WHERE project_id=? AND idempotency_key=?'),
    projectByKey: db.prepare(`SELECT e.* FROM ledger_events e JOIN ledger_items i ON i.id = e.entity_id
      WHERE e.type='project.recorded' AND e.idempotency_key=? AND i.account_id=?`),
    approval: db.prepare('SELECT * FROM ledger_approvals WHERE id=?'),
    approvalByKey: db.prepare('SELECT * FROM ledger_approvals WHERE project_id=? AND idempotency_key=?'),
    approvalGroup: db.prepare('SELECT * FROM ledger_approvals WHERE group_id=? AND change=? ORDER BY id'),
    insertApproval: db.prepare(`INSERT INTO ledger_approvals
      (id,group_id,account_id,project_id,entity_id,change,approved_by,approved_hash,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`),
    consumeApproval: db.prepare('UPDATE ledger_approvals SET consumed_seq=? WHERE id=? AND consumed_seq IS NULL'),
    inFlight: db.prepare(`SELECT id, account_id FROM ledger_items
      WHERE entity='dispatch' AND status='in_flight' AND (run_id IS NULL OR run_id <> ?) ORDER BY created_at`),
  };

  function encode(value) {
    return protect(canonical(value));
  }

  function decode(value) {
    return JSON.parse(unprotect(value));
  }

  function newId(prefix) {
    return `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
  }

  function atomically(work) {
    const result = db.transaction(work)();
    checkpoint('committed');
    return result;
  }

  function load(id) {
    const row = id == null ? null : q.item.get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      projectId: row.project_id,
      entity: row.entity,
      status: row.status,
      version: row.version,
      runId: row.run_id,
      approvalId: row.approval_id,
      body: decode(row.protected_body),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function present(item) {
    if (!item) return null;
    return {
      ...clone(item.body),
      id: item.id,
      accountId: item.accountId,
      projectId: item.projectId,
      entity: item.entity,
      status: item.status,
      version: item.version,
      hash: hashOf(item.body),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  function presentApproval(row) {
    return row && {
      id: row.id, groupId: row.group_id, decisionId: row.entity_id, change: row.change,
      approvedBy: row.approved_by, approvedHash: row.approved_hash, createdAt: row.created_at, usedBy: row.consumed_seq,
    };
  }

  function actorOf(actor) {
    const value = String(actor || '');
    if (!ACTOR.test(value)) throw refuse('INVALID', 'Every change names who made it: person:<id>, model:<name>, resident or system');
    return value;
  }

  function requireProject(accountId, projectId) {
    const project = load(projectId);
    if (!project || project.entity !== 'project' || project.accountId !== String(accountId)) throw refuse('NOT_FOUND', 'No such project');
    return project;
  }

  function requireItem(accountId, id, entity = null) {
    const item = load(id);
    if (!item || item.accountId !== String(accountId) || (entity && item.entity !== entity)) {
      throw refuse('NOT_FOUND', `No such ${entity || 'item'}`);
    }
    return item;
  }

  function requireTitle(entity, body) {
    if (entity === 'conversation') return;
    const field = entity === 'project' ? 'name' : entity === 'dispatch' ? 'purpose' : 'title';
    if (typeof body[field] !== 'string' || !body[field].trim()) throw refuse('INVALID', `A ${entity} needs a ${field}`);
  }

  function cleanFields(entity, fields, projectId) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw refuse('INVALID', 'Fields are an object');
    const body = clone(fields);
    for (const key of Object.keys(body)) {
      if (RESERVED.has(key)) throw refuse('INVALID', `${key} is written by the ledger`);
    }
    if (entity !== 'decision' && body.supersedes != null) throw refuse('INVALID', 'Only a decision replaces a rule');
    const clean = redact(body, { replacement: SCRUBBED });
    if (Buffer.byteLength(canonical(clean)) > MAX_BODY) throw refuse('INVALID', 'That is too large to keep in the ledger');
    for (const [field, target] of Object.entries(REFS[entity] || {})) {
      if (clean[field] == null) continue;
      const ids = Array.isArray(clean[field]) ? clean[field] : [clean[field]];
      for (const ref of ids) {
        const other = load(ref);
        if (!other || other.projectId !== projectId || other.entity !== target) {
          throw refuse('INVALID', `${field} names ${ref}, which is not a ${target} in this project`);
        }
      }
    }
    return clean;
  }

  // A write that already happened under this key returns what it produced and
  // writes nothing, so a retried call after a crash is never applied twice.
  function replayed(projectId, idempotencyKey, entityId, type) {
    if (idempotencyKey == null) return null;
    const prior = q.eventByKey.get(projectId, String(idempotencyKey));
    if (!prior) return null;
    if ((entityId && prior.entity_id !== entityId) || (type && prior.type !== type)) {
      throw refuse('CONFLICT', 'That idempotency key was used for a different change');
    }
    return present(load(prior.entity_id));
  }

  function requireApproval({ projectId, entity, entityId, type, approvalId, approvedHash }) {
    const approval = approvalId ? q.approval.get(String(approvalId)) : null;
    if (!approval) throw refuse('APPROVAL_REQUIRED', 'A rule changes only through a recorded approval');
    if (approval.project_id !== projectId || approval.entity_id !== entityId) throw refuse('APPROVAL_REQUIRED', 'That approval was given for something else');
    if (approval.change !== RULES[entity].changes[type]) throw refuse('APPROVAL_REQUIRED', 'That approval was given for a different change');
    if (approval.consumed_seq != null) throw refuse('APPROVAL_REQUIRED', 'That approval has already been used');
    if (approval.approved_hash !== approvedHash) throw refuse('APPROVAL_REQUIRED', 'It changed after it was approved');
    return approval;
  }

  function append({ prev, accountId, projectId, entity, entityId, type, actor, approvalId = null, approvedHash = null, idempotencyKey = null, payload }) {
    const guarded = needsApproval(entity, type, prev && prev.status);
    if (guarded) requireApproval({ projectId, entity, entityId, type, approvalId, approvedHash });
    const usedApproval = guarded && approvalId ? String(approvalId) : null;
    const at = now().toISOString();
    const text = canonical(payload);
    const seq = Number(q.insertEvent.run(projectId, entity, entityId, type, actor, usedApproval,
      idempotencyKey == null ? null : String(idempotencyKey), sha(text), protect(text), at).lastInsertRowid);
    checkpoint('event');
    if (usedApproval) {
      if (q.consumeApproval.run(seq, usedApproval).changes !== 1) throw refuse('APPROVAL_REQUIRED', 'That approval has already been used');
      checkpoint('approval');
    }
    const next = reduce(prev, { seq, entity, entity_id: entityId, project_id: projectId, created_at: at, approval_id: usedApproval }, payload);
    const body = encode(next.body);
    if (prev) q.updateItem.run(next.projectId, next.status, next.version, next.runId, next.approvalId, body, next.updatedAt, entityId);
    else q.insertItem.run(entityId, accountId, projectId, entity, next.status, next.version, next.runId, next.approvalId, body, next.createdAt, next.updatedAt);
    checkpoint('projection');
    return next;
  }

  function writeRecord(accountId, projectId, entity, fields, { actor, idempotencyKey = null, id = null }) {
    if (!ENTITIES[entity]) throw refuse('INVALID', `Unknown kind of record: ${entity}`);
    const who = actorOf(actor);
    const entityId = id == null ? newId(ENTITIES[entity].prefix) : String(id);
    if (!ID.test(entityId)) throw refuse('INVALID', 'That id is not usable');
    const body = cleanFields(entity, fields, projectId);
    requireTitle(entity, body);
    if (load(entityId)) throw refuse('CONFLICT', 'Something with that id is already recorded');
    return present(append({
      prev: null, accountId: String(accountId), projectId, entity, entityId, type: `${entity}.recorded`, actor: who, idempotencyKey,
      payload: { op: 'record', accountId: String(accountId), body },
    }));
  }

  function createProject(accountId, fields, { actor, idempotencyKey = null, id = null } = {}) {
    if (!accountId) throw refuse('INVALID', 'A project belongs to an account');
    return atomically(() => {
      if (idempotencyKey != null) {
        const prior = q.projectByKey.get(String(idempotencyKey), String(accountId));
        if (prior) return present(load(prior.entity_id));
      }
      const projectId = id == null ? newId(ENTITIES.project.prefix) : String(id);
      return writeRecord(accountId, projectId, 'project', fields, { actor, idempotencyKey, id: projectId });
    });
  }

  function record(accountId, projectId, entity, fields, { actor, idempotencyKey = null, id = null } = {}) {
    if (entity === 'project') throw refuse('INVALID', 'Projects are created with createProject');
    return atomically(() => {
      const project = requireProject(accountId, projectId);
      const again = replayed(project.id, idempotencyKey, null, `${entity}.recorded`);
      if (again) return again;
      return writeRecord(accountId, project.id, entity, fields, { actor, idempotencyKey, id });
    });
  }

  function amend(accountId, id, patch, { actor, approvalId = null, idempotencyKey = null } = {}) {
    const result = atomically(() => {
      const prev = requireItem(accountId, id);
      const type = `${prev.entity}.amended`;
      const again = replayed(prev.projectId, idempotencyKey, prev.id, type);
      if (again) return again;
      if (prev.entity === 'dispatch' || !ENTITIES[prev.entity].moves[prev.status].length) {
        throw refuse('NOT_ALLOWED', `A ${prev.entity} that is ${prev.status} is not changed any more`);
      }
      const who = actorOf(actor);
      const clean = cleanFields(prev.entity, patch, prev.projectId);
      requireTitle(prev.entity, { ...prev.body, ...clean });
      const approvedHash = approvalHash(prev.body, clean);
      const approval = approvalId ? q.approval.get(String(approvalId)) : null;
      const stamp = RULES[prev.entity] && RULES[prev.entity].locked.includes(prev.status) && approval
        ? { approval: { id: approval.id, change: approval.change, by: approval.approved_by, at: approval.created_at } } : {};
      return present(append({
        prev, accountId: prev.accountId, projectId: prev.projectId, entity: prev.entity, entityId: prev.id, type, actor: who,
        approvalId, approvedHash, idempotencyKey, payload: { op: 'amend', patch: { ...clean, ...stamp } },
      }));
    });
    if (RULES[result.entity] && approvalId) note(accountId, 'ledger_rule_amended', `${result.id} ${approvalId}`);
    return result;
  }

  function moveWithin(accountId, id, status, { actor, patch = null, approvalId = null, idempotencyKey = null }, internal) {
    const prev = requireItem(accountId, id);
    const type = `${prev.entity}.${status}`;
    const again = replayed(prev.projectId, idempotencyKey, prev.id, type);
    if (again) return again;
    if (!internal && prev.entity === 'dispatch') throw refuse('NOT_ALLOWED', 'A dispatch is moved by startDispatch and finishDispatch');
    if (!internal && type === 'decision.superseded') throw refuse('NOT_ALLOWED', 'A decision is superseded by settling the one that replaces it');
    const moves = ENTITIES[prev.entity].moves[prev.status];
    if (!moves.includes(status)) throw refuse('NOT_ALLOWED', `A ${prev.entity} that is ${prev.status} cannot become ${status}`);
    const who = actorOf(actor);
    if (RULES[prev.entity] && status === 'rejected' && !PERSON.test(who)) throw refuse('NOT_A_PERSON', `Only a person turns down a proposed ${prev.entity}`);
    const clean = patch == null ? {} : internal ? clone(patch) : cleanFields(prev.entity, patch, prev.projectId);
    const change = RULES[prev.entity] ? RULES[prev.entity].changes[type] : null;
    const settling = type === 'decision.settled';
    const approvedHash = change === 'settle' || change === 'lift' ? approvalHash(prev.body, null) : null;
    const approval = approvedHash && approvalId ? q.approval.get(String(approvalId)) : null;
    if (approval) clean.approval = { id: approval.id, change: approval.change, by: approval.approved_by, at: approval.created_at };
    const next = append({
      prev, accountId: prev.accountId, projectId: prev.projectId, entity: prev.entity, entityId: prev.id, type, actor: who,
      approvalId, approvedHash, idempotencyKey, payload: { op: 'move', status, patch: clean },
    });
    if (settling && approval) {
      for (const sibling of q.approvalGroup.all(approval.group_id, 'supersede')) {
        const target = requireItem(accountId, sibling.entity_id, 'decision');
        const moves = ENTITIES.decision.moves[target.status];
        if (!moves.includes('superseded')) throw refuse('NOT_ALLOWED', `${target.id} is ${target.status} and cannot be superseded`);
        append({
          prev: target, accountId: target.accountId, projectId: target.projectId, entity: 'decision', entityId: target.id,
          type: 'decision.superseded', actor: who, approvalId: sibling.id, approvedHash,
          idempotencyKey: idempotencyKey == null ? null : `${idempotencyKey}#${target.id}`,
          payload: { op: 'move', status: 'superseded', patch: { supersededBy: prev.id } },
        });
      }
    }
    return present(next);
  }

  function move(accountId, id, status, options = {}) {
    const result = atomically(() => moveWithin(accountId, id, status, options, false));
    if (RULES[result.entity] && options.approvalId) note(accountId, `ledger_rule_${status}`, `${result.id} ${options.approvalId}`);
    return result;
  }

  function settle(accountId, decisionId, options = {}) {
    return move(accountId, decisionId, 'settled', options);
  }

  // A person's yes, recorded before it is used. `seenHash` is the hash of the
  // rule as it was shown to them; the approval is bound to that content and,
  // for an amendment, to the exact patch.
  function approve(accountId, ruleId, { change = 'settle', patch = null, seenHash, approvedBy, idempotencyKey = null, id = null } = {}) {
    const result = atomically(() => {
      const rule = requireItem(accountId, ruleId);
      const kind = RULES[rule.entity];
      if (!kind) throw refuse('NOT_FOUND', 'Only a decision or a constraint takes an approval');
      if (idempotencyKey != null) {
        const prior = q.approvalByKey.get(rule.projectId, String(idempotencyKey));
        if (prior) {
          if (prior.entity_id !== rule.id || prior.change !== change) throw refuse('CONFLICT', 'That idempotency key was used for a different approval');
          return presentApproval(prior);
        }
      }
      if (!PERSON.test(String(approvedBy || ''))) throw refuse('NOT_A_PERSON', 'Only a person approves a change to a rule');
      if (seenHash !== hashOf(rule.body)) throw refuse('CHANGED', 'It changed since it was shown. Show it again before approving');
      let approvedHash;
      const superseded = [];
      if (change === 'settle') {
        if (rule.status !== 'proposed') throw refuse('NOT_ALLOWED', `A ${rule.entity} that is ${rule.status} cannot come into force`);
        approvedHash = approvalHash(rule.body, null);
        for (const target of (rule.entity === 'decision' && rule.body.supersedes) || []) {
          const other = requireItem(accountId, target, 'decision');
          if (other.projectId !== rule.projectId || other.status !== 'settled') {
            throw refuse('NOT_ALLOWED', `${other.id} is ${other.status} and cannot be superseded`);
          }
          superseded.push(other.id);
        }
      } else if (change === 'amend') {
        if (rule.status !== kind.inForce) throw refuse('NOT_ALLOWED', `Only a ${rule.entity} in force needs an approval to change`);
        approvedHash = approvalHash(rule.body, cleanFields(rule.entity, patch, rule.projectId));
      } else if (change === 'lift' && rule.entity === 'constraint') {
        if (rule.status !== 'active') throw refuse('NOT_ALLOWED', `A constraint that is ${rule.status} cannot be lifted`);
        approvedHash = approvalHash(rule.body, null);
      } else {
        throw refuse('INVALID', 'That is not a change an approval can make');
      }
      const groupId = id == null ? newId('apr') : String(id);
      if (!ID.test(groupId)) throw refuse('INVALID', 'That id is not usable');
      const at = now().toISOString();
      q.insertApproval.run(groupId, groupId, rule.accountId, rule.projectId, rule.id, change, String(approvedBy),
        approvedHash, idempotencyKey == null ? null : String(idempotencyKey), at);
      checkpoint('approval');
      superseded.forEach((target, index) => {
        q.insertApproval.run(`${groupId}_${index + 1}`, groupId, rule.accountId, rule.projectId, target, 'supersede',
          String(approvedBy), approvedHash, null, at);
        checkpoint('approval');
      });
      return presentApproval(q.approval.get(groupId));
    });
    note(accountId, 'ledger_approval', `${result.change} ${result.decisionId} ${result.id}`);
    return result;
  }

  // ── Conversations ────────────────────────────────────────────────
  //
  // The binding is keyed by account and conversation together, so one
  // account's conversation id says nothing about another's.

  function conversationKey(accountId, conversationId) {
    return `cnv_${sha(`${accountId}\n${conversationId}`).slice(0, 40)}`;
  }

  function bindConversation(accountId, conversationId, projectId, { actor, idempotencyKey = null } = {}) {
    if (conversationId == null || String(conversationId) === '') throw refuse('INVALID', 'A conversation id is needed');
    return atomically(() => {
      const project = requireProject(accountId, projectId);
      const id = conversationKey(accountId, conversationId);
      const again = replayed(project.id, idempotencyKey, id, null);
      if (again) return again;
      if (project.status === 'archived') throw refuse('NOT_ALLOWED', 'An archived project takes no conversations');
      const who = actorOf(actor);
      const prev = load(id);
      if (prev && prev.projectId === project.id) return present(prev);
      return present(append({
        prev, accountId: String(accountId), projectId: project.id, entity: 'conversation', entityId: id,
        type: prev ? 'conversation.switched' : 'conversation.bound', actor: who, idempotencyKey,
        payload: {
          op: 'bind', accountId: String(accountId),
          ...(prev ? {} : { body: { conversationId: String(conversationId).slice(0, 200) } }),
          patch: { from: prev ? prev.projectId : null },
        },
      }));
    });
  }

  function projectFor(accountId, conversationId) {
    const binding = load(conversationKey(accountId, conversationId));
    return binding && binding.accountId === String(accountId) ? binding.projectId : null;
  }

  // What a turn in this conversation works from. Rules and knowledge come back
  // apart, and proposals are listed as proposals, never as rules.
  function contextFor(accountId, conversationId) {
    const projectId = projectFor(accountId, conversationId);
    if (!projectId) throw refuse('NOT_FOUND', 'This conversation is not in a project yet');
    const project = requireProject(accountId, projectId);
    const items = list(accountId, project.id);
    const pick = (entity, statuses) => items.filter(item => item.entity === entity && statuses.includes(item.status));
    return {
      conversationId: String(conversationId),
      project: present(project),
      rules: { decisions: pick('decision', ['settled']), constraints: pick('constraint', ['active']) },
      proposals: { decisions: pick('decision', ['proposed']), constraints: pick('constraint', ['proposed']) },
      knowledge: pick('knowledge', ['current']),
      objectives: pick('objective', ['open']),
      requirements: pick('requirement', ['open']),
      plan: items.filter(item => item.entity === 'plan_step'),
      questions: pick('question', ['open']),
    };
  }

  // ── Dispatch records ─────────────────────────────────────────────
  //
  // One row per piece of work sent to a model. The lifecycle is the action
  // store's: claimed under the id of the running process, so a dispatch left
  // in flight by a process that has gone is recognisable, marked interrupted
  // and never sent again under the same record.

  function recordDispatch(accountId, projectId, fields, options = {}) {
    return record(accountId, projectId, 'dispatch', fields, { actor: 'resident', ...options });
  }

  function fingerprint(sent) {
    if (!sent || typeof sent !== 'object' || Array.isArray(sent)) throw refuse('INVALID', 'sent maps each field name to what was sent');
    return Object.keys(sent).sort().map(field => {
      const text = typeof sent[field] === 'string' ? sent[field] : canonical(sent[field]);
      return { field, bytes: Buffer.byteLength(text), sha256: sha(text) };
    });
  }

  function startDispatch(accountId, id, { runId, sent = {}, actor = 'resident', idempotencyKey = null } = {}) {
    if (!runId) throw refuse('INVALID', 'A dispatch is started by a run');
    return atomically(() => moveWithin(accountId, id, 'in_flight', {
      actor, idempotencyKey,
      patch: { run: { id: String(runId), startedAt: now().toISOString() }, sent: fingerprint(sent) },
    }, true));
  }

  function finishDispatch(accountId, id, { outcome, costMicro = null, latencyMs = null, usage = null, checks = [], error = null, artifactIds = [], actor = 'resident', idempotencyKey = null } = {}) {
    if (outcome !== 'completed' && outcome !== 'failed') throw refuse('INVALID', 'A dispatch finishes completed or failed');
    return atomically(() => {
      const dispatch = requireItem(accountId, id, 'dispatch');
      for (const artifactId of artifactIds) {
        const artifact = requireItem(accountId, artifactId, 'artifact');
        if (artifact.projectId !== dispatch.projectId) throw refuse('INVALID', `${artifactId} is not in this project`);
      }
      const number = value => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
      const result = {
        finishedAt: now().toISOString(),
        costMicro: number(costMicro),
        latencyMs: number(latencyMs),
        usage: usage ? { in: number(usage.in), out: number(usage.out) } : null,
        checks: (checks || []).map(check => ({
          name: String(check.name || '').slice(0, 120),
          passed: check.passed === true,
          detail: check.detail == null ? null : String(check.detail).slice(0, 500),
        })),
        error: error == null ? null : String(error.message || error).slice(0, 2000),
        artifactIds: artifactIds.map(String),
      };
      return moveWithin(accountId, id, outcome, { actor, idempotencyKey, patch: { result } }, true);
    });
  }

  // Run at startup with this process's run id. Everything still in flight
  // under another run was being done by a process that is gone.
  function recoverInterrupted({ runId, reason = 'The process sending this stopped before the answer was recorded' } = {}) {
    if (!runId) throw refuse('INVALID', 'Recovery needs the id of the running process');
    return q.inFlight.all(String(runId)).map(row => atomically(() => moveWithin(row.account_id, row.id, 'interrupted', {
      actor: 'system',
      patch: { interruption: { at: now().toISOString(), byRun: String(runId), reason: String(reason).slice(0, 500) } },
    }, true)));
  }

  function note(accountId, action, details) {
    try { audit(accountId, action, details); } catch { /* the ledger is the record; the audit line is a copy */ }
  }

  // ── Reading ──────────────────────────────────────────────────────

  function get(accountId, id) {
    const item = load(id);
    return item && item.accountId === String(accountId) ? present(item) : null;
  }

  function list(accountId, projectId, { entity = null, status = null } = {}) {
    const where = ['account_id=?', 'project_id=?'];
    const args = [String(accountId), String(projectId)];
    if (entity) { where.push('entity=?'); args.push(entity); }
    if (status) { where.push('status=?'); args.push(status); }
    return db.prepare(`SELECT id FROM ledger_items WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`)
      .all(...args).map(row => present(load(row.id)));
  }

  function projects(accountId) {
    return db.prepare("SELECT id FROM ledger_items WHERE account_id=? AND entity='project' ORDER BY created_at, rowid")
      .all(String(accountId)).map(row => present(load(row.id)));
  }

  function history(accountId, id) {
    requireItem(accountId, id);
    return db.prepare('SELECT * FROM ledger_events WHERE entity_id=? ORDER BY seq').all(String(id)).map(event => ({
      seq: event.seq, type: event.type, actor: event.actor, approvalId: event.approval_id, at: event.created_at,
      ...decode(event.protected_body),
    }));
  }

  function approvals(accountId, ruleId) {
    requireItem(accountId, ruleId);
    return db.prepare('SELECT * FROM ledger_approvals WHERE entity_id=? ORDER BY created_at, rowid').all(String(ruleId)).map(presentApproval);
  }

  // Everything about one project, grouped. The later task preparer reads this
  // to write a brief; nothing here is sent anywhere.
  function snapshot(accountId, projectId) {
    const project = requireProject(accountId, projectId);
    const items = list(accountId, project.id).filter(item => item.entity !== 'project');
    const of = entity => items.filter(item => item.entity === entity);
    return {
      project: present(project),
      objectives: of('objective'),
      requirements: of('requirement'),
      constraints: of('constraint'),
      decisions: of('decision'),
      plan: of('plan_step'),
      artifacts: of('artifact'),
      questions: of('question'),
      knowledge: of('knowledge'),
      conversations: of('conversation'),
      dispatches: of('dispatch'),
    };
  }

  // Rebuilds every item from the log and compares it with the stored view, and
  // checks that every change needing an approval used exactly one.
  function verify() {
    const problems = [];
    const rebuilt = new Map();
    for (const event of db.prepare('SELECT * FROM ledger_events ORDER BY seq').all()) {
      let payload;
      try { payload = decode(event.protected_body); } catch { problems.push(`event ${event.seq} cannot be read`); continue; }
      if (sha(canonical(payload)) !== event.body_hash) problems.push(`event ${event.seq} does not match its hash`);
      const prev = rebuilt.get(event.entity_id) || null;
      if (needsApproval(event.entity, event.type, prev && prev.status)) {
        const approval = event.approval_id ? q.approval.get(event.approval_id) : null;
        if (!approval || approval.consumed_seq !== event.seq || approval.entity_id !== event.entity_id) {
          problems.push(`event ${event.seq} changed rule ${event.entity_id} without its own approval`);
        }
      }
      rebuilt.set(event.entity_id, reduce(prev, event, payload));
    }
    const stored = db.prepare('SELECT * FROM ledger_items').all();
    for (const row of stored) {
      const expected = rebuilt.get(row.id);
      if (!expected) { problems.push(`item ${row.id} has no events`); continue; }
      let body;
      try { body = decode(row.protected_body); } catch { problems.push(`item ${row.id} cannot be read`); continue; }
      const same = row.status === expected.status && row.version === expected.version && row.account_id === expected.accountId
        && row.project_id === expected.projectId && row.entity === expected.entity && (row.run_id || null) === (expected.runId || null)
        && (row.approval_id || null) === (expected.approvalId || null) && canonical(body) === canonical(expected.body)
        && row.created_at === expected.createdAt && row.updated_at === expected.updatedAt;
      if (!same) problems.push(`item ${row.id} does not match its events`);
    }
    if (stored.length !== rebuilt.size) problems.push(`${rebuilt.size - stored.length} items in the log are missing from the view`);
    for (const approval of db.prepare('SELECT * FROM ledger_approvals WHERE consumed_seq IS NOT NULL').all()) {
      const event = db.prepare('SELECT approval_id FROM ledger_events WHERE seq=?').get(approval.consumed_seq);
      if (!event || event.approval_id !== approval.id) problems.push(`approval ${approval.id} is marked used by an event that did not use it`);
    }
    return { ok: problems.length === 0, problems, events: db.prepare('SELECT COUNT(*) AS n FROM ledger_events').get().n, items: stored.length };
  }

  return {
    createProject, record, amend, move, settle, approve,
    bindConversation, projectFor, contextFor,
    recordDispatch, startDispatch, finishDispatch, recoverInterrupted,
    get, list, projects, history, approvals, snapshot, verify,
    hashOf,
  };
}

module.exports = { createProjectLedger, LedgerError, entities: ENTITIES, rules: RULES, canonical };
