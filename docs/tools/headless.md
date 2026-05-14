# Headless TS C64 + 1541 Runtime

The Headless Runtime is the TypeScript emulator subsystem used by MCP
tools, agents, regression scripts, and the V3 Emulator UI. It is no
longer just a loader/depacker harness.

It remains part of the larger C64RE MCP project:

- C64RE owns the project knowledge, artifacts, specs, workflow, and UI.
- VICE remains the compatibility oracle and useful external debugger.
- Headless provides deterministic, scriptable runtime evidence for
  agents and browser clients.

## Runtime Modes

The roadmap and ADR distinguish these modes:

| Mode | Purpose |
|---|---|
| `fast-trap` | Fast analysis path where KERNAL/file traps are acceptable helper behavior. Not an acceptance path for TrueDrive. |
| `real-kernal` | C64 KERNAL runs normally while media access may still use limited helpers. |
| `true-drive` | Real 1541 ROM, drive CPU/VIA, IEC, GCR, motor/head/media behavior. Required for custom fastloaders. |
| `debug-vice-compare` | Headless run prepared for first-divergence comparison against VICE. |
| `debug-lockstep` / `debug-push-only` / `debug-hybrid` | Diagnostic-only modes. They are not product acceptance modes. |

See [../adr-headless-machine-kernel.md](../adr-headless-machine-kernel.md)
and [../../EPIC_ROADMAP.md](../../EPIC_ROADMAP.md).

## Integrated C64 + 1541 Sessions

| Tool | Description |
|---|---|
| `headless_integrated_session_start` | Start a C64 session with optional PRG/CRT/D64/G64 media, mode, and reset profile. |
| `headless_integrated_session_run` | Run by instruction/cycle budget or until a stop condition. |
| `headless_integrated_session_status` | Report machine state, media state, clocks, and recent runtime status. |
| `headless_integrated_session_snapshot` | Capture structured C64/drive/runtime state for analysis or replay. |
| `headless_integrated_session_load_prg` | Load a PRG into an existing session. |
| `headless_integrated_session_type` | Type text through the emulated keyboard path. |
| `headless_integrated_session_joystick` | Set joystick directions/fire for the active session. |

## Standalone Drive Sessions

Standalone drive tools are useful for 1541/G64 investigation and for
isolating media or VIA behavior from a full C64 boot.

| Tool | Description |
|---|---|
| `headless_drive_session_start` | Start a 1541 drive session backed by a G64/D64 image. |
| `headless_drive_status` | Inspect drive CPU, VIA, motor/head, track, and media state. |
| `headless_iec_bus_state` | Inspect resolved IEC line state. |
| `headless_drive_session_save_vsf` | Save a drive snapshot. |
| `headless_drive_session_load_vsf` | Restore a drive snapshot. |
| `headless_drive_persist_writes` | Persist modified media to an output image. |

## Monitor, Interrupts, And Rendering

| Tool | Description |
|---|---|
| `headless_interrupt_request` | Request IRQ/NMI in the session. |
| `headless_interrupt_clear` | Clear pending interrupt state. |
| `headless_io_interrupt_trigger` | Trigger simple emulated I/O interrupt sources. |
| `headless_render_screen` | Render the current VIC framebuffer to a PNG artifact. |

The V3 UI builds on the same runtime surface and adds browser control,
screen display, monitor interaction, media selection, keyboard/joystick
input, frozen screen exploration, and trace swimlanes.

## Trace And Evidence Direction

Headless runtime evidence should become project artifacts:

- raw traces or DuckDB-backed trace stores
- compact swimlane windows
- screenshots and visual state summaries
- snapshots and replay checkpoints
- findings/entities/relations derived from runtime observations

Large JSONL traces are not the desired long-term UI format. The current
direction is a DuckDB trace store with typed event tables, post-hoc
rollups, zoomable time windows, and VICE/headless trace import.

Relevant specs:

- [../epic-headless-time-travel-trace-architecture.md](../epic-headless-time-travel-trace-architecture.md)
- [../../specs/217-duckdb-trace-store.md](../../specs/217-duckdb-trace-store.md)
- [../../specs/230-v2-llm-workbench-master.md](../../specs/230-v2-llm-workbench-master.md)
- [../../specs/234-transaction-swimlane.md](../../specs/234-transaction-swimlane.md)
- [../../specs/355-emulator-trace-swimlane-workbench-ux.md](../../specs/355-emulator-trace-swimlane-workbench-ux.md)

## Current Development Focus

As of 2026-05-09, the active runtime work is around:

- VICE-parity C64/1541 behavior for real games and custom loaders
- VIC-II pixel/line/raster fidelity with real-game regression corpus
- media attach/swap behavior in live sessions
- monitor and V3 browser control surface
- keyboard/joystick passthrough from the browser
- drive status surfaces such as LED/motor/head/write-protect
- structured trace storage and side-by-side swimlane analysis

Do not introduce game-specific traps as product fixes. Compatibility
bugs should identify the exact VICE-observable event or state being
matched.
