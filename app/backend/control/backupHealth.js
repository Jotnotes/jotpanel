'use strict';

const crypto = require('crypto');

const HEALTH_ORDER = Object.freeze({ failed: 0, overdue: 1, never_backed_up: 2, running: 3, healthy: 4 });
const FAILURE_FALLBACK = 'The backup did not finish.';

function createBackupHealthStore({ db, now = () => new Date() } = {}) {
  if (!db) throw new Error('backup health requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_policies (
      id                      TEXT PRIMARY KEY,
      account_id              TEXT NOT NULL,
      primary_domain_snapshot TEXT NOT NULL,
      current_version_id      TEXT,
      enabled                 INTEGER NOT NULL DEFAULT 1,
      state                   TEXT NOT NULL DEFAULT 'active',
      next_due_at             TEXT,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL,
      created_by              TEXT,
      updated_by              TEXT,
      UNIQUE (account_id, primary_domain_snapshot)
    );

    CREATE TABLE IF NOT EXISTS backup_policy_versions (
      id                TEXT PRIMARY KEY,
      policy_id         TEXT NOT NULL,
      version           INTEGER NOT NULL,
      schedule_expression TEXT NOT NULL,
      timezone          TEXT NOT NULL DEFAULT 'UTC',
      grace_seconds     INTEGER NOT NULL,
      include_files     INTEGER NOT NULL,
      include_mail      INTEGER NOT NULL,
      include_databases INTEGER NOT NULL,
      retention_count   INTEGER NOT NULL,
      created_at        TEXT NOT NULL,
      created_by        TEXT,
      UNIQUE (policy_id, version)
    );

    CREATE TABLE IF NOT EXISTS backup_runs (
      id                      TEXT PRIMARY KEY,
      operation_record_id     TEXT,
      account_id              TEXT NOT NULL,
      account_name_snapshot   TEXT NOT NULL,
      primary_domain_snapshot TEXT NOT NULL,
      policy_version_id       TEXT,
      trigger                 TEXT NOT NULL,
      status                  TEXT NOT NULL,
      current_stage           TEXT,
      started_at              TEXT,
      finished_at             TEXT,
      source_observed_at      TEXT,
      verified_at             TEXT,
      bytes_total             INTEGER NOT NULL DEFAULT 0,
      failure_code            TEXT,
      failure_summary         TEXT,
      failure_detail_ref      TEXT,
      worker_id               TEXT,
      lease_expires_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backup_runs_account_started
      ON backup_runs (account_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_backup_runs_status_started
      ON backup_runs (status, started_at DESC);

    CREATE TABLE IF NOT EXISTS backup_run_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      sequence     INTEGER NOT NULL,
      event_key    TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      stage        TEXT,
      status       TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      occurred_at  TEXT NOT NULL,
      worker_id    TEXT,
      UNIQUE (run_id, sequence),
      UNIQUE (run_id, event_key)
    );
    CREATE INDEX IF NOT EXISTS idx_backup_run_events_run
      ON backup_run_events (run_id, sequence);

    CREATE TRIGGER IF NOT EXISTS backup_run_events_no_update
      BEFORE UPDATE ON backup_run_events BEGIN
        SELECT RAISE(ABORT, 'backup run events are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS backup_run_events_no_delete
      BEFORE DELETE ON backup_run_events BEGIN
        SELECT RAISE(ABORT, 'backup run events are append-only');
      END;
    CREATE TRIGGER IF NOT EXISTS backup_policy_versions_no_update
      BEFORE UPDATE ON backup_policy_versions BEGIN
        SELECT RAISE(ABORT, 'backup policy versions are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS backup_policy_versions_no_delete
      BEFORE DELETE ON backup_policy_versions BEGIN
        SELECT RAISE(ABORT, 'backup policy versions are immutable');
      END;

    CREATE TABLE IF NOT EXISTS backup_run_components (
      run_id               TEXT NOT NULL,
      component            TEXT NOT NULL,
      status               TEXT NOT NULL,
      started_at           TEXT,
      finished_at          TEXT,
      artifact_count       INTEGER NOT NULL DEFAULT 0,
      bytes                INTEGER NOT NULL DEFAULT 0,
      expected_object_count INTEGER,
      captured_object_count INTEGER,
      source_timestamp     TEXT,
      failure_code         TEXT,
      failure_summary      TEXT,
      PRIMARY KEY (run_id, component)
    );

    CREATE TABLE IF NOT EXISTS backup_database_results (
      run_id                 TEXT NOT NULL,
      database_id            TEXT NOT NULL,
      database_name_snapshot TEXT NOT NULL,
      engine                 TEXT,
      snapshot_started_at    TEXT,
      expected_table_count   INTEGER,
      captured_table_count   INTEGER,
      expected_tables_digest TEXT,
      captured_tables_digest TEXT,
      dump_bytes             INTEGER,
      dump_sha256            TEXT,
      structure_check_status TEXT,
      failure_code           TEXT,
      PRIMARY KEY (run_id, database_id)
    );

    CREATE TABLE IF NOT EXISTS backup_artifacts (
      id                   TEXT PRIMARY KEY,
      run_id               TEXT NOT NULL,
      component            TEXT NOT NULL,
      worker_locator       TEXT,
      format               TEXT,
      bytes                INTEGER NOT NULL,
      sha256               TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      archive_check_status TEXT,
      manifest_check_status TEXT,
      verified_at          TEXT,
      state                TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_manifests (
      run_id          TEXT PRIMARY KEY,
      manifest_version INTEGER NOT NULL,
      manifest_json   TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS backup_account_health (
      account_id              TEXT PRIMARY KEY,
      account_name_snapshot   TEXT NOT NULL,
      primary_domain_snapshot TEXT,
      policy_id               TEXT,
      policy_version_id       TEXT,
      policy_state            TEXT NOT NULL,
      health_status           TEXT NOT NULL,
      status_label            TEXT NOT NULL,
      last_attempt_run_id     TEXT,
      last_attempt_at         TEXT,
      last_attempt_status     TEXT,
      last_verified_run_id    TEXT,
      last_verified_at        TEXT,
      last_local_verified_at  TEXT,
      next_due_at             TEXT,
      overdue_at              TEXT,
      consecutive_failures    INTEGER NOT NULL DEFAULT 0,
      latest_failure_code     TEXT,
      latest_failure_summary  TEXT,
      bytes_total             INTEGER NOT NULL DEFAULT 0,
      components_json         TEXT NOT NULL DEFAULT '[]',
      updated_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backup_account_health_status
      ON backup_account_health (health_status, account_name_snapshot);
  `);

  // Added after the first version of this table shipped. An offsite copy is
  // part of whether a backup is real, and the table was written as though the
  // only place a backup could be was this machine, so a run whose local
  // artifact verified and whose offsite copy never arrived read as succeeded
  // and the account read as healthy. Guarded so an existing installation gains
  // the columns without a migration step somebody has to remember to run.
  for (const column of [
    "ALTER TABLE backup_runs ADD COLUMN offsite_state TEXT NOT NULL DEFAULT 'not_configured'",
    'ALTER TABLE backup_runs ADD COLUMN offsite_destination TEXT',
    'ALTER TABLE backup_runs ADD COLUMN offsite_summary TEXT',
    'ALTER TABLE backup_runs ADD COLUMN offsite_verified_at TEXT',
    'ALTER TABLE backup_runs ADD COLUMN offsite_parts_stored INTEGER',
    'ALTER TABLE backup_runs ADD COLUMN offsite_parts_expected INTEGER',
    "ALTER TABLE backup_account_health ADD COLUMN offsite_state TEXT NOT NULL DEFAULT 'not_configured'",
    'ALTER TABLE backup_account_health ADD COLUMN last_offsite_verified_at TEXT',
    'ALTER TABLE backup_account_health ADD COLUMN offsite_summary TEXT',
  ]) {
    try { db.exec(column); } catch { /* already there */ }
  }

  // ── Incidents ────────────────────────────────────────────────────
  //
  // Built here rather than beside here, because the health store already holds
  // runs, events and per-account state and a second system would drift from it
  // within a month. An incident is one ongoing problem with one account's
  // backups, opened by a failure and closed by a later success. It exists so a
  // hosting company is told once rather than every time a nightly run fails,
  // and told again if it is still broken tomorrow.
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_incidents (
      id                TEXT PRIMARY KEY,
      fingerprint       TEXT NOT NULL UNIQUE,
      account_id        TEXT NOT NULL,
      account_name_snapshot TEXT NOT NULL,
      domain            TEXT,
      stage             TEXT,
      failure_code      TEXT,
      failure_summary   TEXT,
      state             TEXT NOT NULL,
      occurrences       INTEGER NOT NULL DEFAULT 1,
      opened_at         TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL,
      resolved_at       TEXT,
      acknowledged_at   TEXT,
      acknowledged_by   TEXT,
      last_notified_at  TEXT,
      notify_count      INTEGER NOT NULL DEFAULT 0,
      last_notify_error TEXT,
      last_run_id       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backup_incidents_state ON backup_incidents (state, last_seen_at DESC);
  `);

  function appendEvent(runId, event) {
    const key = String(event.key || `${event.event_type || 'event'}:${event.occurred_at || now().toISOString()}`);
    const exists = db.prepare('SELECT 1 FROM backup_run_events WHERE run_id=? AND event_key=?').get(runId, key);
    if (exists) return false;
    const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM backup_run_events WHERE run_id=?').get(runId).next;
    db.prepare(`INSERT INTO backup_run_events
      (run_id,sequence,event_key,event_type,stage,status,details_json,occurred_at,worker_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      runId, sequence, key, event.event_type || 'event', event.stage || null, event.status || null,
      JSON.stringify(event.details || {}), event.occurred_at || now().toISOString(), event.worker_id || null,
    );
    return true;
  }

  function startRun({ runId, identityId, domain, trigger = 'manual', operationRecordId = null, requestedComponents = [], workerId = null }) {
    if (!runId) throw new Error('a backup run requires a run id');
    const account = accountSnapshot(identityId, domain);
    appendEvent(runId, {
      key: 'panel:run-started', event_type: 'run_started', stage: 'preflight', status: 'running',
      occurred_at: now().toISOString(), worker_id: workerId,
      details: {
        account_id: account.accountId,
        account_name_snapshot: account.name,
        primary_domain_snapshot: domain || account.primaryDomain,
        identity_id: identityId || null,
        operation_record_id: operationRecordId,
        trigger,
        requested_components: requestedComponents,
        source_observed_at: now().toISOString(),
      },
    });
    projectRun(runId);
    rebuildHealth();
    return runId;
  }

  function completeRun({ identityId, operationRecordId = null, truth, fallback = {} }) {
    const evidence = normalizeTruth(truth, { ...fallback, status: 'succeeded' });
    return recordEvidence({ identityId, operationRecordId, evidence });
  }

  function failRun({ identityId, operationRecordId = null, truth, runId, domain, trigger = 'manual', error, failureCode = null, requestedComponents = [] }) {
    const evidence = normalizeTruth(truth, {
      run_id: runId,
      domain,
      trigger,
      status: 'failed',
      stage: truth?.stage || 'preflight',
      started_at: truth?.started_at || now().toISOString(),
      finished_at: now().toISOString(),
      source_observed_at: truth?.source_observed_at || now().toISOString(),
      requested_components: requestedComponents,
      failure_code: failureCode || truth?.failure_code || 'BACKUP_EXECUTION_FAILED',
      failure_summary: safeFailure(error || truth?.failure_summary || FAILURE_FALLBACK),
    });
    return recordEvidence({ identityId, operationRecordId, evidence });
  }

  function recordEvidence({ identityId, operationRecordId, evidence }) {
    if (!evidence.run_id) throw new Error('backup evidence has no run id');
    const account = accountSnapshot(identityId, evidence.domain);
    const transaction = db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM backup_run_events WHERE run_id=?').get(evidence.run_id)) {
        appendEvent(evidence.run_id, {
          key: 'panel:run-started', event_type: 'run_started', stage: 'preflight', status: 'running',
          occurred_at: evidence.started_at || now().toISOString(), worker_id: evidence.worker_id || null,
          details: {
            account_id: account.accountId,
            account_name_snapshot: account.name,
            primary_domain_snapshot: evidence.domain || account.primaryDomain,
            identity_id: identityId || null,
            operation_record_id: operationRecordId || null,
            trigger: evidence.trigger || 'manual',
            requested_components: evidence.requested_components || [],
            source_observed_at: evidence.source_observed_at || evidence.started_at || null,
          },
        });
      }
      for (const [index, event] of (evidence.events || []).entries()) {
        appendEvent(evidence.run_id, {
          ...event,
          key: `worker:${event.key || index}`,
          details: scrubDetails(event.details || {}),
        });
      }
      appendEvent(evidence.run_id, {
        key: `panel:run-evidence:${evidence.status}`,
        event_type: 'run_evidence',
        stage: evidence.stage || (evidence.status === 'succeeded' ? 'local_verify' : 'preflight'),
        status: evidence.status,
        occurred_at: evidence.finished_at || evidence.verified_at || now().toISOString(),
        worker_id: evidence.worker_id || null,
        details: {
          ...scrubDetails(withoutEvents(evidence)),
          account_id: account.accountId,
          account_name_snapshot: account.name,
          primary_domain_snapshot: evidence.domain || account.primaryDomain,
          identity_id: identityId || null,
          operation_record_id: operationRecordId || null,
        },
      });
      projectRun(evidence.run_id);
      rebuildHealth();
    });
    transaction();
    return getRun(evidence.run_id);
  }

  function projectRun(runId) {
    const rows = db.prepare('SELECT * FROM backup_run_events WHERE run_id=? ORDER BY sequence').all(runId);
    if (!rows.length) return null;
    const events = rows.map(row => ({ ...row, details: parseJson(row.details_json, {}) }));
    const started = events.find(event => event.event_type === 'run_started');
    const evidenceEvent = [...events].reverse().find(event => event.event_type === 'run_evidence');
    const base = started?.details || {};
    const evidence = evidenceEvent?.details || {};
    const status = evidence.status || 'running';
    const trigger = evidence.trigger || base.trigger || 'manual';
    const policy = trigger === 'schedule'
      ? currentPolicy(evidence.account_id || base.account_id, evidence.domain || base.primary_domain_snapshot)
      : null;
    const row = {
      id: runId,
      operationRecordId: evidence.operation_record_id || base.operation_record_id || null,
      accountId: evidence.account_id || base.account_id,
      accountName: evidence.account_name_snapshot || base.account_name_snapshot || 'Unknown account',
      domain: evidence.primary_domain_snapshot || evidence.domain || base.primary_domain_snapshot || '',
      policyVersionId: evidence.policy_version_id || policy?.current_version_id || null,
      trigger,
      status,
      stage: evidence.stage || evidenceEvent?.stage || started?.stage || 'preflight',
      startedAt: evidence.started_at || started?.occurred_at || null,
      finishedAt: evidence.finished_at || (status === 'running' ? null : evidenceEvent?.occurred_at) || null,
      sourceObservedAt: evidence.source_observed_at || base.source_observed_at || null,
      // `partial` means the archive on this machine was made and verified and
      // the copy that was meant to leave the machine did not arrive. The local
      // half is real, so it counts as a recovery point and carries its bytes
      // and its verified time exactly as a clean run would. What it must not do
      // is let the account read as healthy, and that is decided from
      // `offsite_state` rather than from here.
      verifiedAt: LOCALLY_GOOD.has(status) ? (evidence.verified_at || evidence.finished_at || evidenceEvent?.occurred_at) : null,
      bytesTotal: LOCALLY_GOOD.has(status) ? Number(evidence.bytes_total || 0) : 0,
      failureCode: status === 'failed' ? (evidence.failure_code || 'BACKUP_EXECUTION_FAILED') : null,
      failureSummary: status === 'failed' ? safeFailure(evidence.failure_summary || FAILURE_FALLBACK) : null,
      workerId: evidence.worker_id || evidenceEvent?.worker_id || null,
      offsite: normalizeOffsite(evidence.offsite),
    };
    db.prepare(`INSERT INTO backup_runs
      (id,operation_record_id,account_id,account_name_snapshot,primary_domain_snapshot,policy_version_id,trigger,status,current_stage,started_at,finished_at,source_observed_at,verified_at,bytes_total,failure_code,failure_summary,failure_detail_ref,worker_id,lease_expires_at,offsite_state,offsite_destination,offsite_summary,offsite_verified_at,offsite_parts_stored,offsite_parts_expected)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        operation_record_id=excluded.operation_record_id, account_id=excluded.account_id,
        account_name_snapshot=excluded.account_name_snapshot, primary_domain_snapshot=excluded.primary_domain_snapshot,
        policy_version_id=excluded.policy_version_id, trigger=excluded.trigger, status=excluded.status,
        current_stage=excluded.current_stage, started_at=excluded.started_at, finished_at=excluded.finished_at,
        source_observed_at=excluded.source_observed_at, verified_at=excluded.verified_at,
        bytes_total=excluded.bytes_total, failure_code=excluded.failure_code,
        failure_summary=excluded.failure_summary, worker_id=excluded.worker_id,
        offsite_state=excluded.offsite_state, offsite_destination=excluded.offsite_destination,
        offsite_summary=excluded.offsite_summary, offsite_verified_at=excluded.offsite_verified_at,
        offsite_parts_stored=excluded.offsite_parts_stored, offsite_parts_expected=excluded.offsite_parts_expected`).run(
      row.id, row.operationRecordId, row.accountId, row.accountName, row.domain, row.policyVersionId,
      row.trigger, row.status, row.stage, row.startedAt, row.finishedAt, row.sourceObservedAt,
      row.verifiedAt, row.bytesTotal, row.failureCode, row.failureSummary, null, row.workerId, null,
      row.offsite.state, row.offsite.destination, row.offsite.summary, row.offsite.verified_at,
      row.offsite.parts_stored, row.offsite.parts_expected,
    );
    projectRunDetails(runId, evidence);
    return row;
  }

  function projectRunDetails(runId, evidence) {
    db.prepare('DELETE FROM backup_run_components WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM backup_database_results WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM backup_artifacts WHERE run_id=?').run(runId);
    db.prepare('DELETE FROM backup_manifests WHERE run_id=?').run(runId);

    const insertComponent = db.prepare(`INSERT INTO backup_run_components
      (run_id,component,status,started_at,finished_at,artifact_count,bytes,expected_object_count,captured_object_count,source_timestamp,failure_code,failure_summary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const component of evidence.components || []) {
      insertComponent.run(
        runId, component.component, component.status || 'unknown', component.started_at || null,
        component.finished_at || null, Number(component.artifact_count || 0), Number(component.bytes || 0),
        numberOrNull(component.expected_object_count), numberOrNull(component.captured_object_count),
        component.source_timestamp || null, component.failure_code || null,
        component.failure_summary ? safeFailure(component.failure_summary) : null,
      );
    }

    const insertDatabase = db.prepare(`INSERT INTO backup_database_results
      (run_id,database_id,database_name_snapshot,engine,snapshot_started_at,expected_table_count,captured_table_count,expected_tables_digest,captured_tables_digest,dump_bytes,dump_sha256,structure_check_status,failure_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const result of evidence.databases || []) {
      insertDatabase.run(
        runId, result.database_id || result.database || result.name, result.database || result.name,
        result.engine || null, result.snapshot_started_at || null,
        numberOrNull(result.expected_table_count), numberOrNull(result.captured_table_count),
        result.expected_tables_digest || null, result.captured_tables_digest || null,
        numberOrNull(result.dump_bytes), result.dump_sha256 || null,
        result.structure_check_status || null, result.failure_code || null,
      );
    }

    const insertArtifact = db.prepare(`INSERT INTO backup_artifacts
      (id,run_id,component,worker_locator,format,bytes,sha256,created_at,archive_check_status,manifest_check_status,verified_at,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const artifact of evidence.artifacts || []) {
      insertArtifact.run(
        `${runId}:${artifact.id}`, runId, artifact.component, artifact.locator || null,
        artifact.format || null, Number(artifact.bytes || 0), artifact.sha256 || '',
        artifact.created_at || evidence.started_at || now().toISOString(),
        artifact.archive_check_status || null, artifact.manifest_check_status || null,
        artifact.verified_at || null, artifact.state || (evidence.status === 'succeeded' ? 'verified' : 'rejected'),
      );
    }
    if (evidence.manifest) {
      db.prepare(`INSERT INTO backup_manifests
        (run_id,manifest_version,manifest_json,manifest_sha256,created_at) VALUES (?,?,?,?,?)`).run(
        runId, Number(evidence.manifest.version || 1), JSON.stringify(evidence.manifest.body || evidence.manifest),
        evidence.manifest.sha256 || '', evidence.manifest.created_at || evidence.finished_at || now().toISOString(),
      );
    }
  }

  function rebuildRuns() {
    const ids = db.prepare('SELECT DISTINCT run_id FROM backup_run_events ORDER BY run_id').all().map(row => row.run_id);
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM backup_run_components').run();
      db.prepare('DELETE FROM backup_database_results').run();
      db.prepare('DELETE FROM backup_artifacts').run();
      db.prepare('DELETE FROM backup_manifests').run();
      db.prepare('DELETE FROM backup_runs').run();
      for (const id of ids) projectRun(id);
      rebuildHealth();
    });
    transaction();
    return { runs: ids.length };
  }

  function recordPolicyAction({ identityId, operation, params = {}, result = {} }) {
    if (operation === 'backup.schedule.clear') {
      const account = accountSnapshot(identityId, params.domain);
      db.prepare(`UPDATE backup_policies SET enabled=0,state='cleared',next_due_at=NULL,updated_at=?,updated_by=?
                  WHERE account_id=? AND primary_domain_snapshot=?`).run(
        now().toISOString(), identityId || null, account.accountId, params.domain,
      );
      rebuildHealth();
      return null;
    }
    if (operation !== 'backup.schedule.set') return null;
    return upsertPolicy({ identityId, schedule: { ...params, ...result } });
  }

  function syncSchedules(schedules, { ownerFor } = {}) {
    const seen = new Set();
    const transaction = db.transaction(rows => {
      for (const schedule of rows || []) {
        const identityId = ownerFor ? ownerFor(schedule.domain) : null;
        if (!identityId) continue;
        const policy = upsertPolicy({ identityId, schedule, rebuild: false });
        if (policy) seen.add(policy.id);
      }
      const active = db.prepare("SELECT id FROM backup_policies WHERE state<>'cleared'").all();
      for (const policy of active) {
        if (seen.has(policy.id)) continue;
        db.prepare("UPDATE backup_policies SET enabled=0,state='cleared',next_due_at=NULL,updated_at=? WHERE id=?")
          .run(now().toISOString(), policy.id);
      }
      rebuildHealth();
    });
    transaction(schedules || []);
    return { policies: seen.size };
  }

  function upsertPolicy({ identityId, schedule, rebuild = true }) {
    if (!schedule?.domain) return null;
    const account = accountSnapshot(identityId, schedule.domain);
    const policyId = `bpol_${digest(`${account.accountId}:${schedule.domain}`).slice(0, 20)}`;
    const at = schedule.set_at || now().toISOString();
    let policy = db.prepare('SELECT * FROM backup_policies WHERE id=?').get(policyId);
    if (!policy) {
      db.prepare(`INSERT INTO backup_policies
        (id,account_id,primary_domain_snapshot,current_version_id,enabled,state,next_due_at,created_at,updated_at,created_by,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        policyId, account.accountId, schedule.domain, null, 1, 'active', dateOrNull(schedule.next_run),
        at, now().toISOString(), identityId || null, identityId || null,
      );
      policy = db.prepare('SELECT * FROM backup_policies WHERE id=?').get(policyId);
    }
    const versionShape = policyVersionShape(schedule);
    const current = policy.current_version_id
      ? db.prepare('SELECT * FROM backup_policy_versions WHERE id=?').get(policy.current_version_id)
      : null;
    let versionId = current?.id || null;
    if (!current || !sameVersion(current, versionShape)) {
      const version = db.prepare('SELECT COALESCE(MAX(version),0)+1 AS next FROM backup_policy_versions WHERE policy_id=?').get(policyId).next;
      versionId = `${policyId}_v${version}`;
      db.prepare(`INSERT INTO backup_policy_versions
        (id,policy_id,version,schedule_expression,timezone,grace_seconds,include_files,include_mail,include_databases,retention_count,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        versionId, policyId, version, versionShape.schedule_expression, versionShape.timezone,
        versionShape.grace_seconds, versionShape.include_files, versionShape.include_mail,
        versionShape.include_databases, versionShape.retention_count, at, identityId || null,
      );
    }
    const state = schedule.suspended_by_hoster ? 'suspended' : schedule.armed === false ? 'unarmed' : 'active';
    db.prepare(`UPDATE backup_policies SET current_version_id=?,enabled=?,state=?,next_due_at=?,updated_at=?,updated_by=? WHERE id=?`).run(
      versionId, schedule.suspended_by_hoster ? 0 : 1, state, dateOrNull(schedule.next_run),
      now().toISOString(), identityId || null, policyId,
    );
    if (rebuild) rebuildHealth();
    return db.prepare('SELECT * FROM backup_policies WHERE id=?').get(policyId);
  }

  // A domain somebody could actually look up, as opposed to the placeholder an
  // account carries until it has a site, or the empty string.
  function realDomain(value) {
    const clean = String(value || '').trim();
    if (!clean || clean.endsWith('.jotpanel.invalid') || clean.endsWith('.arca.invalid')) return null;
    return clean;
  }

  // Whether this failure is the same ongoing problem as the last one, or a new
  // one. Account, domain, the stage that broke and the code: a database dump
  // failing every night is one incident, and that same account's offsite copy
  // starting to fail as well is a second, because they need different actions.
  function fingerprintOf({ accountId, domain: dom, stage, failureCode }) {
    return digest([accountId, dom || '', stage || '', failureCode || ''].join('|')).slice(0, 32);
  }

  // How often the same unresolved incident is allowed to speak. First failure
  // immediately, again on the third consecutive one, then at most daily, and
  // immediately if the failure itself changed. Anything more is a mail rule
  // somebody writes to delete it, which is worse than not sending it.
  const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
  function shouldNotify(incident, { changed }) {
    if (!incident) return false;
    if (incident.notify_count === 0) return true;
    if (changed) return true;
    if (incident.occurrences === 3) return true;
    if (!incident.last_notified_at) return true;
    return now().getTime() - Date.parse(incident.last_notified_at) >= REMIND_AFTER_MS;
  }

  // Opens or updates the incident for a failure and says whether anybody should
  // be told right now. It never sends anything itself: delivery belongs to
  // whatever the panel has connected for transactional email, and a store that
  // reached for a mail server would be two jobs in one file.
  function recordFailure({ accountId, accountName, domain: dom, stage, failureCode, failureSummary, runId }) {
    const fingerprint = fingerprintOf({ accountId, domain: dom, stage, failureCode });
    const at = now().toISOString();
    const existing = db.prepare("SELECT * FROM backup_incidents WHERE fingerprint=? AND state='open'").get(fingerprint);
    // A different failure on the same account closes nothing, but it is a
    // different incident and it speaks straight away.
    const otherOpen = db.prepare("SELECT * FROM backup_incidents WHERE account_id=? AND state='open' AND fingerprint<>?").all(accountId, fingerprint);
    if (existing) {
      db.prepare(`UPDATE backup_incidents SET occurrences=occurrences+1, last_seen_at=?, last_run_id=?, failure_summary=? WHERE id=?`)
        .run(at, runId || existing.last_run_id, safeFailure(failureSummary || existing.failure_summary || ''), existing.id);
    } else {
      db.prepare(`INSERT INTO backup_incidents
        (id,fingerprint,account_id,account_name_snapshot,domain,stage,failure_code,failure_summary,state,occurrences,opened_at,last_seen_at,notify_count,last_run_id)
        VALUES (?,?,?,?,?,?,?,?,'open',1,?,?,0,?)`).run(
        `binc_${crypto.randomBytes(8).toString('hex')}`, fingerprint, accountId, accountName || accountId,
        dom || null, stage || null, failureCode || null, safeFailure(failureSummary || ''), at, at, runId || null,
      );
    }
    const incident = db.prepare("SELECT * FROM backup_incidents WHERE fingerprint=? AND state='open'").get(fingerprint);
    return { incident, notify: shouldNotify(incident, { changed: !existing && otherOpen.length > 0 }) };
  }

  // A later run that worked closes whatever was open for that account and
  // domain, and says so once. Recovery is worth exactly one message.
  function recordSuccess({ accountId, domain: dom, runId }) {
    const open = db.prepare("SELECT * FROM backup_incidents WHERE account_id=? AND state='open' AND (domain IS ? OR domain=?)")
      .all(accountId, dom || null, dom || '');
    if (!open.length) return { closed: [], notify: false };
    const at = now().toISOString();
    for (const incident of open) {
      db.prepare("UPDATE backup_incidents SET state='resolved', resolved_at=?, last_run_id=? WHERE id=?").run(at, runId || incident.last_run_id, incident.id);
    }
    // Only worth announcing if somebody was told about the problem. Closing an
    // incident nobody heard about is not news.
    return { closed: open, notify: open.some(incident => incident.notify_count > 0) };
  }

  function markNotified(incidentId, error = null) {
    db.prepare('UPDATE backup_incidents SET last_notified_at=?, notify_count=notify_count+1, last_notify_error=? WHERE id=?')
      .run(now().toISOString(), error ? safeFailure(error, 300) : null, incidentId);
  }

  function acknowledgeIncident(incidentId, who) {
    db.prepare('UPDATE backup_incidents SET acknowledged_at=?, acknowledged_by=? WHERE id=?').run(now().toISOString(), who || null, incidentId);
    return db.prepare('SELECT * FROM backup_incidents WHERE id=?').get(incidentId) || null;
  }

  function listIncidents({ state = 'open', limit = 100 } = {}) {
    const rows = state === 'all'
      ? db.prepare('SELECT * FROM backup_incidents ORDER BY last_seen_at DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM backup_incidents WHERE state=? ORDER BY last_seen_at DESC LIMIT ?').all(state, limit);
    return rows.map(row => ({
      id: row.id, account: row.account_name_snapshot, account_id: row.account_id, domain: row.domain,
      stage: row.stage, failure_code: row.failure_code, failure_summary: row.failure_summary,
      state: row.state, occurrences: row.occurrences, opened_at: row.opened_at, last_seen_at: row.last_seen_at,
      resolved_at: row.resolved_at, acknowledged_at: row.acknowledged_at,
      notified: row.notify_count, last_notified_at: row.last_notified_at, last_notify_error: row.last_notify_error,
    }));
  }

  function rebuildHealth() {
    const accounts = accountRows();
    const at = now().toISOString();
    const insert = db.prepare(`INSERT INTO backup_account_health
      (account_id,account_name_snapshot,primary_domain_snapshot,policy_id,policy_version_id,policy_state,health_status,status_label,last_attempt_run_id,last_attempt_at,last_attempt_status,last_verified_run_id,last_verified_at,last_local_verified_at,next_due_at,overdue_at,consecutive_failures,latest_failure_code,latest_failure_summary,bytes_total,components_json,updated_at,offsite_state,last_offsite_verified_at,offsite_summary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM backup_account_health').run();
      for (const account of accounts) {
        const runs = db.prepare(`SELECT * FROM backup_runs WHERE account_id=?
          ORDER BY COALESCE(started_at,finished_at,'') DESC, id DESC`).all(account.accountId);
        const policies = db.prepare('SELECT * FROM backup_policies WHERE account_id=? ORDER BY updated_at DESC').all(account.accountId)
          .map(policy => ({
            ...policy,
            _version: policy.current_version_id
              ? db.prepare('SELECT * FROM backup_policy_versions WHERE id=?').get(policy.current_version_id) || null
              : null,
          }));
        const latest = runs[0] || null;
        const latestByDomain = new Map();
        const verifiedByDomain = new Map();
        for (const run of runs) {
          if (!latestByDomain.has(run.primary_domain_snapshot)) latestByDomain.set(run.primary_domain_snapshot, run);
          if (LOCALLY_GOOD.has(run.status) && run.verified_at && !verifiedByDomain.has(run.primary_domain_snapshot)) {
            verifiedByDomain.set(run.primary_domain_snapshot, run);
          }
        }
        const domainLatest = [...latestByDomain.values()];
        const failureRun = domainLatest.find(run => run.status === 'failed') || null;
        const running = domainLatest.find(run => ['running', 'verifying'].includes(run.status)) || null;
        const verifiedPoints = [...verifiedByDomain.values()];
        const verified = verifiedPoints[0] || null;
        let failures = 0;
        if (failureRun) {
          for (const run of runs.filter(item => item.primary_domain_snapshot === failureRun.primary_domain_snapshot)) {
            if (run.status === 'failed') failures += 1;
            else if (LOCALLY_GOOD.has(run.status)) break;
          }
        }
        const activePolicies = policies.filter(policy => policy.enabled);
        const deadlines = activePolicies.map(policy => ({
          policy,
          deadline: policyDeadline(policy, latestByDomain.get(policy.primary_domain_snapshot) || null),
        })).filter(item => item.deadline).sort((left, right) => left.deadline.localeCompare(right.deadline));
        const overdueAt = deadlines[0]?.deadline || null;
        const isOverdue = !!overdueAt && Date.parse(overdueAt) <= now().getTime();
        const missingRequiredRecoveryPoint = activePolicies.some(policy => !verifiedByDomain.has(policy.primary_domain_snapshot));
        // The most recent run per domain that had anything to say about an
        // offsite copy. A run with no destination configured says nothing, so
        // it neither clears nor raises this.
        const offsiteRun = domainLatest.find(run => run.offsite_state === 'failed')
          || domainLatest.find(run => run.offsite_state === 'succeeded')
          || null;
        const offsiteState = offsiteRun?.offsite_state || 'not_configured';

        let health = 'healthy';
        if (failureRun) health = 'failed';
        else if (running) health = 'running';
        else if (isOverdue) health = 'overdue';
        else if (!verified || missingRequiredRecoveryPoint) health = 'never_backed_up';
        // The whole point of this change. The local artifact is real, verified
        // and restorable, and the copy that was supposed to leave the machine
        // did not. Saying healthy there tells a hosting company their data
        // survives the loss of this box when it does not, which is the one lie
        // this product exists not to tell. It sorts with the failures rather
        // than the healthy rows and it is deliberately not called healthy.
        else if (offsiteState === 'failed') health = 'offsite_failed';
        const policy = policies.find(item => item.primary_domain_snapshot === failureRun?.primary_domain_snapshot)
          || deadlines[0]?.policy
          || policies.find(item => item.primary_domain_snapshot === running?.primary_domain_snapshot)
          || policies[0] || null;
        const components = [...new Set(verifiedPoints.flatMap(point => db.prepare(
          'SELECT component FROM backup_run_components WHERE run_id=? AND status=? ORDER BY component',
        ).all(point.id, 'verified').map(row => row.component)))].sort();
        const bytesTotal = verifiedPoints.reduce((sum, point) => sum + Number(point.bytes_total || 0), 0);
        const nextDue = activePolicies.map(item => item.next_due_at).filter(Boolean).sort()[0]
          || nextDueFromDeadline(overdueAt, policy);
        const label = healthLabel(health, { latest: failureRun || latest, verified, running, offsiteRun, now: now() });
        // The domain this row is about, and the account's own name for itself
        // is the last thing tried rather than the first.
        //
        // An account that has never added a site of its own carries an explicit
        // placeholders, `<identity>.jotpanel.invalid` and the legacy
        // `<identity>.arca.invalid`, which exist to mean "no site
        // yet". Preferring it put that placeholder in the grid for an account
        // whose backups were of a real domain, so the one screen whose job is to
        // tell a hoster which account's backups are broken showed a hostname
        // that resolves nowhere and matches no site they have. Seen on the live
        // box with thirteen accounts, every row wrong, and it could not have
        // shown up in a test with invented fixtures.
        const displayDomain = realDomain(latest?.primary_domain_snapshot)
          || realDomain(policy?.primary_domain_snapshot)
          || realDomain(account.primaryDomain)
          || account.primaryDomain || null;
        insert.run(
          account.accountId, account.name, displayDomain,
          policy?.id || null, policy?.current_version_id || null, policy?.state || 'none', health, label,
          latest?.id || null, latest ? (latest.finished_at || latest.started_at) : null, latest?.status || null,
          verified?.id || null, verified?.verified_at || null, verified?.verified_at || null,
          nextDue, overdueAt, failures,
          failureRun?.failure_code || null,
          failureRun ? safeFailure(failureRun.failure_summary) : null,
          bytesTotal, JSON.stringify(components), at,
          offsiteState,
          domainLatest.find(run => run.offsite_state === 'succeeded')?.offsite_verified_at || null,
          offsiteRun?.offsite_state === 'failed' ? safeFailure(offsiteRun.offsite_summary || '') : null,
        );
      }
    });
    transaction();
    return { accounts: accounts.length };
  }

  function listHealth() {
    rebuildHealth();
    return db.prepare('SELECT * FROM backup_account_health').all().map(row => ({
      account_id: row.account_id,
      account: row.account_name_snapshot,
      primary_domain: row.primary_domain_snapshot,
      policy_id: row.policy_id,
      policy_version_id: row.policy_version_id,
      policy_state: row.policy_state,
      status: row.health_status,
      status_label: row.status_label,
      // Reported as its own column rather than folded into the status, because
      // "is there a copy off this machine" is a different question from "did
      // the backup work" and an operator triaging a failure needs both.
      offsite_state: row.offsite_state || 'not_configured',
      last_offsite_verified_at: row.last_offsite_verified_at || null,
      offsite_summary: row.offsite_summary || null,
      last_attempt_run_id: row.last_attempt_run_id,
      last_attempt_at: row.last_attempt_at,
      last_attempt_status: row.last_attempt_status,
      last_verified_run_id: row.last_verified_run_id,
      last_verified_at: row.last_verified_at,
      next_due_at: row.next_due_at,
      overdue_at: row.overdue_at,
      consecutive_failures: row.consecutive_failures,
      failure_code: row.latest_failure_code,
      failure_summary: row.latest_failure_summary,
      bytes_total: row.bytes_total,
      components: parseJson(row.components_json, []),
    })).sort((left, right) => {
      const state = (HEALTH_ORDER[left.status] ?? 99) - (HEALTH_ORDER[right.status] ?? 99);
      return state || left.account.localeCompare(right.account);
    });
  }

  function getRun(runId) {
    const run = db.prepare('SELECT * FROM backup_runs WHERE id=?').get(runId);
    if (!run) return null;
    return {
      ...run,
      components: db.prepare('SELECT * FROM backup_run_components WHERE run_id=? ORDER BY component').all(runId),
      databases: db.prepare('SELECT * FROM backup_database_results WHERE run_id=? ORDER BY database_name_snapshot').all(runId),
      artifacts: db.prepare('SELECT * FROM backup_artifacts WHERE run_id=? ORDER BY component,id').all(runId),
      manifest: db.prepare('SELECT * FROM backup_manifests WHERE run_id=?').get(runId) || null,
      events: db.prepare('SELECT sequence,event_type,stage,status,details_json,occurred_at,worker_id FROM backup_run_events WHERE run_id=? ORDER BY sequence').all(runId),
    };
  }

  function currentPolicy(accountId, domain) {
    if (!accountId || !domain) return null;
    return db.prepare('SELECT * FROM backup_policies WHERE account_id=? AND primary_domain_snapshot=?').get(accountId, domain) || null;
  }

  function accountSnapshot(identityId, domain) {
    let row = null;
    if (identityId && tableExists('memberships')) {
      const provisioning = tableExists('provisioning_accounts');
      row = db.prepare(`SELECT m.org_id,u.name,u.email,${provisioning ? 'p.primary_domain' : 'NULL AS primary_domain'}
        FROM memberships m
        LEFT JOIN users u ON u.id=m.identity_id
        ${provisioning ? 'LEFT JOIN provisioning_accounts p ON p.user_id=m.identity_id' : ''}
        WHERE m.identity_id=?`).get(identityId);
    }
    return {
      accountId: row?.org_id || identityId || `unattributed_${digest(domain || 'backup').slice(0, 16)}`,
      name: row?.name || row?.email || identityId || 'Unattributed account',
      primaryDomain: domain || row?.primary_domain || null,
    };
  }

  function accountRows() {
    if (!tableExists('organizations') || !tableExists('memberships')) {
      return db.prepare('SELECT DISTINCT account_id AS accountId,account_name_snapshot AS name,primary_domain_snapshot AS primaryDomain FROM backup_runs').all();
    }
    const organizations = db.prepare('SELECT id,name FROM organizations ORDER BY name').all();
    const provisioning = tableExists('provisioning_accounts');
    return organizations.map(org => {
      const identity = db.prepare(`SELECT m.identity_id,u.name,u.email,${provisioning ? 'p.primary_domain' : 'NULL AS primary_domain'}
        FROM memberships m LEFT JOIN users u ON u.id=m.identity_id
        ${provisioning ? 'LEFT JOIN provisioning_accounts p ON p.user_id=m.identity_id' : ''}
        WHERE m.org_id=? ORDER BY m.created_at,m.identity_id LIMIT 1`).get(org.id);
      return {
        accountId: org.id,
        name: identity?.name || identity?.email || org.name,
        primaryDomain: identity?.primary_domain || null,
      };
    });
  }

  function tableExists(name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }

  return {
    recordFailure, recordSuccess, markNotified, acknowledgeIncident, listIncidents,
    startRun,
    completeRun,
    failRun,
    recordPolicyAction,
    syncSchedules,
    rebuildRuns,
    rebuildHealth,
    listHealth,
    getRun,
    projectRun,
  };
}

function normalizeTruth(truth, fallback) {
  const input = truth && typeof truth === 'object' ? truth : {};
  return {
    ...fallback,
    ...input,
    run_id: input.run_id || fallback.run_id,
    domain: input.domain || fallback.domain,
    trigger: input.trigger || fallback.trigger || 'manual',
    status: input.status || fallback.status,
    failure_summary: safeFailure(input.failure_summary || fallback.failure_summary || ''),
    components: Array.isArray(input.components) ? input.components : [],
    databases: Array.isArray(input.databases) ? input.databases : [],
    artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
    events: Array.isArray(input.events) ? input.events : [],
    offsite: normalizeOffsite(input.offsite || fallback.offsite),
  };
}

// Where the copy that is not on this machine got to.
//
//   not_configured  no destination is set up, so there is nothing to expect
//   skipped         a destination exists and this run did not use it
//   succeeded       every part was sent and read back off the far end
//   failed          a destination was configured and the copy did not arrive
//
// `failed` is the state the whole change exists for. It is deliberately
// impossible to reach `succeeded` by uploading without reading back, because
// the only thing that sets it is a verify that matched.
const OFFSITE_STATES = ['not_configured', 'skipped', 'succeeded', 'failed'];
// Run statuses whose local artifact is made and verified, so they are a real
// recovery point somebody can restore from right now.
const LOCALLY_GOOD = new Set(['succeeded', 'partial']);
function normalizeOffsite(value) {
  const input = value && typeof value === 'object' ? value : {};
  const state = OFFSITE_STATES.includes(input.state) ? input.state : 'not_configured';
  return {
    state,
    destination: input.destination ? safeFailure(String(input.destination), 200) : null,
    summary: input.summary ? safeFailure(String(input.summary), 500) : null,
    verified_at: state === 'succeeded' ? (dateOrNull(input.verified_at) || null) : null,
    parts_stored: Number.isFinite(Number(input.parts_stored)) ? Number(input.parts_stored) : null,
    parts_expected: Number.isFinite(Number(input.parts_expected)) ? Number(input.parts_expected) : null,
  };
}

function scrubDetails(value) {
  if (Array.isArray(value)) return value.map(scrubDetails);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? safeFailure(value, 2000) : value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(staging_)?path$|locator$/i.test(key) && typeof item === 'string' && item.startsWith('/')) clean[key] = '[protected path]';
    else if (/failure_summary|error|reason/i.test(key) && typeof item === 'string') clean[key] = safeFailure(item, 500);
    else clean[key] = scrubDetails(item);
  }
  return clean;
}

function withoutEvents(evidence) {
  const { events, ...truth } = evidence || {};
  return truth;
}

function safeFailure(value, limit = 500) {
  const message = String(value?.message || value || FAILURE_FALLBACK).split(/\r?\n/).find(Boolean) || FAILURE_FALLBACK;
  return message
    .replace(/(^|\s)\/(?:[^\s:;,]+\/?)+/g, '$1[protected path]')
    .replace(/(\b(?:password|secret|token|credential)\s*[=:]\s*)\S+/gi, '$1[protected]')
    .slice(0, limit);
}

function policyVersionShape(schedule) {
  const parts = Array.isArray(schedule.parts) ? schedule.parts : ['files', 'mail'];
  return {
    schedule_expression: String(schedule.when || 'daily'),
    timezone: String(schedule.timezone || 'UTC'),
    grace_seconds: Number(schedule.grace_seconds || graceSeconds(schedule.when)),
    include_files: parts.includes('files') ? 1 : 0,
    include_mail: parts.includes('mail') ? 1 : 0,
    include_databases: parts.includes('databases') ? 1 : 0,
    retention_count: Math.min(Math.max(Number(schedule.keep) || 7, 1), 90),
  };
}

function sameVersion(row, shape) {
  return row.schedule_expression === shape.schedule_expression
    && row.timezone === shape.timezone
    && Number(row.grace_seconds) === shape.grace_seconds
    && Number(row.include_files) === shape.include_files
    && Number(row.include_mail) === shape.include_mail
    && Number(row.include_databases) === shape.include_databases
    && Number(row.retention_count) === shape.retention_count;
}

function policyDeadline(policy, latestRun) {
  const version = policy && policy.current_version_id ? policy._version : null;
  const cadence = version?.schedule_expression || policy?.schedule_expression;
  const interval = cadenceMs(cadence);
  if (!policy || !interval) return null;
  const base = latestRun?.finished_at || latestRun?.started_at || policy.created_at;
  const time = Date.parse(base);
  if (!Number.isFinite(time)) return null;
  const grace = Number(version?.grace_seconds || policy.grace_seconds || graceSeconds(cadence)) * 1000;
  return new Date(time + interval + grace).toISOString();
}

function nextDueFromDeadline(deadline, policy) {
  if (!deadline) return policy?.next_due_at || null;
  const grace = Number(policy?._version?.grace_seconds || graceSeconds(policy?._version?.schedule_expression)) * 1000;
  return new Date(Date.parse(deadline) - grace).toISOString();
}

function cadenceMs(value) {
  return { hourly: 3600000, daily: 86400000, weekly: 7 * 86400000, monthly: 30 * 86400000 }[String(value || '')] || null;
}

function graceSeconds(value) {
  return { hourly: 1800, daily: 6 * 3600, weekly: 24 * 3600, monthly: 48 * 3600 }[String(value || '')] || 6 * 3600;
}

function healthLabel(status, { latest, verified, running, offsiteRun, now }) {
  if (status === 'failed') return `Failed, ${safeFailure(latest?.failure_summary || FAILURE_FALLBACK)}`;
  // Names both halves, because "offsite failed" on its own reads as though the
  // backup did not happen, and the operator's next decision depends on knowing
  // the local copy is real and restorable right now.
  if (status === 'offsite_failed') {
    return `Offsite failed, local copy verified, ${safeFailure(offsiteRun?.offsite_summary || 'the copy did not reach the destination')}`;
  }
  if (status === 'overdue') return 'Overdue, no attempt since the deadline';
  if (status === 'never_backed_up') return 'Never backed up';
  if (status === 'running') return `Running, ${String(running?.current_stage || 'preflight').replace(/_/g, ' ')}`;
  return `Healthy, verified ${ageWords(verified?.verified_at, now)} ago`;
}

function ageWords(value, at) {
  const elapsed = Math.max(0, at.getTime() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return 'at an unknown time';
  if (elapsed < 60000) return 'less than a minute';
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m`;
  if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h`;
  return `${Math.floor(elapsed / 86400000)}d`;
}

function dateOrNull(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function numberOrNull(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createBackupHealthBackend({ store } = {}) {
  if (!store) throw new Error('backup health backend requires its store');
  return {
    name: 'backup-health',
    async capabilities() {
      return {
        capabilities: new Map([
          ['backup.health.list', {
            id: 'backup.health.list', kind: 'read', backend: 'backup-health',
            run: async () => ({
              health: store.listHealth(),
              states: ['failed', 'offsite_failed', 'overdue', 'never_backed_up', 'running', 'healthy'],
              incidents: store.listIncidents({ state: 'open', limit: 100 }),
            }),
          }],
          // What is broken now and what was, as its own read. The grid answers
          // "which accounts are unhealthy"; this answers "what has anybody
          // actually been told about, and did the telling work", which is the
          // question after a night nobody was watching.
          ['backup.incidents.list', {
            id: 'backup.incidents.list', kind: 'read', backend: 'backup-health',
            run: async params => ({ incidents: store.listIncidents({ state: params?.state || 'open', limit: Number(params?.limit) || 100 }), verified: true }),
          }],
        ]),
        missing: new Map(),
        state: { durable: true, source: 'backup_run_events' },
      };
    },
  };
}

module.exports = { createBackupHealthStore, createBackupHealthBackend, HEALTH_ORDER, safeFailure };
