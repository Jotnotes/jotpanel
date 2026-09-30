#!/usr/bin/env bash
# JotPanel one-command installer
#
#   curl -fsSLo jotpanel-install https://downloads.example/jotpanel-install
#   sudo bash jotpanel-install --domain panel.example.com --email owner@example.com
#
# Or, where the release archive is already on the machine:
#
#   sudo bash jotpanel-install --bundle-file ./jotpanel-panel.tar.gz \
#        --domain panel.example.com --email owner@example.com
#
# The panel installs and works without registration. Registration is offered in
# the panel later and only enables the optional connection to a thinking service.
#
# Two halves get installed, not one. The panel runs as an unprivileged user and
# has no way to become root; every privileged operation goes to a separate
# root-owned service reachable only over a Unix socket, which accepts named
# jobs from a fixed catalogue and nothing else. Installing the panel without
# that service produces a panel where the firewall, packages, mail, databases,
# sites and certificates all report themselves unavailable, so this installer
# treats the socket as part of a successful install rather than an extra.

set -Eeuo pipefail
umask 077

# Settings installed before the rename remain a permanent read-only input.
# Copy them into the new namespace only when the operator did not provide the
# new name. Everything written below is JOTPANEL_*.
while IFS='=' read -r legacy_name legacy_value; do
  case "$legacy_name" in
    ARCA_*)
      current_name="JOTPANEL_${legacy_name#ARCA_}"
      if ! declare -p "$current_name" >/dev/null 2>&1; then
        printf -v "$current_name" '%s' "$legacy_value"
        export "$current_name"
      fi
      ;;
  esac
done < <(env)

VERSION="1.2.0"
INSTALL_DIR="${JOTPANEL_INSTALL_DIR:-/opt/jotpanel}"
BUNDLE_URL="${JOTPANEL_BUNDLE_URL:-}"
BUNDLE_FILE="${JOTPANEL_BUNDLE_FILE:-}"
BUNDLE_SHA256="${JOTPANEL_BUNDLE_SHA256:-}"
# The published installer names its own release here, so the one-line install
# needs no bundle flag. Empty in the source tree; the release step fills it in.
RELEASE_BUNDLE_URL=""
LICENSE_URL="${JOTPANEL_LICENSE_URL:-https://license.jotnotes.com}"
# Empty on purpose, not a documentation domain. `server.js` branches on this
# variable being SET rather than on it being reachable, so writing a
# placeholder here turned every shipped panel into one that routes its
# thinking to a host that does not exist, instead of one that runs locally.
# Unset is the correct state for a free panel: the engine runs on the box.
THINKING_URL="${JOTPANEL_THINKING_URL:-}"
OPS_GROUP="jotpanel-ops"
OPS_SOCKET="/run/jotpanel-ops/ops.sock"
DOMAIN=""
NO_DOMAIN=0
PUBLIC_IP=""
OWNER_EMAIL=""
LICENSE_KEY=""
JSON_OUT=""
GENERATED_PASSWORD=0
OWNER_PASSWORD="${JOTPANEL_OWNER_PASSWORD:-}"
WITH_RESIDENT=0
CERT_STAGING=0
# Swap is made when there is none, because on a small box its absence is what
# turns a busy minute into the kernel killing the database. An administrator who
# manages swap themselves turns it off.
PROVISION_SWAP=1
SWAPFILE="${JOTPANEL_SWAPFILE:-/swapfile}"
# This is the panel installer, so it installs the panel. --shell desktop is
# the same install with the optional desktop shell in front of it; nothing else
# about the box changes, which is what makes the upgrade a one-line switch.
SHELL_MODE="${JOTPANEL_SHELL:-panel}"
# Nobody at the keyboard is the normal case for an installer: a hosting company
# runs this from its own provisioning, over ssh, or from a machine image. Asking
# `read` for a password there does not prompt anybody, it fails, and the script
# died claiming the panel was not ready when nothing had been installed yet.
NON_INTERACTIVE=0
[[ -t 0 ]] || NON_INTERACTIVE=1
TMP_DIR=""
NODE_BIN=""
FIREWALL_PROBE="not_checked"
LOG_PROBE="not_checked"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!!] %s\n' "$*"; }
die()  { printf '\n  ERROR: %s\n\n' "$*" >&2; exit 1; }

# ── Machine preflight ────────────────────────────────────────────────────────
#
# The published minimums are in docs/PANEL_SYSTEM_REQUIREMENTS.md and the
# messages below have to agree with that page, because a person reading the
# website and a person reading this output are the same person twenty minutes
# apart. Three tiers, not one number: the panel alone is small, and what fills a
# machine is the stacks it installs on demand.
#
# Everything here is a function taking its readings from overridable places, so
# the preflight tests can run it against a fake 1, 2 or 4 GB machine without a
# VPS and without root. `scripts/test-preflight.sh` is the caller.

# What a machine reports is not what it was sold as. A 1 GB instance reports
# about 955 MB once the kernel and firmware have taken their share, so a floor
# of 1024 refuses exactly the machines the published 1 GB minimum describes.
# Each floor is the sold size less about five per cent.
RAM_FLOOR_MB=950        # published as 1 GB — the panel by itself
RAM_HOSTING_MB=1950     # published as 2 GB — websites, PHP and databases
RAM_FULL_MB=3900        # published as 4 GB — the above plus mail, DNS and spam filtering
SWAP_MAX_MB=4096
DISK_FLOOR_MB=4096

read_meminfo_mb() { # field
  local file="${JOTPANEL_MEMINFO:-/proc/meminfo}"
  awk -v want="$1" '$1 == want":" {printf "%d", $2/1024; found=1} END {if (!found) print 0}' "$file"
}

read_ram_mb()  { if [[ -n "${JOTPANEL_FAKE_RAM_MB:-}"  ]]; then printf '%s' "$JOTPANEL_FAKE_RAM_MB";  else read_meminfo_mb MemTotal;  fi; }
read_swap_mb() { if [[ -n "${JOTPANEL_FAKE_SWAP_MB:-}" ]]; then printf '%s' "$JOTPANEL_FAKE_SWAP_MB"; else read_meminfo_mb SwapTotal; fi; }

read_disk_mb() { # directory
  if [[ -n "${JOTPANEL_FAKE_DISK_MB:-}" ]]; then printf '%s' "$JOTPANEL_FAKE_DISK_MB"; return; fi
  df -Pm "$1" | awk 'NR==2 {print $4}'
}

read_fstype() { # directory
  if [[ -n "${JOTPANEL_FAKE_FSTYPE:-}" ]]; then printf '%s' "$JOTPANEL_FAKE_FSTYPE"; return; fi
  df -PT "$1" 2>/dev/null | awk 'NR==2 {print $2}'
}

in_container() {
  if [[ -n "${JOTPANEL_FAKE_CONTAINER:-}" ]]; then [[ "$JOTPANEL_FAKE_CONTAINER" == "1" ]]; return; fi
  [[ -d /proc/vz && ! -d /proc/bc ]] && return 0
  command -v systemd-detect-virt >/dev/null 2>&1 && systemd-detect-virt --container --quiet
}

