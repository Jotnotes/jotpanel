#!/usr/bin/env bash
# First boot inside a guest made from a Navigator image: generate this
# machine's own secrets.
#
# WHY THIS EXISTS AT ALL. The image build deletes /opt/jotpanel/.env, and that
# deletion is not tidiness — it is the single most important line in
# build-navigator-image.sh. An image carries whatever the builder had, so a
# baked-in JWT_SECRET would be the SAME signing secret on every customer's
# guest, and a session minted on one would validate on another. That is a
# cross-tenant authentication break, and it would defeat the entire
# one-Navigator-per-VM architecture from the inside.
#
# But install.sh is what normally writes those secrets, and the installer does
# not run on an imaged guest. Without this script the panel exits at boot with
# "JWT_SECRET not set" and the guest is dead on arrival. Found 2026-10-04 by
# booting the server by hand; see docs/NAVIGATOR_IMAGE_PROVISIONING.md.
#
# Ordered Before=jotpanel.service, so the panel has never once seen a missing
# or shared secret.

set -euo pipefail

INSTALL_DIR="${JOTPANEL_INSTALL_DIR:-/opt/jotpanel}"
ENV_FILE="$INSTALL_DIR/.env"

say() { printf '[firstboot] %s\n' "$*"; }

# Idempotent by the only test that matters. This runs on every boot, not just
# the first, because a unit that must not run twice is a unit that eventually
# does: if the file is here, this machine already has its own secrets and
# regenerating them would sign every existing session out and make every
# encrypted field unreadable.
command -v openssl >/dev/null || { echo "[firstboot] openssl is missing; cannot generate secrets" >&2; exit 1; }

# Each part below guards itself, and the script does NOT exit early when .env is
# present. It used to, and that was wrong in a way that only showed on a second
# boot: if the certificate step had failed the first time, every later boot
# returned at the .env check and never reached it again, so a guest with secrets
# and no certificate could never repair itself. The unit runs on every boot by
# design; what must not happen twice is guarded by the thing it would overwrite.
# ── What this guest is, read before anything decides anything ──────
#
# These three are assigned on EVERY boot, not inside the generation branch.
# They used to live inside it, and `DOMAIN` is read much further down as the
# fallback subject for the self-signed certificate: on a boot where .env already
# existed and `hostname -I` returned nothing, that line hit an unbound variable
# under `set -u`, the unit died, and the guest never got the certificate that is
# the only thing making it readable by the pool host at all.
PRODUCT="$(cat "$INSTALL_DIR/IMAGE_PRODUCT" 2>/dev/null || echo navigator)"
VERSION="$(cat "$INSTALL_DIR/IMAGE_VERSION" 2>/dev/null || echo 0.0.0)"
# cloud-init has set the hostname by now. No certificate is fetched here: the
# guest answers on its address with one it makes itself, and a real name is
# attached later from inside, which is the same path a --no-domain install
# takes and is already supported.
DOMAIN="$(hostname -f 2>/dev/null || hostname)"
case "$PRODUCT" in
  navigator) SHELL_MODE=desktop ;;
  panel)     SHELL_MODE=panel ;;
  *)         SHELL_MODE=desktop ;;
esac

# Flush a path to the disk, contents and name together.
#
# `sync FILE` is syncfs(2) on the filesystem holding FILE in coreutils, so it
# covers the file's contents AND the directory entry that names it, which
# fsyncing a file alone does not. A plain `sync` is the fallback for a coreutils
# too old to take the argument, and this must never be the thing that fails the
# unit, so it ends in `|| true`.
flush_path() {
  sync "$1" 2>/dev/null || sync 2>/dev/null || true
}

# ── This guest's own secrets ───────────────────────────────────────
#
# A function so the test can run THIS text rather than a copy of it:
# firstboot-env.test.sh lifts it out of this file by name and evals it.
# The names without which this guest is not this guest.
#
# DELIBERATELY SHORT, and the list is the decision rather than a detail. These
# four are the ones whose absence is not a degraded box but a different one:
# the first three are its identity and its ability to read its own encrypted
# fields, and the fourth is how it finds its own database at all, because
# server.js falls back silently to BACKEND/data without it. Everything else in
# the file is a setting: a missing OLLAMA_BASE or MAX_UPLOAD_MB is a default,
# not a damaged install, and must never trigger a repair.
ENV_REQUIRED=(JWT_SECRET ADMIN_KEY JOTPANEL_ENCRYPT_SECRET JOTPANEL_DATA_DIR)

