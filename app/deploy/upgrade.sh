#!/usr/bin/env bash
# Move an installed JotPanel, including a pre-rename Arca panel, to a new release, keeping everything the school or
# the host has: the database, the deletion ledger, uploads, backups, the
# certificate, the .env. The installer refuses an existing install on purpose;
# this is the other half of that refusal.
#
#   upgrade.sh --bundle-file /root/jotpanel-panel.tar.gz [--bundle-sha256 HASH] [--install-dir /opt/jotpanel]
#
# What it does, in order: verify the release the same way the installer does,
# keep the running app aside, stop the panel, put the new app in place, build
# it, start the panel and ask it whether it is well. If it is not, the kept
# app goes back and the panel is started again on the old release, so a bad
# upgrade ends where it began rather than halfway. The database is never
# touched: the panel migrates its own schema at start-up with CREATE IF NOT
# EXISTS and ALTER-if-missing, which is why the old app can be put back.
set -Eeuo pipefail

while IFS='=' read -r legacy_name legacy_value; do
  case "$legacy_name" in
    ARCA_*)
      current_name="JOTPANEL_${legacy_name#ARCA_}"
      if ! declare -p "$current_name" >/dev/null 2>&1; then printf -v "$current_name" '%s' "$legacy_value"; export "$current_name"; fi
      ;;
  esac
done < <(env)

INSTALL_DIR="${JOTPANEL_INSTALL_DIR:-/opt/jotpanel}"
BUNDLE_FILE=""
BUNDLE_SHA256=""
READY_TIMEOUT="${JOTPANEL_READY_TIMEOUT:-90}"
die() { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle-file) BUNDLE_FILE="${2:-}"; shift 2 ;;
    --bundle-sha256) BUNDLE_SHA256="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ $EUID -eq 0 ]] || die "Run as root."
INSTALL_DIR="${INSTALL_DIR%/}"
LEGACY_LAYOUT=0
RUN_USER=jotpanel
if [[ "$INSTALL_DIR" == "/opt/jotpanel" && ! -e "$INSTALL_DIR" && -f /opt/arca/app/backend/server.js && -f /opt/arca/.env ]]; then
  LEGACY_LAYOUT=1
  INSTALL_DIR=/opt/arca
  RUN_USER=arca
fi
[[ -f "$INSTALL_DIR/app/backend/server.js" && -f "$INSTALL_DIR/.env" ]] || die "$INSTALL_DIR does not hold a JotPanel install to upgrade. Use install.sh for a first install."
[[ -n "$BUNDLE_FILE" && -f "$BUNDLE_FILE" ]] || die "Supply the release with --bundle-file."
PORT="$(grep -E '^PORT=' "$INSTALL_DIR/.env" | tail -1 | cut -d= -f2- || true)"
PORT="${PORT:-9999}"

