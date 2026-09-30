'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createProjectLedger } = require('./projectLedger');

const ROOT = __dirname;
const SCOPE = { kind: 'identity', id: 'person-1' };

function vaultScenarios(modulePath) {
  const { createProviderKeyService } = require(modulePath);
  const db = new Database(':memory:');
  const keys = createProviderKeyService({ db, secret: 'test-vault-secret' });
  keys.put(SCOPE, 'openai', 'sk-first-secret-value', { label: 'work', by: 'person-1' });
  keys.put(SCOPE, 'openai', 'sk-second-secret-value', { label: 'home', by: 'person-1' });
  keys.put(SCOPE, 'openai', 'sk-third-secret-value', { label: 'travel', by: 'person-1' });
  assert.deepEqual(keys.list(SCOPE).map(k => k.label), ['work', 'home', 'travel'], 'three labelled keys stay active');
  assert.throws(() => keys.put(SCOPE, 'openai', 'sk-fourth-secret-value', { label: 'fourth', by: 'person-1' }),
    error => error.code === 'KEY_LIMIT', 'a fourth active key is refused');

  const replacement = keys.put(SCOPE, 'openai', 'sk-new-home-secret', { label: 'home', by: 'person-1' });
  assert.equal(replacement.rotated, true, 'a matching label is replaced');
  assert.equal(keys.list(SCOPE).length, 3, 'replacing one label does not revoke the other two');
  assert.deepEqual(keys.resolveAll('openai', [SCOPE], { markUsed: false }).map(k => k.key),
    ['sk-first-secret-value', 'sk-third-secret-value', 'sk-new-home-secret'], 'active keys resolve in stable oldest-first order');
  assert.equal(keys.revoke(SCOPE, 'openai', 'person-1', { label: 'travel' }).revoked, true);
  assert.deepEqual(keys.list(SCOPE).map(k => k.label), ['work', 'home'], 'a labelled delete removes only that key');

  const shown = JSON.stringify(keys.list(SCOPE));
  assert.ok(!shown.includes('secret_enc') && !shown.includes('sk-'), 'no key or ciphertext column reaches a reader');

  const legacy = createProviderKeyService({ db: new Database(':memory:'), secret: 'legacy-secret' });
  legacy.put(SCOPE, 'openai', 'legacy-first', { by: 'person-1' });
  legacy.put(SCOPE, 'openai', 'legacy-second', { by: 'person-1' });
  assert.equal(legacy.list(SCOPE).length, 1, 'an unlabelled legacy caller still rotates one slot');
  assert.equal(legacy.resolve('openai', [SCOPE]).key, 'legacy-second');
}

const failure = status => Object.assign(new Error(`provider refused sk-never-log-this ${status}`), { status });

async function failoverScenarios(modulePath) {
  const { runWithFailover } = require(modulePath);
  const B = { providerId: 'anthropic', model: 'claude', keyFingerprint: 'b1' };
  for (const status of [401, 403, 429]) {
    const calls = [];
    const A = { providerId: 'openai', model: 'gpt', keyFingerprint: 'f1' };
    const result = await runWithFailover({
      first: A, sleep: async () => {}, next: () => B,
      nextKey: route => ({ ...route, keyFingerprint: 'f2' }),
      onFailure: (_route, error) => { error.message = error.message.replace('sk-never-log-this', '[secret removed]'); },
      run: async route => { calls.push(route.keyFingerprint); if (route.keyFingerprint === 'f1') throw failure(status); return 'ok'; },
    });
    assert.deepEqual(calls, ['f1', 'f2'], `${status} tries another key before another provider`);
    assert.equal(result.route.providerId, 'openai');
    assert.ok(result.failures.every(item => !item.message.includes('sk-never-log-this')), 'the failure record is scrubbed');
  }

  const calls = [];
  const A = { providerId: 'openai', model: 'gpt', keyFingerprint: 'f1' };
  const result = await runWithFailover({
    first: A, sleep: async () => {}, next: () => B,
    nextKey: (route, _error, failures) => ({ ...route, keyFingerprint: failures.length === 1 ? 'f2' : 'f3' }),
    onFailure: (_route, error) => { error.message = '[secret removed]'; },
    run: async route => { calls.push(route.keyFingerprint); if (route.providerId === 'openai') throw failure(401); return 'ok'; },
  });
  assert.deepEqual(calls, ['f1', 'f2', 'b1'], 'only one alternate key is tried before the next provider');
  assert.equal(result.failures.filter(item => item.route === 'openai/gpt').length, 2);

  let emitted = 0;
  const stitched = [];
  await assert.rejects(runWithFailover({
    first: A, emitted: () => emitted, next: () => B, nextKey: route => ({ ...route, keyFingerprint: 'f2' }),
    run: async route => { stitched.push(route.keyFingerprint); emitted = 1; throw failure(401); },
  }), /provider refused/);
  assert.deepEqual(stitched, ['f1'], 'a second key is not stitched on after output starts');
}

