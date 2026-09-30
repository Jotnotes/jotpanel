#!/usr/bin/env bash
# An installer that asks a question nobody can answer is an installer that fails
# in automation. This is how it failed: `read` with no terminal returned false,
# the ERR trap fired, and the message blamed the panel for not being ready
# before a single file had been written.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL="$HERE/install.sh"

fail=0
check() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; else echo "  FAIL $1: expected '$3', got '$2'"; fail=1; fi; }

# With no terminal on stdin, the script must decide it is unattended by itself.
got="$(printf '' | bash -c 'NON_INTERACTIVE=0; [[ -t 0 ]] || NON_INTERACTIVE=1; echo $NON_INTERACTIVE')"
check "no terminal means unattended" "$got" "1"

grep -q '^\[\[ -t 0 \]\] || NON_INTERACTIVE=1' "$INSTALL" \
  && echo "  ok   install.sh infers it from stdin" || { echo "  FAIL install.sh does not infer it"; fail=1; }

# The prompts must stay behind that gate, or the inference buys nothing.
for prompt in "Panel domain" "Owner email" "Initial owner password"; do
  line="$(grep -n "read -.*$prompt" "$INSTALL" | head -1 | cut -d: -f1)"
  window="$(sed -n "$((line-2)),${line}p" "$INSTALL")"
  if grep -q 'NON_INTERACTIVE -eq 0' <<<"$window"; then echo "  ok   \"$prompt\" only asked when someone is there"
  else echo "  FAIL \"$prompt\" is asked unconditionally"; fail=1; fi
done

# And a failure must not name a cause it cannot know.
if grep -q 'trap .*was not reported as ready' "$INSTALL"; then
  echo "  FAIL the error trap still blames the panel for every failure"; fail=1
else echo "  ok   the error trap reports where, not a guessed why"; fi

[[ $fail -eq 0 ]] && echo "installer unattended checks passed" || exit 1
