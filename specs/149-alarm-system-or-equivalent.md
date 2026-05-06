# Spec 149 — Alarm system or per-cycle-tick equivalent

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/alarm.c + src/alarm.h
**Depends on**: Spec 145 (CIA timers schedule alarms),
                Spec 147 (VIA timers schedule alarms)

## Why

VICE schedules T1/T2 underflow + CA1 edge events as alarms.
Drive CPU loop pops pending alarms whose clk <= current_clk and
runs callbacks. CIA/VIA \`ciat_set_alarm\` predicts next underflow
cycle.

We use per-cycle ticks instead — simpler, slower, FUNCTIONALLY
equivalent for most cases. Edge cases differ:
- Timer reload race: VICE alarm fires AT specific cycle; our
  per-tick handles same cycle but ordering with other events
  may differ.
- Alarm dispatch ORDER: VICE dispatches alarms in clock order
  (earliest first). Our scheduler ticks chips in array order.

## Scope

### Point 6: alarm system

Decide:
- **Option A**: Implement alarm system. Match VICE exactly. More
  work, fully 1:1.
- **Option B**: Audit per-cycle-tick approach for edge cases.
  Document where divergence is acceptable. Simpler.

For 100% feature parity with motm-class fastloaders, ALARM SYSTEM
likely needed because:
- VICE T1 zero alarm fires AT specific cycle, kicks IRQ at same
  cycle. Our tick increments timer per cycle, may be off by 1.
- Alarm dispatch order matters when multiple events fire at same
  cycle (T1 + CA1 simultaneously).

## Process (Option A)

1. Read VICE alarm.c (manageable size).
2. Port AlarmContext + alarm scheduling primitives.
3. Wire CIA + VIA timer events through alarms instead of per-cycle.
4. Replace per-cycle ticks with alarm-driven callbacks.

## Process (Option B)

1. Audit per-cycle-tick semantics vs VICE alarm dispatch.
2. Document equivalence proofs / divergence cases.
3. Accept divergence where safe.

## Acceptance

- Drive timer events (T1/T2 underflow + CA1 edge IRQ) fire at
  EXACT same cycle as VICE for given input sequence.
- Verify via cycle-stamped trace from drive CPU.

## Estimated effort

Option A: 1-2 sessions.
Option B: 0.5 session (audit only).

Recommendation: Option A if Specs 145+146+147 don't fix motm.
Option B otherwise.