# Present AND non-empty. `NAME=` with nothing after it is what a partial write
# leaves, and it is as useless as the name being absent.
env_has() {
  grep -qE "^$1=.+" "$2"
}

# Which of the required names this file does not usably carry.
env_missing() {
  local file="$1" name missing=""
  for name in "${ENV_REQUIRED[@]}"; do
    env_has "$name" "$file" || missing="$missing $name"
  done
  printf '%s' "${missing# }"
}

ensure_env_file() {
  # ── What this gate decides, and why each answer is the safe one ────
  #
  # THE FAILURE CLASS. An unclean power-cut keeps the journaled directory entry
  # and loses the unflushed contents, so a file comes back EXISTING AND EMPTY.
  # It destroyed the announce credential on 2026-10-04 and emptied a whole
  # SQLite database on 2026-10-05. This script used to gate on `[[ -f ]]`, which
  # asks only whether the NAME exists, so it would have announced that the
  # machine "keeps the secrets it has" about a file holding none.
  #
  # THE RULE, in the order it is applied:
  #
  #   1. absent, or zero bytes          -> write the whole file
  #   2. all four required names usable  -> LEAVE IT ALONE
  #   3. anything else                   -> keep every value that survived and
  #                                         generate ONLY the missing ones
  #
  # WHY 3 FILLS RATHER THAN REGENERATES, which is the part that matters. The
  # destructive act is REPLACING a surviving `JOTPANEL_ENCRYPT_SECRET`: do that
  # and every encrypted field on the box - provider keys, mail passwords -
  # becomes unreadable for ever. Filling only what is absent cannot do it, by
  # construction: a value that is present is kept, and a value that is absent
  # is already gone, so nothing further can be lost. Regenerating the whole file
  # on any damage would have been the shorter patch and could destroy a
  # recoverable box.
  #
  # AND WHY THE SHAPE OF A SURVIVING VALUE IS NOT JUDGED. A short `JWT_SECRET`
  # still signs tokens perfectly well, so it may be one an operator chose on
  # purpose, and this script cannot tell that from a truncated one. Replacing it
  # would be exactly the silent destruction the rule above exists to prevent, so
  # any non-empty value is accepted as the operator's.
  if [[ ! -s "$ENV_FILE" ]]; then
    if [[ -e "$ENV_FILE" ]]; then
      say "WARNING: $ENV_FILE exists and is EMPTY, which is what an unclean power-cut leaves behind."
      say "It carries no usable secret, so it is being regenerated rather than trusted."
    fi
    write_env_file
    return 0
  fi

  local missing
  missing="$(env_missing "$ENV_FILE")"
  if [[ -z "$missing" ]]; then
    say "$ENV_FILE carries this machine's secrets, so they are kept exactly as they are."
    return 0
  fi

  # Non-empty and incomplete: a partial write, or a file something truncated.
  say "WARNING: $ENV_FILE is not empty but does not usably carry:$missing"
  say "Keeping every value that survived and generating only the missing ones."
  repair_env_file "$missing"
}

# The whole file, for a guest that has none.
write_env_file() {
  say "generating this guest's own secrets for $PRODUCT $VERSION"
  # Written to a temporary name, flushed, and then moved into place, so the
  # final name NEVER exists holding a partial file. A rename within one
  # directory is atomic: either the old state or the whole new file, and never
  # the half-written thing this gate exists to recover from.
  umask 077
  local tmp="$ENV_FILE.new.$$"
  rm -f "$tmp"
  cat > "$tmp" <<EOF
NODE_ENV=production
PORT=9999
JOTPANEL_BOOTSTRAP_PORT=9998
DOMAIN=$DOMAIN
JOTPANEL_VERSION=$VERSION
JOTPANEL_DATA_DIR=$INSTALL_DIR/data
UPLOADS_DIR=$INSTALL_DIR/uploads
JOTPANEL_JOB_ROOT=$INSTALL_DIR
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_KEY=$(openssl rand -hex 32)
JOTPANEL_ENCRYPT_SECRET=$(openssl rand -hex 32)
JOTPANEL_SHELL=$SHELL_MODE
JOTPANEL_PROVISIONING_ADAPTER=native
JOTPANEL_OPS_SOCKET=/run/jotpanel-ops/ops.sock
OLLAMA_BASE=http://127.0.0.1:11434/v1/chat/completions
MAX_UPLOAD_MB=1024
EOF
  install_env_file "$tmp"
}

