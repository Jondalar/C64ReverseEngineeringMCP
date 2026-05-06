# Spec 205 — Kernel trace contract

**Sprint:** 120
**Status:** 205-A FULL ADR §5 EVENT-FAMILY COVERAGE DONE 2026-05-06 — kernel trace controller + 8 wired channels (bus_access, irq, cpu, iec, gcr, vic, cia, session/keyboard/joystick). 14/14 smoke. 205-B (VICE diff CLI) + 205-C (swimlane) still PROPOSED.

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

## 205-A status (full ADR §5 coverage)

- **c4** "cpu" — Cpu6510 + Cpu65xxVice instruction-complete edges
  (both c64 + drive). { side, pc, clk }.
- **c5** "iec" — IecBus line transitions (atn/clk/data + per-side
  derived bits). Independent of legacy IecBus traceEnabled.
- **c6** "gcr" — GcrShifter byte-ready + SYNC# edges via dedicated
  trace observer (doesn't conflict with DriveCpu V-flag wiring).
- **c7** "vic" — raster line + frame transitions from VicIIVice
  line-wrap branch. { kind: "raster", raster_y } + { kind: "frame" }.
- **c8** "cia" — Cia6526Vice ciaSetIrqFlag → chip-side flag set
  events (CIA_IM_TA / TB / ALARM / SDR / FLAG bits) per chip.
- **c9** "gcr" head_step + motor + density edge events. Edge-only
  — no events when value unchanged.
- **c10** "session" / "keyboard" / "joystick" — resetCold +
  mountMedia + typeText + setJoystick* publish.

## 205-B status (2026-05-06)

- **c1** scripts/lib/trace-diff.mjs — JSONL reader, format
  auto-detection (snapshot tuple vs kernel-channel), per-record
  alignment with tolerance window.
- **c2** scripts/diff-trace.mjs — CLI taking --vice + --ours +
  optional --format / --channel / --tolerance / --fields. Verified
  on samples/traces/v2-baseline/motm/{trace,headless-trace}.jsonl
  — reports first divergence at ts=2900000 (vice c64 PC=$424F in
  loader stage-2, ours PC=$E5D4 still in KERNAL boot — Sprint 111
  finding).
- **c3** scripts/smoke-diff-trace.mjs (npm run smoke:diff-trace) —
  8/8 passing covering snapshot + channel formats, identical /
  mutated / length-mismatch / tolerance windows.

## 205-A still open

- 205-C swimlane consumer (UI client of the same registry).
- io / sid / drive_pc channels — already exist in the registry
  but no producer wired through the kernel yet.
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
