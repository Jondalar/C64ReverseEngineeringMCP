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

## V3 Emulator UI — Pure Visualization Of The Headless Core

As of Spec 701 (DONE 2026-05-21) the **headless runtime, not the UI, owns
the machine clock.** The browser is a thin visualization + command layer
on top of a backend-driven loop.

### Backend owns the loop

`RuntimeController` (`src/runtime/headless/debug/runtime-controller.ts`)
runs the C64 + 1541 core continuously, independent of any connected
browser:

- **Pacing** (`session/set_pacing`): `pal` paces to ~1 MHz / 50 fps
  (`setTimeout` sleeping the slice remainder), `warp` runs flat-out
  (`setImmediate`), `fixed-ratio` clamps to a chosen multiple of realtime.
- **Run / pause / stopped** state is backend-owned. The controller
  **self-halts on a breakpoint** — the UI never polls a clock.
- **Breakpoints** live in a stable checknum store on the controller;
  `FlowTracker` (Spec 623) classifies each step into MAIN / IRQ / NMI.
- **Atomic media ops**: `runExclusive(fn)` suspends the loop while a disk
  is mounted / swapped so a tick can never run on a half-attached drive.

The controller broadcasts state changes — `debug/running`,
`debug/paused`, `debug/stopped`, `debug/breakpoint_hit` — and frame
availability over the WebSocket. The UI reacts; it does not drive.

### UI is a command + visualization client

The browser sends commands and renders broadcasts. It holds no emulation
clock:

| UI action | WS command |
|---|---|
| Run / pause | `debug/run` / `debug/pause` |
| Single step | `debug/step` |
| Breakpoint add/remove, go, halt | `monitor/exec` `bk` / `del` / `g` / `z` |
| Interrupt-aware step / return | `monitor/exec` `n` / `ret` (Spec 623 §4.2) |
| Flow-focus step (stay in MAIN/IRQ/NMI) | `monitor/exec` `focus` / `sf` / `nf` (§4.3) |
| Warp toggle, pacing | `session/set_pacing` |
| Mount / swap / unmount media | `media/*` (wrapped in `runExclusive`) |

### Live VIC frame transport (Spec 701 §7)

The screen is a **binary VIC frame stream**, not per-frame PNG/base64:

- The controller pushes raw frames over the WS binary channel
  (`BIN_TYPE_VIC_FRAME`). Format 1 is palette-indexed (1 byte/pixel +
  48-byte RGB palette, ~102 KB/frame); format 0 is RGBA.
- **Latest-frame-wins** with a `bufferedAmount` guard — slow clients drop
  frames instead of lagging.
- The UI blits straight into a `<canvas>` via a reused `ImageData`.

### Inspector surface

`session/state` exposes the visualization model the inspector renders:

- **Per-flow CPU blocks** — MAIN / IRQ / NMI. The shared register file
  (A / X / Y / SP / `nv-bdiZc`) is shown once; each flow shows its own PC
  plus vector targets (`$0314/$0315` CINV, `$0318` NMI, `$FFFE/$FFFF`,
  `$FFFA/$FFFB`).
- **Live VIC raster** (`raster_line`, read from the literal-port
  `LIT_TYPES.vicii`, not the legacy `raster_y`), border/background.
- **Drive surfaces** — LED, motor, head half-track, current track/sector.

### Run it

```bash
npm run v3:server     # headless runtime WS backend (port 4312)
npm run ui:v3:dev     # V3 browser client (vite, port 4313)
```

The same runtime surface also adds media selection, keyboard/joystick
passthrough, frozen-screen exploration, and trace swimlanes.

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

- [../../specs/217-duckdb-trace-store.md](../../specs/217-duckdb-trace-store.md)
- [../../specs/230-v2-llm-workbench-master.md](../../specs/230-v2-llm-workbench-master.md)
- [../../specs/234-transaction-swimlane.md](../../specs/234-transaction-swimlane.md)
- [../../specs/355-emulator-trace-swimlane-workbench-ux.md](../../specs/355-emulator-trace-swimlane-workbench-ux.md)

## Current Development Focus

As of 2026-05-22, the active runtime work is around:

- 1:1 VICE 1541 port under `src/runtime/headless/vice1541/**` (Spec 612
  fidelity doctrine), driving toward dropping VICE entirely
- the 7-game Runtime Proof Gate (motm / MM / IM2 / LNR / Scramble / Pawn /
  Polarbear) staying GREEN as the single acceptance bar (Specs 600/601)
- backend-owned autonomous runtime loop + V3 visualization (Spec 701) and
  VICE-faithful monitor stepping (Spec 623)
- VIC-II pixel/line/raster fidelity from the `viciisc/` literal port
- per-cycle drive scheduling and custom-fastloader `$DD00` paths
  (Specs 614/618)

Do not introduce game-specific traps as product fixes. Compatibility
bugs should identify the exact VICE-observable event or state being
matched.
