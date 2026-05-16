# Spec 600 — Runtime Proof Gates

**Status:** ACTIVE (2026-05-16)
**Branch:** `codex/1541-runtime-gates`
**Baseline:** `runtime-green-2026-05-16` → commit `7bfba28`
**Doc:** `docs/runtime-gates.md` (oracle inventory + script audit)
**Truth table:** `docs/runtime-gates-truth-table.md`

## Goal

Define the single source of truth for "is the headless runtime
green": the **Runtime Proof Gate**. Replace cycle-diff, unit-test,
mapping-PASS, and PC-only-smoke claims with one binding rule.

## Doctrine

```
A PASS is only valid when the Runtime Proof Gate is green.
A Runtime Proof Gate is green only when ALL of these hold:

  1. Screenshot / framebuffer matches the proof-oracle PNG in
     samples/screenshots/proof/<game>-*.png for the expected
     scene at the expected time window.
  2. C64 PC is not stuck in a KERNAL READY / LOAD / IEC wait
     loop (stuck-PC list defined per-game in spec 601).
  3. (Where applicable) screen-RAM SHA-256 matches the frozen
     golden in samples/golden-master/spec-423/<test>.screenram.bin,
     OR the screen contains the expected non-zero glyph signature.
  4. (Where applicable) drive PC is in the expected idle / RX
     region, not stuck in a recognisable error path.
  5. (For SAVE / FORMAT) the disk image hash, or per-track /
     per-sector CRC, changes in the expected way.
```

### What is NOT a Runtime Proof Gate

| Source of green                                | Counts as Runtime Proof? |
|------------------------------------------------|--------------------------|
| Unit tests pass                                | **No.**                  |
| Mapping document audit pass                    | **No.**                  |
| Cycle-diff `N/N` vs VICE                       | **No.**                  |
| Smoke that only prints "no crash"              | **No.**                  |
| Smoke that only checks final PC                | **No.**                  |
| Per-spec "production-proof" markdown           | **No.**                  |
| Sub-agent verdict                              | **No.**                  |
| Runtime Proof Gate green on 1 of 7 games       | **Partial only.** Not a system-wide PASS. |
| Runtime Proof Gate green on all applicable games | **Yes.**              |

### Trigger surface

Every spec that touches any of the following MUST run the full
applicable Runtime Proof Gate set before claiming DONE:

- `src/runtime/headless/drive/**`
- `src/runtime/headless/via/**` (VIA1 / VIA2)
- `src/runtime/headless/iec/**`
- `src/runtime/headless/kernel/**` (KERNAL serial)
- `src/runtime/headless/c64-cpu/**` (6510)
- `src/runtime/headless/vic*/**`
- `src/runtime/headless/cia*/**`
- Any disk-image parser, GCR shifter, rotation engine,
  drivesync / drivecpu / drive ROM.

## Acceptance

1. This spec is committed and referenced from PLAN.md + CLAUDE.md.
2. Spec 601 enumerates every proof-oracle PNG with expected scene
   and gate status.
3. Spec 610 defines the replacement charter for Epic 440 and
   bakes "DONE = Runtime Proof Gate green" into every sub-spec
   acceptance.
4. The aggregator `scripts/test-game-screenshots-all.mjs`
   succeeds for the 5/7 baseline expectation on
   `runtime-green-2026-05-16` (motm, MM, IM2, Scramble, Polarbear
   green; LNR, Pawn red expected per spec 601).

## Out of scope

- Re-implementing the gates as a Vitest / Jest suite. The gates
  are integration runs, not unit tests, and must remain runnable
  via `node scripts/...mjs`.
- Auto-diffing PNGs at pixel level inside the aggregator. Visual
  diff stays human-reviewed for now; gate-author adds a per-game
  scene assertion (PC + screen-RAM signature) where mechanically
  possible.
- Adding new emulator-side instrumentation. Gates use only the
  public headless session API.

## Notes

- VICE traces are explicitly **secondary** under this doctrine.
  See CLAUDE.md "VICE Traces — Secondary, On-Demand Only".
- The Spec 444 v2 regression (commit `9e2edd8`, 9999/9999 cycle-diff
  PASS, broke LOAD on all disks) is the canonical case study for
  why cycle-diff is not a Runtime Proof Gate.
