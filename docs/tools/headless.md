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

## Starting a session — from a cartridge, a disk, a PRG or a snapshot

One parameter, `media_path`, takes all of them. The daemon decides the type by
reading the file, so a cartridge start needs no separate tool and no placeholder
disk:

```
runtime_session_start  media_path = analysis/cart/game.crt
runtime_session_start  media_path = input/disk/game.g64   device_id = 8
runtime_session_start  media_path = analysis/payloads/loader.prg
runtime_session_start  media_path = runtime/dumps/dump-1788791926009.c64re
runtime_session_start                                    # attach to the shared session as it stands
```

`disk_path` is a deprecated alias kept for existing callers. Its name is the
reason this section exists: a session is a MACHINE and a medium is something you
put in it, but the parameter was called `disk_path` and was once required — so
starting from a cartridge meant naming a `.g64` nobody used just to satisfy the
schema, and then mounting the CRT separately (BUG-041). That is long fixed, and
until now nothing said so where a caller would look.

Swapping a cartridge in a session that is already running is the monitor's
`swapcrt`, through `runtime_monitor`.

**"Sandbox" means two different things in this repo**, which is worth knowing
before searching for one. `sandbox_6502_run` and `sandbox_depack` are a CPU sandbox —
no machine at all: a flat 64K of RAM and the real 6502 core, with no VIC, no CIA, no
drive, no KERNAL — the right tool for running a depacker over some bytes. An
ephemeral MACHINE — a whole C64 on its own port, born with a budget and ending
itself when it runs out — is the next section, `runtime_sandbox_run`. If you want
a cartridge to boot, you want a machine, not the CPU sandbox.

## A machine of your own — `runtime_sandbox_run`

`runtime_session_start` is the SHARED machine: one per daemon process, the one
the human's UI is showing, co-driven and never power-cycled for a test. When it
attaches, a `media_path` is **refused** rather than applied — mounting into it is
`runtime_media_mount`'s job, or the monitor's `swapcrt`.

A medium of your own goes in a machine of your own:

```
runtime_sandbox_run  media_path = input/disk/game.g64 \
                     steps      = ['I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"',
                                   'I wait until the drive is idle within 8000 frames',
                                   'I wait 120 frames'] \
                     read_memory = ["$0400:1000", "$d018:1@io"] \
                     frame_path  = analysis/boot.gif
```

It spawns its own `trx64-daemon` on its own port as a CHILD of the call, switches
it on, waits for the BASIC prompt, puts the medium in, walks the steps, reports,
and ends the machine. It is born with a budget (default 120 s, max 600) and ends
itself when the budget runs out whether or not anyone is still listening — that
budget is what makes starting one safe.

**Where the line is drawn, and why.** A sandbox exists for one call, so the call
may ask for anything COMPLETE IN ITSELF: a bounded run, a wait on a state the
machine reaches by itself (`I wait until the CPU reaches $0810 within 4000
frames`), the text screen, the registers, a memory dump, one GIF frame. It may
not ask for anything whose value depends on a LATER call — a breakpoint you stop
at and then decide from, a step you repeat, a monitor prompt — because there is
no later call: **the tool returns no `session_id` and nothing can attach to it.**
A sandbox you could come back to would be a second shared machine, and doctrine
rule 2 allows exactly one. For an interactive debug loop, use the shared machine.

The step notation is the capture scenario's, the same parser as
`runtime_scene_reel` and `.feature` goals — minus `I capture`, which is refused
here with a pointer at the reel. Two ways to say "wait 170 frames" is how a repo
ends up with two of everything.

**One case is not a whole machine.** A `.prg` opened into a sandbox with no disk
and no cartridge makes the runtime latch it as an instruction exerciser and
advance it on an isolated CPU core: no VIC, no CIAs, no SID, no 1541. The CPU,
registers and memory stay real; the screen freezes, no frame can be taken and a
typed key is never scanned. The tool detects this (it asks the runtime whether
its VIC is sweeping) and says `NOT A WHOLE MACHINE` above the report rather than
handing back a stale screen. A cartridge or a disk keeps the whole machine — put
the PRG on a `.d64`, or load it into the shared session, which stays whole.

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
