'use strict';

const crypto = require('crypto');

function createUsageService({ db, now = () => new Date() } = {}) {
  if (!db) throw new Error('usage service requires a database');
  db.exec(`
    CREATE TABLE IF NOT EXISTS account_lifecycle (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      event      TEXT NOT NULL,
      reason     TEXT,
      ts         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_lifecycle_user_ts ON account_lifecycle (user_id, ts);

    CREATE TABLE IF NOT EXISTS usage_snapshots (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      storage_bytes INTEGER NOT NULL,
      site_bytes    INTEGER NOT NULL,
      vault_bytes   INTEGER NOT NULL,
      ts            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_snapshots_user_ts ON usage_snapshots (user_id, ts);
  `);

  // Existing installs predate lifecycle events. Backfill one created event at
  // the account's actual creation time so period reports never invent uptime.
  const missing = db.prepare(`SELECT u.id,u.created_at FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id)`).all();
  const insertLifecycle = db.prepare('INSERT INTO account_lifecycle (id,user_id,event,reason,ts) VALUES (?,?,?,?,?)');
  for (const user of missing) insertLifecycle.run(randomId(), user.id, 'created', 'backfilled from users.created_at', normalizeSqliteDate(user.created_at));

  function recordLifecycle(userId, event, reason = '') {
    if (!['created', 'suspended', 'resumed', 'closed'].includes(event)) throw new Error(`Unknown lifecycle event: ${event}`);
    db.prepare('INSERT INTO account_lifecycle (id,user_id,event,reason,ts) VALUES (?,?,?,?,?)')
      .run(randomId(), userId, event, reason || null, now().toISOString());
  }

  function storage(userId) {
    const vault = safeGet(db, 'SELECT COALESCE(SUM(size),0) bytes FROM files WHERE user_id=?', userId).bytes || 0;
    const published = safeGet(db, 'SELECT COALESCE(SUM(size),0) bytes FROM pub_files WHERE user_id=?', userId).bytes || 0;
    const site = safeGet(db, `SELECT COALESCE(SUM(LENGTH(CAST(sf.content AS BLOB))),0) bytes
      FROM site_files sf JOIN sites s ON s.id=sf.site_id WHERE s.user_id=?`, userId).bytes || 0;
    return { totalBytes: vault + published + site, vaultBytes: vault + published, siteBytes: site };
  }

  function snapshot(userId, force = false) {
    const recent = db.prepare(`SELECT * FROM usage_snapshots WHERE user_id=? ORDER BY ts DESC LIMIT 1`).get(userId);
    if (!force && recent && now().getTime() - Date.parse(recent.ts) < 60 * 60 * 1000) return recent;
    const s = storage(userId);
    const row = { id: randomId(), user_id: userId, storage_bytes: s.totalBytes, site_bytes: s.siteBytes, vault_bytes: s.vaultBytes, ts: now().toISOString() };
    db.prepare('INSERT INTO usage_snapshots (id,user_id,storage_bytes,site_bytes,vault_bytes,ts) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.user_id, row.storage_bytes, row.site_bytes, row.vault_bytes, row.ts);
    return row;
  }

  function reportForAccount(userId, range = {}) {
    const user = db.prepare('SELECT id,name,email,plan,storage_gb,created_at,suspended FROM users WHERE id=?').get(userId);
    if (!user) throw new Error('Account not found');
    const clock = now();
    const requestedPeriod = normalizePeriod(range, clock);
    // A current-period feed reports what has actually happened, never the
    // remainder of the month as though it were already delivered service.
    const observedTo = Math.min(Date.parse(requestedPeriod.to), clock.getTime());
    if (observedTo <= Date.parse(requestedPeriod.from)) throw new Error('Usage period has not started yet');
    const period = observedTo < Date.parse(requestedPeriod.to)
      ? { ...requestedPeriod, to: new Date(observedTo).toISOString(), seconds: Math.round((observedTo - Date.parse(requestedPeriod.from)) / 1000) }
      : requestedPeriod;
    snapshot(userId);

    const ai = db.prepare(`SELECT
        COUNT(*) calls,
        COALESCE(SUM(in_tok),0) input_tokens,
        COALESCE(SUM(out_tok),0) output_tokens,
        COALESCE(SUM(CASE WHEN byok=0 THEN cost ELSE 0 END),0) platform_cost,
        COALESCE(SUM(CASE WHEN byok=1 THEN cost ELSE 0 END),0) customer_key_cost,
        COALESCE(SUM(CASE WHEN byok=0 THEN 1 ELSE 0 END),0) platform_calls,
        COALESCE(SUM(CASE WHEN byok=1 THEN 1 ELSE 0 END),0) customer_key_calls,
        COALESCE(SUM(CASE WHEN byok=0 THEN in_tok+out_tok ELSE 0 END),0) platform_tokens,
        COALESCE(SUM(CASE WHEN byok=1 THEN in_tok+out_tok ELSE 0 END),0) customer_key_tokens
      FROM ai_usage WHERE user_id=? AND ts>=? AND ts<?`).get(userId, period.from, period.to);
    const snapshots = db.prepare(`SELECT * FROM usage_snapshots WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts`).all(userId, period.from, period.to);
    const end = storage(userId);
    const lifecycle = lifecycleDurations(db, userId, period);
    const quotaBytes = (user.storage_gb || 0) * 1024 * 1024 * 1024;

    return {
      schema: 'arca-usage/v1',
      generated_at: now().toISOString(),
      period,
      account: { id: user.id, name: user.name, email: user.email, plan: user.plan },
      assistant: {
        calls: ai.calls,
        input_tokens: ai.input_tokens,
        output_tokens: ai.output_tokens,
        platform: { calls: ai.platform_calls, tokens: ai.platform_tokens, cost_usd: roundMoney(ai.platform_cost) },
        customer_key: { calls: ai.customer_key_calls, tokens: ai.customer_key_tokens, provider_cost_usd: roundMoney(ai.customer_key_cost), billable_by_arca: false },
      },
      storage: {
        measured_at: now().toISOString(),
        end_bytes: end.totalBytes,
        vault_bytes: end.vaultBytes,
        site_bytes: end.siteBytes,
        quota_bytes: quotaBytes,
        percent_of_quota: quotaBytes ? Math.round(end.totalBytes / quotaBytes * 1000) / 10 : null,
        samples: snapshots.map(s => ({ ts: s.ts, bytes: s.storage_bytes })),
        byte_hours: integrateStorage(snapshots, period, end.totalBytes),
        note: 'end_bytes is an exact reading. byte_hours is integrated from hourly snapshots and is null until at least two readings exist.',
      },
      account_state: lifecycle,
      lifecycle_events: db.prepare('SELECT event,reason,ts FROM account_lifecycle WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts').all(userId, period.from, period.to),
    };
  }

  function reportAll(range = {}) {
    return db.prepare('SELECT id FROM users ORDER BY created_at').all().map(({ id }) => reportForAccount(id, range));
  }

  function toCsv(reports) {
    const rows = [[
      'account_id','email','period_from','period_to','ai_platform_calls','ai_platform_tokens','ai_platform_cost_usd',
      'ai_customer_key_calls','ai_customer_key_tokens','ai_customer_key_provider_cost_usd','storage_end_bytes',
      'storage_quota_bytes','storage_byte_hours','live_seconds','suspended_seconds','closed_seconds','inactive_seconds','lifecycle_events',
    ]];
    for (const r of reports) rows.push([
      r.account.id, r.account.email, r.period.from, r.period.to,
      r.assistant.platform.calls, r.assistant.platform.tokens, r.assistant.platform.cost_usd,
      r.assistant.customer_key.calls, r.assistant.customer_key.tokens, r.assistant.customer_key.provider_cost_usd,
      r.storage.end_bytes, r.storage.quota_bytes, r.storage.byte_hours,
      r.account_state.live_seconds, r.account_state.suspended_seconds, r.account_state.closed_seconds, r.account_state.inactive_seconds,
      r.lifecycle_events.map(e => `${e.ts}:${e.event}`).join('|'),
    ]);
    return rows.map(row => row.map(csvCell).join(',')).join('\n') + '\n';
  }

  return { recordLifecycle, storage, snapshot, reportForAccount, reportAll, toCsv, normalizePeriod };
}

function normalizePeriod(range = {}, clock = new Date()) {
  let from;
  let to;
  if (range.period && /^\d{4}-\d{2}$/.test(range.period)) {
    from = new Date(`${range.period}-01T00:00:00.000Z`);
    to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  } else {
    from = range.from ? new Date(range.from) : new Date(Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), 1));
    to = range.to ? new Date(range.to) : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  }
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('Usage period requires valid from/to dates with from before to');
  if (to - from > 366 * 86400000) throw new Error('Usage period cannot exceed 366 days');
  return { from: from.toISOString(), to: to.toISOString(), seconds: Math.round((to - from) / 1000) };
}