# Only the names that are missing, with everything else carried across.
repair_env_file() {
  local missing="$1" name value
  umask 077
  local tmp="$ENV_FILE.new.$$"
  rm -f "$tmp"
  # Every well-formed assignment that survived, in the order it was written.
  # A line that is not `NAME=value` is dropped, which is what the panel's own
  # reader does with it anyway, and is how the partial last line of a truncated
  # write is discarded rather than carried forward as junk.
  grep -E '^[A-Z0-9_]+=' "$ENV_FILE" > "$tmp" || true
  for name in $missing; do
    case "$name" in
      JWT_SECRET|ADMIN_KEY|JOTPANEL_ENCRYPT_SECRET) value="$(openssl rand -hex 32)" ;;
      JOTPANEL_DATA_DIR)                            value="$INSTALL_DIR/data" ;;
      *)                                            continue ;;
    esac
    # Drop an empty `NAME=` before appending, so the file does not end up with
    # the name twice and the reader taking whichever it happens to hit.
    grep -vE "^$name=" "$tmp" > "$tmp.filtered" && mv -f "$tmp.filtered" "$tmp"
    printf '%s=%s\n' "$name" "$value" >> "$tmp"
    say "regenerated $name, which was missing"
  done
  install_env_file "$tmp"

  # A repair is a thing a human has to know happened, so it is left where one
  # will see it rather than only in the journal.
  #
  # 0644 AND NOT 0600, which the umask above would otherwise give it. It holds
  # no secret - the NAMES of what was regenerated and when, nothing else - and
  # two readers need it: a person, and the panel's own ops report, which runs as
  # the `jotpanel` user and reads this to refuse to call the box healthy. At
  # 0600 root-owned the health check would silently never fire, which is the
  # failure mode this whole file exists to stop repeating.
  local marker="$INSTALL_DIR/SECRETS_REPAIRED.txt"
  {
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) jotpanel-firstboot repaired $ENV_FILE"
    echo "missing and regenerated:$missing"
  } >> "$marker" 2>/dev/null || true
  chmod 0644 "$marker" 2>/dev/null || true
  flush_path "$marker"

  # THE ONE CONSEQUENCE THAT IS NOT RECOVERABLE, said plainly. A new encryption
  # secret cannot read what the old one wrote, and the old one is gone, so this
  # is a report of a loss that has already happened rather than a warning about
  # one that might.
  case " $missing " in
    *" JOTPANEL_ENCRYPT_SECRET "*)
      say "WARNING: this guest's encryption secret was lost, so a new one was generated."
      say "Anything stored encrypted before now - provider keys, mail passwords - cannot be read"
      say "with it. The old secret is gone, so this is not undone by restarting: restore from a"
      say "backup if those fields matter. See $INSTALL_DIR/SECRETS_REPAIRED.txt"
      ;;
  esac
}

# Own it, flush it, move it into place, and read it back before believing it.
install_env_file() {
  local tmp="$1"
  chmod 0600 "$tmp"
  # The account the panel runs as, created by the image build's install step.
  # Left alone if it is not there, because a chown to a missing user fails the
  # unit and a panel that cannot read its own .env is a clearer failure than one
  # that never started. Applied to the temporary file, so the final name never
  # exists with the wrong owner even for an instant.
  if id jotpanel >/dev/null 2>&1; then
    chown jotpanel:jotpanel "$tmp"
    install -d -o jotpanel -g jotpanel -m 0750 "$INSTALL_DIR/data" "$INSTALL_DIR/uploads"
  fi
  flush_path "$tmp"
  mv -f "$tmp" "$ENV_FILE"
  flush_path "$INSTALL_DIR"

  # READ BACK BEFORE BELIEVING IT, the same rule the announce credential now
  # follows. A secret this guest cannot read is one it discovers it has lost
  # after a reboot, which is the worst available moment to find out.
  local still_missing
  still_missing="$(env_missing "$ENV_FILE")"
  if [[ -n "$still_missing" ]]; then
    echo "[firstboot] $ENV_FILE was written but does not read back with:$still_missing" >&2
    exit 1
  fi
}

