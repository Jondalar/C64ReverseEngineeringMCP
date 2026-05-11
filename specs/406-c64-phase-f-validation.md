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

- **OQ-406-1 — UNRESOLVED — need user decision:** VICE testprog
  vendoring license. VICE itself is GPL-2+; the `testprogs/`
  directory has no separate top-level LICENSE in VICE source. This
  is a *license-policy* question (re-distribute under GPL-2+ or
  contact authors), not a VICE-source question. The project's
  current `samples/vice-testprogs/LICENSE.md` already addresses
  this; reviewer should confirm it covers the planned vendoring.
- **OQ-406-2 — UNRESOLVED — need user decision:** Diff-trace cycle
  budget for CI. Not a VICE-source question; project-policy choice
  (how slow may smokes be on the CI machine).
- **OQ-406-3 — UNRESOLVED — need user decision:** Boot-ladder
  golden-master strategy (re-use `vicRenderer: "literal-port"` +
  PNG hash). Not a VICE-source question; project-tooling choice.

## Files touched

- 3 new smokes under `scripts/smoke-406-*.mjs`.
- vendored testprog imports under `samples/vice-testprogs/` (most
  already vendored; expand if needed).
- `specs/406-c64-phase-f-validation.md` (this)

## Next spec

Spec 407 — 1541 Phase A: Per-drive context.
