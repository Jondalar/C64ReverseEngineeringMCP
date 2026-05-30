# Bug: `agent_onboard` reports filesystem/artifact store “in sync” for empty unverified workspace

- **ID:** BUG-006
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** mcp-tool
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: 951cb2b
- Surface: mcp default / agent_onboard
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `agent_onboard`

## What happened

On a newly initialized or effectively empty workspace, `agent_onboard` reports that filesystem and artifact store are “in sync” even when there are zero artifacts registered and no meaningful file inventory has been performed. Later, the same project shows many unregistered files.

## Expected

For an empty or unverified workspace, onboarding should not report “in sync” as a success state. It should say something like “no registered artifacts yet; run/import inventory” or provide the correct callable next step.

## Repro steps

1. Initialize or resume an empty/new project.
2. Run `agent_onboard`.
3. Observe “filesystem and artifact store are in sync” despite zero registered artifacts.
4. Later inspect audit after work/files exist; unregistered files appear.

Minimal command / call:

```text
agent_onboard on fresh DDD workspace before artifact registration.
```

## Evidence

- Error / output (verbatim):

```text
Erstes agent_onboard (artifacts=0, 0 registriert):
"✓ Filesystem and artifact store are in sync."
Nach Arbeit: 78 unregistriert.
Bei Nullzustand "in sync" zu melden ist irreführend — nichts war registriert, nichts geprüft.
```

- Artifacts: DDD onboarding output.

## Scope guess (optional)

Project audit/onboarding status wording and empty-state logic.

## Notes / follow-up

- This is less severe than BUG-005, but contributes to LLM workflow confusion.

---

## Resolution

- **Root cause:** `agent_onboard` printed "Filesystem and artifact store are in sync" whenever `reg.unregisteredCount === 0`, with no empty-state guard — a fresh project (0 artifacts, 0 scanned media candidates) hit that branch and showed a false green.
- **Fix commit:** `ba181dc` — when `artifacts === 0` AND `totalCandidates === 0`, report "Empty workspace — no artifacts registered yet and no media found to inventory" + the next step (add media, run extract_disk/extract_crt/register_existing_files). A genuinely-synced non-empty workspace still reports in-sync, now with the counts.
- **Gate proving the fix:** verified — onboard on a fresh project prints the empty-workspace state, not in-sync (`artifacts=0 totalCandidates=0` → EMPTY-WORKSPACE).
- **Regression risk:** low — onboarding wording only; non-empty in-sync path unchanged.
