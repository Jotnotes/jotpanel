'use strict';

// The host operations backend.
//
// Where a free panel is installed underneath, Hestia does this work and this
// file stays out of the way. This backend exists for the two cases Hestia does
// not cover: a plain VPS with no panel at all, and the handful of operations no
// panel exposes over its API — a process list, a log search, the mail queue.
//
// Nothing here is a reimplementation of a control panel. Every capability is a
// thin call onto the tool that already owns the job: systemd for services, ps
// for processes, the database server's own client for databases, tar and chmod
// for files, the resolver for DNS. If the tool is not on the box the capability
// is not offered, and the panel says which tool is missing rather than showing
// a button that cannot work.

const fs = require('fs');
const os = require('os');
const { panelSetting } = require('../panelSettings');
const path = require('path');
const dns = require('dns').promises;
const { checkMailAuth } = require('./mailAuth');
const readline = require('readline');
const { createRunner, failureMessage } = require('./exec');
const { createPrivilegedClient } = require('./privilegedClient');

const IDENT = /^[a-z][a-z0-9_]{0,47}$/;                       // database and role names
const UNIT = /^[A-Za-z0-9@._:\\-]{1,128}$/;                   // systemd unit
// Deliberately narrow. Every character here is safe inside a SQL string
// literal for both MySQL and PostgreSQL, which removes escaping from the
// problem entirely rather than getting it subtly wrong.
const DB_PASSWORD = /^[A-Za-z0-9!#%*+\-=?@^_~.]{10,128}$/;
const SSH_KEY = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)\s+[A-Za-z0-9+/=]{32,}(\s+\S.*)?$/;

const LOG_CANDIDATES = [
  { id: 'web-error', role: 'Website errors', paths: ['/var/log/nginx/error.log', '/var/log/apache2/error.log', '/var/log/httpd/error_log'] },
  { id: 'web-access', role: 'Website access', paths: ['/var/log/nginx/access.log', '/var/log/apache2/access.log', '/var/log/httpd/access_log'] },
  { id: 'mail', role: 'Mail', paths: ['/var/log/mail.log', '/var/log/maillog', '/var/log/exim4/mainlog'] },
  { id: 'system', role: 'System', paths: ['/var/log/syslog', '/var/log/messages', '/var/log/system.log'] },
  { id: 'auth', role: 'Authentication', paths: ['/var/log/auth.log', '/var/log/secure'] },
  { id: 'panel', role: 'Panel', paths: ['/usr/local/hestia/log/error.log', '/usr/local/hestia/log/nginx-error.log'] },
];

// A shared combined log has no host field. Only a log explicitly tied to a
// domain can safely become that customer's statistics.
function siteAccessLogPaths(domain, env = process.env) {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(domain)) throw new Error('Invalid statistics domain');
  const configured = String(panelSetting("OPS_LOG_PATHS", undefined, env) || '').split(',')
    .map(entry => entry.trim().split(':'))
    .filter(([id, label, file]) => id === 'web-access' && label === domain && file)
    .map(([, , file]) => file);
  return configured.length ? configured : LOG_CANDIDATES.find(row => row.id === 'web-access').paths
    .map(file => {
      const current = path.join(path.dirname(file), `jotpanel-${domain}-access.log`);
      const legacy = path.join(path.dirname(file), `arca-${domain}-access.log`);
      return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
    });
}

