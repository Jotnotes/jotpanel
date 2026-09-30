'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { READS } = require('./catalogue');
const { createHostBackend } = require('./hostBackend');
const { executeNamedJob, SPECS } = require('./privilegedJobs');

function hostWithDiskProbe(available) {
  const calls = [];
  const client = {
    probe: async () => ({ ok: true }),
    run: async (job, params = {}) => {
      calls.push({ job, params });
      if (job === 'probe.disk-usage') {
        if (!available) throw new Error('the panel cannot read the managed site folders');
        return { available: true };
      }
      if (job === 'disk.usage') return {
        folders: [
          { path: '/srv/jotpanel-sites/example.com', bytes: 2048 },
          { path: '/var/mail/vhosts/example.com', bytes: 1024 },
        ],
      };
      throw new Error(`${job} is unavailable in this test`);
    },
  };
  const run = async () => ({ ok: false, code: 1, missing: true, timedOut: false, stdout: '', stderr: 'absent', error: 'absent' });
  return { backend: createHostBackend({ run, privilegedClient: client }), calls };
}

test('disk usage is declared as a read and hidden when its permission probe fails', async () => {
  assert.equal(READS['disk-usage'], 'disk.usage');
  const { backend } = hostWithDiskProbe(false);
  const report = await backend.capabilities();
  assert.equal(report.capabilities.has('disk.usage'), false);
  assert.match(report.missing.get('disk.usage'), /cannot read the managed site folders/);
});

test('disk usage calls only the parameter-free named job after the probe passes', async () => {
  const { backend, calls } = hostWithDiskProbe(true);
  const { capabilities } = await backend.capabilities();
  const usage = capabilities.get('disk.usage');
  assert.ok(usage, 'a passing permission probe should expose folder usage');
  assert.equal(usage.kind, 'read');
  const result = await usage.run({ path: '/', command: 'du -x /' });
  assert.deepEqual(calls.at(-1), { job: 'disk.usage', params: {} });
  assert.deepEqual(result, {
    folders: [
      { path: '/srv/jotpanel-sites/example.com', bytes: 2048 },
      { path: '/var/mail/vhosts/example.com', bytes: 1024 },
    ],
  });
  assert.deepEqual(SPECS['probe.disk-usage'][0], []);
  assert.deepEqual(SPECS['disk.usage'][0], []);
});

test('the disk usage root job rejects caller-selected paths and commands', async () => {
  await assert.rejects(
    () => executeNamedJob('disk.usage', { path: '/', command: 'du -x /' }),
    /does not accept: path, command/,
  );
});
