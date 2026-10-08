'use strict';

// BYOG — the model on the user's own machine.
//
// Navigator already knows two kinds of brain. The Resident is an OpenAI-compatible
// engine on the box Navigator itself runs on, free and private to that box. A
// Frontier is somebody's cloud API reached with a key. Neither of them is the
// thing a person means when they say "I have a 4090 at home and I would rather
// use that". Their machine is behind a router they are not going to reconfigure
// and it must never be reachable from the internet, so Navigator cannot dial it.
//
// So the connection is made the only way round that works: the machine dials
// out. A small helper on the user's computer holds one long-lived outbound HTTP
// request open, Navigator writes inference jobs down it, and the helper posts the
// answer back. No inbound port, no NAT rule, no tunnel to configure, and the
// local engine keeps listening only to its own loopback exactly as
// `localEngineSecurity` requires of the Resident.
//
// The rules this file exists to hold:
//
// - A device belongs to one person, and a job is dispatched by looking up that
//   person's devices, never by taking a device id from a caller. There is no
//   argument anywhere in this service that lets one user reach another user's
//   machine.
// - The credential the helper holds is a device credential and nothing else. It
//   lives in its own namespace, it is refused on every panel route, and the
//   scopes an API key would carry do not exist for it. A stolen helper token
//   buys the ability to answer inference jobs and nothing more.
// - The secret is shown once and stored nowhere. What is kept is a hash and a
//   public prefix, the same shape as `apiKeys.js`, so a device can be listed and
//   revoked without the panel being able to reproduce its token.
// - Revocation is immediate. The live link is closed on revoke and the next job
//   is refused, rather than the device staying usable until something restarts.
// - A job is answered once. The id is single use and the answer must carry the
//   nonce the job was issued with, so a replayed result is dropped.
// - Prompt content is never written to the database. Jobs live in memory for
//   the length of the request and the row on disk holds counters, timings and
//   error text only. What Navigator knows about a BYOG conversation afterwards is
//   that it happened, how long it took and whether it worked.
//
// What this does NOT claim: the prompt still passes through Navigator. Navigator builds
// the system prompt, so it necessarily sees the request on its way to the
// device. BYOG moves the INFERENCE to the user's hardware, it does not make
// Navigator blind. See docs/BYOG.md, "Where the words actually go".

const crypto = require('crypto');

// `arcadev_<prefix>_<secret>`. Deliberately not the `arca_` namespace that
// `looksLikeApiKey` recognises: a device credential must never be mistaken for
// a machine credential that can reach panel operations.
const PREFIX_BYTES = 6;
const SECRET_BYTES = 24;
const DEVICE_TOKEN = /^arcadev_([a-f0-9]{12})_([a-f0-9]{48})$/;

// A pairing code is typed by a person off one screen into another, so the
// alphabet has no 0/O/1/I/L and the code is grouped. Ten characters of a
// 32-symbol alphabet is fifty bits, which is far past guessable inside a
// fifteen minute window that also rate limits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_TTL_MS = 15 * 60 * 1000;

const HEARTBEAT_MS = 20 * 1000;
const LINK_STALE_MS = 65 * 1000;
const DEFAULT_JOB_TIMEOUT_MS = 300 * 1000;
const MAX_JOB_BYTES = 256 * 1024;
const DEFAULT_MAX_CONCURRENT = 1;
const MAX_MAX_CONCURRENT = 4;
// Three failures in a row and the device stops being chosen automatically. A
// laptop that shut its lid mid-job should not keep being picked first for the
// next twenty requests while every one of them waits out the timeout.
const DEGRADE_AFTER_FAILURES = 3;

function looksLikeDeviceToken(value) {
  return typeof value === 'string' && value.startsWith('arcadev_');
}

class ByogError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.byog = true;
  }
}