function createHostBackend(config = {}) {
  const {
    env = process.env,
    run = createRunner(),
    // The account's own file area, resolved per request rather than fixed at
    // construction, so file operations can never reach outside the owner asking
    // for them.
    fileRootFor = null,
    now = () => new Date(),
    privilegedClient = createPrivilegedClient({ socketPath: panelSetting("OPS_SOCKET", undefined, env) }),
    logCandidates = LOG_CANDIDATES,
  } = config;

  const dbPrefix = sanitizePrefix(panelSetting("OPS_DB_PREFIX", undefined, env) || 'jotpanel');
  const consoleEnabled = panelSetting("OPS_CONSOLE", undefined, env) === '1';
  const consoleCwd = panelSetting("OPS_CONSOLE_CWD", undefined, env) || process.cwd();
  const maxLogBytes = Math.max(64 * 1024, Number(panelSetting("OPS_LOG_MAX_BYTES", undefined, env)) || 10 * 1024 * 1024);

  let probed = null;

  // ── Privilege ────────────────────────────────────────────────────
  // The web application is never privileged. Its only root boundary is the
  // Unix-socket operations service, which accepts fixed named jobs rather than
  // a command or argv array.
  async function privileged() {
    return privilegedClient.probe();
  }

  async function probe(force = false) {
    if (probed && !force) return probed;
    const priv = await privileged();
    const [systemctl, journalctl, ps, apt, ufw, postqueue, mysql, psql, tar, chmod, diskUsage] = await Promise.all([
      present('systemctl', ['--version']),
      readableJournal(),
      present('ps', ['-Ao', 'pid=']),
      permissionProbe('probe.packages'),
      permissionProbe('probe.firewall'),
      permissionProbe('mail.queue.list'),
      probeMysql(),
      probePsql(),
      present('tar', ['--version']),
      present('chmod', ['--help']).then(r => r || fs.existsSync('/bin/chmod')),
      permissionProbe('probe.disk-usage'),
    ]);
    // BIND, asked the way rule 3 requires: is it answering and does its control
    // channel respond, rather than is the program on disk.
    const named = await permissionProbe('probe.dns').catch(() => ({ ok: false, reason: 'not checked' }));
    const signer = await permissionProbe('probe.dkim').catch(() => ({ ok: false, reason: 'not checked' }));
    probed = {
      platform: process.platform,
      privileged: priv,
      systemctl, journalctl, ps, apt, ufw, postqueue, mysql, psql, tar, named, signer, diskUsage,
      chmod: chmod || process.platform !== 'win32',
      logs: discoverLogs(),
      checkedAt: now().toISOString(),
    };
    return probed;
  }

  async function present(file, args) {
    const result = await run(file, args, { timeoutMs: 6000 });
    return !result.missing;
  }

  // `journalctl --version` answers for anybody, and reading the journal does
  // not: that needs the systemd-journal group. Finding the program and drawing
  // the tool without checking is the firewall defect over again, and it was
  // watched happening on a fresh box where the Logs section reported itself
  // available and then had nothing it could read.
  async function readableJournal() {
    const result = await run('journalctl', ['-n', '1', '--no-pager', '-q'], { timeoutMs: 8000 });
    if (result.missing) return { ok: false, reason: 'journalctl is not present on this host' };
    if (!result.ok) return { ok: false, reason: `the journal is not readable with panel privilege: ${String(result.stderr || result.error || '').split('\n')[0].slice(0, 160) || 'journalctl refused'}` };
    return { ok: true };
  }

  async function permissionProbe(job) {
    try { await privilegedClient.run(job, {}); return { ok: true }; }
    catch (error) { return { ok: false, reason: error.message }; }
  }

  async function probeMysql() {
    const client = panelSetting("OPS_MYSQL_BIN", undefined, env) || 'mysql';
    const result = await run(client, [...mysqlAuthArgs(), '-N', '-B', '-e', 'SELECT 1'], { timeoutMs: 8000 });
    if (result.missing) return { ok: false, reason: `${client} is not installed on this server` };
    if (!result.ok) return { ok: false, reason: failureMessage(result, 'the MySQL client could not sign in') };
    return { ok: true, client, engine: 'mysql' };
  }

  async function probePsql() {
    const client = panelSetting("OPS_PSQL_BIN", undefined, env) || 'psql';
    const result = await run(client, [...psqlAuthArgs(), '--dbname', pgMaintenanceDb(), '-X', '-q', '-t', '-A', '-c', 'SELECT 1'], { timeoutMs: 8000 });
    if (result.missing) return { ok: false, reason: `${client} is not installed on this server` };
    if (!result.ok) return { ok: false, reason: failureMessage(result, 'the PostgreSQL client could not sign in') };
    return { ok: true, client, engine: 'postgres' };
  }

  function mysqlAuthArgs() {
    const args = [];
    if (panelSetting("OPS_MYSQL_HOST", undefined, env)) args.push(`--host=${panelSetting("OPS_MYSQL_HOST", undefined, env)}`);
    if (panelSetting("OPS_MYSQL_PORT", undefined, env)) args.push(`--port=${panelSetting("OPS_MYSQL_PORT", undefined, env)}`);
    if (panelSetting("OPS_MYSQL_USER", undefined, env)) args.push(`--user=${panelSetting("OPS_MYSQL_USER", undefined, env)}`);
    if (panelSetting("OPS_MYSQL_PASSWORD", undefined, env)) args.push(`--password=${panelSetting("OPS_MYSQL_PASSWORD", undefined, env)}`);
    return args;
  }

  function psqlAuthArgs() {
    const args = [];
    if (panelSetting("OPS_PG_HOST", undefined, env)) args.push(`--host=${panelSetting("OPS_PG_HOST", undefined, env)}`);
    if (panelSetting("OPS_PG_PORT", undefined, env)) args.push(`--port=${panelSetting("OPS_PG_PORT", undefined, env)}`);
    if (panelSetting("OPS_PG_USER", undefined, env)) args.push(`--username=${panelSetting("OPS_PG_USER", undefined, env)}`);
    return args;
  }

  // CREATE DATABASE cannot run inside the database being created, so every
  // administrative statement goes through the maintenance database. Postgres
  // otherwise tries to connect to one named after the signed-in user, which on
  // most servers does not exist.
  function pgMaintenanceDb() {
    return panelSetting("OPS_PG_DATABASE", undefined, env) || 'postgres';
  }

  function discoverLogs() {
    const found = [];
    for (const candidate of logCandidates) {
      for (const file of candidate.paths) {
        if (readable(file)) { found.push({ id: candidate.id, role: candidate.role, path: file }); break; }
      }
    }
    // Extra paths an installer or an operator names explicitly, as
    // id:Label:/path entries separated by commas.
    for (const entry of String(panelSetting("OPS_LOG_PATHS", undefined, env) || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const [id, role, file] = entry.split(':');
      if (id && file && readable(file)) found.push({ id: id.trim(), role: (role || id).trim(), path: file.trim() });
    }
    return found;
  }

  function readable(file) {
    try { fs.accessSync(file, fs.constants.R_OK); return fs.statSync(file).isFile(); } catch { return false; }
  }

  // Deliberately re-discovered on every call rather than read from the boot
  // probe. Logs rotate, and a panel that offers yesterday's filename and then
  // fails on it is worse than one that shows a shorter, true list.
  function logSource(id) {
    const source = discoverLogs().find(entry => entry.id === id);
    if (!source) throw new Error(`No readable log is registered under "${id}" on this server right now. It may have been rotated away since the list was drawn.`);
    if (!readable(source.path)) throw new Error(`${source.path} is no longer readable, which usually means it has just been rotated.`);
    return source;
  }

  // ── Services ─────────────────────────────────────────────────────
  async function serviceList() {
    const result = await run('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--no-pager', '--plain']);
    if (!result.ok) throw new Error(failureMessage(result, 'systemd would not list its services'));
    const services = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split(/\s+/);
      const [unit, load, active, sub, ...rest] = parts;
      return { unit, load, active, sub, description: rest.join(' ') };
    }).filter(s => s.unit && s.unit.endsWith('.service'));
    return { services, count: services.length };
  }

  async function serviceStatus({ unit }) {
    const name = assertUnit(unit);
    const props = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'ActiveEnterTimestamp', 'MemoryCurrent', 'MainPID', 'NRestarts', 'Result'];
    const result = await run('systemctl', ['show', name, `--property=${props.join(',')}`, '--no-pager']);
    if (!result.ok) throw new Error(failureMessage(result, `systemd would not report on ${name}`));
    const values = Object.fromEntries(result.stdout.split('\n').filter(Boolean).map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (!values.Id && values.LoadState === 'not-found') throw new Error(`There is no unit called ${name} on this server`);
    const since = values.ActiveEnterTimestamp && values.ActiveEnterTimestamp !== 'n/a' ? new Date(values.ActiveEnterTimestamp) : null;
    return {
      unit: values.Id || name,
      description: values.Description || '',
      load: values.LoadState,
      active: values.ActiveState,
      sub: values.SubState,
      enabled: values.UnitFileState || 'unknown',
      since: since && !Number.isNaN(since.getTime()) ? since.toISOString() : null,
      uptime_seconds: since && !Number.isNaN(since.getTime()) ? Math.max(0, Math.round((now() - since) / 1000)) : null,
      memory_bytes: /^\d+$/.test(values.MemoryCurrent || '') ? Number(values.MemoryCurrent) : null,
      main_pid: /^\d+$/.test(values.MainPID || '') ? Number(values.MainPID) : null,
      restarts: /^\d+$/.test(values.NRestarts || '') ? Number(values.NRestarts) : null,
      result: values.Result || null,
    };
  }

  async function serviceControl({ unit, verb }) {
    const name = assertUnit(unit);
    if (!['start', 'stop', 'restart', 'reload'].includes(verb)) throw new Error(`Unsupported service verb: ${verb}`);
    const priv = await privileged();
    if (!priv.ok) throw new Error(`Cannot ${verb} ${name} because ${priv.reason}`);
    let result = { ok: true, stderr: '', stdout: '' };
    try { await privilegedClient.run('service.control', { unit: name, verb }, { timeoutMs: 90000 }); }
    catch (error) { result = { ok: false, stderr: error.message, stdout: '' }; }
    // Verified against systemd itself rather than against the exit code, so a
    // unit that starts and immediately dies is reported as the failure it is.
    const after = await serviceStatus({ unit: name });
    const wanted = verb === 'stop' ? ['inactive', 'failed'] : ['active'];
    if (!result.ok && !wanted.includes(after.active)) {
      throw Object.assign(new Error(failureMessage(result, `systemctl ${verb} ${name} failed`)), { state: after });
    }
    if (!wanted.includes(after.active)) {
      throw Object.assign(new Error(`${name} is ${after.active}/${after.sub} after ${verb}, not ${wanted[0]}`), { state: after });
    }
    return { unit: name, verb, state: after, verified: true };
  }

  // ── Processes ────────────────────────────────────────────────────
  async function processList({ search = '', limit = 200, sort = 'cpu' } = {}) {
    const result = await run('ps', ['-Ao', 'pid=,ppid=,user=,%cpu=,%mem=,etime=,rss=,args=']);
    if (!result.ok) throw new Error(failureMessage(result, 'the process list could not be read'));
    const needle = String(search || '').trim().toLowerCase();
    let processes = result.stdout.split('\n').map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]), ppid: Number(match[2]), user: match[3],
        cpu: Number(match[4]), memory: Number(match[5]), elapsed: match[6],
        rss_bytes: Number(match[7]) * 1024, command: match[8],
      };
    }).filter(Boolean);
    const total = processes.length;
    if (needle) processes = processes.filter(p => p.command.toLowerCase().includes(needle) || p.user.toLowerCase().includes(needle) || String(p.pid) === needle);
    processes.sort((a, b) => (sort === 'memory' ? b.memory - a.memory : sort === 'pid' ? a.pid - b.pid : b.cpu - a.cpu));
    return {
      processes: processes.slice(0, Math.max(1, Math.min(Number(limit) || 200, 500))),
      matched: processes.length,
      total,
      own_pid: process.pid,
    };
  }

  async function processKill({ pid, signal = 'TERM' }) {
    const target = Number(pid);
    if (!Number.isInteger(target) || target < 2) throw new Error('A process id above 1 is required');
    if (target === process.pid) throw new Error('That is the panel itself. Stopping it here would take the panel down with it.');
    if (target === process.ppid) throw new Error('That is the process supervising the panel, so it cannot be stopped from inside the panel.');
    if (!['TERM', 'KILL', 'HUP', 'INT'].includes(signal)) throw new Error(`Unsupported signal: ${signal}`);
    const before = await processDetail(target);
    if (!before) throw new Error(`No process is running with id ${target}`);
    const priv = await privileged();
    if (!priv.ok) throw new Error(`The process cannot be stopped because ${priv.reason}`);
    try { await privilegedClient.run('process.kill', { pid: target, signal }, { timeoutMs: 10000 }); }
    catch (error) { if (!/no such process/i.test(error.message)) throw error; }
    // A signal is a request. Wait for the process to actually leave the table
    // before this is called done.
    const gone = await waitForExit(target, signal === 'KILL' ? 3000 : 5000);
    if (!gone) throw new Error(`${before.command.slice(0, 60)} (${target}) is still running after ${signal}. Try KILL if it is wedged.`);
    return { pid: target, signal, stopped: before, verified: true };
  }

  async function processDetail(pid) {
    const result = await run('ps', ['-o', 'pid=,user=,args=', '-p', String(pid)], { timeoutMs: 6000 });
    if (!result.ok) return null;
    const match = result.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), user: match[2], command: match[3] } : null;
  }

  async function waitForExit(pid, budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (!(await processDetail(pid))) return true;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return !(await processDetail(pid));
  }

  // ── Logs ─────────────────────────────────────────────────────────
  function logSources() {
    const sources = discoverLogs().map(entry => {
      let size = null; let modified = null;
      try { const stat = fs.statSync(entry.path); size = stat.size; modified = stat.mtime.toISOString(); } catch {}
      return { ...entry, size_bytes: size, modified_at: modified };
    });
    return { sources, max_download_bytes: maxLogBytes };
  }

  async function logTail({ id, lines = 200 }) {
    const source = logSource(id);
    const wanted = Math.max(1, Math.min(Number(lines) || 200, 2000));
    const stat = fs.statSync(source.path);
    const window = Math.min(stat.size, Math.max(64 * 1024, wanted * 512));
    const handle = fs.openSync(source.path, 'r');
    try {
      const buffer = Buffer.alloc(window);
      fs.readSync(handle, buffer, 0, window, Math.max(0, stat.size - window));
      const text = buffer.toString('utf8');
      const rows = text.split('\n');
      if (stat.size > window && rows.length) rows.shift();   // the first line is very likely cut in half
      const tail = rows.filter(line => line !== '').slice(-wanted);
      return { id: source.id, role: source.role, path: source.path, size_bytes: stat.size, truncated: stat.size > window, lines: tail, line_count: tail.length };
    } finally { fs.closeSync(handle); }
  }

  async function logSearch({ id, query, limit = 300, caseSensitive = false }) {
    const source = logSource(id);
    const needle = String(query || '').trim();
    if (!needle) throw new Error('Enter something to search for');
    if (needle.length > 200) throw new Error('Search text must be 200 characters or fewer');
    const cap = Math.max(1, Math.min(Number(limit) || 300, 1000));
    const compare = caseSensitive ? needle : needle.toLowerCase();
    const matches = [];
    let scanned = 0;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(source.path, { encoding: 'utf8' });
      const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
      reader.on('line', line => {
        scanned += 1;
        // Closing the reader does not stop lines already buffered from
        // arriving, so the cap is enforced here as well. Without it the count
        // overshoots and the panel reports more matches than it can show.
        if (matches.length >= cap) return;
        const hay = caseSensitive ? line : line.toLowerCase();
        if (hay.includes(compare)) {
          matches.push({ line_number: scanned, text: line.slice(0, 2000) });
          if (matches.length >= cap) { reader.close(); stream.destroy(); }
        }
      });
      reader.on('close', resolve);
      stream.on('error', reject);
    });
    return {
      id: source.id, role: source.role, path: source.path, query: needle,
      // The first `cap` matches, in file order. A search that stops early says
      // so rather than implying the whole file was read.
      matches, match_count: matches.length, lines_scanned: scanned,
      capped: matches.length >= cap, limit: cap,
    };
  }

  // Returns a readable stream plus the honest byte count, because a 40MB log is
  // not something to hold in memory and not something to silently truncate
  // without saying so.
  function logDownload({ id }) {
    const source = logSource(id);
    const stat = fs.statSync(source.path);
    const start = Math.max(0, stat.size - maxLogBytes);
    return {
      id: source.id, role: source.role, path: source.path,
      filename: `${source.id}-${path.basename(source.path)}`,
      size_bytes: stat.size, sending_bytes: stat.size - start, truncated: start > 0,
      stream: () => fs.createReadStream(source.path, { start }),
    };
  }

  async function journalTail({ unit, lines = 200 }) {
    const name = unit ? assertUnit(unit) : null;
    const args = ['--no-pager', '--output=short-iso', `--lines=${Math.max(1, Math.min(Number(lines) || 200, 2000))}`];
    if (name) args.push('-u', name);
    const result = await run('journalctl', args, { timeoutMs: 25000 });
    if (!result.ok) throw new Error(failureMessage(result, 'the service journal could not be read'));
    return { unit: name, lines: result.stdout.split('\n').filter(Boolean) };
  }

  async function systemMetrics() {
    const disk = await run('df', ['-P', '-B1', '/'], { timeoutMs: 10000 });
    let diskState = { total_bytes: null, used_bytes: null, free_bytes: null, used_percent: null, mount: '/' };
    if (disk.ok) {
      const line = disk.stdout.trim().split('\n').slice(-1)[0] || '';
      const parts = line.split(/\s+/);
      if (parts.length >= 6) diskState = {
        total_bytes: Number(parts[1]) || null,
        used_bytes: Number(parts[2]) || null,
        free_bytes: Number(parts[3]) || null,
        used_percent: Number(String(parts[4]).replace('%', '')) || 0,
        mount: parts[5],
      };
    }
    const total = os.totalmem(); const free = os.freemem();
    return {
      hostname: os.hostname(), platform: `${os.type()} ${os.release()}`,
      load: os.loadavg().map(value => Number(value.toFixed(2))), processors: os.cpus().length,
      memory: { total_bytes: total, used_bytes: total - free, free_bytes: free, used_percent: total ? Math.round(((total - free) / total) * 100) : 0 },
      disk: diskState, uptime_seconds: (() => { try { return Math.round(os.uptime()); } catch { return null; } })(), checked_at: now().toISOString(),
    };
  }

  const metricSamples = [];
  let previousCpu = null;

  function cpuTicks() {
    return os.cpus().reduce((sum, cpu) => {
      const ticks = Object.values(cpu.times || {}).reduce((total, value) => total + Number(value || 0), 0);
      return { total: sum.total + ticks, idle: sum.idle + Number(cpu.times?.idle || 0) };
    }, { total: 0, idle: 0 });
  }

  async function sampleSystemMetrics() {
    const currentCpu = cpuTicks();
    const metrics = await systemMetrics();
    const total = previousCpu ? currentCpu.total - previousCpu.total : currentCpu.total;
    const idle = previousCpu ? currentCpu.idle - previousCpu.idle : currentCpu.idle;
    previousCpu = currentCpu;
    const cpu = total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0;
    const sample = {
      at: metrics.checked_at,
      cpu_percent: Number(cpu.toFixed(1)),
      memory_percent: Number(metrics.memory.used_percent) || 0,
      disk_percent: Number(metrics.disk.used_percent) || 0,
      load_1: Number(metrics.load[0]) || 0,
    };
    metricSamples.push(sample);
    if (metricSamples.length > 180) metricSamples.splice(0, metricSamples.length - 180);
    return sample;
  }

  async function systemMetricsHistory() {
    await sampleSystemMetrics();
    return { samples: metricSamples.slice(), interval_seconds: 30, retained: 180 };
  }

  const metricTimer = setInterval(() => { sampleSystemMetrics().catch(() => {}); }, 30000);
  if (typeof metricTimer.unref === 'function') metricTimer.unref();

  // ── Databases ────────────────────────────────────────────────────
  // Scoped by name prefix, the same way every shared panel does it. The panel
  // can only see and act on databases it created, so a database belonging to
  // something else on the box cannot be listed, altered or dropped from here.
  function assertScoped(name, kind = 'database') {
    const value = String(name || '').trim().toLowerCase();
    if (!IDENT.test(value)) throw new Error(`A ${kind} name must be lowercase letters, digits and underscores, starting with a letter`);
    if (!value.startsWith(`${dbPrefix}_`)) throw new Error(`This panel only manages ${kind}s named ${dbPrefix}_…, so ${value} is out of its scope`);
    return value;
  }

  function scopedName(name, kind = 'database') {
    const raw = String(name || '').trim().toLowerCase();
    return assertScoped(raw.startsWith(`${dbPrefix}_`) ? raw : `${dbPrefix}_${raw}`, kind);
  }

  function engineFor(requested) {
    const wanted = requested || (probed?.mysql?.ok ? 'mysql' : probed?.psql?.ok ? 'postgres' : null);
    if (wanted === 'mysql') {
      if (!probed?.mysql?.ok) throw new Error(probed?.mysql?.reason || 'MySQL is not reachable from this server');
      return 'mysql';
    }
    if (wanted === 'postgres') {
      if (!probed?.psql?.ok) throw new Error(probed?.psql?.reason || 'PostgreSQL is not reachable from this server');
      return 'postgres';
    }
    throw new Error('No database server is reachable from this panel');
  }

  function mysqlQuery(sql, { database, raw = false } = {}) {
    const args = [...mysqlAuthArgs(), '-N', '-B'];
    if (database) args.push(`--database=${database}`);
    args.push('-e', sql);
    return run(probed.mysql.client, args, { timeoutMs: 30000 }).then(result => {
      if (!result.ok) throw new Error(failureMessage(result, 'the database server refused the statement'));
      return raw ? result.stdout : result.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
    });
  }

  // psql's :'name' substitution quotes a value as a SQL literal for us, which
  // is why a password never reaches the command line as part of a statement.
  // The statement goes in on standard input rather than through -c, because -c
  // is handed straight to the server and never sees a psql variable.
  function psqlQuery(sql, { database, vars = {}, raw = false } = {}) {
    const args = [...psqlAuthArgs(), '-X', '-q', '-t', '-A', '-F', '\t', '-v', 'ON_ERROR_STOP=1'];
    for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
    args.push('--dbname', database || pgMaintenanceDb());
    const statement = `${String(sql).trim().replace(/;$/, '')};\n`;
    return run(probed.psql.client, args, { timeoutMs: 30000, input: statement }).then(result => {
      if (!result.ok) throw new Error(failureMessage(result, 'the database server refused the statement'));
      return raw ? result.stdout : result.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
    });
  }

  async function databaseList() {
    const engines = [];
    if (probed?.mysql?.ok) {
      const rows = await mysqlQuery(
        `SELECT s.schema_name, COALESCE(SUM(t.data_length + t.index_length),0), COUNT(t.table_name)
           FROM information_schema.schemata s
           LEFT JOIN information_schema.tables t ON t.table_schema = s.schema_name
          WHERE s.schema_name LIKE '${dbPrefix}\\_%'
          GROUP BY s.schema_name ORDER BY s.schema_name`);
      engines.push({
        engine: 'mysql',
        databases: rows.map(([name, bytes, tables]) => ({ name, engine: 'mysql', size_bytes: Number(bytes) || 0, tables: Number(tables) || 0 })),
        users: (await mysqlQuery(`SELECT DISTINCT user FROM mysql.user WHERE user LIKE '${dbPrefix}\\_%' ORDER BY user`)).map(([name]) => ({ name, engine: 'mysql' })),
      });
    }
    if (probed?.psql?.ok) {
      const rows = await psqlQuery(
        `SELECT datname, pg_database_size(datname) FROM pg_database
          WHERE datname LIKE '${dbPrefix}\\_%' AND datistemplate = false ORDER BY datname`);
      engines.push({
        engine: 'postgres',
        databases: rows.map(([name, bytes]) => ({ name, engine: 'postgres', size_bytes: Number(bytes) || 0, tables: null })),
        users: (await psqlQuery(`SELECT rolname FROM pg_roles WHERE rolname LIKE '${dbPrefix}\\_%' ORDER BY rolname`)).map(([name]) => ({ name, engine: 'postgres' })),
      });
    }
    if (!engines.length) throw new Error('No database server is reachable from this panel');
    return {
      prefix: `${dbPrefix}_`,
      engines,
      databases: engines.flatMap(e => e.databases),
      users: engines.flatMap(e => e.users),
    };
  }

  async function databaseTables({ name, engine }) {
    const database = assertScoped(name);
    const which = engineFor(engine);
    if (which === 'mysql') {
      const rows = await mysqlQuery(
        `SELECT table_name, COALESCE(table_rows,0), COALESCE(data_length+index_length,0)
           FROM information_schema.tables WHERE table_schema = '${database}' ORDER BY table_name`);
      return { name: database, engine: which, tables: rows.map(([table, rowCount, bytes]) => ({ table, rows: Number(rowCount) || 0, size_bytes: Number(bytes) || 0 })) };
    }
    const rows = await psqlQuery(
      `SELECT c.relname, COALESCE(c.reltuples,0)::bigint, pg_total_relation_size(c.oid)
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY c.relname`, { database });
    return { name: database, engine: which, tables: rows.map(([table, rowCount, bytes]) => ({ table, rows: Number(rowCount) || 0, size_bytes: Number(bytes) || 0 })) };
  }

  async function databaseCreate({ name, engine }) {
    const database = scopedName(name);
    const which = engineFor(engine);
    if (which === 'mysql') await mysqlQuery(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    else await psqlQuery(`CREATE DATABASE "${database}"`);
    if (!(await databaseExists(database, which))) throw new Error(`${database} was not present after the create statement`);
    return { name: database, engine: which, verified: true };
  }

  async function databaseDrop({ name, engine }) {
    const database = assertScoped(name);
    const which = engineFor(engine);
    if (!(await databaseExists(database, which))) throw new Error(`There is no database called ${database} on this server`);
    if (which === 'mysql') await mysqlQuery(`DROP DATABASE \`${database}\``);
    else await psqlQuery(`DROP DATABASE "${database}"`);
    if (await databaseExists(database, which)) throw new Error(`${database} still exists after the drop statement`);
    return { name: database, engine: which, dropped: true, verified: true };
  }

  async function databaseExists(name, engine) {
    if (engine === 'mysql') {
      const rows = await mysqlQuery(`SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${name}'`);
      return rows.length > 0;
    }
    const rows = await psqlQuery(`SELECT datname FROM pg_database WHERE datname = '${name}'`);
    return rows.length > 0;
  }

  async function databaseUserCreate({ username, password, engine, host = 'localhost' }) {
    const user = scopedName(username, 'database user');
    assertDbPassword(password);
    const which = engineFor(engine);
    if (which === 'mysql') await mysqlQuery(`CREATE USER '${user}'@'${host}' IDENTIFIED BY '${password}'`);
    else await psqlQuery(`CREATE ROLE "${user}" LOGIN PASSWORD :'pw'`, { vars: { pw: password } });
    if (!(await databaseUserExists(user, which))) throw new Error(`${user} was not present after the create statement`);
    return { username: user, engine: which, verified: true };
  }

  async function databaseUserDrop({ username, engine, host = 'localhost' }) {
    const user = assertScoped(username, 'database user');
    const which = engineFor(engine);
    if (!(await databaseUserExists(user, which))) throw new Error(`There is no database user called ${user}`);
    if (which === 'mysql') await mysqlQuery(`DROP USER '${user}'@'${host}'`);
    else await psqlQuery(`DROP ROLE "${user}"`);
    if (await databaseUserExists(user, which)) throw new Error(`${user} still exists after the drop statement`);
    return { username: user, engine: which, dropped: true, verified: true };
  }

  async function databaseUserExists(user, engine) {
    if (engine === 'mysql') return (await mysqlQuery(`SELECT user FROM mysql.user WHERE user = '${user}'`)).length > 0;
    return (await psqlQuery(`SELECT rolname FROM pg_roles WHERE rolname = '${user}'`)).length > 0;
  }

  async function databaseGrant({ name, username, engine, host = 'localhost', privileges = 'all' }) {
    const database = assertScoped(name);
    const user = assertScoped(username, 'database user');
    const which = engineFor(engine);
    if (privileges !== 'all' && privileges !== 'read') throw new Error('Grant must be all or read');
    if (which === 'mysql') {
      const list = privileges === 'read' ? 'SELECT, SHOW VIEW' : 'ALL PRIVILEGES';
      await mysqlQuery(`GRANT ${list} ON \`${database}\`.* TO '${user}'@'${host}'`);
      await mysqlQuery('FLUSH PRIVILEGES');
      const rows = await mysqlQuery(`SHOW GRANTS FOR '${user}'@'${host}'`, { raw: true });
      if (!String(rows).includes(database)) throw new Error(`The grant on ${database} did not read back for ${user}`);
    } else {
      await psqlQuery(`GRANT ${privileges === 'read' ? 'CONNECT' : 'ALL PRIVILEGES'} ON DATABASE "${database}" TO "${user}"`);
      const rows = await psqlQuery(`SELECT has_database_privilege('${user}', '${database}', '${privileges === 'read' ? 'CONNECT' : 'CREATE'}')`);
      if (!rows.length || rows[0][0] !== 't') throw new Error(`The grant on ${database} did not read back for ${user}`);
    }
    return { name: database, username: user, engine: which, privileges, verified: true };
  }

  async function databasePassword({ username, password, engine, host = 'localhost' }) {
    const user = assertScoped(username, 'database user');
    assertDbPassword(password);
    const which = engineFor(engine);
    if (which === 'mysql') { await mysqlQuery(`ALTER USER '${user}'@'${host}' IDENTIFIED BY '${password}'`); await mysqlQuery('FLUSH PRIVILEGES'); }
    else await psqlQuery(`ALTER ROLE "${user}" PASSWORD :'pw'`, { vars: { pw: password } });
    return { username: user, engine: which, changed: true, verified: true };
  }

  async function databaseDump({ name, engine }) {
    const database = assertScoped(name);
    const which = engineFor(engine);
    const tool = which === 'mysql' ? (panelSetting("OPS_MYSQLDUMP_BIN", undefined, env) || 'mysqldump') : (panelSetting("OPS_PGDUMP_BIN", undefined, env) || 'pg_dump');
    const args = which === 'mysql'
      ? [...mysqlAuthArgs(), '--single-transaction', '--routines', '--triggers', database]
      : [...psqlAuthArgs(), '--no-owner', '--no-privileges', '--dbname', database];
    const result = await run(tool, args, { timeoutMs: 180000, maxBuffer: 256 * 1024 * 1024 });
    if (!result.ok) throw new Error(failureMessage(result, `${tool} could not produce a dump of ${database}`));
    if (!result.stdout.trim()) throw new Error(`${tool} produced an empty dump for ${database}, so nothing was downloaded`);
    return { name: database, engine: which, sql: result.stdout, bytes: Buffer.byteLength(result.stdout, 'utf8'), verified: true };
  }

  async function databaseImport({ name, engine, sql }) {
    const database = assertScoped(name);
    const which = engineFor(engine);
    const text = String(sql || '');
    if (!text.trim()) throw new Error('The dump file is empty');
    if (!(await databaseExists(database, which))) throw new Error(`There is no database called ${database} to import into`);
    const before = await databaseTables({ name: database, engine: which });
    const tool = which === 'mysql' ? probed.mysql.client : probed.psql.client;
    const args = which === 'mysql' ? [...mysqlAuthArgs(), database] : [...psqlAuthArgs(), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--dbname', database];
    const result = await run(tool, args, { input: text, timeoutMs: 300000 });
    if (!result.ok) throw new Error(failureMessage(result, `the import into ${database} failed`));
    const after = await databaseTables({ name: database, engine: which });
    return { name: database, engine: which, tables_before: before.tables.length, tables_after: after.tables.length, verified: true };
  }

  function assertDbPassword(password) {
    if (!DB_PASSWORD.test(String(password || ''))) {
      throw new Error('A database password must be 10–128 characters using letters, digits and ! # % * + - = ? @ ^ _ ~ . only');
    }
    return password;
  }

  // ── Mail queue ───────────────────────────────────────────────────
  // Postfix owns the queue; the panel only reads it and asks it to act.
  async function mailQueue() {
    const result = await run('postqueue', ['-p'], { timeoutMs: 20000 });
    if (!result.ok && !result.stdout) throw new Error(failureMessage(result, 'the mail queue could not be read'));
    const text = result.stdout || '';
    if (/Mail queue is empty/i.test(text)) return { messages: [], count: 0, source: 'postfix' };
    const messages = [];
    for (const block of text.split(/\n\s*\n/)) {
      const head = block.trim().split('\n')[0] || '';
      const match = head.match(/^([A-F0-9]+)([*!]?)\s+(\d+)\s+(.+?)\s{2,}(\S+@\S+|\S+)$/);
      if (!match) continue;
      const recipients = block.trim().split('\n').slice(1).map(l => l.trim()).filter(l => /@/.test(l) && !/^\(/.test(l));
      messages.push({ id: match[1], active: match[2] === '*', size_bytes: Number(match[3]), arrived: match[4].trim(), sender: match[5], recipients, reason: (block.match(/\(([^)]+)\)/) || [])[1] || null });
    }
    return { messages, count: messages.length, source: 'postfix' };
  }

  async function mailQueueAction({ verb, id }) {
    if (!['retry', 'delete'].includes(verb)) throw new Error(`Unsupported queue action: ${verb}`);
    const target = id === 'ALL' ? 'ALL' : String(id || '').trim();
    if (target !== 'ALL' && !/^[A-F0-9]{6,20}$/.test(target)) throw new Error('A queue id looks like 3F2A1B0C, or use ALL');
    const priv = await privileged();
    if (!priv.ok) throw new Error(`The mail queue cannot be changed because ${priv.reason}`);
    await privilegedClient.run('mail.queue.action', { verb, id: target }, { timeoutMs: 60000 });
    const after = await mailQueue();
    if (verb === 'delete' && target !== 'ALL' && after.messages.some(m => m.id === target)) {
      throw new Error(`${target} is still in the queue after the delete`);
    }
    return { verb, id: target, remaining: after.count, verified: true };
  }

  // ── Files ────────────────────────────────────────────────────────
  // Whoever gets here first must not decide who owns the account's files.
  //
  // This runs on both sides: as the panel user for an ordinary read, and as
  // root when the read goes through the privileged service. Plain mkdir means
  // the root side creates the directory owned by root, and the panel, which is
  // the thing that writes uploads into it, is then locked out of it forever.
  //
  // Found on a purpose-built regression box on 2026-08-29, where it was fatal
  // twice over: file.archive could not write its archive, and an upload
  // afterwards died on EACCES making the private subdirectory, which took the
  // whole panel process down with it. Neither showed on the long-lived box,
  // where that directory had been created by the panel long before.
  //
  // So a directory made here inherits the ownership of the file area above it,
  // which is the panel's. Only root can chown, and only root is ever wrong
  // here, so doing it only when it can be done is exactly right.
  function rootFor(ctx) {
    const root = fileRootFor && fileRootFor(ctx || {});
    if (!root) throw new Error('This panel has no file area configured on disk');
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
      try {
        const parent = fs.statSync(path.dirname(root));
        if (typeof process.getuid === 'function' && process.getuid() === 0) {
          fs.chownSync(root, parent.uid, parent.gid);
        }
      } catch { /* the directory exists either way, which is what the caller needs */ }
    }
    return path.resolve(root);
  }

  function accountPath(relative, ctx) {
    const root = rootFor(ctx);
    const clean = String(relative == null ? '' : relative).replace(/^\/+/, '');
    if (clean.includes('\0')) throw new Error('That path is not valid');
    const resolved = path.resolve(root, clean);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('That path is outside the account file area');
    return resolved;
  }

  function fileList({ dir = '' } = {}, ctx) {
    const target = accountPath(dir, ctx);
    if (!fs.existsSync(target)) return { dir: relativeTo(target, ctx), entries: [], exists: false };
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) throw new Error('That is a file, not a folder');
    const entries = fs.readdirSync(target, { withFileTypes: true }).map(entry => {
      const full = path.join(target, entry.name);
      let info = null;
      try { info = fs.lstatSync(full); } catch {}
      return {
        name: entry.name,
        kind: entry.isDirectory() ? 'folder' : entry.isSymbolicLink() ? 'link' : 'file',
        size_bytes: info ? info.size : null,
        mode: info ? (info.mode & 0o7777).toString(8).padStart(3, '0') : null,
        modified_at: info ? info.mtime.toISOString() : null,
      };
    }).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
    return { dir: relativeTo(target, ctx), entries, exists: true, root: rootFor(ctx) };
  }

  function relativeTo(target, ctx) {
    const rel = path.relative(rootFor(ctx), target);
    return rel === '' ? '/' : `/${rel}`;
  }

  function filePermissions({ target, mode, recursive = false }, ctx) {
    const resolved = accountPath(target, ctx);
    if (!fs.existsSync(resolved)) throw new Error('That file or folder does not exist');
    if (!/^[0-7]{3,4}$/.test(String(mode || ''))) throw new Error('Permissions must be three or four octal digits, such as 644 or 2755');
    const numeric = parseInt(String(mode), 8);
    const apply = entry => fs.chmodSync(entry, numeric);
    apply(resolved);
    let changed = 1;
    if (recursive && fs.statSync(resolved).isDirectory()) {
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          apply(full); changed += 1;
          if (entry.isDirectory()) walk(full);
        }
      };
      walk(resolved);
    }
    const after = (fs.statSync(resolved).mode & 0o7777).toString(8).padStart(3, '0');
    if (parseInt(after, 8) !== numeric) throw new Error(`Permissions read back as ${after}, not ${mode}`);
    return { target: relativeTo(resolved, ctx), mode: after, entries_changed: changed, recursive: !!recursive, verified: true };
  }

  async function fileArchive({ sources, archive }, ctx) {
    const list = (Array.isArray(sources) ? sources : [sources]).filter(Boolean);
    if (!list.length) throw new Error('Choose at least one file or folder to archive');
    const out = accountPath(archive, ctx);
    if (!/\.(tar\.gz|tgz|zip)$/i.test(out)) throw new Error('Name the archive with .tar.gz, .tgz or .zip');
    if (fs.existsSync(out)) throw new Error(`${path.basename(out)} already exists, so nothing was overwritten`);
    const root = rootFor(ctx);
    const relatives = list.map(entry => {
      const resolved = accountPath(entry, ctx);
      if (!fs.existsSync(resolved)) throw new Error(`${entry} does not exist`);
      return path.relative(root, resolved);
    });
    const zip = /\.zip$/i.test(out);
    const result = zip
      ? await run('zip', ['-r', '-q', out, ...relatives], { cwd: root, timeoutMs: 300000 })
      : await run('tar', ['-czf', out, ...relatives], { cwd: root, timeoutMs: 300000 });
    if (!result.ok) throw new Error(failureMessage(result, 'the archive could not be created'));
    if (!fs.existsSync(out)) throw new Error('The archive command finished but no archive was written');
    return { archive: relativeTo(out, ctx), entries: relatives.length, size_bytes: fs.statSync(out).size, format: zip ? 'zip' : 'tar.gz', verified: true };
  }

  async function fileExtract({ archive, into }, ctx) {
    const source = accountPath(archive, ctx);
    if (!fs.existsSync(source)) throw new Error('That archive does not exist');
    const target = accountPath(into || path.dirname(path.relative(rootFor(ctx), source)), ctx);
    fs.mkdirSync(target, { recursive: true });
    const before = new Set(fs.readdirSync(target));
    const zip = /\.zip$/i.test(source);
    const result = zip
      ? await run('unzip', ['-o', '-q', source, '-d', target], { timeoutMs: 300000 })
      : await run('tar', ['-xzf', source, '-C', target], { timeoutMs: 300000 });
    if (!result.ok) throw new Error(failureMessage(result, 'the archive could not be extracted'));
    const added = fs.readdirSync(target).filter(entry => !before.has(entry));
    if (!added.length) throw new Error('The extract finished without adding anything, so the archive may be empty or already extracted');
    return { archive: relativeTo(source, ctx), into: relativeTo(target, ctx), added, verified: true };
  }

  // ── DNS, read from the resolver ──────────────────────────────────
  // Not the panel's private copy of a zone but what the internet is actually
  // answering, which is the thing an operator is trying to find out when a
  // record "should" be there and is not.
  async function dnsRecords({ zone, types }) {
    const name = String(zone || '').trim().toLowerCase().replace(/\.$/, '');
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(name)) throw new Error(`${zone || 'that'} is not a domain name`);
    const wanted = (Array.isArray(types) && types.length ? types : ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA']).map(t => String(t).toUpperCase());
    const records = [];
    const notes = [];
    for (const type of wanted) {
      try {
        const answers = await dns.resolve(name, type);
        for (const answer of flattenDns(type, answers)) records.push({ name, type, ...answer });
      } catch (error) {
        if (!['ENODATA', 'ENOTFOUND', 'NOTFOUND'].includes(error.code)) notes.push(`${type}: ${error.code || error.message}`);
      }
    }
    for (const label of ['www', 'mail', 'ftp', '_dmarc']) {
      try {
        const answers = await dns.resolve(`${label}.${name}`, label === '_dmarc' ? 'TXT' : 'A');
        for (const answer of flattenDns(label === '_dmarc' ? 'TXT' : 'A', answers)) records.push({ name: `${label}.${name}`, type: label === '_dmarc' ? 'TXT' : 'A', ...answer });
      } catch { /* absent is the normal case and is not a finding */ }
    }
    return { zone: name, records, checked_at: now().toISOString(), source: 'public resolver', notes };
  }

  // SPF, DKIM and DMARC for one domain, read from the resolver and explained.
  // No privilege is involved, so this answers on any box: it is asking the
  // internet what it already says about somebody's mail.
  async function mailAuthCheck({ domain, selectors }) {
    return checkMailAuth({ domain, selectors }, { resolveTxt: (name, type) => dns.resolve(name, type || 'TXT') });
  }

  function flattenDns(type, answers) {
    if (type === 'MX') return answers.map(a => ({ value: a.exchange, preference: a.priority }));
    if (type === 'TXT') return answers.map(a => ({ value: Array.isArray(a) ? a.join('') : String(a) }));
    if (type === 'SOA') return [{ value: `${answers.nsname} ${answers.hostmaster} serial ${answers.serial}` }];
    return answers.map(a => ({ value: String(a) }));
  }

  // ── Firewall, packages, keys ─────────────────────────────────────
  async function firewallList() {
    return privilegedClient.run('firewall.list', {}, { timeoutMs: 20000 });
  }

  // Backups. The panel never touches the archives itself; every one of these
  // is a named job on the root side, same as everything else that writes.
  async function backupCreate({ domain, parts, databases, engine, keep, runId, trigger }) {
    return privilegedClient.run('backup.create', {
      domain, parts: parts || null, databases: databases || null, engine: engine || null,
      keep: keep || null, runId: runId || null, trigger: trigger || 'manual',
    }, { timeoutMs: 1800000 });
  }
  // Putting a backup that came back from a destination into this machine's own
  // backup store. The panel downloads into staging, this hands the staged files
  // to the privileged side, and that side checks every one of them before
  // anything is written. Nothing here inspects or trusts the files: it forwards
  // references to them and lets the side that can write the store decide.
  async function backupOffsiteStage({ domain, id, files }) {
    return privilegedClient.run('backup.offsite.stage', { domain, id, files: files || [] }, { timeoutMs: 15 * 60 * 1000 });
  }
  async function backupList({ domain }) {
    return privilegedClient.run('backup.list', { domain: domain || null }, { timeoutMs: 30000 });
  }
  async function backupContents({ domain, id, part }) {
    return privilegedClient.run('backup.contents', { domain, id, part: part || 'files' }, { timeoutMs: 300000 });
  }
  async function mailAuthSetup({ domain, policy, reportTo, selector }) {
    return privilegedClient.run('mailauth.setup', { domain, policy: policy || 'none', reportTo: reportTo || null, selector: selector || 'jotpanel' }, { timeoutMs: 300000 });
  }

  async function panelDomainSet({ domain, email, staging }) {
    return privilegedClient.run('panel.domain.set', { domain, email, staging: !!staging }, { timeoutMs: 900000 });
  }

  // Signing on the native stack, once OpenDKIM is installed.
  async function dkimEnable({ domain, selector }) {
    return privilegedClient.run('mail.dkim.enable', { domain, selector: selector || 'jotpanel' }, { timeoutMs: 180000 });
  }
  async function dkimShow({ domain }) {
    return privilegedClient.run('mail.dkim.show', { domain }, { timeoutMs: 30000 });
  }

  // DNS on the native stack, once BIND is installed. Reading from the public
  // resolver stays where it is: the zone is what this machine believes and the
  // resolver is what the world has been told, and both answers are useful.
  async function dnsZones() { return privilegedClient.run('dns.zones', {}, { timeoutMs: 30000 }); }
  async function dnsZoneRecords({ zone }) { return privilegedClient.run('dns.zone.records', { zone }, { timeoutMs: 30000 }); }
  async function dnsZoneCreate({ zone, ip }) { return privilegedClient.run('dns.zone.create', { zone, ip: ip || null }, { timeoutMs: 60000 }); }
  async function dnsZoneDelete({ zone }) { return privilegedClient.run('dns.zone.delete', { zone }, { timeoutMs: 60000 }); }
  async function dnsRecordCreate({ zone, label, type, value, ttl, preference }) {
    return privilegedClient.run('dns.record.write', { zone, label: label || '@', type, value, ttl: ttl || null, preference: preference == null ? null : preference }, { timeoutMs: 60000 });
  }
  async function dnsRecordDelete({ zone, label, type, value }) {
    return privilegedClient.run('dns.record.remove', { zone, label: label || '@', type, value: value || null }, { timeoutMs: 60000 });
  }

  async function dmarcReports({ domain, mailbox, limit }) {
    return privilegedClient.run('dmarc.reports.read', { domain, mailbox: mailbox || 'dmarc', limit: limit || null, knownSenders: null }, { timeoutMs: 120000 });
  }
  async function backupScheduleSet({ domain, when, parts, databases, engine, keep, offsite }) {
    return privilegedClient.run('backup.schedule.set', {
      domain, when: when || 'daily', parts: parts || null, databases: databases || null,
      engine: engine || null, keep: keep || null,
      // Named here as well as in the operation and the job. This function
      // destructures what it forwards, so a parameter it does not name is
      // silently dropped and the operation still answers 200: the schedule was
      // written, just without the thing that was asked for. Live testing caught
      // exactly that, and the caller had no way to tell.
      offsite: offsite === true,
    }, { timeoutMs: 60000 });
  }
  async function backupScheduleClear({ domain }) {
    return privilegedClient.run('backup.schedule.clear', { domain }, { timeoutMs: 60000 });
  }
  async function backupRunsUnattended({ known } = {}) {
    return privilegedClient.run('backup.runs.unattended', { known: known || [] }, { timeoutMs: 30000 });
  }
  async function backupScheduleStatus() {
    return privilegedClient.run('backup.schedule.status', {}, { timeoutMs: 30000 });
  }
  async function backupFetch({ domain, id, part }) {
    return privilegedClient.run('backup.fetch', { domain, id, part: part || 'files' }, { timeoutMs: 60000 });
  }
  async function backupFileVersions({ domain, path: entryPath }) {
    return privilegedClient.run('backup.file.versions', { domain, path: entryPath }, { timeoutMs: 300000 });
  }
  async function backupFilePreview({ domain, id, part, path: entryPath }) {
    return privilegedClient.run('backup.file.preview', { domain, id, part: part || 'files', path: entryPath }, { timeoutMs: 120000 });
  }
  async function backupRestore({ domain, id, part, database, engine, path: entryPath, mode }) {
    return privilegedClient.run('backup.restore', { domain, id, part: part || 'files', database: database || null, engine: engine || null, path: entryPath || null, mode: mode || 'in-place' }, { timeoutMs: 1800000 });
  }

  // A guarded change copies the rules aside and asks systemd to put them back
  // shortly, so a rule that cuts the operator off undoes itself. Confirming
  // that you are still connected is what cancels it.
  async function firewallGuardArm({ minutes }) {
    return privilegedClient.run('firewall.guard.arm', { minutes: minutes || 5 }, { timeoutMs: 30000 });
  }
  async function firewallGuardConfirm({ guardId }) {
    return privilegedClient.run('firewall.guard.confirm', { guardId }, { timeoutMs: 30000 });
  }
  async function firewallGuardStatus() {
    return privilegedClient.run('firewall.guard.status', {}, { timeoutMs: 20000 });
  }

  async function firewallRule({ verb, port, protocol = 'tcp', address, index }) {
    const priv = await privileged();
    if (!priv.ok) throw new Error(`Firewall rules cannot be changed because ${priv.reason}`);
    let args;
    if (verb === 'delete') {
      const number = Number(index);
      if (!Number.isInteger(number) || number < 1) throw new Error('A rule number is required to delete a rule');
      args = ['--force', 'delete', String(number)];
    } else if (verb === 'allow' || verb === 'deny') {
      if (address) {
        if (!/^[0-9a-fA-F:.\/]{3,49}$/.test(address)) throw new Error('That address or range is not valid');
        args = [verb, 'from', address];
        if (port) args.push('to', 'any', 'port', assertPort(port), 'proto', assertProto(protocol));
      } else {
        args = [verb, `${assertPort(port)}/${assertProto(protocol)}`];
      }
    } else throw new Error(`Unsupported firewall action: ${verb}`);
    return privilegedClient.run('firewall.rule', { verb, port: port || null, protocol, address: address || '', index: index || null }, { timeoutMs: 30000 });
  }

  function assertPort(port) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('A port between 1 and 65535 is required');
    return String(value);
  }

  function assertProto(protocol) {
    const value = String(protocol || 'tcp').toLowerCase();
    if (!['tcp', 'udp'].includes(value)) throw new Error('Protocol must be tcp or udp');
    return value;
  }

  async function packageStatus() {
    const upgradable = await run('apt-get', ['--just-print', 'upgrade'], { timeoutMs: 60000 });
    if (!upgradable.ok) throw new Error(failureMessage(upgradable, 'the package list could not be read'));
    const packages = upgradable.stdout.split('\n')
      .map(line => line.match(/^Inst\s+(\S+)\s+\[([^\]]*)\]\s+\(([^\s]+)\s+([^)]*)\)/))
      .filter(Boolean)
      .map(m => ({ name: m[1], installed: m[2], candidate: m[3], origin: m[4], security: /security/i.test(m[4]) }));
    let rebootRequired = false;
    try { rebootRequired = fs.existsSync('/var/run/reboot-required'); } catch {}
    return {
      packages, count: packages.length,
      security_count: packages.filter(p => p.security).length,
      reboot_required: rebootRequired,
      checked_at: now().toISOString(),
    };
  }

  async function packageApply({ securityOnly = true }) {
    const priv = await privileged();
    if (!priv.ok) throw new Error(`Updates cannot be installed because ${priv.reason}`);
    // No explicit budget here on purpose. This work runs as a privileged
    // oneshot that writes its own verified result, so the client's per-job
    // budget applies: it stops watching after a couple of minutes and hands the
    // action to the watcher, which finishes the record from that file. A
    // twenty-minute timeout passed from here would override that and hold the
    // request open until nginx cut it off instead.
    return privilegedClient.run('packages.apply', { securityOnly });
  }

  // ── Authorised SSH keys ─────────────────────────────────────────
  //
  // Asked of the privileged unit, and it did not always be. These three used to
  // run here, in the panel process, appending to `os.homedir()/.ssh/
  // authorized_keys`. The panel process runs as the `jotpanel` service account,
  // whose shell is `/usr/sbin/nologin`, so a key added through the panel landed
  // in a file that authorises nobody, and the operation read back the file it
  // had just written and agreed with itself. Authorising a key is handing
  // somebody the whole machine, so it belongs behind the same boundary as
  // everything else that can do that.
  async function sshKeyList() {
    const priv = await privileged();
    if (!priv.ok) throw new Error(`The authorised keys cannot be read because ${priv.reason}`);
    return privilegedClient.run('sshkey.list', {}, { timeoutMs: 30000 });
  }

  async function sshKeyAdd({ key }) {
    const priv = await privileged();
    if (!priv.ok) throw new Error(`A key cannot be authorised because ${priv.reason}`);
    return privilegedClient.run('sshkey.add', { key }, { timeoutMs: 30000 });
  }

  async function sshKeyRemove({ line }) {
    const priv = await privileged();
    if (!priv.ok) throw new Error(`A key cannot be revoked because ${priv.reason}`);
    return privilegedClient.run('sshkey.remove', { line }, { timeoutMs: 30000 });
  }

  async function systemReboot() {
    const priv = await privileged();
    if (!priv.ok) throw new Error(`The machine cannot be restarted because ${priv.reason}`);
    // Nothing verifies a reboot from inside the machine being rebooted, and
    // pretending otherwise would be the one dishonest result in this file.
    await privilegedClient.run('system.reboot', {}, { timeoutMs: 15000 });
    return { requested: true, verified: false, note: 'The restart was accepted by systemd. Nothing inside this machine can confirm it came back; reload the panel in a minute.' };
  }

  // ── One command, recorded ────────────────────────────────────────
  // Not an interactive shell. One command, a fixed working directory, a time
  // limit, and the whole thing on the record. Off unless the operator turns it
  // on in the environment.
  async function consoleRun({ command }) {
    if (!consoleEnabled) throw new Error('The command console is switched off on this server (set JOTPANEL_OPS_CONSOLE=1 to enable it; ARCA_OPS_CONSOLE remains a read fallback)');
    const text = String(command || '').trim();
    if (!text) throw new Error('Enter a command');
    if (text.length > 2000 || /[\0\r\n]/.test(text)) throw new Error('A command must be one line of no more than 2000 characters');
    const result = await run('/bin/sh', ['-lc', text], { cwd: consoleCwd, timeoutMs: 60000 });
    return {
      command: text, cwd: consoleCwd, exit_code: result.code,
      stdout: result.stdout.slice(-64 * 1024), stderr: result.stderr.slice(-64 * 1024),
      timed_out: result.timedOut, ok: result.ok, verified: true,
    };
  }

  function assertUnit(unit) {
    const value = String(unit || '').trim();
    if (!UNIT.test(value)) throw new Error('That is not a valid service name');
    return /\.(service|socket|timer|target|mount|path)$/.test(value) ? value : `${value}.service`;
  }

  // ── Capability registration ──────────────────────────────────────
  // Everything above is only offered once the tool it depends on has answered
  // for itself on this machine.
  async function capabilities(force = false) {
    const state = await probe(force);
    const caps = new Map();
    const missing = new Map();
    // Some handlers are synchronous filesystem work and some shell out. They
    // are wrapped so every caller sees the same thing: a promise that rejects,
    // never a mixture of thrown and rejected.
    const add = (id, kind, handler) => caps.set(id, {
      id, kind, backend: 'host',
      run: (params, ctx) => Promise.resolve().then(() => handler(params, ctx)),
    });
    const skip = (id, reason) => missing.set(id, reason);

    add('system.metrics', 'read', systemMetrics);
    add('system.metrics.history', 'read', systemMetricsHistory);

    if (state.diskUsage.ok) {
      add('disk.usage', 'read', () => privilegedClient.run('disk.usage', {}));
    } else skip('disk.usage', state.diskUsage.reason || 'folder disk usage is not readable with panel privilege');

    if (state.systemctl) {
      add('service.list', 'read', serviceList);
      add('service.status', 'read', serviceStatus);
      if (state.privileged.ok) add('service.control', 'write', serviceControl);
      else skip('service.control', `systemd is here but ${state.privileged.reason}`);
      if (state.privileged.ok) add('system.reboot', 'write', systemReboot);
      else skip('system.reboot', `systemd is here but ${state.privileged.reason}`);
    } else {
      const why = `systemd is not present on this host (${state.platform})`;
      skip('service.list', why); skip('service.status', why); skip('service.control', why); skip('system.reboot', why);
    }

    if (state.ps) { add('process.list', 'read', processList); add('process.kill', 'write', processKill); }
    else { skip('process.list', 'ps is not available on this host'); skip('process.kill', 'ps is not available on this host'); }

    if (state.logs.length) {
      add('log.sources', 'read', logSources);
      add('log.tail', 'read', logTail);
      add('log.search', 'read', logSearch);
      add('log.download', 'read', logDownload);
    } else {
      const why = 'no readable log file was found in the usual places (set JOTPANEL_OPS_LOG_PATHS to name your own; ARCA_OPS_LOG_PATHS remains a read fallback)';
      ['log.sources', 'log.tail', 'log.search', 'log.download'].forEach(id => skip(id, why));
    }
    if (state.journalctl && state.journalctl.ok) add('log.journal', 'read', journalTail);
    else skip('log.journal', (state.journalctl && state.journalctl.reason) || 'journalctl is not present on this host');

    if (state.mysql.ok || state.psql.ok) {
      add('database.list', 'read', databaseList);
      add('database.tables', 'read', databaseTables);
      add('database.create', 'write', databaseCreate);
      add('database.drop', 'write', databaseDrop);
      add('database.user.create', 'write', databaseUserCreate);
      add('database.user.drop', 'write', databaseUserDrop);
      add('database.grant', 'write', databaseGrant);
      add('database.password', 'write', databasePassword);
      add('database.dump', 'read', databaseDump);
      add('database.import', 'write', databaseImport);
    } else {
      const why = `${state.mysql.reason}; ${state.psql.reason}`;
      ['database.list', 'database.tables', 'database.create', 'database.drop', 'database.user.create',
        'database.user.drop', 'database.grant', 'database.password', 'database.dump', 'database.import'].forEach(id => skip(id, why));
    }

    if (state.postqueue.ok) { add('mail.queue.list', 'read', mailQueue); add('mail.queue.action', 'write', mailQueueAction); }
    else { skip('mail.queue.list', `the Postfix queue permission probe failed: ${state.postqueue.reason}`); skip('mail.queue.action', `the Postfix queue permission probe failed: ${state.postqueue.reason}`); }

    if (fileRootFor) {
      add('file.list', 'read', fileList);
      add('file.permissions', 'write', filePermissions);
      if (state.tar) { add('file.archive', 'write', fileArchive); add('file.extract', 'write', fileExtract); }
      else { skip('file.archive', 'tar is not available on this host'); skip('file.extract', 'tar is not available on this host'); }
    } else {
      ['file.list', 'file.permissions', 'file.archive', 'file.extract'].forEach(id => skip(id, 'this panel has no file area configured on disk'));
    }

    add('dns.records', 'read', dnsRecords);
    add('mailauth.check', 'read', mailAuthCheck);
    if (state.privileged && state.privileged.ok) add('mailauth.setup', 'write', mailAuthSetup);

    if (state.ufw.ok) {
      add('firewall.list', 'read', firewallList);
      if (state.privileged.ok) add('panel.domain.set', 'write', panelDomainSet);
      if (state.privileged.ok) {
        add('backup.list', 'read', backupList);
        add('backup.offsite.stage', 'write', backupOffsiteStage);
        add('backup.contents', 'read', backupContents);
        add('backup.fetch', 'read', backupFetch);
        add('backup.schedule.status', 'read', backupScheduleStatus);
        add('backup.runs.unattended', 'read', backupRunsUnattended);
        add('dmarc.reports.read', 'read', dmarcReports);
        if (state.signer && state.signer.ok) {
          add('mail.dkim.show', 'read', dkimShow);
          add('mail.dkim.enable', 'write', dkimEnable);
        }
        // Only when BIND is actually answering. Rule 3: a zone editor on a
        // machine with no name server is a screen that cannot work.
        if (state.named && state.named.ok) {
          add('dns.zones', 'read', dnsZones);
          add('dns.zone.records', 'read', dnsZoneRecords);
          add('dns.zone.create', 'write', dnsZoneCreate);
          add('dns.zone.delete', 'write', dnsZoneDelete);
          add('dns.record.create', 'write', dnsRecordCreate);
          add('dns.record.delete', 'write', dnsRecordDelete);
        } else {
          const why = (state.named && state.named.reason) || 'BIND is not installed here';
          for (const id of ['dns.zones', 'dns.zone.records', 'dns.zone.create', 'dns.zone.delete', 'dns.record.create', 'dns.record.delete']) skip(id, why);
        }
        add('backup.schedule.set', 'write', backupScheduleSet);
        add('backup.schedule.clear', 'write', backupScheduleClear);
        add('backup.file.versions', 'read', backupFileVersions);
        add('backup.file.preview', 'read', backupFilePreview);
        add('backup.create', 'write', backupCreate);
        add('backup.restore', 'write', backupRestore);
        add('firewall.rule', 'write', firewallRule);
        add('firewall.guard.arm', 'write', firewallGuardArm);
        add('firewall.guard.confirm', 'write', firewallGuardConfirm);
        add('firewall.guard.status', 'read', firewallGuardStatus);
      }
      else {
        skip('firewall.rule', `ufw is here but ${state.privileged.reason}`);
        skip('firewall.guard.arm', `ufw is here but ${state.privileged.reason}`);
      }
    } else { skip('firewall.list', `ufw permission probe failed: ${state.ufw.reason}`); skip('firewall.rule', `ufw permission probe failed: ${state.ufw.reason}`); }

    if (state.apt.ok) {
      add('packages.status', 'read', packageStatus);
      if (state.privileged.ok) add('packages.apply', 'write', packageApply);
      else skip('packages.apply', `apt is here but ${state.privileged.reason}`);
    } else { skip('packages.status', `apt permission probe failed: ${state.apt.reason}`); skip('packages.apply', `apt permission probe failed: ${state.apt.reason}`); }

    if (state.privileged.ok) {
      add('sshkey.list', 'read', sshKeyList);
      add('sshkey.add', 'write', sshKeyAdd);
      add('sshkey.remove', 'write', sshKeyRemove);
    } else {
      // Offering these without the privileged unit is what produced a key that
      // authorised nobody, so they are withheld rather than served from a file
      // the panel happens to be able to write.
      for (const id of ['sshkey.list', 'sshkey.add', 'sshkey.remove']) skip(id, state.privileged.reason);
    }

    if (consoleEnabled) add('console.run', 'write', consoleRun);
    else skip('console.run', 'the command console is switched off on this server (JOTPANEL_OPS_CONSOLE; ARCA_OPS_CONSOLE remains a read fallback)');

    // Native stacks are claimed by nativeStackBackend. These fallback reasons
    // exist only when that backend is not attached; no second panel is needed.
    const NEEDS_PANEL = 'the native stack is not attached. Install the named packages here, connect an existing service, or use the managed-service link.';
    for (const id of [
      'site.list', 'site.create', 'site.delete', 'site.php.versions', 'site.php.set', 'site.alias.set',
      'site.protect.list', 'site.protect.set', 'site.protect.clear',
      'mail.domains', 'mail.mailbox.list', 'mail.mailbox.create', 'mail.mailbox.delete', 'mail.mailbox.password',
      'mail.mailbox.quota', 'mail.forwarder.set', 'mail.forwarder.delete', 'mail.autoreply.set', 'mail.autoreply.clear',
      'mail.catchall.set', 'mail.antispam.set', 'mail.dkim.show', 'mail.dkim.enable',
      'migrate.preview', 'migrate.apply', 'migrate.imap.inspect', 'migrate.imap.pull',
      'runtime.list', 'runtime.status', 'runtime.set', 'runtime.clear', 'runtime.restart', 'runtime.install',
    ]) if (!caps.has(id)) skip(id, NEEDS_PANEL);

    return { capabilities: caps, missing, state };
  }

  return { name: 'host', probe, capabilities, dbPrefix, accountPath, rootFor };
}

function sanitizePrefix(value) {
  const prefix = String(value || 'jotpanel').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{0,15}$/.test(prefix)) throw new Error('JOTPANEL_OPS_DB_PREFIX must be 1–16 lowercase letters or digits starting with a letter');
  return prefix;
}

module.exports = { createHostBackend, IDENT, DB_PASSWORD, SSH_KEY, LOG_CANDIDATES, siteAccessLogPaths };
