# C64 Runtime — the TRX64 daemon

The runtime that MCP tools, agents, scripts and the Emulator UI drive is **TRX64**:
a native (Rust) daemon, a separate process, auto-discovered and auto-spawned as the
sibling `../TRX64/target/release/trx64-daemon` (override with `C64RE_RUNTIME_BIN` /
`C64RE_TRX64_BIN`). It serves the WS JSON-RPC protocol and owns the `.c64re` and
`.c64retrace` formats.

**There is no second runtime.** No in-process emulator, no fallback, nothing to A/B
against. If the daemon is missing the tools say so and hand you the per-OS setup
recipe; nothing silently substitutes.

Leitregel: Capability → TRX64, Meaning/Memory → C64RE.

- C64RE owns the project knowledge, artifacts, specs, workflow, and UI.
- The runtime provides deterministic, scriptable runtime evidence for agents and
  browser clients.
- VICE is a source tree to READ when porting — never something C64RE runs. The
  architecture references moved to `../TRX64/docs/` on 2026-08-12, with the port.

`docs/mcp-tool-usecase-matrix.md` is the generated tool list.
`docs/tool-surface-inventory.md` is a May-2026 audit snapshot, not the current surface —
the live answer is `DEFAULT_TOOLS` in `src/server-tools/tier-tools.ts`.

## Monitor, Interrupts, And Rendering

> The `runtime_*` / monitor / recorder / checkpoint MCP tools are a
> transition/proxy to the runtime daemon (endstate: a dedicated instrument
> server). Every one of them is a client call; none runs a machine here.

| Tool | Description |
|---|---|
| `runtime_render_screen` | Render the current VIC framebuffer to a PNG artifact. |
| `runtime_monitor` | **One tool = the whole interactive monitor REPL, no per-verb allow-list.** Pass ANY command string the human prompt accepts and get its text output — there is no gating, the LLM has the same reach as a person at the monitor. That includes: inspect (`m`/`d`, `r`, `sym`/`inspect`/`xref`, `df`); run control (`n`/`z`/`g`, `bp`/`del`); observers + scoped trace (`obs … do break\|log\|trace`); state (`dump`/`undump`, `trace`); **file I/O / FS mini-shell** (`cd`/`ls`, `load`/`save`, `bload`/`bsave`, `vsf`); **cartridge hot-swap** (`swapcrt`); annotations (`label`/`note`); plus `device c64\|drive8`, `sidefx`, `bank`. Run `help` for the full verb list. Routes to the `monitor/exec` WS handler with the full context, including the trace-store and project bridges. |
| `runtime_recorder_status` / `_list` / `_dump` | The off-thread shared-memory recorder (Spec 766). Its auto-feed is ON by default and is turned OFF with `C64RE_RECORDER_AUTOFEED=0` — this line claimed the opposite (`opt-in C64RE_RECORDER=1`) until 2026-08-12; that variable never existed. `_list` shows the scrub-history anchors; `_dump <seq> <path>` persists a past anchor to a durable `.c64re` (reconstructs core + gen-gated medium) so it can be undumped and replayed with tracing on. |
| `runtime_checkpoint_list` / `_capture` / `_pin` / `_unpin` / `_restore` | The daemon's 705.B checkpoint ring (auto-captured ~0.5 s) for live rewind/scrub. |

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

The **runtime backend, not the UI, owns the machine clock.** The browser is a
visualization and command layer on top of a backend-driven loop.

### Backend owns the loop

The daemon runs the C64 + 1541 core continuously, independent of any connected
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
npm run runtime:daemon -- --project <dir>   # start the TRX64 daemon in the foreground, port 4312
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
rollups, zoomable time windows, and runtime trace import.

## Where the runtime is developed

Runtime work happens in TRX64, against its own gates (Spec 783). C64RE consumes it:
if a runtime capability is missing, the answer is a TRX64 change plus the MCP tool
that reaches it — never a second implementation here.