step "Verifying the release"
if [[ -z "$BUNDLE_SHA256" && -f "${BUNDLE_FILE}.sha256" ]]; then BUNDLE_SHA256="$(awk 'NR==1 {print $1}' "${BUNDLE_FILE}.sha256")"; fi
ACTUAL_SHA256="$(sha256sum "$BUNDLE_FILE" | awk '{print $1}')"
if [[ -n "$BUNDLE_SHA256" ]]; then
  [[ "$BUNDLE_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || die "The bundle SHA-256 is malformed."
  [[ "${ACTUAL_SHA256,,}" == "${BUNDLE_SHA256,,}" ]] || die "Bundle checksum mismatch. Expected $BUNDLE_SHA256, received $ACTUAL_SHA256."
  CHECKSUM_STATE="verified against the supplied checksum"
else
  CHECKSUM_STATE="recorded, no expected checksum was supplied"
fi
if tar -tzf "$BUNDLE_FILE" | awk 'BEGIN{bad=0} /^\//{bad=1} /(^|\/)\.\.($|\/)/{bad=1} END{exit bad?0:1}'; then
  die "The release archive contains an unsafe absolute or parent path."
fi
tar -tzf "$BUNDLE_FILE" | grep 'app/backend/server.js$' >/dev/null || die "That archive is not a JotPanel release."
say "$ACTUAL_SHA256  $CHECKSUM_STATE"

MIGRATION_LIB="$(mktemp "${TMPDIR:-/tmp}/jotpanel-layout.XXXXXX")"
tar -xOf "$BUNDLE_FILE" app/deploy/migrate-layout.sh > "$MIGRATION_LIB" \
  || die "That release does not carry the JotPanel layout migration."
# shellcheck disable=SC1090
source "$MIGRATION_LIB"

PREVIOUS="$INSTALL_DIR/app.previous"
NEW="$INSTALL_DIR/app.next"
rm -rf "$NEW"
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$NEW"
step "Unpacking and building the new release beside the old one"
tar -xzf "$BUNDLE_FILE" -C "$NEW" --strip-components=1
[[ -f "$NEW/backend/server.js" ]] || die "Release layout is invalid."
npm ci --prefix "$NEW/backend" --omit=dev --no-audit --no-fund >/dev/null
npm ci --prefix "$NEW/frontend" --no-audit --no-fund >/dev/null
npm run build --prefix "$NEW/frontend" >/dev/null
install -d -m 0755 "$NEW/backend/public"
cp -R "$NEW/frontend/dist/." "$NEW/backend/public/"
chown -R "$RUN_USER:$RUN_USER" "$NEW"

# The previous release's own report is carried on, so the box always knows
# what it was before this.
PREVIOUS_SHA="$(grep -E '^bundle_sha256=' "$INSTALL_DIR/install-report.txt" "$INSTALL_DIR/upgrade-report.txt" 2>/dev/null | tail -1 | cut -d= -f2- || true)"

rollback() {
  step "The new release did not come up; putting the previous one back"
  systemctl stop jotpanel jotpanel-ops || true
  rm -rf "$INSTALL_DIR/app.failed"
  mv "$INSTALL_DIR/app" "$INSTALL_DIR/app.failed" || true
  mv "$PREVIOUS" "$INSTALL_DIR/app"
  if [[ $LEGACY_LAYOUT -eq 1 ]]; then
    rm -f /etc/systemd/system/jotpanel.service /etc/systemd/system/jotpanel-ops.service /etc/systemd/system/jotpanel-oneshot@.service
    rollback_jotpanel_layout || true
    INSTALL_DIR=/opt/arca
    systemctl daemon-reload
    systemctl start arca-ops arca || true
  else
    systemctl start jotpanel-ops jotpanel || true
  fi
  # Wait for the old release to answer before handing back, so the operator's
  # next request does not land on a panel that is still starting.
  local back=$(( SECONDS + READY_TIMEOUT ))
  until [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)" == "200" ]] || (( SECONDS >= back )); do sleep 2; done
  die "Upgrade rolled back. The failed release is kept at $INSTALL_DIR/app.failed for reading; the panel is on its previous release."
}

# The accounts are counted before the switch and again after it, and fewer
# afterwards puts the old release back. /health answers 200 on an empty panel,
# and the first real upgrade (2026-09-23) passed it having lost every account.
panel_db() {
  local dir
  dir="$(grep -E '^(JOTPANEL|ARCA)_DATA_DIR=' "$INSTALL_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)"
  dir="${dir:-$INSTALL_DIR/data}"
  if [[ -e "$dir/jotpanel.db" ]]; then printf '%s' "$dir/jotpanel.db"; else printf '%s' "$dir/arca.db"; fi
}
count_accounts() { # node_modules-dir database
  "$(command -v node)" -e 'const D=require(process.argv[1]);const db=new D(process.argv[2],{readonly:true,fileMustExist:true});let c=-1;try{c=db.prepare("SELECT count(*) c FROM users").get().c}catch{};console.log(c)' "$1/better-sqlite3" "$2" 2>/dev/null || echo -1
}

step "Switching over"
if [[ $LEGACY_LAYOUT -eq 1 ]]; then
  systemctl stop arca arca-ops
  ACCOUNTS_BEFORE="$(count_accounts "$NEW/backend/node_modules" "$(panel_db)")"
  if ! migrate_jotpanel_layout; then
    rollback_jotpanel_layout || true
    systemctl daemon-reload
    systemctl start arca-ops arca || true
    die "The legacy layout could not be moved and was rolled back."
  fi
  INSTALL_DIR=/opt/jotpanel
  PREVIOUS="$INSTALL_DIR/app.previous"
  NEW="$INSTALL_DIR/app.next"
else
  systemctl stop jotpanel jotpanel-ops
  ACCOUNTS_BEFORE="$(count_accounts "$NEW/backend/node_modules" "$(panel_db)")"
fi
say "accounts before the switch: $ACCOUNTS_BEFORE"
rm -rf "$PREVIOUS"
mv "$INSTALL_DIR/app" "$PREVIOUS"
mv "$NEW" "$INSTALL_DIR/app"

# The voice a customer already installed survives this.
#
# The venv and roughly 337 MB of Whisper and Kokoro weights used to be created
# inside the application tree, which the two lines above replace wholesale. So
# every upgrade silently destroyed an installed voice and asked the customer to
# download the models again — proved on the test box on 2026-09-25, where the
# service simply failed to start after an upgrade.
#
# They belong beside the database, and new installs put them there. An install
# that predates that carries them across once, here, and is then done with it.
# Moved rather than copied: two copies of a 310 MB model is its own defect, and
# the old tree is deleted at the next upgrade anyway.
VOICE_STATE="$INSTALL_DIR/data/tts"
if [[ -d "$PREVIOUS/backend/tts" ]]; then
  # Created first and owned afterwards, best effort: a box whose panel group
  # is named differently would otherwise abort the whole upgrade here, under
  # set -e, over the ownership of a cache directory.
  install -d -m 0750 "$VOICE_STATE"
  for item in venv kokoro-v1.0.onnx voices-v1.0.bin; do
    if [[ -e "$PREVIOUS/backend/tts/$item" && ! -e "$VOICE_STATE/$item" ]]; then
      say "carrying the installed voice across: $item"
      mv "$PREVIOUS/backend/tts/$item" "$VOICE_STATE/$item"
    fi
  done
  chown -R "$RUN_USER:$RUN_USER" "$VOICE_STATE" 2>/dev/null || true
fi

NODE_BIN="$(command -v node)"
render_unit() {
  local source="$INSTALL_DIR/app/deploy/$1" target="/etc/systemd/system/$2"
  [[ -f "$source" ]] || rollback
  sed -e "s|@@INSTALL_DIR@@|$INSTALL_DIR|g" -e "s|@@NODE@@|$NODE_BIN|g" "$source" > "$target"
  chmod 0644 "$target"
  ! grep -q '@@' "$target" || rollback
}
render_unit jotpanel-ops.service.template jotpanel-ops.service
render_unit 'jotpanel-oneshot@.service.template' 'jotpanel-oneshot@.service'
render_unit jotpanel.service.template jotpanel.service
# A box installed before the loopback override was really written gets it here.
if systemctl list-unit-files --type=service 2>/dev/null | grep '^ollama.service' >/dev/null \
   && [[ ! -f /etc/systemd/system/ollama.service.d/jotpanel-loopback.conf ]]; then
  install -d -m 0755 /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_HOST=127.0.0.1:11434"\n' > /etc/systemd/system/ollama.service.d/jotpanel-loopback.conf
  systemctl daemon-reload
  systemctl restart ollama || true
fi
install -d -m 0750 -o root -g jotpanel-ops /var/lib/jotpanel-ops /var/lib/jotpanel-ops/kernel-modules
systemctl daemon-reload
systemctl enable jotpanel-ops.service jotpanel.service >/dev/null
systemctl start jotpanel-ops jotpanel

deadline=$(( SECONDS + READY_TIMEOUT ))
code=""
while :; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [[ "$code" == "200" ]] && break
  if ! systemctl is-active --quiet jotpanel || (( SECONDS >= deadline )); then rollback; fi
  sleep 2
done
systemctl is-active --quiet jotpanel-ops || rollback
say "the panel answers on its new release"
ACCOUNTS_AFTER="$(count_accounts "$INSTALL_DIR/app/backend/node_modules" "$(panel_db)")"
say "accounts after the switch: $ACCOUNTS_AFTER"
if (( ACCOUNTS_BEFORE >= 0 && ACCOUNTS_AFTER < ACCOUNTS_BEFORE )); then
  say "the new release sees fewer accounts than the old one had"
  rollback
fi

if [[ $LEGACY_LAYOUT -eq 1 ]]; then
  systemctl disable arca.service arca-ops.service 2>/dev/null || true
  rm -f /etc/systemd/system/arca.service /etc/systemd/system/arca-ops.service /etc/systemd/system/arca-oneshot@.service
  systemctl daemon-reload
fi

cat > "$INSTALL_DIR/upgrade-report.txt" <<EOF
JotPanel upgrade report
upgraded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
bundle_source=$BUNDLE_FILE
bundle_sha256=$ACTUAL_SHA256
bundle_checksum=$CHECKSUM_STATE
previous_sha256=${PREVIOUS_SHA:-unknown}
previous_release_kept_at=$PREVIOUS
panel_health=verified
accounts_before=$ACCOUNTS_BEFORE
accounts_after=$ACCOUNTS_AFTER
legacy_layout_migrated=$( [[ $LEGACY_LAYOUT -eq 1 ]] && echo yes || echo no )
EOF
chmod 0640 "$INSTALL_DIR/upgrade-report.txt"
printf '%s upgraded to %s (was %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACTUAL_SHA256" "${PREVIOUS_SHA:-unknown}" >> "$INSTALL_DIR/upgrade-history.txt"
step "Upgraded"
say "Report: $INSTALL_DIR/upgrade-report.txt"
say "The previous release is kept at $PREVIOUS until the next upgrade."
