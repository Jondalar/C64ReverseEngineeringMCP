# Spec 408 — 1541 Phase B: CPU and memory

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 407
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring drive 6502 + memory dispatch in line with
`docs/vice-1541-arch.md §13 Phase B` (steps 3–6).

## Doc anchor

- §13 Phase B
- §3 Drive 6502 CPU (§3.1 per-drive context, §3.2 exec loop,
  §3.3 macro template, §3.4 idle methods, §3.5 interrupt model)
- §4 Drive memory map (§4.1 layout, §4.2 dispatch tables, §4.3 ROM)
- §14 invariants 8 (open bus)

## Canonical content (verbatim §13 Phase B)

3. 6502 core (or reuse the C64 one, same template). Wire LOAD/STORE
   to per-drive page-indexed dispatch tables.
4. Page-indexed dispatch tables: 256 entries × {read, store, peek}.
   Initialize all to "open bus" (`drive_read_free` /
   `drive_store_free`), then overlay RAM, VIA1, VIA2, ROM as in §4.2.
5. ROM loading: load 16 KB into `rom[$0000..$3FFF]`, expose at CPU
   addresses $C000-$FFFF via dispatch table.
6. Reset vector: at reset, fetch $FFFC/$FFFD into PC. (1541 ROM
   reset entry ≈ $EAA0.)

## VICE source cite

- Drive CPU exec: `src/drive/drivecpu.c:356` `drivecpu_execute()`.
- Drive CPU macros: `src/drive/drivecpu.c:394-440`.
- Drive memory init: `src/drive/drivemem.c:217` `drivemem_init()`.
- ROM loader: `src/drive/driverom.c` `driverom_load_images()`.

## Audit — current TS state

Files:

- `src/runtime/headless/drive/drive-cpu.ts`
- `src/runtime/headless/drive/drive-bus.ts`
- `src/runtime/headless/cpu/cpu65xx-vice.ts` (shared 6502/6510 core)

Status:

- 6502 = `Cpu65xxVice` (shared with C64 6510, microcode template
  identical = VICE pattern). OK 1:1.
- ROM: 1541 ROM loaded in `resources/roms/`. Verify dispatch.
- Dispatch tables: VICE has per-page arrays; TS likely uses
  `registerIoHandler` per address range. Audit.

Deviations to verify:

1. **Per-page dispatch tables** (§4.2, §13 step 4):
   - Required: 256-entry array of `{read, store, peek}` function
     pointers, indexed by `(addr >> 8)`.
   - Current TS: per-address handler map. Per refinement Q11,
     restructure to per-page arrays exactly.

2. **Open-bus stubs** (§14 invariant 8):
   - Required: unmapped pages return open bus (= `drive_read_free`
     reads last bus value).
   - Current TS: unknown. Verify reads outside RAM/VIA/ROM return
     open bus, not 0xFF or 0.

3. **ROM exposure $C000-$FFFF** (§4.3, §13 step 5):
   - Required: 16 KB ROM at $C000-$FFFF (= 64 pages).
   - Current TS: `drive-bus.ts` registers drive ROM read handler.
   - **TODO fresh session**: confirm exact address range.

4. **Reset vector** (§13 step 6):
   - Required: on hard reset, drive 6502 fetches $FFFC/$FFFD =
     $EAA0 (1541 ROM entry).
   - Current TS: `drive-cpu.ts` reset path. Verify.

## TS extras to DELETE

- Per-address I/O handler map for drive memory (replace with
  per-page table per §4.2).
- Any cycle-counting bypass that skips the 6502 microcode template.

## NTSC stub

- Drive clock is 1 MHz independent of PAL/NTSC. No NTSC stub here
  (sync factor is Phase C).

## Producer changes

1. Restructure drive memory dispatch to per-page tables.
2. Confirm `drive_read_free` / `drive_store_free` open-bus stubs.
3. Confirm reset vector path.

## Consumer changes

- `IntegratedSession` drive memory registration — call sites adapt
  to per-page table.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31 (drive 6502 = shared core).
- New smoke `scripts/smoke-408-drive-mem-dispatch.mjs`: write to
  RAM ($0000-$07FF), VIA1 ($1800-$180F), VIA2 ($1C00-$1C0F), ROM
  ($C000-$FFFF read-only), open bus elsewhere. Each page returns
  correct dispatcher.
- MM + Scramble unchanged.

## Open Questions

- **OQ-408-1**: RESOLVED 2026-05-11 — doc §17, §4.1, §4.2. VIA1
  window is **$1800-$1BFF** (4 pages = 1024 bytes, 16 regs mirrored
  ×64 within the window). Dispatch sets pages `0x18..0x1c`. With
  RAM-expansion-mod disabled, the window is also mirrored at $3800,
  $5800, $7800. Cite `src/drive/iec/memiec.c:143,149,156,163`.
- **OQ-408-2**: RESOLVED 2026-05-11 — doc §17, §4.1. $0800-$17FF on
  stock 1541 is **open bus** (`drive_read_free`). RAM mirror at
  $0800 only when the `drive_ram2_enabled` RAM-expansion-mod flag
  is set. Cite `memiec.c:142,145-151`.

## Files touched

- `src/runtime/headless/drive/drive-bus.ts` (refactor)
- `src/runtime/headless/drive/drive-cpu.ts` (verify reset)
- 1 new smoke
- `specs/408-1541-phase-b-cpu-memory.md` (this)

## Next spec

Spec 409 — 1541 Phase C: Sync model.
