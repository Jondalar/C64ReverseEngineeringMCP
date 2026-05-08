# Spec 089 — VICE-style alarm-context scheduler

## Source studied

- `/Users/alex/Development/C64/Tools/vice/vice/src/alarm.h` — alarm + context types, inline functions
- `/Users/alex/Development/C64/Tools/vice/vice/src/alarm.c` — context lifecycle
- `/Users/alex/Development/C64/Tools/vice/vice/src/maincpu.c` — main CPU loop dispatching alarms
- `/Users/alex/Development/C64/Tools/vice/vice/src/6510core.c` — `CHECK_PENDING_ALARM` macro

## Concept (from VICE)

VICE doesn't tick every peripheral every cycle. Instead each peripheral
*registers* an **alarm** with the CPU's alarm context. An alarm is
"please call my callback at clock cycle T". The CPU's main loop
checks `next_pending_alarm_clk` against current `CLK` after each
instruction. When `CLK >= next_pending_alarm_clk`, the alarm callback
fires.

```c
// from alarm.h
inline static void alarm_context_dispatch(alarm_context_t *context,
                                          CLOCK cpu_clk) {
    CLOCK offset = cpu_clk - context->next_pending_alarm_clk;
    int idx = context->next_pending_alarm_idx;
    alarm_t *alarm = context->pending_alarms[idx].alarm;
    (alarm->callback)(offset, alarm->data);
}
```

The CPU core (`6510core.c`) uses macro:

```c
#define CHECK_PENDING_ALARM() (clk >= next_alarm_clk(maincpu_int_status))
```

After each instruction:
```c
while (CHECK_PENDING_ALARM()) {
    alarm_context_dispatch(ALARM_CONTEXT, CLK);
}
```

Each peripheral sets its alarm to fire at the cycle when its next
event happens:
- CIA timer A underflow → alarm at `CLK + counter_value`
- VIC raster compare → alarm at `CLK + cycles_to_next_compare_match`
- Drive byte ready → alarm at `CLK + bit_period`

When the CPU instruction crosses the alarm clock, the alarm fires.
The peripheral handles the event (sets IRQ flag, raster bar, etc.)
and re-arms its alarm for the next event.

This is **MUCH cheaper** than ticking every peripheral every cycle.
Only fires on demand. And cycle-PRECISE because alarm's `clk` value
is exactly when the event should happen.

## Why we need this

Current model: every peripheral (`cia1`, `cia2`, `vic`, `sid`)
ticks per cycle within instruction batch. Costs O(N×cycles)
arithmetic per cycle. Doesn't scale to demos with many peripherals.

More importantly: alarm-precise timing means `CIA Timer A IRQ
fires at cycle 16421` exactly, not "sometime within instruction
that crossed 16421". Required for KERNAL serial routines that
use Timer A to time inter-bit delays.

## Decision

Refactor `IntegratedSession` to use an alarm-context scheduler
modelled after VICE.

## Scope

### `AlarmContext` class (new)

```ts
// src/runtime/headless/scheduler/alarm-context.ts
export interface AlarmCallback { (offsetCycles: number): void; }

export class Alarm {
  pendingClk = -1;          // -1 = not pending
  constructor(public name: string,
              public callback: AlarmCallback,
              public ctx: AlarmContext) {}
}

export class AlarmContext {
  private alarms: Alarm[] = [];
  private pending: { alarm: Alarm; clk: number }[] = [];
  public nextPendingClk = Number.MAX_SAFE_INTEGER;
  private nextPendingIdx = -1;

  newAlarm(name: string, cb: AlarmCallback): Alarm { ... }
  set(alarm: Alarm, clk: number): void { ... }
  unset(alarm: Alarm): void { ... }
  hasPending(currentClk: number): boolean { return currentClk >= this.nextPendingClk; }
  dispatch(currentClk: number): void {
    const offset = currentClk - this.nextPendingClk;
    const idx = this.nextPendingIdx;
    const a = this.pending[idx]!.alarm;
    this.pending.splice(idx, 1);  // remove from pending
    a.pendingClk = -1;
    this.recomputeNextPending();
    a.callback(offset);
  }
  private recomputeNextPending(): void {
    // scan pending[], find min clk
  }
}
```

### CIA refactor

Each CIA gets an alarm. Timer A start writes `cra |= 1` →
`alarm.set(currentClk + taLatch + 1)`. When alarm fires:
- set `icrFlags |= ICR_TA`
- assert IRQ if mask allows
- if continuous mode: re-arm alarm at `currentClk + taLatch + 1`
- if one-shot: clear cra START bit

No more per-cycle `tick()`. Only event-driven.

### VIC refactor

VIC raster IRQ alarm: when raster compare register changes or current
raster line is updated, set alarm to fire at next match cycle. When
alarm fires: set IRQ_RASTER + reschedule for line+1 wrap.

VIC scanline boundary alarm (for snapshot capture): fires every
`cyclesPerLine` to push scanline snapshot.

Bad-line + sprite-DMA stealing handled differently: VIC reports
to CPU "stalled until cycle X". CPU jumps `CLK` forward.

### Drive lazy execute

Already partially implemented via `beforeC64Read` hook. Convert to
proper `drive.executeToClock(currentClk)` that runs drive cycles
until drive's clock catches up to `currentClk`. Drive has its OWN
alarm context for drive-side events (VIA timers, byte-ready, etc.)

### Main step loop

```ts
stepC64Instruction(): void {
  this.flushDriveCycles();  // drive catches up to CLK
  this.checkInterrupts();
  this.cpu.step();          // advances CLK
  // Dispatch all alarms whose clk <= CLK now
  while (this.alarmContext.hasPending(this.cpu.cycles)) {
    this.alarmContext.dispatch(this.cpu.cycles);
  }
  this.flushDriveCycles();
}
```

No more per-cycle peripheral ticks. Alarms handle event-driven
peripheral state.

## Performance

Every instruction does 1 alarm-pending check (compare two ints).
If no alarm pending, zero overhead. If pending, dispatch 1
callback. Average ~50× cheaper than per-cycle ticks for typical
peripheral mix.

## Out of scope

- Cycle-stepped CPU (Spec 091).
- Sub-instruction bus access (Spec 092).
- Drive-side alarm context (Spec 090).

## Acceptance

- All existing test scenarios pass.
- CIA Timer A IRQ fires on the EXACT cycle of underflow (not "within
  that instruction").
- VIC raster IRQ fires on cycle 0 of compare line.
- 50% reduction in per-cycle CPU work in scheduler.

## Refinement decisions (May 2026)

1. **Two alarm contexts** (B): one per CPU (C64 + drive), matching VICE.
   C64 context handles CIA1/CIA2/VIC/SID alarms. Drive context handles
   VIA1/VIA2 timers + byte-ready.
2. **Persist pending alarms in VSF** (A): full state. Each pending alarm
   serialised as `{name, clk}`. Restore re-arms each at the saved clk.
   Bit-exact resume guaranteed.
3. **Remove backward-compat tick API** (B): no external consumers.
   Existing tests rewritten to use alarm-context dispatch + step API.
   Single source of truth.
4. **Mid-instruction alarm check** (B): VICE pattern. CHECK_PENDING_ALARM
   called after each CLK_ADD within instruction. Lands together with
   Spec 091 (cycle-stepped 6510 with sub-instruction bus access). Until
   091 lands, alarm check after-instruction is the practical default.
