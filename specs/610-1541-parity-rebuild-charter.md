# Spec 610 — 1541 Parity Rebuild Charter

**Status:** ACTIVE (2026-05-16)
**Branch:** `codex/1541-runtime-gates`
**Baseline:** `runtime-green-2026-05-16` → master HEAD `87b4957` (Merge vic_bugs: Specs 425-429)
**Replaces:** Epic 440 (Specs 440-452, now superseded / quarantine).

## Goal

Define the **only** path forward for closing the remaining 1541
parity gaps (Pawn LOAD wildcard, LNR fastloader handover, SAVE,
FORMAT, write path, NTSC, JiffyDOS, multi-drive, datasette) under
the Runtime-Proof-Gate doctrine.

## Constraints

1. **Quarantine of 1541-literal-vice is binding.**
   - The branch `quarantine/1541-literal-vice` is closed.
   - No merge.
   - No rebase onto `codex/1541-runtime-gates` or `master`.
   - No "spec 44x is DONE so cherry-pick the whole batch".
2. **Material lager only.**
   - Cherry-pick only with `git cherry-pick -n` (no commit).
   - One change at a time.
   - Each cherry-pick must be followed immediately by a full
     Runtime Proof Gate run (Spec 600) before it is committed.
   - A cherry-pick that breaks any baseline-green game on Spec 601's
     truth table is reverted and dropped from the rebuild.
3. **DONE means Runtime Proof Gate green.**
   - No spec under 611-615 is DONE until the Runtime Proof Gates
     defined by its scope are green at the spec's tip commit.
   - Unit smokes, cycle-diffs, mapping docs, and sub-agent verdicts
     are NOT acceptable evidence under any 611-615 spec.

## Sub-spec sequence

Each sub-spec lives at `specs/61X-...md` and is opened only when
the previous one is DONE under the rules above. Scope is delimited
so the Runtime Proof Gate impact is localised and traceable.

| Spec | Title                            | Scope                                                                              | Runtime Proof Gate scope                                |
|------|----------------------------------|------------------------------------------------------------------------------------|---------------------------------------------------------|
| 611  | rotation retry                   | Re-port `rotation.c` byte-by-byte; integrate without hybrid; per-cycle hook in drivecpu. | All 5 currently-green games stay green; LNR moves toward green if rotation was implicated. |
| 612  | VIA2 byte-ready                  | Re-port `via2d.c` PA/PB ports + BYTE-READY → SO trick. No GcrShifter parallel state. | All 5 currently-green games stay green; motm stays green at `$b7bf`. |
| 613  | drivecpu timing                  | Re-port `drivecpu.c` push-mode dispatch, alarms, drivesync coupling, attach-clk decay. | All 5 currently-green games stay green; load-directory SHA-drift closes. |
| 614  | GCR read/write                   | Re-port `gcr.c` + read-path + write-path; track buffer model.                       | All 5 stay green; Pawn `LOAD"*"` becomes green (wildcard hits real GCR data). |
| 615  | SAVE / FORMAT write path         | Disk-image write-back; D64/G64 persistence; OPEN15/SAVE/SCRATCH/FORMAT.             | New SAVE / FORMAT Runtime Proof Gates pass; baseline 5/7 stays green. |

Sub-specs may be sub-divided (`611a`, `611b`, ...) per the
"one cherry-pick, one gate run" rule.

## Process per sub-spec

1. Write the sub-spec under `specs/61Xx.md`. Cite the doc anchor
   in `docs/vice-1541-arch.md` § that the change targets, plus the
   exact VICE source file:line being mirrored.
2. List the candidate cherry-picks from `quarantine/1541-literal-vice`
   (or new authoring) that the sub-spec depends on.
3. For each candidate:
   - `git cherry-pick -n <sha>` onto a `codex/1541-runtime-gates`
     working branch.
   - `npm run build:mcp`.
   - Run `node scripts/test-game-screenshots-all.mjs`.
   - Compare to Spec 601 baseline truth table.
   - If any baseline-green game regresses: `git restore --staged .
     && git checkout -- .`, mark the cherry-pick rejected in the
     sub-spec, move on.
   - If no regression and the targeted-red game advances visibly:
     commit, add a "Runtime Proof Gate evidence" block to the
     sub-spec with the screenshot path + PC trail.
4. Sub-spec is DONE only when:
   - all 5 baseline-green games still green (visual oracle match),
   - the sub-spec's targeted scope shows the expected forward
     motion on its Runtime Proof Gate, and
   - the production-proof block cites the Runtime Proof Gate
     evidence verbatim (no cycle-diff numbers, no mapping table
     count).

## Out of scope

- Doctrinal changes to Specs 600-601 (this spec consumes them).
- Re-opening Epic 440 as an implementation plan. The whole 440
  numbering stays quarantined.
- Speculative or "preventive" porting of 1541-literal-vice code
  that no Runtime Proof Gate failure currently demands.

## Notes

- The first sub-spec (611) starts only when the user explicitly
  authorises it. This spec defines the **how**; it does not
  schedule the **when**.
- VICE traces remain secondary. When a Runtime Proof Gate fails
  in a 61X spec, the trace workflow defined in CLAUDE.md
  ("VICE Traces — Secondary, On-Demand Only") is the diagnostic.
