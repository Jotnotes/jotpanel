'use strict';

const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RUN_TIMEOUT_MS = 60 * 1000;
const OUTPUT_LIMIT = 128 * 1024;

function createScheduledJobsService({ db, actionStore, jobRoot, now = () => new Date() } = {}) {
  if (!db || !actionStore) throw new Error('scheduled jobs service is missing required dependencies');
  const cwd = path.resolve(jobRoot || (process.env.JOTPANEL_JOB_ROOT ?? process.env.ARCA_JOB_ROOT) || process.cwd());
  const running = new Map();

  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      name                TEXT NOT NULL,
      note                TEXT DEFAULT '',
      schedule            TEXT NOT NULL,
      command             TEXT NOT NULL,
      enabled             INTEGER DEFAULT 1,
      last_scheduled_slot TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_user ON scheduled_jobs (user_id, created_at);

    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id          TEXT PRIMARY KEY,
      job_id      TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      trigger     TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL,
      exit_code   INTEGER,
      output      TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job ON scheduled_job_runs (job_id, started_at DESC);
  `);

  function list(userId) {
    const jobs = db.prepare('SELECT * FROM scheduled_jobs WHERE user_id=? ORDER BY name').all(userId)
      .map(row => ({ ...row, enabled: !!row.enabled }));
    const latest = db.prepare(`SELECT r.* FROM scheduled_job_runs r
      JOIN (SELECT job_id, MAX(started_at) started_at FROM scheduled_job_runs WHERE user_id=? GROUP BY job_id) x
        ON x.job_id=r.job_id AND x.started_at=r.started_at`).all(userId);
    const byJob = new Map(latest.map(row => [row.job_id, row]));
    return jobs.map(job => ({ ...job, lastRun: byJob.get(job.id) || null, running: running.has(job.id) }));
  }

  function history(userId, jobId, limit = 50) {
    const job = db.prepare('SELECT id FROM scheduled_jobs WHERE id=? AND user_id=?').get(jobId, userId);
    if (!job) throw new Error('Scheduled job not found');
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return db.prepare(`SELECT * FROM scheduled_job_runs WHERE job_id=? AND user_id=? ORDER BY started_at DESC LIMIT ${safeLimit}`).all(jobId, userId);
  }

  function propose(userId, input = {}) {
    const operation = String(input.operation || '').toLowerCase();
    if (!['create', 'update', 'delete', 'run'].includes(operation)) throw new Error('operation must be create, update, delete, or run');
    const existing = input.id ? db.prepare('SELECT * FROM scheduled_jobs WHERE id=? AND user_id=?').get(input.id, userId) : null;
    if (operation !== 'create' && !existing) throw new Error('Scheduled job not found');

    let payload;
    let label;
    let summary;
    let riskLevel = 'standard';
    let confirm = null;
    if (operation === 'create' || operation === 'update') {
      const next = normalizeJob({ ...(existing || {}), ...(input.job || input) });
      payload = { operation, id: existing?.id || null, job: next };
      label = `${operation === 'create' ? 'Create' : 'Update'} scheduled job “${next.name}”`;
      summary = `${next.schedule} · ${next.note || 'No note'} · command is shown in the approval detail.`;
    } else if (operation === 'delete') {
      payload = { operation, id: existing.id };
      label = `Delete scheduled job “${existing.name}”`;
      summary = `Remove the schedule and keep its existing run history in the audit record.`;
      riskLevel = 'destructive';
      confirm = 'DELETE';
    } else {
      payload = { operation, id: existing.id };
      label = `Run “${existing.name}” now`;
      summary = `Run the saved command once, with a 60 second limit and a per-job lock.`;
      riskLevel = 'elevated';
    }

    return actionStore.enqueue({
      accountId: userId,
      kind: `scheduled_job.${operation}`,
      actionKey: `scheduled_job_${operation}`,
      label,
      summary,
      riskLevel,
      requiresApproval: true,
      requiresConfirmText: confirm,
      call: { api: 'arca-native', module: 'ScheduledJobs', function: operation, params: payload },
      metadata: payload,
    });
  }

  async function execute(actionId, userId) {
    const action = actionStore.get(actionId);
    if (!action || action.accountId !== userId || !action.kind.startsWith('scheduled_job.')) throw new Error('Approved scheduled-job action not found');
    if (action.status !== 'approved') throw new Error(`Action ${actionId} must be approved before execution`);
    const payload = action.metadata || action.call?.params || {};
    try {
      let result;
      if (payload.operation === 'create') result = createJob(userId, payload.job);
      else if (payload.operation === 'update') result = updateJob(userId, payload.id, payload.job);
      else if (payload.operation === 'delete') result = deleteJob(userId, payload.id);
      else if (payload.operation === 'run') result = await runJob(userId, payload.id, 'manual');
      else throw new Error('Unknown scheduled-job operation');
      const verified = verifyOperation(userId, payload, result);
      if (!verified.ok) throw Object.assign(new Error(verified.error), { result: verified });
      return actionStore.markExecuted(action.id, { ...result, verified: true });
    } catch (error) {
      actionStore.markFailed(action.id, error, error.result || null);
      throw error;
    }
  }

  function createJob(userId, job) {
    const id = randomId();
    const at = now().toISOString();
    db.prepare(`INSERT INTO scheduled_jobs (id,user_id,name,note,schedule,command,enabled,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, job.name, job.note, job.schedule, job.command, job.enabled ? 1 : 0, at, at);
    return { ok: true, operation: 'create', job: db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id) };
  }

  function updateJob(userId, id, job) {
    const changed = db.prepare(`UPDATE scheduled_jobs SET name=?,note=?,schedule=?,command=?,enabled=?,updated_at=?
                                 WHERE id=? AND user_id=?`)
      .run(job.name, job.note, job.schedule, job.command, job.enabled ? 1 : 0, now().toISOString(), id, userId);
    if (!changed.changes) throw new Error('Scheduled job not found');
    return { ok: true, operation: 'update', job: db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id) };
  }

  function deleteJob(userId, id) {
    const old = db.prepare('SELECT * FROM scheduled_jobs WHERE id=? AND user_id=?').get(id, userId);
    if (!old) throw new Error('Scheduled job not found');
    db.prepare('DELETE FROM scheduled_jobs WHERE id=? AND user_id=?').run(id, userId);
    return { ok: true, operation: 'delete', id, previous: { name: old.name, note: old.note, schedule: old.schedule } };
  }

  function verifyOperation(userId, payload, result) {
    if (!result || result.ok !== true) return { ok: false, error: 'Scheduled job operation did not report success' };
    if (payload.operation === 'create' || payload.operation === 'update') {
      const id = result.job && result.job.id;
      const row = id && db.prepare('SELECT * FROM scheduled_jobs WHERE id=? AND user_id=?').get(id, userId);
      if (!row) return { ok: false, error: 'Scheduled job was not present after the write' };
      if (row.note !== payload.job.note || row.schedule !== payload.job.schedule || row.command !== payload.job.command) {
        return { ok: false, error: 'Scheduled job did not read back exactly as approved' };
      }
    }
    if (payload.operation === 'delete' && db.prepare('SELECT 1 FROM scheduled_jobs WHERE id=? AND user_id=?').get(payload.id, userId)) {
      return { ok: false, error: 'Scheduled job still exists after deletion' };
    }
    if (payload.operation === 'run' && (!result.run || !['succeeded', 'failed', 'timed_out'].includes(result.run.status))) {
      return { ok: false, error: 'Run ended without a verifiable exit status' };
    }
    return { ok: true };
  }

  async function runJob(userId, id, trigger = 'manual') {
    const job = db.prepare('SELECT * FROM scheduled_jobs WHERE id=? AND user_id=?').get(id, userId);
    if (!job) throw new Error('Scheduled job not found');
    if (running.has(id)) throw new Error('This job is already running');

    const runId = randomId();
    const startedAt = now().toISOString();
    db.prepare(`INSERT INTO scheduled_job_runs (id,job_id,user_id,trigger,started_at,status) VALUES (?,?,?,?,?,?)`)
      .run(runId, id, userId, trigger, startedAt, 'running');

    const promise = new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const child = spawn('/bin/sh', ['-lc', job.command], {
        cwd,
        env: { ...process.env, JOTPANEL_JOB_ID: job.id, JOTPANEL_JOB_NAME: job.name },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const append = (target, chunk) => (target + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, RUN_TIMEOUT_MS);

      const finish = (code, signal, spawnError = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const status = timedOut ? 'timed_out' : (!spawnError && code === 0 ? 'succeeded' : 'failed');
        const error = spawnError ? spawnError.message : timedOut ? 'Stopped after 60 seconds' : (code === 0 ? null : `Exited with code ${code}${signal ? ` (${signal})` : ''}`);
        const finishedAt = now().toISOString();
        db.prepare(`UPDATE scheduled_job_runs SET finished_at=?,status=?,exit_code=?,output=?,error=? WHERE id=?`)
          .run(finishedAt, status, Number.isInteger(code) ? code : null, [stdout, stderr].filter(Boolean).join('\n').slice(-OUTPUT_LIMIT), error, runId);
        const run = db.prepare('SELECT * FROM scheduled_job_runs WHERE id=?').get(runId);
        resolve({ ok: true, operation: 'run', run });
      };
      child.on('error', error => finish(null, null, error));
      child.on('close', (code, signal) => finish(code, signal));
    });
    running.set(id, promise);
    try { return await promise; }
    finally { running.delete(id); }
  }

  async function tick() {
    const when = now();
    const slot = when.toISOString().slice(0, 16);
    const jobs = db.prepare('SELECT * FROM scheduled_jobs WHERE enabled=1').all();
    for (const job of jobs) {
      if (job.last_scheduled_slot === slot || running.has(job.id) || !cronMatches(job.schedule, when)) continue;
      db.prepare('UPDATE scheduled_jobs SET last_scheduled_slot=? WHERE id=?').run(slot, job.id);
      runJob(job.user_id, job.id, 'schedule').catch(error => {
        try {
          db.prepare('INSERT INTO audit_log (user_id,action,details) VALUES (?,?,?)')
            .run(job.user_id, 'scheduled_job_failed', `${job.name}: ${error.message}`);
        } catch {}
      });
    }
  }

  function start() {
    const timer = setInterval(() => tick().catch(() => {}), 30000);
    timer.unref();
    setTimeout(() => tick().catch(() => {}), 1000).unref();
    return () => clearInterval(timer);
  }

  return { list, history, propose, execute, runJob, tick, start, cwd };
}

