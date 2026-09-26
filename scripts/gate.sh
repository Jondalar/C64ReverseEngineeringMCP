#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# scripts/gate.sh — runs the gates locally, and runs EXACTLY the ones CI runs.
#
# It does not carry a list. It reads `.github/workflows/gates.yml` and executes
# that workflow's steps, in its order, with its names. There is no second list to
# keep in step, because a second list is how this went wrong: CI stood red from
# 7dfb3c5f for a day and a half over one assertion, two pushes went out on top of
# it, and nobody was running the thing that knew.
#
# That workflow is deliberately the HERMETIC subset — no ROMs, no assembler, no
# media, no daemon — which is why it is the part that can be demanded of every
# machine. The gates that need those assets stay what they were: run them by hand
# when the work touches what they cover.
#
# Usage:
#   scripts/gate.sh              every step in the workflow
#   scripts/gate.sh docs         only the steps that judge documents
#   GATE_LIST=1 scripts/gate.sh  print the steps and run nothing
#
# `npm ci` is skipped: the workflow installs into a bare runner, a working tree
# already has its dependencies, and re-installing them is not what is being tested.
# ─────────────────────────────────────────────────────────────────────────────

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORKFLOW="$ROOT/.github/workflows/gates.yml"
TIER="${1:-all}"

if [ ! -f "$WORKFLOW" ]; then
  printf 'gate: %s is missing — nothing to run, and that is not a pass.\n' "$WORKFLOW" >&2
  exit 2
fi

# The steps that judge documents rather than code. A docs-only push pays for these
# and nothing else; they are also in the full run, so `all` is still a superset.
DOCS_STEPS='check:docs-current|check:doc-capability-claims|check:wiki|check:tool-names'

# (name, command) in workflow order. A step with no `run:` — the checkout and the
# node setup — has nothing to execute and is not a step of ours.
# Only the `gates` job. The workflow also carries a `windows` job (Spec 716.5), whose
# steps are the same two gates run again on a Windows shell — running them a second time
# here would prove nothing this machine has not already proved, and its `npm ci` would
# reinstall the tree underneath the run.
STEPS=$(
  awk '
    /^  [a-z][a-z0-9_-]*:[[:space:]]*$/ {
      job = $1
      sub(/:$/, "", job)
      next
    }
    job != "gates" { next }
    /^[[:space:]]*-[[:space:]]+name:[[:space:]]*/ {
      sub(/^[[:space:]]*-[[:space:]]+name:[[:space:]]*/, "")
      name = $0
      next
    }
    /^[[:space:]]*run:[[:space:]]*/ {
      if (name == "") next
      sub(/^[[:space:]]*run:[[:space:]]*/, "")
      print name "\t" $0
      name = ""
    }
  ' "$WORKFLOW" | grep -v '	npm ci$'
)

if [ "$TIER" = "docs" ]; then
  STEPS=$(printf '%s\n' "$STEPS" | grep -E "$DOCS_STEPS")
fi

TOTAL=$(printf '%s\n' "$STEPS" | sed '/^$/d' | wc -l | tr -d ' ')

if [ "$TOTAL" = "0" ]; then
  printf 'gate: no steps matched (tier=%s). Refusing to report green on an empty run.\n' "$TIER" >&2
  exit 2
fi

if [ "${GATE_LIST:-0}" = "1" ]; then
  printf '%s steps (tier=%s):\n' "$TOTAL" "$TIER"
  printf '%s\n' "$STEPS" | awk -F'\t' '{ printf "  %s\n      %s\n", $1, $2 }'
  exit 0
fi

cd "$ROOT" || exit 2

# The state the run is ABOUT to prove, captured before the first step. Writing the note
# from the state at the END was wrong: an edit or a commit while the gate runs would have
# it claim a tree the gate never saw, and the next push would skip on that claim.
state_now() {
  printf '%s-%s' \
    "$(git rev-parse HEAD 2>/dev/null || echo no-head)" \
    "$(git status --porcelain 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
}
STATE_AT_START="$(state_now)"

N=0
START=$(date +%s)
printf '\n=== gate: %s step(s) from gates.yml (tier=%s) ===\n' "$TOTAL" "$TIER" >&2

printf '%s\n' "$STEPS" | sed '/^$/d' > /tmp/.c64re-gate-steps.$$
while IFS="$(printf '\t')" read -r NAME CMD; do
  N=$((N + 1))
  printf '\n[%s/%s] %s\n' "$N" "$TOTAL" "$NAME" >&2
  # </dev/null: a step must never inherit the caller's stdin. When this runs from
  # pre-push that stdin is git's ref pipe, and a step that reads it kills the push.
  if ! sh -c "$CMD" >&2 </dev/null; then
    ELAPSED=$(( $(date +%s) - START ))
    printf '\n=== gate RED at step %s/%s after %ss ===\n' "$N" "$TOTAL" "$ELAPSED" >&2
    printf '    %s\n' "$NAME" >&2
    printf '    re-run it alone:  %s\n\n' "$CMD" >&2
    rm -f /tmp/.c64re-gate-steps.$$
    exit 1
  fi
done < /tmp/.c64re-gate-steps.$$
rm -f /tmp/.c64re-gate-steps.$$

ELAPSED=$(( $(date +%s) - START ))

# Leave a note saying WHAT was proved, so the pre-push hook does not prove it again.
#
# The note is the commit plus a digest of the working tree's dirty state, which together
# identify the exact code that just went green. It carries no expiry: if the state matches,
# the same 82 steps would run over the same bytes, and running them twice for one push is
# ten minutes spent on an answer already in hand.
GITDIR="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
if [ "$(state_now)" = "$STATE_AT_START" ]; then
  printf '%s %s\n' "$TIER" "$STATE_AT_START" > "$GITDIR/c64re-gate-ok" 2>/dev/null || true
else
  rm -f "$GITDIR/c64re-gate-ok" 2>/dev/null || true
  printf '    (the tree moved while this ran — no note left, the next push gates again)\n' >&2
fi

printf '\n=== gate GREEN — %s/%s steps in %ss ===\n\n' "$TOTAL" "$TOTAL" "$ELAPSED" >&2