# Refuse a machine that cannot run the panel, and tell a machine that can run
# the panel what it cannot yet run. Saying "you have enough for this and not for
# that" up front is cheaper than the support ticket in month three, when the box
# has grown a mail stack and started killing MariaDB.
check_ram() { # ram_mb
  local ram="$1"
  if [[ "$ram" -lt "$RAM_FLOOR_MB" ]]; then
    die "At least 1 GB of RAM is required and this machine reports ${ram} MB.
       The published minimums are 1 GB for the panel by itself, 2 GB to host
       websites with PHP and databases, and 4 GB to add mail, DNS and spam
       filtering."
  fi
  if [[ "$ram" -lt "$RAM_HOSTING_MB" ]]; then
    ok "${ram} MB RAM, which is enough for the panel itself"
    say "Hosting websites with PHP and databases wants 2 GB, and adding mail, DNS and spam filtering wants 4 GB."
  elif [[ "$ram" -lt "$RAM_FULL_MB" ]]; then
    ok "${ram} MB RAM, which is enough for websites, PHP and databases"
    say "Adding mail, DNS and spam filtering wants 4 GB."
  else
    ok "${ram} MB RAM, which is enough for the full stack including mail"
  fi
}

# Swap matters more than the RAM figure on a small box. Without it a memory
# spike does not slow the machine, it makes the kernel kill the largest process,
# which is usually the database or the panel, and the owner experiences that as
# JotPanel crashing at random.
#
# So it is created when it is absent and safe to create, and where it is not
# safe the installer says so and carries on. A missing swap file is a warning
# and never a reason to refuse an install.
ensure_swap() { # ram_mb disk_mb install_parent
  local ram="$1" disk="$2" parent="$3"
  local swap; swap="$(read_swap_mb)"

  if [[ "$swap" -gt 0 ]]; then
    if [[ "$swap" -lt $((ram / 2)) ]]; then
      ok "${swap} MB of swap is configured"
      say "That is well under this machine's ${ram} MB of memory. The recommendation is swap at least equal to RAM."
    else
      ok "${swap} MB of swap is configured"
    fi
    return 0
  fi

  if [[ $PROVISION_SWAP -eq 0 ]]; then
    warn "No swap is configured and --no-swap was given, so none was made."
    return 0
  fi

  local size="$ram"
  [[ "$size" -gt "$SWAP_MAX_MB" ]] && size="$SWAP_MAX_MB"

  # Every reason not to touch the machine, each said plainly rather than
  # failing quietly, because a warning nobody can act on is noise.
  local fstype; fstype="$(read_fstype "$parent")"
  if in_container; then
    warn "No swap is configured, and this looks like a container where the host controls swap. Ask your provider to add ${size} MB."
    return 0
  fi
  case "$fstype" in
    ext2|ext3|ext4|xfs) ;;
    "") warn "No swap is configured and the filesystem type could not be read, so none was made. Add ${size} MB by hand."; return 0 ;;
    *)  warn "No swap is configured and ${fstype} needs a swap file made its own way, so none was made. Add ${size} MB by hand."; return 0 ;;
  esac
  if [[ -e "$SWAPFILE" ]]; then
    warn "No swap is active but $SWAPFILE already exists, so it was left alone. Check it by hand: swapon $SWAPFILE"
    return 0
  fi
  if [[ $((disk - size)) -lt "$DISK_FLOOR_MB" ]]; then
    warn "No swap is configured and there is not enough disk to add ${size} MB while keeping ${DISK_FLOOR_MB} MB free for the install. Add swap by hand once there is room."
    return 0
  fi

  if [[ -n "${JOTPANEL_SWAP_DRY_RUN:-}" ]]; then
    ok "would create ${size} MB of swap at $SWAPFILE on ${fstype}"
    return 0
  fi

  say "No swap is configured. Creating ${size} MB at $SWAPFILE."
  # xfs hands back unwritten extents that swapon refuses, so only ext gets the
  # fast path. Writing a gigabyte of zeroes is slower and always works.
  local made=0
  if [[ "$fstype" == xfs ]]; then
    dd if=/dev/zero of="$SWAPFILE" bs=1M count="$size" status=none 2>/dev/null && made=1
  else
    fallocate -l "${size}M" "$SWAPFILE" 2>/dev/null && made=1
    [[ $made -eq 1 ]] || { dd if=/dev/zero of="$SWAPFILE" bs=1M count="$size" status=none 2>/dev/null && made=1; }
  fi
  if [[ $made -eq 1 ]] \
     && chmod 600 "$SWAPFILE" \
     && mkswap "$SWAPFILE" >/dev/null 2>&1 \
     && swapon "$SWAPFILE" 2>/dev/null; then
    # Only persist something that is demonstrably working, and never twice.
    grep -qs "^${SWAPFILE}[[:space:]]" /etc/fstab || printf '%s none swap sw 0 0\n' "$SWAPFILE" >> /etc/fstab
    ok "${size} MB of swap created and active"
    return 0
  fi

  # Leave nothing half-made behind.
  swapoff "$SWAPFILE" 2>/dev/null || true
  rm -f -- "$SWAPFILE"
  warn "No swap is configured and it could not be created here, so the install continues without it. Add ${size} MB by hand before this machine carries real load."
  return 0
}

# ── Readiness ────────────────────────────────────────────────────────────────
#
# Asking a service whether it is up, without mistaking a service that is still
# coming up for one that is broken.
#
# This was earned on a real 1 GB box (docs/PANEL_PREFLIGHT_VERIFICATION.md §6).
# `systemctl reload nginx` returns when the reload has been ACCEPTED, not when
# the new listener is bound, so the curl on the very next line reached a socket
# nobody was listening on yet and the installer declared a working machine
# broken. The tell was `after 0 ms`: an instant refusal rather than a timeout.
#
# The answer was already in this file, in step 7, which waits for the panel's
# own port and is why that step survived the same box. It was written once and
# applied in one place. This is that idea made general, with the one thing it
# lacked: knowing which failures are worth waiting through and which are final.
#
# Waiting is for a service that has not finished starting: nothing listening
# yet, a reset mid-handshake, or nginx answering 502 and 503 because the thing
# behind it is still booting. Everything else is a real answer and is returned
# at once, because retrying a certificate that does not verify, a name that
# does not resolve or a 404 from a server that is plainly running turns a clear
# error into a minute of silence followed by a worse one.
READY_TIMEOUT="${JOTPANEL_READY_TIMEOUT:-90}"
READY_INTERVAL="${JOTPANEL_READY_INTERVAL:-1}"

# Is a unit in the failed state right now? A service that has given up is not
# going to start during the window, so waiting out the clock helps nobody.
service_failed() { # unit...
  command -v systemctl >/dev/null 2>&1 || return 1
  local unit
  for unit in "$@"; do
    [[ -n "$unit" ]] || continue
    if systemctl is-failed --quiet "$unit" 2>/dev/null; then printf '%s' "$unit"; return 0; fi
  done
  return 1
}

