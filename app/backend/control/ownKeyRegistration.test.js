'use strict';

// Registration is a condition of using OUR service, not of using the panel.
//
// The chat route used to call the licence before the fork that decides who
// answers, so a customer whose own Anthropic key sat in their own vault, on
// their own box, was refused until they had registered with JotNotes. The
// installer's first page says "The panel installs and works without
// registration", and the one feature people came for did not honour it.
// Steve settled it on 2026-09-25: own-key Echo works unregistered.
//
// The rule these hold: the gate follows the thinking URL. No URL means the
// panel answers from its own prompt with the person's own key and nobody is
// asked to register. A URL means the request leaves for our service, and there
// the licence still decides.

const test = require('node:test');
const assert = require('node:assert');

const { createThinkingGate, usesHostedThinking } = require('./thinkingGate');

// The real gate, not a copy of it: these fail if server.js's rule regresses.
function makeGate(env, licence) {
  return createThinkingGate({ licenseClient: { thinkingAccess: licence }, env });
}

const REFUSED = async () => ({ allowed: false, status: 'unregistered', reason: 'Register this panel to connect the assistant.' });
const ALLOWED = async () => ({ allowed: true, status: 'active', registered: true });

test('an unregistered panel with no hosted service answers on the customer own key', async () => {
  const verdict = await makeGate({}, REFUSED)();
  assert.strictEqual(verdict.allowed, true, 'nobody is asked to register to use their own key');
  assert.strictEqual(verdict.registered, false, 'and the panel does not pretend to be registered');
});

test('the legacy ARCA_ thinking url still counts as hosted', async () => {
  const verdict = await makeGate({ ARCA_THINKING_URL: 'https://engine.example/v1' }, REFUSED)();
  assert.strictEqual(verdict.allowed, false, 'the old setting name is still a hosted deployment');
});

test('a hosted panel that is not registered is still refused', async () => {
  const verdict = await makeGate({ JOTPANEL_THINKING_URL: 'https://engine.example/v1' }, REFUSED)();
  assert.strictEqual(verdict.allowed, false, 'our service is still ours to license');
  assert.match(verdict.reason, /Register this panel/);
});

test('a hosted panel that is registered is allowed, and the licence still decides', async () => {
  const verdict = await makeGate({ JOTPANEL_THINKING_URL: 'https://engine.example/v1' }, ALLOWED)();
  assert.strictEqual(verdict.allowed, true);
  assert.strictEqual(verdict.status, 'active', 'the answer comes from the licence, not from this shortcut');
});

test('an empty thinking url is not a hosted deployment', async () => {
  assert.strictEqual((await makeGate({ JOTPANEL_THINKING_URL: '' }, REFUSED)()).allowed, true);
});

test('the fork itself, stated plainly', () => {
  assert.strictEqual(usesHostedThinking({}), false);
  assert.strictEqual(usesHostedThinking({ JOTPANEL_THINKING_URL: 'https://engine.example' }), true);
  assert.strictEqual(usesHostedThinking({ ARCA_THINKING_URL: 'https://engine.example' }), true);
});