async function queueScenarios(runnerPath) {
  const db = new Database(':memory:');
  const ledger = createProjectLedger({ db });
  const { createJobRunner } = require(runnerPath);
  const runner = createJobRunner({ db, ledger });

  async function plan(accountId, id, title) {
    const actor = `person:${accountId}`;
    const project = ledger.createProject(accountId, { name: title }, { actor, id: `p_${id}` });
    const made = await runner.planBuild({ accountId, projectId: project.id, goal: title,
      planner: async () => [{ title, mustContain: [`OK-${title}`] }], rough: true, actor: 'resident' });
    const approval = ledger.approve(accountId, made.id, { seenHash: made.hash, approvedBy: actor });
    return ledger.settle(accountId, made.id, { actor, approvalId: approval.id });
  }

  const plans = {
    A1: await plan('a', 'a1', 'A1'), A2: await plan('a', 'a2', 'A2'),
    B1: await plan('b', 'b1', 'B1'), C1: await plan('c', 'c1', 'C1'),
  };
  const started = [];
  const releases = new Map();
  let running = 0;
  let peak = 0;
  const run = (name, accountId) => runner.runBuild({
    accountId, planId: plans[name].id, runId: `run-${name}`,
    prepareBrief: ({ step }) => step.title,
    specialistsFor: () => [{ id: `model-${name}`, call: async () => {
      started.push(name); running += 1; peak = Math.max(peak, running);
      await new Promise(resolve => releases.set(name, resolve));
      running -= 1;
      return `OK-${name}`;
    } }],
  });
  const promises = [run('A1', 'a'), run('A2', 'a'), run('B1', 'b'), run('C1', 'c')];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['A1', 'B1'], 'another account gets the second slot before the first account gets two');
  assert.equal(runner.status('a', plans.A2.id).run.state, 'queued', 'a waiting build reports queued');
  assert.equal(runner.status('c', plans.C1.id).run.state, 'queued', 'the global third build reports queued');
  assert.ok(peak <= 2, 'at most two builds run at once');

  releases.get('A1')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['A1', 'B1', 'A2'], 'the account returns to the round robin after its first build leaves');
  releases.get('B1')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['A1', 'B1', 'A2', 'C1'], 'the next waiting account receives the free slot');
  releases.get('A2')();
  releases.get('C1')();
  await Promise.all(promises);
  assert.ok(peak <= 2, 'the concurrency ceiling held for the complete run');
}

async function expectMutantCaught(name, work) {
  let outcome = 'STILL PASSES';
  try { await work(); } catch (error) {
    outcome = error instanceof assert.AssertionError ? 'CAUGHT' : `COULD NOT COMPLETE (${error.message})`;
  }
  console.log(`  ${outcome === 'CAUGHT' ? 'ok ' : 'BAD'} ${outcome.padEnd(12)} ${name}`);
  assert.equal(outcome, 'CAUGHT', name);
}

(async () => {
  await vaultScenarios(path.join(ROOT, 'providerKeys.js'));
  await failoverScenarios(path.join(ROOT, 'failover.js'));
  await queueScenarios(path.join(ROOT, 'jobRunner.js'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-multikey-mutants-'));
  const source = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
  try {
    const mutants = [
      ['three-key ceiling', 'providerKeys.js', 'if (!existing.length && live >= MAX_ACTIVE_KEYS)', 'if (false)', vaultScenarios],
      ['labels are independent slots', 'providerKeys.js', "const named = typeof label === 'string' ? label.trim() : null;", "const named = typeof label === 'string' ? 'one-slot' : null;", vaultScenarios, 0],
      ['reader omits ciphertext', 'providerKeys.js', 'SELECT id, provider_id, fingerprint, label, created_at, created_by, last_used_at', 'SELECT id, provider_id, secret_enc, fingerprint, label, created_at, created_by, last_used_at', vaultScenarios],
      ['refused key changes by fingerprint', 'failover.js', 'if (route.keyFingerprint && isKeyRefusal(error) && !keyFailovers.has(key))', 'if (false)', failoverScenarios],
      ['only one alternate key', 'failover.js', ' && !keyFailovers.has(key)', '', failoverScenarios],
      ['two-build box ceiling', 'jobRunner.js', 'while (active < 2 && accountOrder.length)', 'while (active < 3 && accountOrder.length)', queueScenarios],
      ['one active build per account', 'jobRunner.js', 'if (activeAccounts.has(accountId))', 'if (false)', queueScenarios],
      ['queued status is reported', 'jobRunner.js', 'run ? { state: run.state, updatedAt: run.updated_at }', "run ? { state: run.state === 'queued' ? 'running' : run.state, updatedAt: run.updated_at }", queueScenarios],
    ];
    for (const [i, [name, file, find, replace, test, occurrence]] of mutants.entries()) {
      let text = source(file);
      const count = text.split(find).length - 1;
      assert.ok(count > (occurrence || 0), `${name}: mutation target exists`);
      if (occurrence) {
        let seen = 0;
        text = text.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), match => seen++ === occurrence ? replace : match);
      } else {
        text = text.replace(find, () => replace);
      }
      const sub = path.join(dir, `m${i}`);
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, file), text);
      if (file === 'jobRunner.js') fs.copyFileSync(path.join(ROOT, 'supervisor.js'), path.join(sub, 'supervisor.js'));
      await expectMutantCaught(name, () => test(path.join(sub, file)));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('resident multikey tests passed (three labelled keys, key failover, fair build queue; 8 defences caught when removed)');
})().catch(error => { console.error(error); process.exit(1); });
