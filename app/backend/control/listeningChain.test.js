'use strict';

// The ear has the same chain the voice has.
//
// The voice has had three steps since it was written: local Kokoro, then the
// hosted engine under licence, then the person's own ElevenLabs key. The ear had
// one, and answered 503 when the box could not hear. That is the common case and
// not the rare one: a guest sized so twenty fit on a machine has one core, and a
// person on a public terminal has no machine of their own to fall back to.
//
// Proved against the source rather than over HTTP, because the thing being
// asserted is the shape of the chain and the order of it, and standing a whole
// server up to read an order is a slower way to learn the same fact.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server.js');
const source = fs.readFileSync(SERVER, 'utf8');

// ── The chain exists, and in the right order ─────────────────────────────────
{
  const chain = source.slice(source.indexOf('function sttFallbacks'), source.indexOf('function sttFallbacks') + 3000);
  const at = name => chain.indexOf(name);
  assert.ok(at('held.openai') > 0, 'an OpenAI key is not an ear');
  assert.ok(at('held.elevenlabs') > 0, 'an ElevenLabs key is not an ear');
  assert.ok(at('held.deepgram') > 0, 'a Deepgram key is not an ear');

  // Local Whisper is tried before any key, because it is free and the words do
  // not leave the machine. The keys are only reached from the catch.
  const route = source.slice(source.indexOf("app.post('/api/ai/transcribe'"), source.indexOf('function sttFallbacks'));
  assert.ok(route.indexOf('TTS_BASE') < route.indexOf('sttFallbacks'),
    'a paid ear is tried before the free one on this machine');
  assert.ok(route.includes('catch'), 'the fallbacks are not behind a failure of the local ear');
  assert.ok(route.includes("heard: 'this server'"), 'a local transcription does not say where it was heard');
  assert.ok(route.includes('heard: attempt.name'), 'a fallback transcription does not say which ear heard it');
  console.log('  chain: local Whisper first, then the keys the person holds');
}

// ── The browser's own speech recognition is never used ───────────────────────
{
  // Chrome and Safari ship the audio to the browser vendor, and they are worse
  // at unusual words than the model they would replace. Steve's instruction and
  // the measurement on the test box agree on this.
  for (const file of ['arca-webos.jsx', 'control-panel.jsx', 'panel.jsx']) {
    const front = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', file), 'utf8');
    assert.ok(!/\bwebkitSpeechRecognition\b|\bSpeechRecognition\b/.test(front),
      `${file} uses the browser's own speech recognition`);
  }
  assert.ok(!/webkitSpeechRecognition|[^.]\bSpeechRecognition\b/.test(source),
    "the server reaches for the browser's own speech recognition");
  console.log('  nothing uses the browser vendor\'s speech recognition');
}

// ── A box with no Whisper still offers the microphone ────────────────────────
{
  const fn = source.slice(source.indexOf('async function canListen'), source.indexOf('async function listeningSource'));
  assert.ok(fn.includes('userId'), 'canListen cannot tell which person is asking');
  assert.ok(fn.includes('sttFallbacks'), 'canListen does not count a key as an ear');
  assert.ok(fn.includes('if (listeningProbe.ok) return true;'), 'the local ear no longer wins first');
  // The whole point: a hidden microphone is a fallback that can never be
  // reached, so the state route has to be asked per person.
  assert.ok(source.includes('listening: await canListen(req.user.id)'),
    'the state route asks whether the box can hear without saying who for');
  assert.ok(source.includes('listeningSource: await listeningSource(req.user.id)'),
    'nothing tells the screen which ear would answer');
  console.log('  a box with no Whisper still offers the microphone, and says which ear it would use');
}

// ── A voice-only provider can hold a key ─────────────────────────────────────
{
  assert.match(source, /VOICE_ONLY_PROVIDERS = new Set\(\['elevenlabs', 'deepgram'\]\)/,
    'the voice-only providers are not named in one place');
  const fn = source.slice(source.indexOf('function keyableProvider'), source.indexOf('function keyableProvider') + 400);
  assert.ok(fn.includes('VOICE_ONLY_PROVIDERS.has(id)'),
    'a Deepgram key cannot be saved, so that ear can never be reached');
  console.log('  elevenlabs and deepgram can hold a key though they answer no chat');
}

// ── Every defence removed in turn must fail a named check ────────────────────
{
  const { spawnSync } = require('child_process');
  const os = require('os');
  const sabotage = [
    ['the keys tried before the free local ear', "    const held = hostAllowsByok() ? storedByok(req.user.id) : {};\n    for (const attempt of sttFallbacks(held))", '    const held = {};\n    for (const attempt of sttFallbacks(held))'],
    ['a microphone hidden on a box with no Whisper', '  if (!userId) return false;\n  try { return sttFallbacks(', '  if (!userId) return false;\n  try { return ![].concat('],
    ['a Deepgram key that cannot be saved', "  if (VOICE_ONLY_PROVIDERS.has(id)) return id;", "  if (id === 'elevenlabs') return id;"],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ear-break-'));
  for (const [what, from, to] of sabotage) {
    assert.ok(source.includes(from), `${what}: the line to remove is gone (${from.slice(0, 50)})`);
    const broken = path.join(tmp, 'server.js');
    fs.writeFileSync(broken, source.replace(from, to));
    const probe = path.join(tmp, 'probe.js');
    fs.writeFileSync(probe, fs.readFileSync(__filename, 'utf8')
      .replace("const SERVER = path.join(__dirname, '..', 'server.js');", `const SERVER = ${JSON.stringify(broken)};`)
      .replace(/\n\/\/ ── Every defence removed[\s\S]*$/, '\n'));
    const run = spawnSync(process.execPath, [probe], { cwd: __dirname, encoding: 'utf8' });
    assert.notEqual(run.status, 0, `${what}: removed it and every check still passed`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  break tests: ${sabotage.length} defences removed, each one failed a check`);
}

console.log('listening chain tests passed');
