'use strict';

// Puts the backends in order and answers one question honestly: can this server
// actually do this, and if not, why not.
//
// The order matters. Arca's native stack owns the privileged server changes;
// the host backend fills in read-only machine detail. Whichever backend claims
// a capability first owns it.
//
// The reason strings are not decoration. They are what the panel prints where
// a button would otherwise be, so they name the missing tool rather than saying
// "unavailable".

const DEFAULT_TTL_MS = 60 * 1000;

function createOpsEngine({ backends = [], ttlMs = DEFAULT_TTL_MS, now = () => new Date() } = {}) {
  let cache = null;
  let inflight = null;

  // Nobody waits for a re-probe of the machine.
  //
  // The cache holds for a minute, and until 2026-08-28 the first request after
  // it expired paid for the whole sweep: on the live box that is about ten
  // seconds of apt, du, systemctl and stack probes. Measured rather than
  // guessed, in docs/CONCURRENCY_VERIFICATION.md: the first `logs` reading took
  // 10,653 ms and the next four took 109. So once a minute, somebody's click
  // cost ten seconds, and which click it was is arbitrary.
  //
  // An expired answer is served immediately now and the refresh happens behind
  // it. What that costs is that a capability which disappeared can be reported
  // for one more cycle, and there is already a way to say "ask the machine
  // again, properly": `force`, which installs use and which still waits.
  async function resolve(force = false) {
    if (!force && cache && Date.now() - cache.at < ttlMs) return cache.value;
    if (!force && cache) {
      if (!inflight) rebuild(false).catch(() => { /* the next read tries again */ });
      return cache.value;
    }
    if (!force && inflight) return inflight;
    return rebuild(force);
  }

  function rebuild(force) {
    inflight = (async () => {
      const available = new Map();
      const missing = new Map();
      const states = [];
      for (const backend of backends) {
        let report;
        try {
          // The force flag has to reach the backend, not just this cache. A
          // backend that memoises its own probe would otherwise keep
          // reporting a capability whose privilege has since gone away,
          // which draws a button that cannot work.
          report = await backend.capabilities(force);
        } catch (error) {
          states.push({ backend: backend.name, ok: false, error: error.message });
          continue;
        }
        states.push({ backend: backend.name, ok: true, state: report.state || null });
        for (const [id, capability] of report.capabilities) {
          if (!available.has(id)) available.set(id, capability);
        }
        for (const [id, reason] of report.missing) {
          const previous = missing.get(id);
          missing.set(id, previous ? `${previous} · ${backend.name}: ${reason}` : `${backend.name}: ${reason}`);
        }
      }
      // A capability one backend refuses and another provides is not missing.
      for (const id of available.keys()) missing.delete(id);
      const value = { available, missing, backends: states, checkedAt: now().toISOString() };
      cache = { at: Date.now(), value };
      inflight = null;
      return value;
    })();
    // A failed rebuild must not leave the promise wedged in place, or every
    // later read waits on something that already gave up.
    inflight.catch(() => { inflight = null; });
    return inflight;
  }

  async function capabilities(force = false) {
    return resolve(force);
  }

  async function has(id) {
    return (await resolve()).available.has(id);
  }

  // The reason a capability is not offered. Never invents one: if no backend
  // said anything about it, that is stated plainly rather than dressed up.
  async function reasonFor(id) {
    const resolved = await resolve();
    if (resolved.available.has(id)) return null;
    return resolved.missing.get(id)
      || `Nothing attached to this panel provides ${id}. Attach a panel engine, or install the tool it needs.`;
  }

  async function run(id, params = {}, ctx = {}) {
    const resolved = await resolve();
    const capability = resolved.available.get(id);
    if (!capability) {
      const error = new Error(await reasonFor(id));
      error.unavailable = id;
      throw error;
    }
    const started = Date.now();
    const data = await capability.run(params, ctx);
    return { ok: true, capability: id, backend: capability.backend, kind: capability.kind, took_ms: Date.now() - started, data };
  }

  return { capabilities, has, reasonFor, run, refresh: () => resolve(true), backends };
}

module.exports = { createOpsEngine };
