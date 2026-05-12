# Headless Runtime Track

This document is a runtime-track orientation note. The canonical roadmap
is [../EPIC_ROADMAP.md](../EPIC_ROADMAP.md). The binding emulator-core
architecture is [adr-headless-machine-kernel.md](adr-headless-machine-kernel.md).

The Headless Runtime is one subsystem of C64RE MCP. It exists to provide
deterministic, scriptable C64/1541 execution for agents, tests, traces,
and the V3 Emulator UI. It does not replace the project knowledge layer,
the Workspace UI, or VICE as compatibility oracle.

## Product Role

### V1 — Machine Core

V1 is the full headless C64 + 1541 runtime:

- C64 CPU, CIA, VIC, PLA, SID software-visible state, input, reset,
  snapshots, and traces
- full 1541 TrueDrive path with real drive ROM, drive CPU/VIA, IEC, GCR,
  motor/head/media behavior, and D64/G64 support
- no KERNAL serial/file traps as TrueDrive acceptance path
- no audible sound output requirement
- VICE-compatible observable behavior for commercial-game loaders

### V2 — LLM Reverse-Engineering Workbench

V2 turns the runtime into an evidence engine:

- deterministic replay and snapshots
- DuckDB-backed trace store and rollups
- follow-a-path tracing
- transaction swimlanes for C64 CPU, IO, IEC, drive CPU, VIA/GCR, and
  runtime events
- runtime evidence linked to disassembly and project knowledge
- VICE first-divergence comparison as a debug-tier oracle

### V3 — Human Emulator UI

V3 uses the same runtime in a browser:

- live C64 screen
- media selection
- monitor/debugger
- keyboard and joystick input
- frozen screen exploration that writes findings/artifacts back to
  project knowledge
- trace swimlanes and later rewind/export/audio surfaces

## Current Focus As Of 2026-05-09

The old "loader harness" framing is obsolete. Current work is about
emulator fidelity and usable runtime evidence:

- real-game VIC-II parity and regression corpus
- live media attach/swap behavior
- VICE-like drive status surfaces, including LED behavior
- browser keyboard passthrough and virtual joystick UX
- monitor command compatibility with VICE
- DuckDB trace storage and zoomable swimlanes
- project-knowledge integration for runtime outputs

The MoTM fastloader/1541 work established the working rule for hard bugs:
do not guess from large logs. Capture focused, aligned windows and compare
VICE vs Headless transaction by transaction on a shared clock.

## Working Rules

- VICE remains the oracle. A core fix should name the exact
  VICE-observable behavior it matches.
- Headless product acceptance must not depend on game-specific PC traps.
- Smoke tests are useful, but integration tests and real-media E2E tests
  are mandatory for core behavior.
- Real-media E2E coverage should include Maniac Mansion, Murder on the
  Mississippi, Last Ninja, and Impossible Mission II when local samples
  are available.
- Runtime outputs should be registered as project artifacts when they are
  evidence.
- Large raw JSONL traces are a transport/debug artifact, not the final UI
  format. Prefer DuckDB trace stores, rollups, focused swimlanes, and
  registered summaries.

## Important Specs

| Area | Specs |
|---|---|
| Kernel/runtime core | 200-220 |
| V2 LLM workbench | 230-251 |
| V3 technical UI | 260-272 |
| VIC/drive fidelity follow-ups | 280-297 |
| V3 UX decisions | 350-357 |

## Do Not Reintroduce

- treating Headless as only a loader/depacker helper
- using KERNAL traps as TrueDrive success criteria
- game-specific traps as compatibility fixes
- private UI-only state that bypasses project knowledge
- raw trace files as the only durable answer to an RE question
