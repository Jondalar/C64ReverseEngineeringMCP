# EPIC — Native Rust Emulator Core for C64RE

**Status:** PROPOSED  
**Owner:** C64RE runtime  
**Scope:** internal engine under the existing C64RE MCP/workflow stack  
**Non-goal:** standalone emulator product or separate MCP server

## Problem

C64RE already has the right outer architecture for agentic C64 reverse
engineering: MCP tools, durable project knowledge, VICE as oracle,
runtime trace artifacts, DuckDB-backed querying, a browser workbench,
and a TypeScript headless C64/1541 runtime.

The TypeScript runtime is now large enough that the remaining hard
problems are concentrated in the hot deterministic kernel:

- coherent C64/1541 timing
- true-drive IEC and drive CPU synchronization
- GCR rotation and media fidelity
- high-volume trace production
- deterministic snapshot/replay
- performance headroom for agent loops and UI workbench sessions

The goal is not to discard C64RE. The goal is to move the emulator hot
path into a native Rust engine while preserving C64RE's existing
agent-facing API and project workflow.

## Motivation

For C64RE, the long-term target is not just "an emulator that can log
more data". The useful primitive for reverse engineering is a navigable
machine timeline: move back by cycles, frames, or seconds; resume
execution from that point; inspect CPU, drive CPU, IEC, VIC, SID,
memory, disk, screen, and audio at the same timeline coordinate; and
fork new execution branches after patches, monitor writes, different
inputs, or modified media.

That is closer to video editing for a deterministic computer than to a
traditional emulator monitor. A user should be able to scrub through a
run, land on a suspicious loader transition, step backward to the last
IEC edge or decryption write, branch the state, try a patch, and compare
the resulting trace against the original run.

This requires the core to treat time as a first-class data model:

- deterministic state snapshots at stable keyframes
- compact delta streams between keyframes
- indexed CPU, memory, bus, drive, video, audio, and media events
- branchable input, disk-write, cartridge, and debug-intervention logs
- replay from nearest keyframe to any target cycle
- cached video/audio products that can be aligned with trace evidence
- direct import into C64RE's DuckDB trace store without huge JSONL
  intermediates

VICE is still the best fidelity oracle and can be used as an instrumented
backend, but its architecture starts from an emulator plus monitor model.
The Rust core is justified when C64RE needs a rewind-first,
timeline-first engine where tracing, replay, branching, and structured
querying are part of the machine contract rather than bolted-on output.

## Product Goal

Provide a native, deterministic, embeddable emulator engine that C64RE
can use for runtime evidence:

- boot PRG/CRT/D64/G64 sessions
- run real C64 + 1541 true-drive code
- trace CPU, memory, IEC, GCR, VIC, CIA, and monitor events
- snapshot, restore, rewind, branch, and diff runs
- compare against VICE at event granularity
- expose high-level agent workflows through existing C64RE tools

## Architecture Claim

C64RE should keep TypeScript as orchestration and knowledge glue.
Rust should implement the native `MachineKernel` backend.

```text
LLM / UI / CLI / MCP clients
        |
        v
C64RE TypeScript tools and workflows
        |
        v
IntegratedSession / AgentQueryApi / Trace Store
        |
        v
MachineKernel interface
        |
        +-- TypeScript HeadlessMachineKernel  (current fallback/reference)
        |
        +-- Rust NativeMachineKernel          (new engine)
```

The Rust core is selected per session by configuration, e.g.
`kernelBackend: "typescript" | "native"`.

## Non-Goals

- No separate emulator MCP server.
- No direct per-cycle MCP or JSON-RPC surface.
- No greenfield replacement for project knowledge, media tools, VICE
  integration, trace store, or UI.
- No GPL code import from VICE or zinc64.
- No one-shot rewrite of the existing TypeScript runtime.

## Design Principles

1. **C64RE remains the product boundary.** Rust is an implementation
   detail behind the runtime API.
2. **Batch API across the TS/Rust boundary.** Calls such as `runUntil`,
   `snapshot`, and `queryTraceWindow` are valid. Per-cycle calls are
   not.
3. **Traceability is first-class.** Every native behavior change must
   remain explainable through C64RE artifacts, traces, and VICE diffs.
4. **Parity before speed.** Native performance is useful only if it
   preserves the VICE-observable contract.
5. **Dual backend during migration.** The TypeScript kernel stays as
   reference/fallback until native covers the same acceptance surface.
6. **Stable schemas over object sharing.** Snapshots, trace events, and
   status reports use versioned schemas that TypeScript can store,
   query, and compare.
7. **No hidden compatibility hooks in true-drive.** Debug shortcuts stay
   explicit and auditable.

## Target Capabilities

### Session Control

- create and destroy sessions
- mount PRG, CRT, D64, G64, and no-disk media
- select PAL/NTSC and reset profile
- run by cycles, instructions, frames, stop condition, or scenario
- halt on PC, memory watch, I/O watch, IRQ/NMI, IEC event, or timeout

### Runtime Introspection

- C64 CPU and drive CPU registers
- C64 memory, drive memory, cartridge banks, media state
- CIA/VIA/VIC/SID status summaries
- IEC resolved lines and cached VICE-style ports
- drive motor/head/track/density/SYNC/byte-ready status

### Evidence Production

- typed trace streams and ring buffers
- compact event windows for LLM consumption
- DuckDB import path compatible with current trace store
- snapshots suitable for rewind and branch exploration
- VICE/headless normalized diff records

### Compatibility

- existing C64RE MCP tools keep their public shape
- TypeScript backend remains selectable
- native backend can start with partial feature coverage
- status reports must state backend, mode, shortcuts, media, and
  unsupported features

## Integration Boundary

The preferred initial integration is a native subprocess controlled by
a small TypeScript adapter:

```text
src/runtime/headless/kernel/native-machine-kernel.ts
        |
        | JSON-RPC or MessagePack over stdio
        v
native/c64re-engine-cli
        |
        v
native/c64re-engine / native/c64re-core
```

This avoids Node ABI friction, isolates crashes, and keeps distribution
simple. A later N-API adapter can be added if measured IPC overhead
becomes a real bottleneck.

## Acceptance for the Epic

The epic is complete when:

- C64RE can start a session using the native backend.
- Existing headless tool workflows can select native or TypeScript.
- Native PRG and CRT workflows produce equivalent session status,
  monitor, snapshot, and trace artifacts.
- Native true-drive D64/G64 sessions run through a representative
  fastloader corpus with VICE-diffable evidence.
- Native trace output imports into the current DuckDB trace store.
- The V3 workbench can use native sessions without changing its public
  protocol.
