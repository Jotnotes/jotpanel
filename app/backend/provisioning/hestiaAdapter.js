'use strict';

// HestiaCP adapter — the second panel backend behind the same provisioning contract.
//
// The provisioning service builds a scoped, approved `call` object (see actions.js)
// and hands it here for execution. Those call objects are currently expressed in
// cPanel's vocabulary (`module` + `function`), so this adapter's real job is
// translation: it maps a cPanel-shaped call onto Hestia's v-command API and
// normalizes the response back into the same execution envelope the cPanel adapter
// returns. Nothing in actions.js or index.js changes.
//
// Hestia's API is a single POST to https://host:8083/api/ carrying a command name
// and up to nine POSITIONAL arguments. Positional is the important word: argument
// order is the whole contract, and getting it wrong on a write command silently
// creates the wrong object rather than erroring. See COMMANDS below for which
// signatures are verified and which are not.
//
// Transport is injectable so this is unit-testable without a live Hestia box.
// When the environment is not configured the server keeps the mock adapter, so
// local dev and the test suite never need a panel.

const https = require('https');
const { URLSearchParams } = require('url');

// ── Command map ───────────────────────────────────────────────────
// Keyed by the cPanel `Module::function` the action layer emits. `args` receives
// the call params plus the account context and returns the positional argument
// list in Hestia's expected order.
//
// `verified` records whether the signature has been confirmed against a live
// Hestia box. Anything false is a best-effort mapping taken from the documented
// CLI signature and MUST be checked before it is trusted with real data. The
// read commands are the ones this adapter is currently useful for.
const COMMANDS = {
  // ── Reads ───────────────────────────────────────────────────────
  'StatsBar::get_stats': {
    write: false,
    verified: false,
    cmd: 'v-list-user',
    // v-list-user USER [FORMAT] — returns disk, bandwidth, package and counts in
    // one object, so Hestia needs no separate bandwidth call.
    args: (_params, ctx) => [ctx.panelUser, 'json'],
  },
  'Bandwidth::query': {
    write: false,
    verified: false,
    cmd: 'v-list-user',
    args: (_params, ctx) => [ctx.panelUser, 'json'],
  },

  // ── Writes (gated; see allowWrites) ─────────────────────────────
  'Email::add_pop': {
    write: true,
    verified: false,
    cmd: 'v-add-mail-account',
    // v-add-mail-account USER DOMAIN ACCOUNT PASSWORD [QUOTA]
    args: (p, ctx) => [ctx.panelUser, p.domain, p.email, p.password, quotaArg(p.quota)],
  },
  'Ftp::add_ftp': {
    write: true,
    verified: false,
    cmd: 'v-add-web-domain-ftp',
    // v-add-web-domain-ftp USER DOMAIN FTP_USER FTP_PASSWORD [FTP_PATH]
    args: (p, ctx) => [ctx.panelUser, p.domain, p.user, p.pass, p.homedir || ''],
  },
  'ZoneEdit::add_zone_record': {
    write: true,
    verified: false,
    cmd: 'v-add-dns-record',
    // v-add-dns-record USER DOMAIN RECORD TYPE VALUE [PRIORITY] [ID] [TTL]
    // Hestia wants the host label, not the FQDN, so the zone suffix comes off.
    args: (p, ctx) => [
      ctx.panelUser,
      p.domain,
      hostLabel(p.name, p.domain),
      p.type,
      dnsValue(p),
      p.type === 'MX' ? String(p.preference ?? 10) : '',
      '',
      p.ttl === undefined ? '' : String(p.ttl),
    ],
  },
};

// Hestia expresses "no quota" as unlimited rather than 0.
function quotaArg(quota) {
  const n = Number(quota);
  if (!Number.isFinite(n) || n <= 0) return 'unlimited';
  return String(n);
}

// actions.js normalizes DNS names to a FQDN; Hestia stores the label relative to
// the zone, with the apex written as '@'.
function hostLabel(name, zone) {
  const fqdn = String(name || '').trim().toLowerCase().replace(/\.$/, '');
  const z = String(zone || '').trim().toLowerCase();
  if (!fqdn || fqdn === z) return '@';
  return fqdn.endsWith(`.${z}`) ? fqdn.slice(0, -(z.length + 1)) : fqdn;
}

