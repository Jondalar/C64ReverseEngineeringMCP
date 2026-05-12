# High-Level Plan — Rust Core Migration

**Status:** PROPOSED  
**Strategy:** vertical slices behind `MachineKernel`, not a rewrite.

## Phase 0 — Contract Freeze

Goal: make the existing TypeScript runtime contract explicit before
Rust exists.

Deliverables:

- define native session command schema
- define status, snapshot, trace, and error schemas
- add backend selection plumbing to C64RE session creation
- document unsupported-feature reporting

Acceptance:

- TypeScript backend still passes existing smoke/regression scripts.
- A mock native backend can satisfy the adapter contract.

## Phase 1 — Native Process Skeleton

Goal: ship a native binary that C64RE can start, ping, version, and
shut down.

Deliverables:

- Rust workspace under `native/`
- `c64re-engine-cli` stdio protocol
- TypeScript `NativeMachineKernel` adapter
- health/version/status commands
- structured error mapping

Acceptance:

- `npm run build:mcp` still passes.
- smoke script can create a native-backed placeholder session and close
  it cleanly.

## Phase 2 — CPU + Memory PRG Slice

Goal: prove the native core can execute deterministic C64 code and
produce agent-useful evidence.

Deliverables:

- 6510/6502 CPU core with documented illegal-opcode policy
- RAM, ROM, processor port, minimal PLA
- PRG load/reset/run-until support
- memory/register monitor operations
- CPU/memory trace ring
- snapshot/restore for CPU + memory

Acceptance:

- known PRG micro-tests match TypeScript or VICE reference traces.
- `runUntil(pc)` and `readMemory` work through existing C64RE APIs.

## Phase 3 — Cartridge Slice

Goal: move CRT execution into native for RE-relevant cartridges.

Deliverables:

- CRT parser or reuse TS manifest converted to native mount command
- Normal, MagicDesk, Ocean Type 1, EasyFlash baseline mappers
- GAME/EXROM/PLA interactions
- cartridge bank and I/O trace events

Acceptance:

- existing cartridge smoke corpus runs with native backend.
- session status reports active mapper, bank, GAME/EXROM, and writes.

## Phase 4 — Trace Store Integration

Goal: make native traces first-class C64RE artifacts.

Deliverables:

- typed event schema compatible with current `trace-events`
- streaming or file-backed trace export
- DuckDB import adapter
- query windows through `AgentQueryApi`

Acceptance:

- `queryEvents`, `swimlaneSlice`, and `followPath` work for native runs.
- raw trace size and import time are measured.

## Phase 5 — IEC + 1541 Foundation

Goal: implement native true-drive skeleton with VICE-observable IEC
semantics.

Deliverables:

- VICE-style IEC cached bus state
- drive CPU + RAM + DOS ROM
- VIA1 IEC port and CA1 IRQ edge model
- C64 CIA2 `$DD00` wiring through kernel bus
- C64/drive clock sync contract

Acceptance:

- standalone drive ROM boot reaches idle loop.
- synthetic IEC LISTEN/TALK matrix passes.
- bus-access traces match normalized TypeScript/VICE fixtures for
  basic sequences.

## Phase 6 — VIA2 + GCR + Media

Goal: native true-drive can read real D64/G64 media through drive ROM.

Deliverables:

- VIA2 disk controller model
- GCR shifter/rotation
- D64 to GCR path
- G64 track parser path
- motor/head/density/SYNC/byte-ready trace events
- media write policy and write-protect status

Acceptance:

- KERNAL `LOAD"$",8` succeeds through real serial.
- representative fastloader windows are VICE-diffable.
- no hidden true-drive hooks fire.

## Phase 7 — VIC/CIA/SID Fidelity Expansion

Goal: cover enough of the whole C64 to support agent runtime evidence
and V3 workbench sessions.

Deliverables:

- CIA1/CIA2 timer and interrupt parity
- VIC authority decision: port current literal TS model, native model,
  or continue TS renderer during transition
- SID register/audio policy
- keyboard/joystick input bridge
- frame/screenshot export contract

Acceptance:

- V3 workbench can show native sessions with live controls.
- smoke suites for CPU, CIA, VIC, input, and screenshot pass on native
  where declared supported.

## Phase 8 — Native Default Criteria

Goal: decide when native becomes the default backend.

Criteria:

- feature coverage table says native supports the default workflows
- regression corpus is green or has documented expected gaps
- performance beats TS on long trace-producing runs
- trace artifacts remain query-compatible
- crash/error behavior is acceptable for MCP sessions
- TypeScript fallback remains available for bisecting

## Migration Rules

- Add native support vertically, not subsystem-by-subsystem in isolation.
- Keep public MCP tool names stable.
- Every native session status must include backend and unsupported
  features.
- Store native-produced artifacts through existing artifact registration.
- Prefer file-backed trace transfer for large data.
- Keep TS and native trace event schemas normalized from day one.

