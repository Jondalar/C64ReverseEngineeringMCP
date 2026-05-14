# Spec 441 — production proof + tests + perf (FINAL)

Date: 2026-05-14  
Status: **DONE** (4f legacy delete deferred — see "Deferred" below).  
Branch: `1541-literal-vice`.  
Key commits:
  - `34bccc7` — FLIP works: VICE-literal VIA2 backend port
  - `d797f40` — flip-result progress
  - `8123dc4` — snapshot status + production-proof + rotation tests
  - `<perf>` — fast-path attach-clk guard
  - `<this>` — final docs.

## Source of truth

**`rotation.ts` is the production primitive for the 1541 disk-side
bit-stream.** All VIA2 PA/PB/PCR/CA2/CB2 backend hooks read and
write `drive_t` fields and call `rotation_byte_read` /
`rotation_rotate_disk` per VICE `via2d.c`. Drive byte-ready
edges (`drive.byte_ready_edge`) consumed in the cycle wrapper
via `DriveCpu.fireByteReady` (VICE `drivecpu_set_overflow`
analog).

`drive_t` is the literal mirror of VICE `drive_t` (50 fields,
file `src/runtime/headless/drive/drive-t.ts`). `rotation_t`
mirror is module-internal in `rotation.ts`. P64 image format
helpers are throwing stubs gated by `isP64Image` mount-time
detection ([[feedback_p64_stubs_ok]]).

This doc traces the SINGLE production rotation path through the
headless 1541 + lists the regression-test coverage. Satisfies
the Spec 441 acceptance (4a + 4b + 4c + 4d + 4e + 4g; 4f
deferred).

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

## gcrShifter remaining roles

`gcrShifter` (`src/runtime/headless/drive/gcr-shifter.ts`) is no
longer on the production rotation path. It survives in the tree
solely for:

1. **A/B verify harness** — `C64RE_ROTATION_DIFF=1` env-gated
   parallel tick in `cycle-wrappers.ts:147-149`. Used by
   `rotation-diff-harness.ts` to cross-check rotation.ts output
   per cycle. Production runs (env unset) never tick the
   shifter.
2. **Mount / attach notification sink** — `mount.ts` continues
   to invoke `gcrShifter.notifyAttach` / `notifyDetach` /
   `notifyMediaChange` as a no-op sink. drive_t fields are
   updated authoritatively in the same call sites.
3. **Test-only PA/PB read fallback** — `via2-gcr-shifter-coupling.ts`
   `readPa` / `readPb` falls back to `shifter.dataByte` /
   `shifter.syncBit` only when `shadowDrive` is null. Reserved
   for unit tests that construct VIA2 in isolation without a
   Drive_t.

When `C64RE_ROTATION_DIFF` is unset (= production):
gcrShifter has no observable effect on simulation output. The
bit-stream primitive is rotation.ts end-to-end.

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
| `C64RE_ROTATION_DIFF=1` motm capture | 20M instructions, 0 divergence |
| `node tests/unit/drive/rotation.test.ts` | 15/15 PASS |
| `npm run test:lorenz:disk1` (600s) | **83 tests started, 0 fails**, INCONCLUSIVE at 600s (perf cap — out of Spec 441 scope, see Perf below) |

## Deferred — 4f legacy delete

The 82 `gcrShifter` / `GcrShifter` / `gcr-shifter` references in
`src/` are NOT deleted in this spec, even though `rotation.ts`
is the production primitive. Reasons:

1. **A/B harness still active.** The `C64RE_ROTATION_DIFF=1`
   path requires gcrShifter for divergence detection. Deleting
   it loses the only sanity check against rotation.ts drift.
2. **Mount notification sink.** Removing gcrShifter requires
   re-routing `notifyAttach` / `notifyDetach` / `notifyMediaChange`
   call sites in `mount.ts` to drive_t equivalents. Already
   partially done (drive.attach_clk etc) but the sink calls
   themselves remain.
3. **Test fallback.** Unit tests that construct VIA2 without
   a kernel use the shifter-fallback PA/PB reads. Deleting
   gcrShifter requires a stub Drive_t in every such test.

These are all wiring chores, not correctness work. Deferring to
a follow-up cleanup spec after Spec 442 (viacore re-audit) so
this branch stays scoped to "rotation production port".

`gcrShifter.snapshot` / `restore` is dead code today (no
production caller in `session-vsf.ts` or `save-load-tests.ts`);
the future save-state extension should use `rotation_table_get` /
`rotation_table_set` directly against drive_t.

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
