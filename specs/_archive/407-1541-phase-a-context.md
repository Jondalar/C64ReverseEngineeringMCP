# Spec 407 — 1541 Phase A: Per-drive context

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 406
**Doctrine:** 1:1 VICE TDE port. Never deviate.

## Goal

Bring the per-drive context struct in line with
`docs/vice-1541-arch.md §13 Phase A` (steps 1–2) and §2 (drive
lifecycle).

## Doc anchor

- `docs/vice-1541-arch.md` §13 Phase A
- §2.1 two-level structure `diskunit_context_t × drive_t`
- §2.2 drive types relevant for 1541-family
- §2.3 boot / init sequence

## Canonical content (verbatim §13 Phase A)

1. Allocate `diskunit_context_t[N]`, each with its own `clk_ptr`,
   2-element `drives[]`, CPU + cpud structs, VIA1 + VIA2 contexts,
   ROM + RAM buffers, alarm context.
2. For 1541 specifically: `clock_frequency = 1`, drives[1] unused,
   `cia1571 = NULL`.

## VICE source cite

- `diskunit_context_t`: `src/drive/drivetypes.h:166`.
- `drive_t`: `src/drive/drive.h:236`.
- Per-unit allocation: `src/drive/drive.c:162` `drive_init()`.

## Audit — current TS state

Source files:

- `src/runtime/headless/drive/drive-cpu.ts`
- `src/runtime/headless/drive/drive-bus.ts` (or similar)
- `src/runtime/headless/drive/drive-types.ts` (if exists)

Known status:

- Single-drive only (drive 8). Multi-drive deferred (memo
  `multi-drive-architecture.md` archived).
- `DriveCpu` class encapsulates per-drive 6502 + VIA1 + VIA2 +
  rotation.

Deviations to verify:

1. **Struct shape parity** (§2.1):
   - Required: explicit `diskunit_context_t` + nested
     `drive_t drives[2]` (1541 uses only drives[0]).
   - Current TS: `DriveCpu` is one flat class. Not literal struct
     shape but functionally equivalent. Per refinement Q11 +
     doctrine 1:1, restructure to nested form.
   - **TODO fresh session**: propose `Drive1541Unit` (= diskunit) +
     `DriveSlot` (= drive_t) split.

2. **`clk_ptr` plumbing** (§3.1):
   - Required: pointer to drive's own clock field, accessible to
     6502 core + VIA cores + rotation.
   - Current TS: `cycled.cycles` getter; closures pass it around.
   - **TODO fresh session**: confirm single source of truth + no
     duplicate clock counters.

3. **`clock_frequency = 1`** (§13 step 2):
   - Required: explicit constant for 1541; affects sync formula.
   - Current TS: not explicit. Likely buried in `syncFactor16dot16`
     calc.

## TS extras to DELETE

- Any "multi-mode" drive abstraction (1541-II, 1571, CMD) wrappers
  not in VICE. Until spec for those, hard-code 1541.

## NTSC stub

- `clock_frequency` is the same (= 1 MHz drive). PAL/NTSC switch
  affects `sync_factor` only (= Phase C).

## Producer changes

1. Define `Drive1541Unit` type matching `diskunit_context_t` shape:
   - `clk: CLOCK` (per-unit clock)
   - `drives: [DriveSlot, DriveSlot]` (1541 uses [0] only)
   - `cpu: Cpu65xxVice` (= drive 6502)
   - `cpud: DriveCpuData` (= dispatch tables, ctx)
   - `via1: Via1d1541`, `via2: Via2d1541`
   - `rom: Uint8Array(16384)`, `ram: Uint8Array(0x800)`
   - `alarmContext: AlarmContext`
2. `DriveSlot` (= `drive_t`): per-physical-drive state (rotation,
   GCR buffer, head position, motor).
3. Reset / shutdown stubs matching `drive_init` /
   `drive_shutdown` shape.

## Consumer changes

- `IntegratedSession` constructs `Drive1541Unit` instead of
  flat `DriveCpu`.
- All call sites accessing drive state migrate to nested
  `unit.drives[0].rotation`, `unit.via1`, etc.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- New smoke `scripts/smoke-407-drive-struct.mjs`: assert presence
  of nested fields per §2.1.
- MM + Scramble unchanged.

## Open Questions

- **OQ-407-1**: RESOLVED 2026-05-11 — doc §17. 1541 uses only
  `drives[0]`. `drives[1]` is allocated for 1571 dual-side ONLY.
  For the 1541-only port: allocate a single slot or leave
  `drives[1]=NULL`. Cite `drivetypes.h:169` `drives[NUM_DRIVES]`.
- **OQ-407-2**: RESOLVED 2026-05-11 — doc §17. VICE explicitly
  separates `drivecpu_context_t` (registers, clock, alarm, PC base)
  from `drivecpud_context_t` (256-page dispatch tables, sync_factor).
  Split exists for cache locality. TS should split. Cite
  `drivetypes.h:99-137`, doc §3.1.

## Files touched

- `src/runtime/headless/drive/drive-cpu.ts` (refactor)
- `src/runtime/headless/drive/drive-types.ts` (new)
- `src/runtime/headless/integrated-session.ts` (consumer rewrite)
- 1 new smoke
- `specs/407-1541-phase-a-context.md` (this)

## Next spec

Spec 408 — 1541 Phase B: CPU and memory.
