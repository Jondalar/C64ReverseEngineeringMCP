# Spec 406 — C64 Phase F: Validation

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 401, 402, 403, 404, 405
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Goal

Validate the full C64-side port against VICE per
`docs/vice-c64-arch.md §12 Phase F` (steps 26–28).

## Doc anchor

- §12 Phase F (steps 26–28)
- §13 critical invariants (all 14)

## Canonical content (verbatim §12 Phase F)

26. Run the VICE testbench: `vice/testprogs/` has 200+ programs that
    exercise edge cases. Each is a known-pass test against real
    hardware.
27. Diff against VICE: same input file, same cycle count, dump CPU +
    VIC + CIA state every N cycles, compare. Any diff > 1 cycle is a
    bug to fix.
28. Boot real software: bare KERNAL boot, READY prompt, `LOAD"$",8`,
    `LIST`. Then a demo or game. Then a fastloader.

## Source cite

- `vice/testprogs/` (e.g. `cia/`, `vicii/`, `general/`).
- Lorenz CPU test suite (referenced in memos: Disk1 100% PASS).

## Audit — current TS state

Existing test corpora (per memos):

- Lorenz Disk1: 100% PASS (CPU illegal opcodes).
- VICE CIA testprogs: 59/59 PASS (memo
  `feedback_truedrive_101`).
- VICE drive testprogs: 4/4 PASS.
- MM s1 + Scramble Infinity: title rendered (current branch).

Gaps:

- VIC-specific testprogs: not enumerated.
- VICE diff-trace harness: present but unverified scope (per
  archived Spec 236).
- Boot ladder: bare boot + LOAD"$" + LIST not explicit.

## Producer changes

This spec adds **smokes and corpora**, no source changes.

1. Enumerate `vice/testprogs/` categories. Vendor relevant programs
   under `samples/vice-testprogs/` (some already there per memos).
2. Build `scripts/smoke-406-vice-corpus.mjs`: run each testprog,
   compare expected vs actual outcome (most testprogs print pass/
   fail to screen).
3. Build `scripts/smoke-406-vice-diff-trace.mjs`: run a known PRG,
   capture per-N-cycle state via `TraceStoreProducer` + DuckDB
   sink, diff against canned VICE trace.
4. Build `scripts/smoke-406-boot-ladder.mjs`:
   - bare cold reset → READY prompt (verify screen contents).
   - `LOAD"$",8` (with synth blank disk) → "SEARCHING FOR $".
   - `LOAD"*",8,1` → MM s1 + Scramble Infinity titles.

## Consumer changes

- None outside smokes / scripts / vendored testprog corpus.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31 (= already).
- `smoke:cia-fidelity` 22/22 (= already).
- New `smoke-406-vice-corpus` PASS rate ≥ 95% (= each unsupported
  testprog documented as `// requires <feature> deferred to Spec
  4XX`).
- New `smoke-406-vice-diff-trace`: zero divergence over 1M cycles
  for the chosen canary PRG.
- New `smoke-406-boot-ladder`: all 4 ladder steps PASS.

## Open Questions

- **OQ-406-1 — RESOLVED 2026-05-11 — user decision:** Vendor VICE
  testprogs under GPL-2+ (= same terms as VICE). Existing
  `samples/vice-testprogs/LICENSE.md` covers redistribution.
  Expand corpus as needed under same terms.
- **OQ-406-2 — RESOLVED 2026-05-11 — user decision:** No GitHub
  CI/CD. Tests run locally. Diff-trace budget = **per-spec budget**:
  - Core C64/1541/IEC specs (e.g. 401, 408, 416): 100k cycles
    diff-trace (boot phase only, ~0.1 sec).
  - Phase D (404), Phase F rotation (412): 1M cycles (~1 sec).
  - Validation specs (406, 415, 423): 10M cycles (~10 sec).
  Budget pinned in each spec's Acceptance section as
  `node scripts/smoke-NNN-diff-trace.mjs --cycles=<N>`.
- **OQ-406-3 — RESOLVED 2026-05-11 — user decision:** Boot-ladder
  golden-master = **PNG hash + screen RAM hash** per stage. Reference
  vorlage saved at `samples/golden-master/c64-boot-ready.png`
  (bare cold reset → READY screen). Additional stages (post-LOAD"$",
  post-LOAD"*",8,1) captured on first green run and frozen as
  golden masters. Hash mismatch = test fail.

## Files touched

- 3 new smokes under `scripts/smoke-406-*.mjs`.
- vendored testprog imports under `samples/vice-testprogs/` (most
  already vendored; expand if needed).
- `specs/406-c64-phase-f-validation.md` (this)

## Next spec

Spec 407 — 1541 Phase A: Per-drive context.
