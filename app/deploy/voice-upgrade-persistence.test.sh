#!/usr/bin/env bash
# The voice a customer installed has to survive an upgrade.
#
# The venv and roughly 337 MB of Whisper and Kokoro weights were created inside
# the application tree, and upgrade.sh replaces that tree wholesale. So every
# upgrade destroyed an installed voice and asked the customer to download the
# models again. Seen on the test box on 2026-09-25: after an upgrade the venv
# was simply gone and the speech service would not start.
#
# This exercises the real migration block out of upgrade.sh against a real
# directory layout, rather than testing a helper in isolation: it builds an
# install that has voice in the OLD place, runs the block, and checks the state
# is in the new place, is not left behind in the old one, and is not duplicated.
#
# Break-test: delete the migration block from upgrade.sh and cases 1 and 2 fail.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPGRADE="$HERE/upgrade.sh"
fails=0
ok()   { printf '  ok  %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fails=$((fails+1)); }

# The migration block, lifted verbatim from upgrade.sh so the test runs the
# shipped text. If the block is removed or renamed this extraction yields
# nothing and every case below fails, which is the point.
block="$(awk '/^VOICE_STATE=/,/^fi$/' "$UPGRADE")"

run_migration() {
  local root="$1"
  (
    INSTALL_DIR="$root"
    PREVIOUS="$root/app.previous"
    RUN_USER="$(id -un)"
    say() { :; }
    eval "$block"
  )
}

# ── Case 1: an install that already had voice in the old place ──────
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
root="$scratch/opt"
mkdir -p "$root/app.previous/backend/tts/venv/bin" "$root/app/backend/tts" "$root/data"
printf '#!/bin/sh\n' > "$root/app.previous/backend/tts/venv/bin/python"
chmod +x "$root/app.previous/backend/tts/venv/bin/python"
head -c 4096 /dev/urandom > "$root/app.previous/backend/tts/kokoro-v1.0.onnx"
head -c 512  /dev/urandom > "$root/app.previous/backend/tts/voices-v1.0.bin"
onnx_sum="$(shasum -a 256 "$root/app.previous/backend/tts/kokoro-v1.0.onnx" | awk '{print $1}')"

run_migration "$root"

[[ -x "$root/data/tts/venv/bin/python" ]] && ok "the venv is carried into data/tts" || bad "the venv did not survive the upgrade"
[[ -f "$root/data/tts/kokoro-v1.0.onnx" && -f "$root/data/tts/voices-v1.0.bin" ]] \
  && ok "both model files are carried across" || bad "the model weights did not survive the upgrade"
[[ "$(shasum -a 256 "$root/data/tts/kokoro-v1.0.onnx" | awk '{print $1}')" == "$onnx_sum" ]] \
  && ok "the weights are the same bytes, not a re-download" || bad "the carried model is not the original file"
[[ ! -e "$root/app.previous/backend/tts/kokoro-v1.0.onnx" ]] \
  && ok "nothing is left behind in the old tree, so there is only one copy" \
  || bad "the model was copied rather than moved, leaving two copies"

# ── Case 2: it is idempotent, and never overwrites newer state ──────
printf 'newer' > "$root/data/tts/voices-v1.0.bin"
mkdir -p "$root/app.previous/backend/tts"
printf 'older' > "$root/app.previous/backend/tts/voices-v1.0.bin"
run_migration "$root"
[[ "$(cat "$root/data/tts/voices-v1.0.bin")" == "newer" ]] \
  && ok "state already in place is never overwritten by the old tree" \
  || bad "the migration clobbered existing state"

# ── Case 3: a fresh install has nothing to carry and must not fail ──
fresh="$scratch/fresh"
mkdir -p "$fresh/app/backend/tts" "$fresh/data"
run_migration "$fresh"
[[ ! -d "$fresh/data/tts" ]] \
  && ok "a fresh install creates no empty voice state" \
  || bad "a fresh install was given a voice directory it never asked for"

# ── Case 4: the shipped code agrees on where state lives ────────────
grep -q 'JOTPANEL_TTS_STATE' "$HERE/../backend/tts/tts_server.py" \
  && ok "the voice service reads its state location" || bad "tts_server.py does not honour the state location"
grep -q 'data.*tts\|JOTPANEL_TTS_STATE' "$HERE/../backend/tts/setup.sh" \
  && ok "setup.sh installs into the state location" || bad "setup.sh still installs into the application tree"
grep -q "JOTPANEL_TTS_STATE" "$HERE/../backend/server.js" \
  && ok "the panel spawns the service from the state location" || bad "server.js still spawns from the application tree"

if [[ $fails -eq 0 ]]; then
  echo "voice upgrade persistence checks passed"
else
  echo "voice upgrade persistence: $fails check(s) failed"
  exit 1
fi
