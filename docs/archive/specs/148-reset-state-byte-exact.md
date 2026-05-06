> **SUPERSEDED 2026-05-06 by Spec 215** (`specs/215-reset-byte-exact.md`).
> Sprint 113 aborted.

# Spec 148 — Reset state byte-exact 1:1 VICE

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**:
- VICE 3.7.1 src/core/viacore.c viacore_reset
- src/core/ciacore.c ciacore_reset
- src/drive/drivecpu.c drivecpu_reset
- src/drive/drive-resources.c drive_reset_internal
- src/c64/c64.c machine_specific_reset
- src/ram.c (RAMInit pattern logic)
**Depends on**: Spec 145 (CIA reset), Spec 147 (VIA reset)
**Refinement**: locked 2026-05-06

## Why

Drive boot state determines code path. If our drive reset state
differs from VICE by even one byte (RAM init pattern, VIA register
default, ZP $00/$01 CPU port default), drive ROM init takes
different branches → cascading divergence.

C64 reset state similar: $0801 BASIC stub, ZP $00/$01, KERNAL
init pointers — divergence cascades into game start state.

## Refinement decisions

1. **Scope (Phase 1 / now)**: audit + verify smoke. 145+147 port
   chip-internal reset. 148 = orchestrator + audit + verification
   + RAM-init + ZP-port + Boot-State. Drives a new
   `smoke:reset-byte-exact` check that fails if any byte diverges
   from VICE cold-boot snapshot.
2. **Scope (Phase 2 / later, convenience layer)**: centralized
   `runtime/headless/reset.ts` with `coldReset(machine, config?)`
   entry-point.
   - Default config = VICE-default behavior 1:1.
   - Optional config injection: per-scenario init-state overrides
     for tests (e.g., pre-loaded RAM pattern, custom register
     pre-state, faked ZP values). Used as fixture-stub in tests
     that need controlled post-reset state.
3. **RAM init (Phase 1 / now)**: match VICE default exactly.
   - Port VICE `ram.c` RAMInit logic: RAMInitStartValue,
     RAMInitValueInvert, RAMInitValueOffset, RAMInitPatternInvert,
     RAMInitRandomChance.
   - Defaults match VICE defaults (alternating $00/$FF bands,
     specific startup-cell offsets).
   - Drive RAM 2K, C64 RAM 64K, both initialized via shared
     ram-init helper.
   - ZP $00/$01 (CPU port): VICE reset values per machine type
     (C64 6510 has specific defaults; drive 6502 has none).
4. **RAM init (Phase 2 / later)**: configurable pattern-injection
   per scenario.
   - Test fixtures pass `{ramPattern: ..., ramOverlay: [{addr,
     bytes}]}` to coldReset config. Snapshot-tests can fix
     pattern for reproducibility without coupling to VICE-default
     drift.
5. **Verification**: BOTH granular + holistic.
   - **Unit (granular, during dev)**: per-chip reset test.
     CIA1, CIA2, VIA1, VIA2, VIC, SID, CPU each have own unit
     test asserting register-byte values post-reset vs VICE
     captured fixture.
   - **Integration (holistic, gate)**: full machine cold-boot
     snapshot diff vs VICE. Dump ALL state (64K C64 RAM + 2K
     drive RAM + all chip registers + CPU registers). Diff vs
     captured VICE fixture. Zero-divergence required.
   - New smoke target: `smoke:reset-byte-exact`.

## Scope

### Point 19: drive RAM reset
- VICE drivecpu_reset: clears RAM via memset to $00? Actually
  VICE init-time uses RAMInit pattern; reset doesn't clear RAM
  (real HW: RAM persists across CPU reset, only POST clears).
  Verify by reading source.
- Real 1541 cold reset: RAM has random/uninitialized bytes. POST
  routine clears RAM ($EAA0+ in ROM).
- Currently our drive.bus.ram.fill(0). VICE: check exact behavior,
  match.

### Point 20: VIA reset state (cross-ref Spec 147)
Verifies VIA reset implementation from Spec 147 produces VICE-exact
byte values:
- viacore_reset clears registers but with specific timer latch
  defaults ($FFFF or $0000?).
