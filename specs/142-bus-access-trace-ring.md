# Spec 142 — Bus-Access Trace Ring

**Sprint**: 112 (core sync refactor)
**Phase**: tooling
**Status**: proposed
**Depends on**: Spec 139

## Why

The motm investigation consumed many manual traces and produced several
sampling artifacts. Future timing bugs need a first-class trace that
records exactly what each CPU observed at bus-access time.

## Scope

In scope:

- instruction-boundary trace for C64 and drive
- `$DD00` read/write events
- drive `$1800` read/write events
- raw IEC line state and cached IEC port state
- CPU, PC, opcode/instruction phase, clock domain, and cycle
- optional capture windows around PC ranges such as drive `$042F-$044C`
- compact JSONL artifacts

Out of scope:

- VICE import/diff (Spec 143)
- UI visualization
- full memory bus tracing outside configured windows

## Acceptance

- one headless motm run emits a compact trace around the 24-bit receive
  window
- trace shows the exact `$1800` value consumed by the drive CPU
- trace is suitable for regression artifacts and LLM-readable summaries

