'use strict';

// These tests exist to stop a future change from "improving" the firewall
// guard into a data-loss bug. Read the comment above firewallGuardConflict in
// privilegedJobs.js before touching either of them.

const assert = require('assert');
const { test } = require('node:test');
const { firewallGuardConflict, firewallLockoutRisk } = require('./privilegedJobs');

test('a second guard is refused while one is still armed', () => {
  // Several guards each hold a snapshot from a different moment. The first
  // timer to fire restores its own older picture and undoes a change already
  // confirmed under the other. One at a time is the fix. Do not relax it
  // without replacing the whole-file snapshot with a per-change undo.
  const armed = [{ id: 'a'.repeat(12), armed: true, expiresAt: '2026-08-20T13:31:32.940Z' }];
  assert.ok(firewallGuardConflict(armed), 'an armed guard must block a second one');
  assert.equal(firewallGuardConflict([{ id: 'b'.repeat(12), armed: false }]), null);
  assert.equal(firewallGuardConflict([]), null);
  assert.equal(firewallGuardConflict(undefined), null);
});

test('the changes that take away the way in are recognised', () => {
  const rules = [
    { index: 1, target: '22/tcp', action: 'ALLOW' },
    { index: 2, target: 'OpenSSH', action: 'ALLOW' },
    { index: 3, target: '12345/tcp', action: 'ALLOW' },
  ];
  assert.ok(firewallLockoutRisk({ verb: 'deny', port: 22 }, rules));
  assert.ok(firewallLockoutRisk({ verb: 'deny' }, rules));
  assert.ok(firewallLockoutRisk({ verb: 'deny', address: '0.0.0.0/0' }, rules));
  assert.ok(firewallLockoutRisk({ verb: 'delete', index: 2 }, rules), 'deleting the SSH rule is a lockout');
  assert.ok(firewallLockoutRisk({ verb: 'delete', index: 1 }, rules), 'deleting port 22 is a lockout');
});

test('ordinary changes are not treated as dangerous', () => {
  const rules = [{ index: 1, target: '12345/tcp', action: 'ALLOW' }];
  assert.equal(firewallLockoutRisk({ verb: 'allow', port: 443 }, rules), null);
  assert.equal(firewallLockoutRisk({ verb: 'deny', address: '203.0.113.9' }, rules), null);
  assert.equal(firewallLockoutRisk({ verb: 'delete', index: 1 }, rules), null);
  assert.equal(firewallLockoutRisk({ verb: 'delete', index: 99 }, rules), null);
});

test('asking systemctl for two properties at once is refused, with the reason', async () => {
  // systemd prints multiple --value properties in its own order with nothing
  // saying which is which, so reading them positionally is a coin flip. It
  // reported a live timer as not armed once. Never allow the shape again.
  const { systemctlShow } = require('./privilegedJobs');
  await assert.rejects(() => systemctlShow('x.timer', ['ActiveState', 'NextElapseUSecRealtime']), /one property per call/i);
  await assert.rejects(() => systemctlShow('x.timer', 'ActiveState NextElapseUSecRealtime'), /one property per call/i);
});
