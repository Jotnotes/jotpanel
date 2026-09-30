'use strict';

// The web process never executes privileged programs. It can only ask the
// root-owned operations service to run a job from that service's fixed
// catalogue. The Unix socket is the trust boundary: no command, executable,
// argv array or shell text is accepted by this client or sent over the wire.

const http = require('http');

const DEFAULT_SOCKET = '/run/jotpanel-ops/ops.sock';
const RESPONSE_LIMIT = 300 * 1024 * 1024;

// How long the web process is willing to watch, job by job.
//
// It used to wait five minutes for everything, while the privileged side gives
// a package install thirty-five. So the watcher gave up while the worker was
// still working, and on a 1-core box on 2026-09-25 the record called a mail
// install that had succeeded a failure. A budget here that is shorter than the
// work is a promise to misreport it.
//
// These are ceilings for the watching, not permission to take that long: the
// job's own per-command limits still decide when the work itself is abandoned.
//
// They split two ways, and the split is the whole design.
//
// Work that writes a durable result — the privileged oneshots, `stack.install`
// and `packages.apply` — is deliberately given a SHORT budget. Waiting longer
// at the screen buys nothing and costs a browser sitting on a request until
// nginx cuts it off. When this expires the action is handed to the watcher,
// which reads the unit's own result file and settles the record by itself, so
// the person is told the truth ("still running") within two minutes instead of
// staring at a spinner for half an hour.
//
// Work that leaves nothing behind to read — backups, database moves, migration
// — has to be watched to its end, because if nobody is watching when it
// finishes then nobody will ever know how it finished. Those budgets are long,
// and nginx's proxy timeout is set to match them.
const JOB_BUDGETS_MS = [
  [/^stack\.install/, 2 * 60 * 1000],
  [/^packages\.apply/, 2 * 60 * 1000],
  [/^backup\./, 60 * 60 * 1000],
  [/^database\.(import|dump)/, 45 * 60 * 1000],
  [/^migrate\./, 60 * 60 * 1000],
];

function budgetFor(job, fallback) {
  for (const [pattern, ms] of JOB_BUDGETS_MS) if (pattern.test(job)) return ms;
  return fallback;
}

// Work that writes its own durable result, and whose short budget is therefore
// not a limit on the work but a decision to stop watching it.
const ONESHOT_BACKED = /^(stack\.install|packages\.apply)/;

// For those jobs the table wins over whatever a caller asked for.
//
// This is not tidiness. `hostBackend` passed `{ timeoutMs: 1200000 }` for
// `packages.apply`, the request read `options.timeoutMs || budgetFor(...)`, and
// the caller's twenty minutes silently replaced the two-minute hand-off — so
// the panel held the request open long past the point where nginx would cut it
// off, and the hand-off this file exists to perform could never happen. It was
// only found because a live run finished in under three minutes and the record
// did not say what it should have. Any future caller can make that same
// mistake, so the rule is enforced here rather than trusted there.
function requestTimeout(job, requested, fallback) {
  if (ONESHOT_BACKED.test(job)) return budgetFor(job, fallback);
  return requested || budgetFor(job, fallback);
}

function createPrivilegedClient({ socketPath = (process.env.JOTPANEL_OPS_SOCKET ?? process.env.ARCA_OPS_SOCKET) || DEFAULT_SOCKET, timeoutMs = 300000 } = {}) {
  function run(job, params = {}, options = {}) {
    if (!/^[a-z][a-z0-9.-]{1,80}$/.test(String(job || ''))) {
      return Promise.reject(new Error('A valid named operations job is required'));
    }
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return Promise.reject(new Error('Operations job parameters must be an object'));
    }
    const body = JSON.stringify({ job, params });
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath,
        path: '/v1/jobs',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: requestTimeout(job, options.timeoutMs, timeoutMs),
      }, res => {
        const chunks = [];
        let bytes = 0;
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > RESPONSE_LIMIT) {
            req.destroy(new Error('The privileged job response exceeded the safety limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
          catch { return reject(new Error('The privileged operations service returned an invalid response')); }
          if (res.statusCode < 200 || res.statusCode >= 300 || payload.ok !== true) {
            const error = new Error(payload.error || `Privileged job ${job} failed (${res.statusCode})`);
            error.job = job;
            error.code = payload.code || null;
            if (job === 'backup.create' && payload.backupRun) error.backupRun = payload.backupRun;
            return reject(error);
          }
          resolve(payload.result);
        });
      });
      // Marked, so the caller can tell "the machine refused" from "we stopped
      // watching". They are different facts and only one of them means the work
      // did not happen.
      req.on('timeout', () => {
        const expired = new Error(`Privileged job ${job} timed out`);
        expired.timedOut = true;
        expired.code = 'JOB_TIMEOUT';
        expired.job = job;
        req.destroy(expired);
      });
      req.on('error', error => {
        if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
          return reject(new Error(`the privileged operations service is not reachable at ${socketPath}`));
        }
        reject(error);
      });
      req.end(body);
    });
  }

  // Busy is not absent, and the difference is the whole answer.
  //
  // This asks the trivial job whether the privileged service is there, and the
  // backend turns a "no" into every server capability being missing: the panel
  // then tells the operator that mail, DNS, databases, certificates and the
  // rest are unavailable on this machine. Which is right when the service is
  // not running and badly wrong when it merely did not answer inside five
  // seconds, and a machine that has just finished installing itself is exactly
  // the machine that does not.
  //
  // Found by the distro matrix on 2026-08-29: Debian 12 installed cleanly and
  // then failed three function checks a minute later, and the box was fine.
  // Asked again four seconds after that it answered in two milliseconds.
  //
  // So a timeout is asked a second time, with a longer budget, before the
  // panel is allowed to say a capability is not there. Anything that is not a
  // timeout, a service that is not listening or refuses, is believed the first
  // time, because that is a real answer.
  async function probe() {
    const ask = async budget => {
      const result = await run('probe.service', {}, { timeoutMs: budget });
      return { ok: result?.ready === true, reason: result?.ready === true ? null : 'the privileged operations service did not report ready' };
    };
    try {
      return await ask(5000);
    } catch (error) {
      if (!/timed out/i.test(String(error.message))) return { ok: false, reason: error.message };
      try {
        return await ask(20000);
      } catch (second) {
        return {
          ok: false,
          reason: /timed out/i.test(String(second.message))
            ? `${second.message}. It was asked twice, over 25 seconds, so this is the service not answering rather than this machine being briefly busy.`
            : second.message,
        };
      }
    }
  }

  return { run, probe, socketPath };
}

module.exports = { budgetFor, requestTimeout, ONESHOT_BACKED, JOB_BUDGETS_MS, createPrivilegedClient, DEFAULT_SOCKET };
