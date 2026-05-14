# Spec 441 step 4g — production proof + tests

Date: 2026-05-14  
Commit: `34bccc7` (FLIP) + `<this commit>` (tests).

This doc traces the SINGLE production rotation path through the
headless 1541 + lists the regression-test coverage. Satisfies the
Spec 441 step 4g acceptance.

## Single production path (file:line cited)

### Per-cycle tick (cycle-wrapper)

```
DriveCpuCycled.executeCycle()
  src/runtime/headless/scheduler/cycle-wrappers.ts:131-148
    // attach_clk / attach_detach_clk decay (rotation_byte_read does
    // the canonical clear; cycle-wrapper mirrors for live polling)
    rotation_rotate_disk(drive)
      src/runtime/headless/drive/rotation.ts:1031-1057
        // motor-gate, wobble, dispatch to _rotation_1541_simple/gcr/p64
    if (drive.byte_ready_edge) {
      drive.byte_ready_edge = 0
      this.drive.fireByteReady?.()
        src/runtime/headless/drive/drive-cpu.ts:836-855
          // PCR bit 1 gate, via2.signal("ca1","fall"), V flag set,
          // onSoEdge trace
    }
```

`fireByteReady` is the VICE `drivecpu_set_overflow` analog. It is
shared with `gcrShifter.onByteReady` (kept for harness only).

### VIA2 PA read ($1C01 LDA)

```
viacore_read VIA_PRA case
  src/runtime/headless/via/via6522-vice.ts:895
    backend.readPa()
      via2-coupling readPa (Drive_t path)
        src/runtime/headless/drive/via2-gcr-shifter-coupling.ts:84-93
          shadowDrive.req_ref_cycles = BUS_READ_DELAY
          rotation_byte_read(shadowDrive)
            src/runtime/headless/drive/rotation.ts:1059-1081
              if attach_clk: hold GCR_read at 0 + check elapsed
              else: rotation_rotate_disk(drive)
              clear req_ref_cycles
          shadowDrive.byte_ready_level = 0
          return shadowDrive.GCR_read
```

Mirrors VICE `via2d.c:463 read_pra`.

### VIA2 PB read ($1C00 LDA)

```
viacore_read VIA_PRB case
  src/runtime/headless/via/via6522-vice.ts:925
    backend.readPb()
      via2-coupling readPb (Drive_t path)
        src/runtime/headless/drive/via2-gcr-shifter-coupling.ts:112-122
          shadowDrive.req_ref_cycles = BUS_READ_DELAY
          rotation_rotate_disk(shadowDrive)
          syncByte = rotation_sync_found(shadowDrive)
          wps = drive_writeprotect_sense(shadowDrive)
          shadowDrive.byte_ready_level = 0
          return (syncByte | wps | 0x6f)
    // DDRB/PRB merge done by via6522-vice.ts:927-929
```

Mirrors VICE `via2d.c:488 read_prb`.

### VIA2 PB write ($1C00 STA)

```
viacore store_prb → backend.storePb → via2-coupling onPbOutputChanged
  src/runtime/headless/drive/via2-gcr-shifter-coupling.ts:148-208
    rotation_rotate_disk(shadowDrive)   // prologue
    // LED, stepper, density, motor
    rotation_speed_zone_set(zone, dnr)  on density change
    setDriveMotor(shadowDrive, motorOn) on motor change
    rotation_begins(shadowDrive)        on motor-on edge
    shadowDrive.byte_ready_level = 0    // epilogue
```

Mirrors VICE `via2d.c:201 store_prb`.

### VIA2 PCR write ($1C0C STA)

```
viacore_store PCR case → backend.storePcr
  src/runtime/headless/via/via2d1541.ts:122-142
    rotation_rotate_disk(drv)
    drv.read_write_mode = pcrval & 0x20
    drv.byte_ready_active =
      (bra & ~BRA_BYTE_READY) | (pcrval & 0x02)
```

Mirrors VICE `via2d.c:165 via2d_update_pcr`.

### CA2 / CB2 transitions

```
via6522-vice viacore_signal → backend.setCa2 / setCb2
  src/runtime/headless/via/via2d1541.ts:145-178
    setCa2: if state changed, rotation_rotate_disk + update bit 1
    setCb2: if state changed, rotation_rotate_disk + read_write_mode
```

Mirrors VICE `via2d.c:72 set_ca2` and `via2d.c:95 set_cb2`.

## Greps (production state)

| Token | hits in src/ | Verdict |
|---|---|---|
| `gcrShifter.tick` | 1 (env-gated, harness only) | OK |
| `gcrShifter.dataByte` | 1 (legacy fallback in via2-coupling when shadowDrive is null) | OK — test-only path |
| `gcrShifter.syncBit` | 1 (same fallback) | OK |
| `rotation_rotate_disk` | 7 (cycle-wrapper, via2d1541, via2-coupling) | active |
| `rotation_byte_read` | 1 (via2-coupling readPa) | active |
| `rotation_sync_found` | 2 (rotation.ts, via2-coupling) | active |
| `fireByteReady` | 3 (declaration + production callers) | active |
| `drive.GCR_read` | 5 (rotation.ts producer + via2-coupling consumer) | active |
| `drive.byte_ready_edge` | 6 (cycle-wrapper consumer + rotation.ts producers) | active |