function createByogService({
  db,
  now = () => new Date(),
  audit = () => {},
  // Prompt text reaches the log only when an operator has deliberately asked
  // for it. The default is that a support engineer reading the journal sees
  // that a job ran, not what was in it.
  logPrompts = (process.env.JOTPANEL_BYOG_LOG_PROMPTS ?? process.env.ARCA_BYOG_LOG_PROMPTS) === '1',
  jobTimeoutMs = parseInt((process.env.JOTPANEL_BYOG_JOB_TIMEOUT_MS ?? process.env.ARCA_BYOG_JOB_TIMEOUT_MS) || '', 10) || DEFAULT_JOB_TIMEOUT_MS,
  log = (...args) => console.log(...args),
} = {}) {
  if (!db) throw new Error('the byog service requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS byog_devices (
      id                   TEXT PRIMARY KEY,
      user_id              TEXT NOT NULL,
      name                 TEXT NOT NULL,
      prefix               TEXT NOT NULL UNIQUE,
      secret_hash          TEXT NOT NULL,
      created_at           TEXT NOT NULL,
      paired_from          TEXT,
      agent_version        TEXT,
      engine_kind          TEXT,
      host_info            TEXT NOT NULL DEFAULT '{}',
      models               TEXT NOT NULL DEFAULT '[]',
      max_concurrent       INTEGER NOT NULL DEFAULT 1,
      auto_route           INTEGER NOT NULL DEFAULT 1,
      last_seen_at         TEXT,
      last_job_at          TEXT,
      last_latency_ms      INTEGER,
      last_tps             REAL,
      jobs_ok              INTEGER NOT NULL DEFAULT 0,
      jobs_failed          INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      last_error_at        TEXT,
      rotated_at           TEXT,
      revoked_at           TEXT,
      revoked_by           TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_byog_devices_user ON byog_devices(user_id);

    CREATE TABLE IF NOT EXISTS byog_pair_codes (
      code_hash  TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_byog_pair_user ON byog_pair_codes(user_id);
  `);

  const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
  const iso = () => now().toISOString();
  const ms = () => now().getTime();

  // ── The live link registry ──────────────────────────────────────
  // In memory on purpose. A link is a TCP connection this process is holding,
  // so it cannot survive a restart and a row saying "online" that outlived the
  // socket would be a lie the router would then act on. After a restart every
  // device is offline until its helper dials back in, which is the truth.
  const links = new Map(); // deviceId → link

  function linkFor(deviceId) {
    const link = links.get(deviceId);
    if (!link) return null;
    if (ms() - link.lastSeen > LINK_STALE_MS) {
      dropLink(deviceId, 'stale');
      return null;
    }
    return link;
  }

  function dropLink(deviceId, reason) {
    const link = links.get(deviceId);
    if (!link) return;
    links.delete(deviceId);
    clearInterval(link.heartbeat);
    // Anything still waiting on this device fails now rather than sitting until
    // its own timeout. A closed lid should surface in a second, not in five
    // minutes, because the caller may be able to fall back.
    for (const job of link.jobs.values()) {
      job.fail(new ByogError('link_lost', `The link to ${link.deviceName} closed while the job was running (${reason}).`));
    }
    link.jobs.clear();
    try { link.writer.close(reason); } catch { /* already gone */ }
  }

  // ── Credentials ─────────────────────────────────────────────────

  function issueToken(deviceId) {
    const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
    const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');
    db.prepare('UPDATE byog_devices SET prefix=?, secret_hash=?, rotated_at=? WHERE id=?')
      .run(prefix, hash(secret), iso(), deviceId);
    return `arcadev_${prefix}_${secret}`;
  }

  // Never throws on rubbish, and never says which half was wrong.
  function verifyToken(presented) {
    const match = DEVICE_TOKEN.exec(String(presented || ''));
    if (!match) return null;
    const row = db.prepare('SELECT * FROM byog_devices WHERE prefix=?').get(match[1]);
    if (!row) return null;
    const expected = Buffer.from(row.secret_hash, 'utf8');
    const given = Buffer.from(hash(match[2]), 'utf8');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    if (row.revoked_at) return null;
    return row;
  }

  // ── Pairing ─────────────────────────────────────────────────────

  function issuePairCode(userId) {
    if (!userId) throw new ByogError('no_identity', 'A pairing code belongs to a person');
    // One live code per person. Asking for a second invalidates the first, so a
    // code read aloud on a support call cannot be used later by whoever heard it.
    db.prepare('DELETE FROM byog_pair_codes WHERE user_id=?').run(userId);
    const raw = Array.from(crypto.randomBytes(10)).map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    const expiresAt = new Date(ms() + PAIR_TTL_MS).toISOString();
    db.prepare('INSERT INTO byog_pair_codes (code_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .run(hash(normaliseCode(code)), userId, iso(), expiresAt);
    return { code, expiresAt, expiresInSeconds: Math.round(PAIR_TTL_MS / 1000) };
  }

  function normaliseCode(code) {
    return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // The helper's first and only unauthenticated call. The code is the whole
  // credential, so it is single use, short lived and consumed inside the same
  // transaction that creates the device.
  function pair({ code, name, platform, arch, agentVersion, engineKind, host, models, maxConcurrent, from } = {}) {
    const cleaned = normaliseCode(code);
    if (!cleaned) throw new ByogError('bad_code', 'A pairing code is required');
    const row = db.prepare('SELECT * FROM byog_pair_codes WHERE code_hash=?').get(hash(cleaned));
    if (!row) throw new ByogError('bad_code', 'That pairing code is not valid.');
    if (row.used_at) throw new ByogError('bad_code', 'That pairing code has already been used.');
    if (new Date(row.expires_at).getTime() <= ms()) {
      db.prepare('DELETE FROM byog_pair_codes WHERE code_hash=?').run(row.code_hash);
      throw new ByogError('bad_code', 'That pairing code has expired. Generate a new one in Settings.');
    }

    const deviceId = `dev_${crypto.randomBytes(8).toString('hex')}`;
    const label = String(name || '').trim().slice(0, 60) || 'My computer';
    const tx = db.transaction(() => {
      db.prepare('UPDATE byog_pair_codes SET used_at=? WHERE code_hash=?').run(iso(), row.code_hash);
      db.prepare(`INSERT INTO byog_devices
          (id,user_id,name,prefix,secret_hash,created_at,paired_from,agent_version,engine_kind,host_info,models,max_concurrent)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(deviceId, row.user_id, label, `pending_${crypto.randomBytes(3).toString('hex')}`, 'pending',
          iso(), String(from || '').slice(0, 60) || null, String(agentVersion || '').slice(0, 30) || null,
          String(engineKind || '').slice(0, 30) || null,
          JSON.stringify(cleanHost({ platform, arch, ...(host || {}) })),
          JSON.stringify(cleanModels(models)), clampConcurrency(maxConcurrent));
    });
    tx();
    const token = issueToken(deviceId);
    audit(row.user_id, 'byog_device_paired', null, `${label} (${deviceId})`);
    return {
      deviceId,
      token,
      name: label,
      heartbeatSeconds: Math.round(HEARTBEAT_MS / 1000),
      jobTimeoutSeconds: Math.round(jobTimeoutMs / 1000),
      maxJobBytes: MAX_JOB_BYTES,
    };
  }

  function clampConcurrency(value) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENT;
    return Math.min(n, MAX_MAX_CONCURRENT);
  }

  // Everything the helper reports about the machine is written down, and
  // everything it reports is treated as a claim by a device rather than as
  // fact: it is length-capped, type-checked and never interpolated anywhere it
  // could execute. It exists so a person recognises their own computer in a
  // list, and so the router can tell a 24GB card from a laptop.
  function cleanHost(input) {
    const src = input && typeof input === 'object' ? input : {};
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
    const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
    return {
      platform: str(src.platform, 20),
      arch: str(src.arch, 20),
      cpus: num(src.cpus),
      memGb: num(src.memGb),
      gpu: str(src.gpu, 80),
      engineVersion: str(src.engineVersion, 40),
    };
  }

  function cleanModels(input) {
    const list = Array.isArray(input) ? input : [];
    const out = [];
    for (const entry of list.slice(0, 60)) {
      const name = typeof entry === 'string' ? entry : (entry && typeof entry.name === 'string' ? entry.name : '');
      const clean = name.trim().slice(0, 100);
      if (!clean || out.some(m => m.name === clean)) continue;
      const src = (entry && typeof entry === 'object') ? entry : {};
      out.push({
        name: clean,
        family: typeof src.family === 'string' ? src.family.slice(0, 40) : null,
        paramSize: typeof src.paramSize === 'string' ? src.paramSize.slice(0, 20) : null,
        quant: typeof src.quant === 'string' ? src.quant.slice(0, 20) : null,
        contextWindow: Number.isFinite(Number(src.contextWindow)) ? Number(src.contextWindow) : null,
        vision: src.vision === true || isVisionName(clean),
        tools: src.tools === true,
        sizeBytes: Number.isFinite(Number(src.sizeBytes)) ? Number(src.sizeBytes) : null,
      });
    }
    return out;
  }

  const isVisionName = n => /vl|llava|vision|moondream|bakllava|gemma3|minicpm/i.test(n);
  const isCoderName = n => /coder|code/i.test(n);
  // The same licence exclusion the Resident applies. This is the user's own
  // machine and their own copy, so the model is not removed from the list and
  // they may pin it deliberately, but nothing in this product will CHOOSE a
  // non-commercial model on their behalf inside a sold product.
  const isNonCommercial = n => /qwen2\.5:3b/i.test(n);

  function report(deviceId, payload = {}) {
    const device = getRow(deviceId);
    if (!device) throw new ByogError('unknown_device', 'No such device');
    const models = cleanModels(payload.models);
    const host = cleanHost({ ...(payload.host || {}), engineVersion: payload.engine && payload.engine.version });
    db.prepare(`UPDATE byog_devices SET models=?, host_info=?, engine_kind=?, max_concurrent=?, agent_version=?, last_seen_at=? WHERE id=?`)
      .run(JSON.stringify(models), JSON.stringify(host),
        String((payload.engine && payload.engine.kind) || device.engine_kind || '').slice(0, 30) || null,
        clampConcurrency(payload.maxConcurrent != null ? payload.maxConcurrent : device.max_concurrent),
        String(payload.agentVersion || device.agent_version || '').slice(0, 30) || null,
        iso(), deviceId);
    const link = links.get(deviceId);
    if (link) link.models = models;
    return present(getRow(deviceId));
  }

  // ── Device records ──────────────────────────────────────────────

  const getRow = id => db.prepare('SELECT * FROM byog_devices WHERE id=?').get(id) || null;

  function parse(json, fallback) {
    try { return JSON.parse(json); } catch { return fallback; }
  }

  function present(row) {
    if (!row) return null;
    const link = links.get(row.id);
    const online = !!link && ms() - link.lastSeen <= LINK_STALE_MS;
    const models = parse(row.models, []);
    return {
      id: row.id,
      name: row.name,
      online,
      connectedAt: link ? new Date(link.connectedAt).toISOString() : null,
      inFlight: link ? link.jobs.size : 0,
      maxConcurrent: row.max_concurrent,
      autoRoute: !!row.auto_route,
      degraded: row.consecutive_failures >= DEGRADE_AFTER_FAILURES,
      models,
      picks: classify(models),
      host: parse(row.host_info, {}),
      engineKind: row.engine_kind,
      agentVersion: row.agent_version,
      lastSeenAt: row.last_seen_at,
      lastJobAt: row.last_job_at,
      lastLatencyMs: row.last_latency_ms,
      lastTps: row.last_tps,
      jobsOk: row.jobs_ok,
      jobsFailed: row.jobs_failed,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // Which model answers which kind of work, decided from what the machine
  // actually has rather than from a hardcoded name, exactly as the Resident
  // does it. A vision model is a poor choice for plain text, so it is only the
  // chat pick when there is nothing else.
  function classify(models) {
    const names = models.map(m => m.name).filter(n => !isNonCommercial(n));
    const chat = names.find(n => !isCoderName(n) && !isVisionName(n)) || names.find(n => !isCoderName(n)) || names[0] || null;
    const code = names.find(isCoderName) || chat;
    const vision = models.find(m => m.vision && !isNonCommercial(m.name));
    return { chatModel: chat || null, codeModel: code || null, visionModel: vision ? vision.name : null };
  }

  function listDevices(userId) {
    return db.prepare('SELECT * FROM byog_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC')
      .all(userId).map(present);
  }

  function ownedDevice(userId, deviceId) {
    const row = getRow(deviceId);
    // The same answer for "not yours" and "does not exist". A caller must not be
    // able to enumerate other people's device ids by the shape of the refusal.
    if (!row || row.user_id !== userId || row.revoked_at) return null;
    return row;
  }

  function renameDevice(userId, deviceId, name) {
    const row = ownedDevice(userId, deviceId);
    if (!row) throw new ByogError('unknown_device', 'No such device');
    const label = String(name || '').trim().slice(0, 60);
    if (!label) throw new ByogError('bad_name', 'A device needs a name');
    db.prepare('UPDATE byog_devices SET name=? WHERE id=?').run(label, deviceId);
    return present(getRow(deviceId));
  }

  function setAutoRoute(userId, deviceId, allowed) {
    const row = ownedDevice(userId, deviceId);
    if (!row) throw new ByogError('unknown_device', 'No such device');
    db.prepare('UPDATE byog_devices SET auto_route=? WHERE id=?').run(allowed ? 1 : 0, deviceId);
    return present(getRow(deviceId));
  }

  // Immediate. The row is marked, the live link is torn down in the same call
  // and anything in flight on it fails now. A device that is revoked while
  // generating does not get to finish the sentence.
  function revokeDevice(userId, deviceId) {
    const row = ownedDevice(userId, deviceId);
    if (!row) throw new ByogError('unknown_device', 'No such device');
    db.prepare('UPDATE byog_devices SET revoked_at=?, revoked_by=?, secret_hash=? WHERE id=?')
      .run(iso(), userId, `revoked_${crypto.randomBytes(8).toString('hex')}`, deviceId);
    const link = links.get(deviceId);
    if (link) {
      try { link.writer.send('revoked', { reason: 'This device was removed from the account.' }); } catch {}
      dropLink(deviceId, 'revoked');
    }
    audit(userId, 'byog_device_revoked', null, `${row.name} (${deviceId})`);
    return { ok: true, id: deviceId };
  }

  // ── The link ────────────────────────────────────────────────────
  //
  // `writer` is the transport, so the HTTP route can hand in an Express
  // response and a test can hand in an array. Nothing below this line knows
  // what an Express response is.
  function attachLink(device, writer) {
    if (device.revoked_at) throw new ByogError('revoked', 'This device was removed from the account.');
    // A second helper for the same device displaces the first rather than
    // running two. Two links means a job could be written to whichever one the
    // map happened to hold, and the answer would come back from a machine the
    // user thought they had closed.
    if (links.has(device.id)) {
      const existing = links.get(device.id);
      try { existing.writer.send('displaced', { reason: 'This device connected again from somewhere else.' }); } catch {}
      dropLink(device.id, 'displaced');
    }

    const link = {
      deviceId: device.id,
      deviceName: device.name,
      userId: device.user_id,
      writer,
      connectedAt: ms(),
      lastSeen: ms(),
      jobs: new Map(),
      models: parse(device.models, []),
      maxConcurrent: device.max_concurrent,
      heartbeat: null,
    };
    link.heartbeat = setInterval(() => beat(device.id), HEARTBEAT_MS);
    if (typeof link.heartbeat.unref === 'function') link.heartbeat.unref();
    links.set(device.id, link);
    touch(device.id);

    writer.send('hello', {
      protocol: 1,
      deviceId: device.id,
      name: device.name,
      heartbeatSeconds: Math.round(HEARTBEAT_MS / 1000),
      jobTimeoutSeconds: Math.round(jobTimeoutMs / 1000),
      maxConcurrent: device.max_concurrent,
      maxJobBytes: MAX_JOB_BYTES,
    });
    log(`[byog] ${device.name} (${device.id}) linked`);
    return () => dropLink(device.id, 'closed');
  }

  function touch(deviceId) {
    const link = links.get(deviceId);
    if (link) link.lastSeen = ms();
    try { db.prepare('UPDATE byog_devices SET last_seen_at=? WHERE id=?').run(iso(), deviceId); } catch {}
  }

  // One heartbeat, and the thing that makes an idle link count as alive.
  //
  // This was a real bug, found in the browser rather than in a test. The
  // staleness clock was only ever reset by the device DOING something, so a
  // machine that was connected, healthy and simply not being asked anything
  // aged out after a minute and read as offline. BYOG would have worked only
  // for people who talked to it at least once a minute.
  //
  // The socket is the liveness signal, not the traffic. A write that goes
  // through means the connection is still there, the peer hanging up fires
  // `close` on the response and drops the link within a second, and TCP
  // keepalive catches the half-open case where neither end said goodbye. So the
  // staleness window stays as a backstop for a heartbeat that has stopped
  // firing, and a beat that lands refreshes it.
  function beat(deviceId) {
    const link = links.get(deviceId);
    if (!link) return false;
    try {
      link.writer.send('ping', { at: iso() });
      link.lastSeen = ms();
      // The row is what the screen reads once a machine goes away, so "last
      // seen" has to mean the last time we heard anything and not the last time
      // somebody asked it a question. Written at a slower cadence than the beat
      // itself, because this is one row update per device per minute on a box
      // that may have a lot of devices.
      if (!link.lastPersisted || link.lastSeen - link.lastPersisted > 60000) {
        link.lastPersisted = link.lastSeen;
        try { db.prepare('UPDATE byog_devices SET last_seen_at=? WHERE id=?').run(iso(), deviceId); } catch {}
      }
      return true;
    } catch {
      dropLink(deviceId, 'write failed');
      return false;
    }
  }

  // ── Dispatch ────────────────────────────────────────────────────
  //
  // What crosses the link is a structured inference job and never a command, a
  // URL or a shell string. The helper picks its own endpoint out of its own
  // config; nothing here can redirect it, which is the property that makes a
  // compromised Navigator unable to turn a user's laptop into an outbound proxy.
  function dispatch({ userId, deviceId, model, system, messages, maxTokens, onDelta, signal }) {
    const device = ownedDevice(userId, deviceId);
    if (!device) throw new ByogError('unknown_device', 'That device is not on this account.');
    const link = linkFor(deviceId);
    if (!link) throw new ByogError('offline', `${device.name} is not connected right now.`);
    if (link.jobs.size >= device.max_concurrent) {
      throw new ByogError('busy', `${device.name} is already running ${link.jobs.size} job(s).`);
    }

    const chosen = String(model || '').slice(0, 100);
    if (!chosen) throw new ByogError('no_model', 'No model was chosen for that device.');

    const jobId = `job_${crypto.randomBytes(10).toString('hex')}`;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = {
      jobId,
      nonce,
      model: chosen,
      system: typeof system === 'string' ? system : '',
      messages: (Array.isArray(messages) ? messages : []).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content : String(m.content || ''),
        images: Array.isArray(m.images)
          ? m.images.filter(s => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 4)
          : undefined,
      })),
      maxTokens: Number.isFinite(Number(maxTokens)) ? Number(maxTokens) : null,
      stream: typeof onDelta === 'function',
      deadlineSeconds: Math.round(jobTimeoutMs / 1000),
    };

    const size = Buffer.byteLength(JSON.stringify(payload));
    if (size > MAX_JOB_BYTES) {
      throw new ByogError('too_large', `That request is ${Math.round(size / 1024)} KB and this link carries at most ${Math.round(MAX_JOB_BYTES / 1024)} KB.`);
    }

    let settled = false;
    let firstDeltaAt = null;
    let collected = '';
    const startedAt = ms();
    let resolveJob, rejectJob;
    const promise = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
    const job = {
      id: jobId,
      nonce,
      deviceId,
      userId,
      model: chosen,
      startedAt,
      // Whether anything has already been sent to the browser. The caller reads
      // this to decide if a fallback is still honest: once the user has seen
      // tokens from one model, quietly finishing in another one is not a
      // fallback, it is two answers stitched together.
      get streamed() { return firstDeltaAt !== null; },
      onDelta(text) {
        if (settled || !text) return;
        if (firstDeltaAt === null) firstDeltaAt = ms();
        collected += text;
        if (typeof onDelta === 'function') onDelta(text);
      },
      finish(result) {
        if (settled) return false;
        // What the device says the answer was, or failing that what it actually
        // sent. A helper that streams tokens and then closes without repeating
        // the whole text has still answered.
        const text = (result && typeof result.text === 'string' && result.text) ? result.text : collected;
        // An empty answer is a failure, not an answer. The end-to-end run found
        // this the hard way: an engine returning malformed lines produced no
        // tokens, the helper reported success with an empty string, and Navigator
        // handed the user a blank reply from their own computer while another
        // brain was sitting there able to answer. Empty means fall back.
        if (!text || !text.trim()) {
          return this.fail(new ByogError('empty_answer', `${device.name} answered with nothing.`));
        }
        settled = true;
        cleanup();
        const duration = ms() - startedAt;
        recordSuccess(deviceId, duration, result.outTok, firstDeltaAt ? firstDeltaAt - startedAt : null);
        resolveJob({ text, inTok: result.inTok || 0, outTok: result.outTok || 0, byogDevice: device.name, ttftMs: firstDeltaAt ? firstDeltaAt - startedAt : null, durMs: duration });
        return true;
      },
      fail(error) {
        if (settled) return false;
        settled = true;
        cleanup();
        recordFailure(deviceId, error);
        rejectJob(error);
        return true;
      },
    };

    const timer = setTimeout(() => {
      job.fail(new ByogError('timeout', `${device.name} did not answer within ${Math.round(jobTimeoutMs / 1000)} seconds.`));
      try { link.writer.send('cancel', { jobId, reason: 'timeout' }); } catch {}
    }, jobTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const onAbort = () => {
      try { link.writer.send('cancel', { jobId, reason: 'client went away' }); } catch {}
      job.fail(new ByogError('cancelled', 'The request was cancelled.'));
    };
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); throw new ByogError('cancelled', 'The request was cancelled.'); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const live = links.get(deviceId);
      if (live) live.jobs.delete(jobId);
    }

    link.jobs.set(jobId, job);
    try {
      link.writer.send('job', payload);
    } catch (error) {
      job.fail(new ByogError('link_lost', `The link to ${device.name} closed before the job was sent.`));
      dropLink(deviceId, 'write failed');
    }
    if (!logPrompts) log(`[byog] job ${jobId} → ${device.name} (${chosen}, ${payload.messages.length} messages)`);
    else log(`[byog] job ${jobId} → ${device.name} (${chosen}): ${JSON.stringify(payload.messages).slice(0, 2000)}`);
    return { jobId, promise, job };
  }

  // A result is claimed by the device that owns the job, once, with the nonce
  // it was issued. Everything else is dropped.
  function claimJob(deviceId, jobId, nonce) {
    const link = links.get(deviceId);
    if (!link) throw new ByogError('no_link', 'This device has no open link.');
    const job = link.jobs.get(jobId);
    if (!job) throw new ByogError('unknown_job', 'That job is not open on this device.');
    const expected = Buffer.from(job.nonce, 'utf8');
    const given = Buffer.from(String(nonce || ''), 'utf8');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      throw new ByogError('bad_nonce', 'That answer does not match the job it claims to answer.');
    }
    // One answer, one claim. A job is settled once whatever happens, so this is
    // belt and braces rather than the guarantee, but it turns two overlapping
    // answers to the same question into a refusal instead of an interleaving.
    if (job.claimed) throw new ByogError('already_claimed', 'That job is already being answered.');
    job.claimed = true;
    touch(deviceId);
    return job;
  }

  function recordSuccess(deviceId, durationMs, outTok, ttftMs) {
    try {
      const tps = durationMs > 0 && outTok ? outTok / (durationMs / 1000) : null;
      db.prepare(`UPDATE byog_devices SET jobs_ok=jobs_ok+1, consecutive_failures=0,
                  last_job_at=?, last_latency_ms=?, last_tps=?, last_seen_at=? WHERE id=?`)
        .run(iso(), ttftMs != null ? ttftMs : durationMs, tps, iso(), deviceId);
    } catch { /* bookkeeping must not break an answer that worked */ }
  }

  function recordFailure(deviceId, error) {
    try {
      db.prepare(`UPDATE byog_devices SET jobs_failed=jobs_failed+1, consecutive_failures=consecutive_failures+1,
                  last_error=?, last_error_at=?, last_job_at=? WHERE id=?`)
        .run(`${error.code || 'error'}: ${String(error.message || '').slice(0, 200)}`, iso(), iso(), deviceId);
    } catch { /* as above */ }
  }

  // ── Policy and selection ────────────────────────────────────────
  //
  // BYOG is not automatically the best brain in the room and it is not wired in
  // as one. It is free and it is the user's own hardware, which makes it the
  // right answer for mechanical work, and a 14B on a desktop is still not the
  // right answer for the judgement calls the routing table escalates. So it
  // wins where cheap-and-local already wins and it queues behind a Frontier key
  // where genuine judgement is being asked for, which is the same rule
  // ROADMAP.md sets for the Resident.
  const MECHANICAL_TASKS = new Set(['code', 'chat', 'summarize']);

  const DEFAULT_POLICY = { mode: 'auto', deviceId: null, model: null, residentFallback: true };

  function readPolicy(userId) {
    let raw = {};
    try {
      const row = db.prepare('SELECT data FROM settings WHERE user_id=?').get(userId);
      if (row) raw = (parse(row.data, {}) || {}).byog || {};
    } catch { /* settings is the desktop's table; a panel without it has no policy */ }
    const mode = ['auto', 'private', 'off'].includes(raw.mode) ? raw.mode : DEFAULT_POLICY.mode;
    return {
      mode,
      deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      residentFallback: raw.residentFallback !== false,
    };
  }

  // Which of this person's machines should answer, and with which model. Returns
  // null with a reason rather than throwing, because "no device right now" is an
  // ordinary state that the router has to be able to route around.
  function selectDevice(userId, { task = 'chat', needsVision = false, explicitModel = null, ignoreAutoRoute = false } = {}) {
    const policy = readPolicy(userId);
    if (policy.mode === 'off' && !ignoreAutoRoute) return { device: null, policy, reason: 'BYOG is switched off for this account.' };

    let rows = db.prepare('SELECT * FROM byog_devices WHERE user_id=? AND revoked_at IS NULL').all(userId);
    if (policy.deviceId) rows = rows.filter(r => r.id === policy.deviceId);
    if (!ignoreAutoRoute) rows = rows.filter(r => r.auto_route);
    const online = rows.filter(r => linkFor(r.id));
    if (!online.length) {
      return { device: null, policy, reason: rows.length ? 'Your computer is not connected right now.' : 'No computer is paired with this account.' };
    }
    const healthy = online.filter(r => r.consecutive_failures < DEGRADE_AFTER_FAILURES);
    const pool = healthy.length ? healthy : (ignoreAutoRoute ? online : []);
    if (!pool.length) return { device: null, policy, reason: 'Your computer failed its last few jobs, so it is being rested.' };

    // Free first, then the machine that answered fastest last time. A desktop
    // with a card beats a laptop on battery without either of them having to
    // declare which is which.
    pool.sort((a, b) => (a.last_latency_ms || 1e9) - (b.last_latency_ms || 1e9));

    for (const row of pool) {
      const models = parse(row.models, []);
      const picks = classify(models);
      let model = explicitModel || policy.model || null;
      if (model && !models.some(m => m.name === model)) model = null;
      if (!model) {
        if (needsVision) model = picks.visionModel;
        else if (task === 'code' || task === 'build') model = picks.codeModel;
        else model = picks.chatModel;
      }
      if (!model) continue;
      if (needsVision && !models.some(m => m.name === model && m.vision)) continue;
      return { device: present(row), model, policy, reason: null };
    }
    return { device: null, policy, reason: needsVision ? 'No vision model is pulled on your computer.' : 'No usable model is pulled on your computer.' };
  }

  // Should the router reach for the device BEFORE consulting the routing table
  // for this task? Mechanical work yes, judgement no, unless there is no
  // Frontier key at all in which case the user's own machine is the best thing
  // available and the routing table is going to come up empty anyway.
  function preferBefore(task, { hasFrontier }) {
    if (!hasFrontier) return true;
    return MECHANICAL_TASKS.has(task || 'chat');
  }

  function stats() {
    const total = db.prepare('SELECT COUNT(*) AS n FROM byog_devices WHERE revoked_at IS NULL').get().n;
    return { devices: total, links: links.size };
  }

  // For the shutdown path and for tests: close every link deterministically.
  function closeAll(reason = 'server stopping') {
    for (const id of Array.from(links.keys())) dropLink(id, reason);
  }

  return {
    // credentials + pairing
    issuePairCode, pair, verifyToken, looksLikeDeviceToken,
    // records
    listDevices, present, getRow, ownedDevice, renameDevice, setAutoRoute, revokeDevice, report,
    // link + dispatch
    attachLink, dropLink, linkFor, dispatch, claimJob, touch, beat, closeAll,
    // routing
    readPolicy, selectDevice, preferBefore, classify, stats,
    ByogError,
    constants: { HEARTBEAT_MS, LINK_STALE_MS, MAX_JOB_BYTES, DEGRADE_AFTER_FAILURES, PAIR_TTL_MS, jobTimeoutMs },
  };
}

module.exports = { createByogService, looksLikeDeviceToken, ByogError };
