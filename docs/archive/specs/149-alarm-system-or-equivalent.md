> **SUPERSEDED 2026-05-06 by Spec 203** (`specs/203-alarms-irq-timestamps.md`).
> Sprint 113 aborted.

# Spec 149 — Alarm system 1:1 VICE port (FOUNDATION)

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: PROMOTED to foundation — blocks Spec 145 + 147
**Source**: VICE 3.7.1 src/alarm.c (212 LOC) + src/alarm.h (187 LOC)
**Blocks**: Spec 145 (CIA), Spec 147 (VIA), Spec 150 (VIC)
**Refinement**: locked 2026-05-06, **revised 2026-05-06**

## Architecture-correction (revised after CIA agent halt-report)

Original assumption was **WRONG**: we believed chips would expose
predict-functions and 149 would wrap them as alarms later.
**Actual VICE structure**: chip register-write paths CALL
`alarm_set()` directly. There is no separable predict-function.

Examples from ciacore.c:
- `cia_run_ifr_cycle` (4-stage IFR delay-line) advances ONLY in
  alarm callbacks (`ciacore_intta`, `ciacore_inttb`,
  `ciacore_intsdr`, `ciacore_inttod`).
- `sdr_delay` (SP/SDR mercury-delay-line) advances exclusively
  via `sdr_alarm`.
- `write_offset` 1-cycle store delay is implemented as
  `rclk = clk + write_offset; run_pending_alarms(rclk, ...)`.
- TOD = `alarm_set(tod_alarm, todclk)`.

Therefore: **149 must land BEFORE 145 + 147**. CIA + VIA cannot
be ported 1:1 VICE without alarm primitives in place.

## Why

VICE schedules T1/T2 underflow + TOD ticks + VIC raster events as
alarms. CPU loop pops pending alarms whose clk <= current_clk and
runs callbacks. CIA/VIA `ciat_set_alarm` predicts next underflow
cycle so timer doesn't tick every cycle — chip wakes at predicted
event time.

We currently use per-cycle ticks. Simpler but:
- Race conditions: VICE alarm fires AT specific cycle; per-tick
  may handle same cycle but ordering with other events differs.
- Dispatch ORDER: VICE dispatches alarms in clock order
  (earliest first). Our scheduler ticks chips in array order.
  When two events fire at same cycle (T1 underflow + CA1 edge),
  VICE has deterministic order; ours may differ.

User directive: 100% 1:1 VICE. Alarm system is core VICE timing
primitive. Port required for chip-level fidelity.

## Refinement decisions

1. **Approach**: full 1:1 port of VICE alarm.c. ~600 LOC,
   straightforward priority-queue + dispatch loop.
2. **Context granularity**: TWO separate alarm contexts, 1:1
   VICE.
   - `maincpuAlarmContext` — C64 CPU events (CIA1/CIA2 timer/TOD,
     VIC raster, KERNAL).
   - `drivecpuAlarmContext` — drive CPU events (VIA1/VIA2 timer).
   - Cross-CPU signaling (ATN edge, IEC line changes) stays as
     direct `signal()` calls — NOT routed through alarm. Match
     VICE pattern (`viacore_signal()`, `iec_callback`).
3. **Migration (revised post-CIA-halt)**: foundation-first, NOT big-bang.
   - **Step A (this spec, NOW)**: land alarm primitives + unit
     tests. Foundation file `runtime/headless/alarm/alarm-context.ts`.
     No chip changes yet. Standalone alarm-context unit tests
     verify behavior without chip dependency.
   - **Step B**: relaunch Spec 145 (CIA) + Spec 147 (VIA) agents
     with alarm-driven 1:1 VICE port from the start. They use
     alarm primitives for IFR delay-line, SDR, TOD, T1/T2,
     write_offset.
   - **Step C**: CPU phase 2 — wire alarm dispatch into
     `Cpu65xxVice` instruction loop (`while clk >=
     alarm_context_next_pending_clk(ctx) dispatch_one`).
   - **Step D**: Spec 150 (VIC) — raster line alarms.
   - **SID kept per-cycle**: B-level SID has no alarm-driven
     semantics worth porting. Stays as-is.
4. **Event kind classification**:
   - **Alarm events** (predicted clk, queued in priority queue):
     - CIA1/CIA2 timer A/B underflow
     - CIA1/CIA2 TOD tick
     - CIA SDR shift complete
     - VIA1/VIA2 timer T1/T2 underflow
     - VIA SR shift complete
     - VIC raster line tick (one alarm per line, fires at cycle
       boundary that line starts)
   - **Per-cycle events** (every cycle, not alarm):
     - VIC bus stealing (badline char fetch, sprite DMA) —
       gates CPU run; cannot be predicted as single alarm.
     - SID sample tick (Spec 151 if needed for $D41B/$D41C
       readback).
   - **Direct signal events** (synchronous call, no queue):
     - IEC bus edge changes (ATN/CLK/DATA from C64 ↔ drive)
     - IRQ/NMI line set/clear from chip → CPU
     - VIA `signal(ca1, rise)` from backend → core
     - Reset