function normalizeJob(input) {
  const name = String(input.name || '').trim();
  const note = String(input.note || '').trim();
  const schedule = String(input.schedule || '').trim().replace(/\s+/g, ' ');
  const command = String(input.command || '').trim();
  if (name.length < 2 || name.length > 120) throw new Error('Job name must be 2–120 characters');
  if (note.length > 500) throw new Error('Job note must be 500 characters or fewer');
  validateCron(schedule);
  if (!command || command.length > 4000 || /[\0\r\n]/.test(command)) throw new Error('Command must be one line and no more than 4000 characters');
  return { name, note, schedule, command, enabled: input.enabled !== false && input.enabled !== 0 };
}

function validateCron(schedule) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Schedule must use five cron fields: minute hour day month weekday');
  const ranges = [[0,59], [0,23], [1,31], [1,12], [0,7]];
  parts.forEach((field, i) => parseCronField(field, ...ranges[i]));
  return schedule;
}

function parseCronField(field, min, max) {
  const values = new Set();
  for (const segment of field.split(',')) {
    const [base, rawStep] = segment.split('/');
    const step = rawStep == null ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error(`Invalid cron step: ${segment}`);
    let start;
    let end;
    if (base === '*') { start = min; end = max; }
    else if (/^\d+$/.test(base)) { start = Number(base); end = Number(base); }
    else {
      const match = base.match(/^(\d+)-(\d+)$/);
      if (!match) throw new Error(`Invalid cron field: ${segment}`);
      start = Number(match[1]); end = Number(match[2]);
    }
    if (start < min || end > max || start > end) throw new Error(`Cron value ${segment} is outside ${min}-${max}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function cronMatches(schedule, date) {
  const fields = validateCron(schedule).split(/\s+/);
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  return fields.every((field, i) => {
    const set = parseCronField(field, ...[[0,59], [0,23], [1,31], [1,12], [0,7]][i]);
    if (i === 4 && values[i] === 0 && set.has(7)) return true;
    return set.has(values[i]);
  });
}

function randomId() { return crypto.randomBytes(10).toString('hex'); }

module.exports = { createScheduledJobsService, validateCron, cronMatches, normalizeJob };
