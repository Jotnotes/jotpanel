'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getOperation, READS } = require('./catalogue');
const { createNativeStackBackend } = require('./nativeStackBackend');
const { SPECS } = require('./privilegedJobs');

function clientWithWebmail(available) {
  const calls = [];
  return {
    calls,
    probe: async () => ({ ok: true }),
    run: async (job, params = {}) => {
      calls.push({ job, params });
      if (job === 'stack.probe') return {
        stack: params.stack,
        available: params.stack === 'webmail' ? available : false,
        reason: params.stack === 'webmail' && !available ? 'Roundcube cannot read its own configuration' : 'not installed',
      };
      return {
        available: true,
        url: 'https://panel.example.com/webmail/',
        mailboxes: [{ address: 'sales@example.com', url: 'https://panel.example.com/webmail/?_user=sales%40example.com' }],
      };
    },
  };
}

test('Roundcube is a fixed installable stack and a declared read resource', () => {
  const install = getOperation('stack.install.webmail');
  assert.deepEqual(install.normalize({ stack: 'anything-else' }), { stack: 'webmail' });
  assert.equal(install.capability, 'stack.install');
  assert.equal(READS.webmail, 'webmail.status');
});

test('webmail stays absent until its privileged stack probe passes', async () => {
  const client = clientWithWebmail(false);
  const report = await createNativeStackBackend({ client }).capabilities();
  assert.equal(report.capabilities.has('webmail.status'), false);
  assert.match(report.missing.get('webmail.status'), /Roundcube cannot read its own configuration/);
});

test('webmail status uses a parameter-free named job after the probe passes', async () => {
  const client = clientWithWebmail(true);
  const { capabilities } = await createNativeStackBackend({ client }).capabilities();
  const status = capabilities.get('webmail.status');
  assert.ok(status, 'a passing Roundcube probe should expose webmail status');
  assert.equal(status.kind, 'read');

  const result = await status.run({ command: 'cat /etc/roundcube/config.inc.php' });
  assert.deepEqual(client.calls.at(-1), { job: 'webmail.status', params: {} });
  assert.deepEqual(SPECS['webmail.status'][0], []);
  assert.equal(result.available, true);
  assert.equal(typeof result.url, 'string');
  assert.deepEqual(result.mailboxes, [
    { address: 'sales@example.com', url: 'https://panel.example.com/webmail/?_user=sales%40example.com' },
  ]);
});
