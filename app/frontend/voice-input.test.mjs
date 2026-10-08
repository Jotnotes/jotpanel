// The ear's browser half: the recording must go to this panel and nowhere else,
// the microphone must always be released, and a box without Whisper must say so
// in a sentence rather than fail silently.
import assert from "node:assert";
import { audioBlobToWav16k, transcribeAudio, transcribeEndpoint, voiceInputSupported, serverCanListen, startRecording } from "./voice-input.js";

global.window = { location: { origin: "https://panel.example.com" } };
const nav = { mediaDevices: null };
Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });

assert.equal(transcribeEndpoint(), "https://panel.example.com/api/ai/transcribe",
  "the audio goes to this panel's own address");

let seen = null;
const fakeWav = async () => new Blob(["wav"]);
const ok = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ text: "create a mailbox for sales@example.com" }) }; };
const text = await transcribeAudio(new Blob(["raw"]), { fetchImpl: ok, toWav: fakeWav });
assert.equal(text, "create a mailbox for sales@example.com");
assert.equal(seen.url, "https://panel.example.com/api/ai/transcribe");
assert.equal(seen.init.headers["Content-Type"], "audio/wav");
assert.ok(!/speech|google|apple|azure|openai/i.test(seen.url), "no third-party recogniser is ever called");

const failing = async () => ({ ok: false, json: async () => ({ error: "Echo listening is not available" }) });
await assert.rejects(() => transcribeAudio(new Blob(["raw"]), { fetchImpl: failing, toWav: fakeWav }),
  /Echo listening is not available/, "a box without Whisper answers in a sentence");

assert.equal(voiceInputSupported(), false, "a browser with no MediaRecorder is told it cannot talk");

// A box without the speech service installed offers no microphone at all.
const meta = body => async () => ({ ok: true, json: async () => body });
global.fetch = meta({ listening: true });
assert.equal(await serverCanListen(), true, "a box with the ear installed offers the microphone");
global.fetch = meta({ listening: false });
assert.equal(await serverCanListen(), false, "a box without it does not");
global.fetch = meta({});
assert.equal(await serverCanListen(), false, "a panel too old to answer does not");
global.fetch = async () => ({ ok: false, json: async () => ({}) });
assert.equal(await serverCanListen(), false, "a refused question does not");

// The microphone is released even when transcription fails.
let stopped = 0;
const track = { stop: () => { stopped += 1; } };
nav.mediaDevices = { getUserMedia: async () => ({ getTracks: () => [track] }) };
class FakeRecorder {
  constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; }
  start() { this.state = "recording"; setTimeout(() => this.stop(), 0); }
  stop() { this.state = "inactive"; this.onstop?.(); }
}
global.window.MediaRecorder = FakeRecorder;
global.MediaRecorder = FakeRecorder;
global.Blob = Blob;
// Whatever fails downstream — no Whisper on the box, no audio decoder in this
// stub — the recorder must still hand the microphone back.
global.fetch = async () => { throw new Error("no whisper on this box"); };
await assert.rejects(() => startRecording().done);
assert.equal(stopped, 1, "the microphone is released when a recording fails");

console.log("voice input checks passed — this panel's own ear, released microphone, honest failure");

// ── The microphone does not hear Echo talking ────────────────────────────────
//
// Echo speaks through the same speakers the microphone sits in front of, so a
// raw stream means the ear transcribes Echo's own voice as though somebody had
// said it. Dictating to something that talks back is the normal way this is
// used, so this is the normal case rather than an edge.
{
  const { MIC_CONSTRAINTS } = await import('./voice-input.js');
  assert.equal(MIC_CONSTRAINTS.audio.echoCancellation, true, 'the microphone would hear Echo itself');
  assert.equal(MIC_CONSTRAINTS.audio.noiseSuppression, true, 'the room is not taken out of the recording');
  assert.equal(MIC_CONSTRAINTS.audio.autoGainControl, true, 'somebody leaning back goes quiet');

  // Both shells open their own microphone, so both have to ask the same thing.
  const fs = await import('node:fs');
  for (const file of ['voice-input.js', 'arca-webos.jsx']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!/getUserMedia\(\s*\{\s*audio:\s*true\s*\}/.test(src),
      `${file} asks for a raw microphone, so it will hear Echo`);
    assert.ok(src.includes('MIC_CONSTRAINTS'), `${file} does not use the shared microphone constraints`);
  }
  console.log('microphone checks passed — cancellation on, both shells ask the same');
}
