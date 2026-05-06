# Spec 205 — Kernel trace contract

**Sprint:** 120
**Status:** PROPOSED
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
