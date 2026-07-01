# C64 Runtime — TRX64 backend (default) + TypeScript Headless (fallback / parity oracle)

The runtime backend that MCP tools, agents, regression scripts, and the
Emulator UI drive is **TRX64** by default — the native (Rust) daemon,
auto-discovered/spawned as the sibling `../TRX64/target/release/trx64-daemon`.
The **TypeScript Headless runtime** documented here is now the **fallback /
parity oracle** (force it with `C64RE_RUNTIME_TS=1`); it is no longer just a
loader/depacker harness. Both serve the same WS protocol and the same `.c64re`
/ `.c64retrace` formats.

Leitregel: Capability → TRX64, Meaning/Memory → C64RE.

It remains part of the larger C64RE MCP project:

- C64RE owns the project knowledge, artifacts, specs, workflow, and UI.
- VICE remains the compatibility oracle and useful external debugger.
- The runtime (TRX64 by default; the TypeScript Headless runtime as
  fallback / parity oracle) provides deterministic, scriptable runtime
  evidence for agents and browser clients.

## Runtime Modes

The runtime exposes several modes for tools and diagnostics:

| Mode | Purpose |
|---|---|
| `fast-trap` | Fast analysis path where KERNAL/file traps are acceptable helper behavior. Not an acceptance path for TrueDrive. |
| `real-kernal` | C64 KERNAL runs normally while media access may still use limited helpers. |
| `true-drive` | Real 1541 ROM, drive CPU/VIA, IEC, GCR, motor/head/media behavior. Required for custom fastloaders. |
| `debug-vice-compare` | Headless run prepared for first-divergence comparison against VICE. |
| `debug-lockstep` / `debug-push-only` / `debug-hybrid` | Diagnostic-only modes. They are not product acceptance modes. |

Product compatibility gates should use `true-drive` unless a test explicitly
targets a faster analysis or diagnostic mode.

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

> The `runtime_*` / monitor / recorder / checkpoint MCP tools are a
> transition/proxy to the TRX64 backend (endstate: a dedicated `trx64-mcp`
> instrument server). The TS daemon / in-proc paths documented here are the
> fallback / parity oracle.

| Tool | Description |
|---|---|
| `headless_render_screen` | Render the current VIC framebuffer to a PNG artifact. |
| `runtime_monitor` | **One tool = the whole interactive monitor REPL, no per-verb allow-list.** Pass ANY command string the human prompt accepts and get its text output — there is no gating, the LLM has the same reach as a person at the monitor. That includes: inspect (`m`/`d`, `r`, `sym`/`inspect`/`xref`, `df`); run control (`n`/`z`/`g`, `bp`/`del`); observers + scoped trace (`obs … do break\|log\|trace`); state (`dump`/`undump`, `trace`); **file I/O / FS mini-shell** (`cd`/`ls`, `load`/`save`, `bload`/`bsave`, `vsf`); **cartridge hot-swap** (`swapcrt`); annotations (`label`/`note`); plus `device c64\|drive8`, `sidefx`, `bank`. Run `help` for the full verb list. Daemon mode routes to the `monitor/exec` WS handler (full ctx incl. trace-store/project bridges); in-proc builds a minimal ctx (the trace-store/project bridge verbs — map/taint/swimlane/inspect/xref/label — need the daemon path). |
| `runtime_recorder_status` / `_list` / `_dump` | The off-thread shared-memory recorder (Spec 766; opt-in `C64RE_RECORDER=1`). `_list` shows the scrub-history anchors; `_dump <seq> <path>` persists a past anchor to a durable `.c64re` (reconstructs core + gen-gated medium) so it can be undumped and replayed with tracing on. |
| `runtime_checkpoint_list` / `_capture` / `_pin` / `_unpin` / `_restore` | The in-process 705.B checkpoint ring (auto-captured ~0.5 s) for live rewind/scrub. |

**Non-halting scoped trace via observers** — start/stop a trace on PC hits without
breakpoints, e.g. from `runtime_monitor`:

```
obs trstart when exec ab01 do trace c64-cpu memory   # PC=$AB01 → trace on, prints runId
obs trstop  when exec ab04 do trace off              # PC=$AB04 → trace off, prints runId + events
```

The exec observer fires-and-continues (no halt); the trace runId is written back to
the monitor on both start and stop. Address ranges use `lo..hi` (e.g.
`obs w when store 3400..59ff do log`).

## Emulator UI - Visualization Of The Headless Core

The **runtime backend, not the UI, owns the machine clock** (TRX64 by default;
the TypeScript headless runtime described here is the fallback). The browser is a
visualization and command layer on top of a backend-driven loop.

### Backend owns the loop

`RuntimeController` (`src/runtime/headless/debug/runtime-controller.ts`)
runs the C64 + 1541 core continuously, independent of any connected
browser:

- **Pacing** (`session/set_pacing`): `pal` paces to ~1 MHz / 50 fps
  (`setTimeout` sleeping the slice remainder), `warp` runs flat-out
  (`setImmediate`), `fixed-ratio` clamps to a chosen multiple of realtime.
- **Run / pause / stopped** state is backend-owned. The controller
  **self-halts on a breakpoint** — the UI never polls a clock.
- **Breakpoints** live in a stable checknum store on the controller.
  `FlowTracker` classifies each step into MAIN / IRQ / NMI.
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
| Interrupt-aware step / return | `monitor/exec` `n` / `ret` |
| Flow-focus step (stay in MAIN/IRQ/NMI) | `monitor/exec` `focus` / `sf` / `nf` |
| Warp toggle, pacing | `session/set_pacing` |
| Mount / swap / unmount media | `media/*` (wrapped in `runExclusive`) |

### Live VIC frame transport

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
npm run runtime:daemon -- --project <dir>   # TS headless WS backend — the fallback (TRX64 is the default backend), port 4312
npm run ui:dev                              # UI dev server (vite; warm-starts the daemon)
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

## Current Development Focus

As of 2026-05-22, the active runtime work is around:

- 1:1 VICE-shaped C64/1541 behavior under `src/runtime/headless/**`
- the 7-game Runtime Proof Gate staying green as the single acceptance bar
- backend-owned autonomous runtime loop + visualization
- VICE-faithful monitor stepping and flow-aware debugging
- VIC-II pixel/line/raster fidelity from the `viciisc/` literal port
- per-cycle drive scheduling, IEC, GCR, KERNAL load/save, and custom-fastloader
  `$DD00` paths
- SID readback correctness and reSID WASM audio integration

Do not introduce game-specific traps as product fixes. Compatibility
bugs should identify the exact VICE-observable event or state being
matched.
