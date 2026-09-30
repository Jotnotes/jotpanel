'use strict';

const { redact, holdsSecret, SCRUBBED, SECRET_PARAM } = require('./secrets');

const crypto = require('crypto');

const STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTING: 'executing',
  EXECUTED: 'executed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

// The states an action can still move out of. Everything else is terminal.
const OPEN_STATUSES = Object.freeze([STATUSES.PENDING, STATUSES.APPROVED, STATUSES.EXECUTING]);

/**
 * Durable action store used by both Echo provisioning and the native panel.
 *
 * Proposal and result bodies can contain credentials or command arguments, so
 * callers must provide protect/unprotect in production. Only the fields needed
 * to list and filter work are left in clear text. The default identity codec is
 * intentionally useful for isolated tests only.
 */
function createActionStore({
  db,
  now = () => new Date(),
  protect = (value) => value,
  unprotect = (value) => value,
} = {}) {
  if (!db) throw new Error('action store requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS control_actions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      kind            TEXT NOT NULL,
      label           TEXT NOT NULL,
      risk_level      TEXT NOT NULL DEFAULT 'standard',
      status          TEXT NOT NULL DEFAULT 'pending',
      protected_body  TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      approved_at     TEXT,
      approved_by     TEXT,
      rejected_at     TEXT,
      rejected_by     TEXT,
      rejected_reason TEXT,
      started_at      TEXT,
      run_id          TEXT,
      executed_at     TEXT,
      failed_at       TEXT,
      interrupted_at  TEXT,
      error            TEXT,
      verified        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_control_actions_user_created
      ON control_actions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_control_actions_status
      ON control_actions (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_control_actions_kind_outcome
      ON control_actions (kind, status, created_at DESC);
  `);

  // An install that predates the executing state has the table without these
  // columns, and CREATE TABLE IF NOT EXISTS will not add them. Adding them here
  // means an upgraded panel reconciles its own history rather than starting the
  // record afresh.
  const columns = new Set(db.prepare('PRAGMA table_info(control_actions)').all().map(row => row.name));
  for (const [name, type] of [['started_at', 'TEXT'], ['run_id', 'TEXT'], ['interrupted_at', 'TEXT'], ['verified', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE control_actions ADD COLUMN ${name} ${type}`);
  }

  // ── The outcome, out where a query can see it ────────────────────
  //
  // Whether a run was read back afterwards lives in `executionResult.verified`,
  // and that sits inside the encrypted body, so the only way to answer "has
  // this operation ever verified on this box" used to be to page the whole
  // record out over HTTP and decrypt every row. The listing is capped, so the
  // answer had a horizon: run a few hundred proofs in a session and the older
  // ones fall off the back and read as never run. That is how a checklist total
  // went down on a day when nothing regressed.
  //
  // So the verdict is written in clear next to the row on the same statement
  // that records the outcome. It is a verdict, not a copy of the result: three
  // words for the three things that can be true of a finished run, and the body
  // stays the record.
  //
  //   yes           the machine was asked afterwards and agreed
  //   unverifiable  it says it could not check, and says why, which is honest
  //   no            it finished and nothing read it back
  //
  // Nothing reads this to decide anything. It exists so the question can be
  // asked in one indexed query instead of by exhausting a paged list.
  function verdictOf(result) {
    if (result && result.verified === true) return 'yes';
    if (result && result.verified === false && (result.unverified_reason || result.note)) return 'unverifiable';
    return 'no';
  }

  // Rows that finished before the column existed carry their verdict inside the
  // body and nowhere else. One pass fills them in, and because every row it
  // touches ends with a value, the pass finds nothing to do on every boot after
  // the first. A row whose body will not decode is marked as such rather than
  // guessed at: calling it unverified would be a claim about a run nobody can
  // read.
  const unfilled = db.prepare(`SELECT id, protected_body FROM control_actions
                                WHERE verified IS NULL AND status IN (?,?)`).all(STATUSES.EXECUTED, STATUSES.FAILED);
  if (unfilled.length) {
    const write = db.prepare('UPDATE control_actions SET verified=? WHERE id=?');
    const fill = db.transaction(rows => {
      for (const row of rows) {
        let verdict = 'unreadable';
        try { verdict = verdictOf(decode(row.protected_body).executionResult); } catch { /* left unreadable */ }
        write.run(verdict, row.id);
      }
    });
    fill(unfilled);
  }

  function encode(value) {
    return protect(JSON.stringify(value));
  }

  function decode(value) {
    return JSON.parse(unprotect(value));
  }

  // ── Spending a secret ────────────────────────────────────────────
  //
  // `call.params` is the encrypted payload the operation runs on, and it has to
  // hold the real credential right up until the moment the work happens. What
  // it must not do is hold it afterwards. An action is kept for ever, so
  // without this the SMTP password that connected a provider in August is still
  // in the record next year, long after the binding was disconnected, and one
  // object-store secret key is the whole bucket.
  //
  // So the key is dropped the moment the action becomes terminal, inside the
  // store, on the same write that records the outcome. No sweep, no cron, no
  // chore anybody has to remember: an action that can never run again cannot
  // need the key that would have run it.
  //
  // What is kept: the label, the summary, the outcome, the error, and
  // `metadata.params`, which was already the redacted audit summary and is
  // untouched. What goes is the live value, replaced with a word that says it
  // was removed rather than merely hidden.
  function spend(item) {
    if (!item || !item.call || !item.call.params) return item;
    if (!holdsSecret(item.call.params)) return item;
    return {
      ...item,
      call: { ...item.call, params: redact(item.call.params, { replacement: SCRUBBED }) },
      // Auditable in its own right: the record says the secret was there and
      // says when it stopped being there.
      credentialScrubbedAt: now().toISOString(),
    };
  }

  function hydrate(row) {
    if (!row) return null;
    const body = decode(row.protected_body);
    return {
      ...body,
      id: row.id,
      accountId: body.accountId || row.user_id,
      kind: row.kind,
      label: row.label,
      riskLevel: row.risk_level,
      status: row.status,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      startedAt: row.started_at,
      runId: row.run_id,
      rejectedAt: row.rejected_at,
      rejectedBy: row.rejected_by,
      rejectedReason: row.rejected_reason,
      executedAt: row.executed_at,
      failedAt: row.failed_at,
      interruptedAt: row.interrupted_at,
      error: row.error,
    };
  }

  function get(id) {
    return hydrate(db.prepare('SELECT * FROM control_actions WHERE id=?').get(id));
  }

  function list({ accountId, userId, status, kind, limit = 250 } = {}) {
    const where = [];
    const args = [];
    const owner = accountId || userId;
    if (owner) { where.push('user_id=?'); args.push(owner); }
    if (status) { where.push('status=?'); args.push(status); }
    if (kind) { where.push('kind=?'); args.push(kind); }
    const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
    const sql = `SELECT * FROM control_actions${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ${safeLimit}`;
    return db.prepare(sql).all(...args).map(hydrate);
  }

  // ── What has ever run here, per operation ────────────────────────
  //
  // The question the checklist asks, answered as a question rather than by
  // paging the record and counting. `list` is capped at a thousand rows newest
  // first, which is right for a screen and wrong for "has this ever run": a
  // busy session pushes the older proofs past the cap and they come back as
  // never run.
  //
  // This groups instead. One row per kind, out of the index on
  // (kind, status, created_at), with no limit anywhere in it, so a proof from
  // February reads the same after ten thousand actions as it did the day it
  // ran.
  //
  // Scoped to one holder, exactly as `list` is. This is a cheaper way to ask
  // the same question, not a wider one: nothing here may show a caller an
  // operation somebody else ran.
  //
  // Both a last outcome and a last verified time are returned, because they are
  // different facts and collapsing them loses the interesting case. An
  // operation that verified in June and failed this morning is neither "works"
  // nor "never ran", and the caller should be the one to decide what to call it.
  function summarizeByKind({ accountId, userId, prefix = null } = {}) {
    const owner = accountId || userId;
    const where = ['status IN (?,?)'];
    const args = [STATUSES.EXECUTED, STATUSES.FAILED];
    if (owner) { where.push('user_id=?'); args.push(owner); }
    if (prefix) { where.push('kind LIKE ? ESCAPE \'\\\''); args.push(`${String(prefix).replace(/[\\%_]/g, '\\$&')}%`); }
    const rows = db.prepare(`SELECT kind,
        COUNT(*) AS runs,
        SUM(CASE WHEN status=? THEN 1 ELSE 0 END) AS failures,
        MAX(CASE WHEN verified='yes' THEN COALESCE(executed_at, created_at) END) AS verified_at,
        MAX(CASE WHEN verified='unverifiable' THEN COALESCE(executed_at, created_at) END) AS unverifiable_at,
        MAX(CASE WHEN status=? THEN COALESCE(failed_at, created_at) END) AS failed_at,
        MAX(COALESCE(executed_at, failed_at, created_at)) AS last_at
      FROM control_actions
      WHERE ${where.join(' AND ')}
      GROUP BY kind
      ORDER BY kind`).all(STATUSES.FAILED, STATUSES.FAILED, ...args);
    // Why the last failure said it failed, taken from the row that failed most
    // recently. SQLite hands back the bare column from whichever row supplied
    // the MAX, which is the one wanted here and the reason this is a second
    // grouped query rather than a join.
    const reasons = new Map(db.prepare(`SELECT kind, error, MAX(COALESCE(failed_at, created_at))
      FROM control_actions
      WHERE ${['status=?', ...where.slice(1)].join(' AND ')}
      GROUP BY kind`).all(STATUSES.FAILED, ...args.slice(2)).map(row => [row.kind, row.error]));
    return rows.map(row => ({
      kind: row.kind,
      runs: row.runs,
      failures: row.failures || 0,
      // The most recent run that the machine was asked about afterwards and
      // agreed with. Null means no run of this operation was ever read back,
      // which is not the same as the operation failing.
      verifiedAt: row.verified_at || null,
      // Ran, and said out loud that it could not check itself. A reboot is the
      // honest example: nothing inside a machine can watch it restart.
      unverifiableAt: row.unverifiable_at || null,
      lastFailedAt: row.failed_at || null,
      lastError: row.failed_at ? (reasons.get(row.kind) || null) : null,
      lastAt: row.last_at || null,
    }));
  }

  function enqueue(proposal) {
    const userId = proposal.accountId || proposal.userId;
    if (!userId) throw new Error('action proposal requires accountId or userId');
    const id = proposal.id || `act_${crypto.randomBytes(10).toString('hex')}`;
    const createdAt = proposal.createdAt || now().toISOString();
    const action = {
      ...proposal,
      id,
      accountId: userId,
      kind: proposal.kind || proposal.actionKey || 'control.action',
      status: STATUSES.PENDING,
      createdAt,
      approvedAt: null,
      rejectedAt: null,
      startedAt: null,
      executedAt: null,
      failedAt: null,
      interruptedAt: null,
      executionResult: null,
      error: null,
    };
    db.prepare(`INSERT INTO control_actions
      (id,user_id,kind,label,risk_level,status,protected_body,created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, userId, action.kind, action.label || action.kind,
        action.riskLevel || 'standard', STATUSES.PENDING, encode(action), createdAt);
    return get(id);
  }

  function approve(id, { approvedBy, confirmText } = {}) {
    const item = requireItem(id);
    if (item.status !== STATUSES.PENDING) {
      throw new Error(`Action ${id} is ${item.status}, not pending`);
    }
    if (item.requiresConfirmText && item.requiresConfirmText !== confirmText) {
      throw new Error(`Action ${id} requires confirm text: ${item.requiresConfirmText}`);
    }
    const at = now().toISOString();
    db.prepare(`UPDATE control_actions
                   SET status=?, approved_at=?, approved_by=?, error=NULL
                 WHERE id=? AND status=?`)
      .run(STATUSES.APPROVED, at, approvedBy || null, id, STATUSES.PENDING);
    return get(id);
  }

  function reject(id, { rejectedBy, reason } = {}) {
    const item = requireItem(id);
    if (item.status !== STATUSES.PENDING) {
      throw new Error(`Action ${id} is ${item.status}, not pending`);
    }
    const at = now().toISOString();
    // A rejected proposal never ran, and the credential in it was typed by
    // somebody and is real. Rejecting used to leave the body untouched, so a
    // key somebody thought better of sending was kept for ever on the strength
    // of a decision not to use it.
    const next = spend(item);
    db.prepare(`UPDATE control_actions
                   SET status=?, rejected_at=?, rejected_by=?, rejected_reason=?, protected_body=?
                 WHERE id=? AND status=?`)
      .run(STATUSES.REJECTED, at, rejectedBy || null, reason || null, encode(next), id, STATUSES.PENDING);
    return get(id);
  }

  // Claim the action before the work starts, stamped with the id of the process
  // doing it. This is the whole of what makes an interrupted execution
  // recognisable afterwards: a row left in `approved` might simply be waiting
  // its turn, while a row left in `executing` under a run id that is not the
  // running process was being executed by something that is no longer alive.
  function markExecuting(id, { runId } = {}) {
    const item = requireItem(id);
    if (item.status !== STATUSES.APPROVED) {
      throw new Error(`Action ${id} must be approved before execution`);
    }
    const at = now().toISOString();
    db.prepare(`UPDATE control_actions
                   SET status=?, started_at=?, run_id=?, error=NULL
                 WHERE id=? AND status=?`)
      .run(STATUSES.EXECUTING, at, runId || null, id, STATUSES.APPROVED);
    return get(id);
  }

  // Re-stamp an action this process has taken over. Used when the panel
  // restarts while the privileged unit doing the work is still running: the
  // work was not interrupted, only the process watching it was.
  function adoptExecuting(id, { runId } = {}) {
    const item = requireItem(id);
    if (item.status !== STATUSES.EXECUTING) {
      throw new Error(`Action ${id} is ${item.status}, not executing`);
    }
    db.prepare('UPDATE control_actions SET run_id=? WHERE id=? AND status=?')
      .run(runId || null, id, STATUSES.EXECUTING);
    return get(id);
  }

  function markExecuted(id, result) {
    const item = requireItem(id);
    if (item.status !== STATUSES.APPROVED && item.status !== STATUSES.EXECUTING) {
      throw new Error(`Action ${id} must be approved before execution`);
    }
    const at = now().toISOString();
    const next = spend({ ...item, executionResult: result == null ? null : clone(result), error: null });
    db.prepare(`UPDATE control_actions
                   SET status=?, executed_at=?, protected_body=?, verified=?, error=NULL
                 WHERE id=? AND status IN (?,?)`)
      .run(STATUSES.EXECUTED, at, encode(next), verdictOf(next.executionResult), id, STATUSES.APPROVED, STATUSES.EXECUTING);
    return get(id);
  }

  // A run that already happened, with nobody present, recorded as the terminal
  // thing it is.
  //
  // This exists because there was no way to write one down. `markExecuted`
  // refuses anything that was not approved first, correctly, and the only ways
  // past that were to invent an approval or to leave scheduled backups out of
  // the record entirely. Both are wrong, and the second is what shipped: a
  // backup that failed at 3am told nobody.
  //
  // The rule this function exists to hold: `executionBasis` is
  // `unattended_schedule` and `approvedBy` is null, always, and no argument can
  // change either. A caller that passes an approver is refused rather than
  // honoured, because an approval a machine issued is worse than no record at
  // all: it puts a person's name against a decision they never made.
  function recordUnattended({ accountId, kind, actionKey, label, summary, metadata = {}, outcome, result = null, error = null }) {
    if (!accountId) throw new Error('an unattended run requires an accountId');
    if (metadata.approvedBy || metadata.approvalId || (result && (result.approvedBy || result.approvalId))) {
      throw new Error('an unattended run may never carry an approval');
    }
    const failed = outcome === 'failed' || outcome === 'not_started';
    const id = `act_${crypto.randomBytes(10).toString('hex')}`;
    const at = now().toISOString();
    const message = failed ? String(error && error.message ? error.message : error || 'The scheduled run did not succeed').slice(0, 2000) : null;
    const action = {
      id,
      accountId,
      kind: kind || 'control.unattended',
      actionKey: actionKey || null,
      label: label || kind,
      summary: summary || null,
      riskLevel: 'standard',
      // Never approved, and never pending an approval either: it has already
      // run. There is no stage here for anybody to fill in after the fact.
      requiresApproval: false,
      approvedBy: null,
      approvedAt: null,
      executionBasis: 'unattended_schedule',
      status: failed ? STATUSES.FAILED : STATUSES.EXECUTED,
      createdAt: at,
      executedAt: failed ? null : at,
      failedAt: failed ? at : null,
      rejectedAt: null,
      startedAt: null,
      interruptedAt: null,
      metadata: { ...metadata, executionBasis: 'unattended_schedule' },
      executionResult: result == null ? null : clone(result),
      error: message,
    };
    db.prepare(`INSERT INTO control_actions
      (id,user_id,kind,label,risk_level,status,protected_body,created_at,executed_at,failed_at,error,verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, accountId, action.kind, action.label, 'standard', action.status,
        // Written straight into a terminal state, so it is spent on the way in.
        // There is no call body on an unattended run today; this is here so
        // that stays true if one is ever added.
        encode(spend(action)), at, action.executedAt, action.failedAt, message, verdictOf(action.executionResult));
    return get(id);
  }

  function markFailed(id, error, result = null) {
    const item = requireItem(id);
    if (item.status !== STATUSES.APPROVED && item.status !== STATUSES.EXECUTING) {
      throw new Error(`Action ${id} must be approved before failure can be recorded`);
    }
    const at = now().toISOString();
    const message = String(error && error.message ? error.message : error || 'Execution failed').slice(0, 2000);
    // A failure spends the credential too. It went to the far end, which
    // refused it; that makes it used, not unused, and a key that was rejected
    // is still a key.
    const next = spend({ ...item, executionResult: result == null ? null : clone(result), error: message });
    db.prepare(`UPDATE control_actions
                   SET status=?, failed_at=?, protected_body=?, verified=?, error=?
                 WHERE id=? AND status IN (?,?)`)
      .run(STATUSES.FAILED, at, encode(next), verdictOf(next.executionResult), message, id, STATUSES.APPROVED, STATUSES.EXECUTING);
    return get(id);
  }

  // Neither executed nor failed, because neither is known. The panel stopped
  // while this was running and nothing durable was left behind to read, so the
  // record says exactly that and names what to look at instead of guessing.
  function markInterrupted(id, { reason, evidence = null } = {}) {
    const item = requireItem(id);
    if (item.status !== STATUSES.EXECUTING) {
      throw new Error(`Action ${id} is ${item.status}, not executing`);
    }
    const at = now().toISOString();
    const message = String(reason || 'The panel stopped while this action was running and the outcome was not observed').slice(0, 2000);
    // Interrupted is terminal here: execute() only accepts an approved action,
    // so nothing can pick this up again, and a payload that can never be run is
    // a payload with no reason to keep its key.
    const next = spend({ ...item, executionResult: evidence == null ? null : clone(evidence), interruptionReason: message, error: null });
    db.prepare(`UPDATE control_actions
                   SET status=?, interrupted_at=?, protected_body=?, error=NULL
                 WHERE id=? AND status=?`)
      .run(STATUSES.INTERRUPTED, at, encode(next), id, STATUSES.EXECUTING);
    return get(id);
  }

  // Every action left mid-execution, newest first. A run id excludes the rows
  // this process is executing right now, which is what the startup pass wants.
  function listExecuting({ exceptRunId = null } = {}) {
    const rows = exceptRunId
      ? db.prepare('SELECT * FROM control_actions WHERE status=? AND (run_id IS NULL OR run_id<>?) ORDER BY created_at DESC').all(STATUSES.EXECUTING, exceptRunId)
      : db.prepare('SELECT * FROM control_actions WHERE status=? ORDER BY created_at DESC').all(STATUSES.EXECUTING);
    return rows.map(hydrate);
  }

  // The one way a stored proposal changes after it is made, and it is bounded
  // on purpose. Pending only: an approved, running or finished row is a record
  // and records are not edited. What the action IS cannot move either, so an
  // amendment can fill in a parameter and can never turn one operation into
  // another between the moment a person read the card and the moment they
  // approved it.
  function amendPending(id, mutate) {
    const item = requireItem(id);
    if (item.status !== STATUSES.PENDING) throw new Error(`Action ${id} is ${item.status}, not pending`);
    const next = mutate(clone(item));
    const sameAction = next && next.id === item.id && next.status === STATUSES.PENDING
      && next.accountId === item.accountId && next.kind === item.kind && next.actionKey === item.actionKey
      && next.riskLevel === item.riskLevel && next.requiresConfirmText === item.requiresConfirmText;
    if (!sameAction) throw new Error('An amendment may not change what the action is');
    db.prepare('UPDATE control_actions SET protected_body=?, label=? WHERE id=? AND status=?')
      .run(encode(next), next.label || item.label, id, STATUSES.PENDING);
    return get(id);
  }

  function requireItem(id) {
    const item = get(id);
    if (!item) throw new Error(`Unknown approval action: ${id}`);
    return item;
  }

  return {
    enqueue, list, summarizeByKind, get, approve, reject, amendPending, recordUnattended,
    markExecuting, adoptExecuting, markExecuted, markFailed, markInterrupted, listExecuting,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { createActionStore, statuses: STATUSES, openStatuses: OPEN_STATUSES };
