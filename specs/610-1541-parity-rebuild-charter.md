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

| Spec | Title                                          | Scope                                                                                                                                                          | Runtime Proof Gate scope                                                                                                |
|------|------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
| 611  | VICE-derived 1541, side-by-side full-port batch | As defined in `specs/611-new-vice1541-side-by-side.md`. Builds new `drive1541-vice` next to legacy; legacy frozen; factory + Drive1541 interface; missing VICE1541 source modules are ported as one integrated batch before KERNAL LOAD is judged. | Full-port / integration gates in `specs/611-...md` §5 + §6. Master default stays `legacy` and 5/7 GREEN until the VICE1541 default flip. |
| 612  | (superseded by Spec 611 batch)                 | Originally "VIA2 byte-ready"; now part of the full VICE1541 source-module batch. This row stays for back-reference only. | n/a                                                                                                                       |
| 613  | (superseded by Spec 611 batch)                 | Originally "drivecpu timing"; now part of the full VICE1541 source-module batch. | n/a                                                                                                                       |
| 614  | (superseded by Spec 611 batch)                 | Originally "GCR read/write"; now part of the full VICE1541 source-module batch. | n/a                                                                                                                       |
| 615  | SAVE / FORMAT write path                       | Disk-image write-back; D64/G64 persistence; OPEN15 / SAVE / SCRATCH / FORMAT. Straddles drive + C64 KERNAL — own spec + own branch once Spec 611 lands.        | New SAVE / FORMAT Runtime Proof Gates pass; baseline 5/7 stays green; vice module default in place after Spec 611 default flip. |

The earlier "one cherry-pick, one gate run" model (612-614 as
separate rounds against legacy) is replaced by the side-by-side
build in Spec 611. Sub-spec sub-division (`611a`, `611b`, ...) is
not used. The fine-grained 611.x / 611.7g migration phases are no
longer the operating plan; Spec 611 now requires a full VICE1541
source-module port batch, then integration, then KERNAL LOAD.

## Process per sub-spec

Spec 611 is the explicit exception to the old "small slice then gate"
mechanics below. It keeps the Runtime Proof Gate doctrine, legacy
freeze, and side-by-side factory boundary, but it does not accept
further micro-slices as the implementation strategy. For Spec 611,
port the remaining VICE1541 source modules as a complete source-shaped
batch first; integrate that batch; then run KERNAL LOAD and the runtime
gates.

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
- Porting from `quarantine/1541-literal-vice` as authority. Spec 611
  ports from current VICE source. The full VICE1541 source-module batch
  is in scope even before a specific Runtime Proof Gate failure points
  at each individual module, because the 1541 is an integrated subsystem.

## Notes

- The first sub-spec (611) starts only when the user explicitly
  authorises it. This spec defines the **how**; it does not
  schedule the **when**.
- VICE traces remain secondary. When a Runtime Proof Gate fails
  in a 61X spec, the trace workflow defined in CLAUDE.md
  ("VICE Traces — Secondary, On-Demand Only") is the diagnostic.
