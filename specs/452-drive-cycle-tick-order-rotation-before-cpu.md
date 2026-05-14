# Spec 452 — Drive-cycle tick-order: rotation BEFORE cpu per §14 invariant 1

**Status:** OPEN
**Priority:** MEDIUM
**Parent:** Epic 440
**Depends on:** 441 (rotation primitive DONE), 444 (drivecpu body DONE)
**Doctrine:** §14 invariant 1 of `docs/vice-1541-arch.md` requires
`rotation_rotate_disk()` to run BEFORE the drive 6502 cycle, not
after. Current TS does AFTER. Flipping crashes Scramble Infinity
Krill loader (PC stuck $eeb1 KERNAL LOAD), so AFTER is masking
another timing divergence somewhere else in the drive path.
This spec owns finding + fixing the masked divergence so BEFORE
becomes stable.

## Why a new spec

The PARTIAL tick-order item used to be tracked by pre-rewrite Spec 412
(branch `vice-arch-port`). That spec is part of the failed-approach
work that motivated the strict `1541-literal-vice` rewrite — not a
valid live reference.

Spec 441 (rotation.c literal port) ported the primitive correctly but
explicitly stayed out of call-site wiring. Spec 444 (drivecpu literal
port) ticketed the AFTER-position to a follow-up because flipping it
needs a root-cause investigation, not a port action.

This is that follow-up.

## VICE source

- `src/drive/drivecpu.c` — `drivecpu_execute` body invokes
  `drivecpu_rotate()` macro per drive cycle inside the
  `6510core.c` opcode template. The macro expands to
  `rotation_rotate_disk(drv->drives[0])`.
- `src/6510core.c` — opcode template; rotation hook fires at the
  start of every bus-cycle slot.
- `docs/vice-1541-arch.md §12 step 1`, `§13 Phase F step 24`,
  `§14 invariant 1`.

## Current TS state

- `src/runtime/headless/drive/drive-cpu.ts:1226-1245` (cycle-stepped
  inner loop):
  ```ts
  while (cycled.cycles < this.stop_clk) {
      cycled.executeCycle();             // CPU first
      if (this.gcrShifter) this.gcrShifter.tick(1);  // rotation AFTER
      ...
  }
  ```
- Same pattern in `step()` / `runOneInstruction` path
  (`drive-cpu.ts:~1300`).
- `gcr-shifter.ts` rotation primitive is correct (Spec 441); only
  the call-site ordering deviates.

## Known regression blocker

Flipping to `rotation_rotate_disk()` BEFORE `executeCycle()` causes
Scramble Infinity (Krill loader) to wedge at PC=$eeb1 inside KERNAL
LOAD. Root cause is unidentified — a different TS timing divergence
elsewhere in the drive path compensates with AFTER. Until that
divergence is found and fixed, the AFTER position must remain.

Candidate suspects (none confirmed):
- VIA1 / VIA2 CA1 edge sampling timing relative to drive cycle slot
- IEC bus state propagation latency between drive cycle and host
  cycle
- BYTE-READY → SO signal timing (Spec 411 fixed propagation, not
  necessarily the sample slot)
- Drive↔host clock-skew across the `cycleAccum >> 16` boundary

## Acceptance

1. **Root cause** of the Krill regression identified and documented
   (file:line in TS + corresponding VICE behaviour).
2. **Root-cause patch** lands as its own commit, gated by:
   - canary 5/5 still PASS with rotation AFTER (regression-proof
     of the patch itself)
3. **Tick-order flip** lands as a separate commit:
   - `drive-cpu.ts` inner loop calls rotation BEFORE cpu cycle
   - same flip in `step()` / `runOneInstruction`
4. **All canaries** PASS with BEFORE-tick (motm, MM s1, IM2,
   Scramble Infinity Krill, LNR-S1 red-as-expected).
5. **VICE-baseline cycle-diff smoke**
   (`tests/integration/drivecpu-vs-vice-baseline.test.mjs`) stays
   within ±1 cycle.
6. **Rotation-count smoke** added: after N drive cycles, the
   shifter `rotationCount` must equal drive `cpu.cycles`
   (one-tick-per-bus-cycle invariant).
7. Doc `vice-1541-arch.md §14 invariant 1` no longer carries a
   "PARTIAL" caveat in the §17 OQ section.

## Workflow gate

7-step per Spec 440. Steps 4 (production-proof) and 5 (tests)
include the canary suite plus the new rotation-count smoke.

## Do Not

- Do not attempt the flip without finding the masked divergence
  first — that's the failed-approach pattern that motivated
  this spec to exist.
- Do not cite Spec 412 in TS comments or docs — pre-rewrite work,
  not a valid live reference.
- Do not bundle this with Spec 445 (gcr write-path) or 446
  (drivesync) — different abstraction layer (call-site wiring vs
  chip body).

## Output

- `specs/452-...md` (this file).
- Updated `drive-cpu.ts` comments cite Spec 452 (not 412).
- New `tests/integration/drive-rotation-tick-order.test.mjs` or
  similar.
- `docs/spec-452-tick-order-root-cause.md` documenting the masked
  divergence + fix.
