# Spec 441 — Mapping: VICE `rotation.c` → TS `rotation.ts`

**Step 1 of 7** (per Spec 440 workflow gate). Created 2026-05-13.

## Source files

- VICE: `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.c` (1349 LoC)
- VICE: `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.h` (49 LoC)
- TS target: `src/runtime/headless/drive/rotation.ts` (NEW — replaces `gcr-shifter.ts`)

## Doctrine

- All functions ported. No subset. (Per `feedback_vice_no_alternatives`.)
- Literal C-function API as TS top-level functions; `rotation_t` as plain TS interface, not class.
- VICE field names verbatim (snake_case retained).
- Old `gcr-shifter.ts` REMOVED after migration; callers updated.
- No subagent verdicts.

## Struct `rotation_t` (rotation.c:48-83)

| VICE field | C type | TS mapping | Notes |
|---|---|---|---|
| `accum` | uint32_t | `number` (≥0 u32) | bit-time accumulator |
| `rotation_last_clk` | CLOCK | `bigint` | last drive clock seen |
| `last_read_data` | unsigned int | `number` (u32) | 17-bit shift register |
| `last_write_data` | uint8_t | `number` (u8) | last byte to write |
| `bit_counter` | int | `number` | 0-7 within byte |
| `zero_count` | int | `number` | post-sync zero count |
| `frequency` | int | `number` (0/1) | 1×/2× speed select |
| `speed_zone` | int | `number` (0..3) | density zone |
| `ue7_dcba` | int | `number` | UE7 b1/b0 inputs |
| `ue7_counter` | int | `number` | UE7 4-bit counter |
| `uf4_counter` | int | `number` | UF4 4-bit counter |
| `fr_randcount` | uint32_t | `number` | flux reversal counter |
| `filter_counter` | int | `number` | flux filter ignore |
| `filter_state` | int | `number` | flux filter current |
| `filter_last_state` | int | `number` | flux filter previous |
| `write_flux` | int | `number` | write flux state |
| `so_delay` | int | `number` | SO line delay |
| `cycle_index` | uint32_t | `number` | |
| `ref_advance` | CLOCK | `bigint` | pre-simulated cycles |
| `PulseHeadPosition` | uint32_t | `number` | head position (P64) |
| `seed` | uint32_t | `number` | random seed |
| `xorShift32` | uint32_t | `number` | wobble PRNG state |

## Constants / tables

| VICE | Line | TS export |
|---|---|---|
| `NUM_DISK_UNITS` | drive.h | `NUM_DISK_UNITS = 4` |
| `rot_speed_bps[2][4]` | 89 | `ROT_SPEED_BPS` (already in gcr-shifter.ts → moved) |
| Module-static `rotation[NUM_DISK_UNITS]` | 86 | `rotation: rotation_t[]` (4 entries) |

## Function map (1:1 port required)

| VICE function | Line | Status today | TS export name | Notes |
|---|---|---|---|---|
| `rotation_init` | 93 | gcr-shifter constructor (partial) | `rotation_init(freq, dnr)` | seed xorShift32, clear all fields |
| `rotation_reset` | 111 | `GcrShifter` constructor (partial) | `rotation_reset(drive)` | full state reset, re-seed wobble PRNG |
| `rotation_speed_zone_set` | 139 | `setDensity()` (partial) | `rotation_speed_zone_set(zone, dnr)` | |
| `rotation_table_get` | 145 | MISSING | `rotation_table_get(out_ptr)` | export snapshot for save-state |
| `rotation_table_set` | 184 | MISSING | `rotation_table_set(in_ptr)` | restore snapshot |
| `rotation_overflow_callback` | 222 | MISSING | `rotation_overflow_callback(sub, dnr)` | clk-wrap adjustment |
| `write_next_bit` (static) | 227 | MISSING | `_write_next_bit(drive, value)` | bit write to track |
| `read_next_bit` (static) | 256 | inline in `advanceOneBit` (partial) | `_read_next_bit(drive)` | bit read from track |
| `RANDOM_nextInt` (static) | 280 | MISSING | `_RANDOM_nextInt(rot)` | xorShift32-based int |
| `RANDOM_nextUInt` (static) | 288 | MISSING | `_RANDOM_nextUInt(rot)` | xorShift32-based uint |
| `rotation_begins` | 295 | MISSING | `rotation_begins(drive)` | start rotation, anchor clk |
| `rotation_do_wobble` (static) | 308 | partial in `tick()` | `_rotation_do_wobble(drive)` | UE7 wobble adjustment |
| `rotation_1541_gcr` (static) | 339 | **MISSING** | `_rotation_1541_gcr(drive, ref_cycles)` | full UE7/UF4 flux filter — ~230 LoC |
| `rotation_1541_gcr_cycle` (static) | 572 | **MISSING** | `_rotation_1541_gcr_cycle(drive)` | per-cycle flux filter step |
| `rotation_p64_get_delta` (static inline) | 618 | MISSING | `_rotation_p64_get_delta(drive)` | P64 NRZI delta |
| `rotation_1541_p64` (static) | 635 | **MISSING** | `_rotation_1541_p64(drive, ref_cycles)` | P64 catch-up — ~310 LoC |
| `rotation_1541_p64_cycle` (static) | 944 | **MISSING** | `_rotation_1541_p64_cycle(drive)` | P64 per-cycle step |
| `rotation_1541_simple` (static) | 989 | tick() partial port | `_rotation_1541_simple(drive)` | simple G64 bit-shifter |
| `rotation_rotate_disk` | 1106 | `tick()` callable | `rotation_rotate_disk(drive)` | dispatch by image type/mode |
| `rotation_sync_found` | 1134 | `syncBit` getter | `rotation_sync_found(drive) → uint8` | VIA2 PB7 input |
| `rotation_byte_read` | 1145 | `dataByte` getter | `rotation_byte_read(drive)` | latch GCR byte for VIA2 PA |
| `rotation_change_mode` | (rotation.h) | MISSING | `rotation_change_mode(dnr)` | mode switch (Spec 411 territory) |

## Current TS state — gcr-shifter.ts

`gcr-shifter.ts` claims "1:1 port of rotation_1541_simple". Reality:
- Implements ONLY simple path (1541_gcr + 1541_p64 missing entirely)
- Class-API with TS-idiomatic getters/methods (NOT literal C functions)
- VICE field names partially preserved (`last_read_data`, `bit_counter`, `accum`) and partially renamed (`accumX8`, `motorOn`, `rotationTickCount`)
- Wobble PRNG seeded (✓) but `rotation_do_wobble()` body not literal
- Attach/detach delay model is TS-only, not in rotation.c (probably belongs to drive.c — verify)

This file is **DELETED** in step 3.

## Out-of-scope (this spec, for now)

- `disk_track_t` struct (defined in `gcr.h`) — already partially in `gcr.ts`, fully owned by Spec 445
- `drive_t` full struct — owned by `drive-cpu.ts` (Spec 444)
- Alarm-context integration if any — verify in step 2 whether rotation_overflow_callback is called by alarm; if yes block on Spec 448; if no proceed

## Step-1 acceptance

- ✅ This doc committed
- ✅ All `rotation.c` functions enumerated (22 entries above)
- ✅ All `rotation_t` fields enumerated (22 entries above)
- ✅ Status today of TS gcr-shifter.ts honestly documented

## Next step

Step 2 — port `rotation.c` literal into `src/runtime/headless/drive/rotation.ts`. Replace gcr-shifter.ts. Update callers (head-position, drive-cpu, integrated-session, snapshot).

Will pause again if any non-trivial architecture call surfaces during port (per workflow gate step 7).
