# Spec 402 — C64 Phase B: Memory and PLA

**Status:** DONE (spec 401 recurring gate also passed).
**Branch:** `vice-arch-port`
**Depends on:** 401
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Goal

Bring memory map, PLA, processor port, and cartridge banking lines in
line with `docs/vice-c64-arch.md §12 Phase B` (steps 6–8).

## Doc anchor

- `docs/vice-c64-arch.md` §12 Phase B (steps 6–8)
- `docs/vice-c64-arch.md` §4.1 (16+ memory configs)
- `docs/vice-c64-arch.md` §4.2 (standard configurations table)
- `docs/vice-c64-arch.md` §4.3 (processor port $00/$01)
- `docs/vice-c64-arch.md` §4.4 (glue logic HMOS vs CMOS)
- `docs/vice-c64-arch.md` §4.5 (VIC-II banking via CIA2 PA 0..1)
- `docs/vice-c64-arch.md` §4.6 (watchpoint hooks)
- `docs/vice-c64-arch.md` §13 invariants 3, 11, 14

## Canonical content (verbatim §12 Phase B)

6. 16 mem configs: as in §4.2. Pre-build all 32 read tables and
   `NUM_VBANKS × 32` write tables at init.
7. Processor port $00/$01: DDR/data latches with pull-up fall-off.
   Bits 0..2 trigger `mem_pla_config_changed()`. Bits 3..5 hook the
   datasette. Bit fall-off alarm fires after 350 ms of being undriven
   high.
8. Cartridge lines GAME/EXROM: extend mem config selection to 5 bits
   (gives 32 configs, only ~22 unique). Cartridge changes lines on
   write to its banking register → mem reconfig.

## VICE source cite

- `c64pla_config_changed()`: `src/c64/c64pla.c:51`.
- `c64meminit.c`: builds the 32 read + 32×N_VBANKS write tables at
  init.
- `c64gluelogic.c`: HMOS/CMOS PLA difference.
- Processor port write: `c64mem.c` `zero_store()` /
  `pport_data_set_default_cpu()`.
- Fall-off alarm: `src/c64/c64.c` `c64_init()` schedules the discharge
  alarm with `CYCLES_*` per 350 ms.
- VIC banking: CIA2 PA store callback calls
  `vicii_set_vbank(phi1 | (phi2 << 1))` in `src/c64/c64cia2.c:148-162`.

## Audit — current TS state

Source files to audit:

- `src/runtime/headless/memory-bus.ts`
- `src/runtime/headless/pla/*.ts` (if exists; else identify where
  PLA logic lives)
- `src/runtime/headless/cpu/io-port-6510.ts`
- `src/runtime/headless/peripherals/cia2.ts` (VIC banking)
- `src/runtime/headless/cartridge/*.ts` (if cartridge support
  partially present)

Known deviations to verify (fresh session fills file:line):

1. **16 mem configs precomputed tables** (§4.1, §4.2, §12 step 6):
   - Required: 32 read tables (`mem_read[256]` × 32) + `N_VBANKS × 32`
     write tables, indexed `(addr >> 8)` per page, swapped wholesale
     on PLA config change.
   - Current TS: `HeadlessMemoryBus` uses I/O handlers + RAM array.
     Verify whether memory map is rebuilt as 32 tables on
     `(LORAM|HIRAM|CHAREN|GAME|EXROM)` change or simulated via
     `if/else` on each access. The latter deviates.
   - **TODO fresh session**: file:line of memory read/write entry +
     PLA reconfig hook.

2. **Processor port $00/$01 latch + fall-off** (§4.3, §13 invariant 11,
   §12 step 7):
   - Required: DDR + data registers; bits 0..2 trigger
     `mem_pla_config_changed`. Unused-bit fall-off alarm fires after
     ~350 ms (~`22e6` cycles PAL).
   - Current TS: `cpu/io-port-6510.ts` exists. Verify it implements
     fall-off and PLA reconfig trigger.
   - **TODO fresh session**: confirm fall-off alarm registered with
     `maincpu` alarm context (not orphan timer).

3. **Cartridge GAME/EXROM extension** (§4.1, §12 step 8):
   - Required: 5-bit selector `(LORAM|HIRAM|CHAREN|GAME|EXROM)` →
     32-entry config table; only ~22 unique.
   - Current TS: any cartridge support TBD. If absent, spec scope
     limited to building the 5-bit hook with stub `GAME=EXROM=1` for
     no-cartridge case.
   - **TODO fresh session**: enumerate cartridge code paths;
     `GAME`/`EXROM` lines source.

4. **VIC-II banking via CIA2 PA bits 0..1** (§4.5, §13 invariant 14):
   - Required: CIA2 PA store → `vicii_set_vbank(phi1, phi2)`.
   - Current TS: kernel hooks `iecWrite` on CIA2 PA store, calls
     `vic.recordCia2PaChange(or & 0xff)`. Verify path: `iecWrite`
     extracts bits 0..1 inverted (= VIC bank) and updates both
     `phi1` and `phi2` paths per §5.10.
   - **TODO fresh session**: cite `c64cia2.c:148-162` vs current TS
     CIA2 install code.

