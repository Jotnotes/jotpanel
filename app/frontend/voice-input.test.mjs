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