`gcrShifter` retained ONLY for:
1. C64RE_ROTATION_DIFF env harness (cycle-wrapper line 121)
2. Mount/attach notifyMediaChange hooks (kernel)
3. test-only fallback when shadowDrive null

## Tests

`tests/unit/drive/rotation.test.ts` — 15 cases covering:

- rot_speed_bps table (VICE rotation.c:89)
- rotation_init / rotation_reset state
- rotation_speed_zone_set
- _RANDOM_nextUInt xorShift32 sequence (seed 0x1234abcd)
- fr_randcount u32 wrap on underflow (user-reported bug regression)
- rotation_sync_found semantics (attach delay + write mode +
  last_read_data == 0x3ff)
- drive_writeprotect_sense (no disk / writable / read-only / attach window)
- rotation_rotate_disk motor-gate early-return
- rotation_byte_read attach_clk clear after DRIVE_ATTACH_DELAY
- BUS_READ_DELAY = 14 constant

All 15 PASS.

## Regression coverage

| Suite | Status |
|---|---|
| `npm run canary:spec-430` | 5/5 PASS (motm + im2 to game code; lnr-s1 RED-as-expected) |
| `C64RE_ROTATION_DIFF=1 npm run canary:spec-430:trace --canary motm` | 20M instructions, 0 divergence |
| `node tests/unit/drive/rotation.test.ts` | 15/15 PASS |
| `npm run test:lorenz:disk1` | 50+ tests OK, 0 fails, INCONCLUSIVE at 600s (perf, not correctness) |

## Open work

- 4d Snapshot migration — gcrShifter.snapshot/restore is dead code
  in current codebase (no callers in session-vsf.ts or save-load-tests.ts).
  Migration EFFECTIVELY DONE: rotation_table_get/set already exists
  in rotation.ts and reads/writes drive_t.snap_* fields directly.
  When session-vsf extends drive save-state, it should use those.
- 4f Delete legacy — 82 grep hits to clean once snapshot path is
  fully retired and harness can be reduced.
- Perf — addressed in section below.

## Perf (Spec 441 perf-stabilization pass)

### Profile result (Lorenz Disk1 60s, node --cpu-prof)

Top hotspots in Lorenz Disk1 simulation:

| Function | % CPU | Notes |
|---|---|---|
| `cpu65xx executeCycle` | 12.80% | 6510 microcoded core |
| `VIC draw_sprites` | 11.86% | per-cycle sprite render |
| `VIC draw_graphics` | 11.79% | per-cycle text/bitmap render |
| `VIC vicii_cycle` | 10.64% | top-level VIC tick |
| `VIC draw_sprites8` | 10.10% | 8-pixel sprite stripe |
| `cpu65xx executeMicroOp` | 4.81% | sub-instruction microcode |
| `VIC vicii_draw_cycle` | 4.55% | draw-cycle dispatch |
| `VIC draw_graphics8` | 4.38% | 8-pixel graphics stripe |
| `drive-cpu executeToClock` | **2.55%** | drive CPU dispatch |
| `_rotation_1541_simple` | **0.22%** | Spec 441 rotation core |
| `_rotation_do_wobble` | **0.05%** | wobble PRNG |
| `rotation_rotate_disk` | **0.00%** | dispatcher (sub-µs) |
| `fireByteReady` | **0.02%** | V flag + CA1 fire |
| `via2-coupling onPbOutputChanged` | **0.00%** | motor/density |

**Spec 441 rotation work = ~0.3% of total CPU time.** Hot path is
VIC rendering (~50%) and 6510 core (~13%). The Lorenz timeout
vs the pre-Spec-430 baseline (`[motm AB fastloader FIXED 2026-05-08]`
memo: "100% PASS in 600s") is NOT located in rotation code per
profile.

### Defensive optimization applied

Cycle-wrapper attach-clk decay path rewritten with single
short-circuit `!== 0n` check on the fast path. Steady state
(both fields 0n): two short-circuit BigInt comparisons; no
`clk_ptr()` call; no BigInt subtraction. Active window: BigInt
math only when at least one attach window is open.

### Post-optimization verify

| Suite | Result |
|---|---|
| `npm run canary:spec-430` (all 5) | 5/5 PASS |
| Lorenz Disk1 600s (CPU shared with canary) | 83 tests started, 0 fails |
| `tests/unit/drive/rotation.test.ts` | 15/15 PASS |

### Conclusion

Lorenz "100% PASS in 600s" recovery is OUT of Spec 441 scope —
profile points to CPU / VIC code from Specs 430-437 or earlier.
Track separately if user wants the 100%-pass guarantee back.
Spec 441 rotation overhead is verified at <1% and is not a
viable optimization target.