ensure_env_file

# A guest that boots a second time must not be the same machine as the first.
# The image build empties these; systemd regenerates machine-id itself, and
# the ssh host keys are regenerated here because nothing else will.
if [[ ! -s /etc/machine-id ]]; then
  systemd-machine-id-setup >/dev/null 2>&1 || true
fi
if ! ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1; then
  say "regenerating ssh host keys, which the image deliberately shipped without"
  ssh-keygen -A >/dev/null 2>&1 || true
fi

# ── Logs that survive a reboot ─────────────────────────────────────
#
# The image build removes /var/log/journal, correctly: a journal carried in an
# image is the BUILDER's log in every customer's guest. But journald falls back
# to volatile storage when that directory is absent, so everything a guest logs
# is lost the moment it reboots - and the units that run earliest, which is
# exactly firstboot and announce, are the ones rsyslog has not started in time
# to catch either.
#
# That cost a diagnosis on 2026-10-04: a guest had plainly rebooted twice and
# its syslog showed only the first boot's unit events, so there was no way to
# tell whether a unit had run and failed or never run at all. A guest whose
# logs vanish on reboot cannot be supported, never mind debugged.
#
# Recreated here rather than in the image, so the directory belongs to the
# guest and starts empty.
if [[ ! -d /var/log/journal ]]; then
  say "making the journal persistent, so this guest's logs survive a reboot"
  install -d -m 2755 -g systemd-journal /var/log/journal 2>/dev/null \
    || install -d -m 0755 /var/log/journal
  systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
  systemctl kill --kill-who=main --signal=SIGUSR1 systemd-journald >/dev/null 2>&1 || true
fi

# ── This guest's own certificate ───────────────────────────────────
#
# WHY FIRST BOOT AND NOT THE IMAGE. The nginx TLS *config* is identical on every
# guest and could ship in the image; the KEY cannot. A private key baked into an
# image is the same private key in every customer's guest, which is the same
# class of mistake as a shared JWT secret - anybody with the image could
# impersonate every guest made from it.
#
# And without HTTPS the guest is not merely less secure, it is INVISIBLE: the
# pool host's collector polls https://<address>/admin/fleet/summary, and
# install.sh's --image-build skips the certificate step precisely because it is
# per-machine. So this is what makes an enrolled guest readable at all.
#
# Nobody issues a public certificate for an address, so the guest makes its own
# and the panel says so, exactly as a --no-domain install does.
TLS_DIR=/etc/jotpanel-tls
if [[ ! -s "$TLS_DIR/panel.key" ]]; then
  say "making this guest's own self-signed certificate"
  mkdir -p "$TLS_DIR"
  CN="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$CN" ]] || CN="$DOMAIN"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$CN"     -keyout "$TLS_DIR/panel.key" -out "$TLS_DIR/panel.crt" >/dev/null 2>&1     || { echo "[firstboot] a self-signed certificate could not be written" >&2; exit 1; }
  chmod 600 "$TLS_DIR/panel.key"
fi

# The config is written here rather than shipped enabled, because `nginx -t`
# refuses a config whose certificate does not exist yet and an image has no
# certificate. Written and linked only once the key above is in place.
if [[ ! -e /etc/nginx/sites-enabled/jotpanel-tls.conf ]]; then
  install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
  cat > /etc/nginx/sites-available/jotpanel-tls.conf <<'TLSCONF'
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/jotpanel-tls/panel.crt;
    ssl_certificate_key /etc/jotpanel-tls/panel.key;
    client_max_body_size 512m;
    location / {
        proxy_pass http://127.0.0.1:9999;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 3900s;
    }
}
TLSCONF
  ln -sf /etc/nginx/sites-available/jotpanel-tls.conf /etc/nginx/sites-enabled/jotpanel-tls.conf
  if nginx -t >/dev/null 2>&1; then
    say "HTTPS enabled on this guest, so the pool host can read it"
  else
    echo "[firstboot] the HTTPS config did not pass nginx -t; removing it rather than breaking nginx" >&2
    rm -f /etc/nginx/sites-enabled/jotpanel-tls.conf
  fi
fi

say "done: this guest has its own JWT, admin and encryption secrets, shared with no other machine"