# wait_for_http URL DESCRIPTION [--insecure] [--units "a b"]
#
# Returns 0 as soon as the URL answers 2xx. Returns 1 with READY_ERROR set to
# the last useful reason, which the caller puts in its own message, so a failure
# still says what went wrong rather than only that time ran out.
READY_ERROR=""
READY_ATTEMPTS=0
wait_for_http() {
  local url="$1" description="$2"; shift 2
  local insecure=0 units=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --insecure) insecure=1; shift ;;
      --units) units="${2:-}"; shift 2 ;;
      *) shift ;;
    esac
  done

  local curl_args=(-sS -o /dev/null -w '%{http_code}' --max-time 10)
  [[ $insecure -eq 1 ]] && curl_args+=(-k)

  local deadline=$(( SECONDS + READY_TIMEOUT ))
  local code status failed_unit
  READY_ERROR=""
  READY_ATTEMPTS=0

  while :; do
    READY_ATTEMPTS=$(( READY_ATTEMPTS + 1 ))
    # `set -e` must not end the installer on a curl that was always going to
    # fail on the first try, so the exit status is captured rather than thrown.
    code="$(curl "${curl_args[@]}" "$url" 2>/dev/null)" && status=0 || status=$?

    if [[ $status -eq 0 ]]; then
      case "$code" in
        2*) return 0 ;;
        # The server is up and the thing behind it is not, which is the reboot
        # case: nginx answers while the panel is still starting.
        502|503|504) READY_ERROR="$url answered $code, so the service behind it is still starting" ;;
        # Anything else is a real answer from a working server. A 404 on a
        # health path is a configuration fault and no amount of waiting fixes it.
        *) READY_ERROR="$url answered $code"; return 1 ;;
      esac
    else
      case $status in
        # Nothing listening yet, timed out, or the connection dropped
        # mid-exchange. All three are what a service that is still binding its
        # socket looks like from outside.
        7)  READY_ERROR="nothing is listening on $url yet" ;;
        28) READY_ERROR="$url did not answer in time" ;;
        56|52) READY_ERROR="the connection to $url was reset before it answered" ;;
        # Final, every one of them. A name that does not resolve, a handshake
        # that cannot be made, a certificate that does not verify: these are the
        # answers, not the absence of one.
        6)  READY_ERROR="the name in $url does not resolve"; return 1 ;;
        35) READY_ERROR="the TLS handshake with $url failed"; return 1 ;;
        60) READY_ERROR="the certificate presented by $url did not verify"; return 1 ;;
        *)  READY_ERROR="curl gave up on $url with error $status" ;;
      esac
    fi

    if [[ -n "$units" ]] && failed_unit="$(service_failed $units)"; then
      READY_ERROR="$failed_unit has entered the failed state ($READY_ERROR)"
      return 1
    fi

    if [[ $SECONDS -ge $deadline ]]; then
      READY_ERROR="${description} did not become ready within ${READY_TIMEOUT}s: ${READY_ERROR}"
      return 1
    fi
    sleep "$READY_INTERVAL"
  done
}

# Sourced by scripts/test-preflight.sh and scripts/test-readiness.sh, which run
# the functions above against fake machines and fake servers. Nothing below this
# line executes in that mode, so the tests exercise the real code rather than a
# copy of it that can drift.
if [[ -n "${JOTPANEL_INSTALLER_LIB:-}" ]]; then return 0 2>/dev/null || exit 0; fi

cleanup() {
  if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then rm -rf -- "$TMP_DIR"; fi
}
trap cleanup EXIT
# Every failure used to be reported as the panel not being ready, including the
# ones that happened before anything was installed. Say where it stopped and let
# the output above say why.
trap 'die "Installation stopped at line $LINENO. The output above says why."' ERR

usage() {
  sed -n '2,25p' "$0"
  cat <<'EOF'

Options:
  --domain NAME          DNS name for the panel (required)
  --email ADDRESS        Owner login and certificate email (required)
  --password VALUE       Initial owner password (prompted if omitted)
  --bundle-url URL       Release bundle URL
  --bundle-file PATH     Release bundle already on this machine
  --bundle-sha256 HASH   Expected release SHA-256 (otherwise URL.sha256 is used)
  --install-dir PATH     Install location (default /opt/jotpanel)
  --shell panel|desktop  Which face to serve at / (default: panel)
  --cert-staging         Issue from the Let's Encrypt staging authority. The
                         certificate will not be trusted by a browser. For
                         repeated installs onto the same name, which the real
                         authority rate-limits.
  --with-resident        Install Ollama and force it to loopback-only
  --no-swap              Do not create a swap file when the machine has none.
                         Swap is otherwise made to match RAM, up to 4 GB,
                         because without it a memory spike makes the kernel
                         kill the largest process rather than slow the machine
                         down.
  --non-interactive      Refuse missing values instead of prompting. The
                         password is generated when it is omitted, so a
                         provisioning system never has to invent one.
  --license-key VALUE    Licence key, written to the install config
  --json PATH            Write a machine-readable result, including the
                         single-use sign-in link, for a provisioning system
                         to read
  --help                 Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) OWNER_EMAIL="${2:-}"; shift 2 ;;
    --password) OWNER_PASSWORD="${2:-}"; shift 2 ;;
    --bundle-url) BUNDLE_URL="${2:-}"; shift 2 ;;
    --bundle-file) BUNDLE_FILE="${2:-}"; shift 2 ;;
    --bundle-sha256) BUNDLE_SHA256="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --shell) SHELL_MODE="${2:-}"; shift 2 ;;
    --cert-staging) CERT_STAGING=1; shift ;;
    --with-resident) WITH_RESIDENT=1; shift ;;
    --no-swap) PROVISION_SWAP=0; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --license-key) LICENSE_KEY="${2:-}"; shift 2 ;;
    --json) JSON_OUT="${2:-}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ -n "$BUNDLE_URL" || -n "$BUNDLE_FILE" ]] || BUNDLE_URL="$RELEASE_BUNDLE_URL"

[[ $EUID -eq 0 ]] || die "Run this installer as root (sudo bash jotpanel-install ...)."
[[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != "/" ]] || die "--install-dir must be an absolute path other than /."

# An installer invocation on a pre-rename box is an upgrade, not a refusal.
# Use the upgrader carried by the release being installed so the migration and
# the application code are one transaction.
if [[ "$INSTALL_DIR" == "/opt/jotpanel" && -f /opt/arca/app/backend/server.js && -f /opt/arca/.env ]]; then
  legacy_tmp="$(mktemp -d /tmp/jotpanel-legacy-upgrade.XXXXXX)"
  trap 'rm -rf -- "$legacy_tmp"' EXIT
  legacy_bundle="$BUNDLE_FILE"
  if [[ -z "$legacy_bundle" ]]; then
    [[ -n "$BUNDLE_URL" ]] || die "Supply the release with --bundle-url or --bundle-file."
    legacy_bundle="$legacy_tmp/jotpanel.tar.gz"
    curl -fL --retry 3 --connect-timeout 15 "$BUNDLE_URL" -o "$legacy_bundle"
    if [[ -z "$BUNDLE_SHA256" ]]; then
      curl -fL --retry 3 --connect-timeout 15 "${BUNDLE_URL}.sha256" -o "$legacy_tmp/jotpanel.sha256"
      BUNDLE_SHA256="$(awk 'NR==1 {print $1}' "$legacy_tmp/jotpanel.sha256")"
    fi
  elif [[ -z "$BUNDLE_SHA256" && -f "${legacy_bundle}.sha256" ]]; then
    BUNDLE_SHA256="$(awk 'NR==1 {print $1}' "${legacy_bundle}.sha256")"
  fi
  tar -xOf "$legacy_bundle" app/deploy/upgrade.sh > "$legacy_tmp/upgrade.sh" \
    || die "The release does not contain its JotPanel upgrader."
  tar -xOf "$legacy_bundle" app/deploy/migrate-layout.sh > "$legacy_tmp/migrate-layout.sh" \
    || die "The release does not contain its JotPanel layout migration."
  chmod 0700 "$legacy_tmp/upgrade.sh"
  upgrade_args=(--bundle-file "$legacy_bundle")
  [[ -n "$BUNDLE_SHA256" ]] && upgrade_args+=(--bundle-sha256 "$BUNDLE_SHA256")
  exec bash "$legacy_tmp/upgrade.sh" "${upgrade_args[@]}"
