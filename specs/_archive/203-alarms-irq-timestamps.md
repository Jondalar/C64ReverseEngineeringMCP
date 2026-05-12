# Spec 203 — Alarms + IRQ timestamps in kernel

**Sprint:** 118
**Status:** c1+c2+c3+c4 DONE 2026-05-06 — full IRQ/NMI/SO event ring + servicedClock backfill. Smoke 16/16. Drive-cpu IRQ servicing wired alongside c64-cpu (microcoded + legacy).
**ADR:** §4.2, §4.3, §8 Step 4
**Maps from:** legacy 141 (clocked-via1-ca1-irq-timing), 149
(alarm-system-or-equivalent) — superseded
**Depends on:** 202
**Blocks:** 210, 214

## Commit chain

- **c1 ✓ 2026-05-06** — `KernelIrqRing` + `KernelIrqEvent` shape +
  `kernel.emitIrqEvent / irqEvents`. ADR §4.3 event fields:
  `line`, `asserted`, `source`, `target`, `edgeClock`,
  `visibleClock`, `servicedClock?`, `seq`. Capacity 4096, oldest
  evicted.
- **c2 ✓ 2026-05-06** — CIA1 IRQ + CIA2 NMI level-edge detection
  emit kernel events. CIA install opts gain optional `onIrqEdge` /
  `onNmiEdge` callbacks; kernel passes wrappers that build the
  full event and call `emitIrqEvent`. Smoke confirms live capture.
- **c3 ✓ 2026-05-06** — VIA1/VIA2 setIrq edges + VIC raster IRQ +
  drive-CPU SO. DriveCpuOptions gains `onVia1IrqEdge` / `onVia2IrqEdge`
  / `onSoEdge`. DriveBus wraps both VIA setIrq closures with edge-only
  delivery; gcrShifter.onByteReady fires onSoEdge after V flag set.
  Kernel wires VIA edges → `target: "drive-cpu"`, VIC raster →
  `target: "c64-cpu"`, SO → `line: "so"`. KernelIrqSource union
  extended with `gcr-shifter`.
- **c4 ✓ 2026-05-06** — `servicedClock` back-fill. `KernelIrqRing`
  gains `markServiced(target, line, clock)` walking the ring backwards
  for the latest unfilled asserted event. Both `Cpu6510` and
  `Cpu65xxVice` gain `onInterruptServiced?: (vectorAddress, clk)`
  fired at the entry-start cycle. Kernel installs hooks via
  `installCpuInterruptHooks` (called at construction + after
  microcoded swap in IntegratedSession). $FFFA → NMI, $FFFE → IRQ;
  drive-cpu always maps to IRQ (no NMI line on 1541).

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
