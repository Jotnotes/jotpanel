#!/usr/bin/env bash
# Build the runtime bundle consumed by app/deploy/install.sh.
#
# The public panel proxies assistant requests to the licensed thinking service.
# Private prompts and knowledge bases are deliberately outside this artifact;
# the checks below fail closed if that boundary is ever crossed.
#
# One tree, two mutually exclusive products, one script. `--product panel`
# (the default) builds JotPanel and leaves the desktop out; `--product
# navigator` builds JotNotes Navigator and puts it in. The server already picks
# the shell at run time from JOTPANEL_SHELL, so the difference between the two
# artifacts is which front-end files are present and what app/PRODUCT says.
#
# One script rather than two, because two would be copies of each other and the
# boundary checks below are the whole point: a second copy is a second place for
# the private thinking service, a live .env or the paid desktop to slip into a
# free panel, and only one of them would be read when that happened.
#
# The panel does not import the desktop: the panel lives in
# `app/frontend/control-panel.jsx` and the desktop imports it, rather than the
# panel being a component inside the desktop's own file. That is why the desktop
# can be left out at all.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRODUCT=panel
POSITIONAL=()
while (($#)); do
  case "$1" in
    --product)
      PRODUCT="${2:-}"
      [[ "$PRODUCT" == panel || "$PRODUCT" == navigator ]] || { echo "--product is panel or navigator" >&2; exit 2; }
      shift 2 ;;
    --product=*)
      PRODUCT="${1#*=}"
      [[ "$PRODUCT" == panel || "$PRODUCT" == navigator ]] || { echo "--product is panel or navigator" >&2; exit 2; }
      shift ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
set -- "${POSITIONAL[@]+${POSITIONAL[@]}}"

if [[ "$PRODUCT" == navigator ]]; then
  DEFAULT_OUTPUT="$ROOT_DIR/navigator-customer.tar.gz"
  PRODUCT_LABEL="JotNotes Navigator"
else
  DEFAULT_OUTPUT="$ROOT_DIR/jotpanel-customer.tar.gz"
  PRODUCT_LABEL="JotPanel"
fi
OUTPUT="${1:-$DEFAULT_OUTPUT}"

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
# The desktop is left out of a panel bundle by name. For Navigator the same
# three files are exactly what is being shipped, so the exclusion is empty and
# the per-product allowlist below is what has to name them.
DESKTOP_EXCLUDES=(
  --exclude='app/frontend/arca-webos.jsx'
  --exclude='app/frontend/main.jsx'
  --exclude='app/frontend/index.html'
  `# The Echo scenes and LegacyDesk's app. Referenced only by arca-webos.jsx,`
  `# so the panel has no use for them and they weigh more than the rest.`
  --exclude='app/frontend/public'
)
[[ "$PRODUCT" == navigator ]] && DESKTOP_EXCLUDES=()

tar $TAR_CLEAN -C "$ROOT_DIR" -cf - \
  "${DESKTOP_EXCLUDES[@]+${DESKTOP_EXCLUDES[@]}}" \
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
  --exclude='app/docs' \
  `# Git keeps an empty folder with a placeholder; the box makes the folder itself.` \
  --exclude='.gitkeep' \
  --exclude='*.test.js' \
  --exclude='*.test.mjs' \
  `# Shell tests too. app/deploy/*.sh is allowlisted as a glob, so every test` \
  `# beside the deploy scripts was shipping into customer installs: the` \
  `# non-interactive installer test, the voice persistence test and, from` \
  `# 2026-10-05, the firstboot .env durability test. A customer runs the` \
  `# installer, not the tests for it.` \
  --exclude='*.test.sh' \
  `# The Resident's labelled phrases and the script that scores a model on them` \
  `# are development tools, not part of what a customer runs.` \
  --exclude='app/backend/control/residentGateway.labels.json' \
  --exclude='app/backend/control/residentGateway.score.js' \
  `# The MCP gateway runs beside the person's own AI, on their machine, and is` \
  `# published as its own Apache 2.0 package. It is not part of the server.` \
  --exclude='app/mcp-gateway' \
  --exclude='app/tools' \
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