function dnsValue(p) {
  if (p.address) return p.address;
  if (p.cname) return p.cname;
  if (p.exchange) return p.exchange;
  if (p.txtdata) return p.txtdata;
  throw new Error('DNS record has no value to send');
}

// ── HTTP transport ────────────────────────────────────────────────
// Hestia listens on 8083 and ships a self-signed certificate on a fresh install,
// so TLS verification is configurable and defaults to on.
function defaultTransport({ hostname, port, path, body, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, 'utf8');
    const req = https.request(
      {
        hostname,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': payload.length,
        },
        rejectUnauthorized,
        timeout: timeoutMs,
      },
      (r) => {
        let buf = '';
        r.on('data', (d) => (buf += d));
        r.on('end', () => resolve({ statusCode: r.statusCode, body: buf }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Hestia request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Response handling ─────────────────────────────────────────────
// Hestia answers in one of three shapes: a JSON object (when the command takes a
// `json` format argument), a bare exit code, or an error string. Exit code 0 is
// success; every other code is a failure and the numbers are stable enough to
// name the common ones.
const EXIT_CODES = {
  1: 'invalid arguments',
  2: 'object does not exist',
  3: 'object already exists',
  4: 'object is suspended',
  5: 'object is not suspended',
  6: 'password mismatch',
  7: 'value out of range',
  8: 'invalid value',
  9: 'insufficient privileges',
  10: 'internal error',
  11: 'update failed',
  12: 'account limit reached',
  13: 'disk limit reached',
  14: 'bandwidth limit reached',
  15: 'feature disabled',
  16: 'parsing error',
  17: 'database error',
  19: 'connection failed',
  20: 'ftp error',
};

function parseHestiaBody(raw, cmd) {
  const text = String(raw == null ? '' : raw).trim();

  if (text === '' || text === '0') return { ok: true, data: null };

  if (/^\d+$/.test(text)) {
    const code = Number(text);
    return { ok: false, error: `${cmd} — ${EXIT_CODES[code] || 'command failed'} (exit ${code})` };
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, error: `${cmd} — malformed JSON response from host` };
    }
  }

  // Anything else is Hestia talking back in prose, which it only does on failure.
  return { ok: false, error: `${cmd} — ${text.split('\n')[0]}` };
}

// ── Adapter ───────────────────────────────────────────────────────
function createHestiaAdapter(config = {}) {
  const {
    host,
    port = 8083,
    accessKey,
    secretKey,
    apiHash,
    user,
    password,
    // Read-only until explicitly opened. Writes are mapped but their positional
    // signatures are unverified, so this defaults closed on purpose.
    allowWrites = false,
    rejectUnauthorized = true,
    timeoutMs = 20000,
    transport = defaultTransport,
    now = () => new Date(),
  } = config;

  if (!host) throw new Error('Hestia adapter requires a host');

  const auth = buildAuth({ accessKey, secretKey, apiHash, user, password });

  async function callCommand(cmd, args) {
    const body = new URLSearchParams({ ...auth, cmd });
    args.forEach((value, i) => {
      body.set(`arg${i + 1}`, value === undefined || value === null ? '' : String(value));
    });

    const res = await transport({
      hostname: host,
      port,
      path: '/api/',
      body: body.toString(),
      rejectUnauthorized,
      timeoutMs,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`Hestia ${cmd} — host returned HTTP ${res.statusCode}`);
    }

    const parsed = parseHestiaBody(res.body, cmd);
    if (!parsed.ok) throw new Error(`Hestia ${parsed.error}`);
    return parsed.data;
  }

  function resolveCommand(call) {
    const key = `${call.module}::${call.function}`;
    const mapping = COMMANDS[key];
    if (!mapping) throw new Error(`Hestia adapter has no mapping for ${key}`);
    if (mapping.write && !allowWrites) {
      throw new Error(
        `Hestia adapter is read-only: ${key} maps to ${mapping.cmd}, which mutates. ` +
          'Set HESTIA_ALLOW_WRITES=1 only after verifying that command signature against a live box.'
      );
    }
    return mapping;
  }

  async function runCall(call, accountContext, cache) {
    const mapping = resolveCommand(call);
    const args = mapping.args(call.params || {}, accountContext);
    const cacheKey = `${mapping.cmd}|${args.join('|')}`;

    // Fetch-stats fans out into a primary plus companion call, and both map to
    // v-list-user on Hestia because it returns disk and bandwidth together. Run
    // the command once rather than making the same request twice.
    if (!mapping.write && cache.has(cacheKey)) return cache.get(cacheKey);

    const data = await callCommand(mapping.cmd, args);
    if (!mapping.write) cache.set(cacheKey, data);
    return data;
  }

  async function execute(call, accountContext) {
    if (call.api && call.api !== 'cpanel-uapi') {
      throw new Error(`Hestia adapter cannot execute call api "${call.api}"`);
    }

    // The scope layer names the tenant `cpanelUser` for historical reasons. It is
    // just the panel account identifier, and on Hestia it is the Hestia username.
    const ctx = { ...accountContext, panelUser: accountContext.cpanelUser };

    const execution = {
      ok: true,
      adapter: 'hestia',
      executedAt: now().toISOString(),
      accountId: accountContext.accountId,
      cpanelUser: accountContext.cpanelUser,
      call,
    };
    const warnings = [];
    const cache = new Map();

    if (call.companionCalls && call.companionCalls.length) {
      const primary = await runCall(call, ctx, cache);
      const companions = [];
      for (const companion of call.companionCalls) {
        companions.push(await runCall(companion, ctx, cache));
      }
      execution.data = {
        [`${call.module.toLowerCase()}`]: primary,
        bandwidth: companions.length === 1 ? companions[0] : companions,
        visitors: { source: 'higashi' },
      };
    } else {
      execution.data = await runCall(call, ctx, cache);
    }

    // Same honesty rule as the cPanel adapter: Hestia's FTP command has no
    // source-IP concept, so the account is created but the allowlist is not
    // applied, and this says so rather than pretending otherwise.
    if (call.enforcement && call.enforcement.type === 'source-ip-allowlist') {
      execution.enforcement = {
        type: 'source-ip-allowlist',
        allowedIp: call.enforcement.allowedIp,
        applied: false,
        reason: 'Hestia has no source-IP allowlist for FTP users; enforce it at the firewall layer',
      };
      warnings.push(
        `FTP account created but source-IP allowlist (${call.enforcement.allowedIp}) was NOT enforced — wire a firewall backend before relying on it`
      );
    }

    const mapping = COMMANDS[`${call.module}::${call.function}`];
    if (mapping && !mapping.verified) {
      warnings.push(
        `${mapping.cmd} argument order is unverified against a live Hestia box — confirm before trusting this result`
      );
    }

    if (warnings.length) execution.warnings = warnings;
    return execution;
  }

  return { name: 'hestia', host, execute, callCommand, allowWrites };
}

// Hestia accepts an access key pair, a legacy hash, or admin credentials. Prefer
// the key pair; credentials are here only because older installs still use them.
function buildAuth({ accessKey, secretKey, apiHash, user, password }) {
  if (accessKey && secretKey) return { access_key: accessKey, secret_key: secretKey };
  if (apiHash) return { hash: apiHash };
  if (user && password) return { user, password };
  throw new Error('Hestia adapter requires an access key pair, an API hash, or user + password');
}

// Build from environment, or return null when unconfigured so the caller can fall
// back to the mock. Keeps server boot working with no panel attached.
function hestiaAdapterFromEnv(env = process.env) {
  const host = env.HESTIA_HOST;
  if (!host) return null;
  if (!env.HESTIA_ACCESS_KEY && !env.HESTIA_API_HASH && !env.HESTIA_USER) return null;

  return createHestiaAdapter({
    host,
    port: env.HESTIA_PORT ? parseInt(env.HESTIA_PORT, 10) : 8083,
    accessKey: env.HESTIA_ACCESS_KEY,
    secretKey: env.HESTIA_SECRET_KEY,
    apiHash: env.HESTIA_API_HASH,
    user: env.HESTIA_USER,
    password: env.HESTIA_PASSWORD,
    allowWrites: env.HESTIA_ALLOW_WRITES === '1',
    rejectUnauthorized: env.HESTIA_TLS_INSECURE === '1' ? false : true,
    timeoutMs: env.HESTIA_TIMEOUT_MS ? parseInt(env.HESTIA_TIMEOUT_MS, 10) : 20000,
  });
}

module.exports = {
  createHestiaAdapter,
  hestiaAdapterFromEnv,
  parseHestiaBody,
  hostLabel,
  COMMANDS,
};
