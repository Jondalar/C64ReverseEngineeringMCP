# Spec 444 — `drivecpu.c` true literal port

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** Epic 440  
**Depends on:** Spec 443  
**Doctrine:** Spec 435 hat felder umbenannt (lastSyncC64Clk →
lastClk, cycleAccumulator16dot16 → cycleAccum). Math ist äquivalent
ABER nicht bit-identisch mit VICE: TS verwendet
accumulator-threshold-loop, VICE explizites `stop_clk`-field
+ `drive_clk < stop_clk`.

## VICE source

`drive/drivecpu.c` (737 LoC). Function map:

- `drivecpu_init`
- `drivecpu_setup_context`
- `drivecpu_shutdown`
- `drivecpu_reset_cpu9` etc (drive-type-specific resets)
- `drivecpu_reset`
- `drivecpu_wake_up`
- `drivecpu_sleep`
- `drivecpu_execute` — die kern-loop
- `drive_cpu_execute_one`
- `drive_cpu_execute_all`
- `drivecpu_set_overflow` (BYTE-READY/SO)
- `drivecpu_set_irq` (VIA1+VIA2 → drive CPU IRQ)
- Snapshot save/load — OUT V1

## State (literal)

VICE `drivecpu_context_t` (from drivetypes.h):

| Field | Type | TS field today |
|---|---|---|
| `last_clk` | CLOCK | `lastClk` ✓ |
| `cycle_accum` | uint32_t | `cycleAccum` ✓ |
| `stop_clk` | CLOCK | **FEHLT** (TS does threshold-loop) |
| `sync_factor` | uint32_t (16.16) | `syncFactor16dot16` |
| `int_status` | interrupt_cpu_status_t* | `cpuIntStatus` (via cpu) |
| `clk_ptr` | CLOCK* | `driveClkPtr` |

`stop_clk` must become a real field. The exec loop must be:

```
cycles = max(0, clk_value - last_clk)
cycle_accum += sync_factor * cycles
stop_clk += cycle_accum >> 16
cycle_accum &= 0xFFFF
while (drive_clk < stop_clk) {
    execute one 6502 cycle
    // alarms fire here
}
last_clk = clk_value
```

Not the current TS form `while (cycleAccum >= 0x10000) { exec; cycleAccum -= 0x10000 }`.

## Audit + port (Claude-self)

`docs/spec-444-drivecpu-audit.md` — row per VICE function.

Patch `drive-cpu.ts` to use stop_clk explicitly. Preserve PAL clock
constants. Keep Spec 428 dispatch-mode option for now (controversial;
revisit in epic-closing).

## Acceptance

1. `drive-cpu.ts` exposes `stopClk: number` as real field.
2. Catch-up math literal per VICE `drivecpu_execute` body.
3. `drive_cpu_execute_one(unit, hostClk)` + `drive_cpu_execute_all(hostClk)`
   exist as exported entry points with VICE-shape signatures.
4. Audit doc committed.
5. All canaries green.
6. New cycle-accuracy smoke: feed known C64-clk sequence, verify
   produced drive_clk values match VICE-baseline to within 0 cycles
   (currently the math is equivalent, so 0 diff expected).

## Do Not

- Don't change inner 6502 dispatch (Spec 428 owns).
- Don't touch alarms (Spec 448).
- Don't change PAL/NTSC constants (Spec 446).
