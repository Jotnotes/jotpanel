'use strict';

// Voice must stay the customer's own. Nothing about it may be shared between
// tenants, and that is a tenancy decision rather than a performance one.
//
// THE DECISION BEING ENFORCED, from docs/NAVIGATOR_TENANCY.md: "Voice is never
// run on a shared host GPU." The supported routes are the customer's own
// device, their own GPU or voice-service key, or their own whole server. A
// shared voice backend would mean one tenant's words reaching hardware another
// tenant also uses, which is the exact breach the one-Navigator-per-VM
// architecture exists to make impossible.
//
// `listeningChain.test.js` already proves the ORDER of the chain. What this
// adds is the ISOLATION property, and one honest negative: the "own device"
// route does not exist yet, and a test is the right place to say so, because
// the alternative is a reader assuming BYOG already carries audio.
//
// Read from the source rather than over HTTP, in the style of
// listeningChain.test.js: the assertion is about what the code can possibly
// reach, and a running server would only show one configuration of it.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
const byog = fs.readFileSync(path.join(BACKEND, 'control', 'byog.js'), 'utf8');

let passed = 0;
const check = (what, fn) => { fn(); passed++; console.log(`  ok   ${what}`); };

console.log('\nvoice tenancy: the customer\'s own, or nobody\'s\n');

console.log('1. the engine this guest speaks and listens with is its own');
check('the voice service is reached on loopback, so it cannot be a shared host', () => {
  const line = server.split('\n').find(l => /const TTS_BASE\s*=/.test(l));
  assert.ok(line, 'TTS_BASE is not defined any more; this test needs rewriting');
  assert.match(line, /127\.0\.0\.1|localhost/,
    `TTS_BASE points somewhere other than this machine: ${line.trim()}`);
});
check('and its address is not taken from a request or a tenant row', () => {
  const line = server.split('\n').find(l => /const TTS_BASE\s*=/.test(l));
  assert.ok(!/req\.|tenant|account|org/i.test(line), line.trim());
});

console.log('\n2. no shared voice backend is configurable by accident');
check('there is no environment switch pointing voice at another machine', () => {
  // A variable like JOTPANEL_SHARED_TTS would be the shape of the mistake.
  const shared = server.match(/[A-Z_]*(SHARED|POOL|CLUSTER)[A-Z_]*(TTS|VOICE|STT|GPU)[A-Z_]*/g) || [];
  assert.equal(shared.length, 0, `found ${JSON.stringify(shared)}`);
});
check('and the local engine is firewalled rather than exposed', () => {
  const install = fs.readFileSync(path.join(BACKEND, '..', 'deploy', 'install.sh'), 'utf8');
  assert.match(install, /ufw deny 11434/,
    'the local model port is not denied, so a pooled host could reach another guest\'s engine');
});

console.log('\n3. the fallbacks are the person\'s own keys, not the hoster\'s');
check('the ear falls back to keys the account holds, named one by one', () => {
  const chain = server.slice(server.indexOf('function sttFallbacks'));
  for (const held of ['held.openai', 'held.elevenlabs', 'held.deepgram']) {
    assert.ok(chain.indexOf(held) > 0 && chain.indexOf(held) < chain.indexOf('function', 10),
      `${held} is not in the chain`);
  }
});

console.log('\n4. the honest negative: voice on the customer\'s OWN DEVICE is NOT built');
// Said as a test rather than only in a document, because the tenancy doc lists
// the customer's own device as a supported route and the protocol cannot carry
// it. Until BYOG audio lands, a pooled customer's only off-box option is their
// own voice-service key.
check('the BYOG job protocol carries a model and messages and no audio', () => {
  assert.ok(/payload\.messages/.test(byog), 'the protocol no longer carries messages; this test needs rewriting');
  const audio = byog.match(/\b(audio|waveform|pcm|wav|mp3|transcribe|speech)\b/gi) || [];
  assert.equal(audio.length, 0,
    `byog.js now mentions ${JSON.stringify([...new Set(audio)])}. If BYOG audio has been built, `
    + 'invert this test and stop NAVIGATOR_TENANCY.md calling the device route unbuilt.');
});

console.log(`\n${passed} passed\n`);
