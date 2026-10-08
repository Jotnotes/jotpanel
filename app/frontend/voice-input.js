// The ear, in the browser half. Recording is decoded to 16kHz mono 16-bit WAV
// here so the server needs no audio tooling, and the WAV goes to this panel's
// own /api/ai/transcribe.
//
// Nothing in the browser ever recognises speech: no browser speech API, so the
// audio is never handed to Chrome's or Safari's own service. Where it goes after
// the panel is the panel's decision and the person's: Whisper on the box first,
// and otherwise an ear they hold a key for, which the reply names.
//
// Lifted from the desktop shell, which has carried it since Brilliant. The one
// difference worth stating: there, speech is a conversation and a finished
// recording sends itself. Here the text lands in the box and waits, because
// server administration is full of strings speech-to-text mangles — a domain,
// a mailbox, a DKIM record — and reading it before sending costs one glance.


import { readPanelStorage } from "./panel-storage.js";

// What the microphone is asked for, in one place, because the desktop and the
// panel each open their own and a difference between them is a bug nobody sees
// until a room echoes.
//
// Echo speaks out loud through the same speakers this microphone is sitting in
// front of. Asked for bare `{ audio: true }`, the browser is free to hand back a
// raw stream, and the ear then hears Echo's own voice and transcribes it as
// though somebody had said it. Dictating to something that is talking back is
// the normal way this feature is used, so this is the normal case.
//
// Echo cancellation subtracts what is being played from what is heard. Noise
// suppression takes out the room. Automatic gain keeps a person who leans back
// from going quiet. All three are things the browser already knows how to do and
// will not do unless asked.
export const MIC_CONSTRAINTS = Object.freeze({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
});

export async function audioBlobToWav16k(blob) {
  const raw = await blob.arrayBuffer();
  const probe = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await probe.decodeAudioData(raw);
  probe.close();
  const frames = Math.ceil(decoded.duration * 16000);
  const off = new OfflineAudioContext(1, frames, 16000);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const mono = (await off.startRendering()).getChannelData(0);
  const buf = new ArrayBuffer(44 + mono.length * 2);
  const v = new DataView(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF"); v.setUint32(4, 36 + mono.length * 2, true); wstr(8, "WAVE");
  wstr(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wstr(36, "data"); v.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) { const s = Math.max(-1, Math.min(1, mono[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: "audio/wav" });
}

// The address is this panel's own, built the same way every other call in the
// shell builds it. It is never taken from the recording, the page or a reply,
// so there is no path by which audio could be posted somewhere else.
export function transcribeEndpoint() {
  const server = (typeof localStorage !== "undefined" && readPanelStorage("server")) || window.location.origin;
  return `${String(server).replace(/\/$/, "")}/api/ai/transcribe`;
}

export async function transcribeAudio(blob, { fetchImpl = fetch, toWav = audioBlobToWav16k } = {}) {
  const jwt = (typeof localStorage !== "undefined" && readPanelStorage("jwt")) || "";
  const wav = await toWav(blob);
  const res = await fetchImpl(transcribeEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "audio/wav", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) },
    body: wav,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Echo listening is not available");
  return data.text || "";
}

// A box only hears if the speech service is installed, which is optional, so
// the panel asks before offering a microphone at all. A button that can only
// fail is worse than no button.
export async function serverCanListen() {
  try {
    const jwt = (typeof localStorage !== "undefined" && readPanelStorage("jwt")) || "";
    const server = (typeof localStorage !== "undefined" && readPanelStorage("server")) || window.location.origin;
    const res = await fetch(`${String(server).replace(/\/$/, "")}/api/ai/meta`, {
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
    });
    if (!res.ok) return false;
    return (await res.json())?.listening === true;
  } catch { return false; }
}

export function voiceInputSupported() {
  return typeof window !== "undefined"
    && typeof window.MediaRecorder !== "undefined"
    && !!navigator?.mediaDevices?.getUserMedia
    && !!(window.AudioContext || window.webkitAudioContext);
}

// One recording, from the microphone to text. The caller gets a stop handle and
// a promise; every path releases the microphone, including the failing ones,
// because a recorder left running is a live microphone the person cannot see.
export function startRecording({ onLevels } = {}) {
  let stop = () => {};
  const done = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = event => event.data.size && chunks.push(event.data);
    let actx = null, frame = null;
    if (onLevels) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 32;
      actx.createMediaStreamSource(stream).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => { analyser.getByteFrequencyData(bins); onLevels([0,1,2,3,4].map(i => bins[i] / 255)); frame = requestAnimationFrame(tick); };
      tick();
    }
    const release = () => {
      if (frame) cancelAnimationFrame(frame);
      if (actx) actx.close();
      if (onLevels) onLevels([0,0,0,0,0]);
      stream.getTracks().forEach(track => track.stop());
    };
    stop = () => { if (recorder.state !== "inactive") recorder.stop(); };
    try {
      const blob = await new Promise((resolve, reject) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
        recorder.onerror = event => reject(event.error || new Error("Recording failed"));
        recorder.start();
      });
      return await transcribeAudio(blob);
    } finally { release(); }
  })();
  return { stop: () => stop(), done };
}
