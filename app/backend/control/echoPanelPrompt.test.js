'use strict';
const assert = require('assert/strict');
const { buildPanelEchoPrompt } = require('./echoPanelPrompt');

const plain = buildPanelEchoPrompt();
assert.match(plain, /cannot run commands or change anything yourself/, 'Echo is told it cannot act on its own');
assert.match(plain, /Never say something has been done/, 'Echo is told never to claim a change it was not told was verified');
assert.match(plain, /Never ask for passwords, API keys or other secrets/, 'Echo is told never to ask for secrets');
assert.doesNotMatch(plain, /waiting for their approval/, 'no proposal is mentioned when none was made');

const staged = buildPanelEchoPrompt({ bridgeLabel: 'Create mailbox sales@example.com' });
assert.match(staged, /Create mailbox sales@example\.com/, 'the prepared proposal is named');
assert.match(staged, /nothing has changed yet/, 'and Echo says nothing has changed');
assert.ok(buildPanelEchoPrompt({ bridgeLabel: 'x'.repeat(5000) }).length < 3000, 'a long label cannot swell the prompt');
console.log('panel Echo prompt tests passed (6)');

// Answering a plain request for a change with a list of screens to click is the
// failure that made the assistant pointless: the person asked for a mailbox and
// was told to go and make one themselves.
{
  const asked = buildPanelEchoPrompt({});
  assert.ok(/Ask for the one piece you need/.test(asked), 'a request it cannot read asks one question');
  assert.ok(/Never answer a plain request for a change with a list of steps to click/.test(asked));
  const filed = buildPanelEchoPrompt({ bridgeLabel: 'Create mailbox info@site1.example.com' });
  assert.ok(/waiting for their approval in Activity/.test(filed), 'a filed proposal is reported as filed');
  assert.ok(/Do not tell them to fill anything in/.test(filed), 'and not handed back as a form to fill');
  console.log('panel Echo prompt: proposes, never hands back instructions');
}
