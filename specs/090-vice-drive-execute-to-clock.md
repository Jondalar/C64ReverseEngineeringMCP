# Spec 090 — VICE-style drive `execute_to_clock(CLK)` lazy lockstep

## Source studied

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c` (line 356+ `drivecpu_execute`)
- `/Users/alex/Development/C64/Tools/vice/vice/src/iecbus/iecbus.c` (`iecbus_cpu_write_conf1` / `iecbus_cpu_read_conf1`)

## Concept (from VICE)

Drive does NOT run alongside C64 cycle-by-cycle. Drive runs LAZILY:
only catches up to C64's clock at synchronisation points.

Synchronisation points:
1. Every C64 access to drive-bus I/O (`$DD00` / `$DC00` etc. via
   `iecbus_cpu_write_conf1` callback).
2. End of each C64 instruction batch (`maincpu_clk_limit`).
3. Snapshot save / debug breakpoint.

Drive's own clock (`drv->clk`) advances only when `drivecpu_execute`
is called with a target `clk_value`.

```c
void drivecpu_execute(diskunit_context_t *drv, CLOCK clk_value) {
  cpu = drv->cpu;
  drivecpu_wake_up(drv);

  if (clk_value > cpu->last_clk) {
    cycles = clk_value - cpu->last_clk;
  } else {
    cycles = 0;
  }
  // sync_factor encodes drive_freq / c64_freq ratio in 16.16 fixed point
  cpu->cycle_accum += drv->cpud->sync_factor * tcycles;
  cpu->stop_clk += cpu->cycle_accum >> 16;
  cpu->cycle_accum &= 0xffff;

  while (*drv->clk_ptr < cpu->stop_clk) {
    // drive runs ONE instruction worth of cycles
    // 6510core.c included with drive's own CLK macros
  }
  cpu->last_clk = clk_value;
}
```

When C64 writes `$DD00`:
```c
static void iecbus_cpu_write_conf1(uint8_t data, CLOCK clock) {
  diskunit_context_t *unit = diskunit_context[0];
  drive_cpu_execute_one(unit, clock);  // drive catches up to NOW
  // ... update bus state
}
```

So drive sees the C64 cycle count where the bus access happened. Drive
runs UP TO that cycle and processes all its instructions. Then C64's
write updates bus state. Drive's next execute-to-clock sees the new
bus state.

## Why we need this (correctly)

Currently we have `flushDriveCycles()` called from `beforeC64Read`
hook. It only drains accumulator (no-op if empty). It doesn't
**push drive forward by N cycles based on C64's CLK delta**.

Real fix: `drive.executeToClock(c64Clk)` — given C64's current CLK,
compute how many drive cycles drive should run, then run them.

## Decision

Replace `runOneDriveStep` + accumulator with VICE-style
`executeToClock(clk)` API on `DriveCpu`.

## Scope

### `DriveCpu.executeToClock(c64Clk: number): void`

```ts
class DriveCpu {
  // Drive's own clock count
  public clk = 0;
  // Drive's clock at the last sync point (when we caught up)
  private lastSyncC64Clk = 0;
  // Sync factor: drive cycles per C64 cycle (PAL: 1.01477)
  // In 16.16 fixed point: 0x1_03C5 etc.
  private syncFactor = ...;

  // Run drive forward to match C64's clock at this point.
  executeToClock(c64Clk: number): void {
    if (c64Clk <= this.lastSyncC64Clk) return;
    const c64Delta = c64Clk - this.lastSyncC64Clk;
    this.lastSyncC64Clk = c64Clk;
    // accumulate fractional drive cycles
    this.cycleAccumulator += this.syncFactor * c64Delta;
    const driveTarget = this.clk + (this.cycleAccumulator >> 16);
    this.cycleAccumulator &= 0xffff;
    while (this.clk < driveTarget) {
      this.stepInstruction();  // advances this.clk by instruction cycles
    }
  }
}
```

### Integration

1. `IntegratedSession.iecBus.beforeC64Read` calls
   `drive.executeToClock(c64Cpu.cycles)`.
2. `IntegratedSession.stepC64Instruction` ALSO calls
   `executeToClock` AFTER the C64 instruction.
3. Remove `driveCycleAccumulator` + `runOneDriveStep` from session.

### Drive-side alarms

Drive has own alarm context for VIA1/VIA2 timers, byte-ready, etc.
Drive instruction loop checks drive-alarm-context after each
instruction.

### Snapshot

`lastSyncC64Clk`, `cycleAccumulator` saved in VSF.

## Out of scope

- C64 alarm context (Spec 089).
- Cycle-stepped CPU (Spec 091).

## Acceptance

- Drive at IDLE: `executeToClock(c64Clk)` runs drive cycles
  proportional to delta. Drive PC advances naturally.
- Bus access: drive catches up BEFORE C64 reads bus, so drive's
  PB outputs reflect drive's most recent state.
- Snapshot save+restore reproduces drive state exactly (cycle-
  accurate to within 1 drive instruction).

## Refinement decisions (May 2026)

1. **Inline drive-alarm dispatch** (A): inside `executeToClock` loop,
   check drive alarm context after each drive instruction. If alarm
   pending at clk passed, dispatch immediately. Drive timer IRQ fires
   at the right drive cycle.
2. **IRQ serviced before next instruction** (A): standard 6502 behavior.
   `executeToClock` loop: check IRQ pending → service via vector → run
   instruction.
3. **Busy-loop skip via sleep pattern** (A): VICE's `drivecpu_sleep` /
   `drivecpu_wake_up`. Detect drive PC stuck in tight wait loop ($EBFF
   area or bus-poll patterns). Skip drive clock ahead to next pending
   alarm or next bus access. Massive perf win for idle drive. When
   bus state changes, drive woken up + sees the change.
4. **16.16 fixed-point sync_factor** (A): `syncFactor = floor(driveHz /
   c64Hz * 65536)`. Pure integer accumulation. No drift over long runs.