- IFR/IER cleared per datasheet.
- ORA/ORB/DDRA/DDRB cleared.
- ACR/PCR cleared.
- T1 latch behavior on reset: VICE sets specific value.

### CIA reset state (cross-ref Spec 145)
Verifies CIA reset implementation from Spec 145 produces VICE-exact
byte values:
- ICR cleared.
- TOD: VICE sets specific values.
- Timer latches.

### Point 21: Boot order (DONE)
Already implemented (driveHeadStartCycles option). VICE simulates
both CPUs from cycle 0 simultaneously. Real HW: drive boots faster
(~10 frames). We default 0 = match VICE simulation.

### Out of scope
- VIC reset state details → Spec 150.
- SID reset state details → Spec 151.
- CPU reset details (PC=fetch-vector $FFFC, S=$FF, P=$24) →
  Spec 146.
- Spec 148 verifies these CHIPS post-reset state matches captured
  VICE fixtures, but does not implement chip resets — that lives
  in 145/146/147/150/151.

## Deliverables

### Phase 1 (now)
1. `src/runtime/headless/util/ram-init.ts` — VICE RAMInit logic
   port (RAMInitStartValue, RAMInitValueInvert,
   RAMInitValueOffset, RAMInitPatternInvert, RAMInitRandomChance).
2. ZP $00/$01 reset values for C64 6510 (drive 6502 has no port).
3. `tests/unit/reset/cia-reset.test.ts` —
   `via1d-reset.test.ts`, `via2d-reset.test.ts`, etc. one per chip.
4. `tests/fixtures/vice-reset-snapshots/` — captured cold-boot
   VICE fixtures (full machine state).
5. `tests/integration/reset-byte-exact.test.ts` — holistic diff.
6. `scripts/smoke-reset-byte-exact.mjs` — new smoke target.

### Phase 2 (later, convenience)
7. `src/runtime/headless/reset.ts` — centralized
   `coldReset(machine, config?)` entry.
8. Config schema: `ResetConfig` with optional fields:
   - `ramPattern?: 'vice-default' | 'zero' | 'random' | bytes[]`
   - `ramOverlay?: Array<{addr: number, bytes: BYTE[]}>`
   - `cpuRegistersPreset?: ...`
   - `chipRegisterPreset?: { cia1: {...}, ... }`
9. Test fixtures using config injection.

## Acceptance

### Phase 1 gate
- VICE RAMInit logic ported, configurable parameters match
  VICE defaults.
- ZP $00/$01 C64 reset value matches VICE.
- Per-chip reset unit tests pass (one per CIA1, CIA2, VIA1,
  VIA2, CPU; VIC + SID gated by 150/151 landing).
- Integration test `reset-byte-exact`: full cold-boot snapshot
  zero-divergence vs VICE fixture for both C64 + drive RAM and
  all chip registers.
- `smoke:reset-byte-exact` PASS.

### Phase 2 (when landed)
- `coldReset(machine, config?)` API in use by tests.
- Config injection works for pattern-override + register-preset.
- Phase 1 invariants still hold when config = default.

## Process

### Phase 1
1. Read VICE `ram.c` RAMInit logic, port to `ram-init.ts`.
2. Read VICE `c64.c` machine_specific_reset for C64 reset state
   details (ZP $00/$01).
3. Read VICE drivecpu.c + drive_reset_internal for drive reset
   state.
4. Capture VICE cold-boot fixture: VICE binary monitor `m $0000
   $ffff` + drive `device 8 m $0000 $07ff` + register dumps. Save
   as test fixture.
5. Per-chip reset unit tests against captured fixture data.
6. Integration test holistic diff.
7. New smoke target.

### Phase 2 (deferred)
1. Design ResetConfig schema.
2. Centralize coldReset() orchestrator.
3. Migrate test fixtures to use config injection.

## Estimated effort

Phase 1: 1 session (audit + capture + tests).
Phase 2: 0.5 session (mostly factoring, no new logic).

## Cross-reference

- Spec 145: CIA reset implementation.
- Spec 146: CPU reset implementation.
- Spec 147: VIA reset implementation.
- Spec 150: VIC reset implementation.
- Spec 151: SID reset implementation.
- Spec 148 verifies; it does not implement chip resets.
