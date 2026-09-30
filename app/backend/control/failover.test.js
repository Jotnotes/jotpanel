'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fail = status => Object.assign(new Error(`HTTP ${status}`), status ? { status } : {});
const A = { providerId: 'openai', model: 'gpt-4o' };
const B = { providerId: 'anthropic', model: 'claude-sonnet-5' };

// An expected answer that fails is a failed assertion, not a crash.
const answered = async promise => { try { return await promise; } catch (error) { assert.fail(`expected an answer, got: ${error.message}`); } };

async function scenarios(f) {
  const noSleep = async () => {};
  // 429 once: retried on the same provider, answered there.
  let calls = [];
  let r = await answered(f.runWithFailover({ first: A, sleep: noSleep, next: () => B, run: async route => { calls.push(route.providerId); if (calls.length === 1) throw fail(429); return 'ok'; } }));
  assert.deepEqual(calls, ['openai', 'openai'], 'a 429 is retried on the same provider');
  assert.equal(r.route, A);
  // 500 twice: retried once, then the next provider answers.
  calls = [];
  r = await answered(f.runWithFailover({ first: A, sleep: noSleep, next: route => (route === A ? B : null), run: async route => { calls.push(route.providerId); if (route === A) throw fail(500); return 'ok'; } }));
  assert.deepEqual(calls, ['openai', 'openai', 'anthropic'], 'an outage fails over after one retry');
  assert.equal(r.failures.length, 2);
  // Timeout or network error (no status) counts as transient.
  calls = [];
  await answered(f.runWithFailover({ first: A, sleep: noSleep, next: () => B, run: async route => { calls.push(route.providerId); if (calls.length < 3) throw fail(0); return 'ok'; } }));
  assert.deepEqual(calls, ['openai', 'openai', 'anthropic'], 'a timeout is retried, then fails over');
  // A refused key is not retried; it moves on.
  calls = [];
  await answered(f.runWithFailover({ first: A, sleep: noSleep, next: () => B, run: async route => { calls.push(route.providerId); if (route === A) throw fail(401); return 'ok'; } }));
  assert.deepEqual(calls, ['openai', 'anthropic'], 'a refused key moves on without a retry');
  // Tokens already on screen: no failover, the error is shown.
  let shown = 0;
  calls = [];
  await assert.rejects(f.runWithFailover({ first: A, sleep: noSleep, emitted: () => shown, next: () => B, run: async route => { calls.push(route.providerId); shown = 5; throw fail(500); } }), /HTTP 500/, 'after the first token the error is shown');
  assert.deepEqual(calls, ['openai'], 'nothing is stitched onto a half-shown answer');
  // A next() that keeps offering a provider that already failed does not loop.
  calls = [];
  await assert.rejects(f.runWithFailover({ first: A, sleep: noSleep, next: () => B, run: async route => { calls.push(route.providerId); throw fail(401); } }), /HTTP 401/);
  assert.deepEqual(calls, ['openai', 'anthropic'], 'a failed provider is not tried again');
  // Nothing left: the last error, with the record of what was tried.
  await assert.rejects(f.runWithFailover({ first: A, sleep: noSleep, next: () => null, run: async () => { throw fail(503); } }), error => error.failures.length === 2);
}

(async () => {
  const f = require('./failover');
  await scenarios(f);
  const source = fs.readFileSync(path.join(__dirname, 'failover.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-mutants-'));
  const mutants = [
    ['no stitching after the first token', 'if (emitted() > 0 || aborted())', 'if (aborted())'],
    ['retry a busy provider', "if (isTransient(error) && route.providerId !== 'byog' && !retried.has(key))", 'if (false)'],
    ['fail over to the next provider', 'const following = next(route, error, failures);', 'const following = null;'],
    ['a refused key is not retried', 'return !status || status === 408', 'return true || status === 408'],
    ['never back to a failed provider', 'if (!following || again || failures.length >= 8)', 'if (!following || failures.length >= 8)'],
  ];
  try {
    for (const [i, [name, find, replace]] of mutants.entries()) {
      assert.equal(source.split(find).length - 1, 1, name);
      const file = path.join(dir, `m${i}.js`);
      fs.writeFileSync(file, source.replace(find, () => replace));
      let outcome = 'STILL PASSES';
      try { await scenarios(require(file)); } catch (error) { outcome = error instanceof assert.AssertionError ? 'CAUGHT' : `COULD NOT COMPLETE (${error.message})`; }
      console.log(`  ${outcome === 'CAUGHT' ? 'ok ' : 'BAD'} ${outcome.padEnd(12)} ${name}`);
      assert.equal(outcome, 'CAUGHT', name);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('failover tests passed (429, outage, timeout, refused key, no stitching, nothing left; 5 defences caught when removed)');
})().catch(error => { console.error(error); process.exit(1); });