# ── What this product does not ship ──────────────────────────────
#
# The allowlist says what may ship, for both products at once. That is the
# right shape until a file belongs to one product and not the other, and the
# ones that do are mostly reached by lines that never say their names:
# `app/backend/control/**/*.js` carries fleet, enrollment, the fleet summary,
# the machine jobs and activation without naming any of them. Narrowing that
# line to take six files out would take the rest of `control/` out with them.
#
# So removals get a list of their own, per product, read here rather than by
# the allowlist checker. The checker keeps meaning exactly one thing, and this
# keeps the fail-closed property rather than spending it: everything left after
# the removals still has to be named by the allowlist, which runs below and is
# unchanged. The removals are fail-closed in the other direction — a path the
# list names and the stage does not have fails the build, because a renamed
# file is a file this list has silently stopped excluding and nothing else
# would ever say so.
#
# Only the panel has one. Navigator ships what the shared list names, which is
# what it has always shipped.
# The published source is a panel-only tree: scripts/lib/export-jotpanel.py has
# already left the other product's modules out of it, so there is nothing here
# to exclude and a list that names them is naming files this tree never had.
# That is not the renamed-file case above and must not be read as it, or the
# release could not be built from the source it ships - which is how this was
# found: publish-jotpanel-release.sh builds the bundle from the export.
#
# The marker is the other product's own allowlist. A tree that has it is ours;
# a tree without it is the published one. Fail-closed both ways: here the list
# must name nothing the tree still has, so an export that leaked one of these
# files stops the release instead of shipping it quietly.
if [[ "$PRODUCT" == panel ]]; then
  PRODUCT_EXCLUDE="$ROOT_DIR/app/deploy/BUNDLE_EXCLUDE.panel.txt"
  [[ -f "$PRODUCT_EXCLUDE" ]] || { echo "The panel exclusion list is missing: $PRODUCT_EXCLUDE" >&2; exit 1; }
  PANEL_ONLY_TREE=0
  [[ -f "$ROOT_DIR/app/deploy/BUNDLE_ALLOWLIST.navigator.txt" ]] || PANEL_ONLY_TREE=1
  EXCLUDED=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [[ -n "$line" ]] || continue
    if [[ "$PANEL_ONLY_TREE" -eq 1 ]]; then
      if [[ -e "$STAGE/$line" ]]; then
        echo "The published source still has $line, which belongs to the other product" >&2
        echo "The source export let it through. Fix scripts/lib/export-jotpanel.py, not this list." >&2
        exit 1
      fi
      continue
    fi
    if [[ ! -e "$STAGE/$line" ]]; then
      echo "The panel exclusion list names something the bundle does not have: $line" >&2
      echo "It was renamed or removed, and this list stopped excluding it without saying so. Fix the list." >&2
      exit 1
    fi
    rm -rf "${STAGE:?}/$line"
    EXCLUDED=$((EXCLUDED + 1))
  done < "$PRODUCT_EXCLUDE"
  if [[ "$EXCLUDED" -eq 0 && "$PANEL_ONLY_TREE" -eq 0 ]]; then
    echo "The panel exclusion list excluded nothing, so it is not doing its job" >&2
    exit 1
  fi
fi

# ── The tests a customer can actually run ────────────────────────
#
# `--exclude='*.test.js'` above keeps every development suite out of the
# bundle, and keeping all of them out is how `npm test` came to point at
# `test.js`: a suite for a product that no longer exists, fired at a running
# server, failing twenty-four of forty-five checks on a perfectly healthy panel
# because public sign-ups are correctly closed. A customer running the
# documented command should be told their install is fine, or told precisely
# what is not.
#
# So a small named set is copied back in after staging. Each one passes with
# nothing running and exercises files the bundle actually carries. Named one at
# a time, and asserted to exist, for the same reason everything else here is:
# a list that silently matches nothing is worse than no list.
SHIPPED_TESTS=(
  app/backend/control/panelSettings.test.js
  app/backend/control/layoutCompatibility.test.js
  app/backend/control/control.test.js
  app/backend/control/twoFactor.test.js
  app/backend/control/apiKeys.test.js
  app/frontend/panel-storage.test.mjs
)
for shipped in "${SHIPPED_TESTS[@]}"; do
  [[ -f "$ROOT_DIR/$shipped" ]] || { echo "A shipped test is not in the tree: $shipped" >&2; exit 1; }
  mkdir -p "$(dirname "$STAGE/$shipped")"
  cp "$ROOT_DIR/$shipped" "$STAGE/$shipped"
done

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
# The shared list names what both products carry. A product list names the few
# files only one of them does, so the desktop cannot reach a panel bundle by way
# of a line somebody widened in the shared file.
ALLOWLISTS=("$ALLOWLIST")
if [[ "$PRODUCT" == navigator ]]; then
  PRODUCT_ALLOWLIST="$ROOT_DIR/app/deploy/BUNDLE_ALLOWLIST.navigator.txt"
  [[ -f "$PRODUCT_ALLOWLIST" ]] || { echo "The Navigator allowlist is missing: $PRODUCT_ALLOWLIST" >&2; exit 1; }
  ALLOWLISTS+=("$PRODUCT_ALLOWLIST")
fi
python3 "$CHECKER" "$STAGE" "${ALLOWLISTS[@]}" || exit 1

# The desktop is the difference between the two products, so each bundle is
# asserted to have what it is for and not what it is not. A panel bundle that
# quietly carried the paid desktop would publish the paid product with the free
# one; a Navigator bundle without it is an install that boots to nothing.
if [[ "$PRODUCT" == navigator ]]; then
  for required in app/frontend/arca-webos.jsx app/frontend/main.jsx app/frontend/index.html; do
    [[ -e "$STAGE/$required" ]] || { echo "A Navigator bundle without its desktop: $required is missing" >&2; exit 1; }
  done
elif [[ -e "$STAGE/app/frontend/arca-webos.jsx" || -e "$STAGE/app/frontend/index.html" ]]; then
  echo "The desktop crossed the panel bundle boundary" >&2
  exit 1
fi

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

echo "$PRODUCT_LABEL bundle: $OUTPUT ($((BYTES / 1024 / 1024)) MB)"
echo "Product: $PRODUCT (install with JOTPANEL_SHELL=$( [[ "$PRODUCT" == navigator ]] && printf 'desktop' || printf 'panel' ))"
echo "Checksum: $OUTPUT.sha256"
echo "Private thinking instructions: excluded and scanned"