function lifecycleDurations(db, userId, period) {
  const before = db.prepare('SELECT event FROM account_lifecycle WHERE user_id=? AND ts<? ORDER BY ts DESC LIMIT 1').get(userId, period.from);
  const events = db.prepare('SELECT event,ts FROM account_lifecycle WHERE user_id=? AND ts>=? AND ts<? ORDER BY ts').all(userId, period.from, period.to);
  // No event before the requested period means the account did not exist yet.
  // Treating that time as live would overstate service time on the first bill.
  let state = before ? eventToState(before.event) : 'inactive';
  let cursor = Date.parse(period.from);
  const end = Date.parse(period.to);
  const ms = { live: 0, suspended: 0, closed: 0, inactive: 0 };
  for (const event of events) {
    const at = Math.max(cursor, Math.min(end, Date.parse(event.ts)));
    ms[state] += Math.max(0, at - cursor);
    state = eventToState(event.event);
    cursor = at;
  }
  ms[state] += Math.max(0, end - cursor);
  return {
    live_seconds: Math.round(ms.live / 1000),
    suspended_seconds: Math.round(ms.suspended / 1000),
    closed_seconds: Math.round(ms.closed / 1000),
    inactive_seconds: Math.round(ms.inactive / 1000),
    state_at_end: state,
  };
}

