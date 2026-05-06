# Spec 203 — Alarms + IRQ timestamps in kernel

**Sprint:** 118
**Status:** PROPOSED
**ADR:** §4.2, §4.3, §8 Step 4
**Maps from:** legacy 141 (clocked-via1-ca1-irq-timing), 149
(alarm-system-or-equivalent) — superseded
**Depends on:** 202
**Blocks:** 210, 214

## Goal

Kernel owns alarm contexts and IRQ/NMI/CA1/CB1/SO event timestamping.
Chips schedule alarms and request line changes; kernel dispatches.

## Scope

- Alarm contexts owned by kernel, scheduled in owning clock domain
  (c64 / drive / VIC).
- Alarm dispatch at deterministic kernel points; callbacks may mutate
  local chip state and request IRQ/NMI line edges, but cannot advance
  time.
- IRQ/NMI/CA1/CB1/SO events stamped: `edgeClock`, `visibleClock`,
  `servicedClock`, `sourceComponent`, `targetCpu`.
- CPU interrupt delay computed from timestamps, not incidental
  scheduler ordering.

## Acceptance

- CIA/VIA/VIC timer tests green.
- Interrupt trace includes source clock and service clock.
- ADR §10 criterion 6: every `$DD00` and `$1800` access is traceable
  with clock, PC, value, IEC state, sequence — depends on 205 trace
  contract but shape lands here.
- 210 (CIA 1:1) and 214 (VIC bus stealing) can plug into this surface.

## Out of scope

- CIA/VIA/VIC port internals → 210, 211, 214.
- Hook removal → 204.