## Scope

### Point 6: alarm system

Implement VICE alarm primitive:
- `AlarmContext`: priority queue of pending alarms ordered by
  fire-clk.
- `Alarm`: `{ clk: CLOCK, callback: (clk: CLOCK) => void, name:
  string }`.
- `alarmSet(context, clk, callback)`: schedule.
- `alarmUnset(callbackRef)`: cancel.
- `alarmContextNextPendingClk(context): CLOCK`: peek.
- `alarmContextDispatch(context, currentClk)`: pop+fire all
  alarms with `clk <= currentClk` in order.

CPU loop integration:
- Drive CPU loop, before each instruction:
  1. `alarmContextDispatch(drivecpuAlarmContext, drive_clk)`
  2. fetch + execute instruction
- Maincpu loop: same with `maincpuAlarmContext` + `maincpu_clk`.

Chip integration:
- CIA timer underflow: instead of per-cycle decrement,
  `alarmSet(maincpuAlarmContext, clk + remainingCycles,
  ciaTimerAUnderflow)` when timer starts/reloads.
- TOD: alarm scheduled per 1/100s tick (~50000 cycles PAL).
- VIA timer same pattern.
- VIC raster line: alarm scheduled at cycle 0 of next raster line.

### Cross-context coordination
- Lockstep scheduler runs both maincpu_clk and drivecpu_clk in
  step (1:1 ratio for 1MHz/1MHz). Per scheduler-tick:
  1. Dispatch maincpu pending alarms.
  2. Run C64 instruction (advances maincpu_clk).
  3. Dispatch drivecpu pending alarms.
  4. Run drive instruction (advances drivecpu_clk).
  5. Per-cycle hooks (VIC bus stealing).
- Cross-CPU signal events fired from chip-instance directly via
  `signal()` — no queue. Match VICE.

## Deliverables

1. `src/runtime/headless/alarm/alarm-context.ts` — VICE alarm.c
   port.
2. `src/runtime/headless/alarm/alarm-types.ts` — Alarm,
   AlarmContext, AlarmCallback types.
3. `src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts` —
   REWRITTEN with alarm dispatch + per-cycle hooks.
4. CIA + VIA + VIC integration: each chip's reset() registers its
   alarms with its alarm context; timer state changes call
   alarmSet/alarmUnset.
5. `tests/unit/alarm/*.test.ts` — alarm-context unit tests.
6. `tests/integration/alarm-vs-vice-trace.test.ts` — replay VICE
   bus trace, assert alarm dispatch order matches.

## Acceptance

- Drive timer events (T1/T2 underflow + CA1 edge IRQ) fire at
  EXACT same cycle as VICE for given input sequence.
- VIC raster IRQ fires at exact cycle vs VICE.
- Two-event-same-cycle dispatch order matches VICE
  (priority-queue order, FIFO for same clk).
- Scheduler runs both alarm-driven (CIA/VIA/TOD/raster) AND
  per-cycle (VIC bus stealing, SID).
- Per-chip integration verifies via cycle-stamped trace from
  drive CPU + C64 CPU.
- All Spec 145+146+147 acceptance still holds.
- motm boot reaches $0410-$04xx motm receive loop.
- MM-LOAD 3/3 PASS.
- Zero divergence vs VICE in chip-state-diff harness.

## Process

1. Read VICE alarm.c + alarm.h end-to-end. Manageable size.
2. Port AlarmContext + alarm primitives to TS.
3. Rewrite scheduler to alarm-dispatch + per-cycle hook
   structure.
4. Migrate CIA timer/TOD/SDR alarms (Spec 145 already has
   underflow prediction in ciat.ts — wrap-thin to alarmSet).
5. Migrate VIA timer/SR alarms (Spec 147 same pattern).
6. Migrate VIC raster line alarm + per-cycle bus-stealing hook.
7. Per-chip alarm-context registration on reset().
8. Unit tests for alarm-context primitives.
9. Replay VICE bus-trace integration test.
10. Run motm + MM-LOAD smoke.

## Estimated effort

1-2 sessions. alarm.c is small (~600 LOC). Scheduler rewrite +
chip integration is the bulk of the work. Risk: per-chip
migration order matters — if any chip wires alarm wrong, other
chips look broken. Plan: enable alarm per chip, run chip-isolated
unit tests, then enable next chip.

## Cross-reference

- Spec 145: CIA timer underflow prediction → alarm scheduling.
- Spec 147: VIA timer underflow prediction → alarm scheduling.
- Spec 150: VIC raster IRQ + bus stealing — uses alarm for
  raster line tick, per-cycle hook for badline.
- Direct-signal events (IEC/ATN/IRQ-line) do NOT go through
  alarm; they remain synchronous calls. Match VICE.
