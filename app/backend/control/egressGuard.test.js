'use strict';

// Audit scenario F2: a conversation holding a name, an address, a client's
// email, a pasted API key and some venting, then a request that only needs a
// database migration. Also: the hosted engine never receives the person's keys.

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createProjectLedger } = require('./projectLedger');
const guard = require('./egressGuard');

const KEY = 'sk-proj-Abc123DEF456ghi789JKL012mno345'; // gitleaks:allow (a fake key the test needs)
const conversation = [
  { role: 'user', content: 'Hi, I am Jane Roe, 14 Rue des Lilas, Lyon. My client Marc wants invoices by email at marc.dupont@client-example.fr.' },
  { role: 'assistant', content: 'Understood. I can help set that up.' },
  { role: 'user', content: `Here is my OpenAI key ${KEY} and the db password: hunter2secret` },
  { role: 'user', content: 'Honestly my colleague Bob is useless and keeps breaking the schema, I am so fed up with him.' },
  { role: 'assistant', content: 'Sorry to hear that. What do you need next?' },
  { role: 'user', content: 'Write the SQLite migration that adds an invoices table with amounts in whole cents.' },
];
const PRIVATE = ['Jane Roe', 'Rue des Lilas', 'marc.dupont@client-example.fr', KEY, 'hunter2secret', 'Bob', 'fed up'];

function project() {
  const ledger = createProjectLedger({ db: new Database(':memory:') });
  const p = ledger.createProject('u1', { name: 'Invoice tracker' }, { actor: 'person:steve' });
  for (const [entity, title, status] of [['decision', 'Storage is SQLite', 'settled'], ['constraint', 'Money is whole cents', 'active']]) {
    const item = ledger.record('u1', p.id, entity, { title }, { actor: 'person:steve' });
    const yes = ledger.approve('u1', item.id, { seenHash: item.hash, approvedBy: 'person:steve' });
    ledger.move('u1', item.id, status, { actor: 'person:steve', approvalId: yes.id });
  }
  ledger.record('u1', p.id, 'requirement', { title: 'Invoices can be emailed' }, { actor: 'person:steve' });
  const { createResidentGateway } = require('./residentGateway');
  return createResidentGateway({ ledger, runId: 'r' }).projectContext({ accountId: 'u1', projectId: p.id });
}

function testPrivacyScenario(prepare) {
  const out = prepare({ role: 'coding', system: 'You are a careful engineer.', messages: conversation, project: project() });
  const sent = JSON.stringify(out.messages);
  for (const needle of PRIVATE) assert.ok(!sent.includes(needle), `${needle} left the box`);
  assert.ok(!guard.holdsSecret(sent), 'no secret matches the scanner');
  assert.doesNotThrow(() => guard.assertClean(out.messages));
  assert.match(sent, /invoices table/);
  assert.match(sent, /Storage is SQLite/);
  assert.match(sent, /Money is whole cents/);
  assert.match(sent, /Project: Invoice tracker/);
  // Overlap with the earlier conversation, by five-word runs: what went out is
  // the request and the project, not the transcript.
  const runs = text => { const w = text.toLowerCase().split(/\W+/).filter(Boolean); return new Set(w.slice(4).map((_, i) => w.slice(i, i + 5).join(' '))); };
  const earlier = runs(conversation.slice(0, -1).map(m => m.content).join(' '));
  const outgoing = runs(sent);
  const shared = [...earlier].filter(run => outgoing.has(run)).length;
  // The one allowed source is the assistant's own previous reply.
  assert.ok(shared / earlier.size < 0.1, `${shared} of ${earlier.size} runs from the earlier conversation went out`);
  assert.deepEqual(Object.keys(out.fields).sort(), ['previous', 'project', 'request', 'requirements', 'rules', 'system']);
}

testPrivacyScenario(guard.prepareOutbound);

// A plain conversation keeps its thread, with secrets removed by value.
const chat = guard.prepareOutbound({ role: 'chat', messages: conversation });
assert.equal(chat.kind, 'conversation');
assert.ok(!JSON.stringify(chat.messages).includes(KEY) && !JSON.stringify(chat.messages).includes('hunter2secret'));
assert.throws(() => guard.assertClean([{ role: 'user', content: `key ${KEY}` }]), { code: 'EGRESS_SECRET' });
for (const secret of ['sk-ant-api03-abcdefghijklmnopqrstuv', 'AKIAIOSFODNN7EXAMPLE', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk_live_abcdefghijklmnop', 'password: correcthorse']) { // gitleaks:allow (a fake key the test needs)
  assert.ok(guard.holdsSecret(secret), secret);
  assert.ok(!guard.holdsSecret(guard.scrubSecrets(secret)), `scrubbed ${secret}`);
}
assert.ok(!guard.holdsSecret('Write the migration for the password reset table'), 'the word password alone is not a secret');
// Providers quote the key back when they refuse it; that line reaches the screen and the logs.
assert.ok(!guard.scrubSecrets(`Incorrect API key provided: ${KEY}. You can find your API key at https://platform.openai.com`).includes(KEY));
assert.ok(!guard.scrubSecrets('Incorrect API key provided: sk-fake12. See docs').includes('sk-fake12'));

// The hosted engine gets the fields it reads and nothing of the person's keys.
const browserBody = { mode: 'echo', task: 'code', messages: conversation, stream: true, maxTokens: 500,
  byok: { openai: { key: KEY } }, override: { code: { providerId: 'openai' } }, system: 'raw', conversationId: 'c1' };
const hosted = JSON.stringify(guard.hostedBody(browserBody, { messages: [{ role: 'user', content: 'brief' }] }));
assert.ok(!hosted.includes(KEY) && !hosted.includes('byok') && !hosted.includes('override'), 'no keys to the engine');
assert.deepEqual(Object.keys(JSON.parse(hosted)).sort(), ['maxTokens', 'messages', 'mode', 'stream']);

// Break tests: bypass each defence and the scenario must fail.
const bypassed = [
  ['the brief (the transcript goes out)', args => ({ messages: args.messages, fields: { system: '', conversation: args.messages } })],
  ['secret removal', args => { const real = guard.prepareOutbound(args); return { ...real, messages: [...real.messages, { role: 'user', content: `${args.messages[2].content}` }] }; }],
];
for (const [name, broken] of bypassed) {
  assert.throws(() => testPrivacyScenario(broken), assert.AssertionError, `bypassing ${name} must fail the scenario`);
}
assert.throws(() => assert.ok(!JSON.stringify(browserBody).includes(KEY)), assert.AssertionError, 'forwarding the raw body must fail the key check');
console.log('egress guard tests passed (F2 scenario, 2 break tests caught, hosted body carries no keys)');
