#!/usr/bin/env python3
"""Arca Resident voice and ear — local Kokoro TTS + Whisper STT service.

Runs on 127.0.0.1 only. Endpoints:
  POST /speak       JSON {"text": "...", "voice": "af_heart", "speed": 1.0} → audio/wav
  POST /transcribe  body = 16kHz mono 16-bit WAV → JSON {"text": "..."}
  GET  /health      → 200 when the models are ready

Started by the Arca backend (server.js) or by hand:

    ./venv/bin/python tts_server.py        # listens on 127.0.0.1:9998

STT backend: mlx-whisper on Apple Silicon (this box). On a Linux VPS install
faster-whisper into the venv instead; both are tried in that order.

Fresh box? Run ./setup.sh — it builds the venv, installs the pinned stack
(platform-aware STT pick), downloads the two model files if missing and
self-checks by synthesizing a clip. Idempotent, touches only this directory.
"""
import io
import json
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))

# Where the voice's *state* lives: the venv and the model weights.
#
# These used to sit beside this file, inside the application tree, and an
# upgrade replaces that tree wholesale — so every upgrade silently destroyed a
# customer's installed voice and asked them to download 337 MB again. Proved on
# the test box on 2026-09-25.
#
# The weights are state, this file is code. State goes next to the database,
# where the upgrade does not reach: <install>/data/tts. The layout is derived
# from this file's own position (…/app/backend/tts → …/data/tts) so nothing has
# to be configured, and JOTPANEL_TTS_STATE overrides it for a dev checkout.
def _state_dir():
    override = os.environ.get("JOTPANEL_TTS_STATE")
    if override:
        return override
    install = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
    candidate = os.path.join(install, "data", "tts")
    # A dev checkout has no data directory beside the app; the models sit here.
    return candidate if os.path.isdir(candidate) else HERE

STATE = _state_dir()
# 9997, not 9998: the panel's own admin listener owns 9998 on the loopback, and
# a speech service that binds it either fails to start or shadows the panel's
# bootstrap routes. The backend looks for this service on 9997.
PORT = int(os.environ.get("JOTPANEL_TTS_PORT", os.environ.get("ARCA_TTS_PORT", "9997")))
DEFAULT_VOICE = os.environ.get("ARCA_TTS_VOICE", "af_heart")
STT_MODEL = os.environ.get("ARCA_STT_MODEL", "mlx-community/whisper-base-mlx")

print("[tts] loading Kokoro model...", flush=True)
kokoro = Kokoro(os.path.join(STATE, "kokoro-v1.0.onnx"), os.path.join(STATE, "voices-v1.0.bin"))
print("[tts] model loaded", flush=True)

# Speech to text — mlx-whisper (Apple Silicon) first, faster-whisper second.
_stt = None
try:
    import mlx_whisper as _mlxw

    def _stt(audio):  # noqa: F811 — deliberate rebind to the available backend
        return _mlxw.transcribe(audio, path_or_hf_repo=STT_MODEL)["text"].strip()
    print(f"[stt] mlx-whisper ready ({STT_MODEL})", flush=True)
except ImportError:
    try:
        from faster_whisper import WhisperModel as _FW
        # A control panel runs on the smallest box a person will pay for, which
        # is often one core. Left on its defaults this took most of a minute to
        # hear one sentence, which is not a feature anybody uses twice.
        #
        # `tiny` on a single core, `base` where there is more than one, both
        # int8, and every thread the box has. Override with JOTPANEL_STT_MODEL.
        _cores = os.cpu_count() or 1
        _stt_model = os.environ.get("JOTPANEL_STT_MODEL", os.environ.get("ARCA_STT_MODEL")) or ("tiny" if _cores < 2 else "base")
        _fw_model = _FW(_stt_model, compute_type="int8", cpu_threads=_cores)
        # Greedy decoding instead of a five-way beam search, and silence skipped
        # before it is decoded at all. A sentence dictated to a control panel is
        # short and literal; the beam buys accuracy on prose this will never see.
        _lang = os.environ.get("JOTPANEL_STT_LANG") or None

        def _stt(audio):  # noqa: F811
            segments, _ = _fw_model.transcribe(
                audio,
                beam_size=1,
                vad_filter=True,
                language=_lang,
                condition_on_previous_text=False,
            )
            return " ".join(s.text for s in segments).strip()
        print(f"[stt] faster-whisper ready ({_stt_model}, int8, {_cores} thread(s))", flush=True)
    except ImportError:
        print("[stt] no whisper backend installed — /transcribe disabled", flush=True)


def wav_to_float32(data):
    """Parse 16-bit PCM WAV bytes into mono float32 at the recorded rate."""
    with wave.open(io.BytesIO(data), "rb") as w:
        rate = w.getframerate()
        channels = w.getnchannels()
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:  # whisper expects 16kHz; crude but fine for speech
        idx = np.round(np.arange(0, len(audio), rate / 16000.0)).astype(np.int64)
        audio = audio[idx[idx < len(audio)]]
    return audio


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # keep stdout quiet; errors still surface via stderr

    def _json_error(self, code, msg):
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": True, "voice": DEFAULT_VOICE}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._json_error(404, "not found")

    def do_POST(self):
        if self.path == "/transcribe":
            if _stt is None:
                return self._json_error(503, "no whisper backend installed")
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 44 or length > 32 * 1024 * 1024:
                    return self._json_error(400, "wav audio required")
                audio = wav_to_float32(self.rfile.read(length))
                text = _stt(audio)
                body = json.dumps({"text": text}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:  # noqa: BLE001
                print(f"[stt] error: {e}", file=sys.stderr, flush=True)
                try:
                    self._json_error(500, str(e))
                except Exception:
                    pass
            return
        if self.path != "/speak":
            return self._json_error(404, "not found")
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                return self._json_error(400, "text required")
            voice = req.get("voice") or DEFAULT_VOICE
            speed = float(req.get("speed") or 1.0)
            # The language follows the voice: Kokoro's French voices start with
            # "f" (ff_siwis), English with "a"/"b". A caller may say outright.
            lang = req.get("lang") or ("fr-fr" if str(voice).startswith("f") else "en-us")
            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            buf = io.BytesIO()
            sf.write(buf, samples, sample_rate, format="WAV")
            audio = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 — report anything to the caller
            print(f"[tts] error: {e}", file=sys.stderr, flush=True)
            try:
                self._json_error(500, str(e))
            except Exception:
                pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[tts] Echo voice listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
