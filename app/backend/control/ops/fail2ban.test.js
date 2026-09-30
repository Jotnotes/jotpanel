'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getOperation, READS } = require('./catalogue');
const { createNativeStackBackend } = require('./nativeStackBackend');
const { executeNamedJob, SPECS, waitForFail2ban } = require('./privilegedJobs');

function clientWithFail2ban(available) {
  const calls = [];
  return {
    calls,
    probe: async () => ({ ok: true }),
    run: async (job, params = {}) => {
      calls.push({ job, params });
      if (job === 'stack.probe') return {
        stack: params.stack,
        available: params.stack === 'fail2ban' ? available : false,
        reason: params.stack === 'fail2ban' && !available ? 'fail2ban-client cannot read the running server' : 'not installed',
      };
      if (job === 'fail2ban.list') return { bans: [{ ip: '203.0.113.9', jail: 'sshd', banned_at: null }] };
      return { jail: params.jail, ip: params.ip, verified: true };
    },
  };
}

test('unban accepts only an IP address and a narrow jail name', () => {
  const unban = getOperation('fail2ban.unban');
  assert.deepEqual(unban.normalize({ jail: 'sshd-aggressive', ip: '203.0.113.9' }), {
    jail: 'sshd-aggressive', ip: '203.0.113.9',
  });
  assert.deepEqual(unban.normalize({ jail: 'dovecot', ip: '2001:db8::8' }), {
    jail: 'dovecot', ip: '2001:db8::8',
  });
  assert.throws(() => unban.normalize({ jail: 'sshd; restart nginx', ip: '203.0.113.9' }), /jail/);
  assert.throws(() => unban.normalize({ jail: 'sshd', ip: 'all' }), /IP address/);
  assert.equal(READS['fail2ban-bans'], 'fail2ban.list');

  const install = getOperation('stack.install.fail2ban');
  assert.deepEqual(install.normalize({ packages: ['anything'] }), { stack: 'fail2ban' });
});

test('fail2ban controls stay absent until the privileged probe passes', async () => {
  const client = clientWithFail2ban(false);
  const report = await createNativeStackBackend({ client }).capabilities();
  for (const id of ['fail2ban.list', 'fail2ban.unban']) {
    assert.equal(report.capabilities.has(id), false, `${id} must not be offered without a passing probe`);
    assert.match(report.missing.get(id), /fail2ban-client cannot read the running server/);
  }
});

test('fail2ban controls cross privilege through fixed named jobs only', async () => {
  const client = clientWithFail2ban(true);
  const { capabilities } = await createNativeStackBackend({ client }).capabilities();
  const list = capabilities.get('fail2ban.list');
  const unban = capabilities.get('fail2ban.unban');
  assert.ok(list); assert.ok(unban);
  assert.equal(list.kind, 'read'); assert.equal(unban.kind, 'write');

  const result = await list.run({ command: 'fail2ban-client status' });
  await unban.run({ jail: 'sshd', ip: '203.0.113.9', argv: ['set', 'sshd', 'unbanip'] });
  assert.deepEqual(client.calls.slice(-2), [
    { job: 'fail2ban.list', params: {} },
    { job: 'fail2ban.unban', params: { jail: 'sshd', ip: '203.0.113.9' } },
  ]);
  assert.deepEqual(SPECS['fail2ban.list'][0], []);
  assert.deepEqual(SPECS['fail2ban.unban'][0], ['jail', 'ip']);
  assert.deepEqual(result, { bans: [{ ip: '203.0.113.9', jail: 'sshd', banned_at: null }] });
});

test('the fail2ban root job rejects command-shaped extra fields', async () => {
  await assert.rejects(
    () => executeNamedJob('fail2ban.unban', { jail: 'sshd', ip: '203.0.113.9', command: 'systemctl stop fail2ban' }),
    /does not accept: command/,
  );
});

test('unban reads the live ban list before and after the change', () => {
  const handler = String(SPECS['fail2ban.unban'][1]);
  assert.match(handler, /const before = await fail2banList\(\)/);
  assert.match(handler, /const after = await fail2banList\(\)/);
  assert.match(handler, /remains banned/);
});

test('installation waits for the control socket instead of racing systemd', async () => {
  let calls = 0;
  let pauses = 0;
  const ready = await waitForFail2ban({
    run: async () => (++calls === 1
      ? { ok: false, stderr: 'Failed to access socket path' }
      : { ok: true, stdout: 'Server replied: pong' }),
    pause: async () => { pauses++; },
    attempts: 3,
  });
  assert.equal(ready, true);
  assert.equal(calls, 2);
  assert.equal(pauses, 1);
});
