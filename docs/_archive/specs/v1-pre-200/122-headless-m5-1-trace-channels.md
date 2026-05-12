# Spec 122 — Headless M5.1: Trace Channels

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 5, story M5.1
Depth: light
Predecessors: Specs 094, 095

## Motivation

Spec 094's EOF trace harness defines a one-shot trace shape for Bug
40. M5.1 generalises it into separate channels — CPU, memory, IEC,
drive PC, GCR, VIC, CIA, SID, keyboard, joystick — usable as ring
buffers live or as JSONL files post-hoc.

## Acceptance

- Channel registry with one entry per subsystem.
- `session.traceEnable("iec", { mode: "ring", capacity: 10000 })` and
  `session.traceEnable("cpu", { mode: "jsonl", path: "..." })`
  configurable per channel.
- Channels share the EOF-trace schema (Spec 094) where applicable.
- Smoke: enable IEC channel, run synthetic LOAD, dump ring buffer.

## Deliverables

- NEW `src/runtime/headless/trace/channels.ts`
- EDIT existing trace producers to publish via the registry
- `docs/trace-channels.md`

## Dependencies

- Spec 094.
- Spec 095.

## Risks

- Storage cost on long traces. Mitigation: ring buffer default; JSONL
  is opt-in.
- Performance impact when many channels enabled. Mitigation: per-channel
  enable; default all off.

## Out of scope

- Trace transport over network.
- Compressed trace formats.