fi

# The licence address is the one setting a shipped panel cannot work out for
# itself, and a release once carried a documentation domain here that never
# answered, so every install failed its licence calls with an error that read
# like a licensing problem. Refuse to write an address that cannot be one:
# a reserved documentation name, or anything that is not https.
[[ "$LICENSE_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$ ]] \
  || die "JOTPANEL_LICENSE_URL must be an https address. This one is: $LICENSE_URL"
case "${LICENSE_URL#https://}" in
  *.example|*.example/*|*.example.com|*.example.com/*|*.invalid|*.invalid/*|*.test|*.test/*|*.localhost|*.localhost/*|localhost|localhost:*|127.0.0.1*|*.local|*.local/*)
    die "JOTPANEL_LICENSE_URL points at a reserved or local name that will never answer for a customer: $LICENSE_URL" ;;
esac

# And the same for the thinking address, which is not required and must not be
# invented. An address that is set and cannot answer is worse than none, because
# the panel then believes there is a service to reach.
if [[ -n "$THINKING_URL" ]]; then
  [[ "$THINKING_URL" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$ ]] \
    || die "JOTPANEL_THINKING_URL must be an https address. This one is: $THINKING_URL"
  case "${THINKING_URL#https://}" in
    *.example|*.example/*|*.example.com|*.example.com/*|*.invalid|*.invalid/*|*.test|*.test/*|*.localhost|*.localhost/*|localhost|localhost:*|127.0.0.1*|*.local|*.local/*)
      die "JOTPANEL_THINKING_URL points at a reserved or local name that will never answer: $THINKING_URL" ;;
  esac
fi

INSTALL_DIR="${INSTALL_DIR%/}"
if [[ -e "$INSTALL_DIR/app" || -e "$INSTALL_DIR/.env" ]]; then
  die "$INSTALL_DIR already contains a JotPanel install. Use upgrade.sh instead."
fi
[[ -n "$BUNDLE_URL" || -n "$BUNDLE_FILE" ]] || die "Supply the release with --bundle-url or --bundle-file."
[[ -z "$BUNDLE_FILE" || -f "$BUNDLE_FILE" ]] || die "--bundle-file $BUNDLE_FILE is not a file."

if [[ -z "$DOMAIN" && $NON_INTERACTIVE -eq 0 ]]; then read -rp "Panel domain (leave blank to use this machine's address): " DOMAIN; fi
if [[ -z "$OWNER_EMAIL" && $NON_INTERACTIVE -eq 0 ]]; then read -rp "Owner email: " OWNER_EMAIL; fi
if [[ -z "$OWNER_PASSWORD" && $NON_INTERACTIVE -eq 0 ]]; then
  read -rsp "Initial owner password (12+ characters): " OWNER_PASSWORD
  printf '\n'
fi
# Unattended, nobody is there to choose one, and a password a provisioning
# script invented would travel in that script's logs. Generate it here, hand
# the customer a sign-in link instead, and let them set their own from inside.
if [[ -z "$OWNER_PASSWORD" ]]; then
  OWNER_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  GENERATED_PASSWORD=1
fi
# A domain is not required to install. A machine has an address before it has
# a name, an image in a provider's marketplace cannot know the name at all, and
# refusing to install without one turns a two-minute setup into a DNS errand.
# Without a domain the panel answers on the address with a certificate it makes
# itself, and the domain is attached later from inside.
if [[ -n "$DOMAIN" ]]; then
  [[ "$DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || die "That is not a valid public domain. Leave --domain off to install without one."
else
  NO_DOMAIN=1
  PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$PUBLIC_IP" ]] || die "No domain was given and this machine's address could not be worked out. Pass --domain, or set it by hand afterwards."
  DOMAIN="$PUBLIC_IP"
  say "No domain given. The panel will answer on $PUBLIC_IP with its own certificate, and a domain can be attached from inside later."
fi
[[ "$SHELL_MODE" == "panel" || "$SHELL_MODE" == "desktop" ]] || die "--shell must be panel or desktop."
[[ "$OWNER_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "A valid owner email is required."
[[ ${#OWNER_PASSWORD} -ge 12 ]] || die "The initial owner password must be at least 12 characters."

case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "Unsupported architecture: $(uname -m). Supported: x86_64 and arm64." ;;
esac

if [[ -f /etc/debian_version ]]; then
  PKG_FAMILY="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_FAMILY="dnf"
else
  die "This release supports Ubuntu/Debian and current RHEL-family systems."
fi

command -v systemctl >/dev/null 2>&1 || die "This installer requires systemd."

TMP_DIR="$(mktemp -d /tmp/jotpanel-install.XXXXXX)"

step "JotPanel installer $VERSION"
say "Panel:     https://$DOMAIN"
say "Owner:     $OWNER_EMAIL"
say "Directory: $INSTALL_DIR"
say "Release:   ${BUNDLE_FILE:-$BUNDLE_URL}"
say "Registration is not part of installation and no licence server will be contacted."

step "1/9  Checking the machine"
INSTALL_PARENT="$(dirname "$INSTALL_DIR")"
RAM_MB="$(read_ram_mb)"
DISK_MB="$(read_disk_mb "$INSTALL_PARENT")"
check_ram "$RAM_MB"
[[ "$DISK_MB" -ge "$DISK_FLOOR_MB" ]] || die "At least 4 GB free is required; this filesystem reports ${DISK_MB} MB."
ok "${DISK_MB} MB free"
ensure_swap "$RAM_MB" "$DISK_MB" "$INSTALL_PARENT"

step "2/9  Installing system packages"
if [[ "$PKG_FAMILY" == "apt" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  # A freshly built Ubuntu box runs unattended-upgrades within a couple of
  # minutes of first boot, and it takes the dpkg lock. Without this the
  # installer loses that race and dies on "Could not get lock
  # /var/lib/dpkg/lock-frontend", which for a one-command install reads as the
  # product being broken rather than as two updaters wanting the same machine.
  # Watched both ways on a bare box: instant failure without it, apt printing
  # "Waiting for cache lock" and then carrying on with it.
  APT_WAIT=(-o DPkg::Lock::Timeout=900)
  # And do not restart the operator's own connection out from under them.
  #
  # needrestart runs after apt on Debian and Ubuntu and restarts every service
  # whose libraries moved. Its list includes ssh.service, so installing packages
  # over ssh kills the session the installer is running in. Caught in the act on
  # 2026-08-29, in the middle of this very step:
  #
  #   /etc/needrestart/restart.d/systemd-manager
  #   systemctl restart packagekit.service ssh.service systemd-journald.service …
  #
  # and the machine then refused connections while the installer's own session
  # was cut. A distro matrix lost three flavours to it before anybody saw why.
  # An operator would see the install freeze halfway with no error at all.
  #
  # `l` lists what wants restarting and restarts nothing, which is the right
  # behaviour for an installer: this script starts what it needs itself, and
  # anything else can wait for the reboot the operator chooses. NEEDRESTART_SUSPEND
  # covers the older versions that do not read the mode.
  export NEEDRESTART_MODE=l
  export NEEDRESTART_SUSPEND=1
  apt-get "${APT_WAIT[@]}" update -qq
  apt-get "${APT_WAIT[@]}" install -y -qq ca-certificates curl tar gzip openssl nginx certbot python3-certbot-nginx ufw sudo util-linux
  if ! command -v node >/dev/null 2>&1 || [[ "$(node --version | sed 's/^v//' | cut -d. -f1)" -lt 18 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x -o "$TMP_DIR/nodesource.sh"
    bash "$TMP_DIR/nodesource.sh"
    apt-get "${APT_WAIT[@]}" install -y -qq nodejs
  fi
else
  dnf install -y ca-certificates curl tar gzip openssl nginx certbot python3-certbot-nginx firewalld sudo util-linux nodejs npm
fi
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 18 ]] || die "Node.js 18 or newer is required; installed version is $(node --version)."
NODE_BIN="$(command -v node)"
# The unit files are rendered with this path. A relative or shell-resolved
# ExecStart is not valid in a unit, and systemd does not search PATH.
[[ "$NODE_BIN" == /* ]] || die "node resolved to a non-absolute path: $NODE_BIN"
command -v runuser >/dev/null 2>&1 || die "runuser is required to verify the panel's own access to the privileged socket."
ok "Node $(node --version) at $NODE_BIN, nginx and certbot installed"

step "3/9  Obtaining and verifying the release"
if [[ -n "$BUNDLE_FILE" ]]; then
  cp -- "$BUNDLE_FILE" "$TMP_DIR/jotpanel.tar.gz"
  BUNDLE_SOURCE="$BUNDLE_FILE"
  if [[ -z "$BUNDLE_SHA256" && -f "${BUNDLE_FILE}.sha256" ]]; then
    BUNDLE_SHA256="$(awk 'NR==1 {print $1}' "${BUNDLE_FILE}.sha256")"
  fi
else
  curl -fL --retry 3 --connect-timeout 15 "$BUNDLE_URL" -o "$TMP_DIR/jotpanel.tar.gz"
  BUNDLE_SOURCE="$BUNDLE_URL"
  if [[ -z "$BUNDLE_SHA256" ]]; then
    curl -fsSL --retry 3 "${BUNDLE_URL}.sha256" -o "$TMP_DIR/jotpanel.sha256" \
      || die "No bundle checksum was supplied and ${BUNDLE_URL}.sha256 could not be fetched."
    BUNDLE_SHA256="$(awk 'NR==1 {print $1}' "$TMP_DIR/jotpanel.sha256")"
  fi
fi
ACTUAL_SHA256="$(sha256sum "$TMP_DIR/jotpanel.tar.gz" | awk '{print $1}')"
if [[ -n "$BUNDLE_SHA256" ]]; then
  [[ "$BUNDLE_SHA256" =~ ^[a-fA-F0-9]{64}$ ]] || die "The bundle SHA-256 is malformed."
  [[ "${ACTUAL_SHA256,,}" == "${BUNDLE_SHA256,,}" ]] || die "Bundle checksum mismatch. Expected $BUNDLE_SHA256, received $ACTUAL_SHA256."
  CHECKSUM_STATE="verified against the supplied checksum"
else
  # A local file handed over by the operator is already inside the trust
  # boundary; recording what arrived is still worth doing.
  CHECKSUM_STATE="recorded, no expected checksum was supplied"
fi
if tar -tzf "$TMP_DIR/jotpanel.tar.gz" | awk 'BEGIN{bad=0} /^\//{bad=1} /(^|\/)\.\.($|\/)/{bad=1} END{exit bad?0:1}'; then
  die "The release archive contains an unsafe absolute or parent path."
fi
ok "Release archive $ACTUAL_SHA256 ($CHECKSUM_STATE)"

step "4/9  Installing the application"
# Two identities. jotpanel owns and runs the panel and can never become root. The
# jotpanel-ops group exists only to own the far end of the privileged socket, so
# membership of it is the entire grant the panel receives.
getent group "$OPS_GROUP" >/dev/null || groupadd --system "$OPS_GROUP"
NOLOGIN="$(command -v nologin || true)"; NOLOGIN="${NOLOGIN:-/usr/sbin/nologin}"
id jotpanel >/dev/null 2>&1 || useradd --system --home-dir "$INSTALL_DIR" --shell "$NOLOGIN" jotpanel
usermod --append --groups "$OPS_GROUP" jotpanel
id -nG jotpanel | tr ' ' '\n' | grep -x "$OPS_GROUP" >/dev/null || die "jotpanel was not added to the $OPS_GROUP group."
# The Logs screen reads nginx's files and the systemd journal. nginx writes
# www-data:adm 0640 and the journal is readable only by systemd-journal, and the
# panel user is in neither by default, so on a bare box the Logs section had
# nothing it could open. Both groups grant reading and nothing else, which is
# the whole of what that screen needs.
for LOG_GROUP in adm systemd-journal; do
  getent group "$LOG_GROUP" >/dev/null 2>&1 && usermod --append --groups "$LOG_GROUP" jotpanel
done
install -d -m 0750 -o jotpanel -g jotpanel "$INSTALL_DIR" "$INSTALL_DIR/staging" "$INSTALL_DIR/app" "$INSTALL_DIR/data" "$INSTALL_DIR/uploads" "$INSTALL_DIR/logs" "$INSTALL_DIR/backups"
tar -xzf "$TMP_DIR/jotpanel.tar.gz" -C "$INSTALL_DIR/app" --strip-components=1
[[ -f "$INSTALL_DIR/app/backend/server.js" ]] || die "Release layout is invalid: app/backend/server.js was not found."
[[ -f "$INSTALL_DIR/app/backend/ops-daemon.js" ]] || die "Release layout is invalid: app/backend/ops-daemon.js was not found."
npm ci --prefix "$INSTALL_DIR/app/backend" --omit=dev --no-audit --no-fund
npm ci --prefix "$INSTALL_DIR/app/frontend" --no-audit --no-fund
npm run build --prefix "$INSTALL_DIR/app/frontend"
install -d -m 0755 "$INSTALL_DIR/app/backend/public"
cp -R "$INSTALL_DIR/app/frontend/dist/." "$INSTALL_DIR/app/backend/public/"
chown -R jotpanel:jotpanel "$INSTALL_DIR"
ok "Backend dependencies and production frontend built"

step "5/9  Writing safe defaults"
JWT_SECRET="$(openssl rand -hex 32)"
ADMIN_KEY="$(openssl rand -hex 32)"
ENCRYPT_SECRET="$(openssl rand -hex 32)"
cat > "$INSTALL_DIR/.env" <<EOF
NODE_ENV=production
PORT=9999
JOTPANEL_BOOTSTRAP_PORT=9998
DOMAIN=$DOMAIN
JOTPANEL_PUBLIC_ORIGIN=https://$DOMAIN
JOTPANEL_VERSION=$VERSION
JOTPANEL_DATA_DIR=$INSTALL_DIR/data
UPLOADS_DIR=$INSTALL_DIR/uploads
JOTPANEL_JOB_ROOT=$INSTALL_DIR
JWT_SECRET=$JWT_SECRET
ADMIN_KEY=$ADMIN_KEY
JOTPANEL_ENCRYPT_SECRET=$ENCRYPT_SECRET
JOTPANEL_LICENSE_URL=$LICENSE_URL
${THINKING_URL:+JOTPANEL_THINKING_URL=$THINKING_URL}
JOTPANEL_SHELL=$SHELL_MODE
JOTPANEL_PROVISIONING_ADAPTER=native
JOTPANEL_OPS_SOCKET=$OPS_SOCKET
OLLAMA_BASE=http://127.0.0.1:11434/v1/chat/completions
MAX_UPLOAD_MB=1024
EOF
chmod 0600 "$INSTALL_DIR/.env"
chown jotpanel:jotpanel "$INSTALL_DIR/.env"

install -d -m 0755 /usr/local/lib/jotpanel
cat > /usr/local/lib/jotpanel/secure-local-engine <<'HELPER'
#!/usr/bin/env bash
set -Eeuo pipefail
# grep without -q reads the whole list: with pipefail, -q stops early and the
# pipeline reports failure, so the override below was never written.
if systemctl list-unit-files --type=service 2>/dev/null | grep '^ollama.service' >/dev/null; then
  install -d -m 0755 /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/jotpanel-loopback.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
EOF
  systemctl daemon-reload
  systemctl restart ollama
fi
if command -v ufw >/dev/null 2>&1; then ufw deny 11434/tcp >/dev/null || true; fi
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-port=11434/tcp >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
if command -v ss >/dev/null 2>&1 && ss -ltnH | awk '$4 ~ /(^|\]|:)11434$/ && $4 ~ /(0\.0\.0\.0|\[::\]|\*:)/ {bad=1} END{exit bad?0:1}'; then
  printf 'Ollama is still listening beyond loopback.\n' >&2
  exit 1
fi
HELPER
chmod 0755 /usr/local/lib/jotpanel/secure-local-engine
cat > /etc/sudoers.d/jotpanel-local-engine <<'EOF'
jotpanel ALL=(root) NOPASSWD: /usr/local/lib/jotpanel/secure-local-engine
EOF
chmod 0440 /etc/sudoers.d/jotpanel-local-engine
visudo -cf /etc/sudoers.d/jotpanel-local-engine >/dev/null

if [[ $WITH_RESIDENT -eq 1 ]]; then
  curl -fsSL https://ollama.com/install.sh -o "$TMP_DIR/ollama-install.sh"
  bash "$TMP_DIR/ollama-install.sh"
fi
/usr/local/lib/jotpanel/secure-local-engine
ok "Secrets generated; local engine set to loopback and blocked at the firewall"

step "6/9  Installing the privileged operations service"
# Every unit is rendered from a template in the release. Nothing here writes a
# path out by hand, because the installer and the units holding two different
# opinions about where JotPanel lives is exactly the defect this replaces.
render_unit() {
  local source="$INSTALL_DIR/app/deploy/$1" target="/etc/systemd/system/$2"
  [[ -f "$source" ]] || die "The release is missing the unit template $1."
  sed -e "s|@@INSTALL_DIR@@|$INSTALL_DIR|g" -e "s|@@NODE@@|$NODE_BIN|g" "$source" > "$target"
  chmod 0644 "$target"
  ! grep -q '@@' "$target" || die "The rendered unit $2 still contains an unsubstituted placeholder."
}
render_unit jotpanel-ops.service.template jotpanel-ops.service
render_unit 'jotpanel-oneshot@.service.template' 'jotpanel-oneshot@.service'
render_unit jotpanel.service.template jotpanel.service
install -d -m 0750 -o root -g "$OPS_GROUP" /var/lib/jotpanel-ops
# The mount point the privileged unit reads the kernel module directory
# through. ProtectKernelModules hides that directory from the unit, which
# made the folder usage figure short by the size of the installed kernels, so
# it is bound read-only under this second name. systemd needs the mount point
# to exist before it can bind anything onto it.
install -d -m 0750 -o root -g "$OPS_GROUP" /var/lib/jotpanel-ops/kernel-modules
# The directory the SSH key operations write into. Made here rather than by the
# job, because the privileged unit only reaches it through an explicit
# ReadWritePaths= line and systemd resolves that at start.
install -d -m 0700 -o root -g root /root/.ssh

# needrestart restarts every service touched by a library upgrade, and on this
# box that included the panel, in the middle of the panel's own update run. The
# request recording the outcome died with the process, so the machine was fully
# updated while the record still said approved and never executed. A control
# panel does not get to kill itself halfway through an action it is recording.
#
# The upgraded libraries do still need jotpanel to restart. That is what the reboot
# the panel already offers is for, and packages.status reports reboot_required
# so the operator is told.
if [[ -d /etc/needrestart ]]; then
  install -d -m 0755 /etc/needrestart/conf.d
  # blacklist_rc, not override_rc. override_rc only sets which services are
  # pre-selected in the interactive menu, and needrestart still restarted a
  # service that had it; blacklist_rc is the one that excludes. Checked both
  # ways on the box against a service needrestart did want to restart. The
  # push form appends rather than replacing, so this drop-in cannot silently
  # discard a list set anywhere else.
  cat > /etc/needrestart/conf.d/jotpanel.conf <<'NRCONF'
# Managed by the JotPanel installer.
push @{$nrconf{blacklist_rc}}, qr(^jotpanel\.service$), qr(^jotpanel-ops\.service$);
NRCONF
  chmod 0644 /etc/needrestart/conf.d/jotpanel.conf
fi
systemctl daemon-reload
systemctl enable --now jotpanel-ops.service
for _ in {1..30}; do [[ -S "$OPS_SOCKET" ]] && break; sleep 1; done
[[ -S "$OPS_SOCKET" ]] || die "The privileged operations service did not create $OPS_SOCKET. Run: journalctl -u jotpanel-ops -n 100"

ops_job() {
  # $1 caller (root or jotpanel), $2 job name. Prints the raw JSON reply.
  local caller="$1" job="$2"
  local payload; payload="$(printf '{"job":"%s","params":{}}' "$job")"
  if [[ "$caller" == "root" ]]; then
    curl -sS --max-time 30 --unix-socket "$OPS_SOCKET" -X POST http://localhost/v1/jobs \
      -H 'content-type: application/json' -d "$payload"
  else
    runuser -u "$caller" -- curl -sS --max-time 30 --unix-socket "$OPS_SOCKET" -X POST http://localhost/v1/jobs \
      -H 'content-type: application/json' -d "$payload"
  fi
}
ops_ok() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.exit(JSON.parse(s).ok===true?0:1)}catch{process.exit(1)}})'; }

ops_job root probe.service | ops_ok || die "The privileged operations service is running but did not answer probe.service."
# The check that actually matters. The panel runs as jotpanel, and an operations
# service only root can reach is a service the panel does not have.
PANEL_PROBE="$(ops_job jotpanel probe.service)"
printf '%s' "$PANEL_PROBE" | ops_ok \
  || die "The panel user cannot reach the privileged socket, so every privileged capability would report unavailable. Reply was: $PANEL_PROBE"
ok "Privileged operations service answering, and reachable by the unprivileged panel user"

# The firewall defect this release fixes: ufw needs root, the panel is not
# root, and the capability probe used to pass because the program was on disk.
# Asking the socket for the rule list as the panel user is the whole test.
FIREWALL_REPLY="$(ops_job jotpanel probe.firewall || true)"
if printf '%s' "$FIREWALL_REPLY" | ops_ok; then
  FIREWALL_PROBE="ok"
  ok "Firewall readable with panel privilege"
else
  FIREWALL_PROBE="failed"
  warn "The firewall is NOT readable with panel privilege. The panel will correctly hide the firewall tool rather than draw a button that cannot work. Reply: $FIREWALL_REPLY"
fi

# Same question again for the logs, because a section that reports itself
# available and then cannot open a file is the defect this installer exists to
# catch before the operator does.
if runuser -u jotpanel -- journalctl -n 1 --no-pager -q >/dev/null 2>&1; then
  LOG_PROBE="ok"
  ok "Journal readable with panel privilege"
else
  LOG_PROBE="failed"
  warn "The journal is NOT readable with panel privilege, so the panel will hide the journal rather than draw a tool that cannot work."
fi

step "7/9  Starting JotPanel behind nginx"
cat > /etc/nginx/conf.d/jotpanel.conf <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;

  client_max_body_size 1024m;
  location / {
    proxy_pass http://127.0.0.1:9999;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    # Long enough for the work the panel actually does. A backup or a database
    # import legitimately runs for tens of minutes, and a proxy that gives up at
    # five reports a running job to the browser as a gateway error. Operations
    # that leave a durable result hand off to the panel's watcher inside two
    # minutes and never come near this; these seconds are for the ones that
    # cannot, and must be watched to the end to be recorded at all.
    proxy_read_timeout 3900s;
    proxy_send_timeout 3900s;
  }
}
EOF
nginx -t
# nginx ships with Restart=no, so a crash leaves the site down until somebody
# notices. The panel is meant to be the thing that notices, and it cannot be if
# it went down with it, so nginx is told to come back on its own.
mkdir -p /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/restart.conf <<'UNIT'
[Service]
Restart=always
RestartSec=3
UNIT
systemctl daemon-reload

systemctl enable --now jotpanel nginx
# This step already waited, and it is why it survived the 1 GB box that broke
# step 8b. It now waits through the shared helper instead of its own loop, so
# there is one answer to "is it up yet" rather than two that can drift, and so
# this one also stops early when the unit has actually failed.
wait_for_http "http://127.0.0.1:9999/health" "JotPanel" --units "jotpanel" \
  || die "JotPanel did not pass its local health check: $READY_ERROR. Run: journalctl -u jotpanel -n 100"
ok "JotPanel is healthy on 127.0.0.1:9999"

step "8/9  Creating the one owner and certificate"
OWNER_JSON="$TMP_DIR/owner.json"
{
  printf '%s\0' "$OWNER_EMAIL"
  printf '%s\0' "$OWNER_PASSWORD"
} | node -e 'const fs=require("fs");const [email,password]=fs.readFileSync(0).toString().split("\0");fs.writeFileSync(process.argv[1],JSON.stringify({name:"Owner",email,password,plan:"owner",storageGB:100}),{mode:0o600})' "$OWNER_JSON"
ADMIN_HEADERS="$TMP_DIR/admin-headers.txt"
printf 'x-admin-key: %s\ncontent-type: application/json\n' "$ADMIN_KEY" > "$ADMIN_HEADERS"
chmod 0600 "$ADMIN_HEADERS"
wait_for_http "http://127.0.0.1:9998/health" "the bootstrap surface" --units "jotpanel" \
  || die "The bootstrap surface never answered on 127.0.0.1:9998. $READY_ERROR"

# Port 9998, not 9999. The bootstrap surface has its own listener bound to
# loopback and is not part of the app nginx proxies or the recovery port
# serves, so this call can only be made from the machine itself. It also
# refuses once any account exists: creating the second one is `account.create`
# in the panel, which puts it under a provider and inside a package.
CREATE_RESULT="$(curl -fsS -X POST http://127.0.0.1:9998/admin/api/accounts -H "@$ADMIN_HEADERS" --data-binary "@$OWNER_JSON")" \
  || die "The owner account could not be created."
node -e 'const d=JSON.parse(process.argv[1]);if(!d.userId)process.exit(1)' "$CREATE_RESULT" || die "The owner account response could not be verified: $CREATE_RESULT"

if [[ "$PKG_FAMILY" == "apt" ]]; then
  ufw allow OpenSSH >/dev/null
  ufw allow 'Nginx Full' >/dev/null
  # The recovery port. The panel answers here directly, so a web server that
  # stopped serving can still be repaired from the panel that manages it.
  ufw allow "${JOTPANEL_PANEL_PORT:-7443}"/tcp >/dev/null
  ufw --force enable >/dev/null
else
  systemctl enable --now firewalld
  firewall-cmd --permanent --add-service=http >/dev/null
  firewall-cmd --permanent --add-service=https >/dev/null
  firewall-cmd --permanent --add-service=ssh >/dev/null
  firewall-cmd --reload >/dev/null
fi

if [[ $NO_DOMAIN -eq 1 ]]; then
  # Nobody issues a public certificate for an IP address, so the panel makes
  # its own and says so plainly. It is the same certificate the recovery port
  # already uses, so the browser warning is the one warning rather than two.
  step "8b/9  No domain, so serving on the address with a self-signed certificate"
  mkdir -p /etc/jotpanel-tls
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$PUBLIC_IP" \
    -keyout /etc/jotpanel-tls/panel.key -out /etc/jotpanel-tls/panel.crt >/dev/null 2>&1 \
    || die "A self-signed certificate could not be written."
  chmod 600 /etc/jotpanel-tls/panel.key
  cat > /etc/nginx/sites-available/jotpanel-tls.conf <<TLSCONF
server {
    listen 443 ssl;
    server_name _;
    ssl_certificate     /etc/jotpanel-tls/panel.crt;
    ssl_certificate_key /etc/jotpanel-tls/panel.key;
    client_max_body_size 512m;
    location / {
        proxy_pass http://127.0.0.1:9999;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        # Same reasoning as the final configuration: see the note there.
        proxy_read_timeout 3900s;
    }
}
TLSCONF
  ln -sf /etc/nginx/sites-available/jotpanel-tls.conf /etc/nginx/sites-enabled/jotpanel-tls.conf
  nginx -t >/dev/null 2>&1 || die "The self-signed HTTPS configuration did not pass nginx's own check."
  systemctl reload nginx
  # The reload returns when it has been accepted, not when the listener is
  # bound, which is the race that failed a perfectly good install here.
  wait_for_http "https://$PUBLIC_IP/health" "HTTPS on this machine's address" --insecure --units "nginx jotpanel" \
    || die "HTTPS on the address did not answer: $READY_ERROR"
  CERT_STATE="self_signed_no_domain"
  ok "Serving on https://$PUBLIC_IP with a certificate this machine made"
else
CERTBOT_ARGS=(--nginx --non-interactive --agree-tos --redirect --hsts -m "$OWNER_EMAIL" -d "$DOMAIN")
if [[ $CERT_STAGING -eq 1 ]]; then CERTBOT_ARGS+=(--staging); fi
certbot "${CERTBOT_ARGS[@]}" \
  || die "The panel is running locally, but certificate issuance failed. Check that $DOMAIN resolves to this machine, then rerun certbot."
if [[ $CERT_STAGING -eq 1 ]]; then
  # A staging certificate is deliberately untrusted, so the check proves the
  # HTTPS path serves the panel and says nothing about the chain.
  # certbot reloads nginx itself, so the same race lives here.
  wait_for_http "https://$DOMAIN/health" "HTTPS on $DOMAIN" --insecure --units "nginx jotpanel" \
    || die "HTTPS was configured but the public health check failed: $READY_ERROR"
  CERT_STATE="staging_untrusted"
  ok "Owner account created and HTTPS serving with a staging certificate"
else
  # No --insecure here on purpose: this branch is the one that proves the chain,
  # so a certificate that does not verify must fail rather than be waited out.
  wait_for_http "https://$DOMAIN/health" "HTTPS on $DOMAIN" --units "nginx jotpanel" \
    || die "HTTPS was configured but the public health check failed: $READY_ERROR"
  CERT_STATE="verified"
  ok "Owner account and live HTTPS certificate verified"
fi
fi

# The way in. A password in a welcome email is read by everyone that email
# passes, so the customer gets a link that works once and expires within the
# hour, and sets their own password from inside the panel.
LOGIN_LINK=""
OWNER_ID="$(printf '%s' "$CREATE_RESULT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).userId||"")}catch{}})')"
if [[ -n "$OWNER_ID" ]]; then
  LOGIN_LINK="$(curl -fsS -X POST "http://127.0.0.1:9998/admin/api/accounts/$OWNER_ID/login-link" \
    -H "@$ADMIN_HEADERS" --data '{"minutes":60}' \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).url||"")}catch{}})' || true)"
fi
[[ -n "$LOGIN_LINK" ]] && ok "Single-use sign-in link ready, valid for one hour" || say "No sign-in link was issued; the password still works."

if [[ -n "$LICENSE_KEY" ]]; then
  printf 'JOTPANEL_LICENSE_KEY=%s\n' "$LICENSE_KEY" >> "$INSTALL_DIR/.env"
  ok "Licence key written to the install config"
fi

step "9/9  Writing the installation report"
cat > "$INSTALL_DIR/install-report.txt" <<EOF
JotPanel installation report
product=$(cat "$INSTALL_DIR/app/PRODUCT" 2>/dev/null || echo panel)
installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
installer_version=$VERSION
domain=$DOMAIN
has_domain=$( [[ $NO_DOMAIN -eq 1 ]] && printf 'no_installed_on_address' || printf 'yes' )
owner_email=$OWNER_EMAIL
bundle_source=$BUNDLE_SOURCE
bundle_sha256=$ACTUAL_SHA256
bundle_checksum=$CHECKSUM_STATE
node=$(node --version)
node_path=$NODE_BIN
install_dir=$INSTALL_DIR
panel_health=verified
https_health=$CERT_STATE
ops_socket=$OPS_SOCKET
ops_service=answering
ops_reachable_by_panel_user=yes
firewall_probe=$FIREWALL_PROBE
log_probe=$LOG_PROBE
registration=$( [[ -n "$LICENSE_KEY" ]] && printf 'key_supplied' || printf 'not_requested' )
owner_password=$( [[ $GENERATED_PASSWORD -eq 1 ]] && printf 'generated_use_sign_in_link' || printf 'supplied_by_installer' )
assistant=off_until_registered
local_engine=$( [[ $WITH_RESIDENT -eq 1 ]] && printf 'installed_loopback_only' || printf 'not_installed' )
voice_service=$( systemctl is-active jotpanel-voice.service 2>/dev/null || printf 'not_installed' )
firewall=http_https_ssh_only_engine_11434_blocked
EOF
chmod 0640 "$INSTALL_DIR/install-report.txt"
chown root:jotpanel "$INSTALL_DIR/install-report.txt"

printf '\n  JotPanel is ready: https://%s\n' "$DOMAIN"
if [[ $NO_DOMAIN -eq 1 ]]; then
  # The warning is unavoidable on an address, and clicking through one without
  # looking is a habit worth not teaching, so the fingerprint is printed here.
  # It is the one moment the person is definitely looking at the real machine.
  FINGERPRINT="$(openssl x509 -in /etc/jotpanel-tls/panel.crt -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)"
  printf '  There is no domain on this install yet, so the certificate is one this machine made and your browser will warn about it.\n'
  printf '  Before you click through that warning, check the fingerprint matches:\n    %s\n' "$FINGERPRINT"
  # This said "add a domain from Settings" when no such screen existed, and was
  # then corrected to say plainly that there was none. The screen exists now, in
  # Settings, so this says where it is — and still names --domain first, because
  # giving the name at install time skips the restart the later change costs.
  printf '  You can give this panel a name now with --domain, or afterwards from Settings once the name resolves to this machine.\n'
  printf '  Setting it later fetches a certificate and restarts the panel, so anyone signed in is signed out for a moment.\n'
fi
if [[ -n "$LOGIN_LINK" ]]; then
  printf '  Sign in once with this link, then set a password from inside:\n    %s\n' "$LOGIN_LINK"
  printf '  It works once and expires in an hour.\n'
else
  printf '  Sign in with %s and the password you supplied.\n' "$OWNER_EMAIL"
fi
if [[ -n "$JSON_OUT" ]]; then
  # For a provisioning system: everything it needs to hand the machine over,
  # written where only root can read it.
  node -e 'const fs=require("fs");const [out,domain,email,link,gen,port,fingerprint]=process.argv.slice(1);fs.writeFileSync(out,JSON.stringify({ok:true,domain,panel_url:"https://"+domain,recovery_url:"https://"+domain+":"+port,owner_email:email,login_url:link||null,login_url_single_use:!!link,password_generated:gen==="1",certificate_fingerprint_sha256:fingerprint||null},null,2)+"\n",{mode:0o600});' \
    "$JSON_OUT" "$DOMAIN" "$OWNER_EMAIL" "$LOGIN_LINK" "$GENERATED_PASSWORD" "${JOTPANEL_PANEL_PORT:-7443}" "${FINGERPRINT:-}"
  chmod 0600 "$JSON_OUT"
  printf '  Machine-readable result: %s\n' "$JSON_OUT"
fi
[[ $CERT_STAGING -eq 1 ]] && printf '  The certificate is from the staging authority and your browser will warn about it.\n'
printf '  JotPanel has not registered or called the assistant service. Register inside the Licence screen only when you want Echo.\n'
printf '  Installation report: %s/install-report.txt\n\n' "$INSTALL_DIR"
