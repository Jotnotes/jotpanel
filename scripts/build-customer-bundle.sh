#!/usr/bin/env bash
# Build the runtime bundle consumed by app/deploy/install.sh.
#
# The public panel proxies assistant requests to the licensed thinking service.
# Private prompts and knowledge bases are deliberately outside this artifact;
# the checks below fail closed if that boundary is ever crossed.
#
# The desktop is not in here either. Its three files are excluded by name below
# and, more to the point, nothing in the panel imports them any more: the panel
# lives in `app/frontend/control-panel.jsx` and the desktop imports it, rather
# than the panel being a component inside the desktop's own file. That is why
# `app/frontend/arca-webos.jsx` is no longer in the allowlist.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT="${1:-$ROOT_DIR/jotpanel-customer.tar.gz}"

if [[ "$OUTPUT" != /* ]]; then OUTPUT="$PWD/$OUTPUT"; fi
if [[ "$OUTPUT" == "/" || -d "$OUTPUT" ]]; then
  echo "Output must be a tar.gz file path" >&2
  exit 2
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/arca-customer-bundle.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# macOS tars its own extended attributes into the archive, and the customer's
# box then prints a screenful of "Ignoring unknown extended header keyword
# LIBARCHIVE.xattr.com.apple.provenance" while unpacking. Harmless, and it is
# the first thing anybody installing this ever sees.
export COPYFILE_DISABLE=1
TAR_CLEAN=""
tar --no-xattrs --version >/dev/null 2>&1 && TAR_CLEAN="--no-xattrs"
PRODUCT=panel
tar $TAR_CLEAN -C "$ROOT_DIR" -cf - \
  --exclude='app/backend/thinking' \
  --exclude='app/backend/concierge_kb.md' \
  --exclude='app/tools/echo_control_layer.py' \
  --exclude='app/backend/data' \
  --exclude='app/backend/node_modules' \
  --exclude='app/backend/.env' \
  --exclude='app/backend/license-server.js' \
  --exclude='app/backend/licenseAllocations.test.js' \
  --exclude='app/backend/engine-server.js' \
  --exclude='app/backend/engine-server.test.js' \
  --exclude='app/backend/tts/venv' \
  --exclude='app/backend/tts/*.onnx' \
  --exclude='app/backend/tts/*.bin' \
  --exclude='app/frontend/node_modules' \
  --exclude='app/frontend/dist' \
  --exclude='app/frontend/arca-webos.jsx' \
  --exclude='app/frontend/main.jsx' \
  --exclude='app/frontend/index.html' \
  --exclude='app/docs' \
  `# Git keeps an empty folder with a placeholder; the box makes the folder itself.` \
  --exclude='.gitkeep' \
  --exclude='*.test.js' \
  --exclude='*.test.mjs' \
  `# The Resident's labelled phrases and the script that scores a model on them` \
  `# are development tools, not part of what a customer runs.` \
  --exclude='app/backend/control/residentGateway.labels.json' \
  --exclude='app/backend/control/residentGateway.score.js' \
  `# The MCP gateway runs beside the person's own AI, on their machine, and is` \
  `# published as its own Apache 2.0 package. It is not part of the server.` \
  --exclude='app/mcp-gateway' \
  --exclude='app/tools' \
  --exclude='app/frontend/public' \
  --exclude='app/CLAUDE_HANDOFF.md' \
  --exclude='app/backend/provisioning/README.md' \
  app | tar -C "$STAGE" -xf -

if [[ -e "$STAGE/app/backend/thinking" || -e "$STAGE/app/backend/concierge_kb.md" ]]; then
  echo "Private thinking-service files crossed the customer bundle boundary" >&2
  exit 1
fi

# These are services JotPanel talks to, not services a customer installation
# runs. Keep an explicit assertion after staging so a later tar edit cannot
# quietly undo the exclusions above while the broad backend allowlist remains.
if [[ -e "$STAGE/app/backend/license-server.js" || -e "$STAGE/app/backend/engine-server.js" ]]; then
  echo "An internal service reached the customer bundle" >&2
  exit 1
fi

# A live .env was shipped once, carrying this machine's real JWT_SECRET and
# ADMIN_KEY into an artifact meant for customers. The exclude above stops the
# known one; this stops the next one, wherever it appears in the tree. Only the
# two templates that exist to be filled in are allowed through.
LEAKED="$(find "$STAGE/app" -name '.env' -o -name '.env.*' ! -name '.env.example' ! -name '.env.production')"
if [[ -n "$LEAKED" ]]; then
  echo "An environment file reached the customer bundle:" >&2
  printf '%s\n' "$LEAKED" >&2
  exit 1
fi

# ── The boundary ─────────────────────────────────────────────────
#
# Everything staged is checked against the allowlist and anything unnamed fails
# the build. The reasoning is in the allowlist and in the checker; the short
# version is that a blocklist only catches what somebody thought of on the day
# it was written.
ALLOWLIST="$ROOT_DIR/app/deploy/BUNDLE_ALLOWLIST.txt"
CHECKER="$ROOT_DIR/scripts/lib/check-bundle-allowlist.py"
[[ -f "$ALLOWLIST" ]] || { echo "The bundle allowlist is missing: $ALLOWLIST" >&2; exit 1; }
[[ -f "$CHECKER" ]] || { echo "The bundle allowlist checker is missing: $CHECKER" >&2; exit 1; }
printf '%s\n' "$PRODUCT" > "$STAGE/app/PRODUCT"
python3 "$CHECKER" "$STAGE" "$ALLOWLIST" || exit 1

# Kept as a second net rather than as the only one. The allowlist decides what
# may ship; this catches a known private instruction inside a file that was
# allowed. grep rather than ripgrep, because this must not depend on a tool that
# happens to be installed on one developer's machine.
if grep -rIqF \
    -e 'You are Echo in Builder mode.' \
    -e '=== FACTS ===' \
    "$STAGE/app"; then
  echo "Private assistant instructions were found in the customer bundle" >&2
  exit 1
fi

(cd "$STAGE" && find app -type f -print | LC_ALL=C sort) > "$STAGE/app/BUNDLE_CONTENTS.txt"
mkdir -p "$(dirname "$OUTPUT")"
tar $TAR_CLEAN -C "$STAGE" -czf "$OUTPUT" app

if command -v sha256sum >/dev/null; then
  sha256sum "$OUTPUT" > "$OUTPUT.sha256"
else
  shasum -a 256 "$OUTPUT" > "$OUTPUT.sha256"
fi

# The bundle ballooned to 656 MB once, carrying a macOS Python virtualenv and
# 337 MB of voice models into a panel that has no assistant. setup.sh builds
# both on the target box, so neither belongs here. A ceiling turns the next
# accidental inclusion into a failed build rather than a slow upload.
BYTES="$(wc -c < "$OUTPUT" | tr -d ' ')"
LIMIT=$((150 * 1024 * 1024))
if [[ "$BYTES" -gt "$LIMIT" ]]; then
  echo "Bundle is $((BYTES / 1024 / 1024)) MB, over the $((LIMIT / 1024 / 1024)) MB ceiling. Largest entries:" >&2
  tar -tzvf "$OUTPUT" | sort -k3 -n -r | head -15 >&2
  exit 1
fi

echo "Customer bundle: $OUTPUT ($((BYTES / 1024 / 1024)) MB)"
echo "Checksum: $OUTPUT.sha256"
echo "Private thinking instructions: excluded and scanned"
