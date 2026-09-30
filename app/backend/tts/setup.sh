#!/usr/bin/env bash
# One-command rebuild of the Resident voice service on a fresh box.
#
#   cd app/backend/tts && ./setup.sh
#
# Creates ./venv, installs the pinned voice stack, downloads the two Kokoro
# model files if they are missing and finishes with an import self-check.
# Idempotent: an existing venv is reused (pip only fills gaps) and existing
# model files are never re-downloaded. Nothing outside this directory is touched.
#
# STT backend is picked by platform: mlx-whisper on Apple Silicon,
# faster-whisper everywhere else (matches the fallback order in tts_server.py).
set -euo pipefail
cd "$(dirname "$0")"

PY="${ARCA_TTS_PYTHON:-python3}"
MODEL_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

# The venv and the weights are state, not code.
#
# They used to be created right here, inside the application tree, which
# upgrade.sh replaces wholesale — so an upgrade destroyed an installed voice and
# asked the customer to download 337 MB again. They now live beside the
# database, where an upgrade does not reach.
#
# The path is derived from this script's position (…/app/backend/tts →
# …/data/tts) so nothing has to be configured on a normal install, and
# JOTPANEL_TTS_STATE overrides it for a dev checkout.
INSTALL_ROOT="$(cd ../../.. && pwd)"
STATE="${JOTPANEL_TTS_STATE:-$INSTALL_ROOT/data/tts}"
mkdir -p "$STATE"

# An install that already has a working voice in the old place keeps it: the
# venv and the weights are moved, not downloaded again. Moved rather than
# copied, so there is never a second stale copy of a 310 MB model.
for old in venv kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ -e "$old" ] && [ ! -e "$STATE/$old" ]; then
    echo "[setup] moving existing $old into $STATE"
    mv "$old" "$STATE/$old"
  fi
done

cd "$STATE"
echo "[setup] state directory: $STATE"

echo "[setup] python: $($PY --version 2>&1)"
if [ ! -x venv/bin/python ]; then
  echo "[setup] creating venv..."
  "$PY" -m venv venv
fi

echo "[setup] installing pinned packages..."
./venv/bin/pip install --quiet --upgrade pip
./venv/bin/pip install --quiet \
  "kokoro-onnx==0.4.7" \
  "onnxruntime==1.27.0" \
  "soundfile==0.14.0" \
  "numpy>=2,<3"

if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
  echo "[setup] Apple Silicon — installing mlx-whisper for STT..."
  ./venv/bin/pip install --quiet "mlx-whisper==0.4.3"
else
  echo "[setup] installing faster-whisper for STT..."
  ./venv/bin/pip install --quiet "faster-whisper"
fi

for f in kokoro-v1.0.onnx voices-v1.0.bin; do
  if [ -s "$f" ]; then
    echo "[setup] $f already present, skipping download"
  else
    echo "[setup] downloading $f ..."
    curl -fL --retry 3 -o "$f.part" "$MODEL_BASE/$f"
    mv "$f.part" "$f"
  fi
done

echo "[setup] self-check: loading Kokoro..."
./venv/bin/python - <<'EOF'
from kokoro_onnx import Kokoro
k = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
import numpy as np
samples, rate = k.create("Setup check.", voice="af_heart", speed=1.0)
assert len(samples) > 0 and rate > 0
print(f"[setup] OK — synthesized {len(samples)/rate:.2f}s of audio at {rate}Hz")
EOF

echo "[setup] done. The panel starts the service itself; its venv and models are in $STATE."
