#!/usr/bin/env bash
# Take a bare Linux box to a working JotPanel with one command from here.
#
#   scripts/install-on-box.sh --host 192.0.2.10 --domain panel.example.com \
#       --email owner@example.com --password-file ~/.secret --cert-staging
#
# There is no downloads host yet, so this builds the release locally and hands
# it to the machine. Everything after that is app/deploy/install.sh doing its
# own job: this script must never run a setup command on the box itself. If it
# ever grows one, that is a defect in the installer, not a feature of this.
#
# Authentication. A key is used where one already works. Otherwise the root
# password gets one login, which is spent installing the public key, and every
# login after that is by key.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST=""
DOMAIN=""
NO_DOMAIN=0
EMAIL=""
PASSWORD_FILE=""
ROOT_PASSWORD_FILE=""
# The new setting wins; the former name remains a permanent fallback.
SSH_KEY="${JOTPANEL_SSH_KEY:-${ARCA_SSH_KEY:-$HOME/.ssh/id_ed25519_arca}}"
[[ -f "$SSH_KEY" ]] || SSH_KEY="$HOME/.ssh/id_ed25519_jotnotes"
CERT_STAGING=0
WITH_RESIDENT=0
SHELL_MODE=""
INSTALL_DIR="/opt/jotpanel"
KEEP_BUNDLE=0
UPGRADE=0

die() { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --password-file) PASSWORD_FILE="${2:-}"; shift 2 ;;
    --root-password-file) ROOT_PASSWORD_FILE="${2:-}"; shift 2 ;;
    --key) SSH_KEY="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --shell) SHELL_MODE="${2:-}"; shift 2 ;;
    # The installer supports a box with no name: it answers on the address with
    # a certificate it makes itself, and a domain is attached later from inside.
    # This wrapper could not ask for that, so a bare-IP install, which is a
    # supported way to run the product, was the one path the harness could not
    # exercise. Found while building the regression box on 2026-08-29.
    --no-domain) NO_DOMAIN=1; shift ;;
    --cert-staging) CERT_STAGING=1; shift ;;
    # The installer can bring the local engine with it and bind it to loopback,
    # which is the shape every education deployment wants and the one this
    # wrapper had no way to ask for. Found while building the first Brilliant
    # demo box on 2026-08-30.
    --with-resident) WITH_RESIDENT=1; shift ;;
    --keep-bundle) KEEP_BUNDLE=1; shift ;;
    # An installed box is moved to this tree's release instead of installed.
    --upgrade) UPGRADE=1; shift ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$HOST" ]] || die "--host is required."
[[ -n "$DOMAIN" || $NO_DOMAIN -eq 1 || $UPGRADE -eq 1 ]] || die "--domain is required, or --no-domain to install on the machine's address."
[[ -n "$EMAIL" || $UPGRADE -eq 1 ]] || die "--email is required."
[[ $UPGRADE -eq 1 || ( -n "$PASSWORD_FILE" && -f "$PASSWORD_FILE" ) ]] || die "--password-file must point at a file holding the panel owner password."
[[ -f "$SSH_KEY" ]] || die "SSH key $SSH_KEY not found."
[[ -f "$SSH_KEY.pub" ]] || die "SSH public key $SSH_KEY.pub not found."

# ServerAliveInterval is not a nicety here, it is the difference between a run
# that fails and a run that hangs. An install takes twenty minutes and the
# machine restarts its own ssh daemon partway through when unattended-upgrades
# lands an openssh update, which drops the session without telling this end.
# Without a keepalive the client waits on a socket nobody will ever answer.
#
# That happened on 2026-08-29: the desktop install finished on the box, every
# unit came up, the panel answered, and the matrix sat behind a dead connection
# for over two hours and never ran its last flavour. Three minutes of silence is
# now a failure that can be reported instead of a wait nobody can see.
SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/known_hosts")

# ── Reach the machine ────────────────────────────────────────────────
step "Reaching root@$HOST"
# A rebuilt box keeps the address and changes the host key, so the stale entry
# is dropped rather than left to fail the connection with a scary warning.
ssh-keygen -R "$HOST" >/dev/null 2>&1 || true

if ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" -o BatchMode=yes "root@$HOST" true 2>/dev/null; then
  printf '   key already accepted\n'
else
  [[ -n "$ROOT_PASSWORD_FILE" && -f "$ROOT_PASSWORD_FILE" ]] \
    || die "The key was refused and no --root-password-file was given, so there is no way in."
  command -v sshpass >/dev/null || die "sshpass is needed for the first password login (brew install sshpass)."
  printf '   installing the public key with the root password\n'
  SSHPASS="$(cat "$ROOT_PASSWORD_FILE")" sshpass -e ssh "${SSH_OPTS[@]}" \
    -o PreferredAuthentications=password -o PubkeyAuthentication=no "root@$HOST" \
    'install -d -m 700 /root/.ssh && cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys' \
    < "$SSH_KEY.pub"
  ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" -o BatchMode=yes "root@$HOST" true \
    || die "The public key was copied but key login still fails."
  printf '   key installed\n'
fi

remote() { ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@$HOST" "$@"; }

# Let the machine finish being born before installing anything on it.
#
# A freshly provisioned image spends its first minutes on its own work:
# cloud-init finishes, and the distribution runs its first unattended upgrade.
# If that upgrade takes openssh, sshd restarts and every session in flight is
# cut. Installing lands in exactly that window, and on 2026-08-29 it cost a
# distro matrix three flavours in one night: an scp closed partway through
# Debian 13, a connection reset partway through Ubuntu 26.04, and a session that
# died silently during a desktop install and left the run hanging for two hours
# on a box that was sitting there finished.
#
# Neither wait is fatal. A machine that never settles is installed on anyway,
# because refusing would be worse than racing, and what happened is printed so
# the log can say so afterwards.
step "Letting the machine finish its own first boot"
if [[ "$(remote 'command -v cloud-init >/dev/null && echo yes || echo no' 2>/dev/null)" == "yes" ]]; then
  remote 'cloud-init status --wait >/dev/null 2>&1 || true' || true
  printf '   cloud-init: %s\n' "$(remote 'cloud-init status 2>/dev/null | head -1' || echo 'did not answer')"
fi
waited=0
for _ in $(seq 1 60); do
  # `pgrep -x unattended-upgr` was the test here, and it never came back free on
  # Ubuntu. The kernel truncates a process name to fifteen characters, so the
  # real upgrader and `unattended-upgrade-shutdown --wait-for-signal` — a daemon
  # that waits for a shutdown that is not coming — are both called
  # `unattended-upgr`. Every install therefore sat out the full ten-minute
  # timeout waiting for something that had finished, or had never started.
  #
  # The lock is the honest question anyway: what matters is not whether a
  # process with a particular name exists, but whether the package system is
  # busy. So the lock is asked first, and the name check now looks at the whole
  # command line and excludes the waiter.
  busy="$(remote 'if command -v fuser >/dev/null && fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then echo busy; elif pgrep -a unattended-upgrade 2>/dev/null | grep -v shutdown | grep -q .; then echo busy; else echo free; fi' 2>/dev/null || echo free)"
  [[ "$busy" == "busy" ]] || break
  waited=1
  sleep 10
done
if [[ $waited -eq 1 ]]; then
  printf '   waited for the machine to finish its own package work\n'
else
  printf "   nothing of the machine's own was still running\n"
fi

printf '   %s\n' "$(remote 'cat /etc/os-release | grep ^PRETTY_NAME= | cut -d= -f2- | tr -d \"')"

# ── Build the release ────────────────────────────────────────────────
step "Building the release bundle"
# One fixed path meant several installs running at once all built into the same
# file and read each other's half-written bundle, which surfaced as a checksum
# mismatch on whichever machine lost the race. JOTPANEL_BUNDLE lets a caller give
# each run its own; the former ARCA_BUNDLE spelling remains a fallback.
BUNDLE="${JOTPANEL_BUNDLE:-${ARCA_BUNDLE:-$ROOT_DIR/dist/jotpanel.tar.gz}}"
mkdir -p "$ROOT_DIR/dist"
"$SCRIPT_DIR/build-customer-bundle.sh" "$BUNDLE" >/dev/null
BUNDLE_SHA="$(awk '{print $1}' "$BUNDLE.sha256")"
printf '   %s  %s\n' "$(du -h "$BUNDLE" | cut -f1)" "$BUNDLE_SHA"

# ── Ship it ──────────────────────────────────────────────────────────
step "Copying the release and the installer"
# The remote name is fixed even when the local one is not. Copying into a
# directory keeps the local basename, so a caller giving the bundle its own path
# — which is how several installs run at once without overwriting each other —
# landed a file the installer was not looking for.
scp -i "$SSH_KEY" "${SSH_OPTS[@]}" -q "$BUNDLE" "root@$HOST:/root/jotpanel.tar.gz"
scp -i "$SSH_KEY" "${SSH_OPTS[@]}" -q "$BUNDLE.sha256" "root@$HOST:/root/jotpanel.tar.gz.sha256"
scp -i "$SSH_KEY" "${SSH_OPTS[@]}" -q "$ROOT_DIR/app/deploy/install.sh" "root@$HOST:/root/"
if [[ $UPGRADE -eq 1 ]]; then
  step "Upgrading the installed panel"
  scp -i "$SSH_KEY" "${SSH_OPTS[@]}" -q "$ROOT_DIR/app/deploy/upgrade.sh" "root@$HOST:/root/"
  set +e
  remote "bash /root/upgrade.sh --bundle-file /root/jotpanel.tar.gz --bundle-sha256 $BUNDLE_SHA --install-dir $(printf '%q' "$INSTALL_DIR")"
  STATUS=$?
  set -e
  [[ $KEEP_BUNDLE -eq 1 ]] || rm -f "$BUNDLE" "$BUNDLE.sha256"
  [[ $STATUS -eq 0 ]] || die "The upgrade did not complete (exit $STATUS). Read the output above; the box is on whichever release answered."
  exit 0
fi
scp -i "$SSH_KEY" "${SSH_OPTS[@]}" -q "$PASSWORD_FILE" "root@$HOST:/root/.jotpanel-owner-password"
remote 'chmod 600 /root/.jotpanel-owner-password'

# ── One command, on the box ──────────────────────────────────────────
step "Running the installer"
INSTALL_FLAGS=(--email "$EMAIL" --install-dir "$INSTALL_DIR"
               --bundle-file /root/jotpanel.tar.gz --bundle-sha256 "$BUNDLE_SHA"
               --non-interactive)
# No --domain at all rather than an empty one, because that is what the
# installer reads as "install on the address".
[[ $NO_DOMAIN -eq 1 ]] || INSTALL_FLAGS+=(--domain "$DOMAIN")
[[ $CERT_STAGING -eq 1 ]] && INSTALL_FLAGS+=(--cert-staging)
[[ -n "$SHELL_MODE" ]] && INSTALL_FLAGS+=(--shell "$SHELL_MODE")
[[ $WITH_RESIDENT -eq 1 ]] && INSTALL_FLAGS+=(--with-resident)

set +e
ssh -i "$SSH_KEY" "${SSH_OPTS[@]}" "root@$HOST" \
  "JOTPANEL_OWNER_PASSWORD=\$(cat /root/.jotpanel-owner-password) bash /root/install.sh $(printf '%q ' "${INSTALL_FLAGS[@]}"); rc=\$?; shred -u /root/.jotpanel-owner-password 2>/dev/null || rm -f /root/.jotpanel-owner-password; exit \$rc"
STATUS=$?
set -e

[[ $KEEP_BUNDLE -eq 1 ]] || rm -f "$BUNDLE" "$BUNDLE.sha256"

if [[ $STATUS -ne 0 ]]; then
  printf '\n  The installer exited %s. The box was NOT left in a working state.\n' "$STATUS"
  printf '  Rebuild the machine before the next attempt; a half-installed box proves nothing.\n\n'
  exit "$STATUS"
fi

step "Installed"
printf '   https://%s\n\n' "${DOMAIN:-$HOST}"
