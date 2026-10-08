#!/usr/bin/env bash
# A guest's .env has to survive the power going off, and be repaired if it did not.
#
# THE CASE THIS EXISTS FOR, proven on real hardware 2026-10-05. An unclean
# power-cut keeps the journaled directory entry and loses the unflushed
# contents, so a file comes back EXISTING AND EMPTY. jotpanel-firstboot.sh gated
# on `[[ -f ]]`, which asks only whether the name exists, so it would have
# announced that the machine "keeps the secrets it has" about a file holding
# none. The panel then starts with no JWT_SECRET, no ADMIN_KEY, no encryption
# secret and no JOTPANEL_DATA_DIR, and server.js falls back silently to
# BACKEND/data when that last one is absent, which is a guest answering out of a
# different and empty database.
#
# The same cut destroyed the announce credential on 2026-10-04 and emptied a
# whole SQLite database on 2026-10-05, so this is the third instance of one
# failure class and the gate is tested rather than reasoned about.
#
# It runs the SHIPPED TEXT: the function is lifted out of
# jotpanel-firstboot.sh by name and evaluated here. If it is renamed or removed
# the extraction yields nothing and every case below fails, which is the point.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIRSTBOOT="$HERE/jotpanel-firstboot.sh"
fails=0
ok()  { printf '  ok  %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; fails=$((fails+1)); }

lift() { awk "/^$1\\(\\) \\{/,/^\\}\$/" "$FIRSTBOOT"; }
block="$(lift ensure_env_file)"
required="$(grep -E '^ENV_REQUIRED=\(' "$FIRSTBOOT")"
helpers="$(lift flush_path)
$(lift env_has)
$(lift env_missing)
$(lift write_env_file)
$(lift repair_env_file)
$(lift install_env_file)"
for part in "$block" "$required" "$helpers"; do
  if [[ -z "$part" ]]; then
    echo "  FAIL the .env gate could not be lifted out of jotpanel-firstboot.sh"
    exit 1
  fi
done

# Run the real function against a throwaway install root. `id` is stubbed to
# fail so the chown branch is skipped, which is exactly what the shipped script
# does on a box that has no jotpanel user yet.
run_gate() {
  local root="$1"
  (
    INSTALL_DIR="$root"
    ENV_FILE="$root/.env"
    PRODUCT=navigator
    VERSION=1.0.0
    SHELL_MODE=desktop
    DOMAIN=guest.test
    say() { :; }
    id() { return 1; }
    eval "$required"
    eval "$helpers"
    eval "$block"
    ensure_env_file
  )
}

secrets_present() {
  local f="$1"
  grep -qE '^JWT_SECRET=[0-9a-f]{64}$' "$f" \
    && grep -qE '^ADMIN_KEY=[0-9a-f]{64}$' "$f" \
    && grep -qE '^JOTPANEL_ENCRYPT_SECRET=[0-9a-f]{64}$' "$f"
}

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

# ── Case 1: a first boot with no .env at all ────────────────────────
root="$scratch/fresh"; mkdir -p "$root"
run_gate "$root" >/dev/null
[[ -s "$root/.env" ]] && ok "a first boot with no .env generates one" || bad "no .env was generated"
secrets_present "$root/.env" \
  && ok "it carries all three per-guest secrets, 32 bytes of hex each" \
  || bad "the generated .env is missing a secret"
grep -qx "JOTPANEL_DATA_DIR=$root/data" "$root/.env" \
  && ok "and names the data directory, so server.js cannot fall back to BACKEND/data" \
  || bad "JOTPANEL_DATA_DIR is wrong or absent, which is the silent-fallback case"
[[ "$(stat -f '%Lp' "$root/.env" 2>/dev/null || stat -c '%a' "$root/.env")" == "600" ]] \
  && ok "the file is 0600" || bad "the .env is not 0600"

# ── Case 2: THE POWER-CUT CASE. The file exists and is zero bytes ───
root="$scratch/emptied"; mkdir -p "$root"
: > "$root/.env"
[[ -f "$root/.env" && ! -s "$root/.env" ]] || bad "the fixture is not an empty existing file"
run_gate "$root" >/dev/null
[[ -s "$root/.env" ]] \
  && ok "an EMPTY existing .env is repaired rather than trusted (this is the -f vs -s bug)" \
  || bad "an empty .env was left empty, so the guest would start with no secrets at all"
secrets_present "$root/.env" \
  && ok "and the repaired file carries real secrets" \
  || bad "the repaired .env has no usable secrets"

# ── Case 3: a valid .env is NEVER overwritten ───────────────────────
# Regenerating signs out every session and makes every encrypted field on the
# box unreadable, so this is the property the gate exists to protect.
root="$scratch/intact"; mkdir -p "$root"
cat > "$root/.env" <<EOF
NODE_ENV=production
JOTPANEL_DATA_DIR=$root/data
JWT_SECRET=$(printf 'a%.0s' {1..64})
ADMIN_KEY=$(printf 'b%.0s' {1..64})
JOTPANEL_ENCRYPT_SECRET=$(printf 'c%.0s' {1..64})
EOF
before="$(shasum -a 256 "$root/.env" | awk '{print $1}')"
run_gate "$root" >/dev/null
after="$(shasum -a 256 "$root/.env" | awk '{print $1}')"
[[ "$before" == "$after" ]] \
  && ok "a valid non-empty .env is left byte-identical" \
  || bad "an existing valid .env was overwritten, which signs out every session"

# ── Case 4: nothing partial is left lying about ─────────────────────
# The file is written to a temporary name and moved into place, so the real name
# never holds a half-written file and no debris survives the run.
root="$scratch/atomic"; mkdir -p "$root"
run_gate "$root" >/dev/null
leftovers="$(find "$root" -maxdepth 1 -name '.env.new.*' | wc -l | tr -d ' ')"
[[ "$leftovers" == "0" ]] \
  && ok "no temporary file is left behind, so the write landed by rename" \
  || bad "$leftovers temporary .env file(s) left behind"

# ── Case 5: the gate is the one in the shipped script ───────────────
# The gate must test CONTENTS, never mere existence. `-f` is the bug.
grep -qE 'if \[\[ ! -s "\$ENV_FILE" \]\]; then' "$FIRSTBOOT" \
  && ok "jotpanel-firstboot.sh gates on the file's contents with -s" \
  || bad "the shipped gate no longer tests contents with -s"
grep -qE '^\s*if \[\[ -f "\$ENV_FILE" \]\]' "$FIRSTBOOT" \
  && bad "the shipped gate is back to -f; an empty .env would be trusted again" \
  || ok "and nothing gates on -f, which only asks whether the name exists"
grep -q 'mv -f "\$tmp" "\$ENV_FILE"' "$FIRSTBOOT" \
  && ok "and installs the file by atomic rename" \
  || bad "the shipped script no longer writes .env by rename"

# ── Case 6: non-empty but MISSING a required secret: filled, not replaced ──
# The whole point of the widened gate, and of filling rather than regenerating:
# a surviving encryption secret must come through untouched, because replacing
# it makes every encrypted field on the box unreadable for ever.
root="$scratch/truncated"; mkdir -p "$root"
cat > "$root/.env" <<EOF
NODE_ENV=production
JOTPANEL_DATA_DIR=$root/data
ADMIN_KEY=$(printf 'b%.0s' {1..64})
JOTPANEL_ENCRYPT_SECRET=$(printf 'c%.0s' {1..64})
OLLAMA_BASE=http://127.0.0.1:11434/v1/chat/completions
EOF
run_gate "$root" >/dev/null
grep -qE '^JWT_SECRET=[0-9a-f]{64}$' "$root/.env" \
  && ok "a missing JWT_SECRET is filled in" || bad "the missing JWT_SECRET was not generated"
grep -qx "JOTPANEL_ENCRYPT_SECRET=$(printf 'c%.0s' {1..64})" "$root/.env" \
  && ok "THE SURVIVING ENCRYPTION SECRET IS UNTOUCHED, so encrypted fields stay readable" \
  || bad "the surviving encryption secret was replaced, which destroys every encrypted field"
grep -qx "ADMIN_KEY=$(printf 'b%.0s' {1..64})" "$root/.env" \
  && ok "and so is the surviving admin key" || bad "the surviving ADMIN_KEY was replaced"
grep -qx 'OLLAMA_BASE=http://127.0.0.1:11434/v1/chat/completions' "$root/.env" \
  && ok "settings that were not missing are carried across" || bad "an unrelated setting was dropped"
[[ -s "$root/SECRETS_REPAIRED.txt" ]] \
  && ok "the repair is recorded where a human will see it" || bad "no repair record was left"
# 0644, not the 0600 the umask would give it. The panel's ops report runs as the
# jotpanel user and reads this file to refuse to call the box healthy, so at
# 0600 root-owned the health check would silently never fire. It holds no
# secret: the names of what was regenerated, and when.
mode="$(stat -f '%Lp' "$root/SECRETS_REPAIRED.txt" 2>/dev/null || stat -c '%a' "$root/SECRETS_REPAIRED.txt")"
[[ "$mode" == "644" ]] \
  && ok "and is 0644, so the panel user can read it and report the box as unhealthy" \
  || bad "the repair record is $mode; the health check could not read it"
grep -q 'missing and regenerated:' "$root/SECRETS_REPAIRED.txt" \
  && ok "in the format control/secretsRepaired.js parses" \
  || bad "the repair record is not in the format the health check reads"

# ── Case 7: an EMPTY assignment counts as missing ───────────────────
# `NAME=` with nothing after it is what a partial write leaves behind, and it is
# as useless as the name being absent.
root="$scratch/blankvalue"; mkdir -p "$root"
cat > "$root/.env" <<EOF
NODE_ENV=production
JOTPANEL_DATA_DIR=$root/data
JWT_SECRET=
ADMIN_KEY=$(printf 'b%.0s' {1..64})
JOTPANEL_ENCRYPT_SECRET=$(printf 'c%.0s' {1..64})
EOF
run_gate "$root" >/dev/null
grep -qE '^JWT_SECRET=[0-9a-f]{64}$' "$root/.env" \
  && ok "an empty JWT_SECRET= is treated as missing and filled" \
  || bad "an empty assignment was accepted as a secret"
[[ "$(grep -c '^JWT_SECRET=' "$root/.env")" == "1" ]] \
  && ok "and the name appears exactly once afterwards" || bad "JWT_SECRET was left in the file twice"

# ── Case 8: a MISSING OPTIONAL value changes nothing ────────────────
# "Never regenerate a valid file just because optional values are absent."
root="$scratch/optional"; mkdir -p "$root"
cat > "$root/.env" <<EOF
JOTPANEL_DATA_DIR=$root/data
JWT_SECRET=$(printf 'a%.0s' {1..64})
ADMIN_KEY=$(printf 'b%.0s' {1..64})
JOTPANEL_ENCRYPT_SECRET=$(printf 'c%.0s' {1..64})
EOF
before="$(shasum -a 256 "$root/.env" | awk '{print $1}')"
run_gate "$root" >/dev/null
[[ "$(shasum -a 256 "$root/.env" | awk '{print $1}')" == "$before" ]] \
  && ok "a file with no OLLAMA_BASE or PORT is still left byte-identical" \
  || bad "a valid file was rewritten because an optional value was absent"
[[ ! -e "$root/SECRETS_REPAIRED.txt" ]] \
  && ok "and nothing is recorded as repaired" || bad "an untouched file was recorded as repaired"

# ── Case 9: a short surviving secret is the operator's, not ours ────
# A short JWT_SECRET still signs tokens, so it may have been chosen on purpose
# and this script cannot tell that from a truncated one. Replacing it would be
# the silent destruction the rule exists to prevent.
root="$scratch/shortsecret"; mkdir -p "$root"
cat > "$root/.env" <<EOF
JOTPANEL_DATA_DIR=$root/data
JWT_SECRET=chosen-by-hand
ADMIN_KEY=$(printf 'b%.0s' {1..64})
JOTPANEL_ENCRYPT_SECRET=$(printf 'c%.0s' {1..64})
EOF
before="$(shasum -a 256 "$root/.env" | awk '{print $1}')"
run_gate "$root" >/dev/null
[[ "$(shasum -a 256 "$root/.env" | awk '{print $1}')" == "$before" ]] \
  && ok "a short but present secret is accepted as the operator's and not replaced" \
  || bad "a present secret was replaced on the strength of its shape"

# ── Case 10: the junk tail of a truncated write is dropped ──────────
root="$scratch/junktail"; mkdir -p "$root"
printf 'NODE_ENV=production\nJOTPANEL_DATA_DIR=%s/data\nADMIN_KEY=%s\nJOTPANEL_ENCRYPT_SECRET=%s\nJWT_SECR' \
  "$root" "$(printf 'b%.0s' {1..64})" "$(printf 'c%.0s' {1..64})" > "$root/.env"
run_gate "$root" >/dev/null
grep -q 'JWT_SECR$' "$root/.env" \
  && bad "the partial last line was carried forward as junk" \
  || ok "the partial last line of a truncated write is dropped"
grep -qE '^JWT_SECRET=[0-9a-f]{64}$' "$root/.env" \
  && ok "and the secret it was half-way through writing is generated" \
  || bad "the half-written secret was not completed"

# ── Case 11: the required set is the shipped one ────────────────────
grep -qx 'ENV_REQUIRED=(JWT_SECRET ADMIN_KEY JOTPANEL_ENCRYPT_SECRET JOTPANEL_DATA_DIR)' "$FIRSTBOOT" \
  && ok "the required set is the four names this test assumes" \
  || bad "ENV_REQUIRED has changed; the decision about what is critical needs re-reading"

echo
if [[ $fails -eq 0 ]]; then
  echo "firstboot .env durability checks passed"
else
  echo "$fails firstboot .env check(s) failed"
  exit 1
fi
