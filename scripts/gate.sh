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
# Parallel: a `# gate: parallel` (or `# gate: runtime`) comment on the line(s) above a step in gates.yml
# marks it as safe to run beside others — CI ignores the comment. A step WITHOUT a tag is serial: a new
# step cannot start sharing state with the others by accident, it has to be proved and tagged. `runtime`
# is a step that starts a daemon or server on a free port (at most 3 of them at once).
# The scheduler is scripts/gate-pool.mjs; GATE_JOBS=1 makes the whole run serial again.
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
DOCS_STEPS='check:docs-current|check:doc-capability-claims|check:wiki|check:tool-names|check:no-internal-refs'

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
    /^[[:space:]]*#[[:space:]]*gate:[[:space:]]*(parallel|runtime|serial)/ {
      tag = $0
      sub(/^[[:space:]]*#[[:space:]]*gate:[[:space:]]*/, "", tag)
      sub(/[^a-z].*$/, "", tag)
      next
    }
    /^[[:space:]]*-[[:space:]]+name:[[:space:]]*/ {
      sub(/^[[:space:]]*-[[:space:]]+name:[[:space:]]*/, "")
      name = $0
      mode = (tag == "" ? "serial" : tag)
      tag = ""
      next
    }
    /^[[:space:]]*run:[[:space:]]*/ {
      if (name == "") next
      sub(/^[[:space:]]*run:[[:space:]]*/, "")
      print name "\t" mode "\t" $0
      name = ""
    }
  ' "$WORKFLOW" | grep -v '	npm ci$' | sed -e 's#\(	\)npm run build$#\1node scripts/ensure-built.mjs all#' -e 's#\(	\)npm run ui:build$#\1node scripts/ensure-built.mjs ui#'
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
  printf '%s\n' "$STEPS" | awk -F'\t' '{ printf "  %s\n      %s  [%s]\n", $1, $3, $2 }'
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

# Every ORPHANED trx64-daemon serving a throwaway project. A test that spawns the real
# server lets it warm-start a daemon, and that daemon is detached by design (it outlives an
# MCP reconnect) — so it also outlives the test, sits on :4312, and the UI and the real MCP
# attach to a machine holding a temp project. Detached and its parent gone is what makes it
# a leak: its parent is then 1. A daemon whose parent is alive is somebody's sandbox —
# another session's reel started during this run blocked a push on 2026-10-01 — and is not
# this run's to judge. Taken before and after: only an orphan this run left is its fault.
temp_daemons() {
  ps -axo pid=,ppid=,command= 2>/dev/null \
    | awk '$2 == 1' \
    | grep 'trx64-daemon' | grep -v grep \
    | grep -E -- "--project (/tmp/|/private/tmp/|/var/folders/|/private/var/folders/|${TMPDIR:-/nonexistent/})" \
    | sort
}
TEMP_DAEMONS_AT_START="$(temp_daemons)"

# Spec 902 D5 — every step runs with a state directory of its own and says it is a smoke, so the
# process ledger records what a step starts as that step's, and the last step of the workflow
# (check:leaks) can name the one that left something running. A directory per run: nothing a test
# writes there is the owner's selection, hold or ledger.
if [ -z "${C64RE_STATE_DIR:-}" ]; then
  C64RE_STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/c64re-gate-state.XXXXXX")
  GATE_OWNS_STATE=1
fi
export C64RE_STATE_DIR
export C64RE_STARTED_BY=smoke

START=$(date +%s)
printf '\n=== gate: %s step(s) from gates.yml (tier=%s) ===\n' "$TOTAL" "$TIER" >&2

# One run directory for the logs, the per-step scratch and the timings; the scheduler writes into it.
GATE_RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/c64re-gate-run.XXXXXX")
export GATE_RUN_DIR
GATE_TIMINGS_IN="$(git rev-parse --git-dir 2>/dev/null || echo .git)/c64re-gate-timings.tsv"
export GATE_TIMINGS_IN
printf '%s\n' "$STEPS" | sed '/^$/d' > "$GATE_RUN_DIR/steps.tsv"
# </dev/null: a step must never inherit the caller's stdin. When this runs from
# pre-push that stdin is git's ref pipe, and a step that reads it kills the push.
if ! node scripts/gate-pool.mjs "$GATE_RUN_DIR/steps.tsv" </dev/null; then
  ELAPSED=$(( $(date +%s) - START ))
  printf '=== gate RED after %ss (logs: %s) ===\n\n' "$ELAPSED" "$GATE_RUN_DIR" >&2
  [ "${GATE_OWNS_STATE:-0}" = "1" ] && rm -rf "$C64RE_STATE_DIR"
  exit 1
fi

LEFT_BEHIND=$(temp_daemons | grep -vxF -- "${TEMP_DAEMONS_AT_START:-\x00}")
if [ -n "$LEFT_BEHIND" ]; then
  printf '\n=== gate RED: a step left a runtime daemon running ===\n' >&2
  printf '%s\n' "$LEFT_BEHIND" | sed 's/^/    /' >&2
  printf '    A test that starts the MCP server sets C64RE_RUNTIME_AUTOSTART=0, or runs its own\n' >&2
  printf '    daemon on its own port and kills it in finally. Stop these by PID.\n\n' >&2
  exit 1
fi

ELAPSED=$(( $(date +%s) - START ))
[ "${GATE_OWNS_STATE:-0}" = "1" ] && rm -rf "$C64RE_STATE_DIR"
cp "$GATE_RUN_DIR/timings.tsv" "$(git rev-parse --git-dir 2>/dev/null || echo .git)/c64re-gate-timings.tsv" 2>/dev/null || true
cp "$GATE_RUN_DIR/watch.tsv" "$(git rev-parse --git-dir 2>/dev/null || echo .git)/c64re-gate-watch.tsv" 2>/dev/null || true
rm -rf "$GATE_RUN_DIR"

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
