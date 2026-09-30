'use strict';

// Real cPanel UAPI / WHM API 1 adapter — the Phase 2 replacement for the mock.
//
// The provisioning service builds a scoped, approved `call` object (see actions.js)
// and hands it here for execution. This adapter turns that call into a live
// WHM-proxied cPanel request. It runs against a central WHM using a WHM API token,
// which lets JotPanel act on behalf of any owned cPanel account without holding each
// account's own password — the right model for a multi-tenant control-panel layer.
//
// Transport is injectable so the whole thing is unit-testable without a live host.
// When the environment is not configured (no host / no token) the server keeps the
// mock adapter instead, so local dev and the test suite never need a cPanel box.

const https = require('https');

// ── HTTP transport ────────────────────────────────────────────────
// Default transport speaks to WHM over TLS. cPanel/WHM boxes very often present a
// self-signed or hostname-mismatched cert on 2087, so TLS verification is
// configurable, defaulting to on.
function defaultTransport({ hostname, port, path, headers, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, port, path, method: 'GET', headers, rejectUnauthorized, timeout: timeoutMs },
      (r) => {
        let buf = '';
        r.on('data', (d) => (buf += d));
        r.on('end', () => resolve({ statusCode: r.statusCode, body: buf }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`cPanel request timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

// ── Response unwrapping ───────────────────────────────────────────
// A WHM-proxied UAPI response nests the real UAPI result (the object carrying
// `status` plus `data`/`errors`) one or more levels down under `result`/`data`/
// `cpanelresult`. Drill to the deepest such object — that is the action's own
// result, not the WHM envelope that wraps it.
function unwrapApiResult(json) {
  const found = [];
  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if ('status' in node && ('data' in node || 'errors' in node)) found.push(node);
    for (const key of ['result', 'data', 'cpanelresult']) {
      if (node[key] && typeof node[key] === 'object') visit(node[key], depth + 1);
    }
  };
  visit(json, 0);
  return found.length ? found[found.length - 1] : null;
}

function joinErrors(errors) {
  if (!errors) return '';
  if (Array.isArray(errors)) return errors.filter(Boolean).join('; ');
  return String(errors);
}

// ── Adapter ───────────────────────────────────────────────────────
function createCpanelAdapter(config = {}) {
  const {
    host,
    port = 2087,
    whmUser = 'root',
    apiToken,
    rejectUnauthorized = true,
    timeoutMs = 20000,
    transport = defaultTransport,
    now = () => new Date(),
  } = config;

  if (!host) throw new Error('cPanel adapter requires a host');
  if (!apiToken) throw new Error('cPanel adapter requires a WHM API token');

  const authHeader = `whm ${whmUser}:${apiToken}`;

  // Run one cPanel UAPI function proxied through WHM's json-api/cpanel endpoint.
  async function callUapi({ user, module, func, params = {} }) {
    const qs = new URLSearchParams({
      'cpanel_jsonapi_apiversion': '3',
      'cpanel_jsonapi_user': user,
      'cpanel_jsonapi_module': module,
      'cpanel_jsonapi_func': func,
    });
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const path = `/json-api/cpanel?${qs.toString()}`;

    const res = await transport({
      hostname: host, port, path,
      headers: { Authorization: authHeader },
      rejectUnauthorized, timeoutMs,
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`cPanel ${module}::${func} — host returned HTTP ${res.statusCode}`);
    }

    let json;
    try { json = JSON.parse(res.body); }
    catch { throw new Error(`cPanel ${module}::${func} — non-JSON response from host`); }

    // WHM-level failure (bad token, denied) surfaces on the outer metadata.
    if (json.metadata && Number(json.metadata.result) === 0) {
      throw new Error(`cPanel ${module}::${func} — WHM denied: ${json.metadata.reason || 'access denied'}`);
    }

    const result = unwrapApiResult(json);
    if (!result) throw new Error(`cPanel ${module}::${func} — unrecognized response shape`);
    if (Number(result.status) !== 1) {
      const msg = joinErrors(result.errors) || 'call failed';
      throw new Error(`cPanel ${module}::${func} — ${msg}`);
    }
    return result.data;
  }

  async function execute(call, accountContext) {
    if (call.api && call.api !== 'cpanel-uapi') {
      throw new Error(`cPanel adapter cannot execute call api "${call.api}"`);
    }

    const execution = {
      ok: true,
      adapter: 'cpanel-whm',
      executedAt: now().toISOString(),
      accountId: accountContext.accountId,
      cpanelUser: accountContext.cpanelUser,
      call,
    };
    const warnings = [];

    // Fetch-account-stats fans out: the primary StatsBar call plus any companion
    // calls (bandwidth). Visitors are never sourced from cPanel — higashi remains
    // the record for that, joined by the UI layer.
    if (call.companionCalls && call.companionCalls.length) {
      const primary = await callUapi(call);
      const companions = [];
      for (const companion of call.companionCalls) {
        companions.push(await callUapi(companion));
      }
      execution.data = {
        [`${call.module.toLowerCase()}`]: primary,
        bandwidth: companions.length === 1 ? companions[0] : companions,
        visitors: { source: 'higashi' },
      };
    } else {
      execution.data = await callUapi(call);
    }

    // The FTP source-IP allowlist is not something cPanel's Ftp::add_ftp expresses
    // on its own (see docs/phase2/API_MAPPING.md). The account is created here; the
    // allowlist must be applied by a firewall/host-policy backend. This adapter has
    // no such backend wired, so it reports the account as created but flags the
    // allowlist as NOT applied rather than pretending it was.
    if (call.enforcement && call.enforcement.type === 'source-ip-allowlist') {
      execution.enforcement = {
        type: 'source-ip-allowlist',
        allowedIp: call.enforcement.allowedIp,
        applied: false,
        reason: 'no source-ip-allowlist backend configured on this adapter; FTP user created without IP restriction',
      };
      warnings.push(
        `FTP account created but source-IP allowlist (${call.enforcement.allowedIp}) was NOT enforced — wire a firewall backend before relying on it`
      );
    }

    if (warnings.length) execution.warnings = warnings;
    return execution;
  }

  return { name: 'cpanel-whm', host, execute, callUapi };
}

// Build the adapter from environment, or return null when unconfigured so the
// caller can fall back to the mock. Keeps server boot working with no cPanel box.
function cpanelAdapterFromEnv(env = process.env) {
  const host = env.CPANEL_WHM_HOST;
  const apiToken = env.CPANEL_WHM_API_TOKEN;
  if (!host || !apiToken) return null;
  return createCpanelAdapter({
    host,
    port: env.CPANEL_WHM_PORT ? parseInt(env.CPANEL_WHM_PORT, 10) : 2087,
    whmUser: env.CPANEL_WHM_USER || 'root',
    apiToken,
    // Default to strict TLS; allow explicit opt-out for hosts with self-signed certs.
    rejectUnauthorized: env.CPANEL_TLS_INSECURE === '1' ? false : true,
    timeoutMs: env.CPANEL_TIMEOUT_MS ? parseInt(env.CPANEL_TIMEOUT_MS, 10) : 20000,
  });
}

module.exports = {
  createCpanelAdapter,
  cpanelAdapterFromEnv,
  unwrapApiResult,
};