5. **Chargen mirroring in VIC banks 0+2** (§13 invariant 14):
   - Required: VIC sees chargen at `$1000-$1FFF` only when in bank 0
     or 2. Banks 1, 3 → RAM.
   - Current TS: literal-port VIC fetch path uses VIC mem table per
     §5.10. Verify mirroring is implemented in the VIC fetch dispatch.
   - **TODO fresh session**: identify VIC fetch dispatcher TS file +
     mirroring branch.

## TS extras to DELETE

- Any non-VICE memory abstraction (e.g. "mode-aware" RAM that bypasses
  the 32-config table).
- Bus-trace helpers that are not in VICE's read/write path.
- Watchpoint hooks per §4.6 stay (VICE has them) but must use the
  per-page table interception, not a separate layer.

## NTSC stub

- PLA configs are identical PAL/NTSC.
- Fall-off discharge cycles are derived from CPU clock — VICE uses
  `machine_get_cycles_per_second()`. PAL: `985248 * 0.350 ≈ 344836`.
  NTSC: `1022730 * 0.350 ≈ 357956`. Stub `// TODO NTSC` for the
  NTSC rate; PAL hard-coded for now per refinement Q10.

## Producer changes

1. Implement 32-entry config table per §4.1 / §4.2 with explicit
   `(LORAM, HIRAM, CHAREN, GAME, EXROM)` indexing. Build at init
   (`c64meminit.c` analog).
2. Wire processor port $00/$01 store → PLA reconfig hook +
   datasette hook (datasette in spec 405 / Phase E; stub the slot now).
3. Implement fall-off alarm on bits 6/7 of $01 with 350 ms PAL
   timing.
4. Confirm CIA2 PA write → VIC bank update via §4.5 path.

## Consumer changes

- VIC fetch dispatcher: switch chargen-mirror branch on current VIC
  bank per §13 invariant 14.
- CIA2: store callback already updates VIC bank — confirm `phi1` +
  `phi2` symmetric handling per §5.10.
- Cartridge stub: GAME=EXROM=1 hard-wired until cartridge spec lands.

## Acceptance

- `npm run build` zero errors.
- `npm run smoke:cpu-fidelity` 31/31, `npm run smoke:cia-fidelity` 22/22.
- New smoke `scripts/smoke-402-pla-configs.mjs`: iterate all 16
  no-cart configs, write a known byte to a marker address, read
  back via expected per-config path (RAM, KERNAL ROM, BASIC ROM,
  CHARGEN, I/O). Assert read matches VICE table per §4.2.
- New smoke `scripts/smoke-402-cpuport-falloff.mjs`: set bits 6/7
  to input, drive high, advance `350ms * 985248` cycles, assert
  reads fall to 0.
- MM s1 + Scramble Infinity unchanged (memory map is upstream of
  game state).

## Open Questions

- **OQ-402-1 — RESOLVED** → `docs/vice-c64-arch.md §4.1`.
  `NUM_CONFIGS = 32` (`src/c64/c64mem.c:80`), `NUM_VBANKS = 4`
  (`:83`). 5 input bits (LORAM, HIRAM, CHAREN, GAME, EXROM) →
  32 slots; ~14 unique in stock-C64 use, the rest are duplicates.
  VICE allocates the full 32-entry table for branchless dispatch.
- **OQ-402-2 — RESOLVED** → `docs/vice-c64-arch.md §4.3`.
  `C64_CPU6510_DATA_PORT_FALL_OFF_CYCLES = 350000`
  (`src/c64/c64.h:79` ≈ 355 ms @ PAL 985248 Hz). SX-64 variant for
  bits 3..5 = 1500000 (`c64.h:81`). Random jitter
  `FALLOFF_RANDOM = CONST / 5` is added at schedule time
  (`c64mem.c:366`). Lorenz `cpuports.prg` fails below 5984 cycles
  (`c64.h:83`). Doc previously said "~22M cycles at 1 MHz" — that
  was wrong; corrected.
- **OQ-402-3 — RESOLVED** → `docs/vice-c64-arch.md §4.4`. Default
  for `VICE_MACHINE_C64` (= x64 and x64sc) is **`GLUE_LOGIC_DISCRETE`
  = HMOS** (`src/c64/c64gluelogic.c:144`). The resource's generic
  factory_value at `:136` is CUSTOM_IC, but is overridden to
  DISCRETE for the C64 machine class. Other machines (C128 etc.)
  keep CUSTOM_IC.

## Files touched (planned)

- `src/runtime/headless/memory-bus.ts` (modify, possibly large)
- `src/runtime/headless/pla/c64pla.ts` (new or modify if exists)
- `src/runtime/headless/cpu/io-port-6510.ts` (modify — fall-off)
- `src/runtime/headless/peripherals/cia2.ts` (verify VIC bank path)
- `scripts/smoke-402-pla-configs.mjs` (new)
- `scripts/smoke-402-cpuport-falloff.mjs` (new)
- `specs/402-c64-phase-b-memory-pla.md` (this)

## Next spec

Spec 403 — C64 Phase C: Peripherals (CIAs).
