'use strict';

// The revert half of the firewall guard. systemd runs this on its own, as a
// transient timer armed when a risky rule was applied, so a change that cuts
// the operator off is undone by the machine rather than by the person who can
// no longer reach it. It takes one argument, the guard id, and nothing else.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_DIR = (process.env.JOTPANEL_OPS_STATE_DIR ?? process.env.ARCA_OPS_STATE_DIR) || '/var/lib/jotpanel-ops';
const id = String(process.argv[2] || '');
if (!/^[0-9a-f]{12}$/.test(id)) { console.error('[fw-revert] a guard id is required'); process.exit(2); }

const dir = path.join(STATE_DIR, 'firewall-snapshots', id);
if (!fs.existsSync(dir)) { console.error('[fw-revert] nothing to restore for', id); process.exit(0); }

let restored = 0;
for (const name of ['user.rules', 'user6.rules']) {
  const from = path.join(dir, name);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join('/etc/ufw', name));
  restored++;
}

try {
  for (const bin of ['/usr/sbin/ufw', '/usr/bin/ufw']) {
    if (!fs.existsSync(bin)) continue;
    execFileSync(bin, ['reload'], { timeout: 30000, stdio: 'ignore' });
    break;
  }
} catch (e) { console.error('[fw-revert] reload failed:', e.message); }

// Out of the armed folder and into the spent one. A guard that has already
// fired must never still read as armed: the operator would think they were
// protected when they are not, and the lockout check would wave through a
// change on the strength of a guard that is no longer there. The snapshot
// itself is kept, because a change that undid itself is worth being able to
// look at afterwards.
fs.writeFileSync(path.join(dir, 'reverted.json'), JSON.stringify({ id, restored, at: new Date().toISOString() }));
const spent = path.join(STATE_DIR, 'firewall-snapshots-spent', id);
try {
  fs.mkdirSync(path.dirname(spent), { recursive: true, mode: 0o700 });
  fs.rmSync(spent, { recursive: true, force: true });
  fs.renameSync(dir, spent);
} catch (e) { console.error('[fw-revert] could not file the spent guard:', e.message); }
console.error(`[fw-revert] restored ${restored} rule file(s) for ${id}, the change was never confirmed`);
