'use strict';

// Root-side job catalogue. This file is intentionally boring: every exported
// operation has a fixed name, validates a small parameter object, and invokes
// executables with execFile. There is no generic command job and no shell.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { siteAccessLogPaths } = require('./hostBackend');
const net = require('net');
const http = require('http');
const tls = require('tls');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { inspectImapSource } = require('./imapSource');
// Navigator-only, and absent from a JotPanel bundle. Registered below only on
// a pool host, so a build without it is a build that could never have called
// it; required this way so the ops daemon starts on one.
let createMachineJobs = null;
try { ({ createMachineJobs } = require('./machineJobs')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND' || error.requireStack[0] !== __filename) throw error; }
const { hashPassword, renderHtpasswd, parseHtpasswd, renderAuthLocation, addOrReplaceUser, removeUser } = require('./siteProtect');
const {
  FAILURE_CODES,
  activeFault,
  namesDigest,
  tableNamesFromSql,
  truncateSqlToTableCount,
  verifyArtifactFacts,
  verifyDatabaseObjectSet,
  verifyManifestArtifactSet,
} = require('./backupWorkerTruth');

const STATE_DIR = (process.env.JOTPANEL_OPS_STATE_DIR ?? process.env.ARCA_OPS_STATE_DIR) || '/var/lib/jotpanel-ops';
const SITE_STATE = path.join(STATE_DIR, 'sites.json');
const MAIL_STATE = path.join(STATE_DIR, 'mail.json');
const SITE_ROOT = (process.env.JOTPANEL_OPS_SITE_ROOT ?? process.env.ARCA_OPS_SITE_ROOT) || '/srv/jotpanel-sites';
const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';
const MAILBOX_MAP = '/etc/postfix/jotpanel-mailboxes';
const DOMAIN_MAP = '/etc/postfix/jotpanel-domains';
const ALIAS_MAP = '/etc/postfix/jotpanel-aliases';
// Checked before delivery for every recipient, not just external senders, so
// mail to a suspended account is rejected with a clear reason rather than
// silently accepted and delivered. The virtual maps above are left alone —
// unsuspending needs no restore step, the domain was never actually removed
// from them, only rejected ahead of them.
const SUSPENDED_MAP = '/etc/postfix/jotpanel-suspended';
const DOVECOT_USERS = '/etc/dovecot/jotpanel-users';
const DOVECOT_CONFIG = '/etc/dovecot/conf.d/99-jotpanel-panel.conf';
const DB_PREFIX = cleanPrefix((process.env.JOTPANEL_OPS_DB_PREFIX ?? process.env.ARCA_OPS_DB_PREFIX) || 'jotpanel');
const OUTPUT_LIMIT = 300 * 1024 * 1024;
// Whether this machine is a pool host. Read from the environment the installer
// writes, never from a request: a job catalogue that could be widened by a
// caller is not a closed catalogue.
const POOL_HOST = String(process.env.JOTPANEL_FLEET_ROLE || '').trim().toLowerCase() === 'pool-host';

function runFile(file, args = [], options = {}) {
  return new Promise(resolve => {
    let child;
    const done = (error, stdout, stderr) => resolve({
      ok: !error,
      code: error && Number.isInteger(error.code) ? error.code : error ? null : 0,
      missing: !!(error && error.code === 'ENOENT'),
      timedOut: !!(error && error.killed),
      stdout: String(stdout == null ? '' : stdout),
      stderr: String(stderr == null ? '' : stderr),
      error: error ? firstLine(error.message) : null,
    });
    try {
      child = execFile(file, args, {
        timeout: options.timeoutMs || 120000,
        maxBuffer: options.maxBuffer || OUTPUT_LIMIT,
        encoding: 'utf8',
        env: options.env || process.env,
        cwd: options.cwd,
      }, done);
    } catch (error) { return done(error, '', ''); }
    if (options.input != null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(options.input));
    }
    return undefined;
  });
}

function firstLine(value) {
  // The first line that says something. Command output is full of rules and
  // separators, and "- - - - - - - -" is not a summary of what happened, which
  // is what a successful renewal reported until this skipped them.
  const lines = String(value || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines.find(line => /[A-Za-z0-9]/.test(line)) || lines[0] || 'The job failed';
}

// What went wrong, in the words of the thing that refused, and not merely the
// first line it happened to print.
//
// This used to be the first non-empty line of stderr. certbot opens every run,
// successful or not, with "Saving debug log to /var/log/letsencrypt/
// letsencrypt.log", so that sentence was what an operator was shown for every
// certificate failure there has ever been, whatever had actually happened. The
// real reason was in the output the whole time, three lines further down.
//
// So the opening boilerplate is skipped, a line that reads like a reason is
// preferred, and the first line is still what it falls back to when nothing
// else stands out. Nothing is invented: every candidate is a line the command
// itself printed.
const OUTPUT_NOISE = /^(saving debug log|please read the terms|account registered|requesting a certificate|simulating renewal|renewing an existing certificate|certbot failed to authenticate|hook|[-=*_\s]+$)/i;
const OUTPUT_REASON = /\b(error|errors|failed|failure|refused|denied|cannot|could not|couldn't|not found|no such|invalid|unable|permission|timed out|conflict|already)\b/i;

function failure(result, fallback) {
  const printed = `${String(result?.stderr || '')}\n${String(result?.stdout || '')}`
    .split('\n').map(line => line.trim()).filter(Boolean).filter(line => !OUTPUT_NOISE.test(line));
  const reason = printed.find(line => OUTPUT_REASON.test(line));
  return reason || printed[0] || firstLine(result?.error || fallback);
}

async function must(file, args, options, fallback) {
  const result = await runFile(file, args, options);
  if (!result.ok) throw Object.assign(new Error(failure(result, fallback || `${path.basename(file)} failed`)), { code: result.code });
  return result;
}

function command(candidates) {
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return candidates[candidates.length - 1];
}

function cleanPrefix(value) {
  const prefix = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new Error('The database prefix is invalid');
  return prefix;
}

function domain(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(clean) || clean.includes('..')) throw new Error(`${value} is not a domain name`);
  return clean;
}

function localPart(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(clean)) throw new Error(`${value} is not a mailbox name`);
  return clean;
}

function email(value) {
  const clean = String(value || '').trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1) throw new Error(`${value} is not an email address`);
  localPart(clean.slice(0, at)); domain(clean.slice(at + 1));
  return clean;
}

function dbName(value, kind = 'database') {
  const raw = String(value || '').trim().toLowerCase();
  const clean = raw.startsWith(`${DB_PREFIX}_`) ? raw : `${DB_PREFIX}_${raw}`;
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(clean) || !clean.startsWith(`${DB_PREFIX}_`)) throw new Error(`That ${kind} is outside the ${DB_PREFIX}_ scope`);
  return clean;
}

function dbPassword(value) {
  const clean = String(value || '');
  if (!/^[A-Za-z0-9!#%*+\-=?@^_~.]{10,128}$/.test(clean)) throw new Error('The database password is not valid');
  return clean;
}

function mailboxPassword(value) {
  const clean = String(value || '');
  if (clean.length < 10 || clean.length > 200 || /[\0\r\n]/.test(clean)) throw new Error('A mailbox password must be 10–200 characters on one line');
  return clean;
}

function unit(value) {
  const clean = String(value || '').trim();
  if (!/^[A-Za-z0-9@._:\\-]{1,128}$/.test(clean)) throw new Error('That is not a valid service name');
  return /\.(service|socket|timer|target|mount|path)$/.test(clean) ? clean : `${clean}.service`;
}

function ensureDir(target, mode = 0o755) {
  fs.mkdirSync(target, { recursive: true, mode });
  try { fs.chmodSync(target, mode); } catch {}
}

function readState(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

function writeState(file, value, mode = 0o600) {
  ensureDir(path.dirname(file), 0o750);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temp, file);
  fs.chmodSync(file, mode);
}

async function serviceState(name) {
  const result = await runFile('/usr/bin/systemctl', ['is-active', name], { timeoutMs: 15000 });
  return result.stdout.trim() || 'unknown';
}

// A unit that is on its way somewhere has not answered the question yet.
// `is-active` reports these while systemd is still working, and none of them
// means the service is broken.
const SETTLING_UNIT_STATES = new Set(['reloading', 'activating', 'deactivating']);

// `reload-or-restart` returns once systemd has taken the job, not once the unit
// has finished taking it. Asking `is-active` in the next breath therefore
// catches a healthy service mid-reload and calls it a failure.
//
// Found on a 1-core box on 2026-09-25: the mail stack installed, Postfix and
// Dovecot came up and worked, and the record said the install had failed
// because Dovecot happened to be `reloading` at the instant it was asked. A red
// mark over a working thing, which is as much a lie as a false tick.
//
// So a settling state is waited out before any verdict is given. Anything that
// is still not active when it has stopped moving is a real answer and is
// believed. This is the same wait, and the same reasoning, as the nginx and
// PHP-FPM checks further down; this path simply never got it.
async function settleServiceState(name, { read = serviceState, timeoutMs = 60000, everyMs = 500 } = {}) {
  let state = await read(name);
  if (!SETTLING_UNIT_STATES.has(state)) return state;
  await waitUntilAsync(async () => {
    state = await read(name);
    return !SETTLING_UNIT_STATES.has(state);
  }, timeoutMs, everyMs);
  return state;
}

async function reloadService(name) {
  await must('/usr/bin/systemctl', ['reload-or-restart', name], { timeoutMs: 90000 }, `${name} would not reload`);
  const state = await settleServiceState(name);
  if (state !== 'active') throw new Error(`${name} is ${state} after reload`);
  return state;
}

// ── Service, process, firewall and packages ───────────────────────
async function serviceControl(params) {
  const name = unit(params.unit);
  const verb = String(params.verb || '');
  if (!['start', 'stop', 'restart', 'reload'].includes(verb)) throw new Error('Unsupported service action');
  await must('/usr/bin/systemctl', [verb, name], { timeoutMs: 90000 }, `systemd refused to ${verb} ${name}`);
  return { unit: name, verb, accepted: true };
}

async function processKill(params) {
  const pid = Number(params.pid);
  const signal = String(params.signal || 'TERM');
  if (!Number.isInteger(pid) || pid < 2) throw new Error('A process id above 1 is required');
  if (!['TERM', 'KILL', 'HUP', 'INT'].includes(signal)) throw new Error('Unsupported process signal');
  await must('/usr/bin/kill', [`-${signal}`, String(pid)], { timeoutMs: 10000 }, `Signal ${signal} was refused`);
  return { pid, signal, accepted: true };
}

function ufwBin() { return command(['/usr/sbin/ufw', '/usr/bin/ufw', 'ufw']); }

async function firewallList() {
  const result = await must(ufwBin(), ['status', 'numbered'], { timeoutMs: 20000 }, 'ufw status could not be read with panel privilege');
  const rules = result.stdout.split('\n').map(line => {
    const match = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)?\s*(.*)$/i);
    return match ? { index: Number(match[1]), target: match[2].trim(), action: match[3].toUpperCase(), direction: (match[4] || 'IN').toUpperCase(), from: match[5].trim() } : null;
  }).filter(Boolean);
  return { active: /Status:\s*active/i.test(result.stdout), rules, engine: 'ufw' };
}

// Would this change take away the way in? Decided from the machine's own rule
// list rather than from anything the caller said about itself, because a
// safety check built on a header is a safety check somebody can talk their way
// past. A dangerous change is refused unless a guard is armed, and the guard
// is what makes it survivable, so the answer to the refusal is one click
// rather than a shrug.
function firewallLockoutRisk(params, rules) {
  const panelPort = String(parseInt((process.env.JOTPANEL_PANEL_PORT ?? process.env.ARCA_PANEL_PORT) || '7443', 10));
  const criticalPorts = new Set(['22', panelPort, '443', '80']);
  const verb = String(params.verb || '');
  if (verb === 'delete') {
    const rule = rules.find(r => r.index === Number(params.index));
    if (!rule) return null;
    const target = String(rule.target || '');
    if (/openssh|ssh/i.test(target)) return 'that rule is what allows SSH';
    if (/nginx/i.test(target)) return 'that rule is what allows the web server';
    const port = (target.match(/^(\d+)/) || [])[1];
    if (port && criticalPorts.has(port)) return `port ${port} is one of the ways back in`;
    return null;
  }
  if (verb !== 'deny') return null;
  const address = String(params.address || '').trim();
  const port = params.port == null || params.port === '' ? null : String(params.port);
  if (!address && (port === null || criticalPorts.has(port))) {
    return port ? `it blocks port ${port} for everybody` : 'it blocks everybody';
  }
  if (/^0\.0\.0\.0(\/0)?$|^::(\/0)?$/.test(address)) return 'it blocks every address there is';
  return null;
}

function firewallGuardArmed() {
  // Synchronous on purpose: this decides whether a lockout-risky change may
  // run, so it asks systemd directly rather than trusting a folder that a
  // fired guard might have left behind.
  try {
    if (!fs.existsSync(FW_SNAPSHOT_DIR)) return false;
    for (const id of fs.readdirSync(FW_SNAPSHOT_DIR)) {
      if (!/^[0-9a-f]{12}$/.test(id)) continue;
      for (const unit of [guardUnit(id), legacyGuardUnit(id)]) {
        try {
          const out = require('child_process').execFileSync('/usr/bin/systemctl',
            ['is-active', `${unit}.timer`], { timeout: 10000, encoding: 'utf8' });
          if (/^\s*(activating|active|waiting)/i.test(out)) return true;
        } catch { /* is-active exits non-zero when it is not active */ }
      }
    }
    return false;
  } catch { return false; }
}

async function firewallRule(params) {
  const verb = String(params.verb || '');
  let args;
  if (verb === 'delete') {
    const index = Number(params.index);
    if (!Number.isInteger(index) || index < 1) throw new Error('A firewall rule number is required');
    args = ['--force', 'delete', String(index)];
  } else if (verb === 'allow' || verb === 'deny') {
    const protocol = String(params.protocol || 'tcp').toLowerCase();
    if (!['tcp', 'udp'].includes(protocol)) throw new Error('Protocol must be tcp or udp');
    const port = params.port == null || params.port === '' ? null : Number(params.port);
    if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('A port between 1 and 65535 is required');
    const address = String(params.address || '').trim();
    if (address && !/^[0-9a-fA-F:.\/]{3,49}$/.test(address)) throw new Error('That address or range is not valid');
    if (address) {
      args = [verb, 'from', address];
      if (port) args.push('to', 'any', 'port', String(port), 'proto', protocol);
    } else {
      if (!port) throw new Error('A port or source address is required');
      args = [verb, `${port}/${protocol}`];
    }
  } else throw new Error('Unsupported firewall action');
  const before = await firewallList();
  const risk = firewallLockoutRisk(params, before.rules);
  if (risk && !firewallGuardArmed()) {
    throw new Error(`This would lock you out of this machine, because ${risk}. Guard the firewall first and the change will undo itself if you lose your connection.`);
  }
  await must(ufwBin(), args, { timeoutMs: 30000 }, 'ufw rejected the rule');
  const after = await firewallList();
  return { verb, previous: before.rules.length, rules: after.rules.length, state: after, guarded: !!risk, verified: true };
}

// ── The firewall guard ────────────────────────────────────────────
//
// The thing people are actually afraid of with a server firewall is not
// getting a rule wrong, it is getting a rule wrong and losing the way back in.
// CSF answered that with a testing mode and a cron job that undid everything
// on a timer. This is the same idea done properly: before a risky change the
// rule files are copied aside and systemd is asked to put them back in a few
// minutes, and confirming that you are still connected cancels it. Nobody has
// to remember to disarm anything, because the safe outcome is the default one.
const FW_SNAPSHOT_DIR = path.join(STATE_DIR, 'firewall-snapshots');
const FW_REVERT_SCRIPT = path.join(__dirname, 'fwRevert.js');
const UFW_RULE_FILES = ['user.rules', 'user6.rules'];

function guardUnit(id) { return `jotpanel-fw-revert-${id}`; }
function legacyGuardUnit(id) { return `arca-fw-revert-${id}`; }

// ONE GUARD AT A TIME. DO NOT RELAX THIS.
//
// Allowing several guards looks like an improvement and is a data-loss bug.
// Each guard holds a snapshot of the rules taken at the moment it was armed.
// Whichever timer fires first restores ITS picture, which is older than the
// other guard's, so it silently undoes a change the operator already confirmed
// under the second one. That is not theoretical: on 2026-08-20 a confirmed
// rule vanished from the live box for exactly this reason, and the operator
// had no way to tell why.
//
// If concurrent guards are ever genuinely needed, the snapshot model has to go
// first. A guard would have to record the specific change it covers and undo
// only that, rather than restoring a whole rule file. Until that exists, one.
function firewallGuardConflict(guards) {
  return (guards || []).find(g => g.armed) || null;
}

async function firewallGuardArm(params) {
  const existing = await firewallGuardStatus();
  const live = firewallGuardConflict(existing.guards);
  if (live) {
    throw new Error(`The firewall is already guarded until ${live.expiresAt}. Keep or drop that change first, because two guards would undo each other.`);
  }
  const minutes = Math.min(Math.max(parseInt(params.minutes, 10) || 5, 1), 60);
  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(FW_SNAPSHOT_DIR, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let saved = 0;
  for (const name of UFW_RULE_FILES) {
    const from = path.join('/etc/ufw', name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, name));
    saved++;
  }
  if (!saved) throw new Error('No ufw rule files were found to copy aside, so a guarded change cannot be undone here');

  await must('/usr/bin/systemd-run', [
    '--unit', guardUnit(id),
    '--on-active', String(minutes * 60),
    '--description', 'JotPanel firewall guard: restore the rules if the change was never confirmed',
    process.execPath, FW_REVERT_SCRIPT, id,
  ], { timeoutMs: 20000 }, 'systemd would not arm the revert timer');

  // Rule 2: the guard is only real if the timer is actually there.
  const check = await runFile('/usr/bin/systemctl', ['is-active', `${guardUnit(id)}.timer`], { timeoutMs: 10000 });
  const armed = /activating|active|waiting/i.test(check.stdout);
  if (!armed) throw new Error('The revert timer did not come up, so the change was not guarded');
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  fs.writeFileSync(path.join(dir, 'guard.json'), JSON.stringify({ id, minutes, expiresAt, armedAt: new Date().toISOString() }));
  return { guardId: id, minutes, expiresAt, files: saved, verified: true };
}

async function firewallGuardConfirm(params) {
  const id = String(params.guardId || '');
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error('A guard id is required');
  const dir = path.join(FW_SNAPSHOT_DIR, id);
  if (!fs.existsSync(dir)) throw new Error('That guard is not armed here');
  await runFile('/usr/bin/systemctl', ['stop', `${guardUnit(id)}.timer`], { timeoutMs: 15000 });
  await runFile('/usr/bin/systemctl', ['stop', `${guardUnit(id)}.service`], { timeoutMs: 15000 });
  await runFile('/usr/bin/systemctl', ['stop', `${legacyGuardUnit(id)}.timer`], { timeoutMs: 15000 });
  await runFile('/usr/bin/systemctl', ['stop', `${legacyGuardUnit(id)}.service`], { timeoutMs: 15000 });
  const check = await runFile('/usr/bin/systemctl', ['is-active', `${guardUnit(id)}.timer`], { timeoutMs: 10000 });
  if (/^\s*active/i.test(check.stdout)) throw new Error('The revert timer is still armed, so the change is not confirmed yet');
  fs.rmSync(dir, { recursive: true, force: true });
  return { guardId: id, confirmed: true, verified: true };
}

async function firewallGuardStatus() {
  if (!fs.existsSync(FW_SNAPSHOT_DIR)) return { guards: [], verified: true };
  const guards = [];
  for (const id of fs.readdirSync(FW_SNAPSHOT_DIR)) {
    if (!/^[0-9a-f]{12}$/.test(id)) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(FW_SNAPSHOT_DIR, id, 'guard.json'), 'utf8')); } catch {}
    let check = await runFile('/usr/bin/systemctl', ['is-active', `${guardUnit(id)}.timer`], { timeoutMs: 10000 });
    if (!/^\s*(activating|active|waiting)/i.test(check.stdout)) {
      check = await runFile('/usr/bin/systemctl', ['is-active', `${legacyGuardUnit(id)}.timer`], { timeoutMs: 10000 });
    }
    // A folder is not a guard. The timer is, so an entry whose timer has gone
    // reads as spent rather than as protection that is no longer there.
    guards.push({ ...meta, id, armed: /^\s*(activating|active|waiting)/i.test(check.stdout) });
  }
  return { guards, verified: true };
}

// The machine's own automatic updater holds the dpkg lock for the first few
// minutes after a box is built, and apt fails instantly rather than waiting.
// A panel that answers "Could not get lock" to the operator's first click has a
// button that does not work, so every apt run here waits its turn instead.
const APT_WAIT = ['-o', 'DPkg::Lock::Timeout=900'];

// ── Authorised SSH keys ───────────────────────────────────────────
//
// This lives in the privileged unit, and it did not always. It used to run in
// the panel process, which appends to `os.homedir()/.ssh/authorized_keys`, and
// the panel process runs as the `jotpanel` service account whose shell is
// `/usr/sbin/nologin`. So a key added through the panel landed in a file sshd
// consults for an account that can never sign in, the operation read the file
// it had just written, agreed with itself, and reported success. The card says
// "whoever holds the matching private key can sign in to this server over SSH",
// and nobody could.
//
// Two rules come out of that, and they are why this is not simply a corrected
// path. Authorising a key is administrative access to the whole machine, so it
// belongs behind the same privileged boundary as everything else that can hand
// somebody the box. And the file is refused unless its account can actually
// log in, because writing a key somewhere harmless is worse than refusing: it
// looks like it worked.
const SSH_KEYS_FILE = (process.env.JOTPANEL_OPS_SSH_AUTHORIZED_KEYS ?? process.env.ARCA_OPS_SSH_AUTHORIZED_KEYS) || '/root/.ssh/authorized_keys';
const SSH_KEY_LINE = /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+[A-Za-z0-9+/=]{16,}(\s+\S.*)?$/;

// Whose file this is, and whether that account can use it. Derived from the
// path against /etc/passwd rather than assumed, so an override still gets
// checked.
function sshKeyAccount() {
  const target = path.resolve(SSH_KEYS_FILE);
  const home = path.dirname(path.dirname(target));
  const row = fs.readFileSync('/etc/passwd', 'utf8').split('\n')
    .map(line => line.split(':'))
    .find(parts => parts.length > 5 && path.resolve(parts[5] || '') === home);
  if (!row) throw new Error(`${SSH_KEYS_FILE} does not belong to any account on this machine, so a key written there would authorise nobody`);
  const [user, , uid, gid, , , shell] = row;
  if (/\/(nologin|false)$/.test(String(shell || ''))) {
    throw new Error(`${user} cannot sign in to this machine (its shell is ${shell}), so a key written to ${SSH_KEYS_FILE} would authorise nobody`);
  }
  return { user, uid: Number(uid), gid: Number(gid), shell, path: target };
}

function sshKeyList() {
  const account = sshKeyAccount();
  if (!fs.existsSync(account.path)) return { path: account.path, account: account.user, keys: [], exists: false };
  const keys = fs.readFileSync(account.path, 'utf8').split('\n').map((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const parts = trimmed.split(/\s+/);
    const typeAt = parts.findIndex(part => /^(ssh-|ecdsa-|sk-)/.test(part));
    if (typeAt === -1) return null;
    const body = parts[typeAt + 1] || '';
    return {
      line: index + 1,
      type: parts[typeAt],
      comment: parts.slice(typeAt + 2).join(' ') || '(no label)',
      fingerprint: body ? `SHA256:${crypto.createHash('sha256').update(Buffer.from(body, 'base64')).digest('base64').replace(/=+$/, '')}` : null,
    };
  }).filter(Boolean);
  return { path: account.path, account: account.user, keys, exists: true };
}

async function sshKeyAdd(params) {
  const account = sshKeyAccount();
  const value = String(params.key || '').trim().replace(/\s+/g, ' ');
  if (!SSH_KEY_LINE.test(value)) throw new Error('That does not look like a public key line (it should start with ssh-ed25519, ssh-rsa or ecdsa-…)');
  const body = value.split(' ')[1];
  const before = fs.existsSync(account.path) ? fs.readFileSync(account.path, 'utf8') : '';
  if (before.includes(body)) throw new Error('That key is already authorised');
  ensureDir(path.dirname(account.path), 0o700);
  fs.chownSync(path.dirname(account.path), account.uid, account.gid);
  fs.writeFileSync(account.path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${value}\n`, { mode: 0o600 });
  fs.chownSync(account.path, account.uid, account.gid);
  fs.chmodSync(account.path, 0o600);
  const after = sshKeyList();
  if (!fs.readFileSync(account.path, 'utf8').includes(body)) throw new Error('The key was not present after the write');
  return { added: after.keys[after.keys.length - 1], account: account.user, path: account.path, total: after.keys.length, verified: true };
}

async function sshKeyRemove(params) {
  const account = sshKeyAccount();
  const number = Number(params.line);
  if (!Number.isInteger(number) || number < 1) throw new Error('A key line number is required');
  if (!fs.existsSync(account.path)) throw new Error('There is no authorized_keys file on this server');
  const lines = fs.readFileSync(account.path, 'utf8').split('\n');
  if (number > lines.length) throw new Error(`There is no key on line ${number}`);
  const removed = lines[number - 1];
  if (!removed.trim()) throw new Error(`Line ${number} is blank, not a key`);
  // Taken aside first. Revoking the wrong line is how somebody loses the shell
  // on their own machine, and a copy costs nothing.
  const backup = `${account.path}.arca-${new Date().toISOString().replace(/[:.]/g, '')}`;
  fs.copyFileSync(account.path, backup);
  fs.chmodSync(backup, 0o600);
  lines.splice(number - 1, 1);
  fs.writeFileSync(account.path, lines.join('\n'), { mode: 0o600 });
  fs.chownSync(account.path, account.uid, account.gid);
  const body = removed.trim().split(/\s+/)[1] || '\0';
  if (fs.readFileSync(account.path, 'utf8').includes(body)) throw new Error('The key is still present after the removal');
  return { removed_line: number, account: account.user, remaining: sshKeyList().keys.length, backup, verified: true };
}

const STACKS = {
  database: ['mariadb-server', 'mariadb-client'],
  // php-pgsql goes in with the server. Without it Adminer and every PHP
  // application on the machine can see a PostgreSQL server and not connect to
  // it, which looks like the panel installed something broken.
  postgres: ['postgresql', 'postgresql-client', 'php-pgsql'],
  web: ['nginx'],
  certificates: ['certbot'],
  webmail: ['roundcube', 'roundcube-sqlite3', 'php-fpm', 'php-sqlite3'],
  fail2ban: ['fail2ban'],
  // Echo's ears and voice. The heavy part is not apt: setup.sh builds a venv and
  // fetches the models, which is why this is a proposal a person approves rather
  // than something an installer does to a box nobody asked.
  voice: ['python3-venv', 'python3-pip'],
  mail: ['postfix', 'postfix-pcre', 'dovecot-core', 'dovecot-imapd', 'dovecot-lmtpd', 'dovecot-sieve'],
  // A name server of our own, so records can be written rather than only read.
  // Without it the panel can tell you your SPF is wrong and cannot fix it.
  dns: ['bind9', 'bind9utils', 'dnsutils'],
  // Signing, kept as its own stack rather than folded into mail, so a machine
  // that already has Postfix and Dovecot can gain it without reinstalling
  // either. Without this the panel can tell you DKIM is missing and cannot
  // give you one, which is where it stood until 2026-08-20.
  dkim: ['opendkim', 'opendkim-tools'],
  // Spam filtering, its own stack for the same reason signing is: a box that
  // already carries Postfix and Dovecot gains it without reinstalling either.
  // Redis goes in with it because rspamd keeps its statistics, its greylist and
  // its rate limits there, and without it the filter runs with its memory wiped
  // on every restart, which is a filter that never learns.
  antispam: ['rspamd', 'redis-server'],
  // The unversioned names pull whatever the distribution's current PHP is,
  // which is 8.3 on Ubuntu 24.04 and 8.2 on Debian 12, so this list is the same
  // on every apt flavour and does not go stale when the distribution moves on.
  // The extension set is not arbitrary: it is what WordPress and phpMyAdmin
  // both refuse to run without, which is the whole reason this stack exists.
  php: ['php-fpm', 'php-cli', 'php-mysql', 'php-xml', 'php-mbstring',
    'php-curl', 'php-zip', 'php-gd', 'php-intl', 'php-bcmath'],
};

// Which PHP-FPM versions this machine has on disk, newest first. Read from the
// configuration tree rather than from the package manager, because what matters
// is what can actually serve a site.
function phpVersionsOnDisk() {
  let entries = [];
  try { entries = fs.readdirSync('/etc/php'); } catch { return []; }
  return entries
    .filter(name => /^\d+\.\d+$/.test(name) && fs.existsSync(path.join('/etc/php', name, 'fpm')))
    .sort((a, b) => parseFloat(b) - parseFloat(a));
}

async function phpVersions() {
  const versions = phpVersionsOnDisk();
  const out = [];
  for (const version of versions) {
    const unit = await runFile('/usr/bin/systemctl', ['is-active', `php${version}-fpm.service`], { timeoutMs: 10000 });
    const state = (unit.stdout || '').trim() || 'unknown';
    out.push({
      version, running: state === 'active', unit_state: state,
      unit: `php${version}-fpm.service`,
      socket: `/run/php/php${version}-fpm.sock`,
      socket_present: fs.existsSync(`/run/php/php${version}-fpm.sock`),
    });
  }
  const def = out.find(entry => entry.running) || out[0] || null;
  return { versions: out, count: out.length, default: def ? def.version : null };
}

const WEBMAIL_SNIPPET = '/etc/nginx/snippets/jotpanel-webmail.conf';
const WEBMAIL_INCLUDE = `  include ${WEBMAIL_SNIPPET};`;
const FAIL2BAN_JAILS = ['sshd', 'postfix', 'dovecot'];

function jotPanelDomain() {
  try {
    const body = fs.readFileSync((process.env.JOTPANEL_ENV_FILE ?? process.env.ARCA_ENV_FILE) || '/opt/jotpanel/.env', 'utf8');
    const value = (body.match(/^DOMAIN=(.+)$/m) || [])[1];
    if (value) return String(value).trim().replace(/^['"]|['"]$/g, '');
  } catch {}
  return 'localhost';
}

function roundcubeRoot() {
  for (const candidate of ['/var/lib/roundcube/public_html', '/usr/share/roundcube']) {
    if (fs.existsSync(path.join(candidate, 'index.php'))) return candidate;
  }
  throw new Error('Roundcube is installed but its public index.php could not be found');
}

function panelNginxFiles() {
  return ['/etc/nginx/conf.d/jotpanel.conf', '/etc/nginx/sites-available/jotpanel-tls.conf']
    .filter(file => fs.existsSync(file));
}

async function configureWebmail() {
  const root = roundcubeRoot();
  const php = await phpVersions();
  const running = php.versions.find(entry => entry.running);
  if (!running) throw new Error('Roundcube installed but no PHP-FPM pool is running');
  const socket = running.socket;
  ensureDir(path.dirname(WEBMAIL_SNIPPET), 0o755);
  fs.writeFileSync(WEBMAIL_SNIPPET, `# Managed by jotpanel-ops. Roundcube under the panel's own name.
location = /webmail { return 302 /webmail/; }
location /webmail/ {
  alias ${root}/;
  index index.php;
  try_files $uri $uri/ /webmail/index.php?$query_string;
}
location ~ ^/webmail/(.+\\.php)$ {
  alias ${root}/$1;
  include fastcgi_params;
  fastcgi_param SCRIPT_FILENAME ${root}/$1;
  fastcgi_param SCRIPT_NAME /webmail/$1;
  fastcgi_pass unix:${socket};
}
`, { mode: 0o644 });

  const configs = panelNginxFiles();
  if (!configs.length) throw new Error('The panel nginx configuration was not found, so webmail has nowhere to be served');
  for (const file of configs) {
    const body = fs.readFileSync(file, 'utf8');
    const withoutOldIncludes = body.split('\n').filter(line => line.trim() !== `include ${WEBMAIL_SNIPPET};`).join('\n');
    const patched = withoutOldIncludes.replace(/^(\s*)server\s*\{\s*$/gm, line => `${line}\n${WEBMAIL_INCLUDE}`);
    if (patched === withoutOldIncludes) throw new Error(`${file} has no nginx server block for webmail`);
    fs.writeFileSync(file, patched, { mode: 0o644 });
  }

  const config = '/etc/roundcube/config.inc.php';
  if (fs.existsSync(config)) {
    let body = fs.readFileSync(config, 'utf8');
    const settings = [
      ['$config[\'default_host\']', "'127.0.0.1'"],
      ['$config[\'default_port\']', '143'],
      ['$config[\'smtp_server\']', "'127.0.0.1'"],
      ['$config[\'smtp_port\']', '25'],
      ['$config[\'product_name\']', "'JotPanel Webmail'"],
    ];
    for (const [key, value] of settings) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const row = `${key} = ${value};`;
      body = new RegExp(`^\\s*${escaped}\\s*=.*$`, 'm').test(body)
        ? body.replace(new RegExp(`^\\s*${escaped}\\s*=.*$`, 'm'), row)
        : `${body.replace(/\s*$/, '')}\n${row}\n`;
    }
    fs.writeFileSync(config, body, { mode: 0o640 });
  }

  await validateAndReloadNginx();
  const probe = await webmailStatus();
  return { root, php: running.version, url: probe.url, mailboxes: probe.mailboxes.length };
}

function webmailRequest({ tlsMode = false } = {}) {
  const hostname = jotPanelDomain();
  if (!tlsMode) {
    return new Promise(resolve => {
      const request = http.request({ host: '127.0.0.1', port: 80, path: '/webmail/', method: 'GET', headers: { Host: hostname }, timeout: 10000 }, response => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location || null }));
      });
      request.on('timeout', () => request.destroy(new Error('webmail request timed out')));
      request.on('error', error => resolve({ status: null, error: firstLine(error.message) }));
      request.end();
    });
  }
  return new Promise(resolve => {
    const socket = tls.connect({ host: '127.0.0.1', port: 443, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: false, timeout: 10000 }, () => {
      socket.write(`GET /webmail/ HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { if (reply.length < 8192) reply += chunk; });
    socket.on('end', () => resolve({ status: Number((reply.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/) || [])[1]) || null }));
    socket.on('timeout', () => socket.destroy(new Error('webmail TLS request timed out')));
    socket.on('error', error => resolve({ status: null, error: firstLine(error.message) }));
  });
}

async function webmailStatus() {
  roundcubeRoot();
  const mailProbe = await stackProbe({ stack: 'mail' });
  if (!mailProbe.available) throw new Error(`Roundcube is installed but local IMAP is unavailable: ${mailProbe.reason}`);
  let response = await webmailRequest();
  if ([301, 302, 307, 308].includes(response.status)) response = await webmailRequest({ tlsMode: true });
  if (response.status !== 200) throw new Error(`Roundcube did not answer under the panel domain${response.error ? `: ${response.error}` : ` (HTTP ${response.status || 'no response'})`}`);
  const base = `https://${jotPanelDomain()}/webmail/`;
  const mailboxes = readMail().mailboxes.map(entry => {
    const address = mailboxAddress(entry);
    return { address, url: `${base}?_user=${encodeURIComponent(address)}` };
  });
  return { available: true, url: base, mailboxes, verified: true };
}

async function configureFail2ban() {
  const target = '/etc/fail2ban/jail.d/jotpanel.conf';
  ensureDir(path.dirname(target), 0o755);
  fs.writeFileSync(target, `# Managed by jotpanel-ops. SSH and both halves of local mail.
[sshd]
enabled = true
backend = systemd

[postfix]
enabled = true
backend = systemd

[dovecot]
enabled = true
backend = systemd
`, { mode: 0o644 });
  await must(command(['/usr/bin/fail2ban-client', '/usr/local/bin/fail2ban-client', 'fail2ban-client']), ['-t'], { timeoutMs: 60000 }, 'fail2ban rejected its managed jail configuration');
  await must('/usr/bin/systemctl', ['enable', '--now', 'fail2ban.service'], { timeoutMs: 60000 }, 'fail2ban would not start');
  await must('/usr/bin/systemctl', ['restart', 'fail2ban.service'], { timeoutMs: 60000 }, 'fail2ban would not restart with the managed jails');
  // systemctl reports a successful start as soon as the process exists.
  // fail2ban creates its control socket a little later, and probing in that
  // gap made a healthy Linux install record itself as failed. Wait for the
  // interface we actually depend on instead of guessing a fixed sleep.
  await waitForFail2ban();
  return fail2banList();
}

function fail2banClient() { return command(['/usr/bin/fail2ban-client', '/usr/local/bin/fail2ban-client', 'fail2ban-client']); }

async function waitForFail2ban({ run = runFile, pause = delay, attempts = 20, intervalMs = 250 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await run(fail2banClient(), ['ping'], { timeoutMs: 15000 });
    if (last.ok) return true;
    if (attempt + 1 < attempts) await pause(intervalMs);
  }
  throw new Error(failure(last, 'fail2ban did not open its control channel after starting'));
}

function parseFail2banJails(output) {
  const value = (String(output || '').match(/Jail list:\s*(.+)$/mi) || [])[1] || '';
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

async function fail2banList() {
  await must(fail2banClient(), ['ping'], { timeoutMs: 15000 }, 'fail2ban does not answer its control channel');
  const status = await must(fail2banClient(), ['status'], { timeoutMs: 15000 }, 'fail2ban status could not be read');
  const jails = parseFail2banJails(status.stdout);
  const bans = [];
  for (const jail of jails) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(jail)) continue;
    const row = await must(fail2banClient(), ['status', jail], { timeoutMs: 15000 }, `fail2ban could not read ${jail}`);
    const ips = ((row.stdout.match(/Banned IP list:\s*(.*)$/mi) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
    for (const ip of ips) if (net.isIP(ip)) bans.push({ ip, jail, banned_at: null });
  }
  return { jails, bans, count: bans.length, verified: true };
}

async function fail2banUnban(params) {
  const jail = String(params.jail || '').trim();
  const ip = String(params.ip || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(jail)) throw new Error('That fail2ban jail name is invalid');
  if (!net.isIP(ip)) throw new Error('That is not an IPv4 or IPv6 address');
  const before = await fail2banList();
  if (!before.bans.some(entry => entry.jail === jail && entry.ip === ip)) throw new Error(`${ip} is not banned in ${jail}`);
  await must(fail2banClient(), ['set', jail, 'unbanip', ip], { timeoutMs: 15000 }, `fail2ban would not unban ${ip}`);
  const after = await fail2banList();
  if (after.bans.some(entry => entry.jail === jail && entry.ip === ip)) throw new Error(`${ip} remains banned in ${jail}`);
  return { jail, ip, bans: after.bans, verified: true };
}

// Directories this unit is not allowed to see through their own name, and the
// second name each is bound to so it can still be measured. `du` runs inside
// the privileged unit, and a directory systemd has masked measures as zero
// there, so without this the answer is short by however much is in it and looks
// exactly like a correct answer. Found on 2026-08-28 by comparing the panel's
// figure against du run over ssh: /usr came back 154 MB light on a box carrying
// one kernel, which is every Arca box, and would be worse on one carrying four.
const MASKED_FOLDERS = [{ real: '/usr/lib/modules', through: '/var/lib/jotpanel-ops/kernel-modules' }];

async function diskUsage() {
  const du = command(['/usr/bin/du', '/bin/du', 'du']);
  const result = await must(du, ['-x', '-B1', '--max-depth=1', '/'], { timeoutMs: 180000, maxBuffer: 8 * 1024 * 1024 }, 'folder disk usage could not be read with panel privilege');
  const folders = String(result.stdout || '').split('\n').map(line => {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    return match && match[2] !== '/' ? { path: match[2], bytes: Number(match[1]) } : null;
  }).filter(Boolean);

  // Each masked directory is measured through its second name and added to the
  // folder it really lives under. If the bind is not there, which is any box
  // installed before this landed, the figure is left alone rather than guessed
  // at, and the shortfall is named in the answer rather than hidden in it.
  const unmeasured = [];
  for (const masked of MASKED_FOLDERS) {
    const parent = folders.find(folder => masked.real.startsWith(`${folder.path}/`));
    if (!parent) continue;
    // Empty means nothing is bound there, and an empty directory still measures
    // as one block. Testing `bytes > 0` therefore added 4096 and reported
    // success on a box with no bind at all, which is the same silence this
    // whole change is about, so the test is whether anything is in it.
    let bound = false;
    try { bound = fs.readdirSync(masked.through).length > 0; } catch { bound = false; }
    if (!bound) { unmeasured.push(masked.real); continue; }
    const measured = await runFile(du, ['-x', '-B1', '-s', masked.through], { timeoutMs: 60000, maxBuffer: 65536 });
    const bytes = measured.ok ? Number((/^(\d+)\s/.exec(measured.stdout.trim()) || [])[1]) : NaN;
    if (Number.isFinite(bytes) && bytes > 0) parent.bytes += bytes;
    else unmeasured.push(masked.real);
  }

  return {
    folders: folders.sort((a, b) => b.bytes - a.bytes).slice(0, 30),
    ...(unmeasured.length ? { unmeasured } : {}),
    checked_at: new Date().toISOString(), verified: true,
  };
}

// How much disk a specific set of sites actually use, for the hoster's own
// per-account storage figure. Whole-machine `disk.usage` above answers "what
// is eating this box"; this answers "what does this one account's stuff cost
// in bytes", which the admin view needs per account rather than once for the
// whole machine. Run per domain, not batched into one `du`, because a domain
// whose folder is gone (deleted outside the panel, or a race with a delete
// still in flight) must not blank out every other domain's real number — it
// is reported as unmeasured instead, which is the honest answer, not zero.
const DU = command(['/usr/bin/du', '/bin/du', 'du']);
async function siteStorage(params) {
  const domains = (Array.isArray(params.domains) ? params.domains : []).slice(0, 200).map(domain);
  const usage = await Promise.all(domains.map(async d => {
    const result = await runFile(DU, ['-s', '-B1', siteBase(d)], { timeoutMs: 20000, maxBuffer: 65536 });
    if (!result.ok) return [d, null];
    const match = /^(\d+)\s+/.exec(result.stdout.trim());
    return [d, match ? Number(match[1]) : null];
  }));
  return { usage: Object.fromEntries(usage), checked_at: new Date().toISOString(), verified: true };
}

// The complete set of privileged oneshot instances. `privileged-oneshot.js`
// maps each name to the function that runs it and validates against this list,
// so a systemd instance name is never anything but one of these.
const ONESHOT_INSTANCES = Object.freeze([
  ...Object.keys(STACKS).map(stack => `stack-${stack}`),
  'packages-security',
  'packages-all',
  // One per language that has something to install. Written out rather than
  // derived, because this list is read before the runtime table exists and a
  // closed list is the point of it. The two are checked against each other
  // where the table is defined, so drift fails at load rather than in the field.
  'runtime-node',
  'runtime-python',
  'runtime-ruby',
  'runtime-java',
  'runtime-perl',
  'runtime-dotnet',
  // A mailbox copy belongs here for the same reason an upgrade does: it takes
  // as long as somebody's mail takes, and the panel dying halfway through must
  // not lose the answer.
  'migrate-imap',
]);

// A read, and the only way the unprivileged panel can see what a oneshot did.
// The unit writes its verified result as its last act, so an action whose panel
// process died still has a real outcome to be reconciled against. `active`
// separates "no result yet because it is still working" from "no result, and
// nothing is running", which are opposite answers for the record.
async function oneshotResult(params) {
  const instance = String(params.instance || '');
  if (!ONESHOT_INSTANCES.includes(instance)) throw new Error('Unknown privileged oneshot');
  const state = readState(path.join(STATE_DIR, `oneshot-${instance}.json`), null);
  // systemctl is-active exits non-zero for anything but active, and the word we
  // want is on stdout either way, so the exit status is not the answer here.
  const unit = await runFile('/usr/bin/systemctl', ['is-active', `jotpanel-oneshot@${instance}.service`], { timeoutMs: 15000 });
  const unitState = (unit.stdout || '').trim() || (unit.stderr || '').trim() || 'unknown';
  return {
    instance,
    present: !!state,
    active: unitState === 'active' || unitState === 'activating' || unitState === 'reloading',
    unit_state: unitState,
    ok: state ? state.ok === true : null,
    finished_at: state ? state.finished_at || null : null,
    result: state && state.ok === true ? state.result || null : null,
    error: state && state.ok !== true ? state.error || null : null,
  };
}

// Whisper and Kokoro, installed where an upgrade cannot delete them. The venv
// and the weights are a third of a gigabyte, so they live under the install's
// data directory, which upgrade.sh leaves alone, and the tree under app/ holds
// only the scripts. Everything here is idempotent: setup.sh re-run on a box
// that already has the models downloads nothing.
const VOICE_PORT = parseInt((process.env.JOTPANEL_TTS_PORT ?? process.env.ARCA_TTS_PORT) || '9997', 10);
const VOICE_UNIT = '/etc/systemd/system/jotpanel-voice.service';

async function voiceHealthy(timeoutMs = 4000) {
  try {
    const res = await fetch(`http://127.0.0.1:${VOICE_PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch { return false; }
}

async function installVoice() {
  const root = (process.env.JOTPANEL_INSTALL_DIR ?? process.env.ARCA_INSTALL_DIR) || '/opt/jotpanel';
  const scripts = `${root}/app/app/backend/tts`;
  const here = fs.existsSync(scripts) ? scripts : `${root}/app/backend/tts`;
  if (!fs.existsSync(`${here}/setup.sh`)) throw new Error('This panel does not carry the voice scripts.');
  // The venv and the models live in the data directory, not beside the scripts,
  // because an upgrade replaces the tree and would delete a third of a gigabyte
  // of weights with it. setup.sh decides that location; this asks it rather than
  // assuming, which is how the first attempt wrote a service pointing at a venv
  // that does not exist and restarted sixty-five times.
  const state = process.env.JOTPANEL_TTS_STATE || `${root}/data/tts`;

  // Twenty minutes: on one core the model download and the first load are slow,
  // and a timeout here would leave a half-built venv behind.
  await must('/bin/bash', [`${here}/setup.sh`], { cwd: here, timeoutMs: 1200000, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } },
    'The voice stack did not install');

  const python = `${state}/venv/bin/python`;
  if (!fs.existsSync(python)) throw new Error(`The voice stack installed but left no interpreter at ${python}.`);

  fs.writeFileSync(VOICE_UNIT, [
    '[Unit]',
    'Description=JotPanel voice (speech to text and text to speech)',
    'After=network.target',
    '',
    '[Service]',
    `WorkingDirectory=${here}`,
    `Environment=JOTPANEL_TTS_PORT=${VOICE_PORT}`,
    `Environment=JOTPANEL_TTS_STATE=${state}`,
    `ExecStart=${python} ${here}/tts_server.py`,
    'Restart=on-failure',
    // Ten seconds apart and no burst limit: a model that fails to load fails the
    // same way every time, and sixty-five restarts in a minute tells nobody
    // anything it did not already say once.
    'RestartSec=10',
    'StartLimitIntervalSec=0',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\n') + '\n', { mode: 0o644 });

  await must('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60000 }, 'The service manager would not reload');
  await must('/usr/bin/systemctl', ['enable', '--now', 'jotpanel-voice'], { timeoutMs: 120000 }, 'The voice service would not start');

  // Loading the models takes a while on a small box, so it is given time to
  // answer rather than asked once and declared broken.
  // Ten minutes. Loading Whisper and Kokoro on one core is slow the first time,
  // and five minutes was not enough on the box this was proved on.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await voiceHealthy()) return { verified: true, port: VOICE_PORT, unit: 'jotpanel-voice', state };
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error(`The voice service installed but never answered on port ${VOICE_PORT}. Its log is in the service manager under jotpanel-voice.`);
}

async function installStackPackages(params) {
  const stack = String(params.stack || '');
  const packages = STACKS[stack];
  if (!packages) throw new Error('Unknown server stack');
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  if (stack === 'mail') {
    await must('/usr/bin/debconf-set-selections', [], { input: `postfix postfix/mailname string ${os.hostname()}\npostfix postfix/main_mailer_type select Internet Site\n`, env }, 'Postfix setup could not be prepared');
  }
  if (stack === 'webmail') {
    await must('/usr/bin/debconf-set-selections', [], {
      input: 'roundcube-core roundcube/dbconfig-install boolean true\nroundcube-core roundcube/database-type select sqlite3\nroundcube-core roundcube/reconfigure-webserver multiselect\n', env,
    }, 'Roundcube setup could not be prepared');
  }
  await must('/usr/bin/apt-get', [...APT_WAIT, 'update'], { timeoutMs: 1800000, env }, 'The package index could not be updated');
  await must('/usr/bin/apt-get', [...APT_WAIT, '-y', '-o', 'Dpkg::Options::=--force-confold', 'install', ...packages], { timeoutMs: 2100000, env }, `The ${stack} stack did not install`);
  if (stack === 'voice') return { stack, packages, ...(await installVoice()) };
  const configured = stack === 'mail' ? await mailConfigure()
    : stack === 'webmail' ? await configureWebmail()
      : stack === 'fail2ban' ? await configureFail2ban()
        : null;
  const probe = await stackProbe({ stack });
  if (!probe.available) throw new Error(`${stack} packages installed but the permission probe still fails: ${probe.reason}`);
  return { stack, packages, probe, configured, verified: true };
}

// Anything that drives dpkg is handed to a short-lived unit. This daemon keeps
// RestrictSUIDSGID and ProtectHome, and a security upgrade run inside it died
// setting the setgid bit on pam_extrausers_chkpwd. The unit leaves a verified
// result on disk, and that file is the answer rather than the unit's exit
// status, because a job can fail its own verification while systemd counts the
// process as having exited cleanly.
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function oneshotIsRunning(unit, run = runFile) {
  const probe = await run('/usr/bin/systemctl', ['is-active', unit], { timeoutMs: 15000 });
  const state = (probe.stdout || '').trim() || (probe.stderr || '').trim();
  return state === 'active' || state === 'activating' || state === 'reloading';
}

// The injectable ends exist so the D-Bus case below can be tested without a
// machine that upgrades systemd underneath the test.
async function runPrivilegedOneshot(instance, description, {
  waitMs = 1500000, pollMs = 3000,
  run = runFile,
  exists = file => fs.existsSync(file),
  read = file => readState(file, null),
  remove = file => { try { fs.unlinkSync(file); } catch {} },
  sleep = delay,
} = {}) {
  const resultFile = path.join(STATE_DIR, `oneshot-${instance}.json`);
  const unit = `jotpanel-oneshot@${instance}.service`;
  remove(resultFile);
  const deadline = Date.now() + waitMs;
  const started = await run('/usr/bin/systemctl', ['start', unit], { timeoutMs: waitMs });

  // `systemctl start` does wait for a oneshot to finish, but it is only a D-Bus
  // client asking systemd to do the work, and these jobs upgrade systemd
  // itself. Watched on a real box: the security set restarted D-Bus, systemctl
  // exited with "Warning! D-Bus connection terminated", and the unit carried on
  // for another thirty-five seconds and completed all thirty-three packages.
  // Reading the client's exit as the job's outcome recorded a successful update
  // as a failed one, which is a worse thing to tell an operator than saying
  // nothing. The unit is the authority, and the file it writes is the answer.
  while (!exists(resultFile) && Date.now() < deadline) {
    if (!(await oneshotIsRunning(unit, run))) break;
    await sleep(pollMs);
  }

  const result = read(resultFile);
  if (!result) {
    const stillRunning = await oneshotIsRunning(unit, run);
    if (stillRunning) throw new Error(`${description} was still running after ${Math.round(waitMs / 60000)} minutes and has not reported a result`);
    throw new Error(started.ok ? `${description} left no verification result` : failure(started, `${description} could not be started`));
  }
  if (result.ok !== true) throw new Error(result.error || `${description} failed`);
  return result.result;
}

async function stackInstall(params) {
  const stack = String(params.stack || '');
  if (!STACKS[stack]) throw new Error('Unknown server stack');
  return runPrivilegedOneshot(`stack-${stack}`, `The ${stack} installer`);
}

async function stackProbe(params) {
  const stack = String(params.stack || '');
  try {
    // The `database` stack is MariaDB by name and always was; Postgres is its
    // own stack rather than a second meaning for the same word.
    if (stack === 'database') return { stack, available: (await mysqlProbe()).available };
    if (stack === 'postgres') {
      const probe = await postgresProbe();
      if (!probe.available) throw new Error(probe.reason || 'PostgreSQL is not runnable');
      return { stack, available: true };
    }
    if (stack === 'voice') {
      if (!(await voiceHealthy())) throw new Error('The voice service is not answering');
      return { stack, available: true };
    }
    if (stack === 'web') {
      await must(command(['/usr/sbin/nginx', '/usr/bin/nginx', 'nginx']), ['-t'], { timeoutMs: 20000 }, 'nginx configuration is not runnable');
      return { stack, available: true };
    }
    if (stack === 'dkim') {
      // Permission, not presence. The question is whether Postfix is actually
      // handing mail to a signer that is listening, not whether a package is
      // unpacked, so both halves are asked.
      // The stack is the signer being installed and running. Whether Postfix
      // is handing mail to it is a per-domain setup step, checked where that
      // happens, and demanding it here made a correct install report failure.
      const status = await runFile('/usr/bin/systemctl', ['is-active', 'opendkim.service'], { timeoutMs: 10000 });
      if (!/^\s*active/.test(status.stdout)) {
        const enabled = await runFile('/usr/bin/systemctl', ['enable', '--now', 'opendkim'], { timeoutMs: 30000 });
        if (!enabled.ok) throw new Error('OpenDKIM is installed and will not start');
      }
      return { stack, available: true };
    }
    if (stack === 'antispam') {
      // Permission, not presence. rspamd on disk proves nothing: the question
      // is whether this panel can make the running filter take a new
      // configuration, so it is asked to validate one and it is asked to be
      // running.
      const status = await runFile('/usr/bin/systemctl', ['is-active', 'rspamd.service'], { timeoutMs: 10000 });
      if (!/^\s*active/.test(status.stdout)) {
        const started = await runFile('/usr/bin/systemctl', ['enable', '--now', 'rspamd'], { timeoutMs: 60000 });
        if (!started.ok) throw new Error('rspamd is installed and will not start');
      }
      await must(command(['/usr/bin/rspamadm', '/usr/local/bin/rspamadm', 'rspamadm']), ['configtest'],
        { timeoutMs: 30000 }, 'rspamd will not accept its own configuration, so the panel cannot change it');
      return { stack, available: true };
    }
    if (stack === 'dns') {
      // Permission, not presence. named on disk proves nothing; this asks the
      // running server to answer and asks its control channel to respond,
      // because writing a zone needs both.
      const status = await runFile('/usr/bin/systemctl', ['is-active', 'named.service'], { timeoutMs: 10000 });
      const alt = await runFile('/usr/bin/systemctl', ['is-active', 'bind9.service'], { timeoutMs: 10000 });
      if (!/^\s*active/.test(status.stdout) && !/^\s*active/.test(alt.stdout)) throw new Error('BIND is installed and not running');
      await must(command(['/usr/sbin/rndc', '/usr/bin/rndc', 'rndc']), ['status'], { timeoutMs: 20000 }, 'the BIND control channel does not answer, so zones cannot be reloaded');
      return { stack, available: true };
    }
    if (stack === 'certificates') {
      await must(command(['/usr/bin/certbot', '/usr/local/bin/certbot', 'certbot']), ['certificates'], { timeoutMs: 60000 }, 'certbot cannot read its certificate store');
      return { stack, available: true };
    }
    if (stack === 'webmail') {
      const state = await webmailStatus();
      return { stack, available: state.available, url: state.url };
    }
    if (stack === 'fail2ban') {
      const state = await fail2banList();
      const missing = FAIL2BAN_JAILS.filter(jail => !state.jails.includes(jail));
      if (missing.length) throw new Error(`fail2ban is running without the ${missing.join(', ')} jail${missing.length === 1 ? '' : 's'}`);
      return { stack, available: true, jails: state.jails };
    }
    if (stack === 'php') {
      // Permission, not presence. A php binary on disk says nothing about
      // whether anything can serve a page, so this asks the interpreter to run
      // and then asks systemd whether a pool is actually listening.
      const cli = await must(command(['/usr/bin/php', 'php']), ['-v'], { timeoutMs: 15000 }, 'PHP is not runnable');
      const state = await phpVersions();
      if (!state.count) throw new Error('no PHP-FPM version is configured on this machine');
      const running = state.versions.filter(entry => entry.running);
      if (!running.length) throw new Error(`PHP-FPM is installed (${state.versions.map(v => v.version).join(', ')}) but no pool is running`);
      return { stack, available: true, versions: state.versions, default: state.default, cli: firstLine(cli.stdout) };
    }
    if (stack === 'mail') {
      await must(command(['/usr/sbin/postconf', '/usr/bin/postconf', 'postconf']), ['-h', 'mail_version'], { timeoutMs: 10000 }, 'Postfix is not runnable');
      await must(command(['/usr/bin/doveconf', '/usr/sbin/doveconf', 'doveconf']), ['-n'], { timeoutMs: 20000 }, 'Dovecot is not runnable');
      return { stack, available: true };
    }
    throw new Error('Unknown server stack');
  } catch (error) { return { stack, available: false, reason: error.message }; }
}

async function packageStatusPrivileged() {
  const result = await must('/usr/bin/apt-get', ['--just-print', 'upgrade'], { timeoutMs: 90000 }, 'apt cannot read the upgrade set with panel privilege');
  const packages = result.stdout.split('\n')
    .map(line => line.match(/^Inst\s+(\S+)\s+\[([^\]]*)\]\s+\(([^\s]+)\s+([^)]*)\)/))
    .filter(Boolean)
    .map(match => ({ name: match[1], installed: match[2], candidate: match[3], origin: match[4], security: /security/i.test(match[4]) }));
  // /var/run/reboot-required is created by update-notifier-common, which is not
  // installed on every image, including the Ubuntu cloud image this panel is
  // most often installed on. Reporting false there says "no reboot is needed"
  // when the truthful answer is "this machine cannot tell you", and an operator
  // acting on the first one leaves a half-patched kernel running.
  const rebootFlag = '/var/run/reboot-required';
  const canAnswer = fs.existsSync('/usr/bin/update-notifier') || fs.existsSync('/usr/share/update-notifier')
    || fs.existsSync('/var/lib/update-notifier') || fs.existsSync(rebootFlag);
  const rebootRequired = fs.existsSync(rebootFlag);
  let rebootPackages = [];
  try { rebootPackages = fs.readFileSync(`${rebootFlag}.pkgs`, 'utf8').split('\n').filter(Boolean); } catch {}
  return {
    packages, count: packages.length,
    security_count: packages.filter(item => item.security).length,
    reboot_required: rebootRequired,
    // Null rather than false where nothing on this machine keeps the flag.
    reboot_known: canAnswer ? true : false,
    reboot_state: canAnswer ? (rebootRequired ? 'required' : 'not_required') : 'unknown',
    reboot_unknown_reason: canAnswer ? null : 'update-notifier-common is not installed, so this machine does not record whether a reboot is needed.',
    reboot_packages: rebootPackages,
  };
}

// Asked in the daemon, because "there is nothing waiting" should come back at
// once rather than after starting a unit to find out.
async function packageApplyPrivileged(params) {
  const securityOnly = params.securityOnly !== false;
  const before = await packageStatusPrivileged();
  const targets = securityOnly ? before.packages.filter(item => item.security) : before.packages;
  if (!targets.length) throw new Error(securityOnly ? 'There are no security updates waiting' : 'There are no updates waiting');
  return runPrivilegedOneshot(securityOnly ? 'packages-security' : 'packages-all', 'The update run');
}

// Runs inside the oneshot. The waiting set is read again here rather than
// carried in from the daemon, so the packages installed are the ones apt says
// are waiting at the moment they are installed.
async function applyPackageUpdates(params) {
  const securityOnly = params.securityOnly !== false;
  const before = await packageStatusPrivileged();
  const targets = securityOnly ? before.packages.filter(item => item.security) : before.packages;
  // The refusal for "nothing waiting" belongs to the check in the daemon, which
  // answers before a unit is started. Reaching here with an empty set means the
  // waiting work went away between that check and this run, which on a new box
  // means the machine's own updater got to it first while apt waited for the
  // lock. That is the operator's request satisfied, not a failed one.
  if (!targets.length) {
    const state = await packageStatusPrivileged();
    return {
      installed: [], remaining: state.count, remaining_security: state.security_count,
      reboot_required: state.reboot_required, verified: true,
      note: 'Nothing was left to install by the time this run had the package lock; the machine had already been brought up to date.',
    };
  }
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  await must('/usr/bin/apt-get', [...APT_WAIT, '-y', '-o', 'Dpkg::Options::=--force-confold', 'install', ...targets.map(item => item.name)], { timeoutMs: 2100000, env }, 'The update run failed');
  const after = await packageStatusPrivileged();
  return { installed: targets.map(item => item.name), remaining: after.count, remaining_security: after.security_count, reboot_required: after.reboot_required, verified: true };
}

// ── MariaDB ───────────────────────────────────────────────────────
function mysqlBin() { return command(['/usr/bin/mariadb', '/usr/bin/mysql', 'mariadb']); }
function dumpBin() { return command(['/usr/bin/mariadb-dump', '/usr/bin/mysqldump', 'mariadb-dump']); }

// On standard input, not in an argument. `--execute` put every statement in the
// process list, and two of those statements carry a password in clear: CREATE
// USER ... IDENTIFIED BY and ALTER USER ... IDENTIFIED BY. Any local user could
// read a customer's database password out of ps for as long as the call took.
// The identifiers are still validated to the same closed character set, which
// is what makes building the statement safe at all.
async function mysql(sql, database = null, options = {}) {
  const args = ['--batch', '--skip-column-names'];
  if (database) args.push(`--database=${dbName(database)}`);
  return must(mysqlBin(), args, { input: `${sql}\n`, timeoutMs: options.timeoutMs || 60000, maxBuffer: options.maxBuffer }, 'MariaDB refused the named job');
}

async function mysqlProbe() {
  try {
    const result = await mysql('SELECT 1');
    return { available: result.stdout.trim() === '1', engine: 'mysql', permission: 'root Unix socket' };
  } catch (error) { return { available: false, engine: 'mysql', reason: error.message }; }
}

function tsv(text) { return String(text || '').split('\n').filter(Boolean).map(line => line.split('\t')); }

async function mysqlList() {
  const rows = tsv((await mysql(`SELECT s.schema_name, COALESCE(SUM(t.data_length+t.index_length),0), COUNT(t.table_name) FROM information_schema.schemata s LEFT JOIN information_schema.tables t ON t.table_schema=s.schema_name WHERE s.schema_name LIKE '${DB_PREFIX}\\_%' GROUP BY s.schema_name ORDER BY s.schema_name`)).stdout);
  const users = tsv((await mysql(`SELECT DISTINCT user FROM mysql.user WHERE user LIKE '${DB_PREFIX}\\_%' ORDER BY user`)).stdout);
  return {
    prefix: `${DB_PREFIX}_`,
    engines: [{ engine: 'mysql', databases: rows.map(([name, bytes, tables]) => ({ name, engine: 'mysql', size_bytes: Number(bytes) || 0, tables: Number(tables) || 0 })), users: users.map(([name]) => ({ name, engine: 'mysql' })) }],
    databases: rows.map(([name, bytes, tables]) => ({ name, engine: 'mysql', size_bytes: Number(bytes) || 0, tables: Number(tables) || 0 })),
    users: users.map(([name]) => ({ name, engine: 'mysql' })),
  };
}

async function mysqlTables(params) {
  const name = dbName(params.name);
  // The existence check is the reading, not a nicety. Without it a database
  // that is not on this machine answers 200 with an empty table list, which on
  // the screen is indistinguishable from a database that is here and empty,
  // and the Postgres side of the same operation has always refused it.
  if (!(await mysqlDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  const rows = tsv((await mysql(`SELECT table_name, COALESCE(table_rows,0), COALESCE(data_length+index_length,0) FROM information_schema.tables WHERE table_schema='${name}' ORDER BY table_name`)).stdout);
  return { name, engine: 'mysql', tables: rows.map(([table, count, bytes]) => ({ table, rows: Number(count) || 0, size_bytes: Number(bytes) || 0 })) };
}

async function mysqlDatabaseExists(name) {
  const clean = dbName(name);
  return tsv((await mysql(`SELECT schema_name FROM information_schema.schemata WHERE schema_name='${clean}'`)).stdout).length > 0;
}

async function mysqlUserExists(name) {
  const clean = dbName(name, 'database user');
  return tsv((await mysql(`SELECT user FROM mysql.user WHERE user='${clean}' AND host='localhost'`)).stdout).length > 0;
}

async function mysqlCreate(params) {
  const name = dbName(params.name);
  await mysql(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  if (!(await mysqlDatabaseExists(name))) throw new Error(`${name} was not present after creation`);
  return { name, engine: 'mysql', verified: true };
}

async function mysqlDrop(params) {
  const name = dbName(params.name);
  if (!(await mysqlDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  await mysql(`DROP DATABASE \`${name}\``);
  if (await mysqlDatabaseExists(name)) throw new Error(`${name} still exists after deletion`);
  return { name, engine: 'mysql', dropped: true, verified: true };
}

async function mysqlUserCreate(params) {
  const username = dbName(params.username, 'database user');
  const password = dbPassword(params.password);
  await mysql(`CREATE USER '${username}'@'localhost' IDENTIFIED BY '${password}'`);
  if (!(await mysqlUserExists(username))) throw new Error(`${username} was not present after creation`);
  return { username, engine: 'mysql', verified: true };
}

async function mysqlUserDrop(params) {
  const username = dbName(params.username, 'database user');
  if (!(await mysqlUserExists(username))) throw new Error(`There is no database user called ${username}`);
  await mysql(`DROP USER '${username}'@'localhost'`);
  if (await mysqlUserExists(username)) throw new Error(`${username} still exists after deletion`);
  return { username, engine: 'mysql', dropped: true, verified: true };
}

// The one line of SHOW GRANTS that is about this database, and nothing else.
// Matching on the name anywhere in the output is not the same question: the
// output carries the user name and every other database's line too, so a grant
// on a neighbouring database whose name merely contains this one would answer
// yes.
function mysqlGrantLine(grants, name, username) {
  const rows = String(grants || '').split('\n');
  const wanted = new RegExp(`ON \`?${name}\`?\\.\\* TO \`?${username}\`?@`, 'i');
  return rows.find(row => wanted.test(row)) || null;
}

async function mysqlGrant(params) {
  const name = dbName(params.name);
  const username = dbName(params.username, 'database user');
  const privileges = params.privileges === 'read' ? 'read' : 'all';
  if (!(await mysqlDatabaseExists(name)) || !(await mysqlUserExists(username))) throw new Error('The database and user must both exist before a grant');

  // GRANT adds, it never replaces, and that is the whole of the bug this
  // guards against. Setting a user who had ALL PRIVILEGES back to read-only
  // used to issue GRANT SELECT and stop, which changes nothing: the user keeps
  // every privilege it had, and the old read-back agreed because the database
  // name was still in the output. So somebody reduced an application's access
  // to read-only, the panel said it was done, the record said verified, and the
  // account could still drop the tables.
  //
  // The existing grant is taken away first. There is a moment between the two
  // statements where the user can reach nothing, which is the right way round:
  // the failure mode of this order is a refusal, and the failure mode of the
  // other order is the privilege never leaving.
  //
  // Two statements, because MariaDB only accepts the combined
  // "ALL PRIVILEGES, GRANT OPTION" form globally, and a database-level revoke
  // that leaves GRANT OPTION behind leaves the user able to hand its own access
  // to somebody else.
  const held = mysqlGrantLine((await mysql(`SHOW GRANTS FOR '${username}'@'localhost'`)).stdout, name, username);
  if (held) {
    await mysql(`REVOKE ALL PRIVILEGES ON \`${name}\`.* FROM '${username}'@'localhost'`);
    // Only when it is really held: MariaDB refuses a revoke of a grant that was
    // never made rather than treating it as already done, and the panel never
    // issues this one itself, so it is only ever here to clear something set by
    // hand outside the panel.
    if (/WITH GRANT OPTION/i.test(held)) await mysql(`REVOKE GRANT OPTION ON \`${name}\`.* FROM '${username}'@'localhost'`);
  }
  const list = privileges === 'read' ? 'SELECT, SHOW VIEW' : 'ALL PRIVILEGES';
  await mysql(`GRANT ${list} ON \`${name}\`.* TO '${username}'@'localhost'`);

  // Read back what the privileges ARE, not that the database is mentioned.
  const line = mysqlGrantLine((await mysql(`SHOW GRANTS FOR '${username}'@'localhost'`)).stdout, name, username);
  if (!line) throw new Error(`The grant on ${name} did not read back for ${username}`);
  const holdsEverything = /GRANT\s+ALL\s+PRIVILEGES/i.test(line);
  if (privileges === 'all' && !holdsEverything) throw new Error(`${username} did not end up with full access to ${name}`);
  if (privileges === 'read' && holdsEverything) throw new Error(`${username} still holds full access to ${name} after being reduced to read-only`);
  if (privileges === 'read' && !/\bSELECT\b/i.test(line)) throw new Error(`${username} did not end up able to read ${name}`);
  if (/WITH GRANT OPTION/i.test(line)) throw new Error(`${username} can still pass its access to ${name} on to others`);
  return { name, username, engine: 'mysql', privileges, grant: line.trim(), verified: true };
}

async function mysqlPasswordChange(params) {
  const username = dbName(params.username, 'database user');
  const password = dbPassword(params.password);
  if (!(await mysqlUserExists(username))) throw new Error(`There is no database user called ${username}`);
  await mysql(`ALTER USER '${username}'@'localhost' IDENTIFIED BY '${password}'`);
  return { username, engine: 'mysql', changed: true, verified: true };
}

async function mysqlDump(params) {
  const name = dbName(params.name);
  if (!(await mysqlDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  const result = await must(dumpBin(), ['--single-transaction', '--routines', '--triggers', name], { timeoutMs: 300000, maxBuffer: OUTPUT_LIMIT }, `A dump of ${name} failed`);
  if (!result.stdout.trim()) throw new Error(`The dump of ${name} was empty`);
  return { name, engine: 'mysql', sql: result.stdout, bytes: Buffer.byteLength(result.stdout), verified: true };
}

async function mysqlImport(params) {
  const name = dbName(params.name);
  const sql = String(params.sql || '');
  if (!sql.trim()) throw new Error('The SQL dump is empty');
  if (Buffer.byteLength(sql) > 256 * 1024 * 1024) throw new Error('The SQL dump exceeds 256 MB');
  if (!(await mysqlDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  const before = await mysqlTables({ name });
  await must(mysqlBin(), [`--database=${name}`], { input: sql, timeoutMs: 600000, maxBuffer: OUTPUT_LIMIT }, `The import into ${name} failed`);
  const after = await mysqlTables({ name });
  return { name, engine: 'mysql', tables_before: before.tables.length, tables_after: after.tables.length, verified: true };
}

// ── Websites and certificates ─────────────────────────────────────
function currentOrLegacy(current, legacy) { return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current; }
function siteConfigPath(name) {
  return currentOrLegacy(path.join(NGINX_AVAILABLE, `jotpanel-${domain(name)}.conf`), path.join(NGINX_AVAILABLE, `arca-${domain(name)}.conf`));
}
function siteEnabledPath(name) {
  return currentOrLegacy(path.join(NGINX_ENABLED, `jotpanel-${domain(name)}.conf`), path.join(NGINX_ENABLED, `arca-${domain(name)}.conf`));
}
function siteBase(name) { return path.join(SITE_ROOT, domain(name)); }

function documentRoot(site) {
  const relative = String(site.document_root || 'public').replace(/^\/+/, '');
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) throw new Error('The document root must be a relative folder path');
  const base = siteBase(site.domain);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error('The document root leaves the managed site directory');
  return target;
}

// An absolute document root is refused rather than quietly turned into a
// relative one. "/var/www/x/public" used to have its leading slash stripped and
// come out as a four-deep folder mirrored inside the site, which is not the path
// the person typed and is not a path they can reason about. Two copies of this
// refusal on purpose — the catalogue's `relativeRoot` is the first — because
// this is the one that stands between a parameter and a root-owned filesystem
// and has to hold even if something above it is loosened.
function siteRelativeRoot(value, fallback = 'public') {
  const given = value == null || String(value).trim() === '' ? fallback : String(value).trim();
  if (given.startsWith('/')) {
    throw new Error('The document root is a folder inside the site, not a path on the server: write it as public, or public_html/shop, with no leading slash.');
  }
  return given;
}

function nginxGroup() {
  const configured = fs.readFileSync('/etc/nginx/nginx.conf', 'utf8').match(/^\s*user\s+([A-Za-z0-9_-]+)(?:\s+([A-Za-z0-9_-]+))?\s*;/m);
  const user = configured?.[1] || 'www-data';
  const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(line => line.startsWith(`${user}:`));
  if (!passwd) throw new Error(`The nginx user ${user} does not exist`);
  const primaryGid = Number(passwd.split(':')[3]);
  if (!configured?.[2]) return primaryGid;
  const group = fs.readFileSync('/etc/group', 'utf8').split('\n').find(line => line.startsWith(`${configured[2]}:`));
  if (!group) throw new Error(`The nginx group ${configured[2]} does not exist`);
  return Number(group.split(':')[2]);
}

// One system user per site, which is what isolation actually means here. Two
// sites owned by the same user are not isolated at all: whichever PHP pool runs
// first can read, and rewrite, the other one's files and its database password.
// DirectAdmin and Hestia both do this and it is the reason a VPS owner can put
// somebody else's project on the same box without thinking about it.
//
// The name is derived from the domain and capped at the 32 characters Linux
// allows, with a hash tail so two long domains that shorten to the same prefix
// cannot collide onto one account.
function siteUserName(name) {
  const clean = domain(name).replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
  const tail = crypto.createHash('sha256').update(domain(name)).digest('hex').slice(0, 6);
  return `web_${clean.slice(0, 22)}_${tail}`.slice(0, 32);
}

async function ensureSiteUser(name) {
  const user = siteUserName(name);
  const home = siteBase(name);
  if (!userExists(user)) {
    const nologin = ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false'].find(p => fs.existsSync(p)) || '/bin/false';
    await must(command(['/usr/sbin/useradd', '/usr/bin/useradd']), ['--system', '--home-dir', home, '--shell', nologin, '--user-group', user],
      { timeoutMs: 30000 }, `the system user for ${domain(name)} could not be created`);
  }
  const record = passwdRecord(user);
  if (!record) throw new Error(`the system user for ${domain(name)} did not read back after creation`);
  return { user, uid: record.uid, gid: record.gid };
}

function passwdRecord(user) {
  const row = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(line => line.split(':')[0] === user);
  if (!row) return null;
  const parts = row.split(':');
  return { user, uid: Number(parts[2]), gid: Number(parts[3]), home: parts[5] };
}
function userExists(user) { return !!passwdRecord(user); }

async function removeSiteUser(name) {
  const user = siteUserName(name);
  if (!userExists(user)) return { user, removed: false };
  // The home directory is removed separately by the caller, so this only takes
  // the account away and never gets to delete a tree on its own.
  await runFile(command(['/usr/sbin/userdel', '/usr/bin/userdel']), [user], { timeoutMs: 30000 });
  return { user, removed: !userExists(user) };
}

// A document root deeper than one folder invents the folders in between, and
// those folders are the ones that broke.
//
// `documentRoot` strips a leading slash, so documentRoot:"/var/www/x/public"
// becomes var/www/x/public *inside* the site and three directories are created
// to mirror it. `ensureDir` chmods only the directory it is handed, and
// `mkdirSync` applies its mode to parents it creates but never re-modes one that
// already exists — so var, var/www and var/www/x were left root:root 0750 while
// only the leaf was handed to the site user and the nginx group. nginx is
// neither root nor in group root, so it had no SEARCH permission on the way
// down and every request answered 404 with `stat() ... failed (13: Permission
// denied)` in the error log. MEASURED on a clean install of this release.
//
// The same shape as the machine root at 0711 in machineJobs.js, fixed on real
// hardware on 2026-10-04 for the same reason: a service that is not root needs
// --x on every parent of a file it opens.
function mirroredDocumentDirs(site) {
  const base = siteBase(site.domain);
  const dirs = [];
  let cursor = path.dirname(documentRoot(site));
  while (cursor !== base && cursor.startsWith(`${base}${path.sep}`)) { dirs.unshift(cursor); cursor = path.dirname(cursor); }
  return dirs;
}

// 0711 and not one bit more. `--x` is search without read: the web server, and
// the site's own PHP pool, can walk through to the document root, and neither
// one — nor any other site's pool — can list what is kept in here. No write bit
// for group or other anywhere, which also keeps sshd willing to chroot the
// site's SFTP user at the base above.
const MIRRORED_DIR_MODE = 0o711;

function ensureMirroredDocumentDirs(site) {
  const dirs = mirroredDocumentDirs(site);
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true, mode: MIRRORED_DIR_MODE });
    // chmod as well as mkdir, because mkdirSync does not re-mode a directory
    // that already exists: a machine installed before this fix keeps the 0750
    // it was given and would go on serving 404 after the upgrade.
    fs.chmodSync(dir, MIRRORED_DIR_MODE);
    // The worker is root. Guarded so the unit test, which is not, exercises the
    // modes rather than dying on an ownership it cannot set.
    if (process.getuid && process.getuid() === 0) fs.chownSync(dir, 0, 0);
  }
  return dirs;
}

// Which account the web server actually runs as, and every group it is in, so a
// permission question is answered about that account rather than about root.
function webServiceAccount() {
  const configured = fs.readFileSync('/etc/nginx/nginx.conf', 'utf8').match(/^\s*user\s+([A-Za-z0-9_-]+)(?:\s+([A-Za-z0-9_-]+))?\s*;/m);
  const user = configured?.[1] || 'www-data';
  const record = passwdRecord(user);
  if (!record) throw new Error(`The nginx user ${user} does not exist`);
  const gids = new Set([record.gid, nginxGroup()]);
  for (const line of fs.readFileSync('/etc/group', 'utf8').split('\n')) {
    const parts = line.split(':');
    if (parts.length < 4) continue;
    if (parts[3].split(',').map(name => name.trim()).includes(user)) gids.add(Number(parts[2]));
  }
  return { user, uid: record.uid, gids: [...gids] };
}

// The permission bits POSIX applies to this account on this file: owner, else
// group, else other — the first match and only that one, which is why a 0750
// directory owned by root is closed to www-data however many groups it is in.
function bitsFor(stat, account) {
  if (account.uid === 0) return 7;
  if (stat.uid === account.uid) return (stat.mode >> 6) & 7;
  if (account.gids.includes(stat.gid)) return (stat.mode >> 3) & 7;
  return stat.mode & 7;
}

function modeOf(stat) { return (stat.mode & 0o7777).toString(8).padStart(4, '0'); }

// The read-back for "can this site be served at all". Walks every component of
// the document root from the filesystem root down, names the first directory the
// web server cannot enter, and then checks it can read the entry file. Returns
// null when the whole chain works, or one plain sentence saying why it does not.
// `from` is the filesystem root in production and nothing in the panel passes
// anything else: the whole chain is what matters, because one unsearchable
// directory anywhere along it is a 404. The unit test starts the walk lower
// down, because the temp directory a developer's machine hands a test is 0700
// and private to that developer, which has nothing to do with what is tested.
function documentRootAccessFailure(root, account, entryFile = null, { from = path.sep } = {}) {
  const start = path.resolve(from);
  const walk = start === path.sep ? root : path.relative(start, root);
  let cursor = start;
  for (const part of walk.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.statSync(cursor); }
    catch { return `${cursor} is not there, so the web server has nothing to serve`; }
    if (!stat.isDirectory()) return `${cursor} is not a directory, so the web server has nothing to serve`;
    if (!(bitsFor(stat, account) & 1)) {
      return `the web server runs as ${account.user} and cannot enter ${cursor}, which is mode ${modeOf(stat)} owned by ${stat.uid}:${stat.gid} — every request for this site would answer 404 until that directory can be searched`;
    }
  }
  if (entryFile && fs.existsSync(entryFile)) {
    const stat = fs.statSync(entryFile);
    if (!(bitsFor(stat, account) & 4)) {
      return `the web server runs as ${account.user} and cannot read ${entryFile}, which is mode ${modeOf(stat)} owned by ${stat.uid}:${stat.gid}`;
    }
  }
  return null;
}

function prepareDocumentRoot(site) {
  const root = documentRoot(site);
  const gid = nginxGroup();
  ensureDir(SITE_ROOT, 0o755);
  ensureDir(siteBase(site.domain), 0o750);
  ensureDir(root, 0o750);
  // Everything invented between the base and the leaf, made searchable. Without
  // this the leaf is correct and unreachable.
  ensureMirroredDocumentDirs(site);
  // Three layers, and the middle one is not an accident. The tree above stays
  // root owned and traversable because nginx has to walk into it. The site's
  // own base is root owned too, because sshd refuses to chroot into a directory
  // that its occupant can write, and that base is where SFTP lands. Only the
  // document root and the site's tmp belong to the site's user, with the web
  // server's group able to read, which is what lets nginx serve the files while
  // the neighbouring site's pool cannot open them.
  fs.chownSync(SITE_ROOT, 0, 0);
  fs.chmodSync(SITE_ROOT, 0o755);
  fs.chownSync(siteBase(site.domain), 0, 0);
  fs.chmodSync(siteBase(site.domain), 0o755);
  const owner = site.owner_uid != null ? site.owner_uid : 0;
  fs.chownSync(root, owner, gid);
  fs.chmodSync(root, 0o750);
  return { root, gid, uid: owner };
}

function readSites() {
  const state = readState(SITE_STATE, { sites: [] });
  if (!Array.isArray(state.sites)) state.sites = [];
  return state;
}

// A PHP-FPM pool per site, running as that site's own user. This is the half
// that makes the system user mean something: without it every site's PHP runs
// as www-data and can read every other site's files and database credentials,
// which is the default on a hand-built box and the thing a panel is supposed to
// stop happening.
function phpPoolPath(version, name) {
  return currentOrLegacy(`/etc/php/${version}/fpm/pool.d/jotpanel-${domain(name)}.conf`, `/etc/php/${version}/fpm/pool.d/arca-${domain(name)}.conf`);
}
function phpSocketPath(name) { return currentOrLegacy(`/run/php/jotpanel-${domain(name)}.sock`, `/run/php/arca-${domain(name)}.sock`); }

function writePhpPool(site, version, user) {
  const target = phpPoolPath(version, site.domain);
  ensureDir(path.dirname(target), 0o755);
  const openBase = `${siteBase(site.domain)}/:/tmp/:/usr/share/php/`;
  fs.writeFileSync(target, `; Managed by jotpanel-ops. Edit through the panel.
[jotpanel-${domain(site.domain)}]
user = ${user}
group = ${user}
listen = ${phpSocketPath(site.domain)}
listen.owner = ${user}
listen.group = ${nginxGroupName()}
listen.mode = 0660
pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 30s
pm.max_requests = 500
; A site cannot open a file outside its own tree, so a compromised script on one
; site is confined to that site rather than to the machine.
php_admin_value[open_basedir] = ${openBase}
php_admin_value[upload_tmp_dir] = ${siteBase(site.domain)}/tmp
php_admin_value[session.save_path] = ${siteBase(site.domain)}/tmp
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen
php_admin_flag[log_errors] = on
php_admin_value[error_log] = ${siteBase(site.domain)}/php-error.log
`, { mode: 0o644 });
  return target;
}

function removePhpPool(name) {
  const removed = [];
  for (const version of phpVersionsOnDisk()) {
    const target = phpPoolPath(version, name);
    if (fs.existsSync(target)) { fs.unlinkSync(target); removed.push(target); }
  }
  return removed;
}

function nginxGroupName() {
  for (const candidate of ['www-data', 'nginx', 'http']) {
    if (fs.readFileSync('/etc/group', 'utf8').split('\n').some(line => line.split(':')[0] === candidate)) return candidate;
  }
  return 'www-data';
}

// systemctl reload returns once the master has been signalled, not once it has
// finished. The pool socket outlives the request that removed it by a moment,
// and checking for it immediately reported a successful deletion as a failure,
// which is precisely the wrong way round for a panel whose whole claim is that
// the record is true. The nginx path above already waits for the same reason.
// The same wait, for a check that has to be awaited. A port answering is not a
// question that can be asked synchronously, and the rollback above needs to
// know whether what it put back is actually serving again.
async function waitUntilAsync(predicate, timeoutMs = 10000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(everyMs);
  }
}

async function waitUntil(predicate, timeoutMs = 10000, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(everyMs);
  }
  return predicate();
}

async function reloadPhpPool(version) {
  const unit = `php${version}-fpm.service`;
  const test = await runFile(command([`/usr/sbin/php-fpm${version}`, `/usr/sbin/php-fpm`]), ['-t'], { timeoutMs: 20000 });
  if (!test.ok && !test.missing) throw new Error(`PHP-FPM rejected the generated pool: ${firstLine(test.stderr || test.stdout)}`);
  await reloadService(unit);
  if (await serviceState(unit) !== 'active') throw new Error(`${unit} stopped after reloading the generated pool`);
  return { unit, reloaded: true };
}

function renderSite(site) {
  const root = documentRoot(site);
  const accessLog = `  access_log ${siteAccessLogPaths(domain(site.domain), {})[0]} combined;\n`;
  const names = [domain(site.domain), ...(site.aliases || []).map(domain)].join(' ');
  const challenge = `  location ^~ /.well-known/acme-challenge/ { root ${root}; }\n`;
  // A suspended site answers every request with 503 and nothing else — no PHP,
  // no protected-directory checks, no proxy to a runtime. The one exception is
  // the ACME challenge location, kept live so certificate renewal still works
  // while suspended and does not fail the moment the account is reinstated.
  const content = site.suspended
    ? `${challenge}  default_type text/plain;\n  return 503 "This account has been suspended by the hosting provider.\\n";\n`
    : site.redirect
      ? `  return 301 ${String(site.redirect).replace(/[$\\]/g, '')};\n`
      : site.runtime
        ? runtimeLocation(site, root, challenge)
        : `  root ${root};\n  index ${site.php ? 'index.php ' : ''}index.html index.htm;\n${challenge}  location / { try_files $uri $uri/ ${site.php ? '/index.php?$query_string' : '=404'}; }\n${phpLocation(site)}`;
  // Protection goes in before everything else: the server-scope directives are
  // inherited by every location including the PHP one, and the location blocks
  // use ^~ so the PHP regex cannot take a request out from under them. None of
  // that applies to a suspended site, which answers 503 before any of it runs.
  const guard = site.suspended ? { server: '', locations: '' } : protectFragments(site);
  const body = `${accessLog}${guard.server}${guard.locations}${content}`;
  let text = `# Managed by jotpanel-ops. Edit through the panel.\nserver {\n  listen 80;\n  listen [::]:80;\n  server_name ${names};\n${body}}\n`;
  const live = `/etc/letsencrypt/live/${site.domain}`;
  if (fs.existsSync(path.join(live, 'fullchain.pem')) && fs.existsSync(path.join(live, 'privkey.pem'))) {
    const httpContent = site.force_https
      ? `# Managed by jotpanel-ops. Edit through the panel.\nserver { listen 80; listen [::]:80; server_name ${names};\n${accessLog}${challenge}  return 301 https://${site.domain}$request_uri;\n}\n`
      : text;
    text = `${httpContent}server {\n  listen 443 ssl;\n  listen [::]:443 ssl;\n  server_name ${names};\n  ssl_certificate ${live}/fullchain.pem;\n  ssl_certificate_key ${live}/privkey.pem;\n${body}}\n`;
  }
  return text;
}

// Everything goes to the application, including what looks like a static file.
// Serving the document root alongside it would hand out server.js and .env to
// anybody who guessed the name, which is how a language runtime turns into a
// source-code leak.
function runtimeLocation(site, root, challenge) {
  return `  root ${root};\n${challenge}`
    + `  location / {\n`
    + `    proxy_pass http://127.0.0.1:${Number(site.runtime.port)};\n`
    + `    proxy_http_version 1.1;\n`
    + `    proxy_set_header Host $host;\n`
    + `    proxy_set_header X-Real-IP $remote_addr;\n`
    + `    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n`
    + `    proxy_set_header X-Forwarded-Proto $scheme;\n`
    + `    proxy_set_header Upgrade $http_upgrade;\n`
    + `    proxy_set_header Connection "upgrade";\n`
    + `    proxy_read_timeout 120s;\n`
    + `  }\n`;
}

// Only rendered where the site actually has a pool. A fastcgi_pass at a socket
// that does not exist is a 502 on every page, which is the button that cannot
// work wearing a different hat.
function phpLocation(site) {
  if (!site.php) return '';
  return `  location ~ \\.php$ {\n`
    + `    include snippets/fastcgi-php.conf;\n`
    + `    fastcgi_pass unix:${phpSocketPath(site.domain)};\n`
    + `  }\n`
    + `  location ~ /\\.(?!well-known).* { deny all; }\n`;
}

// nginx creates a log file it has never seen as root:root 0640, so the panel —
// which runs as `jotpanel` and is in `adm` precisely so it can read logs — cannot
// read a word of it. The stock access.log is readable only because the package
// ships it that way. So the file is made here, before nginx first opens it, with
// the ownership the reader needs. nginx appends to an existing file and leaves
// its ownership alone.
//
// Without this, website statistics cannot work on any machine at all: every
// per-site log is unreadable, the panel says so honestly on the screen, and the
// graph stays empty for ever.
function ensureSiteLog(site) {
  const file = siteAccessLogPaths(domain(site.domain), {})[0];
  try {
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o640 });
    const adm = readGroupId('adm');
    if (adm !== null) fs.chownSync(file, 0, adm);
    fs.chmodSync(file, 0o640);
  } catch (error) {
    // Not fatal. A site that serves and cannot be counted is worth more than a
    // site that refuses to exist, and the screen already says when a log cannot
    // be read.
    console.warn(`[sites] could not prepare the traffic log for ${site.domain}: ${error.message}`);
  }
}

function readGroupId(name) {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(row => row.startsWith(`${name}:`));
    const id = line && Number(line.split(':')[2]);
    return Number.isInteger(id) ? id : null;
  } catch { return null; }
}

function writeSiteConfig(site) {
  ensureDir(NGINX_AVAILABLE); ensureDir(NGINX_ENABLED); prepareDocumentRoot(site);
  ensureSiteLog(site);
  const available = siteConfigPath(site.domain);
  fs.writeFileSync(available, renderSite(site), { mode: 0o644 });
  const enabled = siteEnabledPath(site.domain);
  try { if (fs.lstatSync(enabled)) fs.unlinkSync(enabled); } catch {}
  fs.symlinkSync(available, enabled);
}

async function validateAndReloadNginx() {
  const nginx = command(['/usr/sbin/nginx', '/usr/bin/nginx', 'nginx']);
  const checked = await must(nginx, ['-t'], { timeoutMs: 30000 }, 'nginx rejected the generated virtual host');
  await reloadService('nginx.service');
  // systemctl returns once the master accepts SIGHUP; give the old workers a
  // moment to leave so the first request after an approved change sees the new
  // vhost rather than the previous generation.
  await new Promise(resolve => setTimeout(resolve, 300));
  if (await serviceState('nginx.service') !== 'active') throw new Error('nginx stopped after reloading the generated virtual host');
  return { config_test: firstLine(checked.stderr || checked.stdout), service: 'active' };
}

async function siteList() {
  const state = readSites();
  return {
    sites: state.sites.map(site => ({
      domain: site.domain,
      aliases: site.aliases || [],
      redirect: site.redirect || null,
      document_root: documentRoot(site),
      ssl: fs.existsSync(`/etc/letsencrypt/live/${site.domain}/fullchain.pem`),
      force_https: site.force_https === true,
      suspended: !!site.suspended,
      user: site.user || null,
      php: site.php || null,
      php_socket: site.php ? phpSocketPath(site.domain) : null,
      runtime: site.runtime ? { id: site.runtime.id, label: site.runtime.label || null, entry: site.runtime.entry, port: site.runtime.port, unit: site.runtime.unit } : null,
      application: site.application ? { id: site.application.id, label: site.application.label || null, installed_at: site.application.installed_at || null } : null,
      config: siteConfigPath(site.domain),
    })),
  };
}

async function siteCreate(params) {
  const name = domain(params.domain);
  const state = readSites();
  if (state.sites.some(site => site.domain === name)) throw new Error(`${name} is already configured`);
  // Refused before anything is created, so a document root this panel will not
  // serve does not leave a system user and a PHP pool behind it.
  const relativeRoot = siteRelativeRoot(params.documentRoot);

  const owner = await ensureSiteUser(name);
  // PHP is optional. A box with no PHP still gets a working static site rather
  // than a vhost pointing at a socket nothing is listening on.
  const php = await phpVersions();
  const version = php.default;

  const site = {
    domain: name, aliases: [], document_root: relativeRoot,
    redirect: null, force_https: false,
    user: owner.user, owner_uid: owner.uid,
    php: version || null,
  };
  const root = documentRoot(site);
  const { gid } = prepareDocumentRoot(site);
  ensureDir(path.join(siteBase(name), 'tmp'), 0o750);
  fs.chownSync(path.join(siteBase(name), 'tmp'), owner.uid, owner.gid);

  const index = path.join(root, version ? 'index.php' : 'index.html');
  if (!fs.existsSync(index)) {
    fs.writeFileSync(index, version ? `<?php echo "${name}\\n";\n` : `${name}\n`, { mode: 0o640 });
  }
  fs.chownSync(index, owner.uid, gid);
  fs.chmodSync(index, 0o640);

  let pool = null;
  if (version) { pool = writePhpPool(site, version, owner.user); await reloadPhpPool(version); }

  state.sites.push(site); writeSiteConfig(site); writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx();

  const after = await siteList();
  const created = after.sites.find(entry => entry.domain === name);
  if (!created || !fs.existsSync(created.config)) throw new Error(`${name} did not read back after creation`);
  // Isolation is the point, so it is checked rather than assumed: the site owns
  // its own tree, and where there is a pool it is listening on its own socket.
  if (fs.statSync(root).uid !== owner.uid) throw new Error(`${name} was created but its document root is not owned by ${owner.user}`);
  // And that the web server can actually reach it. Owning the leaf says nothing
  // about the way down to it: this panel reported "executed" for a site whose
  // intermediate directories nginx could not enter, and the only honest way to
  // stop that is to answer the serving question itself rather than a proxy for
  // it. Checked after the reload, so what is checked is the live path.
  const unreachable = documentRootAccessFailure(root, webServiceAccount(), index);
  if (unreachable) throw new Error(`${name} was created but it cannot be served: ${unreachable}`);
  if (version && !(await waitUntil(() => fs.existsSync(phpSocketPath(name)))))
    throw new Error(`${name} has a PHP pool but nothing is listening on ${phpSocketPath(name)}`);

  return { site: created, user: owner.user, php: version, pool, reload, verified: true };
}

// ── Bringing an existing site into the traffic count ──────────────
//
// A vhost gains its `access_log` line when it is written, and it is written
// when a site is created or changed. Nothing rewrites the ones that already
// existed, so on a box with a history the statistics screen reads zero and says
// the traffic is not being counted — correctly, and for ever, because nobody is
// going to edit every site to make a graph appear.
//
// Re-rendering a vhost is not free: it replaces the file, and anything somebody
// added to it by hand goes with it. So this compares what is on disk against
// what we would write, ignoring the log line itself. Identical means the file is
// still ours and can be replaced safely. Different means somebody has been in
// there, and it is left alone and reported rather than quietly overwritten.

function withoutAccessLog(text) {
  return String(text).split('\n').filter(line => !/^\s*access_log\s/.test(line)).join('\n');
}

function siteLogState(site) {
  const configPath = siteConfigPath(site.domain);
  if (!fs.existsSync(configPath)) return { domain: site.domain, counted: false, safe: false, reason: 'it has no configuration file on this machine' };
  const current = fs.readFileSync(configPath, 'utf8');
  const wanted = renderSite(site);
  if (/^\s*access_log\s/m.test(current)) {
    // Named in the configuration is not the same as readable, and "readable"
    // has to mean readable *by the panel*. This code runs as root, and root can
    // read the root:root file nginx creates, so asking the filesystem whether
    // this process may open it answers yes and the site is reported as counted
    // while the panel reads nothing. The question is the group and the mode.
    const file = siteAccessLogPaths(domain(site.domain), {})[0];
    const adm = readGroupId('adm');
    let stat = null;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat) return { domain: site.domain, counted: false, safe: true, reason: 'its traffic log has not been created yet' };
    const groupReadable = adm !== null && stat.gid === adm && (stat.mode & 0o040) !== 0;
    if (!groupReadable) {
      return { domain: site.domain, counted: false, safe: true, reason: 'its traffic log exists but this panel is not allowed to read it' };
    }
    return { domain: site.domain, counted: true, safe: true, reason: '' };
  }
  if (withoutAccessLog(current) !== withoutAccessLog(wanted)) {
    return { domain: site.domain, counted: false, safe: false, reason: 'its configuration has been edited outside the panel, so rewriting it would discard those changes' };
  }
  return { domain: site.domain, counted: false, safe: true, reason: 'its configuration predates traffic counting' };
}

async function siteStatisticsStatus() {
  const state = readSites();
  const sites = state.sites.map(siteLogState);
  return {
    sites,
    counted: sites.filter(s => s.counted).length,
    waiting: sites.filter(s => !s.counted && s.safe).length,
    blocked: sites.filter(s => !s.counted && !s.safe).length,
    verified: true,
  };
}

async function siteStatisticsEnable(params) {
  const state = readSites();
  const wanted = params.domain ? [domain(params.domain)] : state.sites.map(site => site.domain);
  const changed = [];
  const skipped = [];
  for (const name of wanted) {
    const site = state.sites.find(entry => entry.domain === name);
    if (!site) { skipped.push({ domain: name, reason: 'it is not a site on this server' }); continue; }
    const before = siteLogState(site);
    if (before.counted) { skipped.push({ domain: name, reason: 'it is already counted' }); continue; }
    if (!before.safe) { skipped.push({ domain: name, reason: before.reason }); continue; }
    // The log file too, not only the configuration. A box that installed before
    // the ownership fix has logs nginx created as root:root, which the panel
    // cannot read however correct the vhost is — so bringing a site into
    // counting has to repair the file as well as name it.
    ensureSiteLog(site);
    writeSiteConfig(site);
    changed.push(name);
  }

  // The reload happens once, after every file is written, and its own failure
  // is the answer rather than something to work around: a configuration that
  // does not test is not a configuration to reload.
  const reload = changed.length ? await validateAndReloadNginx() : { reloaded: false, reason: 'nothing needed changing' };

  // Read back off the disk rather than trusting the write, which is the rule
  // every other handler here follows.
  const after = changed.filter(name => {
    const site = readSites().sites.find(entry => entry.domain === name);
    return site && siteLogState(site).counted;
  });
  if (after.length !== changed.length) {
    throw new Error(`${changed.length - after.length} site(s) were rewritten but still carry no access log`);
  }

  return { enabled: after, skipped, reload, verified: true };
}

// Change which PHP version serves a site. The screen offering this has had
// nothing underneath it since it was written, so it was correctly hidden; the
// pool has to move to the new version's directory and the vhost has to point at
// it, and both have to be true at once or the site answers 502.
async function sitePhpSet(params) {
  const name = domain(params.domain);
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);
  const wanted = String(params.template || '').trim();
  const available = await phpVersions();
  const target = available.versions.find(entry => entry.version === wanted);
  if (!target) throw new Error(`PHP ${wanted} is not installed on this machine`);
  if (!target.running) throw new Error(`PHP ${wanted} is installed but its pool is not running`);

  const owner = siteOwner(site);
  const previous = site.php;
  removePhpPool(name);
  writePhpPool(site, wanted, owner.user);
  await reloadPhpPool(wanted);
  if (previous && previous !== wanted) await reloadPhpPool(previous);

  site.php = wanted;
  writeSiteConfig(site); writeState(SITE_STATE, state);
  await validateAndReloadNginx();

  if (!(await waitUntil(() => fs.existsSync(phpSocketPath(name)))))
    throw new Error(`${name} was moved to PHP ${wanted} but nothing is listening on its socket`);
  // Asked over HTTP, because a pool that starts and a site that serves are not
  // the same thing and 502 is exactly what this change gets wrong.
  const answered = await runFile(command(['/usr/bin/curl', '/bin/curl']),
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${name}`, 'http://127.0.0.1/'], { timeoutMs: 60000 });
  const status = Number((answered.stdout || '').trim()) || 0;
  if (status < 200 || status >= 500) throw new Error(`${name} answered ${status || 'nothing'} after moving to PHP ${wanted}`);
  return { domain: name, php: wanted, was: previous, http_status: status, verified: true };
}

// ── Moving real files in and out of a site ────────────────────────
//
// Neither direction can be done by the panel on its own. It cannot read a site
// tree, and anything it wrote there would belong to jotpanel rather than to the
// site. So a file crosses in a staging directory both halves can reach: the
// panel writes an upload there and asks for it to be placed, and asks for a
// download to be put there before it streams it out. The staging name is
// generated here and validated on the way back, so a caller never names a path.
// Staging lives inside the panel's own directory rather than the ops state
// directory. The panel runs under ProtectSystem=strict and can only write where
// it is installed, and widening that to reach /var/lib would give the web
// process more of the machine for no benefit: root can read the panel's tree
// perfectly well from this side, so the file can cross without either half
// gaining anything it did not already have.
const PANEL_USER = (process.env.JOTPANEL_PANEL_USER ?? process.env.ARCA_PANEL_USER) || 'jotpanel';
const STAGING_DIR = (process.env.JOTPANEL_PANEL_STAGING ?? process.env.ARCA_PANEL_STAGING) || '/opt/jotpanel/staging';
const STAGING_LIMIT = 2 * 1024 * 1024 * 1024;

function stagingPath(id) {
  if (!/^stage_[a-f0-9]{32}$/.test(String(id || ''))) throw new Error('That is not a staging reference');
  return path.join(STAGING_DIR, id);
}

function ensureStaging() {
  ensureDir(STAGING_DIR, 0o750);
  const panel = passwdRecord(PANEL_USER);
  if (!panel) throw new Error(`the panel user ${PANEL_USER} does not exist`);
  fs.chownSync(STAGING_DIR, panel.uid, panel.gid);
  fs.chmodSync(STAGING_DIR, 0o750);
  return STAGING_DIR;
}

// Where the panel should write an upload before asking for it to be placed.
async function stagingReserve() {
  ensureStaging();
  const id = `stage_${crypto.randomBytes(16).toString('hex')}`;
  return { id, path: stagingPath(id), limit_bytes: STAGING_LIMIT };
}

// The upload half. The file is already on disk and belongs to the panel; this
// puts it inside the site and gives it to the site's own user.
async function siteFilePlace(params) {
  const staged = stagingPath(params.staged);
  if (!fs.existsSync(staged)) throw new Error('That upload is no longer waiting to be placed');
  const stat = fs.statSync(staged);
  if (stat.size > STAGING_LIMIT) { fs.unlinkSync(staged); throw new Error('That file is larger than this panel accepts'); }
  const { site, target, relative } = sitePath(params.domain, params.path);
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new Error('A folder is already at that name');
  ensureDir(path.dirname(target), 0o750);
  // Copied then unlinked rather than renamed, because staging and the site tree
  // can be different filesystems and a rename across one fails.
  copyIntoSite(staged, target);
  fs.unlinkSync(staged);
  applySiteOwnership(site, target);
  const after = fs.statSync(target);
  if (after.size !== stat.size) throw new Error('The file did not read back at the size it was placed');
  return { domain: site.domain, path: relative, size_bytes: after.size, owner: siteOwner(site).user, verified: true };
}

// The download half. A copy the panel can read is put in staging and handed
// back by reference; the panel streams it and removes it afterwards.
async function siteFileStage(params) {
  const { site, target, relative } = sitePath(params.domain, params.path, { mustExist: true });
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error('That is a folder. Make an archive of it first.');
  if (stat.size > STAGING_LIMIT) throw new Error('That file is too large to download through the panel');
  ensureStaging();
  const id = `stage_${crypto.randomBytes(16).toString('hex')}`;
  const staged = stagingPath(id);
  fs.copyFileSync(target, staged);
  const panel = passwdRecord(PANEL_USER);
  fs.chownSync(staged, panel.uid, panel.gid);
  fs.chmodSync(staged, 0o640);
  return { id, name: path.basename(relative), size_bytes: stat.size, domain: site.domain, path: relative, staged_path: staged };
}

async function stagingDiscard(params) {
  const staged = stagingPath(params.staged);
  try { fs.unlinkSync(staged); } catch {}
  return { discarded: !fs.existsSync(staged) };
}

// Archives, because a folder cannot be downloaded and moving a site by hand one
// file at a time is what people are trying to escape.
async function siteArchiveCreate(params) {
  const source = sitePath(params.domain, params.path, { mustExist: true });
  const out = sitePath(params.domain, params.target);
  if (fs.existsSync(out.target)) throw new Error('Something is already at that name');
  if (!/\.(tar\.gz|tgz|zip)$/i.test(out.relative)) throw new Error('An archive has to be named .tar.gz or .zip');
  const zip = /\.zip$/i.test(out.relative);
  const base = path.dirname(source.target);
  const item = path.basename(source.target);
  if (zip) {
    await must(command(['/usr/bin/zip', '/bin/zip']), ['-r', '-q', out.target, item], { cwd: base, timeoutMs: 900000 }, 'the archive could not be created');
  } else {
    await must(command(['/usr/bin/tar', '/bin/tar']), ['-czf', out.target, '-C', base, item], { timeoutMs: 900000 }, 'the archive could not be created');
  }
  applySiteOwnership(source.site, out.target);
  if (!fs.existsSync(out.target)) throw new Error('The archive did not read back after creation');
  return { domain: source.site.domain, archive: out.relative, of: source.relative, size_bytes: fs.statSync(out.target).size, verified: true };
}

async function siteArchiveExtract(params) {
  const archive = sitePath(params.domain, params.path, { mustExist: true });
  const into = sitePath(params.domain, params.target || '');
  ensureDir(into.target, 0o750);
  const zip = /\.zip$/i.test(archive.relative);
  if (zip) {
    // -o would overwrite silently; this refuses instead and says which file.
    await must(command(['/usr/bin/unzip', '/bin/unzip']), ['-n', '-q', archive.target, '-d', into.target], { timeoutMs: 900000 }, 'the archive could not be extracted');
  } else {
    await must(command(['/usr/bin/tar', '/bin/tar']), ['-xzf', archive.target, '-C', into.target, '--keep-old-files'], { timeoutMs: 900000 }, 'the archive could not be extracted');
  }
  // An archive is attacker-shaped input even when the owner uploaded it, because
  // people extract things they downloaded. The class of bug is real and current:
  // cPanel shipped CVE-2026-29203, unsafe symlink handling letting a user chmod
  // an arbitrary file into a privilege escalation, and zip slip is the same idea
  // with ../ instead of a link. So rather than trusting tar and unzip to have
  // been careful, everything that came out is walked and anything pointing or
  // sitting outside the site is removed before ownership is applied to any of
  // it. Applying ownership first is what would turn a link into a privilege
  // escalation, so the order here matters.
  const escaped = [];
  const siteReal = fs.realpathSync(documentRoot(archive.site));
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let points;
        try { points = fs.realpathSync(full); } catch { points = path.resolve(dir, fs.readlinkSync(full)); }
        if (points !== siteReal && !points.startsWith(siteReal + path.sep)) {
          fs.unlinkSync(full); escaped.push(path.relative(siteReal, full));
        }
        continue; // never descend through a link
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(into.target);
  // And nothing may have landed outside the tree at all, which is zip slip.
  const realInto = fs.realpathSync(into.target);
  if (realInto !== siteReal && !realInto.startsWith(siteReal + path.sep)) {
    throw new Error('That archive extracted outside the site and has been refused');
  }

  const owner = siteOwner(archive.site);
  // -h so the link itself is changed rather than whatever it points at, and -P
  // so a symlinked directory is never descended into. Both are defaults on GNU
  // chown and both are stated because the defence depends on them.
  await must(command(['/bin/chown', '/usr/bin/chown']), ['-RhP', `${owner.uid}:${nginxGroup()}`, into.target], { timeoutMs: 300000 }, 'ownership could not be applied to the extracted files');
  const listing = await siteFileList({ domain: archive.site.domain, dir: into.relative });
  return {
    domain: archive.site.domain, archive: archive.relative, into: into.relative,
    entries: listing.count,
    // Said out loud rather than cleaned up quietly, because an archive that
    // tried to escape is something the owner should know about.
    removed_escaping_links: escaped,
    verified: true,
  };
}

// ── PostgreSQL, the second database stack ─────────────────────────
//
// The panel already half believed in Postgres and did not deliver it, which is
// the worst of both: the catalogue accepted `postgres` as an engine and the host
// backend probed for `psql`, while the only stack that could be installed was
// MariaDB and every job below spoke MySQL. Every rival free panel is MySQL only,
// so this is the same open ground the runtimes were, and the people who want it
// are the Django, Rails and Node shops who now have a runtime here and nowhere
// to put their data.
//
// The shape is deliberately the same as the MySQL half rather than a second
// mechanism: the same `arca_` prefix, the same closed character set for every
// identifier, the same statements built on standard input so that a password
// never reaches the process list, and the same read-back before anything is
// called done.
//
// The one real difference is how the panel is allowed to talk to it. MariaDB
// trusts root over its Unix socket. Postgres maps an operating system user to a
// role, and root is not the `postgres` role, so every statement goes through
// runuser as the postgres user. That is an executable from a closed list with
// fixed arguments, exactly like every other program this file invokes.

function psqlBin() { return command(['/usr/bin/psql', '/usr/local/bin/psql', 'psql']); }
function pgDumpBin() { return command(['/usr/bin/pg_dump', '/usr/local/bin/pg_dump', 'pg_dump']); }
function runuserBin() { return command(['/usr/sbin/runuser', '/usr/bin/runuser', 'runuser']); }

// -tAF gives tuples only, unaligned, tab separated, which is the same shape the
// MySQL half returns and lets both share `tsv`. ON_ERROR_STOP is what makes a
// failed statement a failed job rather than a warning nobody reads.
async function psql(sql, database = null, options = {}) {
  const args = ['-u', 'postgres', '--', psqlBin(), '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '\t', '-q'];
  if (database) args.push('-d', dbName(database));
  args.push('-f', '-');
  return must(runuserBin(), args, {
    input: `${sql}\n`,
    timeoutMs: options.timeoutMs || 60000,
    maxBuffer: options.maxBuffer,
  }, 'PostgreSQL refused the named job');
}

async function postgresProbe() {
  try {
    const result = await psql('SELECT 1');
    return { available: result.stdout.trim() === '1', engine: 'postgres', permission: 'peer authentication as the postgres role' };
  } catch (error) { return { available: false, engine: 'postgres', reason: firstLine(error.message) }; }
}

// Which engine a job should speak. An explicit choice is honoured and refused if
// that engine is not runnable, which is a better answer than quietly doing the
// work somewhere the caller did not mean. With no choice, whichever is here.
async function databaseEngine(requested) {
  const asked = requested == null || requested === '' ? null : String(requested).toLowerCase();
  if (asked && !['mysql', 'postgres'].includes(asked)) throw new Error(`${requested} is not a database engine this panel knows`);
  const [mysqlState, postgresState] = await Promise.all([mysqlProbe(), postgresProbe()]);
  if (asked === 'mysql') {
    if (!mysqlState.available) throw new Error(`MariaDB is not runnable on this machine: ${mysqlState.reason || 'install it first'}`);
    return 'mysql';
  }
  if (asked === 'postgres') {
    if (!postgresState.available) throw new Error(`PostgreSQL is not runnable on this machine: ${postgresState.reason || 'install it first'}`);
    return 'postgres';
  }
  if (mysqlState.available) return 'mysql';
  if (postgresState.available) return 'postgres';
  throw new Error(`Neither database server is runnable here. MariaDB: ${mysqlState.reason || 'not installed'}. PostgreSQL: ${postgresState.reason || 'not installed'}.`);
}

async function postgresDatabaseExists(name) {
  const clean = dbName(name);
  return tsv((await psql(`SELECT datname FROM pg_database WHERE datname = '${clean}'`)).stdout).length > 0;
}

async function postgresRoleExists(name) {
  const clean = dbName(name, 'database user');
  return tsv((await psql(`SELECT rolname FROM pg_roles WHERE rolname = '${clean}'`)).stdout).length > 0;
}

async function postgresList() {
  const rows = tsv((await psql(`SELECT datname, pg_database_size(datname) FROM pg_database WHERE datname LIKE '${DB_PREFIX}\\_%' ORDER BY datname`)).stdout);
  const roles = tsv((await psql(`SELECT rolname FROM pg_roles WHERE rolname LIKE '${DB_PREFIX}\\_%' ORDER BY rolname`)).stdout);
  const databases = [];
  for (const [name, bytes] of rows) {
    // Table counts come from inside each database, because Postgres keeps no
    // cross-database catalogue the way information_schema does in MySQL. A
    // database that cannot be entered is reported with an unknown count rather
    // than dropped from the list.
    let tables = null;
    try {
      const inside = tsv((await psql(`SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`, name)).stdout);
      tables = Number(inside[0] && inside[0][0]) || 0;
    } catch { tables = null; }
    databases.push({ name, engine: 'postgres', size_bytes: Number(bytes) || 0, tables });
  }
  return { databases, users: roles.map(([name]) => ({ name, engine: 'postgres' })) };
}

async function postgresTables(params) {
  const name = dbName(params.name);
  if (!(await postgresDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  const rows = tsv((await psql(
    `SELECT c.relname, COALESCE(c.reltuples,0)::bigint, pg_total_relation_size(c.oid) `
    + `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace `
    + `WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY c.relname`, name)).stdout);
  // reltuples is an estimate and it is -1, not 0, until the table has been
  // analysed at least once. Printing "-1 rows" at an operator is worse than
  // printing nothing, so an unanalysed table says it does not know.
  return {
    name, engine: 'postgres',
    tables: rows.map(([table, count, bytes]) => ({
      table,
      rows: Number(count) >= 0 ? Number(count) : null,
      estimated: true,
      size_bytes: Number(bytes) || 0,
    })),
  };
}

async function postgresCreate(params) {
  const name = dbName(params.name);
  if (await postgresDatabaseExists(name)) throw new Error(`${name} already exists`);
  await psql(`CREATE DATABASE "${name}" ENCODING 'UTF8'`);
  if (!(await postgresDatabaseExists(name))) throw new Error(`${name} was not present after creation`);
  return { name, engine: 'postgres', verified: true };
}

async function postgresDrop(params) {
  const name = dbName(params.name);
  if (!(await postgresDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  // Postgres refuses to drop a database anything is connected to, and the
  // refusal names no session, so the connections are closed first and said out
  // loud rather than leaving the owner with "database is being accessed".
  await psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`);
  await psql(`DROP DATABASE "${name}"`);
  if (await postgresDatabaseExists(name)) throw new Error(`${name} still exists after deletion`);
  return { name, engine: 'postgres', dropped: true, verified: true };
}

async function postgresUserCreate(params) {
  const username = dbName(params.username, 'database user');
  const password = dbPassword(params.password);
  if (await postgresRoleExists(username)) throw new Error(`${username} already exists`);
  await psql(`CREATE ROLE "${username}" LOGIN PASSWORD '${password}'`);
  if (!(await postgresRoleExists(username))) throw new Error(`${username} was not present after creation`);
  return { username, engine: 'postgres', verified: true };
}

async function postgresUserDrop(params) {
  const username = dbName(params.username, 'database user');
  if (!(await postgresRoleExists(username))) throw new Error(`There is no database user called ${username}`);

  // PostgreSQL refuses to drop a role while anything still points at it, and
  // the panel's own grant is one of the things that points at it. So a user
  // that had been given a database through this panel could never be deleted
  // through this panel: the operation failed with "some objects depend on it"
  // and named none of them. Every account the Databases screen created and
  // granted was undeletable from the screen that created it.
  //
  // What points at a role is either ownership or a privilege, and the two are
  // not the same thing at all.
  const pointsAt = tsv((await psql(`SELECT COALESCE(d.datname, ''), s.deptype
      FROM pg_shdepend s LEFT JOIN pg_database d ON d.oid = s.dbid
      WHERE s.refobjid = (SELECT oid FROM pg_roles WHERE rolname = '${username}')
      GROUP BY 1, 2`)).stdout);

  // Ownership is refused, and named. PostgreSQL offers DROP OWNED BY, which
  // would delete every table the role made, and REASSIGN OWNED BY, which would
  // hand somebody's tables to another account without saying so. Deleting a
  // login must not delete or quietly re-own data, so this stops and says what
  // is in the way.
  const owns = [...new Set(pointsAt.filter(row => row[1] === 'o').map(row => row[0] || 'this server'))];
  if (owns.length) {
    throw new Error(`${username} still owns tables or other objects in ${owns.join(', ')}. Move or delete those first: deleting a login must not delete what it made.`);
  }

  // Privileges are taken away, because the panel granted them and nothing of
  // anybody's is lost by removing them. DROP OWNED BY with nothing owned
  // removes exactly the grants and the default privileges, which is what is
  // left holding the role.
  const databases = [...new Set(pointsAt.map(row => row[0]).filter(Boolean))];
  const outside = databases.filter(name => !name.startsWith(`${DB_PREFIX}_`));
  if (outside.length) {
    throw new Error(`${username} holds access to ${outside.join(', ')}, which is outside what this panel manages. Take that away first.`);
  }
  // Once where the connection already is, which is where a database-level grant
  // is recorded, and once inside each managed database it reaches.
  await psql(`DROP OWNED BY "${username}"`);
  for (const database of databases) await psql(`DROP OWNED BY "${username}"`, database);

  await psql(`DROP ROLE "${username}"`);
  if (await postgresRoleExists(username)) throw new Error(`${username} still exists after deletion`);
  return { username, engine: 'postgres', dropped: true, privileges_removed_in: databases, verified: true };
}

async function postgresGrant(params) {
  const name = dbName(params.name);
  const username = dbName(params.username, 'database user');
  const privileges = params.privileges === 'read' ? 'read' : 'all';
  if (!(await postgresDatabaseExists(name)) || !(await postgresRoleExists(username))) {
    throw new Error('The database and user must both exist before a grant');
  }
  // Taken away before it is given, for the same reason as the MariaDB half:
  // GRANT adds and never replaces, so reducing a user from full access to
  // read-only by issuing the read-only grants leaves every write privilege
  // exactly where it was. The default privileges are revoked too, or tables
  // made after the reduction would still arrive writable.
  const revoke = [
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${username}"`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "${username}"`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "${username}"`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM "${username}"`,
    `REVOKE ALL ON SCHEMA public FROM "${username}"`,
  ];
  await psql(revoke.join(';\n'), name);
  await psql(`REVOKE ALL PRIVILEGES ON DATABASE "${name}" FROM "${username}"`);

  await psql(`GRANT ${privileges === 'read' ? 'CONNECT' : 'ALL PRIVILEGES'} ON DATABASE "${name}" TO "${username}"`);
  // The database grant alone gets a Postgres user a connection and nothing to
  // read, which is the difference that makes people think the panel is broken.
  // The schema and its tables are granted from inside the database, and the
  // default privileges are set so tables made later are reachable too.
  const inside = privileges === 'read'
    ? [`GRANT USAGE ON SCHEMA public TO "${username}"`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${username}"`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "${username}"`]
    : [`GRANT ALL ON SCHEMA public TO "${username}"`,
      `GRANT ALL ON ALL TABLES IN SCHEMA public TO "${username}"`,
      `GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${username}"`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${username}"`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${username}"`];
  await psql(inside.join(';\n'), name);

  // Read back which way the privileges point, not merely that the user can
  // connect: a user reduced to read-only can still connect, so CONNECT alone
  // answers a different question from the one being asked. Whether the role may
  // create in the schema is the difference between the two grants, and whether
  // any existing table will take an insert is the other half.
  const connects = tsv((await psql(`SELECT has_database_privilege('${username}', '${name}', 'CONNECT')`)).stdout);
  if (!(connects[0] && connects[0][0] === 't')) throw new Error(`the grant on ${name} did not read back for ${username}`);
  const shape = tsv((await psql(
    `SELECT has_schema_privilege('${username}', 'public', 'CREATE'), `
    + `COALESCE(bool_or(has_table_privilege('${username}', c.oid, 'INSERT')), false) `
    + `FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace `
    + `WHERE c.relkind = 'r' AND n.nspname = 'public'`, name)).stdout);
  const mayCreate = shape[0] && shape[0][0] === 't';
  const mayInsert = shape[0] && shape[0][1] === 't';
  if (privileges === 'all' && !mayCreate) throw new Error(`${username} did not end up with full access to ${name}`);
  if (privileges === 'read' && (mayCreate || mayInsert)) throw new Error(`${username} still holds write access to ${name} after being reduced to read-only`);
  return { name, username, engine: 'postgres', privileges, may_create: !!mayCreate, may_insert: !!mayInsert, verified: true };
}

async function postgresPasswordChange(params) {
  const username = dbName(params.username, 'database user');
  const password = dbPassword(params.password);
  if (!(await postgresRoleExists(username))) throw new Error(`There is no database user called ${username}`);
  await psql(`ALTER ROLE "${username}" WITH PASSWORD '${password}'`);
  return { username, engine: 'postgres', changed: true, verified: true };
}

async function postgresDump(params) {
  const name = dbName(params.name);
  if (!(await postgresDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  const result = await must(runuserBin(), ['-u', 'postgres', '--', pgDumpBin(), '--no-owner', '--no-privileges', name],
    { timeoutMs: 300000, maxBuffer: OUTPUT_LIMIT }, `A dump of ${name} failed`);
  return { name, engine: 'postgres', sql: result.stdout, bytes: Buffer.byteLength(result.stdout), verified: true };
}

async function postgresImport(params) {
  const name = dbName(params.name);
  const sql = String(params.sql || '');
  if (!sql.trim()) throw new Error('The SQL dump is empty');
  if (Buffer.byteLength(sql) > 256 * 1024 * 1024) throw new Error('The SQL dump exceeds 256 MB');
  if (!(await postgresDatabaseExists(name))) throw new Error(`There is no database called ${name}`);
  const before = await postgresTables({ name });
  await must(runuserBin(), ['-u', 'postgres', '--', psqlBin(), '-v', 'ON_ERROR_STOP=1', '-q', '-d', name, '-f', '-'],
    { input: sql, timeoutMs: 600000, maxBuffer: OUTPUT_LIMIT }, `The import into ${name} failed`);
  const after = await postgresTables({ name });
  return { name, engine: 'postgres', tables_before: before.tables.length, tables_after: after.tables.length, verified: true };
}

// ── One database surface over two engines ─────────────────────────
//
// The panel has one Databases screen and one set of operations, and which
// engine serves them is a property of the machine rather than of the screen.
// Each job below picks the engine the caller asked for, refuses if that engine
// is not runnable, and otherwise uses whichever one is here. Both are listed
// together, because an operator wants to know what is on their server, not
// which of two catalogues to look in.

const ENGINES = {
  mysql: {
    probe: () => mysqlProbe(), list: () => mysqlList(), tables: p => mysqlTables(p),
    create: p => mysqlCreate(p), drop: p => mysqlDrop(p),
    userCreate: p => mysqlUserCreate(p), userDrop: p => mysqlUserDrop(p),
    grant: p => mysqlGrant(p), password: p => mysqlPasswordChange(p),
    dump: p => mysqlDump(p), import: p => mysqlImport(p),
  },
  postgres: {
    probe: () => postgresProbe(), list: () => postgresList(), tables: p => postgresTables(p),
    create: p => postgresCreate(p), drop: p => postgresDrop(p),
    userCreate: p => postgresUserCreate(p), userDrop: p => postgresUserDrop(p),
    grant: p => postgresGrant(p), password: p => postgresPasswordChange(p),
    dump: p => postgresDump(p), import: p => postgresImport(p),
  },
};

async function withEngine(params, verb) {
  const engine = await databaseEngine(params.engine);
  return ENGINES[engine][verb](params);
}

// Whether this machine can serve databases at all, and which engines answer.
// The single `available` is what the capability layer reads, so a box with only
// Postgres now offers the Databases screen where before it offered nothing.
async function databaseProbe() {
  const [mysqlState, postgresState] = await Promise.all([mysqlProbe(), postgresProbe()]);
  const engines = [mysqlState, postgresState];
  const up = engines.filter(entry => entry.available);
  return {
    available: up.length > 0,
    engine: up.length ? up[0].engine : 'mysql',
    engines,
    reason: up.length ? undefined : `MariaDB: ${mysqlState.reason || 'not installed'}. PostgreSQL: ${postgresState.reason || 'not installed'}.`,
  };
}

// Both engines in one answer, and an engine that is absent is absent rather
// than an error: a machine with only Postgres should not have its database
// screen refused because MariaDB is not there.
async function databaseList() {
  const listed = [];
  for (const [engine, implementation] of Object.entries(ENGINES)) {
    const probe = await implementation.probe();
    if (!probe.available) { listed.push({ engine, available: false, reason: probe.reason, databases: [], users: [] }); continue; }
    try {
      const answer = await implementation.list();
      listed.push({ engine, available: true, databases: answer.databases, users: answer.users });
    } catch (error) {
      listed.push({ engine, available: false, reason: firstLine(error.message), databases: [], users: [] });
    }
  }
  return {
    prefix: `${DB_PREFIX}_`,
    engines: listed,
    databases: listed.flatMap(entry => entry.databases),
    users: listed.flatMap(entry => entry.users),
  };
}

const databaseTables = params => withEngine(params, 'tables');
const databaseCreate = params => withEngine(params, 'create');
const databaseDrop = params => withEngine(params, 'drop');
const databaseUserCreate = params => withEngine(params, 'userCreate');
const databaseUserDrop = params => withEngine(params, 'userDrop');
const databaseGrant = params => withEngine(params, 'grant');
const databasePasswordChange = params => withEngine(params, 'password');
const databaseDump = params => withEngine(params, 'dump');
const databaseImport = params => withEngine(params, 'import');

// ── Backups ───────────────────────────────────────────────────────
//
// The thing a host asks about first and compromises on last, because it is
// what saves them at three in the morning. Kept deliberately dull: gzipped tar
// per part, a manifest with a checksum for each, and a restore that can put
// back one file rather than the whole account. Nothing proprietary, so a
// customer can open a backup with tar on any machine and does not need this
// panel to get their own data out.
//
// Three parts, kept apart on purpose. Files, databases and mail have different
// sizes, different restore urgencies and different sensitivities, and a single
// blob forces all three to be treated as the largest and most sensitive.
const BACKUP_ROOT = (process.env.JOTPANEL_OPS_BACKUP_ROOT ?? process.env.ARCA_OPS_BACKUP_ROOT) || '/var/backups/jotpanel';
const BACKUP_PARTS = ['files', 'databases', 'mail'];
const TAR = ['/usr/bin/tar', '/bin/tar', 'tar'];

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
}

// A backup id names a directory under the backup root, so it is validated here
// rather than trusted. The catalogue already refuses anything with a slash in
// it, but this file runs as root and the rule for everything else in it is that
// it validates its own inputs instead of relying on the layer above having done
// so. The shape is the one backupStamp writes and nothing else.
function backupId(value) {
  const clean = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T[\d-]+Z$/.test(clean)) throw new Error('That is not a backup identifier');
  return clean;
}

function backupDir(dom, id) { return path.join(BACKUP_ROOT, domain(dom), backupId(id)); }

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function dirBytes(target) {
  let total = 0;
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch {} }
    }
  };
  walk(target);
  return total;
}

async function freeBytes(target) {
  try { return Number(fs.statfsSync(target).bavail) * Number(fs.statfsSync(target).bsize); }
  catch { return null; }
}

// Two backups of one domain at once delete each other's work. Retention runs at
// the end of a run and prunes by age across the whole domain, so with a small
// keep the second run prunes the archive the first has just finished, and the
// first has already reported success for something no longer on the disk. That
// is not hypothetical: it was reproduced with two concurrent runs at keep=1,
// where the newer run pruned the older run's directory and both reported
// success. The realistic version of it is a person taking a manual backup while
// the 3am timer fires.
//
// So a domain gets one backup or restore at a time. mkdir is atomic, which is
// the whole reason the lock is a directory rather than a file with a write in
// it. A lock older than any run could legitimately be is treated as abandoned,
// because a machine that lost power mid-backup must not refuse backups forever.
const BACKUP_LOCK_DIR = path.join(STATE_DIR, 'backup-locks');
const BACKUP_LOCK_STALE_MS = 3 * 60 * 60 * 1000;

async function withBackupLock(dom, run) {
  ensureDir(BACKUP_LOCK_DIR, 0o700);
  const lock = path.join(BACKUP_LOCK_DIR, `${dom}.lock`);
  let held = false;
  try { fs.mkdirSync(lock); held = true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let age = Infinity;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { age = Infinity; }
    if (age > BACKUP_LOCK_STALE_MS) {
      fs.rmSync(lock, { recursive: true, force: true });
      try { fs.mkdirSync(lock); held = true; } catch { held = false; }
    }
    if (!held) throw new Error(`Another backup or restore of ${dom} is already running. Wait for it to finish rather than starting a second one, because two at once can delete each other's archive.`);
  }
  try { return await run(); }
  finally { if (held) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* the next run treats a leftover as stale */ } } }
}

async function backupCreate(params) {
  return withBackupLock(domain(params.domain), () => backupCreateWithinLock(params));
}

async function backupCreateWithinLock(params) {
  const dom = domain(params.domain);
  const want = Array.isArray(params.parts) && params.parts.length
    ? params.parts.filter(p => BACKUP_PARTS.includes(p))
    : ['files', 'mail'];
  const databases = Array.isArray(params.databases) ? params.databases.filter(Boolean) : [];
  const suppliedRunId = String(params.runId || '');
  const runId = /^run_[a-f0-9]{20}$/.test(suppliedRunId) || /^brun_[a-f0-9]{20}$/.test(suppliedRunId)
    ? suppliedRunId : `brun_${crypto.randomBytes(10).toString('hex')}`;
  const trigger = params.trigger === 'schedule' ? 'schedule' : 'manual';
  const startedAt = new Date().toISOString();
  const sourceObservedAt = startedAt;
  const workerId = `${os.hostname()}:${process.pid}`;
  const fault = activeFault();
  const events = [];
  const artifacts = [];
  const databaseResults = [];
  let components = [];
  let dir = null;
  let stage = 'preflight';
  let faultUsed = false;

  const event = (eventType, status, details = {}) => events.push({
    key: String(events.length + 1), event_type: eventType, stage, status,
    details, occurred_at: new Date().toISOString(), worker_id: workerId,
  });
  const runTruth = extra => ({
    schema: 'arca-backup-run/v1', run_id: runId, domain: dom, trigger,
    status: extra.status, stage, started_at: startedAt,
    finished_at: extra.finished_at || null, source_observed_at: sourceObservedAt,
    verified_at: extra.verified_at || null, requested_components: want,
    bytes_total: extra.bytes_total || 0, failure_code: extra.failure_code || null,
    failure_summary: extra.failure_summary || null, worker_id: workerId,
    components, databases: databaseResults, artifacts, manifest: extra.manifest || null,
    events,
  });
  const fail = (code, summary, details = null) => {
    const finishedAt = new Date().toISOString();
    event('run_failed', 'failed', { failure_code: code, failure_summary: summary, ...(details ? { evidence: details } : {}) });
    const error = new Error(summary);
    error.code = code;
    error.backupRun = runTruth({ status: 'failed', finished_at: finishedAt, failure_code: code, failure_summary: summary });
    throw error;
  };

  event('run_started', 'running', { requested_components: want, source_observed_at: sourceObservedAt });

  try {
    // A backup of a site that is not here produced an empty archive and then
    // failed its own read-back, which sent the owner looking for a broken
    // verifier rather than a misspelled domain.
    if (!fs.existsSync(siteBase(dom)) && !fs.existsSync(path.join('/var/vmail', dom))) {
      fail('SOURCE_NOT_FOUND', `There is no site or mail for ${dom} on this server, so there is nothing to back up`);
    }
    if (want.includes('databases') && !databases.length) {
      fail('DATABASE_SELECTION_EMPTY', 'Databases were requested and no database names were supplied.');
    }

  const id = backupStamp();
  dir = backupDir(dom, id);
  ensureDir(BACKUP_ROOT, 0o700);
  ensureDir(path.join(BACKUP_ROOT, dom), 0o700);
  ensureDir(dir, 0o700);

  const sources = { files: siteBase(dom), mail: path.join('/var/vmail', dom) };
  // A backup that fills the disk is worse than no backup, because it takes the
  // running site down with it. Refuse before writing rather than halfway.
  let needed = 0;
  for (const part of want) if (sources[part] && fs.existsSync(sources[part])) needed += dirBytes(sources[part]);
  // Databases were left out of this estimate, so a box with a small site and a
  // large database was told it had room and then filled the disk anyway. The
  // dump is written uncompressed before it is gzipped, so the figure that
  // matters is the database's own size, and the server is asked for it rather
  // than it being guessed at. A database the server cannot size does not make
  // the whole backup refuse; it is simply not counted, which is the same
  // position this check was in for every database until now.
  if (want.includes('databases') && databases.length) {
    try {
      const listed = await databaseList();
      for (const name of databases) {
        const row = (listed.databases || []).find(entry => entry.name === name);
        if (row && Number.isFinite(Number(row.size_bytes))) needed += Number(row.size_bytes);
      }
    } catch { /* sizing is a courtesy; a backup is not refused because it failed */ }
  }
  const free = await freeBytes(BACKUP_ROOT);
  if (free != null && needed > free * 0.8) {
    fail('BACKUP_SPACE_INSUFFICIENT', `This backup needs roughly ${Math.round(needed / 1e6)} MB before compression and the disk has ${Math.round(free / 1e6)} MB free. Free some space or send the backup elsewhere first.`);
  }

  const parts = [];
  for (const part of want) {
    if (part === 'databases') continue;
    const source = sources[part];
    if (!source || !fs.existsSync(source)) {
      fail('COMPONENT_MISSING', `The requested ${part} component is not present for ${dom}.`);
    }
    stage = part;
    event('component_started', 'running', { component: part });
    const archive = path.join(dir, `${part}.tar.gz`);
    const partStarted = new Date().toISOString();
    try {
      await must(command(TAR), ['-czf', archive, '-C', path.dirname(source), path.basename(source)], { timeoutMs: 1800000 }, `${part} could not be archived`);
    } catch (error) { fail('ARCHIVE_WRITE_FAILED', `${part} could not be archived: ${firstLine(error.message)}`); }

    // Section 6 fault: the archive command returns zero and the worker replaces
    // its output with zero bytes. The size check below, not the command exit,
    // has to be the thing that refuses it.
    if (fault === 'empty-artifact' && !faultUsed) { fs.truncateSync(archive, 0); faultUsed = true; }
    // Section 6 fault: a previously generated artifact is made to look old.
    // No web parameter reaches this seam; it exists only when the root worker
    // was started with the explicit test-machine environment switch.
    if (fault === 'stale-artifact' && !faultUsed) {
      const old = new Date(Date.parse(sourceObservedAt) - 5 * 60 * 1000);
      fs.utimesSync(archive, old, old);
      faultUsed = true;
    }
    const stat = fs.statSync(archive);
    const factsFailure = verifyArtifactFacts({ bytes: stat.size, createdAtMs: stat.mtimeMs, sourceObservedAt });
    if (factsFailure) fail(factsFailure.code, `The ${part} artifact is not usable: ${factsFailure.summary}`);

    // Rule 2: read it back. An archive nobody has opened is a hope. The first
    // enumeration becomes the manifest inventory and the second one below is
    // compared against it after the manifest is on disk.
    let listing;
    try { listing = await must(command(TAR), ['-tzf', archive], { timeoutMs: 300000 }, `${part} archive could not be read back`); }
    catch (error) { fail(FAILURE_CODES.ARCHIVE_INVALID, `The ${part} archive cannot be completely enumerated: ${firstLine(error.message)}`); }
    const entryNames = listing.stdout.split('\n').filter(Boolean);
    if (!entryNames.length) fail(FAILURE_CODES.ARCHIVE_INVALID, `The ${part} archive contains no entries.`);
    const artifactId = `${part}-${artifacts.length + 1}`;
    const artifact = {
      id: artifactId, component: part, locator: `backup:${dom}:${id}:${path.basename(archive)}`,
      format: 'tar.gz', bytes: stat.size, sha256: sha256File(archive),
      created_at: stat.mtime.toISOString(), archive_check_status: 'passed',
      manifest_check_status: 'pending', verified_at: null, state: 'staging',
      entries: entryNames.length, entries_sha256: namesDigest(entryNames),
    };
    artifacts.push(artifact);
    parts.push({
      artifact_id: artifactId, part, file: path.basename(archive), bytes: artifact.bytes,
      entries: artifact.entries, entries_sha256: artifact.entries_sha256, sha256: artifact.sha256,
      // When this part was read, so the skew between parts is a number in the
      // record rather than something nobody can find out afterwards.
      started_at: partStarted, finished_at: new Date().toISOString(),
    });
    event('artifact_created', 'running', { component: part, artifact_id: artifactId, bytes: artifact.bytes, sha256: artifact.sha256 });
  }

  if (want.includes('databases')) {
    for (const name of databases) {
      const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '');
      if (!safe) continue;
      stage = 'database';
      const dbStarted = new Date().toISOString();
      event('component_started', 'running', { component: 'databases', database: safe });
      let expected;
      try { expected = await databaseTables({ name: safe, engine: params.engine || null }); }
      catch (error) { fail('DATABASE_INVENTORY_FAILED', `The table inventory for ${safe} could not be read before capture: ${firstLine(error.message)}`); }
      const expectedTables = (expected.tables || []).map(table => table.table).sort();
      const out = path.join(dir, `db-${safe}.sql`);
      // databaseDump() hands back the dump as a string, it has never written a
      // file itself, so this is the write the rest of the function assumed
      // already happened. Without it `out` never exists and every database
      // backup silently skipped itself here, having done a real dump and then
      // thrown it away.
      let dump;
      try { dump = await databaseDump({ name: safe, engine: expected.engine || params.engine || null }); }
      catch (error) { fail('DATABASE_DUMP_FAILED', `The dump of ${safe} failed: ${firstLine(error.message)}`); }
      let sql = dump && dump.sql ? dump.sql : '';
      // Section 6 fault: the bytes themselves are cut after the twenty-second
      // table. The object-set check therefore observes 22 of 80 from the dump
      // it would keep, rather than being handed a fabricated count.
      if (fault === 'database-object-set-mismatch' && !faultUsed) {
        sql = truncateSqlToTableCount(sql, 22);
        faultUsed = true;
      }
      if (sql) fs.writeFileSync(out, sql, { mode: 0o600 });
      const file = out;
      if (!fs.existsSync(file) || !fs.statSync(file).size) fail(FAILURE_CODES.ARTIFACT_EMPTY, `The dump of ${safe} produced an empty artifact.`);
      const capturedTables = tableNamesFromSql(sql);
      try { await must(command(['/usr/bin/gzip', '/bin/gzip', 'gzip']), ['-f', file], { timeoutMs: 600000 }, `${safe} could not be compressed`); }
      catch (error) { fail('DATABASE_ARCHIVE_INVALID', `${safe} could not be compressed: ${firstLine(error.message)}`); }
      const gz = `${file}.gz`;
      // The empty-output seam must work for a database-only policy too. A
      // test machine truncates the compressed bytes, then the ordinary size
      // check below has to refuse them without being told which fault ran.
      if (fault === 'empty-artifact' && !faultUsed) { fs.truncateSync(gz, 0); faultUsed = true; }
      if (fault === 'stale-artifact' && !faultUsed) {
        const old = new Date(Date.parse(sourceObservedAt) - 5 * 60 * 1000);
        fs.utimesSync(gz, old, old);
        faultUsed = true;
      }
      const stat = fs.statSync(gz);
      const factsFailure = verifyArtifactFacts({ bytes: stat.size, createdAtMs: stat.mtimeMs, sourceObservedAt });
      if (factsFailure) fail(factsFailure.code, `The ${safe} artifact is not usable: ${factsFailure.summary}`);
      const artifactId = `database-${safe}`;
      const artifact = {
        id: artifactId, component: 'databases', locator: `backup:${dom}:${id}:${path.basename(gz)}`,
        format: 'sql.gz', bytes: stat.size, sha256: sha256File(gz), created_at: stat.mtime.toISOString(),
        archive_check_status: 'passed', manifest_check_status: 'pending', verified_at: null, state: 'staging',
      };
      artifacts.push(artifact);
      const databaseResult = {
        database_id: safe, database: safe, engine: dump.engine || expected.engine || null,
        snapshot_started_at: dbStarted, expected_table_count: expectedTables.length,
        captured_table_count: capturedTables.length, expected_tables_digest: namesDigest(expectedTables),
        captured_tables_digest: namesDigest(capturedTables), dump_bytes: artifact.bytes,
        dump_sha256: artifact.sha256, structure_check_status: 'passed', failure_code: null,
        expected_tables: expectedTables, captured_tables: capturedTables,
      };
      databaseResults.push(databaseResult);
      parts.push({
        artifact_id: artifactId, part: 'databases', database: safe, file: path.basename(gz),
        bytes: artifact.bytes, sha256: artifact.sha256,
        started_at: dbStarted, finished_at: new Date().toISOString(),
        expected_table_count: expectedTables.length, captured_table_count: capturedTables.length,
        expected_tables_digest: databaseResult.expected_tables_digest,
        captured_tables_digest: databaseResult.captured_tables_digest,
        // A dump taken in one transaction is a real point in time. Saying so per
        // part is what lets the summary below distinguish "this database is
        // consistent with itself" from "these parts are consistent with each
        // other", which are different claims and only the first one is true.
        consistency: 'single-transaction snapshot',
      });
      event('artifact_created', 'running', { component: 'databases', database: safe, artifact_id: artifactId, bytes: artifact.bytes, sha256: artifact.sha256 });
      const objectFailure = verifyDatabaseObjectSet(expectedTables, capturedTables);
      if (objectFailure) {
        databaseResult.failure_code = objectFailure.code;
        fail(objectFailure.code, `${safe}: ${objectFailure.summary}`, objectFailure.details);
      }
    }
  }

  // What this backup is and is not consistent with. Files are archived from a
  // live tree with no snapshot and no quiesce, and each part is read at a
  // different moment, so the parts are not a single point in time and saying
  // otherwise would be the most expensive kind of lie a backup can tell. The
  // window is measured rather than described, so an operator restoring a site
  // whose database and files disagree can see exactly how far apart they were
  // read instead of guessing.
  const timed = parts.filter(entry => entry.started_at && entry.finished_at);
  const consistency = {
    parts_share_a_point_in_time: false,
    databases: 'each dump is a single-transaction snapshot, consistent with itself',
    files: 'archived from the live tree with no snapshot and no quiesce, so a file written during the archive is captured mid-write',
    window_started_at: timed.length ? timed.map(entry => entry.started_at).sort()[0] : null,
    window_finished_at: timed.length ? timed.map(entry => entry.finished_at).sort().slice(-1)[0] : null,
    window_seconds: timed.length
      ? Math.round((new Date(timed.map(e => e.finished_at).sort().slice(-1)[0]) - new Date(timed.map(e => e.started_at).sort()[0])) / 1000)
      : null,
    note: 'A change made to this account between the first and last timestamps above may be in one part of this backup and not another.',
  };

  const manifest = {
    manifest_version: 1, id, run_id: runId, domain: dom, created_at: new Date().toISOString(),
    source_observed_at: sourceObservedAt, requested_components: want,
    parts, consistency, format: 'gzipped tar and gzipped sql, openable with tar and gunzip anywhere',
  };
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  // Section 6 fault: remove an artifact from the persisted manifest. The
  // expected set remains the artifacts made above, so the verifier has to find
  // the mismatch by reading the manifest back rather than by trusting memory.
  if (fault === 'manifest-mismatch' && !faultUsed) {
    const broken = { ...manifest, parts: manifest.parts.slice(1) };
    fs.writeFileSync(manifestFile, JSON.stringify(broken, null, 2), { mode: 0o600 });
    faultUsed = true;
  }
  event('manifest_written', 'running', { artifacts: artifacts.map(artifact => artifact.id) });

  stage = 'local_verify';
  let back;
  try { back = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
  catch (error) { fail(FAILURE_CODES.MANIFEST_MISMATCH, `The manifest cannot be read back: ${firstLine(error.message)}`); }
  const setFailure = verifyManifestArtifactSet(artifacts.map(artifact => artifact.id), (back.parts || []).map(part => part.artifact_id));
  if (setFailure) fail(setFailure.code, setFailure.summary);
  for (const part of back.parts || []) {
    const artifact = artifacts.find(entry => entry.id === part.artifact_id);
    if (!artifact) fail(FAILURE_CODES.MANIFEST_MISMATCH, `The manifest names an artifact this run did not produce: ${part.artifact_id}.`);
    const file = path.join(dir, part.file);
    if (!fs.existsSync(file)) fail(FAILURE_CODES.MANIFEST_MISMATCH, `The manifest names ${part.file}, which is absent.`);
    const stat = fs.statSync(file);
    const actualSha256 = sha256File(file);
    const factsFailure = verifyArtifactFacts({
      bytes: stat.size, createdAtMs: stat.mtimeMs, sourceObservedAt,
      expectedSha256: part.sha256, actualSha256,
    });
    if (factsFailure) fail(factsFailure.code, `${part.file}: ${factsFailure.summary}`);
    if (part.part === 'databases') {
      let captured;
      try { captured = tableNamesFromSql(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }
      catch (error) { fail(FAILURE_CODES.ARCHIVE_INVALID, `${part.file} cannot be decompressed and parsed: ${firstLine(error.message)}`); }
      const result = databaseResults.find(entry => entry.database === part.database);
      const objectFailure = verifyDatabaseObjectSet(result?.expected_tables || [], captured);
      if (objectFailure) fail(objectFailure.code, `${part.database}: ${objectFailure.summary}`, objectFailure.details);
    } else {
      let listing;
      try { listing = await must(command(TAR), ['-tzf', file], { timeoutMs: 300000 }, `${part.part} archive could not be enumerated`); }
      catch (error) { fail(FAILURE_CODES.ARCHIVE_INVALID, `The ${part.part} archive cannot be completely enumerated: ${firstLine(error.message)}`); }
      const names = listing.stdout.split('\n').filter(Boolean);
      if (names.length !== part.entries || namesDigest(names) !== part.entries_sha256) {
        fail(FAILURE_CODES.MANIFEST_MISMATCH, `The ${part.part} archive contents do not match the manifest.`);
      }
    }
    artifact.manifest_check_status = 'passed';
    artifact.verified_at = new Date().toISOString();
    artifact.state = 'verified';
    event('artifact_verified', 'verifying', { component: artifact.component, artifact_id: artifact.id, bytes: artifact.bytes, sha256: artifact.sha256 });
  }

  components = want.map(component => {
    const held = artifacts.filter(artifact => artifact.component === component);
    const dbs = component === 'databases' ? databaseResults : [];
    const timed = parts.filter(part => part.part === component);
    return {
      component, status: 'verified', artifact_count: held.length,
      bytes: held.reduce((sum, artifact) => sum + artifact.bytes, 0),
      started_at: timed.map(part => part.started_at).filter(Boolean).sort()[0] || startedAt,
      finished_at: timed.map(part => part.finished_at).filter(Boolean).sort().slice(-1)[0] || new Date().toISOString(),
      expected_object_count: component === 'databases' ? dbs.reduce((sum, item) => sum + item.expected_table_count, 0) : null,
      captured_object_count: component === 'databases' ? dbs.reduce((sum, item) => sum + item.captured_table_count, 0) : null,
      source_timestamp: sourceObservedAt,
    };
  });

  const manifestSha256 = sha256File(manifestFile);
  const manifestEvidence = { version: 1, sha256: manifestSha256, created_at: back.created_at, body: back };
  event('verification_succeeded', 'succeeded', { artifacts: artifacts.length, manifest_sha256: manifestSha256 });

  // Retention happens only after local verification. Pruning before the checks
  // could delete the last good recovery point and then discover that its
  // replacement was empty or stale, which is the exact order this feature is
  // here to prevent.
  const keep = Math.min(Math.max(parseInt(params.keep, 10) || 7, 1), 90);
  const all = fs.readdirSync(path.join(BACKUP_ROOT, dom)).filter(n => /^\d{4}-/.test(n)).sort();
  const pruned = [];
  while (all.length > keep) {
    const oldest = all.shift();
    if (oldest === id) continue;
    fs.rmSync(path.join(BACKUP_ROOT, dom, oldest), { recursive: true, force: true });
    pruned.push(oldest);
  }
  // Age is a second bound, independent of the count. A backup older than the
  // configured maximum goes even when it is one of the few kept, because that
  // maximum is what the promise about deleted records waiting in backups says.
  // A misconfigured maximum is recorded, not allowed to fail a run whose
  // backup has just been verified: the catch below would destroy it.
  const { expireBackups } = require('./backupExpiry');
  try {
    for (const gone of expireBackups({ root: BACKUP_ROOT, domain: dom, event: (type, _domain, details) => event(type, 'succeeded', details) }).expired) {
      if (gone.backup !== id && !pruned.includes(gone.backup)) pruned.push(gone.backup);
    }
  } catch (error) { event('backup_expiry_refused', 'failed', { reason: error.message }); }

  const finishedAt = new Date().toISOString();
  const bytesTotal = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  const truth = runTruth({
    status: 'succeeded', finished_at: finishedAt, verified_at: finishedAt,
    bytes_total: bytesTotal, manifest: manifestEvidence,
  });
  return {
    ...back, pruned, kept: keep, archived: artifacts.length, kept_on_disk: true,
    bytes_total: bytesTotal, verified: true, run_truth: truth,
  };
  } catch (error) {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a rejected staging area is never listed as a backup */ }
      try { fs.rmdirSync(path.join(BACKUP_ROOT, dom)); } catch { /* other backups live there */ }
    }
    for (const artifact of artifacts) {
      artifact.state = 'rejected';
      artifact.manifest_check_status = artifact.manifest_check_status === 'passed' ? 'passed' : 'failed';
    }
    if (error.backupRun) {
      error.backupRun.artifacts = artifacts;
      error.backupRun.databases = databaseResults;
      error.backupRun.components = components;
      throw error;
    }
    const summary = firstLine(error.message);
    const finishedAt = new Date().toISOString();
    event('run_failed', 'failed', { failure_code: error.code || 'BACKUP_EXECUTION_FAILED', failure_summary: summary });
    error.code = error.code || 'BACKUP_EXECUTION_FAILED';
    error.backupRun = runTruth({ status: 'failed', finished_at: finishedAt, failure_code: error.code, failure_summary: summary });
    throw error;
  }
}

function readManifest(dom, id) {
  const file = path.join(backupDir(dom, id), 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('That backup is not on this machine');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Putting a backup that came back from an offsite destination into the local
// backup store, so the ordinary restore path can be used on it.
//
// This is the only way an archive from outside ever enters that store, and it
// is deliberately narrow. It refuses to touch a backup id that already exists,
// because a recovery that silently wrote over the copy already on this machine
// would destroy the very thing somebody would fall back to if the recovery
// turned out to be wrong. It checks every file before anything is moved: the
// hash the caller expects where one is known, and in every case that the
// archive is a readable gzip whose table of contents can be listed, because a
// truncated download is still a file and still has a size.
async function backupOffsiteStage(params) {
  const dom = domain(params.domain);
  // Checked here rather than trusted from the caller. `text()` is a catalogue
  // helper and does not exist on this side of the socket, which is the whole
  // point of this side validating for itself: nothing that crosses is believed.
  const id = String(params.id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(id)) throw new Error(`${params.id} is not a backup identifier`);
  const files = Array.isArray(params.files) ? params.files : [];
  if (!files.length) throw new Error('there are no files to put back');

  const target = path.join(BACKUP_ROOT, dom, id);
  if (fs.existsSync(target)) {
    throw new Error(`${id} is already a backup of ${dom} on this machine, and a recovery will not write over it. Remove it deliberately first, or restore from the copy you already have.`);
  }

  // Everything is checked while it is still in staging. Nothing lands in the
  // backup store until every file has passed, so a failure halfway leaves the
  // store exactly as it was rather than half a backup that looks whole.
  const checked = [];
  for (const entry of files) {
    const staged = stagingPath(String(entry.staged || ''));
    if (!fs.existsSync(staged)) throw new Error('that download is no longer waiting to be put back');
    // The name a destination holds is the download name `backup.fetch` builds,
    // `<domain>-<id>-<file>`, and the backup store wants the plain `<file>` the
    // manifest names. Putting the download name back would produce a directory
    // full of correct archives that no restore can read, which is exactly what
    // happened the first time this was run end to end: every byte arrived and
    // the restore said the backup was not on this machine.
    const downloadName = path.basename(String(entry.filename || ''));
    if (!downloadName || downloadName.includes('/') || downloadName.startsWith('.')) throw new Error(`${entry.filename} is not a name this will write`);
    const prefix = `${dom}-${id}-`;
    const name = downloadName.startsWith(prefix) ? downloadName.slice(prefix.length) : downloadName;
    if (!name || name.startsWith('.')) throw new Error(`${entry.filename} is not a name this will write`);
    const bytes = fs.statSync(staged).size;
    if (!bytes) throw new Error(`${name} came back empty, so it is not a backup`);

    if (entry.sha256) {
      const digest = await sha256OfFile(staged);
      if (digest !== String(entry.sha256)) {
        throw new Error(`${name} does not match the copy this panel recorded: expected ${entry.sha256} and got ${digest}. Nothing has been restored.`);
      }
    }
    // Structure, always, hash or no hash. Restoring onto a rebuilt machine is
    // exactly the case where no local record survives to compare against, and
    // it is also exactly the case where being handed a truncated file matters
    // most.
    if (/\.t(ar\.)?gz$/i.test(name)) {
      const listed = await runFile(command(['/bin/tar', '/usr/bin/tar']), ['-tzf', staged], { timeoutMs: 120000, maxBuffer: 8 * 1024 * 1024 });
      if (!listed.ok) throw new Error(`${name} is not a readable archive, so it was not put back: ${firstLine(listed.stderr || listed.stdout)}`);
      if (!String(listed.stdout || '').trim()) throw new Error(`${name} is a readable archive with nothing in it`);
    }
    checked.push({ staged, name, bytes, sha256: entry.sha256 || null });
  }

  ensureDir(path.join(BACKUP_ROOT, dom), 0o700);
  ensureDir(target, 0o700);
  const placed = [];
  try {
    for (const file of checked) {
      const to = path.join(target, file.name);
      // Copied then unlinked rather than renamed: staging and the backup store
      // can be on different filesystems and a rename across one fails.
      fs.copyFileSync(file.staged, to);
      fs.chmodSync(to, 0o600);
      placed.push(to);
    }
  } catch (error) {
    // A half-written recovery is removed rather than left looking like a
    // backup. The store is put back exactly as it was found.
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* nothing else to do */ }
    throw error;
  }
  // The staged copies go whether this worked or not, so a download of somebody
  // else's data is not left sitting in a shared directory.
  for (const file of checked) { try { fs.unlinkSync(file.staged); } catch { /* already gone */ } }

  const after = fs.existsSync(target) ? fs.readdirSync(target) : [];
  if (after.length !== checked.length) throw new Error(`${id} did not read back with all ${checked.length} of its files`);
  // Read back the way every other reader will read it. A directory of archives
  // with no manifest is a pile of files: `backup.list` will not show it and a
  // restore will say the backup is not on this machine, so it is refused here
  // rather than left looking like a recovery that worked.
  try { readManifest(dom, id); } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error(`what came back for ${id} is not a usable backup: ${error.message}`);
  }
  return { domain: dom, id, files: after.length, bytes: checked.reduce((n, f) => n + f.bytes, 0), verified: true };
}

async function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function backupList(params) {
  const root = BACKUP_ROOT;
  if (!fs.existsSync(root)) return { backups: [], root, verified: true };
  const wanted = params && params.domain ? domain(params.domain) : null;
  const backups = [];
  for (const dom of fs.readdirSync(root)) {
    if (wanted && dom !== wanted) continue;
    const domDir = path.join(root, dom);
    if (!fs.statSync(domDir).isDirectory()) continue;
    for (const id of fs.readdirSync(domDir).sort().reverse()) {
      try {
        const manifest = readManifest(dom, id);
        const archived = (manifest.parts || []).filter(p => p.file);
        const bytes = archived.reduce((n, p) => n + (p.bytes || 0), 0);
        // A part that was skipped is not in this backup, so it does not get
        // listed as though it were. It is named separately with its reason.
        backups.push({
          id, domain: dom, created_at: manifest.created_at, bytes,
          parts: archived.map(p => p.database ? `${p.part}:${p.database}` : p.part),
          skipped: (manifest.parts || []).filter(p => p.skipped).map(p => ({ part: p.database ? `${p.part}:${p.database}` : p.part, reason: p.skipped })),
          empty: archived.length === 0,
        });
      } catch { /* a directory that is not a backup is not a finding */ }
    }
  }
  return { backups, root, verified: true };
}

// What is inside, so a person can restore one file instead of an account.
async function backupContents(params) {
  const dom = domain(params.domain);
  const manifest = readManifest(dom, String(params.id || ''));
  const part = String(params.part || 'files');
  const entry = (manifest.parts || []).find(p => p.part === part && !p.database);
  if (!entry || !entry.file) throw new Error(`This backup has no ${part} archive`);
  const listing = await must(command(TAR), ['-tzf', path.join(backupDir(dom, manifest.id), entry.file)], { timeoutMs: 300000 }, 'the archive could not be listed');
  const files = listing.stdout.split('\n').filter(Boolean);
  return { id: manifest.id, domain: dom, part, count: files.length, files: files.slice(0, 5000), truncated: files.length > 5000, verified: true };
}

// ── All three records, one action ─────────────────────────────────
//
// The whole point. Each piece worked on its own and the customer still had to
// know that mail authentication is three separate records, that one of them
// needs a signing key generated first, and that a second SPF record breaks the
// first. Nobody should have to know any of that.
async function mailAuthSetup(params) {
  const dom = domain(params.domain);
  // Install what this needs rather than reporting what is absent. The customer
  // asked for their mail to be trusted; being told that requires OpenDKIM and
  // a name server, and being left to go and get them, is the panel handing its
  // own job back. The summary says what will be installed before anybody
  // approves it, so nothing arrives on the machine unannounced.
  const installed = [];
  for (const [stack, why] of [['dkim', 'to sign the mail'], ['dns', 'to publish the records']]) {
    try {
      await stackProbe({ stack });
    } catch {
      try {
        await runPrivilegedOneshot(`stack-${stack}`, `install the ${stack} stack for mail authentication`);
        await stackProbe({ stack });
        installed.push(`${stack === 'dkim' ? 'OpenDKIM' : 'BIND'} was installed ${why}`);
      } catch (e) { /* reported below, where the step that needed it fails */ }
    }
  }
  const policy = ['none', 'quarantine', 'reject'].includes(String(params.policy)) ? String(params.policy) : 'none';
  const reportTo = String(params.reportTo || `dmarc@${dom}`).trim();
  const selector = String(params.selector || 'jotpanel').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jotpanel';
  const done = [];
  const left = [];

  // 1. Signing. Without a key there is nothing to publish and nothing signs.
  let dkimValue = null;
  try {
    const signed = await dkimEnableNative({ domain: dom, selector });
    dkimValue = signed.dns_value;
    done.push(`mail from this server is signed for ${dom}`);
  } catch (e) {
    left.push(`signing is not set up: ${firstLine(e.message)}`);
  }

  // 2. The three records, into our own zone when we hold it.
  const holdsZone = !!readZone(dom);
  const records = [
    { label: '@', type: 'TXT', value: 'v=spf1 mx a -all', what: 'SPF' },
    ...(dkimValue ? [{ label: `${selector}._domainkey`, type: 'TXT', value: dkimValue, what: 'DKIM' }] : []),
    // Starting at none is not timidity. Starting at reject is how a company
    // instructs the world to throw away its own invoices before it has seen a
    // single report telling it which of its senders is failing.
    { label: '_dmarc', type: 'TXT', value: `v=DMARC1; p=${policy}; rua=mailto:${reportTo}; adkim=r; aspf=r; pct=100`, what: 'DMARC' },
  ];

  const published = [];
  const toPublish = [];
  for (const record of records) {
    if (!holdsZone) { toPublish.push({ name: `${record.label === '@' ? '' : record.label + '.'}${dom}`, type: 'TXT', value: record.value, what: record.what }); continue; }
    try {
      await dnsRecordWrite({ zone: dom, label: record.label, type: record.type, value: record.value });
      published.push(record.what);
    } catch (e) {
      left.push(`${record.what} could not be published: ${firstLine(e.message)}`);
      toPublish.push({ name: `${record.label === '@' ? '' : record.label + '.'}${dom}`, type: 'TXT', value: record.value, what: record.what });
    }
  }
  if (published.length) done.push(`${published.join(', ')} published in the zone this server holds`);

  // 3. Somewhere for the reports to land, if it is our own address.
  const reportDomain = (reportTo.split('@')[1] || '').toLowerCase();
  let mailbox = null;
  if (reportDomain === dom) {
    const account = reportTo.split('@')[0].toLowerCase();
    const home = path.join('/var/vmail', dom, account);
    mailbox = { address: reportTo, exists: fs.existsSync(home) };
    if (!mailbox.exists) left.push(`${reportTo} does not exist yet, so the reports have nowhere to land. Create that mailbox.`);
    else done.push(`reports will arrive at ${reportTo}`);
  }

  return {
    domain: dom, policy, selector, report_to: reportTo,
    holds_zone: holdsZone,
    published,
    publish_yourself: toPublish,
    mailbox,
    installed,
    done: [...installed, ...done], outstanding: left,
    summary: left.length
      ? `${done.length ? done.join('; ') + '. ' : ''}Still to do: ${left.join('; ')}.`
      : `${dom} is signed, and SPF, DKIM and DMARC are published. Leave the policy at ${policy} until the reports show everything of yours passing.`,
    // Verified means something actually changed on this machine. Handing back
    // three strings to paste is a useful answer and it is not a change.
    verified: published.length > 0 || !!dkimValue,
  };
}

// ── Giving the panel its name, after the fact ─────────────────────
//
// A machine has an address before it has a name, and an image in a provider's
// marketplace cannot know the name at all, so the install no longer demands
// one. This is the other half: attaching a domain later, from inside, without
// anybody editing nginx by hand.
const JOTPANEL_ENV = (process.env.JOTPANEL_ENV_FILE ?? process.env.ARCA_ENV_FILE) || '/opt/jotpanel/.env';
const CERTBOT = ['/usr/bin/certbot', '/usr/local/bin/certbot', 'certbot'];

async function panelDomainSet(params) {
  const name = domain(params.domain);
  const email = String(params.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A contact address is needed for the certificate');

  // Refuse before certbot does. A name that does not point here cannot be
  // certified, and finding that out from certbot's own error is a worse way to
  // learn it than being told plainly.
  const dnsMod = require('dns').promises;
  let pointsHere = false;
  let sawAddresses = [];
  try {
    sawAddresses = await dnsMod.resolve4(name);
    const mine = [];
    const nets = require('os').networkInterfaces();
    for (const list of Object.values(nets)) for (const iface of list || []) if (iface.family === 'IPv4' && !iface.internal) mine.push(iface.address);
    let publicIp = null;
    try {
      const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(6000) });
      if (res.ok) publicIp = (await res.text()).trim();
    } catch {}
    if (publicIp) mine.push(publicIp);
    pointsHere = sawAddresses.some(a => mine.includes(a));
  } catch (e) {
    throw new Error(`${name} does not resolve yet, so a certificate cannot be issued for it. Point it at this machine first.`);
  }
  if (!pointsHere) {
    throw new Error(`${name} resolves to ${sawAddresses.join(', ')}, which is not this machine. Point it here first, then try again.`);
  }

  // nginx: give the panel's own server block the name.
  //
  // This used to look for `arca.conf` or `arca` by name. The installer writes
  // `arca-tls.conf`, so the loop matched nothing, the block kept `server_name _`
  // and certbot — which chooses a block by matching the name it was given —
  // could not find ours and attached the certificate to nginx's stock default
  // instead. The result was a name with a real certificate serving an empty
  // webroot, and a panel still answering only on the address. The operation
  // reported failure, correctly, because the health check afterwards could not
  // reach the panel on the new name. It had simply never worked on a box built
  // by this installer, which is why every document said to use --domain at
  // install: nobody had run the other path.
  //
  // So the block is found by what it is rather than what it is called: the one
  // that proxies to the panel's own port. A file can be renamed; what it does
  // cannot.
  const available = '/etc/nginx/sites-available';
  const panelPort = String((process.env.JOTPANEL_PANEL_UPSTREAM_PORT ?? process.env.ARCA_PANEL_UPSTREAM_PORT) || '9999');
  let named = 0;
  for (const file of fs.existsSync(available) ? fs.readdirSync(available) : []) {
    const full = path.join(available, file);
    let body;
    try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
    if (!body.includes(`proxy_pass http://127.0.0.1:${panelPort}`)) continue;
    fs.writeFileSync(full, body.replace(/server_name\s+[^;]+;/g, `server_name ${name};`), { mode: 0o644 });
    named += 1;
  }
  if (!named) {
    throw new Error(`No nginx server block on this machine proxies to the panel on port ${panelPort}, so there is nothing to give the name ${name} to.`);
  }
  await must(command(['/usr/sbin/nginx', '/usr/bin/nginx', 'nginx']), ['-t'], { timeoutMs: 20000 }, 'the new server name did not pass nginx\'s own check');
  await must('/usr/bin/systemctl', ['reload', 'nginx'], { timeoutMs: 30000 }, 'nginx would not reload');

  const args = ['--nginx', '--non-interactive', '--agree-tos', '--redirect', '--hsts', '-m', email, '-d', name];
  if (params.staging) args.push('--staging');
  await must(command(CERTBOT), args, { timeoutMs: 600000 }, `the certificate for ${name} could not be issued`);

  // The panel's own idea of where it lives.
  if (fs.existsSync(JOTPANEL_ENV)) {
    let env = fs.readFileSync(JOTPANEL_ENV, 'utf8');
    env = env.includes('\nDOMAIN=') || env.startsWith('DOMAIN=')
      ? env.replace(/^DOMAIN=.*$/m, `DOMAIN=${name}`)
      : `${env.replace(/\s*$/, '')}\nDOMAIN=${name}\n`;
    env = env.includes('JOTPANEL_PUBLIC_ORIGIN=')
      ? env.replace(/^JOTPANEL_PUBLIC_ORIGIN=.*$/m, `JOTPANEL_PUBLIC_ORIGIN=https://${name}`)
      : `${env.replace(/\s*$/, '')}\nJOTPANEL_PUBLIC_ORIGIN=https://${name}\n`;
    fs.writeFileSync(JOTPANEL_ENV, env, { mode: 0o640 });
  }
  // Rule 2, and before the restart rather than after it. nginx is what serves
  // the certificate, so the new name can be proved without touching the panel
  // process at all.
  let served = false;
  let reason = null;
  for (let attempt = 0; attempt < 8 && !served; attempt++) {
    await new Promise(r => setTimeout(r, 1200));
    try {
      const res = await fetch(`https://${name}/health`, { signal: AbortSignal.timeout(8000) });
      served = res.ok;
    } catch (e) { reason = firstLine(e.message); }
  }
  if (!served) throw new Error(`The certificate was issued and https://${name}/health did not answer${reason ? `: ${reason}` : ''}`);

  // The panel reads its own name at boot, so it has to come back to pick the
  // new one up. Restarting it in the middle of the request that asked for the
  // restart kills that request, and the operator sees a dead connection rather
  // than the result. So it is handed to systemd a little way out, which is long
  // enough for this answer to reach whoever asked for it.
  //
  // It was five seconds, and five seconds was not enough. Watched on the box on
  // 2026-08-24: the answer has to get back from the privileged unit to the
  // panel, the panel has to write the outcome into the action record and then
  // reply, and the restart fired in the middle of that. The operator saw a
  // refused connection, and the record came back after the restart saying the
  // action was interrupted and that the panel would not guess whether it had
  // worked. Which was honest, and was also a permanently unverifiable operation
  // caused by a timer that could simply be longer.
  await runFile('/usr/bin/systemd-run', [
    '--unit', 'jotpanel-domain-restart',
    '--on-active', '25',
    '--description', 'Restart the panel under its new name',
    '/usr/bin/systemctl', 'restart', 'jotpanel',
  ], { timeoutMs: 20000 });

  return {
    domain: name, https: true, origin: `https://${name}`,
    note: 'The panel restarts in a few seconds to pick up its new name. If the page goes blank, reload it.',
    verified: true,
  };
}

// ── DKIM signing ──────────────────────────────────────────────────
//
// The panel could tell you DKIM was missing and could not give you one, which
// is a diagnosis without a cure. OpenDKIM rather than Rspamd because this is
// one job: Postfix hands every outgoing message to a signer over a local
// socket, the signer looks the domain up in two small tables and signs. Spam
// filtering is a different feature and folding the two together would make
// both harder to fix.
const OPENDKIM_DIR = '/etc/opendkim';
const OPENDKIM_KEYS = path.join(OPENDKIM_DIR, 'keys');
const OPENDKIM_KEYTABLE = path.join(OPENDKIM_DIR, 'KeyTable');
const OPENDKIM_SIGNTABLE = path.join(OPENDKIM_DIR, 'SigningTable');
const OPENDKIM_TRUSTED = path.join(OPENDKIM_DIR, 'TrustedHosts');
const OPENDKIM_CONF = '/etc/opendkim.conf';
const OPENDKIM_SOCKET = 'inet:8891@127.0.0.1';
const GENKEY = ['/usr/sbin/opendkim-genkey', '/usr/bin/opendkim-genkey', 'opendkim-genkey'];

function opendkimUser() {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find(l => l.startsWith('opendkim:'));
    if (!line) return null;
    const parts = line.split(':');
    return { uid: Number(parts[2]), gid: Number(parts[3]) };
  } catch { return null; }
}

// Written whole rather than patched, so a half-edited config from an earlier
// version cannot survive into this one.
function writeOpendkimConfig() {
  fs.writeFileSync(OPENDKIM_CONF, [
    '# Written by JotPanel.',
    'Syslog                  yes',
    'UMask                   007',
    'Mode                    sv',
    'Canonicalization        relaxed/simple',
    'OversignHeaders         From',
    'SubDomains              no',
    `Socket                  ${OPENDKIM_SOCKET}`,
    'PidFile                 /run/opendkim/opendkim.pid',
    'UserID                  opendkim',
    `KeyTable                ${OPENDKIM_KEYTABLE}`,
    `SigningTable            refile:${OPENDKIM_SIGNTABLE}`,
    `ExternalIgnoreList      ${OPENDKIM_TRUSTED}`,
    `InternalHosts           ${OPENDKIM_TRUSTED}`,
    '',
  ].join('\n'), { mode: 0o644 });
  if (!fs.existsSync(OPENDKIM_TRUSTED)) {
    fs.writeFileSync(OPENDKIM_TRUSTED, ['127.0.0.1', '::1', 'localhost', ''].join('\n'), { mode: 0o644 });
  }
  for (const file of [OPENDKIM_KEYTABLE, OPENDKIM_SIGNTABLE]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o644 });
  }
}

function dkimRecordFromFile(file) {
  // opendkim-genkey writes a BIND fragment split across quoted chunks. The
  // value a person needs is those chunks joined, without the quotes.
  const body = fs.readFileSync(file, 'utf8');
  const quoted = body.match(/"([^"]*)"/g) || [];
  return quoted.map(part => part.slice(1, -1)).join('').trim();
}

async function dkimEnableNative(params) {
  const dom = domain(params.domain);
  const selector = String(params.selector || 'jotpanel').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jotpanel';
  const owner = opendkimUser();
  if (!owner) throw new Error('OpenDKIM is not installed on this server');

  ensureDir(OPENDKIM_DIR, 0o755);
  // The directory as well as the key. A 0600 key owned by opendkim is no use
  // inside a 0750 directory owned root:root, because the signer cannot traverse
  // in to reach it, and the failure is not a permission message anybody sees:
  // OpenDKIM logs "can't load key", tempfails the message, and Postfix answers
  // 451 Service unavailable. Every message this server tried to sign for its
  // own domains was rejected, and nothing in the panel said so. This is the
  // same trap that was already fixed once for nginx and the protected
  // directories, in a different file.
  ensureDir(OPENDKIM_KEYS, 0o750);
  try { fs.chownSync(OPENDKIM_KEYS, 0, owner.gid); } catch { /* left as it is rather than widened */ }
  writeOpendkimConfig();

  const dir = path.join(OPENDKIM_KEYS, dom);
  ensureDir(dir, 0o750);
  const priv = path.join(dir, `${selector}.private`);
  const txt = path.join(dir, `${selector}.txt`);
  if (!fs.existsSync(priv)) {
    await must(command(GENKEY), ['-b', '2048', '-d', dom, '-s', selector, '-D', dir], { timeoutMs: 120000 }, 'the signing key could not be generated');
  }
  fs.chownSync(dir, owner.uid, owner.gid);
  fs.chownSync(priv, owner.uid, owner.gid);
  fs.chmodSync(priv, 0o600);

  const keyLine = `${selector}._domainkey.${dom} ${dom}:${selector}:${priv}`;
  const signLine = `*@${dom} ${selector}._domainkey.${dom}`;
  for (const [file, line] of [[OPENDKIM_KEYTABLE, keyLine], [OPENDKIM_SIGNTABLE, signLine]]) {
    const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!body.split('\n').some(l => l.trim() === line)) fs.writeFileSync(file, `${body.replace(/\s*$/, '')}\n${line}\n`.replace(/^\n/, ''), { mode: 0o644 });
  }

  // Postfix has to hand mail over, or the key exists and nothing is signed.
  const postconf = command(['/usr/sbin/postconf', '/usr/bin/postconf', 'postconf']);
  for (const [key, value] of [
    ['milter_default_action', 'accept'],
    ['milter_protocol', '6'],
    ['smtpd_milters', OPENDKIM_SOCKET.replace('@', ':').replace('inet:8891:127.0.0.1', 'inet:127.0.0.1:8891')],
    ['non_smtpd_milters', 'inet:127.0.0.1:8891'],
  ]) await must(postconf, ['-e', `${key} = ${value}`], { timeoutMs: 20000 }, `Postfix refused ${key}`);

  await must('/usr/bin/systemctl', ['enable', '--now', 'opendkim'], { timeoutMs: 60000 }, 'OpenDKIM would not start');
  await must('/usr/bin/systemctl', ['restart', 'opendkim'], { timeoutMs: 60000 }, 'OpenDKIM would not restart with the new key');
  await must('/usr/bin/systemctl', ['reload-or-restart', 'postfix'], { timeoutMs: 60000 }, 'Postfix would not pick up the signer');

  // Rule 2, both halves: the signer is up and Postfix is pointed at it.
  const running = await systemctlShow('opendkim.service', 'ActiveState');
  if (!/active/i.test(running)) throw new Error('The key was written and OpenDKIM is not running, so nothing is being signed');
  const milters = await runFile(postconf, ['-h', 'smtpd_milters'], { timeoutMs: 15000 });
  if (!/8891/.test(milters.stdout || '')) throw new Error('OpenDKIM is running and Postfix is not handing mail to it');

  const record = fs.existsSync(txt) ? dkimRecordFromFile(txt) : null;
  return {
    domain: dom, selector, signing: true,
    dns_name: `${selector}._domainkey.${dom}`,
    dns_type: 'TXT',
    dns_value: record,
    note: 'Mail from this server is signed from now on. It only counts once the record above is published in DNS.',
    verified: true,
  };
}

async function dkimShowNative(params) {
  const dom = domain(params.domain);
  const dir = path.join(OPENDKIM_KEYS, dom);
  if (!fs.existsSync(dir)) return { domain: dom, signing: false, keys: [], verified: true };
  const keys = fs.readdirSync(dir).filter(n => n.endsWith('.txt')).map(name => {
    const selector = name.replace(/\.txt$/, '');
    return {
      selector,
      dns_name: `${selector}._domainkey.${dom}`,
      dns_type: 'TXT',
      dns_value: dkimRecordFromFile(path.join(dir, name)),
    };
  });
  const running = fs.existsSync(OPENDKIM_CONF);
  return { domain: dom, signing: keys.length > 0 && running, keys, verified: true };
}

// ── DNS, written rather than only read ────────────────────────────
//
// Zones live in one directory of our own and are pulled in by a single include
// line, so nothing this panel writes ever lands inside the distribution's own
// configuration and an uninstall leaves BIND as it was found. Every change is
// checked by named-checkzone before it is loaded, because a zone file with one
// bad line takes the whole server down and takes every other domain with it.
const ZONE_DIR = (process.env.JOTPANEL_OPS_ZONE_DIR ?? process.env.ARCA_OPS_ZONE_DIR) || '/etc/bind/jotpanel-zones';
const ZONE_INCLUDE = '/etc/bind/named.conf.jotpanel';
const RNDC = ['/usr/sbin/rndc', '/usr/bin/rndc', 'rndc'];
const CHECKZONE = ['/usr/sbin/named-checkzone', '/usr/bin/named-checkzone', 'named-checkzone'];
const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

function zoneFile(zone) { return path.join(ZONE_DIR, `db.${zone}`); }

function zoneSerial(existing) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (!existing) return `${today}01`;
  const current = String(existing);
  if (current.startsWith(today)) {
    const n = parseInt(current.slice(8), 10) || 0;
    return `${today}${String(Math.min(n + 1, 99)).padStart(2, '0')}`;
  }
  // A serial that goes backwards is a zone every secondary quietly ignores.
  return String(Math.max(Number(`${today}01`), Number(current) + 1));
}

function readZone(zone) {
  const file = zoneFile(zone);
  if (!fs.existsSync(file)) return null;
  const body = fs.readFileSync(file, 'utf8');
  const serial = (body.match(/^\s*(\d{6,10})\s*;\s*serial/mi) || [])[1] || null;
  const records = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('$')) continue;
    const match = trimmed.match(/^(\S+)\s+(?:(\d+)\s+)?IN\s+([A-Z]+)\s+(.+)$/);
    if (!match) continue;
    if (match[3] === 'SOA') continue;
    let value = match[4].trim();
    let preference = null;
    if (match[3] === 'MX' || match[3] === 'SRV') {
      const parts = value.split(/\s+/);
      preference = Number(parts.shift());
      value = parts.join(' ');
    }
    if (match[3] === 'TXT') {
      // A TXT value longer than 255 characters is written as several quoted
      // chunks, which is one value on the wire. Reading it back as the raw
      // line and stripping the outer quotes leaves the inner quotes in the
      // middle, so a DKIM key never matched what was written and a successful
      // publish was recorded as a failure.
      const chunks = value.match(/"((?:[^"\\]|\\.)*)"/g);
      value = chunks ? chunks.map(c => c.slice(1, -1).replace(/\\"/g, '"')).join('') : value.replace(/^"|"$/g, '');
    }
    records.push({ name: match[1], ttl: match[2] ? Number(match[2]) : null, type: match[3], value, preference });
  }
  return { zone, file, serial, records };
}

function renderZone(zone, records, serial) {
  const head = [
    `; Written by JotPanel. Records are managed from the panel.`,
    `$TTL 3600`,
    `@   IN  SOA ns1.${zone}. hostmaster.${zone}. (`,
    `        ${serial} ; serial`,
    `        3600       ; refresh`,
    `        600        ; retry`,
    `        1209600    ; expire`,
    `        3600 )     ; negative cache`,
    '',
  ];
  const body = records.map(r => {
    const ttl = r.ttl ? `${r.ttl} ` : '';
    if (r.type === 'TXT') {
      // A TXT string is capped at 255 characters on the wire, and a DKIM key is
      // longer than that, so it is split into quoted chunks the way BIND wants.
      const chunks = String(r.value).match(/.{1,255}/g) || [''];
      return `${r.name}\t${ttl}IN\tTXT\t${chunks.map(c => `"${c.replace(/"/g, '\\"')}"`).join(' ')}`;
    }
    if (r.type === 'MX' || r.type === 'SRV') return `${r.name}\t${ttl}IN\t${r.type}\t${r.preference == null ? 10 : r.preference} ${r.value}`;
    return `${r.name}\t${ttl}IN\t${r.type}\t${r.value}`;
  });
  return [...head, ...body, ''].join('\n');
}

// The name server runs as its own user and cannot read a root-only file, and
// BIND says nothing useful when it cannot: the zone is simply absent and the
// logs report all zones loaded. So the group and the mode are set explicitly
// every time rather than left to whatever the umask was.
function letBindRead(target, mode) {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(l => l.startsWith('bind:'));
    const gid = line ? Number(line.split(':')[2]) : null;
    if (gid != null) fs.chownSync(target, 0, gid);
    fs.chmodSync(target, mode);
  } catch { /* a box without a bind user has no name server to feed */ }
}

async function writeZone(zone, records, previousSerial) {
  ensureDir(ZONE_DIR, 0o755);
  letBindRead(ZONE_DIR, 0o755);
  const serial = zoneSerial(previousSerial);
  const file = zoneFile(zone);
  const staged = `${file}.staged`;
  fs.writeFileSync(staged, renderZone(zone, records, serial), { mode: 0o644 });
  // Check before it is anywhere BIND will read it. A bad zone that reaches the
  // server does not break one domain, it stops the server answering at all.
  const check = await runFile(command(CHECKZONE), [zone, staged], { timeoutMs: 30000 });
  if (!check.ok) { fs.rmSync(staged, { force: true }); throw new Error(`That change makes an invalid zone: ${firstLine(check.stdout || check.stderr)}`); }
  fs.renameSync(staged, file);
  letBindRead(file, 0o644);

  // Make sure the zone is declared, once.
  let include = fs.existsSync(ZONE_INCLUDE) ? fs.readFileSync(ZONE_INCLUDE, 'utf8') : '';
  let newlyDeclared = false;
  if (!new RegExp(`zone\\s+"${zone.replace(/\./g, '\\.')}"`).test(include)) {
    include += `zone "${zone}" {\n    type master;\n    file "${file}";\n    allow-transfer { none; };\n};\n`;
    fs.writeFileSync(ZONE_INCLUDE, include, { mode: 0o644 });
    letBindRead(ZONE_INCLUDE, 0o644);
    newlyDeclared = true;
  }
  const local = '/etc/bind/named.conf.local';
  if (fs.existsSync(local)) {
    const body = fs.readFileSync(local, 'utf8');
    if (!body.includes(ZONE_INCLUDE)) fs.appendFileSync(local, `\ninclude "${ZONE_INCLUDE}";\n`);
  }
  // A zone the server has never heard of is not picked up by `reload`, which
  // only rereads the zones already declared when BIND last read its config.
  // Every first-time zone therefore wrote a correct file, reloaded cleanly and
  // then failed its own read-back with "zone not loaded". Re-reading the
  // configuration is what declares it; reload afterwards is what refreshes an
  // existing one.
  if (newlyDeclared) await must(command(RNDC), ['reconfig'], { timeoutMs: 30000 }, 'BIND would not take the new zone');
  await must(command(RNDC), ['reload'], { timeoutMs: 30000 }, 'BIND would not reload the zone');
  // Rule 2. `rndc reload` reports success whether or not the zone came up, and
  // an unreadable zone file produces the cheerful message "all zones loaded"
  // with the zone quietly absent. Ask the running server about this zone by
  // name instead.
  const status = await runFile(command(RNDC), ['zonestatus', zone], { timeoutMs: 20000 });
  if (!status.ok || !/serial/i.test(status.stdout)) {
    throw new Error(`The zone file was written and BIND is not serving ${zone}: ${firstLine(status.stderr || status.stdout) || 'zone not loaded'}`);
  }
  return serial;
}

async function dnsZones() {
  if (!fs.existsSync(ZONE_DIR)) return { zones: [], verified: true };
  const zones = fs.readdirSync(ZONE_DIR)
    .filter(name => name.startsWith('db.') && !name.endsWith('.staged'))
    .map(name => {
      const zone = name.slice(3);
      const read = readZone(zone);
      return { zone, records: read ? read.records.length : 0, serial: read ? read.serial : null, file: zoneFile(zone) };
    });
  return { zones, verified: true };
}

async function dnsZoneRecords(params) {
  const zone = domain(params.zone);
  const read = readZone(zone);
  if (!read) throw new Error(`This server holds no zone for ${zone}`);
  return { ...read, verified: true };
}

async function dnsZoneCreate(params) {
  const zone = domain(params.zone);
  if (readZone(zone)) throw new Error(`${zone} already has a zone on this server`);
  const ip = String(params.ip || '').trim();
  if (ip && !/^[0-9.]{7,15}$/.test(ip)) throw new Error('That is not an IPv4 address');
  const records = [
    { name: '@', type: 'NS', value: `ns1.${zone}.` },
    ...(ip ? [
      { name: '@', type: 'A', value: ip },
      { name: 'ns1', type: 'A', value: ip },
      { name: 'www', type: 'A', value: ip },
      { name: '@', type: 'MX', value: `mail.${zone}.`, preference: 10 },
      { name: 'mail', type: 'A', value: ip },
    ] : []),
  ];
  const serial = await writeZone(zone, records, null);
  const back = readZone(zone);
  return { zone, serial, records: back.records, verified: !!back && back.records.length === records.length };
}

// Removing one zone block from named.conf, by counting braces.
//
// A pattern cannot do this. The first version of `dnsZoneDelete` used
// `zone "name" \{[^}]*\};?` and it stopped at the first closing brace, which
// belongs to `allow-transfer { none; }` and not to the zone. What was left
// behind was `;\n};`, and `rndc reconfig` refused it with "unexpected token".
// `scripts/lib/dropProofZone.js` had already learned exactly this and says so
// in its own header; this is the same lesson arriving in the product.
//
// It failed safely, which is the part worth keeping: the declaration went back,
// named.conf still parsed and BIND carried on serving its other zones, because
// the caller puts the old configuration back when the reconfigure is refused.
//
// Depth-counted from the `zone "name"` token to its matching close brace, plus
// a trailing semicolon and the blank line after it if they are there.
function withoutZoneDeclaration(config, zone) {
  const token = new RegExp(`zone\\s+"${zone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
  const found = token.exec(config);
  if (!found) return config;
  const open = config.indexOf('{', found.index);
  if (open === -1) return config;
  let depth = 0;
  let end = -1;
  for (let i = open; i < config.length; i += 1) {
    if (config[i] === '{') depth += 1;
    else if (config[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  // An unbalanced file is not something to guess at: leave it alone and let the
  // caller's own read-back refuse, rather than writing something worse.
  if (end === -1) return config;
  let cut = end + 1;
  if (config[cut] === ';') cut += 1;
  while (cut < config.length && (config[cut] === '\n' || config[cut] === '\r')) cut += 1;
  return config.slice(0, found.index) + config.slice(cut);
}

// Taking a zone away, which this panel could not do at all until now.
//
// The independent audit found it unprompted on three separate machines: the
// panel can give this server a zone and had no operation that removed one, so a
// zone made through the panel could only be removed by hand, in the privileged
// layer's own files, by somebody with root. That is a hosting panel that can
// create and cannot delete, and the checklist could not show it because the
// checklist is generated from the operations that exist.
//
// THE ORDER IS THE WHOLE THING. Undeclare, reconfigure, check that BIND has
// really dropped it, and only then remove the file. Doing it the other way
// round leaves BIND holding a declaration pointing at a file that is gone, and
// a `named.conf` that will not load is not one broken domain, it is the name
// server refusing to start at all for every zone on the machine. That is the
// same reasoning `writeZone` above uses for checking a zone before it is put
// anywhere BIND reads.
//
// And if the reconfigure fails, the declaration goes back, so a failure leaves
// the machine as it was found rather than half-undone.
async function dnsZoneDelete(params) {
  const zone = domain(params.zone);
  const read = readZone(zone);
  if (!read) throw new Error(`This server holds no zone for ${zone}`);

  const before = fs.existsSync(ZONE_INCLUDE) ? fs.readFileSync(ZONE_INCLUDE, 'utf8') : '';
  const after = withoutZoneDeclaration(before, zone);
  if (after !== before) {
    fs.writeFileSync(ZONE_INCLUDE, after, { mode: 0o644 });
    letBindRead(ZONE_INCLUDE, 0o644);
  }

  try {
    await must(command(RNDC), ['reconfig'], { timeoutMs: 30000 }, 'BIND would not take the zone away');
  } catch (error) {
    // Put the declaration back rather than leaving the machine half-undone.
    fs.writeFileSync(ZONE_INCLUDE, before, { mode: 0o644 });
    letBindRead(ZONE_INCLUDE, 0o644);
    await runFile(command(RNDC), ['reconfig'], { timeoutMs: 30000 });
    throw error;
  }

  // Asked of the running server by name, exactly as writeZone asks the opposite
  // question. `rndc reconfig` reports success whether or not the zone went, so
  // the only honest check is whether BIND still answers for it.
  const status = await runFile(command(RNDC), ['zonestatus', zone], { timeoutMs: 20000 });
  const stillServing = status.ok && /serial/i.test(status.stdout);
  if (stillServing) {
    throw new Error(`BIND is still serving ${zone} after the zone was undeclared, so the file has been left alone`);
  }

  // Only now is the file safe to remove: nothing points at it any more.
  const file = zoneFile(zone);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}.staged`, { force: true });

  return {
    zone,
    removed: !fs.existsSync(file),
    declared: new RegExp(`zone\\s+"${zone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(
      fs.existsSync(ZONE_INCLUDE) ? fs.readFileSync(ZONE_INCLUDE, 'utf8') : ''),
    served_by_bind: false,
    verified: !fs.existsSync(file),
  };
}

async function dnsRecordWrite(params) {
  const zone = domain(params.zone);
  const read = readZone(zone);
  if (!read) throw new Error(`This server holds no zone for ${zone}. Create the zone first.`);
  const type = String(params.type || '').toUpperCase();
  if (!RECORD_TYPES.includes(type)) throw new Error(`Record type must be one of ${RECORD_TYPES.join(', ')}`);
  const name = String(params.label || '@').trim() || '@';
  if (!/^[@A-Za-z0-9_*][A-Za-z0-9._-]*$/.test(name)) throw new Error('That record name is not valid');
  const value = String(params.value == null ? '' : params.value).trim();
  if (!value) throw new Error('A value is required');
  if (/[\r\n]/.test(value)) throw new Error('A record value is one line');
  const record = {
    name, type, value,
    ttl: params.ttl ? Number(params.ttl) : null,
    preference: params.preference == null || params.preference === '' ? (type === 'MX' ? 10 : null) : Number(params.preference),
  };
  // Replacing rather than appending for the single-value types, because two
  // SPF records is the exact failure the checker upstream reports.
  const single = type === 'TXT' && /^v=spf1/i.test(value);
  const records = read.records.filter(r => {
    if (r.name !== name || r.type !== type) return true;
    if (single) return !/^v=spf1/i.test(r.value);
    if (type === 'TXT' && /^v=DMARC1/i.test(value)) return !/^v=DMARC1/i.test(r.value);
    return !(r.value === value);
  });
  records.push(record);
  const serial = await writeZone(zone, records, read.serial);
  const back = readZone(zone);
  const present = back.records.some(r => r.name === name && r.type === type && r.value === value);
  if (!present) throw new Error('The zone was written and the record is not in it, so it is recorded as a failure');
  return { zone, serial, record, records: back.records.length, verified: true };
}

async function dnsRecordDelete(params) {
  const zone = domain(params.zone);
  const read = readZone(zone);
  if (!read) throw new Error(`This server holds no zone for ${zone}`);
  const name = String(params.label || '@');
  const type = String(params.type || '').toUpperCase();
  const value = params.value == null ? null : String(params.value).trim();
  const before = read.records.length;
  const records = read.records.filter(r => !(r.name === name && r.type === type && (value == null || r.value === value)));
  if (records.length === before) throw new Error('There is no such record in that zone');
  const serial = await writeZone(zone, records, read.serial);
  const back = readZone(zone);
  return { zone, serial, removed: before - back.records.length, records: back.records.length, verified: back.records.length === records.length };
}

// ── DMARC reports, read out of the mailbox they arrive in ─────────
//
// Every service in this category exists partly to be an address that receives
// this mail. We already run the mail server, so the reporting address is a
// mailbox on the customer's own domain and nothing is forwarded to anybody.
const { parseAggregateReport, summarise, extractReportXml } = require('./dmarcReports');

async function dmarcReportsRead(params) {
  const dom = domain(params.domain);
  const account = String(params.mailbox || 'dmarc').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const maildir = path.join('/var/vmail', dom, account, 'Maildir');
  if (!fs.existsSync(maildir)) {
    return {
      domain: dom, mailbox: `${account}@${dom}`, mailbox_exists: false,
      ...summarise([]),
      note: `There is no ${account}@${dom} mailbox on this server yet, so nothing can be collecting the reports. Create it, then point the DMARC record's rua at it.`,
      verified: true,
    };
  }
  const limit = Math.min(Math.max(parseInt(params.limit, 10) || 500, 1), 5000);
  const reports = [];
  const unreadable = [];
  let seen = 0;
  for (const box of ['new', 'cur']) {
    const dir = path.join(maildir, box);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (seen >= limit) break;
      seen++;
      const file = path.join(dir, name);
      try {
        const xml = extractReportXml(fs.readFileSync(file));
        if (!xml) continue;
        reports.push(parseAggregateReport(xml));
      } catch (e) { unreadable.push({ file: name, reason: firstLine(e.message) }); }
    }
  }
  const known = Array.isArray(params.knownSenders) ? params.knownSenders : [];
  return {
    domain: dom,
    mailbox: `${account}@${dom}`,
    mailbox_exists: true,
    messages_seen: seen,
    reports_read: reports.length,
    unreadable: unreadable.slice(0, 20),
    ...summarise(reports, { knownSenders: known }),
    verified: true,
  };
}

// ONE PROPERTY PER CALL. This exists because of a real bug.
//
// `systemctl show -p A -p B --value` prints the values in systemd's own order,
// not the order they were asked for, and there is nothing in the output saying
// which is which. Reading them back positionally reported a live timer as not
// armed on 2026-08-20. Rather than remember that, asking for two is now an
// error that says so.
async function systemctlShow(unit, property, options = {}) {
  if (Array.isArray(property) || String(property).includes(' ')) {
    throw new Error('Ask systemctl for one property per call. Several with --value come back in systemd\'s order rather than the order requested, and there is no way to tell which value is which.');
  }
  const result = await runFile('/usr/bin/systemctl', ['show', unit, '-p', String(property), '--value'], { timeoutMs: options.timeoutMs || 10000 });
  return (result.stdout || '').trim();
}

// Scheduled backups, on systemd timers rather than a cron line, so nothing is
// assembled as text and the schedule survives a reboot. The choices are a
// fixed list: a timer is not somewhere to accept free text.
const BACKUP_SCHEDULE_DIR = path.join(STATE_DIR, 'backup-schedules');
const BACKUP_RUN_SCRIPT = path.join(__dirname, 'backupRun.js');
const BACKUP_WHEN = {
  hourly: 'hourly',
  daily: '*-*-* 03:30:00',
  weekly: 'Sun *-*-* 04:00:00',
  monthly: '*-*-01 04:30:00',
};

function backupUnit(dom) {
  const slug = dom.replace(/[^a-z0-9.-]/gi, '');
  const legacy = `arca-backup-${slug}`;
  return !fs.existsSync(`/etc/systemd/system/jotpanel-backup-${slug}.timer`) && fs.existsSync(`/etc/systemd/system/${legacy}.timer`)
    ? legacy : `jotpanel-backup-${slug}`;
}

async function backupScheduleSet(params) {
  const dom = domain(params.domain);
  const when = String(params.when || 'daily').toLowerCase();
  if (!BACKUP_WHEN[when]) throw new Error(`Choose one of: ${Object.keys(BACKUP_WHEN).join(', ')}`);
  const config = {
    domain: dom,
    when,
    parts: Array.isArray(params.parts) && params.parts.length ? params.parts.filter(p => BACKUP_PARTS.includes(p)) : ['files', 'mail'],
    databases: Array.isArray(params.databases) ? params.databases.filter(Boolean) : [],
    engine: params.engine || null,
    keep: Math.min(Math.max(parseInt(params.keep, 10) || 7, 1), 90),
    // Recorded on the schedule so the run journal can say the copy was asked
    // for. The upload itself is not done here: the credential for the
    // destination lives in the panel's encrypted binding store and this side
    // has no way to read it, which is the point. The panel performs the copy
    // when it collects the run, and records whether it arrived.
    offsite: !!params.offsite,
    set_at: new Date().toISOString(),
  };
  ensureDir(BACKUP_SCHEDULE_DIR, 0o700);
  fs.writeFileSync(path.join(BACKUP_SCHEDULE_DIR, `${dom}.json`), JSON.stringify(config, null, 2), { mode: 0o600 });

  const unit = backupUnit(dom);
  fs.writeFileSync(`/etc/systemd/system/${unit}.service`, [
    '[Unit]',
    `Description=JotPanel backup for ${dom}`,
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${process.execPath} ${BACKUP_RUN_SCRIPT} ${dom}`,
    '',
  ].join('\n'), { mode: 0o644 });
  fs.writeFileSync(`/etc/systemd/system/${unit}.timer`, [
    '[Unit]',
    `Description=JotPanel backup schedule for ${dom}`,
    '',
    '[Timer]',
    `OnCalendar=${BACKUP_WHEN[when]}`,
    'Persistent=true',
    'RandomizedDelaySec=900',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n'), { mode: 0o644 });

  await must('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 20000 }, 'systemd would not reload');

  // Suspension has to survive the customer setting the schedule again. Without
  // this the timer was re-enabled underneath a suspension: the marker stayed,
  // so the panel went on reporting the schedule as suspended, while systemd ran
  // it every night. A control that reports itself as holding while it is not is
  // worse than one that plainly does not exist.
  const suspended = fs.existsSync(path.join(BACKUP_SCHEDULE_DIR, `${dom}.suspended`));
  if (suspended) {
    await runFile('/usr/bin/systemctl', ['disable', '--now', `${unit}.timer`], { timeoutMs: 20000 });
    const stillOn = await runFile('/usr/bin/systemctl', ['is-active', `${unit}.timer`], { timeoutMs: 10000 });
    if (/^\s*active/i.test(stillOn.stdout)) throw new Error(`${dom} is suspended and its backup timer would not stay stopped`);
    return {
      ...config, unit, next_run: null, suspended_by_hoster: true, armed: false,
      note: `The schedule is stored and will run when ${dom} is no longer suspended. Nothing is armed while it is.`,
      verified: false,
    };
  }

  await must('/usr/bin/systemctl', ['enable', '--now', `${unit}.timer`], { timeoutMs: 20000 }, 'the backup timer would not start');
  // Rule 2: ask systemd when it will actually run rather than assuming.
  const next = await systemctlShow(`${unit}.timer`, 'NextElapseUSecRealtime');
  if (!next) throw new Error('The timer was written and systemd reports no next run, so it is not scheduled');
  return { ...config, unit, next_run: next, armed: true, verified: true };
}

async function backupScheduleClear(params) {
  const dom = domain(params.domain);
  const unit = backupUnit(dom);
  await runFile('/usr/bin/systemctl', ['disable', '--now', `${unit}.timer`], { timeoutMs: 20000 });
  for (const suffix of ['timer', 'service']) {
    const file = `/etc/systemd/system/${unit}.${suffix}`;
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  await must('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 20000 }, 'systemd would not reload');
  const file = path.join(BACKUP_SCHEDULE_DIR, `${dom}.json`);
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  const check = await runFile('/usr/bin/systemctl', ['is-active', `${unit}.timer`], { timeoutMs: 10000 });
  if (/^\s*active/i.test(check.stdout)) throw new Error('The timer is still running, so nothing was cleared');
  return { domain: dom, cleared: true, verified: true };
}

// The scheduled-jobs half of suspension. JotPanel has no user crontab: a customer's
// scheduled work on this machine is their backup timer, so that is the thing
// suspension has to stop. It is not backup.schedule.clear, which deletes the
// unit files and the schedule itself, because unsuspending would then have
// nothing to put back and the customer would find their schedule quietly gone.
// This stops and disables the timer and leaves every file where it was, so
// restoring is enabling the same unit again.
async function backupScheduleSuspend(params) {
  const dom = domain(params.domain);
  const suspended = !!params.suspended;
  const unit = backupUnit(dom);
  const config = path.join(BACKUP_SCHEDULE_DIR, `${dom}.json`);
  // No schedule means nothing to stop, and unsuspending must not invent one.
  if (!fs.existsSync(config)) return { domain: dom, suspended, scheduled: false, verified: true };
  const marker = path.join(BACKUP_SCHEDULE_DIR, `${dom}.suspended`);

  if (suspended) {
    await must('/usr/bin/systemctl', ['disable', '--now', `${unit}.timer`], { timeoutMs: 20000 }, 'the backup timer would not stop');
    // Written so the schedule view can say why a timer is not armed. Without
    // it a suspended account's schedule reads exactly like one the customer
    // turned off themselves.
    fs.writeFileSync(marker, new Date().toISOString(), { mode: 0o600 });
  } else {
    await must('/usr/bin/systemctl', ['enable', '--now', `${unit}.timer`], { timeoutMs: 20000 }, 'the backup timer would not start again');
    if (fs.existsSync(marker)) fs.rmSync(marker, { force: true });
  }

  // systemd's own answer, not ours. A timer that is loaded but not armed still
  // reports a unit file, so the next run time is what actually says whether it
  // will ever fire again.
  const state = await systemctlShow(`${unit}.timer`, 'ActiveState');
  const next = await systemctlShow(`${unit}.timer`, 'NextElapseUSecRealtime');
  // Anchored for the same reason as the status read: "inactive" contains
  // "active". Here the next-run check was carrying it, which is luck rather
  // than a check.
  const armed = /^active$/i.test((state || '').trim()) && !!next;
  if (armed === suspended) throw new Error(`${dom} did not read back as ${suspended ? 'stopped' : 'scheduled again'}: systemd reports ${state || 'nothing'}`);
  return { domain: dom, suspended, scheduled: true, unit, armed, next_run: next || null, verified: true };
}

// The unattended-run journal, read whole so the panel can put anything it has
// not seen into the durable record. `since` is the panel telling us which run
// ids it already holds, so a run is ingested exactly once however often this is
// called. Nothing here is deleted by this read: the journal is the evidence and
// pruning it is a separate decision.
const BACKUP_RUN_DIR = path.join(STATE_DIR, 'backup-runs');

async function backupRunsUnattended(params = {}) {
  if (!fs.existsSync(BACKUP_RUN_DIR)) return { runs: [], verified: true };
  const known = new Set(Array.isArray(params.known) ? params.known.map(String) : []);
  const runs = [];
  for (const name of fs.readdirSync(BACKUP_RUN_DIR)) {
    if (!name.endsWith('.json')) continue;
    if (known.has(name.replace(/\.json$/, ''))) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(BACKUP_RUN_DIR, name), 'utf8'));
      // Refuses to hand back anything claiming to be approved. A journal file is
      // written by this machine and read by the panel, and if either end could
      // introduce an approval the distinction the whole design rests on would be
      // one file edit away from meaningless.
      if (entry && entry.executionBasis === 'unattended_schedule' && !entry.approvedBy && !entry.approvalId) runs.push(entry);
    } catch { /* a file mid-write is picked up on the next pass */ }
  }
  runs.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
  return { runs, verified: true };
}

async function backupScheduleStatus() {
  if (!fs.existsSync(BACKUP_SCHEDULE_DIR)) return { schedules: [], verified: true };
  const schedules = [];
  for (const name of fs.readdirSync(BACKUP_SCHEDULE_DIR)) {
    if (!name.endsWith('.json') || name.endsWith('.last.json')) continue;
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(BACKUP_SCHEDULE_DIR, name), 'utf8')); } catch { continue; }
    const unit = backupUnit(config.domain);
    // Asked one at a time. Two properties with --value come back in systemd's
    // order rather than the order they were requested, and reading them the
    // wrong way round reported a live timer as not armed.
    const state = await systemctlShow(`${unit}.timer`, 'ActiveState');
    const next = await systemctlShow(`${unit}.timer`, 'NextElapseUSecRealtime');
    let last = null;
    try { last = JSON.parse(fs.readFileSync(path.join(BACKUP_SCHEDULE_DIR, `${config.domain}.last.json`), 'utf8')); } catch {}
    const suspended = fs.existsSync(path.join(BACKUP_SCHEDULE_DIR, `${config.domain}.suspended`));
    // Anchored, because systemd's word for a stopped timer is "inactive" and it
    // contains "active". An unanchored match called every stopped timer armed,
    // so a suspended account and one whose schedule had been cleared both read
    // as running nightly.
    schedules.push({ ...config, unit, armed: /^active$/i.test((state || '').trim()), suspended_by_hoster: suspended, next_run: next || null, last_run: last });
  }
  return { schedules, verified: true };
}

function panelGroupId() {
  try {
    const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find(l => l.startsWith(`${PANEL_USER}:`));
    return line ? Number(line.split(':')[2]) : null;
  } catch { return null; }
}

// Hand the archive over. A backup somebody cannot take away is a backup that
// dies with the machine, so downloading it is part of the feature rather than
// an extra. The panel process reads the file itself, which is why this returns
// a path and a size rather than bytes.
async function backupFetch(params) {
  const dom = domain(params.domain);
  const manifest = readManifest(dom, String(params.id || ''));
  const part = String(params.part || 'files');
  // The manifest itself is fetchable, because an offsite copy that carries the
  // archives and not the description of them is a pile of files rather than a
  // backup, and the machine that could have described them is the one that is
  // gone in the case offsite exists for.
  const entry = part === 'manifest'
    ? { part: 'manifest', file: 'manifest.json' }
    : (manifest.parts || []).find(p => (p.database ? `${p.part}:${p.database}` : p.part) === part || (p.part === part && !p.database));
  if (!entry || !entry.file) throw new Error(`This backup has no ${part} archive`);
  const file = path.join(backupDir(dom, manifest.id), entry.file);
  const stat = fs.statSync(file);
  // The panel process is what streams this out and it is not root, so the file
  // and the two directories above it have to let the panel group in. Without
  // this the read fails after the response headers are already sent, which the
  // browser sees as a dropped connection rather than as an error it can show.
  try {
    const group = panelGroupId();
    if (group != null) {
      fs.chownSync(file, 0, group);
      fs.chmodSync(file, 0o640);
      for (const dir of [backupDir(dom, manifest.id), path.join(BACKUP_ROOT, dom), BACKUP_ROOT]) {
        fs.chownSync(dir, 0, group);
        fs.chmodSync(dir, 0o750);
      }
    }
  } catch (e) { throw new Error(`The archive could not be opened up for the panel to read: ${e.message}`); }
  // The digest, computed here when the entry does not carry one.
  //
  // Every archive part has a sha256 in the manifest, but the manifest itself is
  // fetched through the inline entry a few lines above, which has a part and a
  // file name and nothing else. So `sha256` came back null for exactly that one
  // part, the destination adapter had nothing to compare a hash against and fell
  // back to comparing lengths, and `backup.offsite.store` then declined to call
  // itself verified because one of its parts was confirmed by size. The archives
  // were hashed and the description of them was not, and the whole operation
  // read as unconfirmed on every machine because of it.
  //
  // Hashing it here rather than at the caller, because this is the side that has
  // the file and already knows its size.
  return {
    path: file,
    filename: `${dom}-${manifest.id}-${entry.file}`,
    bytes: stat.size,
    sha256: entry.sha256 || sha256File(file),
    verified: true,
  };
}

// Every version of one file that we hold, newest first.
//
// AdminBolt gives you a snapshot picker: choose a date, then go looking for
// your file inside it. This is the other way round. Name the file and get its
// history, with the date and size of each copy, so "when did this break" is
// answered by looking rather than by guessing a date and checking.
async function backupFileVersions(params) {
  const dom = domain(params.domain);
  const wanted = String(params.path || '').trim();
  if (!wanted || wanted.startsWith('/') || wanted.includes('..')) throw new Error('A path inside the backup is required');
  const domDir = path.join(BACKUP_ROOT, dom);
  if (!fs.existsSync(domDir)) return { domain: dom, path: wanted, versions: [], verified: true };
  const versions = [];
  for (const id of fs.readdirSync(domDir).sort().reverse()) {
    let manifest;
    try { manifest = readManifest(dom, id); } catch { continue; }
    for (const entry of manifest.parts || []) {
      if (!entry.file || entry.database) continue;
      const archive = path.join(domDir, id, entry.file);
      const listing = await runFile(command(TAR), ['-tvzf', archive], { timeoutMs: 300000 });
      if (!listing.ok) continue;
      for (const line of listing.stdout.split('\n')) {
        if (!line) continue;
        // tar -tv gives: perms owner/group size date time name
        const match = line.match(/^\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+)\s+(.+)$/);
        if (!match) continue;
        const name = match[3].trim();
        if (name !== wanted && !name.endsWith(`/${wanted}`) && !name.endsWith(wanted)) continue;
        versions.push({ id, part: entry.part, path: name, bytes: Number(match[1]), modified: match[2], created_at: manifest.created_at });
      }
    }
  }
  return { domain: dom, path: wanted, versions, count: versions.length, verified: true };
}

// Read one file out of a backup without restoring it, so somebody can look
// before they overwrite the live one. Text only and capped, because this is
// for checking a config or a page and not for pulling a database out.
const PREVIEW_LIMIT = 256 * 1024;
async function backupFilePreview(params) {
  const dom = domain(params.domain);
  const manifest = readManifest(dom, String(params.id || ''));
  const wanted = String(params.path || '').trim();
  if (!wanted || wanted.startsWith('/') || wanted.includes('..')) throw new Error('A path inside the backup is required');
  const entry = (manifest.parts || []).find(p => p.part === (params.part || 'files') && !p.database);
  if (!entry || !entry.file) throw new Error(`This backup has no ${params.part || 'files'} archive`);
  const archive = path.join(backupDir(dom, manifest.id), entry.file);
  const out = await runFile(command(TAR), ['-xzOf', archive, wanted], { timeoutMs: 120000, maxBuffer: PREVIEW_LIMIT * 4 });
  if (!out.ok) throw new Error(`${wanted} is not in that backup`);
  const body = out.stdout;
  const binary = /\u0000/.test(body.slice(0, 4096));
  const live = params.part === 'mail' ? path.join('/var/vmail', dom) : siteBase(dom);
  const livePath = path.join(path.dirname(live), wanted);
  let liveBody = null;
  try { if (fs.existsSync(livePath) && fs.statSync(livePath).size <= PREVIEW_LIMIT) liveBody = fs.readFileSync(livePath, 'utf8'); } catch {}
  return {
    id: manifest.id, domain: dom, path: wanted,
    binary,
    bytes: Buffer.byteLength(body),
    truncated: body.length > PREVIEW_LIMIT,
    content: binary ? null : body.slice(0, PREVIEW_LIMIT),
    // The live copy comes back beside it so the panel can show what changed
    // rather than asking somebody to remember what the file used to say.
    live: liveBody === null ? null : { path: livePath, content: liveBody.slice(0, PREVIEW_LIMIT), same: liveBody === body },
    verified: true,
  };
}

// Putting files back is not the same as putting a site back, and this used to
// treat them as the same thing. After the account had been deleted, the archive
// unpacked cleanly, the read-back found the files exactly where it expected
// them, and the operation reported success, while the domain served the default
// nginx page because the vhost, the system user and the pool had gone with the
// account. The files were also left owned by the uid recorded in the archive,
// which belongs to nobody after a delete and belongs to somebody else once that
// uid is handed out again.
//
// So an in-place restore of the whole files part now rebuilds what a site needs
// before it unpacks, reasserts ownership afterwards because tar carries the old
// one, and asks the running server whether the site answers before it calls any
// of this a success. What it cannot do by itself, a database and a mailbox, it
// names instead of leaving for the operator to discover.
async function backupRestore(params) {
  // Same lock as backupCreate, and for the same reason in the other direction: a
  // backup reading the site tree while a restore overwrites it archives a
  // half-restored site and calls it a backup.
  return withBackupLock(domain(params.domain), () => backupRestoreWithinLock(params));
}

async function backupRestoreWithinLock(params) {
  const dom = domain(params.domain);
  const manifest = readManifest(dom, String(params.id || ''));
  const part = String(params.part || 'files');
  // A database used to be refused here, with a message pointing at the import
  // path. That path worked and nothing walked it for you: download the dump
  // under its qualified name, gunzip it, upload it, then import it, four steps
  // and an approval each. The dump is already on this machine, so the operation
  // now does the work. It creates the database when it is missing, which is the
  // registration half, then imports into it and counts the tables afterwards.
  if (part === 'databases') {
    const dumps = (manifest.parts || []).filter(p => p.database && p.file);
    if (!dumps.length) throw new Error('This backup holds no database');
    const only = params.database ? String(params.database) : null;
    const chosen = only ? dumps.filter(p => p.database === only) : dumps;
    if (!chosen.length) throw new Error(`This backup holds no database called ${only}`);

    const listed = await databaseList();
    const engines = (listed.engines || []).filter(row => row.available !== false).map(row => row.engine);
    const restoredDatabases = [];
    for (const dump of chosen) {
      const file = path.join(backupDir(dom, manifest.id), dump.file);
      let sql = '';
      try { sql = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'); }
      catch (error) { throw new Error(`The dump for ${dump.database} could not be read back: ${error.message}`); }
      if (!sql.trim()) throw new Error(`The dump for ${dump.database} is empty, so nothing was restored`);

      const existing = (listed.databases || []).find(row => row.name === dump.database);
      const engine = params.engine || existing?.engine || engines[0] || 'mysql';
      let created = false;
      if (!existing) {
        await databaseCreate({ name: dump.database, engine });
        created = true;
      }
      const done = await databaseImport({ name: dump.database, sql, engine });
      // Rule 2 again. An import that runs and leaves an empty database is not a
      // restore, and the count comes from the server rather than from the dump.
      if (!done.tables_after) throw new Error(`${dump.database} has no tables after the import, so this is recorded as a failure rather than a restore`);
      restoredDatabases.push({ database: dump.database, engine, created, tables: done.tables_after });
    }
    return {
      id: manifest.id, domain: dom, part, mode: 'in place',
      restored: restoredDatabases.map(row => row.database).join(', '),
      databases: restoredDatabases, rebuilt: restoredDatabases.filter(row => row.created).map(row => `the database ${row.database}`),
      outstanding: [], serving: null, complete: true, verified: true,
    };
  }
  const entry = (manifest.parts || []).find(p => p.part === part && !p.database);
  if (!entry || !entry.file) throw new Error(`This backup has no ${part} archive`);
  const archive = path.join(backupDir(dom, manifest.id), entry.file);
  const target = part === 'files' ? siteBase(dom) : path.join('/var/vmail', dom);
  const copy = params.mode === 'copy';
  const into = copy
    ? path.join(path.dirname(target), `${path.basename(target)}.restored-${manifest.id}`)
    : path.dirname(target);

  const one = params.path ? String(params.path) : null;
  if (one && (one.includes('..') || one.startsWith('/'))) throw new Error('That path is not inside the backup');

  // A copy alongside is deliberately not the live site, so none of the rebuild
  // or the serving check applies to it. Only an in-place whole-part restore is
  // claiming to put a working site back.
  const restoresWholeSite = part === 'files' && !copy && !one;
  const rebuilt = [];
  if (restoresWholeSite && !readSites().sites.some(site => site.domain === dom)) {
    // The same path a new site takes, rather than a second implementation of it
    // that would drift. It writes a placeholder index only where none exists,
    // and the archive unpacks over the top of it a moment later.
    await siteCreate({ domain: dom, documentRoot: params.documentRoot || 'public' });
    rebuilt.push('the system user', 'the document root', 'the web server configuration');
  }

  if (copy) ensureDir(into, 0o750);
  const args = ['-xzf', archive, '-C', into];
  if (one) args.push(one);
  await must(command(TAR), args, { timeoutMs: 1800000 }, 'the restore could not be unpacked');

  // tar carries the ownership recorded when the archive was written. After a
  // delete and a rebuild that uid maps to nobody, so the files are reassigned to
  // the user that owns the site now.
  if (part === 'files' && !copy) {
    const owner = await ensureSiteUser(dom);
    await must(command(['/bin/chown', '/usr/bin/chown']), ['-RhP', `${owner.uid}:${nginxGroup()}`, siteBase(dom)],
      { timeoutMs: 300000 }, 'ownership could not be applied to the restored files');
    const site = readSites().sites.find(entry2 => entry2.domain === dom);
    if (site) prepareDocumentRoot(site);
  }

  // Rule 2: look at what is on disk now rather than trusting the exit code.
  const check = one
    ? path.join(copy ? into : path.dirname(target), one)
    : (copy ? into : target);
  const present = fs.existsSync(check);
  if (!present) throw new Error('The restore reported success and the file is not there, so it is recorded as a failure');

  // The question a person actually asked when they pressed restore. Files on
  // disk are not an answer to it, so the running server is asked instead, and a
  // site that does not answer is a failed restore rather than a green one.
  let httpStatus = null;
  if (part === 'files' && !copy) {
    await validateAndReloadNginx();
    // The site has to be a site this server knows about, not merely a name that
    // something answered for. Without this, a missing vhost falls through to the
    // default server, which returns a cheerful 200 for the welcome page, and
    // that 200 is exactly the false success this whole change exists to stop.
    const known = (await siteList()).sites.find(entry2 => entry2.domain === dom);
    if (!known || !fs.existsSync(known.config)) {
      throw new Error(`The files are back but ${dom} has no web server configuration on this machine, so nothing is serving them and this is recorded as a failure rather than a success`);
    }
    const answered = await runFile(command(['/usr/bin/curl', '/bin/curl']),
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${dom}`, 'http://127.0.0.1/'], { timeoutMs: 60000 });
    httpStatus = Number((answered.stdout || '').trim()) || 0;
    if (httpStatus < 200 || httpStatus >= 500) {
      throw new Error(`The files are back but ${dom} answered ${httpStatus || 'nothing'}, so this is not a working site yet and is recorded as a failure rather than a success`);
    }
    // And what came back has to be the restored site rather than whatever else
    // was willing to answer. Where the index is a static file its size is known
    // on disk, so the served length is compared against it. A site whose index
    // is generated is left to the status check, because there is nothing static
    // to compare it to.
    // siteList already resolved this to an absolute path. Resolving it a second
    // time built a nonsense path, found no index there, and quietly skipped the
    // whole comparison, which is the same shape of fault as the one above: a
    // check that passes because it never ran.
    const root = known.document_root;
    const staticIndex = ['index.html', 'index.htm'].map(name => path.join(root, name)).find(file => fs.existsSync(file));
    if (staticIndex) {
      const measured = await runFile(command(['/usr/bin/curl', '/bin/curl']),
        ['-s', '-o', '/dev/null', '-w', '%{size_download}', '-H', `Host: ${dom}`, 'http://127.0.0.1/'], { timeoutMs: 60000 });
      const served = Number((measured.stdout || '').trim()) || 0;
      const onDisk = fs.statSync(staticIndex).size;
      if (served !== onDisk) {
        throw new Error(`${dom} answered ${httpStatus} but served ${served} bytes where the restored index is ${onDisk}, so something other than the restored site is answering and this is recorded as a failure`);
      }
    }
  }

  // What this operation cannot put back on its own, named here rather than left
  // for whoever is reading a green tick at three in the morning to find out.
  const outstanding = [];
  const dumps = (manifest.parts || []).filter(p => p.database && p.file);
  if (dumps.length && part === 'files' && !copy) {
    let existing = [];
    try {
      const listed = await databaseList();
      existing = (listed.databases || []).map(row => row.name);
    } catch { existing = []; }
    for (const dump of dumps) {
      if (!existing.includes(dump.database)) {
        outstanding.push(`the database ${dump.database}, which this backup holds and this server does not. Restore it from this same backup, choosing the database part.`);
      }
    }
  }
  // Asked of the mail server's own registry rather than of the directory,
  // because the restore has just created that directory and it would always
  // answer yes. A maildir with no mailbox behind it serves nobody.
  if (part === 'mail' && !copy) {
    let registered = [];
    try { registered = (await mailList()).mailboxes.filter(box => box.domain === dom); } catch { registered = []; }
    if (!registered.length) {
      outstanding.push(`a mailbox for ${dom}, which needs a password no backup can hold. Create the mailbox and these messages are served again.`);
    }
  }

  const stat = fs.statSync(check);
  // A restore that put back some of what the account needs is not a success and
  // it is not a failure either, and reporting it as the first was the whole
  // complaint. The record already has a way to say this: a handler that cannot
  // stand behind its own result returns verified false with a note, and the
  // panel prints that note instead of a green tick. So a partial restore says
  // plainly that it is partial and lists what is still missing.
  const partial = outstanding.length > 0;
  return {
    id: manifest.id, domain: dom, part, restored: one || 'everything',
    mode: copy ? 'copy' : 'in place', path: check,
    bytes: stat.isDirectory() ? dirBytes(check) : stat.size,
    rebuilt, outstanding,
    ...(httpStatus == null ? {} : { http_status: httpStatus }),
    // Only the files part is a claim about a site answering. A copy alongside is
    // not serving anything, and mail is not a web page, so both say nothing here
    // rather than saying false and reading like a fault.
    serving: (copy || httpStatus == null) ? null : (httpStatus >= 200 && httpStatus < 400),
    complete: !partial,
    verified: !partial,
    ...(partial ? { note: `Partial restore. ${part === 'files' ? 'The site is serving' : 'The files are back'}, and this account is still missing ${outstanding.join(' Also missing: ')}` } : {}),
  };
}

// ── Runtimes beyond PHP ───────────────────────────────────────────
//
// Every free panel's community asks for this and none of them have solved it.
// The reason they have not is that it looks like six features and it is one: a
// long-running process owned by the site's own user, behind the reverse proxy
// that is already there. Once that shape exists, adding a language is a row in
// the table below, which is why this arrives with seven of them rather than one.
//
// The rule that shapes all of it is rule four. **Nothing a customer types
// becomes a command.** The program that runs is chosen from the closed table
// below and its path comes from `command()`, exactly like every other executable
// this file invokes. The only thing the customer supplies is which file inside
// their own site to start, and that is a path, validated twice: once against a
// deliberately narrow character set, because it is about to become a word in a
// systemd unit and a Linux file name may legally contain a newline, and once by
// `sitePath`, which refuses anything outside the site or reached through a link.
//
// The process is confined the way the PHP pool is confined. It runs as the
// site's user, the filesystem is read-only apart from the site's own tree, and
// it listens on the loopback address. The installer leaves ufw allowing only
// SSH and nginx, so a program that insists on binding every address is still
// unreachable from outside; nginx is the only way in.

const RUNTIME_UNIT_DIR = '/etc/systemd/system';
const RUNTIME_PORT_BASE = 21000;
const RUNTIME_PORT_COUNT = 500;

const RUNTIMES = {
  node: {
    label: 'Node.js', packages: ['nodejs'], bin: ['/usr/bin/node', '/usr/bin/nodejs'],
    args: entry => [entry], extensions: ['.js', '.mjs', '.cjs'], example: 'server.js',
    version: ['--version'], note: 'Your program reads the port to listen on from the PORT environment variable.',
  },
  python: {
    label: 'Python', packages: ['python3'], bin: ['/usr/bin/python3'],
    args: entry => [entry], extensions: ['.py'], example: 'app.py',
    version: ['--version'], note: 'Your program reads the port to listen on from the PORT environment variable.',
  },
  ruby: {
    label: 'Ruby', packages: ['ruby'], bin: ['/usr/bin/ruby'],
    args: entry => [entry], extensions: ['.rb'], example: 'app.rb',
    version: ['--version'], note: 'Your program reads the port to listen on from the PORT environment variable.',
  },
  java: {
    label: 'Java', packages: ['default-jre-headless'], bin: ['/usr/bin/java'],
    args: entry => ['-jar', entry], extensions: ['.jar'], example: 'app.jar',
    // java -version prints to standard error and still exits zero, which is why
    // the probe reads either stream rather than only one.
    version: ['-version'], note: 'A self-contained jar, the shape Spring Boot and Quarkus already build. Server.port is read from the PORT environment variable.',
  },
  perl: {
    label: 'Perl', packages: ['perl'], bin: ['/usr/bin/perl'],
    args: entry => [entry], extensions: ['.pl'], example: 'app.pl',
    version: ['--version'], note: 'Your program reads the port to listen on from the PORT environment variable.',
  },
  dotnet: {
    label: '.NET', packages: ['dotnet-runtime-8.0'], bin: ['/usr/bin/dotnet', '/usr/lib/dotnet/dotnet'],
    args: entry => [entry], extensions: ['.dll'], example: 'App.dll',
    // --list-runtimes, not --version. `dotnet --version` reports the SDK
    // version and fails with "The command could not be loaded" when only the
    // runtime is installed, which is the normal case on a server: nobody builds
    // there. Watched on the box, where it reported .NET unavailable on a machine
    // that had just installed it successfully.
    version: ['--list-runtimes'], note: 'The published dll, run by the shared runtime. ASPNETCORE_URLS is set for you.',
  },
  binary: {
    // Go, Rust, C, Zig, anything that compiles to one file. There is nothing to
    // install for this one: the program is its own runtime, which is the whole
    // appeal of it, and the probe is whether the file itself can be executed.
    label: 'A compiled program', packages: [], bin: null,
    args: () => [], extensions: [], example: 'app',
    version: null, note: 'A single compiled executable, which is what Go and Rust produce. It reads the port from the PORT environment variable.',
  },
};

const RUNTIME_IDS = Object.keys(RUNTIMES);

// The closed list above and the table here are the same set or one of them is
// wrong, and a language the panel offers to install with no unit behind it is
// exactly the kind of drift worth failing on before a customer finds it.
for (const [id, spec] of Object.entries(RUNTIMES)) {
  const instance = `runtime-${id}`;
  const listed = ONESHOT_INSTANCES.includes(instance);
  if (spec.packages.length && !listed) throw new Error(`${spec.label} can be installed but ${instance} is not a privileged oneshot`);
  if (!spec.packages.length && listed) throw new Error(`${instance} is a privileged oneshot but ${spec.label} has nothing to install`);
}

function runtimeSpec(value) {
  const id = String(value || '');
  const spec = RUNTIMES[id];
  if (!spec) throw new Error(`${value} is not a runtime this panel knows`);
  return { id, spec };
}

// Deliberately narrower than the rule the file manager uses for the same tree.
// A file name on Linux may contain a space, a quote or a newline, and this name
// is about to become a word inside a systemd unit, where a newline would let
// somebody add User=root to a unit describing their own application.
function runtimeEntry(value, spec) {
  const clean = String(value == null ? '' : value).trim().replace(/^\/+/, '');
  if (!clean) throw new Error('Name the file your application starts from');
  if (clean.length > 200) throw new Error('That path is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(clean)) {
    throw new Error('The starting file has to be named with letters, digits, dots, dashes, underscores and slashes only. Rename it if it has spaces or anything unusual in it.');
  }
  if (clean.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('That path is not a file inside the site');
  if (spec.extensions.length && !spec.extensions.some(ext => clean.toLowerCase().endsWith(ext))) {
    throw new Error(`A ${spec.label} application starts from a file ending ${spec.extensions.join(' or ')}`);
  }
  return clean;
}

function runtimeUnitName(name) {
  const slug = domain(name);
  const current = `jotpanel-app-${slug}.service`, legacy = `arca-app-${slug}.service`;
  return !fs.existsSync(path.join(RUNTIME_UNIT_DIR, current)) && fs.existsSync(path.join(RUNTIME_UNIT_DIR, legacy)) ? legacy : current;
}
function runtimeUnitPath(name) { return path.join(RUNTIME_UNIT_DIR, runtimeUnitName(name)); }

// Permission, not presence. Finding an interpreter on disk says nothing about
// whether it runs, which is the mistake this file has shipped twice.
async function runtimeProbe(id) {
  const { spec } = runtimeSpec(id);
  if (!spec.bin) return { runtime: id, label: spec.label, available: true, detail: 'no interpreter is needed; the program is its own runtime' };
  const binary = command(spec.bin);
  if (!fs.existsSync(binary)) return { runtime: id, label: spec.label, available: false, reason: `${spec.label} is not installed on this machine` };
  const result = await runFile(binary, spec.version, { timeoutMs: 20000 });
  if (!result.ok) return { runtime: id, label: spec.label, available: false, reason: `${binary} is on disk but would not run: ${firstLine(result.stderr || result.stdout || result.error)}` };
  return { runtime: id, label: spec.label, available: true, binary, detail: firstLine(result.stdout || result.stderr) };
}

async function runtimeList() {
  const runtimes = [];
  for (const id of RUNTIME_IDS) {
    const probe = await runtimeProbe(id);
    runtimes.push({ ...probe, packages: RUNTIMES[id].packages, example: RUNTIMES[id].example, note: RUNTIMES[id].note, installable: RUNTIMES[id].packages.length > 0 });
  }
  const state = readSites();
  return {
    runtimes,
    available: runtimes.filter(entry => entry.available).map(entry => entry.runtime),
    running: state.sites.filter(site => site.runtime).map(site => ({ domain: site.domain, runtime: site.runtime.id, entry: site.runtime.entry, port: site.runtime.port })),
  };
}

// One loopback port per site, remembered in the site record so a restart does
// not move it. Nothing outside the machine can reach these: the installer
// leaves ufw allowing SSH and nginx and nothing else.
function allocateRuntimePort(state, name) {
  const taken = new Set(state.sites.filter(site => site.runtime && site.domain !== name).map(site => site.runtime.port));
  for (let port = RUNTIME_PORT_BASE; port < RUNTIME_PORT_BASE + RUNTIME_PORT_COUNT; port += 1) {
    if (!taken.has(port)) return port;
  }
  throw new Error(`This machine has run out of application ports (${RUNTIME_PORT_BASE} upwards)`);
}

function portAnswers(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = answered => { try { socket.destroy(); } catch {} resolve(answered); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function writeRuntimeUnit(site, id, spec, entryAbsolute, port) {
  const owner = siteOwner(site);
  const base = siteBase(site.domain);
  const binary = spec.bin ? command(spec.bin) : entryAbsolute;
  // Every word quoted. The character set above already refuses a space or a
  // quote in the part that came from a customer, and this is the second of the
  // two gates rather than the only one.
  const exec = [binary, ...spec.args(entryAbsolute)].map(part => `"${part}"`).join(' ');
  const unit = `# Managed by jotpanel-ops. Edit through the panel.
[Unit]
Description=JotPanel application for ${site.domain} (${spec.label})
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
User=${owner.user}
Group=${owner.user}
WorkingDirectory=${path.dirname(entryAbsolute)}
Environment=PORT=${port}
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
Environment=ASPNETCORE_URLS=http://127.0.0.1:${port}
Environment=HOME=${base}
ExecStart=${exec}
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=jotpanel-app-${site.domain}

# The same confinement the PHP pool gets, said in systemd rather than in
# php.ini. The filesystem is read-only apart from the site's own tree, so a
# compromised application is confined to the site rather than to the machine.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${base}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
RemoveIPC=true

[Install]
WantedBy=multi-user.target
`;
  const target = runtimeUnitPath(site.domain);
  fs.writeFileSync(target, unit, { mode: 0o644 });
  return target;
}

async function runtimeSet(params) {
  const name = domain(params.domain);
  const { id, spec } = runtimeSpec(params.runtime);
  const probe = await runtimeProbe(id);
  if (!probe.available) throw new Error(probe.reason);

  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);

  const relative = runtimeEntry(params.entry, spec);
  // The second gate, and the one that knows about links: this refuses anything
  // outside the site or reached through a symlink out of it.
  const resolved = sitePath(name, relative, { mustExist: true });
  const stat = fs.lstatSync(resolved.target);
  if (stat.isSymbolicLink()) throw new Error('The starting file is a link. Point this at the file itself.');
  if (!stat.isFile()) throw new Error('The starting file is not a file');
  if (!spec.bin) {
    // Nothing interprets a compiled program, so the only thing that makes it
    // runnable is its own mode, and saying so beats a unit that fails to start.
    if (!(stat.mode & 0o100)) throw new Error(`${relative} is not executable. Set its permissions to 750 and try again.`);
  }

  const port = site.runtime && site.runtime.port ? site.runtime.port : allocateRuntimePort(state, name);
  const unit = runtimeUnitName(name);

  // What is here now, kept so a failure can put it back.
  //
  // Watched failing on the box: pointing a live site at an application that
  // starts and immediately exits replaced the working unit, restarted onto the
  // broken one, and then refused. The record said failed and the site said 502,
  // which is the worst pair of answers a panel can give. A refusal has to leave
  // the machine as it found it.
  const previousUnit = fs.existsSync(runtimeUnitPath(name)) ? fs.readFileSync(runtimeUnitPath(name), 'utf8') : null;
  const previousRuntime = site.runtime ? { ...site.runtime } : null;
  const restore = async () => {
    try {
      if (previousUnit === null) {
        await runFile('/usr/bin/systemctl', ['disable', '--now', unit], { timeoutMs: 90000 });
        try { fs.unlinkSync(runtimeUnitPath(name)); } catch {}
        await runFile('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60000 });
        return 'the site is serving its own files, as it was';
      }
      fs.writeFileSync(runtimeUnitPath(name), previousUnit, { mode: 0o644 });
      await runFile('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60000 });
      await runFile('/usr/bin/systemctl', ['restart', unit], { timeoutMs: 90000 });
      const back = await waitUntilAsync(() => portAnswers(previousRuntime.port), 20000);
      return back
        ? `the ${previousRuntime.label || previousRuntime.id} application that was serving it is back`
        : `the ${previousRuntime.label || previousRuntime.id} application that was serving it did NOT come back and the site is down`;
    } catch (error) { return `and putting the previous application back also failed: ${firstLine(error.message)}`; }
  };

  writeRuntimeUnit(site, id, spec, resolved.target, port);
  site.runtime = { id, entry: resolved.relative, port, unit, label: spec.label };

  let unitState = 'unknown';
  let answering = false;
  try {
    await must('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60000 }, 'systemd would not read the generated unit');
    // restart rather than start, so setting a runtime on a site that already has
    // one picks up the new unit instead of leaving the old process serving.
    await must('/usr/bin/systemctl', ['enable', '--now', unit], { timeoutMs: 90000 }, `${unit} would not start`);
    await must('/usr/bin/systemctl', ['restart', unit], { timeoutMs: 90000 }, `${unit} would not restart onto the new unit`);

    // Read back, and against the thing that matters. A unit that is active
    // proves the process started; only an answer on the port proves it is
    // serving, and an application that starts and then exits is the common case.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (await serviceState(unit) === 'failed') break;
      if (await portAnswers(port)) { answering = true; break; }
      await delay(500);
    }
    unitState = await serviceState(unit);
    if (!answering) {
      const why = await runtimeRecentLog(name);
      throw new Error(`${relative} started but nothing is listening on port ${port} (${unitState}).${why ? ` The last thing it said: ${why}` : ''}`);
    }
  } catch (error) {
    // The program's own last words, whichever way this failed. systemd's
    // "start was attempted too often" is true and useless; what the operator
    // needs is the line the application printed before it gave up.
    const said = await runtimeRecentLog(name);
    const restored = await restore();
    throw new Error(`${firstLine(error.message)}${said && !error.message.includes(said) ? ` The application said: ${said}` : ''} Nothing was changed: ${restored}.`);
  }

  writeState(SITE_STATE, state);
  writeSiteConfig(site);
  const reload = await validateAndReloadNginx();
  return {
    domain: name, runtime: id, label: spec.label, entry: resolved.relative, port, unit,
    unit_state: unitState, answering: true, nginx: reload.service,
    note: spec.note,
    verified: true,
  };
}

// The last few lines the application itself printed, which is the only useful
// thing to say when it did not come up.
async function runtimeRecentLog(name) {
  const unit = runtimeUnitName(name);
  const result = await runFile('/usr/bin/journalctl', ['-u', unit, '-n', '40', '--no-pager', '-o', 'cat'], { timeoutMs: 20000 });
  if (!result.ok) return null;
  // systemd narrates its own actions into the same stream, and its narration is
  // longer than the program's. Watched on the box: a Python syntax error was
  // pushed out of the answer by "Main process exited, code=exited" and
  // "Scheduled restart job", which tell an operator nothing they did not know.
  // The program's own words are the point, so systemd's are dropped.
  const systemd = [
    /^Start(ed|ing)\b/, /^Stopp(ed|ing)\b/, /^Scheduled restart/, /^Deactivated/, /^Consumed \d/,
    new RegExp(`^${unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`),
  ];
  const lines = String(result.stdout || '').split('\n').map(line => line.trim())
    .filter(Boolean)
    .filter(line => !systemd.some(pattern => pattern.test(line)));
  // A program that is being restarted prints the same complaint each time, and
  // saying it twice does not make it clearer.
  const distinct = lines.filter((line, at) => line !== lines[at - 1]);
  return distinct.slice(-2).join(' / ') || null;
}

async function runtimeClear(params) {
  const name = domain(params.domain);
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);
  if (!site.runtime) throw new Error(`${name} is not running an application`);
  const unit = runtimeUnitName(name);

  await runFile('/usr/bin/systemctl', ['disable', '--now', unit], { timeoutMs: 90000 });
  try { fs.unlinkSync(runtimeUnitPath(name)); } catch { /* already gone is the wanted state */ }
  await must('/usr/bin/systemctl', ['daemon-reload'], { timeoutMs: 60000 }, 'systemd would not forget the removed unit');

  const port = site.runtime.port;
  delete site.runtime;
  writeState(SITE_STATE, state);
  // The site goes back to being served from its own files, which is what it was
  // before, so nothing is left pointing at a port with nothing behind it.
  writeSiteConfig(site);
  await validateAndReloadNginx();

  const stillListening = await portAnswers(port, 800);
  const unitState = await serviceState(unit);
  if (stillListening) throw new Error(`the application on ${name} is still listening on port ${port}`);
  if (fs.existsSync(runtimeUnitPath(name))) throw new Error(`the unit for ${name} is still on disk`);
  return { domain: name, unit, unit_state: unitState, port_released: port, serving: 'the site’s own files again', verified: true };
}

async function runtimeRestart(params) {
  const name = domain(params.domain);
  const site = readSites().sites.find(entry => entry.domain === name);
  if (!site || !site.runtime) throw new Error(`${name} is not running an application`);
  const unit = runtimeUnitName(name);
  await must('/usr/bin/systemctl', ['restart', unit], { timeoutMs: 90000 }, `${unit} would not restart`);
  let answering = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await portAnswers(site.runtime.port)) { answering = true; break; }
    if (await serviceState(unit) === 'failed') break;
    await delay(500);
  }
  const unitState = await serviceState(unit);
  if (!answering) {
    const why = await runtimeRecentLog(name);
    throw new Error(`${unit} is ${unitState} and nothing is listening on port ${site.runtime.port}.${why ? ` The last thing it said: ${why}` : ''}`);
  }
  return { domain: name, unit, unit_state: unitState, port: site.runtime.port, answering: true, verified: true };
}

async function runtimeStatus(params) {
  const name = domain(params.domain);
  const site = readSites().sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);
  if (!site.runtime) return { domain: name, running: false, source: 'the site’s own files' };
  const unit = runtimeUnitName(name);
  return {
    domain: name, running: true, runtime: site.runtime.id, label: site.runtime.label || null,
    entry: site.runtime.entry, port: site.runtime.port, unit,
    unit_state: await serviceState(unit),
    answering: await portAnswers(site.runtime.port, 1200),
    recent: await runtimeRecentLog(name),
  };
}

// Installing a language is apt, so it goes to the short-lived unit for the same
// reason every other package job does.
async function runtimeInstall(params) {
  const { id, spec } = runtimeSpec(params.runtime);
  if (!spec.packages.length) throw new Error(`${spec.label} needs nothing installed; the program is its own runtime`);
  return runPrivilegedOneshot(`runtime-${id}`, `The ${spec.label} installer`);
}

// Runs inside the oneshot, where apt is allowed to take as long as it takes.
async function installRuntimePackages(params) {
  const { id, spec } = runtimeSpec(params.runtime);
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  await must('/usr/bin/apt-get', [...APT_WAIT, 'update'], { timeoutMs: 1800000, env }, 'The package index could not be updated');
  await must('/usr/bin/apt-get', [...APT_WAIT, '-y', '-o', 'Dpkg::Options::=--force-confold', 'install', ...spec.packages], { timeoutMs: 2100000, env }, `${spec.label} did not install`);
  const probe = await runtimeProbe(id);
  if (!probe.available) throw new Error(`${spec.label} installed but will not run: ${probe.reason}`);
  return { runtime: id, label: spec.label, packages: spec.packages, detail: probe.detail, verified: true };
}

// ── Migration, the executing half ─────────────────────────────────
//
// Something else reads the archive and produces a plan. This takes that plan and
// builds it, and it is deliberately dull: every step calls the same job the
// panel already uses for that thing, so a site created by a migration is
// identical to one created by hand and there is no second code path to keep
// correct.
//
// Two rules from the strategy document shape all of it. **Nothing is cut over
// until the owner says so**, so this creates alongside and never touches DNS or
// removes anything. And **the report is honest about what failed**, per item,
// because a migration that claims success while three mailboxes are missing
// destroys confidence permanently and is the reason people do not switch panels.

// A plan arriving from a parser is not trusted. Every field is re-validated by
// the job that uses it, which is where the validation lives anyway, and anything
// the plan asks for that this machine cannot do is refused per item rather than
// failing the whole run.
function planList(plan, key) {
  const value = plan && plan[key];
  return Array.isArray(value) ? value : [];
}

async function migratePreview(params) {
  const plan = params.plan || {};
  const db = await mysqlProbe();
  const mail = await stackProbe({ stack: 'mail' });
  const php = await phpVersions();
  const existingSites = readSites().sites.map(site => site.domain);

  const domains = planList(plan, 'domains');
  const databases = planList(plan, 'databases');
  const mailboxes = planList(plan, 'mailboxes');
  const clashes = domains.filter(entry => existingSites.includes(String(entry.domain || '').toLowerCase()));

  return {
    account: plan.account || null,
    will_create: {
      sites: domains.length - clashes.length,
      databases: databases.length,
      mailboxes: mailboxes.length,
      files: planList(plan, 'files').length,
      statistics: planList(plan, 'statistics').length,
    },
    // Said before anything runs, not discovered halfway through.
    blocked: [
      ...(databases.length && !db.available ? [{ what: `${databases.length} database(s)`, why: 'no database server is installed on this machine' }] : []),
      ...(mailboxes.length && !mail.available ? [{ what: `${mailboxes.length} mailbox(es)`, why: 'Postfix and Dovecot are not both installed on this machine' }] : []),
      ...(domains.length && !php.count ? [{ what: 'PHP for the imported sites', why: 'PHP is not installed, so the sites will be static until it is' }] : []),
      ...clashes.map(entry => ({ what: entry.domain, why: 'a site with this name already exists here and will be left alone' })),
    ],
    // Carried straight through from the parser rather than reworded, because it
    // knows what it could not read and this does not.
    warnings: planList(plan, 'warnings'),
    unsupported: planList(plan, 'unsupported'),
    cutover: 'Nothing is switched over by this. DNS is untouched and the old server keeps serving until you point the name here yourself.',
  };
}


// ── Carrying the content of a migration, not only its shape ──────
//
// The plan says what to build. The archive holds what to put in it. Until these
// were joined, a migration created a working, empty document root, an empty
// database with the right name and an address with no mail behind it, and every
// one of those looks finished from the panel.
//
// Panel-neutral on purpose. Nothing below knows what cPanel is: the plan names a
// member prefix, this puts what is under that prefix where it belongs and reads
// it back. A DirectAdmin or Plesk mapper supplies different prefixes and reuses
// all of this unchanged.

const { readArchiveFile } = require('../archiveFormat');
const { membersUnder, writeMembers, countFiles } = require('./migrationContent');

function openMigrationArchive(archivePath) {
  // Read once and held for the run. The same reader the plan was parsed with,
  // so an archive that could be read to make the plan can be read to fill it.
  const { entries } = readArchiveFile(archivePath);
  return entries;
}

async function placeSiteFiles(domainName, prefix, entries) {
  const members = membersUnder(entries, prefix);
  if (!members.length) throw new Error(`the archive holds no files under ${prefix}`);
  const site = readSites().sites.find(item => item.domain === domainName);
  if (!site) throw new Error(`${domainName} does not exist here, so its files have nowhere to go`);
  const root = documentRoot(site);
  ensureDir(root, 0o750);
  const before = countFiles(root);
  const { written, bytes } = writeMembers(root, members);
  const after = countFiles(root);
  if (after - before < written) {
    throw new Error(`${written} file(s) were written into ${domainName} and only ${after - before} are there afterwards`);
  }
  const owner = siteOwner(site);
  await must(command(['/bin/chown', '/usr/bin/chown']), ['-RhP', `${owner.uid}:${nginxGroup()}`, root],
    { timeoutMs: 300000 }, `ownership could not be applied to the files placed in ${domainName}`);
  return { domain: domainName, files: written, bytes, verified: true };
}

async function placeMailboxContent(entry, prefix, entries) {
  const members = membersUnder(entries, prefix);
  if (!members.length) throw new Error(`the archive holds no mail under ${prefix}`);
  const address = mailboxAddress(entry);
  const { maildir } = prepareMailboxHome(entry);
  // A cPanel-shaped mail folder is already Maildir++, which is what Dovecot
  // reads, so the tree goes across as it stands rather than being rebuilt.
  const { written, bytes } = writeMembers(maildir, members, 0o600);
  await must(command(['/bin/chown', '/usr/bin/chown']), ['-RhP', '5000:5000', path.dirname(maildir)],
    { timeoutMs: 300000 }, `ownership could not be applied to the mail placed in ${address}`);
  // Asked of the mail server rather than counted off the disk, because the
  // number that matters is the one Dovecot will serve.
  const counted = await mailboxMessageCount(address);
  if (!counted.messages) throw new Error(`${written} mail file(s) were placed in ${address} and Dovecot reads no messages there`);
  return { address, files: written, bytes, messages: counted.messages, verified: true };
}

async function migrateApply(params) {
  const plan = params.plan || {};
  const done = []; const failed = [];
  // What this run created, for the panel to claim on the way out. A migration
  // makes many things at once, which no single-resource scope can describe, and
  // until these were handed back a migrated resource belonged to nobody: the
  // reads narrow by ownership, so the account that had just moved in could not
  // see what it had moved.
  const claims = [];
  // The archive the plan was read out of. Opened once, and its absence is a
  // reported condition rather than a failure: everything is still built, and
  // every piece of content that could not be carried is named below.
  let archive = null;
  if (params.archivePath) {
    try { archive = openMigrationArchive(params.archivePath); }
    catch (error) { failed.push({ what: 'the archive', why: `it could not be read, so nothing was filled in: ${firstLine(error.message)}` }); }
  }
  // Kept apart from `done` on purpose. Everything in `done` is written into the
  // durable record; this list is handed to the owner once, in the response to
  // the run that generated it, and is never stored anywhere.
  const credentials = [];
  const step = async (what, run) => {
    try { const result = await run(); done.push({ what, result: result && result.verified ? 'verified' : 'done' }); return result; }
    catch (error) { failed.push({ what, why: firstLine(error.message) }); return null; }
  };

  for (const entry of planList(plan, 'domains')) {
    const name = String(entry.domain || '').toLowerCase();
    if (!name) continue;
    if (readSites().sites.some(site => site.domain === name)) { failed.push({ what: `site ${name}`, why: 'already exists here and was left alone' }); continue; }
    const made = await step(`site ${name}`, () => siteCreate({ domain: name, documentRoot: entry.documentRoot || 'public' }));
    if (!made) continue;
    claims.push({ kind: 'site', key: name });
    if (!entry.filesPrefix) {
      failed.push({ what: `files for ${name}`, why: 'the plan names no files for this site in the archive, so its document root is empty' });
    } else if (!archive) {
      failed.push({ what: `files for ${name}`, why: 'the archive was not available to this run, so the site was created empty' });
    } else {
      await step(`files for ${name}`, () => placeSiteFiles(name, entry.filesPrefix, archive));
    }
  }

  // Asked once rather than discovered per database. Without this every database
  // in the plan failed with "spawn mariadb ENOENT", which is true and is not a
  // sentence anybody should have to read to find out no database server is
  // installed here.
  const database = await mysqlProbe();
  for (const entry of planList(plan, 'databases')) {
    if (!database.available) {
      failed.push({ what: `database ${entry.name}`, why: `no database server is installed on this machine${database.reason ? `: ${database.reason}` : ''}` });
      continue;
    }
    const created = await step(`database ${entry.name}`, () => mysqlCreate({ name: entry.name }));
    if (!created) continue;
    claims.push({ kind: 'database', key: entry.name });
    if (!entry.dumpPath) {
      failed.push({ what: `contents of ${entry.name}`, why: 'the archive carries no dump for this database, so it was created empty' });
    } else if (!archive) {
      failed.push({ what: `contents of ${entry.name}`, why: 'the archive was not available to this run, so the database was created empty' });
    } else {
      const dump = archive.get(entry.dumpPath);
      if (!dump) failed.push({ what: `contents of ${entry.name}`, why: `the dump ${entry.dumpPath} is named in the plan and is not in the archive` });
      else await step(`contents of ${entry.name}`, () => databaseImport({ name: entry.name, sql: dump.toString('utf8') }));
    }
    for (const user of (Array.isArray(entry.users) ? entry.users : [])) {
      // A password cannot come out of an archive, so a new one is generated and
      // handed back once. The alternative is a user that exists and cannot
      // connect, which is worse than saying so.
      const password = dbPassword(appSecret(24));
      const madeUser = await step(`database user ${user.username}`, () => mysqlUserCreate({ username: user.username, password }));
      if (madeUser) {
        credentials.push({ what: `database user ${user.username}`, username: user.username, password });
        await step(`grant ${user.username} on ${entry.name}`, () => mysqlGrant({ name: entry.name, username: user.username, privileges: user.privileges === 'read' ? 'read' : 'all' }));
      }
    }
  }

  for (const entry of planList(plan, 'mailboxes')) {
    const password = dbPassword(appSecret(20));
    const made = await step(`mailbox ${entry.address}`, () => mailMailboxCreate({
      domain: entry.domain, account: entry.account, password, quotaMb: entry.quotaMb == null ? 0 : entry.quotaMb,
    }));
    if (!made) continue;
    credentials.push({ what: `mailbox ${made.address}`, username: made.address, password });
    // Claimed by domain, which is how resource_owners tracks mail, so a second
    // mailbox on the same domain is the same claim rather than a second row.
    if (!claims.some(claim => claim.kind === 'mailbox' && claim.key === entry.domain)) claims.push({ kind: 'mailbox', key: entry.domain });
    if (!entry.mailPrefix) {
      // Named with the way out rather than left as a complaint. An archive
      // without a mail tree is the normal shape of a configuration-only backup,
      // and the copy that fills it is already built and does not need one.
      failed.push({ what: `mail for ${made.address}`, why: 'the archive carries no stored mail for this address, so the mailbox is empty. Copy it from the old server with Migrate mailbox over IMAP, which reads the far side directly and needs no archive' });
    } else if (!archive) {
      failed.push({ what: `mail for ${made.address}`, why: 'the archive was not available to this run, so the mailbox is empty' });
    } else {
      await step(`mail for ${made.address}`, () => placeMailboxContent(
        { domain: entry.domain, account: entry.account }, entry.mailPrefix, archive,
      ));
    }
  }

  for (const entry of planList(plan, 'forwarders')) {
    const at = String(entry.from || '').split('@');
    if (at.length !== 2) { failed.push({ what: `forwarder ${entry.from}`, why: 'the address could not be read' }); continue; }
    await step(`forwarder ${entry.from}`, () => mailForward({ domain: at[1], account: at[0], forward: entry.to, remove: false }));
  }

  return {
    done, failed, claims,
    counts: { done: done.length, failed: failed.length },
    // Passwords are generated here because archives carry hashes the target
    // cannot reuse. They appear once, in the response to this run, and the owner
    // has to write them down; there is nowhere else they exist in readable form.
    // `deliver_once` is the name the operations service knows to hand back to
    // the caller and to leave out of the record.
    deliver_once: credentials,
    // Named so it is a count and not a password. `passwords_generated` was
    // matched by the record's own redaction and every migration recorded the
    // number as [protected], which reads like a leak and is a tally.
    credentials_generated: credentials.length,
    cutover: 'Nothing was switched over. The old server is still serving these names until you change DNS yourself.',
    verified: true,
  };
}

// ── Migration by IMAP, for the majority who have no archive ────────
//
// Most people who want to leave cannot get an archive out of the place they are
// leaving. They have a mailbox, a password and a server name somebody wrote
// down for them years ago, and that is enough, because Dovecot can be its own
// migration tool: the imapc driver reads the far side over IMAP and writes into
// the Maildir this machine already owns. That is why this uses doveadm rather
// than a third-party synchroniser. No extra package, and the thing writing the
// mail is the same thing that will serve it afterwards.
//
// Three rules shape all of it. **The far side is never written to**, which is
// why this is `doveadm backup` rather than `doveadm sync`: backup is one-way and
// treats the source as authoritative, and somebody's live mail server is not a
// thing this panel gets to modify. **The password never becomes an argument**,
// because a process list is readable by every user on the machine, so the
// connection settings go into a private file on tmpfs that lives for the length
// of the copy. And **the copy is counted afterwards against what the source
// said it held**, because a migration that reports success while a folder is
// missing is the reason people stop trusting panels.

// tmpfs, root only, and gone when the machine restarts. The copy settings carry
// somebody's live mail password and have no business on a disk.
const IMAP_RUNTIME = (process.env.JOTPANEL_OPS_RUNTIME_DIR ?? process.env.ARCA_OPS_RUNTIME_DIR) || '/run/jotpanel-ops';
const IMAP_REQUEST = path.join(IMAP_RUNTIME, 'migrate-imap-request.json');
const DOVEADM = ['/usr/bin/doveadm', '/usr/sbin/doveadm', 'doveadm'];
const DOVECONF = ['/usr/bin/doveconf', '/usr/sbin/doveconf', 'doveconf'];

function imapSourceParams(params) {
  const security = ['tls', 'starttls', 'plain'].includes(String(params.security || '')) ? String(params.security) : 'tls';
  const host = String(params.host || '').trim().toLowerCase();
  if (!host || host.length > 253 || !/^[a-z0-9][a-z0-9.:_-]*$/.test(host)) throw new Error(`${params.host} is not a mail server name or address`);
  const port = params.port == null || params.port === '' ? (security === 'tls' ? 993 : 143) : Number(params.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('The mail server port must be a whole number between 1 and 65535');
  const username = String(params.username == null ? '' : params.username);
  const password = String(params.password == null ? '' : params.password);
  // A line break in either of these is how a client that builds strings ends up
  // sending a command nobody asked for, on the far side and in the Dovecot
  // configuration file alike. Both build strings, so both refuse the character.
  if (!username || username.length > 255 || /[\r\n\0]/.test(username)) throw new Error('The mailbox login is required and must be one line');
  if (!password || password.length > 255 || /[\r\n\0]/.test(password)) throw new Error('The mailbox password is required and must be one line');
  return { host, port, security, username, password, allowUntrusted: params.allowUntrusted === true || params.allowUntrusted === 'true' };
}

// Permission, not presence. doveadm is on disk on every machine that has
// Dovecot at all, and that says nothing about whether this build knows the
// imapc driver. Asking the configuration parser for one of its settings is the
// only answer that means anything, because a build without imapc does not have
// the setting and says so.
async function migrateImapProbe() {
  const mail = await stackProbe({ stack: 'mail' });
  if (!mail.available) return { available: false, reason: mail.reason || 'Postfix and Dovecot are not both runnable on this machine' };
  const setting = await runFile(command(DOVECONF), ['-h', 'imapc_host'], { timeoutMs: 15000 });
  if (!setting.ok) return { available: false, reason: `this Dovecot build does not know the imapc settings, so it cannot read another server's mail (${firstLine(setting.stderr || setting.stdout)})` };
  const backup = await runFile(command(DOVEADM), ['help', 'backup'], { timeoutMs: 15000 });
  if (!backup.ok) return { available: false, reason: `this Dovecot build has no doveadm backup command (${firstLine(backup.stderr || backup.stdout)})` };
  return { available: true, driver: 'dovecot-imapc' };
}

// A read, and the only one in the migration set. It logs in to the server
// somebody is leaving, counts what is in it and logs out, and it is worth doing
// on its own: most failed migrations are a wrong password or a folder nobody
// knew was there, and both are cheaper to find out before the copy than during.
async function migrateImapInspect(params) {
  const source = imapSourceParams(params);
  const inspected = await inspectImapSource({ ...source, timeoutMs: 45000 });
  const { password: _password, ...connection } = source;
  return { ...inspected, connection };
}

// What Dovecot itself says is in a local mailbox, folder by folder. This is the
// read-back for the copy, and it asks Dovecot rather than counting files,
// because the number that matters is the one the mail server will serve.
async function mailboxMessageCount(address) {
  const result = await must(command(DOVEADM), ['mailbox', 'status', '-u', address, 'messages', '*'], { timeoutMs: 300000 }, `Dovecot could not count what is in ${address}`);
  const folders = [];
  for (const raw of String(result.stdout || '').split('\n')) {
    const match = /^(.+?)\s+messages=(\d+)$/.exec(raw.trim());
    if (match) folders.push({ folder: match[1].trim(), messages: Number(match[2]) });
  }
  return { messages: folders.reduce((total, folder) => total + folder.messages, 0), folders };
}

async function migrateImapPull(params) {
  const target = { domain: domain(params.domain), account: localPart(params.account) };
  const address = `${target.account}@${target.domain}`;
  const entry = readMail().mailboxes.find(item => mailboxAddress(item) === address);
  if (!entry) throw new Error(`${address} does not exist on this server yet, so there is nothing to copy into. Create the mailbox first.`);

  const probe = await migrateImapProbe();
  if (!probe.available) throw new Error(probe.reason);

  const source = imapSourceParams(params);
  const replace = params.replace === true || params.replace === 'true';

  // Looked at before a byte is written, so a wrong password is one sentence now
  // rather than a background job that fails twenty minutes from now, and so
  // there is a number to check the copy against when it finishes.
  const before = await inspectImapSource({ ...source, timeoutMs: 45000 });

  const existing = await mailboxMessageCount(address);
  if (existing.messages > 0 && !replace) {
    throw new Error(`${address} already holds ${existing.messages} message(s) on this server. A copy mirrors the other server over the top of them, so this refuses unless the mirror is what you asked for.`);
  }

  writeState(IMAP_REQUEST, { address, source, replace, requested_at: new Date().toISOString() });
  let ran;
  try {
    // Nineteen minutes here against the unit's twenty-five, so the socket is
    // still waiting when the unit reports. A copy that runs out of time is not
    // lost work: doveadm backup is incremental, and running it again carries on
    // from what is already here rather than starting the mailbox over.
    ran = await runPrivilegedOneshot('migrate-imap', `The mailbox copy into ${address}`, { waitMs: 1140000 });
  } finally {
    // Removed on every path. The daemon put a live mail password in here and
    // the only acceptable lifetime for that is the length of one copy.
    try { fs.unlinkSync(IMAP_REQUEST); } catch { /* the oneshot removes it too */ }
  }

  const after = await mailboxMessageCount(address);
  const shortfall = before.message_count - after.messages;
  if (shortfall > 0) {
    throw new Error(`${address} holds ${after.messages} message(s) and the other server said it had ${before.message_count}. ${shortfall} did not arrive, so this is not being recorded as a finished copy. Running it again continues where it stopped.`);
  }
  return {
    address,
    source: { host: source.host, port: source.port, security: source.security, username: source.username },
    certificate_verified: before.certificate_verified,
    source_messages: before.message_count,
    source_folders: before.folder_count,
    copied_messages: after.messages,
    folders: after.folders,
    // Said out loud because it is the question the owner asks next, and the
    // answer is no. Mail sent to this address still goes wherever the MX record
    // points, which is the old server until somebody changes it.
    unreadable_at_source: before.unreadable,
    cutover: 'Nothing was switched over. Mail still arrives at the old server until you change the MX record yourself.',
    note: ran && ran.note ? ran.note : null,
    verified: true,
  };
}

// Runs inside the oneshot, where the copy can take as long as it takes without
// holding a socket open. The connection settings are read once and the file
// carrying them is removed immediately, so the password exists on tmpfs for the
// few milliseconds between the daemon writing it and this reading it.
// Where this mailbox's mail really sits, expanded from the mail_location
// Dovecot is configured with rather than assumed to be under the home. If it
// cannot be worked out, the caller refuses rather than guessing: the only thing
// this path is used for is moving somebody's mail, and a guess there is the
// worst kind of wrong.
async function maildirFor(address) {
  const at = String(address).lastIndexOf('@');
  if (at < 1) return null;
  const account = address.slice(0, at);
  const dom = address.slice(at + 1);
  const configured = await runFile(command(DOVECONF), ['-h', 'mail_location'], { timeoutMs: 15000 });
  const location = String(configured.stdout || '').trim();
  const maildir = location.match(/^maildir:([^\s:]+)/);
  if (!maildir) return null;
  return maildir[1].replace(/%d/g, dom).replace(/%n/g, account).replace(/%u/g, address);
}

async function runImapPull() {
  const request = readState(IMAP_REQUEST, null);
  try { fs.unlinkSync(IMAP_REQUEST); } catch { /* already gone is the wanted state */ }
  if (!request || !request.address || !request.source) throw new Error('No mailbox copy was waiting to be run');
  const address = email(request.address);
  const source = imapSourceParams(request.source);
  const replace = request.replace === true;

  // ── Making a mailbox match another one ────────────────────────
  //
  // `doveadm backup -R` mirrors, which means it deletes what the other server
  // does not have. Into an empty mailbox that is exactly right and it is what
  // the copy has always done. Into a mailbox that already holds mail it fails,
  // every time, with:
  //
  //   Error: Mailbox INBOX sync: mailbox_delete failed: INBOX can't be deleted.
  //
  // and by then it has already emptied the mailbox. So the destructive version
  // of this operation destroyed somebody's migrated mail and then reported a
  // failure, which is the worst outcome available.
  //
  // The reason, established by trying it four ways on the box rather than by
  // reading about it: dsync can CREATE INBOX carrying the other server's
  // mailbox GUID, and cannot delete and recreate one that already exists.
  // Emptying the mailbox first does not help, because the mailbox is still
  // there. A full sync does not help. The only thing that works is INBOX not
  // existing when the copy starts.
  //
  // So the mailbox is moved aside, whole, and the copy then runs into a
  // mailbox that is not there, which is the case that has always worked. What
  // was moved aside is kept and named in the result: an operation that replaces
  // somebody's mail should leave the old copy somewhere they can be pointed at,
  // and if the copy fails it is put straight back, so a failed replace leaves
  // the mailbox exactly as it was.
  let maildir = null;
  let aside = null;
  if (replace) {
    maildir = await maildirFor(address);
    if (!maildir) throw new Error(`this server's mail location could not be read, so ${address} cannot be replaced safely`);
    if (fs.existsSync(maildir)) {
      aside = `${maildir}.arca-replaced-${new Date().toISOString().replace(/[:.]/g, '')}`;
      fs.renameSync(maildir, aside);
    }
  }

  const putItBack = () => {
    if (!aside || !fs.existsSync(aside)) return false;
    // Whatever the failed copy managed to create goes, and the mailbox that was
    // there before comes back.
    try { fs.rmSync(maildir, { recursive: true, force: true }); } catch { /* nothing there is the wanted state */ }
    fs.renameSync(aside, maildir);
    return true;
  };

  const configPath = writeImapcConfig(source);
  try {
    // -R is what makes this one-way from the remote into here. Without it the
    // direction is the other way and this would write into somebody's live mail
    // server, which is the single worst thing a migration tool can do.
    const result = await runFile(command(DOVEADM), ['-c', configPath, 'backup', '-R', '-u', address, 'imapc:'], { timeoutMs: 1080000 });
    if (!result.ok) {
      const restored = putItBack();
      throw new Error(`${failure(result, `the mailbox copy into ${address} failed`)}${restored ? `. Nothing was lost: ${address} has been put back exactly as it was.` : ''}`);
    }
    const said = firstLine(result.stdout || result.stderr || '');
    return {
      address, host: source.host, replaced: replace,
      previous_contents_kept_at: aside,
      note: said === 'The job failed' ? null : said,
      copied: true,
    };
  } catch (error) {
    putItBack();
    throw error;
  } finally {
    try { fs.unlinkSync(configPath); } catch { /* removed either way */ }
  }
}

// Dovecot's own configuration language, quoted rather than interpolated. A
// password is allowed to contain a hash or a quote and neither is allowed to
// end the value early.
function confValue(value) {
  return `"${String(value).replace(/([\\"])/g, '\\$1')}"`;
}

function writeImapcConfig(source) {
  ensureDir(IMAP_RUNTIME, 0o750);
  const file = path.join(IMAP_RUNTIME, `imapc-${crypto.randomBytes(12).toString('hex')}.conf`);
  const ssl = source.security === 'tls' ? 'imaps' : source.security === 'starttls' ? 'starttls' : 'no';
  const body = `# Written by jotpanel-ops for one mailbox copy and removed as soon as it ends.
# The panel's own configuration is included first so the local side of the copy
# is exactly the mail store this machine already serves.
!include /etc/dovecot/dovecot.conf
imapc_host = ${confValue(source.host)}
imapc_port = ${source.port}
imapc_user = ${confValue(source.username)}
imapc_password = ${confValue(source.password)}
imapc_ssl = ${ssl}
imapc_ssl_verify = ${source.allowUntrusted ? 'no' : 'yes'}
ssl_client_ca_dir = /etc/ssl/certs
# rfc822.size and fetch-headers keep this to one round trip per message on
# servers that support them, which is the difference between a mailbox copying
# in minutes and in hours.
imapc_features = rfc822.size fetch-headers
mail_prefetch_count = 20
`;
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

// ── SFTP for one site ─────────────────────────────────────────────
//
// The site already has a system user with no shell. Giving it SFTP means adding
// it to one group that sshd chroots and confining it to its own directory, and
// never giving it a shell, which is why ForceCommand is internal-sftp rather
// than anything that could run a command.
//
// The chroot has to be a directory the occupant cannot write, or sshd refuses
// the session outright, which is why a site's base is root owned and only the
// document root inside it belongs to the site.
const SFTP_GROUP = 'jotpanel-sftp';
// Suspension is a second group rather than a change to the SFTP group or the
// user's password, because both of those are the customer's own settings and
// unsuspending has to put back exactly what was there. Membership of this
// group is the only thing that changes, and sshd refuses the session before
// any authentication method is tried, so it holds whether the customer signs
// in with the password the panel set or a key that arrived some other way.
const SFTP_SUSPENDED_GROUP = 'jotpanel-suspended';
const SSHD_DROPIN = '/etc/ssh/sshd_config.d/jotpanel-sftp.conf';

async function ensureSftpConfig() {
  for (const name of [SFTP_GROUP, SFTP_SUSPENDED_GROUP]) {
    if (!groupExists(name)) {
      await must(command(['/usr/sbin/groupadd', '/usr/bin/groupadd']), ['--system', name], { timeoutMs: 20000 }, `the ${name} group could not be created`);
    }
  }
  // DenyGroups goes above the Match, deliberately. Everything after a Match
  // line in an sshd config file belongs to that Match and to nothing else, so
  // a DenyGroups written underneath it would only ever apply to members of
  // jotpanel-sftp who were already matched, and would read as correct.
  const wanted = `# Managed by jotpanel-ops. Edit through the panel.
DenyGroups ${SFTP_SUSPENDED_GROUP}
Match Group ${SFTP_GROUP}
  ChrootDirectory %h
  ForceCommand internal-sftp
  AllowTcpForwarding no
  AllowAgentForwarding no
  X11Forwarding no
  PermitTunnel no
`;
  ensureDir(path.dirname(SSHD_DROPIN), 0o755);
  const current = fs.existsSync(SSHD_DROPIN) ? fs.readFileSync(SSHD_DROPIN, 'utf8') : null;
  if (current !== wanted) {
    fs.writeFileSync(SSHD_DROPIN, wanted, { mode: 0o644 });
    // Checked before the running sshd is asked to take it, because a bad drop-in
    // that gets reloaded is how a machine loses its own administrator.
    const test = await runFile(command(['/usr/sbin/sshd', '/usr/bin/sshd']), ['-t'], { timeoutMs: 20000 });
    if (!test.ok) {
      if (current === null) { try { fs.unlinkSync(SSHD_DROPIN); } catch {} } else fs.writeFileSync(SSHD_DROPIN, current, { mode: 0o644 });
      throw new Error(`sshd rejected the generated SFTP configuration: ${firstLine(test.stderr || test.stdout)}`);
    }
    await reloadService(sshUnit());
  }
  return { group: SFTP_GROUP, config: SSHD_DROPIN };
}

function sshUnit() {
  for (const unit of ['ssh.service', 'sshd.service']) {
    if (fs.existsSync(`/lib/systemd/system/${unit}`) || fs.existsSync(`/usr/lib/systemd/system/${unit}`)) return unit;
  }
  return 'ssh.service';
}

function groupExists(name) {
  return fs.readFileSync('/etc/group', 'utf8').split('\n').some(line => line.split(':')[0] === name);
}

function groupMembers(name) {
  const row = fs.readFileSync('/etc/group', 'utf8').split('\n').find(line => line.split(':')[0] === name);
  return row ? (row.split(':')[3] || '').split(',').filter(Boolean) : [];
}

async function sftpStatus(params) {
  const name = domain(params.domain);
  const { site } = siteRootFor(name);
  const user = site.user || siteUserName(name);
  return {
    domain: name, user,
    enabled: groupExists(SFTP_GROUP) && groupMembers(SFTP_GROUP).includes(user),
    home: siteBase(name),
    // The path they will see once connected, because a chroot makes every
    // instruction about absolute paths wrong and this is the commonest support
    // question any panel gets.
    path_after_login: `/${path.basename(documentRoot(site))}`,
    port: 22,
  };
}

async function sftpEnable(params) {
  const name = domain(params.domain);
  const { site } = siteRootFor(name);
  const user = site.user || siteUserName(name);
  const password = dbPassword(String(params.password || ''));
  if (password.length < 12) throw new Error('An SFTP password must be at least 12 characters');
  const config = await ensureSftpConfig();

  // sshd refuses to chroot into a directory its occupant can write, and it says
  // so only in the authentication log while the client sees the connection
  // close. A site created before this rule existed still has a base owned by
  // its own user, so enabling SFTP puts that right rather than assuming it, and
  // then checks it, because the failure is otherwise invisible from the panel.
  const base = siteBase(name);
  fs.chownSync(base, 0, 0);
  fs.chmodSync(base, 0o755);
  const chroot = fs.statSync(base);
  if (chroot.uid !== 0 || (chroot.mode & 0o022)) {
    throw new Error(`${base} must be owned by root and not group or world writable before sshd will chroot into it`);
  }

  await must(command(['/usr/sbin/usermod', '/usr/bin/usermod']), ['--append', '--groups', SFTP_GROUP, user], { timeoutMs: 20000 }, `${user} could not be added to ${SFTP_GROUP}`);
  await must(command(['/usr/sbin/chpasswd', '/usr/bin/chpasswd']), [], { input: `${user}:${password}\n`, timeoutMs: 20000 }, 'the SFTP password could not be set');
  if (!groupMembers(SFTP_GROUP).includes(user)) throw new Error(`${user} did not read back as a member of ${SFTP_GROUP}`);
  const test = await runFile(command(['/usr/sbin/sshd', '/usr/bin/sshd']), ['-t'], { timeoutMs: 20000 });
  if (!test.ok) throw new Error(`sshd will not accept its configuration after the change: ${firstLine(test.stderr)}`);
  return { ...(await sftpStatus({ domain: name })), config: config.config, verified: true };
}

// Called once per site the account owns when an account is suspended or
// unsuspended, from the admin routes, alongside site.suspend and
// mail.domain.suspend. It does not use sftp.disable: that one deletes the
// customer's password on purpose, so an account suspended with it and then
// unsuspended would come back with SFTP silently dead and nothing recording
// what the password had been. This only adds or removes the deny group, which
// leaves the SFTP setting, the password and the group membership untouched,
// so unsuspending needs no memory of what was there before.
async function sftpSuspend(params) {
  const name = domain(params.domain);
  const suspended = !!params.suspended;
  const { site } = siteRootFor(name);
  const user = site.user || siteUserName(name);
  // The config has to exist before the deny can mean anything: on a box where
  // nobody ever turned SFTP on there is no drop-in, so DenyGroups is not in
  // force and adding somebody to the group would do nothing at all while
  // reading back as done.
  const config = await ensureSftpConfig();
  if (!userExists(user)) return { domain: name, user, suspended, sftp_user: false, verified: true };

  if (suspended) {
    if (!groupMembers(SFTP_SUSPENDED_GROUP).includes(user)) {
      await must(command(['/usr/sbin/usermod', '/usr/bin/usermod']), ['--append', '--groups', SFTP_SUSPENDED_GROUP, user], { timeoutMs: 20000 }, `${user} could not be added to ${SFTP_SUSPENDED_GROUP}`);
    }
  } else if (groupMembers(SFTP_SUSPENDED_GROUP).includes(user)) {
    await must(command(['/usr/sbin/gpasswd', '/usr/bin/gpasswd']), ['--delete', user, SFTP_SUSPENDED_GROUP], { timeoutMs: 20000 }, `${user} could not be removed from ${SFTP_SUSPENDED_GROUP}`);
  }

  const test = await runFile(command(['/usr/sbin/sshd', '/usr/bin/sshd']), ['-t'], { timeoutMs: 20000 });
  if (!test.ok) throw new Error(`sshd will not accept its configuration after the change: ${firstLine(test.stderr || test.stdout)}`);
  await reloadService(sshUnit());
  const now = groupMembers(SFTP_SUSPENDED_GROUP).includes(user);
  if (now !== suspended) throw new Error(`${user} did not read back as ${suspended ? 'suspended' : 'restored'} for SFTP`);
  const denied = fs.readFileSync(SSHD_DROPIN, 'utf8').split('\n').some(l => l.trim() === `DenyGroups ${SFTP_SUSPENDED_GROUP}`);
  if (!denied) throw new Error('The SFTP configuration does not deny the suspended group, so suspending would not stop anything');
  return { domain: name, user, suspended, sftp_user: true, config: config.config, verified: true };
}

function userExists(name) {
  return fs.readFileSync('/etc/passwd', 'utf8').split('\n').some(line => line.split(':')[0] === name);
}

async function sftpDisable(params) {
  const name = domain(params.domain);
  const { site } = siteRootFor(name);
  const user = site.user || siteUserName(name);
  if (groupExists(SFTP_GROUP) && groupMembers(SFTP_GROUP).includes(user)) {
    await must(command(['/usr/sbin/gpasswd', '/usr/bin/gpasswd']), ['--delete', user, SFTP_GROUP], { timeoutMs: 20000 }, `${user} could not be removed from ${SFTP_GROUP}`);
  }
  // The password goes as well, so somebody who wrote it down before it was
  // turned off cannot sign in afterwards. passwd --delete rather than --lock,
  // because a locked account is one prefix character away from being a working
  // one again and this should leave nothing to unlock.
  await must(command(['/usr/bin/passwd', '/bin/passwd']), ['--delete', user], { timeoutMs: 20000 }, `the password for ${user} could not be removed`);
  await must(command(['/usr/bin/passwd', '/bin/passwd']), ['--lock', user], { timeoutMs: 20000 }, `${user} could not be locked`);
  if (groupMembers(SFTP_GROUP).includes(user)) throw new Error(`${user} is still a member of ${SFTP_GROUP}`);
  return { ...(await sftpStatus({ domain: name })), locked: true, verified: true };
}

// ── A site's own files ────────────────────────────────────────────
//
// The panel runs as jotpanel and a site tree is drwxr-x--- owned by that site's
// user, so the web process cannot read it, and anything it did write would
  // belong to jotpanel and the site's own PHP could not then change it, which breaks
// WordPress updating itself. So file work on a site comes here, where the
// ownership can be put right, and the site's own directory is the boundary.
function siteRootFor(name) {
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === domain(name));
  if (!site) throw new Error(`${domain(name)} is not a site on this server`);
  return { site, base: siteBase(site.domain), root: documentRoot(site) };
}

// Every path a caller sends is resolved against the site's own tree and refused
// if it lands outside it, before anything is opened. Symlinks are resolved too,
// because a link inside the tree pointing at /etc is the obvious way out.
function sitePath(name, relative, { mustExist = false } = {}) {
  const { site, base, root } = siteRootFor(name);
  const clean = String(relative == null ? '' : relative).replace(/^\/+/, '');
  if (clean.includes('\0')) throw new Error('That path is not valid');
  const resolved = path.resolve(root, clean);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('That path is outside the site');
  const realRoot = fs.realpathSync(root);
  if (fs.existsSync(resolved)) {
    const real = fs.realpathSync(resolved);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('That path leaves the site through a link');
  } else if (mustExist) throw new Error('That path does not exist');

  // The check above only fires when the target already exists, and that was a
  // hole rather than an oversight worth leaving. `path.resolve` is lexical, so
  // it does not follow a link; `O_NOFOLLOW` guards the *final* component and
  // nothing above it; and `ensureDir` is `mkdir -p`, which walks a symlinked
  // directory without complaint. So a site's own SFTP user could put a link in
  // their document root, ask the panel to write to a path *through* it, and
  // have the root process create the file wherever the link pointed.
  //
  // Proved on the live box on 2026-08-28 before this was written: a link in a
  // customer's `public/` pointing at `/srv/arca-escape-probe` produced
  // `/srv/arca-escape-probe/ESCAPED.txt` owned by the site user, from an
  // ordinary `site.files.write`. Pointed at `/etc` it is the same call.
  //
  // So the deepest ancestor that actually exists is resolved and checked, which
  // is the first thing on the path the kernel can be made to follow. A leaf
  // that does not exist yet cannot be a link, and everything above it is now
  // covered whether it exists or not.
  let ancestor = resolved;
  while (ancestor !== root && ancestor.startsWith(root + path.sep) && !fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new Error('That path leaves the site through a link');
  }
  return { site, base, root, target: resolved, relative: path.relative(root, resolved) };
}

function siteOwner(site) {
  const record = passwdRecord(site.user || siteUserName(site.domain));
  if (!record) throw new Error(`${site.domain} has no system user`);
  return record;
}

// Never through a link.
//
// `chown` and `chmod` follow symlinks. A site's own user has SFTP into its own
// tree and can put a link there, so the sequence "check the path, then chown
// it" hands them any file on the machine if they swap the file between the two
// steps. That is cPanel's symlink escalation, and it is a race a local user
// wins easily by looping. `lchown` acts on the link itself and can never be
// pointed elsewhere, and a link is refused a mode change rather than followed.
//
// This does not make an intermediate directory component safe: only openat with
// O_NOFOLLOW per component would, and Node cannot express that. It closes the
// final component, which is the one a caller names.
function applySiteOwnership(site, target) {
  const owner = siteOwner(site);
  const gid = nginxGroup();
  const stat = fs.lstatSync(target);
  fs.lchownSync(target, owner.uid, gid);
  if (stat.isSymbolicLink()) return;
  fs.chmodSync(target, stat.isDirectory() ? 0o750 : 0o640);
}

// Writing into a site, with the final component never followed. O_NOFOLLOW
// makes the open fail outright if what is there is a link, which is the answer
// this wants: a caller asking to write a file must not end up writing through
// somebody's link into /etc.
function openInSiteNoFollow(target, mode = 0o640) {
  return fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode);
}

function writeIntoSite(target, content, mode = 0o640) {
  const handle = openInSiteNoFollow(target, mode);
  try { fs.writeSync(handle, content); } finally { fs.closeSync(handle); }
}

// Copied through file descriptors rather than by path, in chunks, because the
// staging limit is two gigabytes and reading that into memory to avoid a
// symlink would trade one fault for another.
function copyIntoSite(source, target, mode = 0o640) {
  const from = fs.openSync(source, 'r');
  let into;
  try {
    into = openInSiteNoFollow(target, mode);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(from, buffer, 0, buffer.length, null);
      if (!read) break;
      fs.writeSync(into, buffer, 0, read);
    }
  } finally {
    fs.closeSync(from);
    if (into !== undefined) fs.closeSync(into);
  }
}

async function siteFileList(params) {
  const { site, root, target, relative } = sitePath(params.domain, params.dir, { mustExist: false });
  if (!fs.existsSync(target)) return { domain: site.domain, dir: relative, entries: [], exists: false };
  if (!fs.statSync(target).isDirectory()) throw new Error('That is a file, not a folder');
  const entries = fs.readdirSync(target, { withFileTypes: true }).map(entry => {
    const full = path.join(target, entry.name);
    let info = null; try { info = fs.lstatSync(full); } catch {}
    return {
      name: entry.name,
      directory: entry.isDirectory(),
      symlink: !!info && info.isSymbolicLink(),
      size_bytes: info ? info.size : null,
      modified: info ? new Date(info.mtimeMs).toISOString() : null,
      mode: info ? (info.mode & 0o777).toString(8).padStart(3, '0') : null,
    };
  }).sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1));
  return { domain: site.domain, dir: relative, root, entries, count: entries.length, exists: true };
}

const EDITABLE_LIMIT = 2 * 1024 * 1024;

async function siteFileRead(params) {
  const { site, target, relative } = sitePath(params.domain, params.path, { mustExist: true });
  const stat = fs.statSync(target);
  if (stat.isDirectory()) throw new Error('That is a folder, not a file');
  if (stat.size > EDITABLE_LIMIT) throw new Error(`That file is ${Math.round(stat.size / 1024)} KB and this editor stops at ${EDITABLE_LIMIT / 1024} KB`);
  const content = fs.readFileSync(target);
  // A binary file opened in a text editor is how people destroy their own
  // uploads, so it is refused rather than mangled.
  if (content.includes(0)) throw new Error('That looks like a binary file rather than something to edit');
  return { domain: site.domain, path: relative, size_bytes: stat.size, content: content.toString('utf8') };
}

async function siteFileWrite(params) {
  const { site, target, relative } = sitePath(params.domain, params.path);
  const content = String(params.content == null ? '' : params.content);
  if (Buffer.byteLength(content) > EDITABLE_LIMIT) throw new Error('That is larger than this editor will save');
  ensureDir(path.dirname(target), 0o750);
  writeIntoSite(target, content);
  applySiteOwnership(site, target);
  // A path boundary rather than a string prefix. `startsWith` alone counts
  // /srv/jotpanel-sites/x/public-other as being inside /srv/jotpanel-sites/x/public,
  // which is not reachable from here because every step is an ancestor of a
  // contained path, and is the wrong test to leave lying about.
  const documents = documentRoot(site);
  for (let dir = path.dirname(target); dir === documents || dir.startsWith(documents + path.sep); dir = path.dirname(dir)) applySiteOwnership(site, dir);
  const after = fs.statSync(target);
  if (after.size !== Buffer.byteLength(content)) throw new Error('The file did not read back at the size it was written');
  return { domain: site.domain, path: relative, size_bytes: after.size, owner: siteOwner(site).user, verified: true };
}

async function siteFolderCreate(params) {
  const { site, target, relative } = sitePath(params.domain, params.path);
  if (fs.existsSync(target)) throw new Error('Something is already there');
  ensureDir(target, 0o750);
  applySiteOwnership(site, target);
  if (!fs.statSync(target).isDirectory()) throw new Error('The folder did not read back after creation');
  return { domain: site.domain, path: relative, verified: true };
}

async function siteFileDelete(params) {
  const { site, root, target, relative } = sitePath(params.domain, params.path, { mustExist: true });
  if (target === root) throw new Error('The document root itself cannot be deleted from here');
  const directory = fs.statSync(target).isDirectory();
  fs.rmSync(target, { recursive: directory, force: false });
  if (fs.existsSync(target)) throw new Error('It is still there after deleting');
  return { domain: site.domain, path: relative, directory, removed: true, verified: true };
}

async function siteFileRename(params) {
  const from = sitePath(params.domain, params.path, { mustExist: true });
  const to = sitePath(params.domain, params.target);
  if (fs.existsSync(to.target)) throw new Error('Something is already at the new name');
  fs.renameSync(from.target, to.target);
  applySiteOwnership(from.site, to.target);
  if (fs.existsSync(from.target) || !fs.existsSync(to.target)) throw new Error('The rename did not read back');
  return { domain: from.site.domain, from: from.relative, to: to.relative, verified: true };
}

// ── Password-protected directories ────────────────────────────────
//
// The pure half is siteProtect.js. This is the half that touches the machine:
// it keeps the htpasswd files, folds the fragment into the virtual host, and
// proves afterwards that the door is actually shut by asking for the page and
// expecting a 401.
//
// `renderAuthLocation` returns a scope and the caller must honour it. Protecting
// `/` goes in the server block, where auth_basic is inherited by every location
// including the PHP one. Protecting a subdirectory goes in its own `location ^~`
// block. Putting either in the wrong place leaves PHP files unauthenticated.

const PROTECT_DIR = '/etc/nginx/protect';

function protectSlug(urlPath) {
  return urlPath === '/' ? 'root' : urlPath.replace(/^\/+|\/+$/g, '').replace(/\//g, '-');
}

function protectFilePath(name, urlPath) {
  return currentOrLegacy(
    path.join(PROTECT_DIR, `jotpanel-${domain(name)}-${protectSlug(urlPath)}.htpasswd`),
    path.join(PROTECT_DIR, `arca-${domain(name)}-${protectSlug(urlPath)}.htpasswd`),
  );
}

function protectPath(value) {
  const clean = String(value == null || value === '' ? '/' : value);
  if (!clean.startsWith('/')) throw new Error('A protected path starts with a slash');
  const trimmed = clean.replace(/\/+$/, '') || '/';
  if (trimmed.split('/').some(part => part === '..')) throw new Error(`${value} is not a path inside the site`);
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(trimmed)) throw new Error(`${value} contains characters a protected path may not use`);
  return trimmed;
}

function readProtectEntries(file) {
  try { return parseHtpasswd(fs.readFileSync(file, 'utf8')).entries; } catch { return []; }
}

// What the virtual host needs, for every protected path on this site.
function protectFragments(site) {
  const rows = Array.isArray(site.protect) ? site.protect : [];
  const server = []; const locations = [];
  for (const row of rows) {
    const rendered = renderAuthLocation({
      path: row.path,
      authFilePath: protectFilePath(site.domain, row.path),
      realm: 'Restricted',
      phpSocketPath: site.php ? phpSocketPath(site.domain) : null,
    });
    (rendered.scope === 'server' ? server : locations).push(rendered.text);
  }
  return { server: server.join(''), locations: locations.join('') };
}

async function siteProtectList(params) {
  const { site } = siteRootFor(params.domain);
  const rows = Array.isArray(site.protect) ? site.protect : [];
  return {
    domain: site.domain,
    protected: rows.map(row => ({
      path: row.path,
      file: protectFilePath(site.domain, row.path),
      users: readProtectEntries(protectFilePath(site.domain, row.path)).map(entry => entry.username),
    })),
    count: rows.length,
  };
}

async function siteProtectSet(params) {
  const name = domain(params.domain);
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);
  const urlPath = protectPath(params.path);
  const username = String(params.user || '');
  const hash = hashPassword(String(params.password || ''));

  // The directory as well as the file. A 0640 file that nginx can read is no use
  // inside a 0750 directory owned root:root, because it cannot traverse in to
  // reach it, and the failure is a 500 rather than anything that says so.
  ensureDir(PROTECT_DIR, 0o750);
  try { fs.chownSync(PROTECT_DIR, 0, systemGroupId(nginxGroupName())); } catch { /* left root-only rather than widened */ }
  const file = protectFilePath(name, urlPath);
  const entries = addOrReplaceUser(readProtectEntries(file), username, hash);
  fs.writeFileSync(file, renderHtpasswd(entries), { mode: 0o640 });
  fs.chmodSync(file, 0o640);
  // nginx reads it as its worker user, so it is owned by root and readable by
  // the group nginx runs as, and by nobody else.
  try { fs.chownSync(file, 0, systemGroupId(nginxGroupName())); } catch { /* left root-only rather than widened */ }

  site.protect = (Array.isArray(site.protect) ? site.protect : []).filter(row => row.path !== urlPath);
  site.protect.push({ path: urlPath });
  site.protect.sort((a, b) => a.path.localeCompare(b.path));
  writeState(SITE_STATE, state);
  writeSiteConfig(site);
  await validateAndReloadNginx();

  // Read back by asking for the page. A config that parses is not the same as a
  // door that is shut, and this is the only question worth answering here.
  //
  // Over the scheme the site actually serves. A site that forces HTTPS answers
  // the plain request with a redirect before it ever reaches the password
  // check, so asking over http reported every protected directory as open on
  // exactly the sites people bother to protect. `--resolve` sends the real name
  // in SNI and in the Host header while still talking to this machine, and the
  // certificate is not being tested here, so a self-signed one is not a
  // failure of the door being shut.
  const suffix = urlPath === '/' ? '/' : `${urlPath}/`;
  const answered = await runFile(command(['/usr/bin/curl', '/bin/curl']),
    site.force_https || site.ssl
      ? ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '--resolve', `${name}:443:127.0.0.1`, `https://${name}${suffix}`]
      : ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${name}`, `http://127.0.0.1${suffix}`],
    { timeoutMs: 30000 });
  const status = Number((answered.stdout || '').trim()) || 0;
  if (status !== 401) throw new Error(`${urlPath} on ${name} answered ${status || 'nothing'} rather than asking for a password, so it is not protected`);

  return {
    domain: name, path: urlPath, user: username, file,
    users: entries.map(entry => entry.username),
    http_status: status, verified: true,
  };
}

async function siteProtectClear(params) {
  const name = domain(params.domain);
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);
  const urlPath = protectPath(params.path);
  const username = String(params.user || '');
  const rows = Array.isArray(site.protect) ? site.protect : [];
  if (!rows.some(row => row.path === urlPath)) throw new Error(`${urlPath} on ${name} is not protected`);

  const file = protectFilePath(name, urlPath);
  const left = removeUser(readProtectEntries(file), username);
  let opened = false;
  if (left.length) {
    fs.writeFileSync(file, renderHtpasswd(left), { mode: 0o640 });
    fs.chmodSync(file, 0o640);
  } else {
    // The last login is gone, so the directory is public again. Said out loud
    // rather than leaving an empty password file that refuses everybody.
    site.protect = rows.filter(row => row.path !== urlPath);
    try { fs.unlinkSync(file); } catch { /* already gone is the wanted state */ }
    opened = true;
    writeState(SITE_STATE, state);
    writeSiteConfig(site);
    await validateAndReloadNginx();
  }

  const answered = await runFile(command(['/usr/bin/curl', '/bin/curl']),
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${name}`, `http://127.0.0.1${urlPath === '/' ? '/' : `${urlPath}/`}`],
    { timeoutMs: 30000 });
  const status = Number((answered.stdout || '').trim()) || 0;
  if (opened && status === 401) throw new Error(`${urlPath} on ${name} still asks for a password after removing the last login`);
  if (!opened && status !== 401) throw new Error(`${urlPath} on ${name} stopped asking for a password when it should still be protected`);

  return {
    domain: name, path: urlPath, user: username,
    users: left.map(entry => entry.username),
    now_public: opened, http_status: status, verified: true,
  };
}

// ── Applications ──────────────────────────────────────────────────
//
// The most opened screen in any control panel, and the one this product did not
// have. It is a named job like everything else: the panel sends an application
// name from a closed list and a domain, never a URL, an archive path or a
// command, so nothing a customer types reaches a shell or a download.
const APPLICATIONS = {
  wordpress: {
    label: 'WordPress',
    // Fetched from the vendor's own canonical address, which is the only place
    // this ever downloads from and is not built from anything the caller sends.
    url: 'https://wordpress.org/latest.tar.gz',
    strip: 1,
    needsDatabase: true,
    entry: 'wp-config.php',
  },
  phpmyadmin: {
    label: 'phpMyAdmin',
    url: 'https://www.phpmyadmin.net/downloads/phpMyAdmin-latest-all-languages.tar.gz',
    strip: 1,
    needsDatabase: false,
    entry: 'index.php',
    speaks: ['mysql'],
    note: 'Speaks MySQL and MariaDB only.',
  },
  // The answer to "phpMyAdmin, but for Postgres". phpPgAdmin has not had a real
  // release in years and pgAdmin wants Apache and a Python stack, neither of
  // which belongs on an nginx-only panel. Adminer is one PHP file, still
  // maintained, and it speaks both engines this panel installs as well as
  // several nobody here hosts, which is exactly the thing somebody with an old
  // database somewhere else needs.
  adminer: {
    label: 'Adminer',
    url: 'https://www.adminer.org/latest.php',
    singleFile: true,
    needsDatabase: false,
    entry: 'index.php',
    speaks: ['mysql', 'postgres'],
    note: 'One file. Speaks MySQL, MariaDB and PostgreSQL, and SQLite, MS SQL, Oracle and Firebird if their PHP drivers are present.',
  },
};

function appSecret(length = 64) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function applicationList() {
  const db = await mysqlProbe();
  const php = await phpVersions();
  return {
    applications: Object.entries(APPLICATIONS).map(([id, app]) => ({
      id, label: app.label, needs_database: app.needsDatabase,
      speaks: app.speaks || null, note: app.note || null,
      // Honest about why it cannot be offered, per the rule, rather than a
      // disabled tile with no explanation.
      available: !!php.count && (!app.needsDatabase || db.available),
      reason: !php.count ? 'PHP is not installed on this server'
        : (app.needsDatabase && !db.available ? 'a database server is not installed on this server' : null),
    })),
    php: php.default,
    database: db.available,
  };
}

async function applicationInstall(params) {
  const app = APPLICATIONS[String(params.application || '')];
  if (!app) throw new Error('Unknown application');
  const name = domain(params.domain);
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not a site on this server`);
  if (!site.php) throw new Error(`${name} has no PHP pool, so it cannot run ${app.label}`);

  const root = documentRoot(site);
  const owner = passwdRecord(site.user || siteUserName(name));
  if (!owner) throw new Error(`${name} has no system user`);
  // What is already here, decided from the record rather than from a file name.
  //
  // This checked for the entry file, and a site created with PHP is given an
  // index.php the moment it exists, so every fresh PHP site claimed phpMyAdmin
  // was already installed on it. Watched on the box with Adminer.
  if (site.application) throw new Error(`${site.application.label || site.application.id} is already installed on ${name}. Remove it first, or use another site.`);
  // And an application is copied over the document root, so a site with real
  // content in it is refused rather than flattened. The page the panel writes
  // itself when a site is created does not count as content.
  const PANEL_DEFAULTS = new Set(['index.php', 'index.html']);
  const occupied = fs.readdirSync(root).filter(entry => !PANEL_DEFAULTS.has(entry));
  if (occupied.length) {
    throw new Error(`${name} already has files in it (${occupied.slice(0, 3).join(', ')}${occupied.length > 3 ? ` and ${occupied.length - 3} more` : ''}). Installing ${app.label} would copy over them, so this refuses. Use an empty site.`);
  }

  let database = null;
  if (app.needsDatabase) {
    const probe = await mysqlProbe();
    if (!probe.available) throw new Error('a database server is not installed on this server');
    const slug = `${DB_PREFIX}_${crypto.createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
    const password = dbPassword(appSecret(28));
    // The name is derived from the domain, so it is the same every time this
    // domain is installed onto. If it is already there, an earlier install for
    // this same site left it behind, and creating it again fails inside
    // MariaDB: what an operator saw was "ERROR 1007 (HY000) at line 1: Can't
    // create database 'arca_499a3113ab'; database exists", which names nothing
    // they recognise and suggests nothing they can do.
    if (await mysqlDatabaseExists(slug)) {
      throw new Error(`${name} already has a database from an earlier ${app.label} install (${slug}). Delete that database first, or install onto a different site.`);
    }
    await mysqlCreate({ name: slug });
    await mysqlUserCreate({ username: slug, password });
    await mysqlGrant({ name: slug, username: slug, privileges: 'all' });
    database = { name: slug, username: slug, password };
  }

  const work = fs.mkdtempSync(path.join('/tmp', 'jotpanel-app-'));
  try {
    if (app.singleFile) {
      // Some of these are one file rather than an archive. The download still
      // goes to the vendor's own canonical address and nowhere the caller named.
      const target = path.join(work, app.entry);
      await must(command(['/usr/bin/curl', '/bin/curl']), ['-fL', '--retry', '3', '--connect-timeout', '20', '-o', target, app.url],
        { timeoutMs: 600000 }, `${app.label} could not be downloaded`);
      const head = fs.readFileSync(target, 'utf8').slice(0, 200);
      if (!head.includes('<?php')) throw new Error(`what ${app.label} sent back is not a PHP file`);
    } else {
      const archive = path.join(work, 'app.tar.gz');
      await must(command(['/usr/bin/curl', '/bin/curl']), ['-fL', '--retry', '3', '--connect-timeout', '20', '-o', archive, app.url],
        { timeoutMs: 600000 }, `${app.label} could not be downloaded`);
      await must(command(['/usr/bin/tar', '/bin/tar']), ['-xzf', archive, '-C', work, `--strip-components=${app.strip}`],
        { timeoutMs: 300000 }, `${app.label} could not be unpacked`);
      fs.unlinkSync(archive);
    }

    if (params.application === 'wordpress' && database) {
      const sample = path.join(work, 'wp-config-sample.php');
      let config = fs.readFileSync(sample, 'utf8')
        .replace('database_name_here', database.name)
        .replace('username_here', database.username)
        .replace('password_here', database.password);
      config = config.replace(/put your unique phrase here/g, () => appSecret(64));
      fs.writeFileSync(path.join(work, 'wp-config.php'), config, { mode: 0o640 });
      fs.unlinkSync(sample);
    }

    // Copied in rather than moved, so a half-finished unpack never becomes a
    // half-installed site.
    await must(command(['/bin/cp', '/usr/bin/cp']), ['-a', `${work}/.`, `${root}/`], { timeoutMs: 300000 }, `${app.label} could not be placed`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  await must(command(['/bin/chown', '/usr/bin/chown']), ['-R', `${owner.uid}:${nginxGroup()}`, root], { timeoutMs: 120000 }, 'ownership could not be applied');
  const finder = command(['/usr/bin/find', '/bin/find']);
  await must(finder, [root, '-type', 'd', '-exec', 'chmod', '750', '{}', '+'], { timeoutMs: 120000 }, 'directory permissions could not be applied');
  await must(finder, [root, '-type', 'f', '-exec', 'chmod', '640', '{}', '+'], { timeoutMs: 120000 }, 'file permissions could not be applied');

  if (!fs.existsSync(path.join(root, app.entry))) throw new Error(`${app.label} did not read back after installation`);
  // Asked over HTTP through nginx and the site's own pool, because a directory
  // full of PHP files is not the same as a working application.
  const answered = await runFile(command(['/usr/bin/curl', '/bin/curl']), ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', `Host: ${name}`, 'http://127.0.0.1/'], { timeoutMs: 60000 });
  const status = Number((answered.stdout || '').trim()) || 0;
  if (status < 200 || status >= 400) throw new Error(`${app.label} was installed on ${name} but the site answered ${status || 'nothing'}`);

  // Written into the record, which is what the next install reads. A file on
  // disk cannot tell the panel whether it put it there.
  const after = readSites();
  const stored = after.sites.find(entry => entry.domain === name);
  if (stored) {
    // The database goes into the record too, and it is not decoration: without
    // it, deleting the site leaves the database and its login on the machine
    // for ever, because nothing else knows the site was ever given one. Names
    // are recorded, never the password.
    stored.application = {
      id: params.application, label: app.label, installed_at: new Date().toISOString(),
      database: database ? { name: database.name, username: database.username } : null,
    };
    writeState(SITE_STATE, after);
  }

  return {
    application: params.application, label: app.label, domain: name,
    document_root: root, database: database ? { name: database.name, username: database.username } : null,
    http_status: status,
    // Said every time, because this is the single most attacked path on shared
    // hosting and every panel that ships one of these ships it wide open. The
    // panel does not update it either, and pretending otherwise is how people
    // end up serving a three-year-old database client to the internet.
    warning: app.speaks ? `${app.label} is now the whole of ${name} and anybody who finds it gets a login box for your databases. Put a password on the site, and update ${app.label} yourself: this panel installs it and does not keep it current.` : null,
    verified: true,
  };
}

async function siteDelete(params) {
  const name = domain(params.domain);
  const state = readSites();
  const before = state.sites.length;
  const removed = state.sites.find(site => site.domain === name);
  state.sites = state.sites.filter(site => site.domain !== name);
  if (state.sites.length === before) throw new Error(`${name} is not managed by this panel`);
  for (const target of [siteEnabledPath(name), siteConfigPath(name)]) { try { fs.unlinkSync(target); } catch {} }
  const pools = removePhpPool(name);
  const version = (await phpVersions()).default;
  fs.rmSync(siteBase(name), { recursive: true, force: true });
  writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx();
  if (pools.length && version) await reloadPhpPool(version);
  if ((await siteList()).sites.some(site => site.domain === name)) throw new Error(`${name} still reads back after deletion`);

  // The database the panel gave this site's application goes with the site, and
  // it goes early.
  //
  // It did not go at all until today, and the leak was invisible: deleting a
  // WordPress site took the files, the pool and the system user, and left the
  // database and its login on the machine. They accumulate, they are named
  // after a hash so nobody recognises them, and installing onto the same domain
  // again then failed on the one left behind.
  //
  // Only what the record says this site was given. The name is derivable from
  // the domain, and deriving it would be guessing at somebody's data: a site
  // whose record names no database has none dropped for it.
  let database = null;
  const given = removed && removed.application && removed.application.database;
  if (given && given.name) {
    if (await mysqlDatabaseExists(given.name)) await mysqlDrop({ name: given.name });
    if (given.username && await mysqlUserExists(given.username)) await mysqlUserDrop({ username: given.username });
    if (await mysqlDatabaseExists(given.name)) throw new Error(`${name} was removed but its database ${given.name} is still on the machine`);
    database = given.name;
  }

  // The socket goes before the user, because that order is the whole of it.
  //
  // This used to remove the system user first and check the socket afterwards,
  // and `userdel` refuses while a process is still running as that user. The
  // PHP pool has been told to go but has not always gone by the time the next
  // line runs, so a delete failed intermittently with "its system user is still
  // on the machine", after the files and the configuration were already gone.
  // Half a deletion, reported as a failure, with nothing said about which half.
  if (!(await waitUntil(() => !fs.existsSync(phpSocketPath(name)))))
    throw new Error(`${name} was removed but its PHP socket is still listening`);
  let account = await removeSiteUser(name);
  // And once more after a moment, because the pool's last worker can outlive
  // its socket by a beat.
  if (!account.removed && userExists(siteUserName(name))) {
    await waitUntil(() => !userExists(siteUserName(name)), 5000);
    if (userExists(siteUserName(name))) account = await removeSiteUser(name);
  }
  if (userExists(siteUserName(name))) throw new Error(`${name} was removed but its system user is still on the machine`);

  return { domain: name, removed: true, user: account.user, pools_removed: pools.length, database_removed: database, reload, verified: true };
}

async function siteDocumentRoot(params) {
  const name = domain(params.domain);
  // The same refusal as site.create, because the same absolute path arrives
  // here and used to have its leading slash stripped in exactly the same way.
  const relative = siteRelativeRoot(params.documentRoot, '');
  const state = readSites(); const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not managed by this panel`);
  site.document_root = relative;
  const { root, gid } = prepareDocumentRoot(site);
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) fs.writeFileSync(index, `${name}\n`, { mode: 0o640 });
  fs.chownSync(index, 0, gid);
  fs.chmodSync(index, 0o640);
  writeSiteConfig(site); writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx(); const after = (await siteList()).sites.find(entry => entry.domain === name);
  // The same read-back as creation: a new document root the web server cannot
  // walk into is a 404, so it is a failure here and not an executed change.
  const unreachable = documentRootAccessFailure(root, webServiceAccount(), index);
  if (unreachable) throw new Error(`${name} now points at a document root it cannot be served from: ${unreachable}`);
  return { domain: name, document_root: after.document_root, reload, verified: true };
}

async function siteRedirect(params) {
  const name = domain(params.domain);
  const target = params.target == null || params.target === '' ? null : String(params.target).trim();
  if (target && (!/^https?:\/\/[a-z0-9][a-z0-9.-]*(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(target) || /[$\\]/.test(target))) throw new Error('The redirect must be an HTTP or HTTPS URL');
  const state = readSites(); const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not managed by this panel`);
  site.redirect = target; writeSiteConfig(site); writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx();
  return { domain: name, redirect: target, reload, verified: true };
}

// Called once per site the account owns when an account is suspended or
// unsuspended, from the admin suspend/unsuspend routes rather than through
// the customer-facing propose/approve path — an account cannot suspend
// itself. Rewrites that one site's nginx vhost to answer 503 (see renderSite)
// and reloads, or restores it to what site.redirect/document-root/etc already
// have on file, unchanged, which is why unsuspending needs no separate state
// of "what it looked like before."
async function siteSuspend(params) {
  const name = domain(params.domain);
  const suspended = !!params.suspended;
  const state = readSites(); const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not managed by this panel`);
  site.suspended = suspended; writeSiteConfig(site); writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx();
  const after = (await siteList()).sites.find(entry => entry.domain === name);
  if (!!after.suspended !== suspended) throw new Error(`${name} did not read back as ${suspended ? 'suspended' : 'restored'}`);
  return { domain: name, suspended, reload, verified: true };
}

async function siteAlias(params) {
  const name = domain(params.domain); const alias = domain(params.alias);
  const state = readSites(); const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not managed by this panel`);
  site.aliases = site.aliases || [];
  site.aliases = params.remove ? site.aliases.filter(value => value !== alias) : [...new Set([...site.aliases, alias])];
  writeSiteConfig(site); writeState(SITE_STATE, state); const reload = await validateAndReloadNginx();
  return { domain: name, aliases: site.aliases, reload, verified: true };
}

function certificateInfo(name) {
  const certPath = `/etc/letsencrypt/live/${domain(name)}/cert.pem`;
  if (!fs.existsSync(certPath)) return null;
  const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
  return { domain: domain(name), issuer: cert.issuer, valid_from: new Date(cert.validFrom).toISOString(), expires_at: new Date(cert.validTo).toISOString(), serial: cert.serialNumber, fingerprint_sha256: cert.fingerprint256, path: certPath };
}

function servedCertificate(name) {
  const hostname = domain(name);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port: 443, servername: hostname, rejectUnauthorized: false, timeout: 12000 }, () => {
      try {
        const peer = socket.getPeerCertificate(true);
        if (!peer || !peer.raw) throw new Error(`nginx did not present a certificate for ${hostname}`);
        const cert = new crypto.X509Certificate(peer.raw);
        resolve({ domain: hostname, issuer: cert.issuer, valid_from: new Date(cert.validFrom).toISOString(), expires_at: new Date(cert.validTo).toISOString(), serial: cert.serialNumber, fingerprint_sha256: cert.fingerprint256 });
      } catch (error) { reject(error); }
      finally { socket.end(); }
    });
    socket.on('timeout', () => socket.destroy(new Error(`nginx did not answer TLS for ${hostname}`)));
    socket.on('error', reject);
  });
}

async function verifyServedCertificate(name) {
  const stored = certificateInfo(name);
  if (!stored) throw new Error(`${domain(name)} has no certificate on disk`);
  const served = await servedCertificate(name);
  if (stored.fingerprint_sha256 !== served.fingerprint_sha256) {
    throw new Error(`nginx is serving a different certificate for ${domain(name)} than certbot wrote`);
  }
  return served;
}

function httpSiteRequest(name) {
  const hostname = domain(name);
  return new Promise(resolve => {
    const request = http.request({ host: '127.0.0.1', port: 80, path: '/.arca-https-check', method: 'GET', headers: { Host: hostname }, timeout: 10000 }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location || null }));
    });
    request.on('timeout', () => request.destroy(new Error(`nginx did not answer HTTP for ${hostname}`)));
    request.on('error', error => resolve({ status: null, error: firstLine(error.message) }));
    request.end();
  });
}

async function certificateList() {
  const sites = (await siteList()).sites;
  return { certificates: sites.map(site => certificateInfo(site.domain)).filter(Boolean), sites: sites.map(site => ({ domain: site.domain, certificate: certificateInfo(site.domain), force_https: site.force_https === true })) };
}

async function certificateIssue(params) {
  const name = domain(params.domain); const state = readSites(); const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`Add ${name} as a website before issuing its certificate`);
  const certbot = command(['/usr/bin/certbot', '/usr/local/bin/certbot', 'certbot']);
  const args = ['certonly', '--webroot', '--webroot-path', documentRoot(site), '--domain', name, '--non-interactive', '--agree-tos', '--keep-until-expiring'];
  if (params.staging === true) args.push('--staging');
  if (params.email) args.push('--email', email(params.email)); else args.push('--register-unsafely-without-email');
  await must(certbot, args, { timeoutMs: 600000 }, `certbot could not issue ${name}`);
  const certificate = certificateInfo(name);
  if (!certificate) throw new Error(`certbot returned but ${name} has no certificate on disk`);
  site.force_https = params.forceHttps === true; writeSiteConfig(site); writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx();
  const served = await verifyServedCertificate(name);
  if (site.force_https) {
    const redirect = await httpSiteRequest(name);
    if (![301, 302, 307, 308].includes(redirect.status) || !String(redirect.location || '').startsWith(`https://${name}`)) {
      throw new Error(`${name} has a certificate but HTTP did not redirect to HTTPS`);
    }
  }
  return { domain: name, certificate, served, force_https: site.force_https, staging: params.staging === true, reload, verified: true };
}

async function certificateRenew(params) {
  const name = domain(params.domain); if (!certificateInfo(name)) throw new Error(`${name} has no certificate to renew`);
  // `certbot renew` deliberately sleeps for a random part of eight minutes so
  // unattended fleet timers do not all hit the CA together. This is an owner
  // waiting on one recorded action, not a fleet timer, and the live box sat for
  // 230 seconds before doing any work until this flag was added.
  const args = ['renew', '--cert-name', name, '--non-interactive', '--force-renewal', '--no-random-sleep-on-renew'];
  if (params.dryRun === true) args.push('--dry-run');
  const result = await must(command(['/usr/bin/certbot', '/usr/local/bin/certbot', 'certbot']), args, { timeoutMs: 600000 }, `certbot could not renew ${name}`);
  const reload = await validateAndReloadNginx();
  const served = await verifyServedCertificate(name);
  return { domain: name, dry_run: params.dryRun === true, output: firstLine(result.stdout || result.stderr), certificate: certificateInfo(name), served, reload, verified: true };
}

async function certificateHttps(params) {
  const name = domain(params.domain);
  const state = readSites();
  const site = state.sites.find(entry => entry.domain === name);
  if (!site) throw new Error(`${name} is not managed by this panel`);
  if (!certificateInfo(name)) throw new Error(`${name} needs a certificate before HTTPS can be forced`);
  site.force_https = params.enabled === true;
  writeSiteConfig(site); writeState(SITE_STATE, state);
  const reload = await validateAndReloadNginx();
  const served = await verifyServedCertificate(name);
  const httpState = await httpSiteRequest(name);
  const redirects = [301, 302, 307, 308].includes(httpState.status) && String(httpState.location || '').startsWith(`https://${name}`);
  if (redirects !== site.force_https) {
    throw new Error(site.force_https ? `${name} still answers over HTTP instead of forcing HTTPS` : `${name} still redirects HTTP after the redirect was removed`);
  }
  return { domain: name, force_https: site.force_https, http: httpState, served, reload, verified: true };
}

// ── Postfix and Dovecot mail administration ───────────────────────
function readMail() {
  const state = readState(MAIL_STATE, { mailboxes: [], forwards: [] });
  if (!Array.isArray(state.mailboxes)) state.mailboxes = [];
  if (!Array.isArray(state.forwards)) state.forwards = [];
  return state;
}

function mailboxAddress(entry) { return `${entry.account}@${entry.domain}`; }
function mailboxHome(entry) { return path.join('/var/vmail', entry.domain, entry.account); }

function systemGroupId(name) {
  const row = fs.readFileSync('/etc/group', 'utf8').split('\n').find(line => line.startsWith(`${name}:`));
  if (!row) throw new Error(`The system group ${name} does not exist`);
  return Number(row.split(':')[2]);
}

function prepareMailboxHome(entry) {
  const home = mailboxHome(entry);
  const domainRoot = path.dirname(home);
  const maildir = path.join(home, 'Maildir');
  for (const directory of [domainRoot, home, maildir]) {
    ensureDir(directory, 0o700);
    fs.chownSync(directory, 5000, 5000);
    fs.chmodSync(directory, 0o700);
  }
  return { home, maildir };
}

async function ensureVmailUser() {
  if (!fs.readFileSync('/etc/group', 'utf8').split('\n').some(line => line.startsWith('vmail:'))) {
    await must(command(['/usr/sbin/groupadd', '/usr/bin/groupadd']), ['--gid', '5000', 'vmail'], {}, 'The vmail group could not be created');
  }
  if (!fs.readFileSync('/etc/passwd', 'utf8').split('\n').some(line => line.startsWith('vmail:'))) {
    await must(command(['/usr/sbin/useradd', '/usr/bin/useradd']), ['--uid', '5000', '--gid', 'vmail', '--home-dir', '/var/vmail', '--create-home', '--shell', '/usr/sbin/nologin', 'vmail'], {}, 'The vmail user could not be created');
  }
  ensureDir('/var/vmail', 0o770); fs.chownSync('/var/vmail', 5000, 5000);
}

function writeDovecotUsers(state) {
  ensureDir(path.dirname(DOVECOT_USERS));
  for (const entry of state.mailboxes) prepareMailboxHome(entry);
  const lines = state.mailboxes.map(entry => `${mailboxAddress(entry)}:${entry.password_hash}:5000:5000::${mailboxHome(entry)}::userdb_quota_rule=*:storage=${entry.quotaMb || 0}M`);
  fs.writeFileSync(DOVECOT_USERS, `${lines.join('\n')}${lines.length ? '\n' : ''}`, { mode: 0o600 });
  fs.chownSync(DOVECOT_USERS, 0, systemGroupId('dovecot'));
  fs.chmodSync(DOVECOT_USERS, 0o640);
}

async function writeMailMaps(state) {
  const domains = [...new Set(state.mailboxes.map(entry => entry.domain))].sort();
  const mailboxLines = state.mailboxes.map(entry => `${mailboxAddress(entry)}\t${entry.domain}/${entry.account}/Maildir/`);
  const aliasLines = [];
  for (const entry of state.mailboxes) {
    const address = mailboxAddress(entry);
    const forwards = state.forwards.filter(item => item.address === address).map(item => item.forward);
    if (forwards.length) aliasLines.push(`${address}\t${[address, ...forwards].join(', ')}`);
  }
  for (const catchall of state.catchalls || []) aliasLines.push(`@${catchall.domain}\t${catchall.forward}`);
  fs.writeFileSync(DOMAIN_MAP, `${domains.map(name => `${name}\tOK`).join('\n')}${domains.length ? '\n' : ''}`, { mode: 0o640 });
  fs.writeFileSync(MAILBOX_MAP, `${mailboxLines.join('\n')}${mailboxLines.length ? '\n' : ''}`, { mode: 0o640 });
  fs.writeFileSync(ALIAS_MAP, `${aliasLines.join('\n')}${aliasLines.length ? '\n' : ''}`, { mode: 0o640 });
  const postmap = command(['/usr/sbin/postmap', '/usr/bin/postmap', 'postmap']);
  const postfixGid = systemGroupId('postfix');
  for (const map of [DOMAIN_MAP, MAILBOX_MAP, ALIAS_MAP]) {
    await must(postmap, [map], { timeoutMs: 30000 }, `Postfix could not compile ${map}`);
    for (const target of [map, `${map}.db`]) {
      fs.chownSync(target, 0, postfixGid);
      fs.chmodSync(target, 0o640);
    }
  }
  writeDovecotUsers(state);
}

async function mailConfigure() {
  await ensureVmailUser();
  ensureDir('/etc/postfix'); ensureDir('/etc/dovecot/conf.d');
  const postconf = command(['/usr/sbin/postconf', '/usr/bin/postconf', 'postconf']);
  const settings = [
    ['virtual_mailbox_domains', `hash:${DOMAIN_MAP}`], ['virtual_mailbox_maps', `hash:${MAILBOX_MAP}`],
    ['virtual_alias_maps', `hash:${ALIAS_MAP}`], ['virtual_transport', 'lmtp:unix:private/dovecot-lmtp'],
    ['virtual_uid_maps', 'static:5000'], ['virtual_gid_maps', 'static:5000'], ['virtual_mailbox_base', '/var/vmail'],
    ['mynetworks', '127.0.0.0/8 [::1]/128'],
    // Live-tested on the real box, not assumed: with a separate
    // smtpd_recipient_restrictions carrying the suspended check, real RCPT TO
    // traffic for a suspended domain was still accepted (250), even though
    // reject_unauth_destination in smtpd_relay_restrictions correctly rejected
    // an unrelated domain in the same test. relay_restrictions is what this
    // Postfix install actually enforces per RCPT, so the check goes there,
    // first in the list, ahead of permit_mynetworks — order matters, since a
    // REJECT anywhere in the list is absolute regardless of what comes after.
    ['smtpd_relay_restrictions', `check_recipient_access hash:${SUSPENDED_MAP},permit_mynetworks,reject_unauth_destination`],
  ];
  for (const [key, value] of settings) await must(postconf, ['-e', `${key} = ${value}`], {}, `Postfix refused ${key}`);
  // The map must exist and be compiled before postfix check/reload references
  // it, same as the virtual maps below — an empty file is a valid, empty map.
  const postmap = command(['/usr/sbin/postmap', '/usr/bin/postmap', 'postmap']);
  if (!fs.existsSync(SUSPENDED_MAP)) fs.writeFileSync(SUSPENDED_MAP, '', { mode: 0o640 });
  await must(postmap, [SUSPENDED_MAP], { timeoutMs: 30000 }, 'Postfix could not compile the suspended-accounts map');
  // Live-found bug, not assumed: root:root 0640 on this file means postfix's
  // own smtpd cannot open it, check_recipient_access fails to connect to the
  // table, and Postfix's default behavior on that failure is to log a warning
  // and continue past the check rather than fail closed — so the map existing
  // and compiling correctly proved nothing, mail still went through silently.
  // Same class of bug as the OpenDKIM permission defect in GA_READINESS.md.
  for (const target of [SUSPENDED_MAP, `${SUSPENDED_MAP}.db`]) {
    fs.chownSync(target, 0, systemGroupId('postfix'));
    fs.chmodSync(target, 0o640);
  }
  // The quota plugin is loaded here, and this line is the whole reason a mailbox
  // size means anything.
  //
  // `writeDovecotUsers` has always written `userdb_quota_rule=*:storage=<n>M`
  // against every mailbox, which is exactly right and was completely inert:
  // without the plugin loaded, Dovecot reads the rule, does nothing with it, and
  // delivers over the limit for ever. The panel showed a size, the operation
  // reported success, the record said verified, and nothing enforced it. Found
  // by running `mail.mailbox.quota` on a live box and asking Dovecot what it
  // thought the quota was, which is the only way this class of defect is ever
  // found: it looks identical to a limit that works.
  //
  // Loaded globally so IMAP reports the quota to the mail program, and named
  // again for LMTP so delivery is what refuses, since a limit nothing enforces
  // at delivery time is the same bug wearing a different hat.
  const dovecot = `# Managed by jotpanel-ops. Edit through the panel.\nprotocols = imap lmtp\nmail_location = maildir:/var/vmail/%d/%n/Maildir\nfirst_valid_uid = 5000\nlast_valid_uid = 5000\nmail_plugins = $mail_plugins quota\npassdb {\n  driver = passwd-file\n  args = scheme=CRYPT username_format=%u ${DOVECOT_USERS}\n}\nuserdb {\n  driver = passwd-file\n  args = username_format=%u ${DOVECOT_USERS}\n}\nservice lmtp {\n  unix_listener /var/spool/postfix/private/dovecot-lmtp {\n    mode = 0600\n    user = postfix\n    group = postfix\n  }\n}\nprotocol lmtp {\n  mail_plugins = $mail_plugins sieve quota\n}\nprotocol imap {\n  mail_plugins = $mail_plugins imap_quota\n}\nplugin {\n  sieve = file:~/sieve;active=~/.dovecot.sieve\n  quota = maildir:User quota\n  quota_grace = 0%%\n}\n`;
  fs.writeFileSync(DOVECOT_CONFIG, dovecot, { mode: 0o644 });
  const state = readMail(); await writeMailMaps(state);
  await must(command(['/usr/bin/doveconf', '/usr/sbin/doveconf', 'doveconf']), ['-n'], {}, 'Dovecot rejected the panel configuration');
  await must(postconf, ['check'], {}, 'Postfix rejected the panel configuration');
  await reloadService('dovecot.service'); await reloadService('postfix.service');
  return { postfix: await serviceState('postfix.service'), dovecot: await serviceState('dovecot.service'), virtual_table: MAILBOX_MAP, verified: true };
}

// Adds or removes one domain from the suspended-recipients map `mailConfigure`
// wires into smtpd_recipient_restrictions. Called once per mail-owning domain
// from the same admin suspend/unsuspend routes that call site.suspend for
// that account's sites — the two are separate maps because HTTP and mail are
// separate services, but both read the same account-level decision.
async function mailDomainSuspend(params) {
  const name = domain(params.domain);
  const suspended = !!params.suspended;
  if (!fs.existsSync(path.dirname(SUSPENDED_MAP))) throw new Error('Postfix is not installed on this server');
  // access(5)'s domain-level lookup key is the bare domain, not "@domain" —
  // "@domain" is alias/rewrite-map syntax (virtual_alias_maps and similar),
  // a different feature. Live-tested and got this wrong on the first pass:
  // `postmap -q` against the exact string written back a match, which proved
  // nothing about whether check_recipient_access's own address-matching
  // algorithm would ever construct that key — it constructs the bare domain.
  const lines = fs.existsSync(SUSPENDED_MAP)
    ? fs.readFileSync(SUSPENDED_MAP, 'utf8').split('\n').filter(Boolean)
      .filter(line => !line.startsWith(`${name}\t`) && !line.startsWith(`@${name}\t`))
    : [];
  if (suspended) lines.push(`${name}\tREJECT This account has been suspended by the hosting provider.`);
  fs.writeFileSync(SUSPENDED_MAP, `${lines.join('\n')}${lines.length ? '\n' : ''}`, { mode: 0o640 });
  await must(command(['/usr/sbin/postmap', '/usr/bin/postmap', 'postmap']), [SUSPENDED_MAP], { timeoutMs: 30000 }, 'Postfix could not compile the suspended-accounts map');
  // Same permission fix as mailConfigure — postfix's own smtpd has to be able
  // to open this table or the check silently passes through instead of
  // rejecting, and writeFileSync does not change ownership on a file that
  // already exists, only on one it creates, so this cannot be assumed done
  // once and skipped here.
  for (const target of [SUSPENDED_MAP, `${SUSPENDED_MAP}.db`]) {
    fs.chownSync(target, 0, systemGroupId('postfix'));
    fs.chmodSync(target, 0o640);
  }
  await reloadService('postfix.service');
  const after = fs.readFileSync(SUSPENDED_MAP, 'utf8');
  const nowSuspended = after.includes(`${name}\t`);
  if (nowSuspended !== suspended) throw new Error(`${name} did not read back as ${suspended ? 'suspended' : 'restored'} in the mail map`);
  return { domain: name, suspended, verified: true };
}

async function mailList() {
  const state = readMail();
  return {
    domains: [...new Set(state.mailboxes.map(entry => entry.domain))].sort().map(name => ({
      domain: name,
      mailboxes: state.mailboxes.filter(entry => entry.domain === name).length,
      antispam: !(Array.isArray(state.antispamOff) ? state.antispamOff : []).includes(name),
    })),
    mailboxes: state.mailboxes.map(entry => ({ domain: entry.domain, account: entry.account, address: mailboxAddress(entry), quota_mb: entry.quotaMb || null, size_bytes: directorySize(mailboxHome(entry)), forwards: state.forwards.filter(item => item.address === mailboxAddress(entry)).map(item => item.forward), autoreply: !!entry.autoreply })),
    forwards: state.forwards,
    catchalls: state.catchalls || [],
    source: 'postfix-dovecot-virtual',
  };
}

function directorySize(root) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) total += directorySize(full); else if (entry.isFile()) total += fs.statSync(full).size;
    }
  } catch {}
  return total;
}

async function passwordHash(password) {
  // On standard input, twice, rather than in an argument. `doveadm pw -p` put
  // every mailbox password this panel ever created into the process list, where
  // any local user could read it with ps for as long as the call took. The
  // password is already refused if it contains a line break, which is what
  // makes feeding it as two lines safe.
  const clean = mailboxPassword(password);
  const result = await must(command(['/usr/bin/doveadm', '/usr/sbin/doveadm', 'doveadm']), ['pw', '-s', 'SHA512-CRYPT'], { input: `${clean}\n${clean}\n` }, 'Dovecot could not hash the mailbox password');
  const hash = result.stdout.trim(); if (!hash.startsWith('{SHA512-CRYPT}')) throw new Error('Dovecot returned an unexpected password hash');
  return hash;
}

async function mailMailboxCreate(params) {
  const entry = { domain: domain(params.domain), account: localPart(params.account), quotaMb: params.quotaMb ? Number(params.quotaMb) : 0, password_hash: await passwordHash(params.password), autoreply: false };
  if (!Number.isInteger(entry.quotaMb) || entry.quotaMb < 0) throw new Error('Mailbox size must be a whole number');
  const state = readMail(); const address = mailboxAddress(entry);
  if (state.mailboxes.some(item => mailboxAddress(item) === address)) throw new Error(`${address} already exists`);
  state.mailboxes.push(entry);
  prepareMailboxHome(entry);
  writeState(MAIL_STATE, state); await writeMailMaps(state); await reloadService('postfix.service');
  const after = await mailList(); if (!after.mailboxes.some(item => item.address === address)) throw new Error(`${address} did not read back after creation`);
  return { address, mailbox: after.mailboxes.find(item => item.address === address), verified: true };
}

async function mailMailboxDelete(params) {
  const address = `${localPart(params.account)}@${domain(params.domain)}`; const state = readMail();
  const entry = state.mailboxes.find(item => mailboxAddress(item) === address); if (!entry) throw new Error(`${address} does not exist`);
  state.mailboxes = state.mailboxes.filter(item => mailboxAddress(item) !== address); state.forwards = state.forwards.filter(item => item.address !== address);
  fs.rmSync(mailboxHome(entry), { recursive: true, force: true }); writeState(MAIL_STATE, state); await writeMailMaps(state); await reloadService('postfix.service');
  if ((await mailList()).mailboxes.some(item => item.address === address)) throw new Error(`${address} still reads back after deletion`);
  return { address, deleted: true, verified: true };
}

async function mailMailboxPassword(params) {
  const address = `${localPart(params.account)}@${domain(params.domain)}`; const state = readMail(); const entry = state.mailboxes.find(item => mailboxAddress(item) === address);
  if (!entry) throw new Error(`${address} does not exist`); entry.password_hash = await passwordHash(params.password); writeState(MAIL_STATE, state); writeDovecotUsers(state);
  return { address, changed: true, verified: true };
}

async function mailMailboxQuota(params) {
  const address = `${localPart(params.account)}@${domain(params.domain)}`; const state = readMail(); const entry = state.mailboxes.find(item => mailboxAddress(item) === address);
  if (!entry) throw new Error(`${address} does not exist`); const quota = params.quotaMb ? Number(params.quotaMb) : 0;
  if (!Number.isInteger(quota) || quota < 0) throw new Error('Mailbox size must be a whole number'); entry.quotaMb = quota; writeState(MAIL_STATE, state); writeDovecotUsers(state);
  return { address, quota_mb: quota || null, verified: true };
}

async function mailForward(params) {
  const address = `${localPart(params.account)}@${domain(params.domain)}`; const forward = email(params.forward); const state = readMail();
  if (!state.mailboxes.some(item => mailboxAddress(item) === address)) throw new Error(`${address} does not exist`);
  state.forwards = state.forwards.filter(item => !(item.address === address && item.forward === forward));
  if (!params.remove) state.forwards.push({ address, forward }); writeState(MAIL_STATE, state); await writeMailMaps(state); await reloadService('postfix.service');
  const exists = (await mailList()).forwards.some(item => item.address === address && item.forward === forward);
  if (exists === !!params.remove) throw new Error('The forwarder did not read back in the requested state');
  return { address, forward, removed: !!params.remove, verified: true };
}

async function mailAutoreply(params) {
  const address = `${localPart(params.account)}@${domain(params.domain)}`; const state = readMail(); const entry = state.mailboxes.find(item => mailboxAddress(item) === address);
  if (!entry) throw new Error(`${address} does not exist`); const sieve = path.join(mailboxHome(entry), '.dovecot.sieve');
  const compiled = path.join(mailboxHome(entry), '.dovecot.svbin');
  if (params.clear) {
    for (const target of [sieve, compiled]) { try { fs.unlinkSync(target); } catch {} } entry.autoreply = false;
  } else {
    const message = String(params.message || '').trim().replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (!message || message.length > 4000) throw new Error('The automatic reply must be 1–4000 characters');
    fs.writeFileSync(sieve, `require ["vacation"];\nvacation :days 1 :subject "Automatic reply" "${message}";\n`, { mode: 0o600 });
    fs.chownSync(sieve, 5000, 5000); const sievec = command(['/usr/bin/sievec', '/usr/lib/dovecot/sievec', 'sievec']);
    await must(sievec, [sieve], {}, 'Dovecot could not compile the automatic reply');
    if (!fs.existsSync(compiled)) throw new Error('Dovecot did not leave a compiled automatic reply');
    fs.chownSync(compiled, 5000, 5000); fs.chmodSync(compiled, 0o600); entry.autoreply = true;
  }
  writeState(MAIL_STATE, state); const after = (await mailList()).mailboxes.find(item => item.address === address);
  if (!after || after.autoreply !== !params.clear) throw new Error('The automatic reply did not read back in the requested state');
  return { address, enabled: !params.clear, verified: true };
}

// ── Spam filtering ────────────────────────────────────────────────
//
// rspamd runs as a milter beside OpenDKIM rather than instead of it, so a box
// that already signs its mail keeps signing it. Postfix takes a list of
// milters and the panel adds itself to that list rather than writing it, which
// is the difference between installing a filter and quietly turning off
// somebody's signing.
//
// Per-domain on and off is a filter setting keyed on the recipient, not a
// second Postfix. A domain that is switched off gets `want_spam`, which tells
// rspamd to look at the message and act on nothing, so mail keeps flowing and
// the headers stop appearing. Nothing here builds a command out of a domain
// name: the name is validated and then written into a configuration file.
const RSPAMD_LOCAL = '/etc/rspamd/local.d';
const RSPAMD_SETTINGS = path.join(RSPAMD_LOCAL, 'settings.conf');
const RSPAMD_MILTER = 'inet:localhost:11332';

// No `settings { }` around these. rspamd includes this file from inside its own
// settings section, and rspamd's shipped config says so in a comment. Wrapping
// them produced a settings block nested in a settings block, which parses,
// passes configtest, reloads cleanly and does nothing at all. The switch read
// as working for as long as nobody sent a message through it.
function renderRspamdSettings(offDomains) {
  const rows = offDomains.map((name, index) => `arca_off_${index} {\n  priority = high;\n  rcpt = "@${name}";\n  want_spam = yes;\n}`);
  return `# Written by JotPanel. Domains listed here are not filtered.\n${rows.join('\n')}\n`;
}

// A filter that decides a message is spam and then says nothing is not a
// filter. Everything under the reject threshold is delivered, so it has to
// arrive carrying the verdict, which is what a mail client's own rules and a
// Junk folder both read.
const RSPAMD_HEADERS = 'use = ["x-spamd-bar", "x-spam-level", "x-spam-status", "authentication-results"];\nauthenticated_headers = ["authentication-results"];\n';

// Redis is installed with the filter and has to be pointed at, or rspamd logs
// "call to redis failed" on every message and quietly runs with no statistics,
// no greylist and no rate limits. It is on this machine and listening on
// loopback, which is the only place it should ever be reachable from.
const RSPAMD_REDIS = 'servers = "127.0.0.1:6379";\n';

async function ensureRspamdMilter() {
  const postconf = command(['/usr/sbin/postconf', '/usr/bin/postconf', 'postconf']);
  const current = await runFile(postconf, ['-h', 'smtpd_milters'], { timeoutMs: 20000 });
  const existing = String(current.stdout || '').trim();
  if (existing.includes(RSPAMD_MILTER)) return existing;
  // Appended, never replaced. Whatever else is filtering this mail was put
  // there by somebody and is not ours to remove.
  const next = existing ? `${existing}, ${RSPAMD_MILTER}` : RSPAMD_MILTER;
  await must(postconf, [`smtpd_milters=${next}`], { timeoutMs: 20000 }, 'Postfix would not take the filter');
  await must(postconf, [`non_smtpd_milters=${next}`], { timeoutMs: 20000 }, 'Postfix would not take the filter for locally submitted mail');
  await must(postconf, ['milter_protocol=6'], { timeoutMs: 20000 }, 'Postfix would not set the milter protocol');
  // A filter that is down must not stop mail. Losing the headers is a bad day;
  // bouncing everybody's mail because a daemon restarted is a different one.
  await must(postconf, ['milter_default_action=accept'], { timeoutMs: 20000 }, 'Postfix would not set the milter fallback');
  await reloadService('postfix.service');
  return next;
}

async function mailAntispam(params) {
  const name = domain(params.domain);
  const enabled = params.enabled !== false && params.enabled !== 'false';
  const state = readMail();
  const off = new Set(Array.isArray(state.antispamOff) ? state.antispamOff : []);
  if (enabled) off.delete(name); else off.add(name);
  const list = [...off].sort();

  ensureDir(RSPAMD_LOCAL, 0o755);
  // chmod after writing, every time, because the mode passed to writeFileSync is
  // masked by the daemon's umask and this daemon's is strict. These came out
  // 0600 root-only, which the running filter did not notice because it had
  // already read them, and which stopped it starting at all after a reboot: the
  // spam filter was dead on the next boot and the only sign was mail arriving
  // unfiltered. Everything rspamd reads has to be readable by rspamd.
  for (const [file, body] of [['milter_headers.conf', RSPAMD_HEADERS], ['redis.conf', RSPAMD_REDIS]]) {
    const target = path.join(RSPAMD_LOCAL, file);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== body) fs.writeFileSync(target, body, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
  }
  const staged = `${RSPAMD_SETTINGS}.staged`;
  fs.writeFileSync(staged, renderRspamdSettings(list), { mode: 0o644 });
  fs.chmodSync(staged, 0o644);
  // Checked before it is anywhere the filter will read it, the same way a zone
  // is. A configuration rspamd refuses stops it starting, and a mail server
  // with no filter running is better than a mail server that will not start.
  const previous = fs.existsSync(RSPAMD_SETTINGS) ? fs.readFileSync(RSPAMD_SETTINGS, 'utf8') : null;
  fs.renameSync(staged, RSPAMD_SETTINGS);
  fs.chmodSync(RSPAMD_SETTINGS, 0o644);
  // configtest runs as root and will happily read a file rspamd itself cannot,
  // so the mode is fixed before the check rather than trusted afterwards.
  const check = await runFile(command(['/usr/bin/rspamadm', 'rspamadm']), ['configtest'], { timeoutMs: 30000 });
  if (!check.ok) {
    if (previous == null) fs.rmSync(RSPAMD_SETTINGS, { force: true });
    else fs.writeFileSync(RSPAMD_SETTINGS, previous, { mode: 0o644 });
    throw new Error(`rspamd refused that change and it has been put back: ${firstLine(check.stderr || check.stdout)}`);
  }

  const milters = await ensureRspamdMilter();
  await reloadService('rspamd.service');

  state.antispamOff = list;
  writeState(MAIL_STATE, state);

  // Read back from the RUNNING filter, not from the file that was just written.
  // Reading the file back only proves the panel can write a file, which it
  // already did, and a correctly written rule in a place rspamd does not look
  // reads exactly the same as one that works. `configdump` is rspamd's own view
  // of the configuration it is currently running.
  const running = await serviceState('rspamd.service');
  const dump = await runFile(command(['/usr/bin/rspamadm', 'rspamadm']), ['configdump', 'settings'], { timeoutMs: 30000 });
  const live = new Set([...String(dump.stdout || '').matchAll(/rcpt = "@([^"]+)"/g)].map(match => match[1]));
  const verified = running === 'active'
    && dump.ok
    && String(milters).includes(RSPAMD_MILTER)
    && live.has(name) === !enabled;
  return {
    domain: name, enabled, filtered_domains_off: list, milters, rspamd: running,
    unfiltered_in_running_config: [...live], verified,
  };
}

async function mailCatchall(params) {
  const name = domain(params.domain); const forward = params.forward ? email(params.forward) : null; const state = readMail();
  state.catchalls = (state.catchalls || []).filter(item => item.domain !== name); if (forward) state.catchalls.push({ domain: name, forward });
  writeState(MAIL_STATE, state); await writeMailMaps(state); await reloadService('postfix.service');
  return { domain: name, forward, verified: true };
}

// postqueue -p prints a header row with no blank line after it, then one block
// per message, then a summary line. Splitting that on blank lines makes the
// header the head of the first block, so the oldest message was dropped from
// every read, and a queue holding exactly one message read as empty. Walking
// the lines and starting a message wherever a queue id appears does not care
// how the blocks are separated, or whether the header is there at all.
//
// The id pattern accepts long queue ids as well as the traditional hex ones,
// because enable_long_queue_ids is an operator setting and a panel that shows
// an empty queue on a box that has one is the same bug wearing a hat.
const QUEUE_HEAD = /^([0-9A-Za-z]{5,25})([*!]?)\s+(\d+)\s+(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2})\s+(\S+)\s*$/;

function parseMailQueue(stdout) {
  if (/Mail queue is empty/i.test(stdout)) return [];
  const messages = [];
  for (const raw of String(stdout).split('\n')) {
    const head = raw.match(QUEUE_HEAD);
    if (head) {
      messages.push({
        id: head[1],
        active: head[2] === '*',
        held: head[2] === '!',
        size_bytes: Number(head[3]),
        arrived: head[4].replace(/\s+/g, ' ').trim(),
        sender: head[5],
        recipients: [],
        reason: null,
      });
      continue;
    }
    const line = raw.trim();
    const current = messages[messages.length - 1];
    // Anything before the first queue id is the column header, and anything
    // that is neither a reason nor an address is the closing summary line.
    if (!line || !current) continue;
    if (line.startsWith('(')) { current.reason = line.replace(/^\(/, '').replace(/\)$/, ''); continue; }
    if (line.includes('@')) current.recipients.push(line);
  }
  return messages;
}

async function mailQueueList() {
  const result = await must(command(['/usr/sbin/postqueue', '/usr/bin/postqueue', 'postqueue']), ['-p'], { timeoutMs: 30000 }, 'The Postfix queue could not be read');
  const messages = parseMailQueue(result.stdout);
  return { messages, count: messages.length, source: 'postfix' };
}

async function mailQueueAction(params) {
  const verb = String(params.verb || ''); const id = String(params.id || '').trim();
  if (!['retry', 'delete'].includes(verb) || (id !== 'ALL' && !/^[0-9A-Za-z]{5,25}$/.test(id))) throw new Error('The mail queue action is invalid');
  if (verb === 'retry' && id === 'ALL') await must(command(['/usr/sbin/postqueue', '/usr/bin/postqueue', 'postqueue']), ['-f'], {}, 'The queue flush failed');
  else await must(command(['/usr/sbin/postsuper', '/usr/bin/postsuper', 'postsuper']), [verb === 'retry' ? '-r' : '-d', id], {}, 'The queue action failed');
  const after = await mailQueueList(); if (verb === 'delete' && id !== 'ALL' && after.messages.some(item => item.id === id)) throw new Error(`${id} remains in the queue`);
  return { verb, id, remaining: after.count, verified: true };
}

const SPECS = {
  'probe.service': [[], async () => ({ ready: process.getuid() === 0, uid: process.getuid(), transport: 'unix-socket', accepts: 'named-jobs-only' })],
  'probe.firewall': [[], async () => ({ available: true, ...(await firewallList()) })],
  'probe.database': [[], mysqlProbe],
  'probe.web': [[], async () => stackProbe({ stack: 'web' })],
  'probe.certificates': [[], async () => stackProbe({ stack: 'certificates' })],
  'probe.webmail': [[], async () => stackProbe({ stack: 'webmail' })],
  'probe.fail2ban': [[], async () => stackProbe({ stack: 'fail2ban' })],
  'probe.disk-usage': [[], async () => {
    // A directory nobody but root can read, and a small one.
    //
    // This probe asks one question: does `du` run with privilege here. It used
    // to ask it by walking the whole of /var, which on this box is 1.2 GB and on
    // a real one is the mail, the databases and the backups. Every capability
    // refresh therefore walked it, and under concurrent load on 2026-08-28 the
    // walk passed its thirty second timeout, the probe reported the capability
    // as not readable with panel privilege, and the whole folder usage screen
    // answered 501. A busy machine made a working feature disappear.
    //
    // The state directory proves the same thing in milliseconds: it is 0750
    // root-owned, so the panel's own user cannot read it and root can.
    const result = await must(command(['/usr/bin/du', '/bin/du', 'du']), ['-x', '-B1', '--max-depth=0', STATE_DIR], { timeoutMs: 30000 }, 'folder disk usage is not readable with panel privilege');
    return { available: new RegExp(`^\\d+\\s+${STATE_DIR}\\s*$`, 'm').test(result.stdout), root: STATE_DIR };
  }],
  'probe.mail': [[], async () => stackProbe({ stack: 'mail' })],
  'probe.dns': [[], async () => stackProbe({ stack: 'dns' })],
  'probe.packages': [[], packageStatusPrivileged],
  'service.control': [['unit', 'verb'], serviceControl],
  'system.reboot': [[], async () => { await must('/usr/bin/systemctl', ['reboot'], { timeoutMs: 15000 }, 'systemd refused the reboot'); return { requested: true }; }],
  'process.kill': [['pid', 'signal'], processKill],
  'firewall.list': [[], firewallList],
  'firewall.rule': [['verb', 'port', 'protocol', 'address', 'index'], firewallRule],
  'firewall.guard.arm': [['minutes'], firewallGuardArm],
  'firewall.guard.confirm': [['guardId'], firewallGuardConfirm],
  'firewall.guard.status': [[], firewallGuardStatus],
  'fail2ban.list': [[], fail2banList],
  'fail2ban.unban': [['jail', 'ip'], fail2banUnban],
  'disk.usage': [[], diskUsage],
  'site.storage': [['domains'], siteStorage],
  // runId and trigger are minted by the panel or the fixed schedule runner.
  // They are not catalogue inputs and no request can choose the fault adapter,
  // which remains an environment-only test-machine seam.
  'backup.create': [['domain', 'parts', 'databases', 'engine', 'keep', 'runId', 'trigger'], backupCreate],
  'backup.list': [['domain'], backupList],
  'backup.offsite.stage': [['domain', 'id', 'files'], backupOffsiteStage],
  'backup.contents': [['domain', 'id', 'part'], backupContents],
  'backup.restore': [['domain', 'id', 'part', 'database', 'engine', 'path', 'mode'], backupRestore],
  'backup.fetch': [['domain', 'id', 'part'], backupFetch],
  'backup.schedule.set': [['domain', 'when', 'parts', 'databases', 'engine', 'keep', 'offsite'], backupScheduleSet],
  'backup.schedule.clear': [['domain'], backupScheduleClear],
  'backup.schedule.status': [[], backupScheduleStatus],
  'backup.runs.unattended': [['known'], backupRunsUnattended],
  'dmarc.reports.read': [['domain', 'mailbox', 'limit', 'knownSenders'], dmarcReportsRead],
  'mailauth.setup': [['domain', 'policy', 'reportTo', 'selector'], mailAuthSetup],
  'panel.domain.set': [['domain', 'email', 'staging'], panelDomainSet],
  'mail.dkim.enable': [['domain', 'selector'], dkimEnableNative],
  'mail.dkim.show': [['domain'], dkimShowNative],
  'probe.dkim': [[], async () => stackProbe({ stack: 'dkim' })],
  'dns.zones': [[], dnsZones],
  'dns.zone.records': [['zone'], dnsZoneRecords],
  'dns.zone.create': [['zone', 'ip'], dnsZoneCreate],
  'dns.zone.delete': [['zone'], dnsZoneDelete],
  'dns.record.write': [['zone', 'label', 'type', 'value', 'ttl', 'preference'], dnsRecordWrite],
  'dns.record.remove': [['zone', 'label', 'type', 'value'], dnsRecordDelete],
  'backup.file.versions': [['domain', 'path'], backupFileVersions],
  'backup.file.preview': [['domain', 'id', 'part', 'path'], backupFilePreview],
  'packages.apply': [['securityOnly'], packageApplyPrivileged],
  'sshkey.list': [[], sshKeyList],
  'sshkey.add': [['key'], sshKeyAdd],
  'sshkey.remove': [['line'], sshKeyRemove],
  'stack.probe': [['stack'], stackProbe],
  'oneshot.result': [['instance'], oneshotResult],
  'php.versions': [[], phpVersions],
  'runtime.list': [[], runtimeList],
  'runtime.status': [['domain'], runtimeStatus],
  'runtime.set': [['domain', 'runtime', 'entry'], runtimeSet],
  'runtime.clear': [['domain'], runtimeClear],
  'runtime.restart': [['domain'], runtimeRestart],
  'runtime.install': [['runtime'], runtimeInstall],
  'migrate.preview': [['plan'], migratePreview],
  // `archivePath` is named here because the dispatcher refuses a parameter it
  // was not told to expect, which is the check that caught this: the panel put
  // the staged archive on the call and the backend dropped it, so the migration
  // built the shape of an account and filled none of it.
  'migrate.apply': [['plan', 'archivePath'], migrateApply],
  'migrate.imap.probe': [[], migrateImapProbe],
  'migrate.imap.inspect': [['host', 'port', 'security', 'username', 'password', 'allowUntrusted'], migrateImapInspect],
  'migrate.imap.pull': [['domain', 'account', 'host', 'port', 'security', 'username', 'password', 'allowUntrusted', 'replace'], migrateImapPull],
  'sftp.status': [['domain'], sftpStatus],
  'sftp.enable': [['domain', 'password'], sftpEnable],
  'sftp.disable': [['domain'], sftpDisable],
  'sftp.suspend': [['domain', 'suspended'], sftpSuspend],
  'staging.reserve': [[], stagingReserve],
  'staging.discard': [['staged'], stagingDiscard],
  'site.files.place': [['domain', 'path', 'staged'], siteFilePlace],
  'site.files.stage': [['domain', 'path'], siteFileStage],
  'site.files.archive': [['domain', 'path', 'target'], siteArchiveCreate],
  'site.files.extract': [['domain', 'path', 'target'], siteArchiveExtract],
  'site.php.set': [['domain', 'template'], sitePhpSet],
  'site.statistics.status': [[], siteStatisticsStatus],
  'site.statistics.enable': [['domain'], siteStatisticsEnable],
  'site.files.list': [['domain', 'dir'], siteFileList],
  'site.files.read': [['domain', 'path'], siteFileRead],
  'site.files.write': [['domain', 'path', 'content'], siteFileWrite],
  'site.files.folder': [['domain', 'path'], siteFolderCreate],
  'site.files.delete': [['domain', 'path'], siteFileDelete],
  'site.files.rename': [['domain', 'path', 'target'], siteFileRename],
  'application.list': [[], applicationList],
  'application.install': [['application', 'domain'], applicationInstall],
  'stack.install': [['stack'], stackInstall],
  'database.list': [[], databaseList],
  'database.tables': [['name', 'engine'], databaseTables],
  'database.create': [['name', 'engine'], databaseCreate],
  'database.drop': [['name', 'engine'], databaseDrop],
  'database.user.create': [['username', 'password', 'engine'], databaseUserCreate],
  'database.user.drop': [['username', 'engine'], databaseUserDrop],
  'database.grant': [['name', 'username', 'privileges', 'engine'], databaseGrant],
  'database.password': [['username', 'password', 'engine'], databasePasswordChange],
  'database.dump': [['name', 'engine'], databaseDump],
  'database.import': [['name', 'sql', 'engine'], databaseImport],
  'site.list': [[], siteList],
  'site.create': [['domain', 'documentRoot'], siteCreate],
  'site.delete': [['domain'], siteDelete],
  'site.document-root': [['domain', 'documentRoot'], siteDocumentRoot],
  'site.redirect': [['domain', 'target'], siteRedirect],
  'site.suspend': [['domain', 'suspended'], siteSuspend],
  'backup.schedule.suspend': [['domain', 'suspended'], backupScheduleSuspend],
  'site.alias': [['domain', 'alias', 'remove'], siteAlias],
  'site.reload': [[], async () => ({ ...(await validateAndReloadNginx()), verified: true })],
  'site.protect.list': [['domain'], siteProtectList],
  'site.protect.set': [['domain', 'path', 'user', 'password'], siteProtectSet],
  'site.protect.clear': [['domain', 'path', 'user'], siteProtectClear],
  'certificate.list': [[], certificateList],
  'certificate.issue': [['domain', 'email', 'staging', 'forceHttps'], certificateIssue],
  'certificate.renew': [['domain', 'dryRun'], certificateRenew],
  'certificate.https': [['domain', 'enabled'], certificateHttps],
  'webmail.status': [[], webmailStatus],
  'mail.configure': [[], mailConfigure],
  'mail.list': [[], mailList],
  'mail.mailbox.create': [['domain', 'account', 'password', 'quotaMb'], mailMailboxCreate],
  'mail.mailbox.delete': [['domain', 'account'], mailMailboxDelete],
  'mail.mailbox.password': [['domain', 'account', 'password'], mailMailboxPassword],
  'mail.mailbox.quota': [['domain', 'account', 'quotaMb'], mailMailboxQuota],
  'mail.forwarder': [['domain', 'account', 'forward', 'remove'], mailForward],
  'mail.autoreply': [['domain', 'account', 'message', 'clear'], mailAutoreply],
  'mail.catchall': [['domain', 'forward'], mailCatchall],
  'mail.antispam': [['domain', 'enabled'], mailAntispam],
  'mail.domain.suspend': [['domain', 'suspended'], mailDomainSuspend],
  'mail.queue.list': [[], mailQueueList],
  'mail.queue.action': [['verb', 'id'], mailQueueAction],

  // Making the machine a panel is installed into, rather than changing a
  // machine a panel is already on. Registered only on a pool host.
  //
  // Absent, not refused. A customer's guest never has these jobs in its
  // catalogue at all, so `machine.create` over that guest's socket answers
  // UNKNOWN_JOB — there is nothing to refuse and nothing reachable behind a
  // refusal. The web half is gated the same way, by never mounting the routes,
  // and both are kept because they fail differently: this survives somebody
  // mounting the routes on a guest, and that survives somebody setting the
  // environment variable on one.
  //
  // See docs/FLEET_AND_MACHINES.md for why a pool host is a separate Navigator
  // install rather than a role a customer's panel can enter.
  ...(POOL_HOST && createMachineJobs ? createMachineJobs({ runFile, command, must }) : {}),
};

async function executeNamedJob(name, params = {}) {
  const spec = SPECS[String(name || '')];
  if (!spec) throw Object.assign(new Error(`Unknown privileged job: ${name}`), { code: 'UNKNOWN_JOB' });
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Job parameters must be an object');
  const [allowed, handler] = spec; const extras = Object.keys(params).filter(key => !allowed.includes(key));
  if (extras.length) throw new Error(`Job ${name} does not accept: ${extras.join(', ')}`);
  return handler(params);
}

module.exports = {
  backupCreate, systemctlShow,
  // Exported for the tests that hold the firewall guard's rules in place.
  firewallGuardConflict, firewallLockoutRisk,
  applySiteOwnership, copyIntoSite, writeIntoSite,
  installRuntimePackages, renderSite, runtimeEntry, RUNTIMES,
  parseMailQueue, waitForFail2ban,
  applyPackageUpdates, executeNamedJob, installStackPackages, oneshotResult, phpVersions,
  runImapPull, runPrivilegedOneshot, ONESHOT_INSTANCES, SPECS, runFile,
  // Exported for the containment tests only. `sitePath` is the boundary between
  // a customer's path and a root-owned write, and it is worth being able to test
  // directly rather than only through an operation that needs a real machine.
  __testing: { sitePath, settleServiceState, SETTLING_UNIT_STATES,
    documentRoot, siteRelativeRoot, mirroredDocumentDirs, ensureMirroredDocumentDirs, documentRootAccessFailure, MIRRORED_DIR_MODE } };
