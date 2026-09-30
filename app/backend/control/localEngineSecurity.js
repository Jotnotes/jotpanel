'use strict';

const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function createLocalEngineSecurity({
  actionStore,
  engineBase = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434/v1/chat/completions',
  helperPath = (process.env.JOTPANEL_SECURE_ENGINE_HELPER ?? process.env.ARCA_SECURE_ENGINE_HELPER) || '/usr/local/lib/arca/secure-local-engine',
  now = () => new Date(),
} = {}) {
  if (!actionStore) throw new Error('local engine security requires the action store');
  let cached = null;

  async function check({ force = false } = {}) {
    if (!force && cached && now().getTime() - cached.at < 60 * 1000) return cached.value;
    let url;
    try { url = new URL(engineBase); }
    catch {
      return remember({ safe: false, usable: false, status: 'invalid_configuration', reason: 'The local engine address is not a valid URL.' });
    }
    const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
    if (!loopback.has(url.hostname)) {
      return remember({
        safe: false,
        usable: false,
        status: 'exposed_configuration',
        reason: `The local assistant is configured through ${url.hostname}, not this machine's loopback address. JotPanel will not use it.`,
        fixAvailable: fs.existsSync(helperPath),
      });
    }

    // Linux is the installed-panel target. Read the kernel's listening socket
    // table rather than trusting Ollama's environment string, because a person
    // can change that setting after Arca starts.
    if (process.platform === 'linux') {
      try {
        const { stdout } = await execFileAsync('ss', ['-ltnH'], { timeout: 3000, maxBuffer: 1024 * 1024 });
        const port = Number(url.port || 80);
        const listeners = parseListeners(stdout, port);
        const exposed = listeners.find(item => item.exposed);
        if (exposed) {
          return remember({
            safe: false,
            usable: false,
            status: 'exposed_listener',
            reason: `Your local assistant engine is reachable by other devices through ${exposed.address}:${port}. JotPanel has stopped local mode until the safe setting is restored.`,
            listeners,
            fixAvailable: fs.existsSync(helperPath),
          });
        }
        return remember({
          safe: true,
          usable: true,
          status: 'loopback_only',
          reason: listeners.length ? 'The local assistant engine is listening only on this machine.' : 'No externally reachable local-engine listener was found.',
          listeners,
          fixAvailable: fs.existsSync(helperPath),
        });
      } catch (error) {
        return remember({
          safe: false,
          usable: false,
          status: 'unverified',
          reason: `JotPanel could not verify the engine listener (${error.message}), so local mode is stopped rather than assumed safe.`,
          fixAvailable: fs.existsSync(helperPath),
        });
      }
    }

    // On a developer desktop the configured loopback URL is the available
    // boundary; the production installer always adds the firewall layer too.
    return remember({ safe: true, usable: true, status: 'loopback_configured', reason: 'The local assistant address is restricted to this machine.', fixAvailable: false });
  }

  function remember(value) {
    const result = { ...value, checkedAt: now().toISOString(), engine: engineBase };
    cached = { at: now().getTime(), value: result };
    return result;
  }

  function proposeFix(userId) {
    return actionStore.enqueue({
      accountId: userId,
      kind: 'local_engine.secure',
      actionKey: 'secure_local_engine',
      label: 'Restore the safe local assistant setting',
      summary: 'Bind the engine to this machine, reinforce the firewall rule and verify the listener again.',
      riskLevel: 'elevated',
      requiresApproval: true,
      call: { api: 'arca-native', module: 'LocalEngine', function: 'secure', params: {} },
    });
  }

  async function executeFix(actionId, userId) {
    const action = actionStore.get(actionId);
    if (!action || action.accountId !== userId || action.kind !== 'local_engine.secure') throw new Error('Approved engine-security action not found');
    if (action.status !== 'approved') throw new Error(`Action ${actionId} must be approved before execution`);
    try {
      if (!fs.existsSync(helperPath)) throw new Error('The safe-setting helper is not installed on this machine');
      const command = typeof process.getuid === 'function' && process.getuid() !== 0 ? '/usr/bin/sudo' : helperPath;
      const args = command === helperPath ? [] : [helperPath];
      await execFileAsync(command, args, { timeout: 30000, maxBuffer: 1024 * 1024 });
      cached = null;
      const verified = await check({ force: true });
      if (!verified.safe) throw Object.assign(new Error(`The fix ran, but verification still says: ${verified.reason}`), { result: verified });
      return actionStore.markExecuted(action.id, { ok: true, verified: true, security: verified });
    } catch (error) {
      actionStore.markFailed(action.id, error, error.result || null);
      throw error;
    }
  }

  function start(onFinding) {
    const run = async () => {
      const state = await check({ force: true });
      if (!state.safe && typeof onFinding === 'function') onFinding(state);
    };
    run().catch(() => {});
    const timer = setInterval(() => run().catch(() => {}), 5 * 60 * 1000);
    timer.unref();
    return () => clearInterval(timer);
  }

  return { check, proposeFix, executeFix, start, engineBase, helperPath };
}

function parseListeners(output, port) {
  const rows = [];
  for (const line of String(output || '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[3];
    const match = local.match(/^(.*):(\d+)$/);
    if (!match || Number(match[2]) !== port) continue;
    const address = match[1].replace(/^\[|\]$/g, '');
    const exposed = ['0.0.0.0', '::', '*'].includes(address);
    rows.push({ address, port, exposed });
  }
  return rows;
}

module.exports = { createLocalEngineSecurity, parseListeners };
