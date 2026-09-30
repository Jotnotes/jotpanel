'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { READS } = require('./catalogue');
const { createHostBackend } = require('./hostBackend');

function localMetricsBackend() {
  const privilegedCalls = [];
  const client = {
    probe: async () => ({ ok: false, reason: 'no root service in this test' }),
    run: async (job, params = {}) => {
      privilegedCalls.push({ job, params });
      throw new Error(`${job} is unavailable in this test`);
    },
  };
  const run = async (file, args) => {
    if (file === 'df') return {
      ok: true, code: 0, missing: false, timedOut: false, stderr: '', error: null,
      stdout: 'Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/disk1 1000000 250000 750000 25% /\n',
    };
    return { ok: false, code: 1, missing: true, timedOut: false, stdout: '', stderr: 'absent', error: 'absent' };
  };
  return { backend: createHostBackend({ run, privilegedClient: client }), privilegedCalls };
}

test('the graph history is a declared host-local read', async () => {
  assert.equal(READS['system-metrics-history'], 'system.metrics.history');
  const { backend, privilegedCalls } = localMetricsBackend();
  const report = await backend.capabilities();
  const history = report.capabilities.get('system.metrics.history');
  assert.ok(history, 'metric history should be available without a root daemon');
  assert.equal(history.kind, 'read');
  assert.equal(history.backend, 'host');

  const privilegedBeforeRead = privilegedCalls.length;
  const result = await history.run({ command: 'cat /proc/stat' });
  assert.equal(privilegedCalls.length, privilegedBeforeRead, 'metric history must stay in the unprivileged host backend');
  assert.ok(Array.isArray(result.samples));
});

test('every retained graph sample has the stable chart fields', async () => {
  const { backend } = localMetricsBackend();
  const { capabilities } = await backend.capabilities();
  let result;
  for (let index = 0; index < 185; index++) result = await capabilities.get('system.metrics.history').run({});
  assert.equal(result.samples.length, 180, 'the in-memory history must remain bounded');
  assert.equal(result.retained, 180);
  assert.equal(result.interval_seconds, 30);
  for (const sample of result.samples) {
    assert.equal(typeof sample.at, 'string');
    for (const key of ['cpu_percent', 'memory_percent', 'disk_percent', 'load_1']) {
      assert.equal(Number.isFinite(sample[key]), true, `${key} must be a finite number`);
    }
  }
});
