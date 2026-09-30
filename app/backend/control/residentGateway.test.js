'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createProjectLedger } = require('./projectLedger');
const { createResidentGateway, interpret, candidatesFor, ROLE_ROUTES } = require('./residentGateway');

// The server decides the work; the browser's task is only a hint.
assert.equal(interpret({ text: 'fix the bug in this javascript function', taskHint: 'chat' }).role, 'coding');
assert.equal(interpret({ text: 'design a logo and a colour palette', taskHint: 'code' }).role, 'design');
assert.equal(interpret({ text: 'research the latest competitors' }).role, 'research');
assert.equal(interpret({ text: 'summarise this email' }).role, 'mechanical');
assert.equal(interpret({ text: 'should we raise prices?' }).role, 'reasoning');
assert.equal(interpret({ text: 'hello there', taskHint: 'summarize' }).role, 'mechanical');
assert.equal(interpret({ text: 'hello there', taskHint: 'admin-everything' }).role, 'chat', 'an unknown hint is ignored');
assert.equal(interpret({ text: 'hello there', mode: 'build' }).role, 'coding');

// Decision 3 defaults, overridable by the host's table by task or by role.
assert.equal(candidatesFor('creative')[0][0], 'openai');
assert.equal(candidatesFor('code')[0][0], 'anthropic');
assert.equal(candidatesFor('research')[0][0], 'gemini');
assert.deepEqual(candidatesFor('code', { coding: [['mistral', 'codestral']] }), [['mistral', 'codestral']]);
assert.deepEqual(candidatesFor('code', { code: [['groq', 'x']], coding: [['mistral', 'y']] }), [['groq', 'x']]);
assert.equal(candidatesFor('nonsense'), ROLE_ROUTES.chat);

// A turn: General project on first use, conversation bound, record in flight
// before the call with only hashes of what was sent, then finished.
(async () => {
const db = new Database(':memory:');
const ledger = createProjectLedger({ db });
const gateway = createResidentGateway({ ledger, runId: 'run-1' });
const turn = await gateway.open('u1', { conversationId: 'chat-1', mode: 'echo', text: 'refactor this python code' });
assert.equal(turn.role, 'coding');
assert.equal(ledger.contextFor('u1', 'chat-1').project.name, 'General');
assert.equal((await gateway.open('u1', { conversationId: 'chat-2', text: 'hi' })).projectId, turn.projectId, 'one General project per account');
const id = gateway.dispatch(turn, { providerId: 'anthropic', model: 'claude-sonnet-5', source: 'platform' }, { sent: { messages: [{ role: 'user', content: 'secret words' }] } });
const inFlight = ledger.get('u1', id);
assert.equal(inFlight.status, 'in_flight');
assert.equal(inFlight.route.role, 'coding');
assert.ok(!JSON.stringify(db.prepare('SELECT * FROM ledger_events').all()).includes('secret words'));
assert.equal(gateway.finish(turn, id, { error: 'HTTP 401' }).status, 'failed');
const explicit = gateway.dispatch(turn, { providerId: 'openai', model: 'gpt-4o-mini' }, { explicit: true });
assert.equal(ledger.get('u1', explicit).route.reason, 'the person chose this model');
assert.ok(ledger.verify().ok);

// The model step: used when it answers in time and in shape, and the rules
// otherwise, with the log saying which.
const { createUnderstanding } = require('./residentGateway');
const said = reply => createUnderstanding({ callModel: async () => reply, budgetMs: 200 });
const text = 'my homepage looks dated, freshen it up';
assert.equal((await said('{"role":"design","state":"neutral","confidence":0.9}')({ text })).how, 'model');
assert.equal((await said('{"role":"design","state":"neutral","confidence":0.9}')({ text })).role, 'design');
for (const junk of ['sure! it is design', '{"role":"admin","confidence":1}', '{"role":"design|reasoning","confidence":0.8}', '{"role":"design","confidence":7}', '{"role":"design"']) {
  const read = await said(junk)({ text, taskHint: 'chat' });
  assert.equal(read.how, 'rules (model output unreadable)', junk);
  assert.equal(read.role, 'chat', junk);
}
const failing = await createUnderstanding({ callModel: async () => { throw new Error('ollama down'); }, budgetMs: 200 })({ text });
assert.equal(failing.how, 'rules (model failed)');
const started = Date.now();
const slow = await createUnderstanding({ callModel: () => new Promise(r => setTimeout(() => r('{"role":"design","state":"neutral","confidence":1}'), 2000)), budgetMs: 150 })({ text });
assert.equal(slow.how, 'rules (over budget)');
assert.ok(Date.now() - started < 600, 'the answer is never held past the budget');
// A machine too slow for the model: after three misses in a row the turn goes
// straight to the rules, with no wait, until the rest is over.
{
  let clock = 0; let asked = 0;
  const slowModel = createUnderstanding({ budgetMs: 30, slowLimit: 3, restMs: 1000, now: () => clock,
    callModel: () => { asked += 1; return new Promise(r => setTimeout(() => r('{"role":"design","confidence":1}'), 200)); } });
  for (const n of [1, 2, 3]) assert.equal((await slowModel({ text: `slow ${n}` })).how, 'rules (over budget)');
  const before = Date.now();
  const resting = await slowModel({ text: 'slow 4' });
  assert.equal(resting.how, 'rules (model too slow on this machine)');
  assert.ok(Date.now() - before < 20, 'no wait while resting');
  assert.equal(asked, 3, 'the model is not asked while resting');
  clock = 2000;
  assert.equal((await slowModel({ text: 'slow 5' })).how, 'rules (over budget)', 'tried again after the rest');
  assert.equal(asked, 4);
}
let calls = 0;
const counted = createUnderstanding({ callModel: async () => { calls += 1; return '{"role":"design","state":"neutral","confidence":0.9}'; } });
await counted({ text }); await counted({ text });
assert.equal(calls, 1, 'the same words are read once');
assert.equal((await said('{"role":"chat","state":"curious","confidence":0.9}')({ text: 'this is useless, still broken!!' })).state, 'frustrated', 'state comes from the words');
// The rules are the floor every turn keeps when no model answers. Measured on
// the labelled set so a regression shows; the local model's score is measured
// by residentGateway.score.js against a running Ollama.
const labels = require('./residentGateway.labels.json');
const plain = createUnderstanding();
let roles = 0, states = 0;
for (const label of labels) {
  const read = await plain({ text: label.text });
  if (read.role === label.role) roles += 1;
  if (read.state === label.state) states += 1;
}
assert.ok(roles / labels.length >= 0.4, `rules read ${roles}/${labels.length} roles`);
assert.ok(states / labels.length >= 0.55, `rules read ${states}/${labels.length} states`);
console.log('resident gateway tests passed');
})().catch(error => { console.error(error); process.exit(1); });