function eventToState(event) {
  if (event === 'suspended') return 'suspended';
  if (event === 'closed') return 'closed';
  return 'live';
}

function integrateStorage(samples, period, endBytes) {
  if (samples.length < 2) return null;
  const points = [...samples];
  if (Date.parse(points[0].ts) > Date.parse(period.from)) points.unshift({ ts: period.from, storage_bytes: points[0].storage_bytes });
  if (Date.parse(points[points.length - 1].ts) < Date.parse(period.to)) points.push({ ts: period.to, storage_bytes: endBytes });
  let byteMs = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dt = Math.max(0, Date.parse(points[i].ts) - Date.parse(points[i - 1].ts));
    byteMs += points[i - 1].storage_bytes * dt;
  }
  return Math.round(byteMs / 3600000);
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeGet(db, sql, ...args) {
  try { return db.prepare(sql).get(...args) || {}; }
  catch { return {}; }
}

function normalizeSqliteDate(value) {
  if (!value) return new Date(0).toISOString();
  const text = String(value);
  const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function roundMoney(value) { return Math.round(Number(value || 0) * 1000000) / 1000000; }
function randomId() { return crypto.randomBytes(10).toString('hex'); }

module.exports = { createUsageService, normalizePeriod, lifecycleDurations, integrateStorage };
