# Spec 205 — Kernel trace contract

**Sprint:** 120
**Status:** 205-A foundation (c1+c2+c3) DONE 2026-05-06 — kernel trace controller wraps TraceRegistry, JSONL artifact path validated, irq channel auto-publishes from emitIrqEvent + markIrqServiced. 205-B (VICE diff CLI) + 205-C (swimlane) + remaining ADR §5 event families still PROPOSED.

## 205-A status (2026-05-06)

- **c1** kernel.trace() returns a real KernelTraceController backed by
  the kernel-owned TraceRegistry. Surface: configureChannel, publish,
  getRing, isEnabled, closeAll, getBusAccessProducer /
  setBusAccessProducer. Session traceRegistry getter forwards to the
  kernel. Bus-access producer registration routes through
  kernel.trace().setBusAccessProducer.
- **c2** scripts/smoke-trace.mjs (npm run smoke:trace) validates the
  JSONL artifact path: configure jsonl, run a 50k-cycle warm boot,
  closeAll, parse every line. 6 acceptance checks covering envelope
  shape, BusAccessEvent payload, IEC snapshot, monotonic seq.
- **c3** ChannelName widened with "irq". emitIrqEvent + markIrqServiced
  auto-publish into the irq channel when enabled — edge events carry
  line/asserted/source/target/edgeClock/visibleClock; serviced events
  carry kind="serviced"+servicedClock. First-divergence tooling now
  sees IRQs and bus accesses on the same timeline.

## 205-A still open

- All other event families per ADR §5 (CPU instruction boundary,
  alarms, GCR bit/byte-ready, VIC raster/frame, motor/density, media
  mount/reset). Each is one small commit using the same
  trace.publish pattern.
**ADR:** §5
**Maps from:** legacy 142 (bus-access-trace-ring), 143
(vice-headless-iec-diff), 152 (swimlane-full-compare) — superseded
**Depends on:** 200 (facade exists)
**Parallel-eligible with:** 201-204 (different write scope: trace
producer, not timing path)

## Goal

Define and implement canonical kernel events. Replace ad-hoc tracing
with one event stream that supports first-divergence debugging and
VICE comparison.

## Sub-deliverables

### 205-A — Bus-access trace ring (was 142)

In-memory ring buffer + JSONL artifact for `BusAccessContext`-tagged
events. Filtered capture windows (PC range, address range, clock
window).

### 205-B — VICE/headless first-divergence diff (was 143)

Tool that aligns kernel JSONL with VICE bus trace and reports first
divergent event. Used by ADR §10 criterion 7 and 9.

### 205-C — Swimlane full compare (was 152)

Visual swimlane view consuming kernel JSONL + VICE trace. Replaces
existing partial swimlane.

## Required event families

Per ADR §5: CPU instruction boundary, CPU bus access, `$DD00` access,
`$1800` access, IEC port update, ATN/CLK/DATA edge, VIA/CIA alarm,
IRQ/NMI/SO, GCR bit/byte-ready, disk head/motor/density, VIC
raster/frame, media mount/reset/input.

Each event carries: kernel sequence number, clock domain, clock,
side/device, PC/opcode/phase when CPU-related, before/after state,
compatibility hooks used.

## Acceptance

- All event families emit at correct clock points.
- JSONL artifact validates against schema.
- 205-B identifies first divergent event for known-bad MM/motm boot.
- Existing swimlane callers migrated to 205-C.

## Out of scope

- Removing existing trace producers — they become thin shims around
  kernel event emit.
