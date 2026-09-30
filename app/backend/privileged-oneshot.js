'use strict';

// The privileged jobs the operations daemon must not run inside itself.
//
// jotpanel-ops is long-lived and keeps RestrictSUIDSGID and ProtectHome. dpkg can
// live with neither: libpam-modules-bin ships pam_extrausers_chkpwd setgid
// shadow, so an ordinary security upgrade died on "error setting permissions
// of ./usr/sbin/pam_extrausers_chkpwd: Operation not permitted". Anything that
// drives dpkg runs here instead, for as long as it takes and no longer.
//
// The only argument is a fixed job name from the table below. It is never a
// package name, never a stack chosen at runtime and never a command. The
// daemon validates it before starting the unit and it is validated again here,
// because this process is root and the systemd instance name is attacker-shaped
// input in every design where somebody eventually gets it wrong.

const fs = require('fs');
const path = require('path');
const { installStackPackages, applyPackageUpdates, installRuntimePackages, runImapPull, RUNTIMES, ONESHOT_INSTANCES } = require('./control/ops/privilegedJobs');

if (typeof process.getuid !== 'function' || process.getuid() !== 0) throw new Error('The privileged oneshot must run as root');

const JOBS = {
  'stack-database': () => installStackPackages({ stack: 'database' }),
  'stack-postgres': () => installStackPackages({ stack: 'postgres' }),
  'stack-web': () => installStackPackages({ stack: 'web' }),
  'stack-certificates': () => installStackPackages({ stack: 'certificates' }),
  'stack-webmail': () => installStackPackages({ stack: 'webmail' }),
  'stack-fail2ban': () => installStackPackages({ stack: 'fail2ban' }),
  'stack-mail': () => installStackPackages({ stack: 'mail' }),
  'stack-dns': () => installStackPackages({ stack: 'dns' }),
  'stack-voice': () => installStackPackages({ stack: 'voice' }),
  'stack-dkim': () => installStackPackages({ stack: 'dkim' }),
  'stack-antispam': () => installStackPackages({ stack: 'antispam' }),
  'stack-php': () => installStackPackages({ stack: 'php' }),
  'packages-security': () => applyPackageUpdates({ securityOnly: true }),
  'packages-all': () => applyPackageUpdates({ securityOnly: false }),
  // The parameters are not on the command line and never could be: the
  // instance name is the whole argument, so the daemon leaves the connection
  // settings in a root-only file on tmpfs and this reads them once.
  'migrate-imap': () => runImapPull(),
  // One entry per language with something to install. Built from the same table
  // the daemon validates against, so the two cannot say different things.
  ...Object.fromEntries(Object.entries(RUNTIMES)
    .filter(([, spec]) => spec.packages.length)
    .map(([id]) => [`runtime-${id}`, () => installRuntimePackages({ runtime: id })])),
};

const instance = String(process.argv[2] || '');
const job = ONESHOT_INSTANCES.includes(instance) ? JOBS[instance] : null;
if (!job) throw new Error(`Unknown privileged oneshot: ${instance}`);
// The two lists are the same set or one of them is wrong, and a job the panel
// can ask about but not run is exactly the kind of drift worth failing on.
for (const name of ONESHOT_INSTANCES) if (!JOBS[name]) throw new Error(`No runner for privileged oneshot ${name}`);

const stateDir = (process.env.JOTPANEL_OPS_STATE_DIR ?? process.env.ARCA_OPS_STATE_DIR) || '/var/lib/jotpanel-ops';
const target = path.join(stateDir, `oneshot-${instance}.json`);

function finish(payload) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o750 });
  const temp = `${target}.${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

job()
  .then(result => finish({ ok: true, result, finished_at: new Date().toISOString() }))
  .catch(error => { finish({ ok: false, error: error.message, finished_at: new Date().toISOString() }); console.error(error); process.exitCode = 1; });
