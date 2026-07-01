# C64RE Runtime Daemon — Solution Design

Status: binding design for Spec 744.4c.

> **SUPERSEDED / HISTORICAL.** This design specified a **C64RE-hosted** Runtime
> Daemon as the single emulator authority for a project. That ownership is
> superseded by the TRX64 split: the runtime authority is now the **TRX64**
> backend (the default, auto-discovered/spawned Rust daemon), with C64RE as the
> workbench that drives it.

**Leitregel: Capability → TRX64, Meaning/Memory → C64RE.** TRX64 is the strategic runtime base and the default backend process (the Rust daemon, auto-discovered/spawned) — it produces bytes, events and machine-state and owns runtime, instrument, reverse-debug, trace, checkpoints (`.c64re`/`.c64retrace`), daemon/FFI/CLI. C64RE is the reverse-engineering workbench — project knowledge, method/memory, analysis pipeline, semantic disassembly, findings/entities/questions, UI/orchestration, curation — it turns those bytes/events/state into knowledge. The TypeScript runtime in C64RE is a fallback / parity oracle, not the strategic base. Endstate: two MCP servers — `trx64-mcp` (instrument/runtime) and `c64re-mcp` (workbench/knowledge); today's C64RE `runtime_*` tools are a transition/proxy to the TRX64 backend, not their permanent home.

The binary trace-format / index details described below remain accurate; only their ownership now lives in TRX64.

## Goal

There is exactly one running C64 Headless Runtime authority for a project.

Both actors are clients:

- human: browser UI;
- LLM: MCP runtime tools.

Neither actor owns the emulator process.

## Product Topology

```text
C64RE Runtime Daemon
  owns IntegratedSession(s)
  owns RuntimeSessionService
  owns media, trace, checkpoint/ring, run/pause/close

Browser UI
  connects to Runtime Daemon

MCP server
  runtime_* tools connect to Runtime Daemon
```

## Binding Rules

1. Product `IntegratedSession` instances are created only inside the Runtime
   Daemon.
2. UI code must not create product sessions directly.
3. MCP tools must not create product sessions directly.
4. MCP reconnect must not reset runtime sessions.
5. Browser reload must not reset runtime sessions.
6. Trace capture is active and daemon-owned. The binary `.c64retrace` firehose is
   the default capture path; the live run loop drains the trace once per frame; the
   DuckDB query index is built asynchronously on a worker thread after `stop()`
   returns. Starting a trace does not by itself start a run loop.
7. UI live playback is explicit continuous mode.
8. All trace READS route through the daemon. `trace_store_*` + swimlane/query tools
   call the daemon's `trace/read` op (which lazy-rebuilds a missing index from the
   `.c64retrace` authority), so the daemon is the single owner of the trace store —
   clients ask it, they do not open the store themselves. MCP runtime tools are
   bounded operations unless they explicitly ask the daemon for live mode.
9. Commands from UI and MCP serialize through the daemon and return explicit
   busy/run-state results when they overlap.
10. VICE is not part of this product topology.

## Rejected Topologies

### MCP-hosted Runtime

Rejected as product architecture. It ties runtime lifetime to MCP/IDE
connection lifetime. MCP reconnect can reset sessions.

### UI-hosted Runtime

Rejected as product architecture. It makes MCP attach/control dependent on a UI
process and historically led to a second MCP-private runtime.

### Two Process-local Singletons

Rejected. A singleton is shared only inside one OS process. UI and MCP in
separate processes with separate singletons are two runtimes.

### Mirrored Emulators

Rejected. Shared runtime means one machine state, not two sessions synchronized
after the fact.

## Required Runtime Daemon API

The transport may be HTTP, WS, JSON-RPC, stdio bridge, or another local protocol.
The API shape must cover:

- `session.start/list/attach/status/close`
- `control.run/pause/resume/wait/step`
- `media.mount/swap/eject/status`
- `trace.start/mark/status/stop` — start live capture on a running session, mark
  phases, poll status, stop. `stop` finalizes the `.c64retrace` and returns
  IMMEDIATELY (the DuckDB index builds off-thread); optional `wait_index: true`
  blocks until the index is queryable. (`trace.finalize` was collapsed into `stop`.)
- `trace.read store_fn` — route all store reads (query/info/top-pcs/bus/anchors)
  through the daemon, which lazy-rebuilds a missing index from the `.c64retrace`
  authority before reading.
- `render.frame/screenshot/status`
- `inspect.*` for frozen/live inspection where applicable

MCP can wrap these as stable `runtime_*` tools. The LLM must not need to know the
daemon transport.

## Acceptance

Spec 744.4c is accepted only when an end-to-end product test proves:

1. start Runtime Daemon;
2. UI connects as client;
3. MCP connects as client;
4. MCP creates a session and UI sees the same session id/frame/cycle;
5. UI pauses/runs that session and MCP sees the same state transition;
6. UI creates or selects a session and MCP can status/render/control it;
7. MCP reconnect does not reset the session;
8. browser reload does not reset the session;
9. grep/audit proves no product path creates `IntegratedSession` outside the
   daemon.

## Trace Capture & Indexing (Spec 726.B + Spec 746.x)

### Binary trace format (`.c64retrace`)

The authoritative runtime trace timeline is an append-only binary log
(`.c64retrace`). DuckDB is a DERIVED, rebuildable query index — never the hot-path
authority.

```
FILE        := FileHeader  Event*
FileHeader  := MAGIC(8 "C64RETR1")  version(u16)  flags(u16)  metaLen(u32)  metaJson(metaLen)
Event       := opcode(u8)  payload(opcode-specific, self-delimiting)
```

- All multi-byte fields are **little-endian**. `cycle` is **f64** (holds the full
  2^53 safe-integer range — a PAL session far exceeds u32 cycles).
- `metaJson` = `{ runId, defId, defVersion, defName, defJson, domains, cycleStart,
  mediaSha?, mediaName?, startCheckpointId?, createdAt }`. `defJson` is the full
  trace definition, so the index is always rebuildable from the log alone.
- Events are **self-delimiting**: fixed opcodes have a static payload size (the
  `SIZE` table); the variable opcodes (`MARK`, `MEDIA_WRITE`) embed a u16 length.
  A decoder streams sequentially and skips unknown opcodes (forward-compatible).

Record sizes (total bytes incl. the 1-byte opcode):

| Opcode | Hex | Bytes | Payload after opcode |
|---|---|---|---|
| CPU_STEP / DRIVE_CPU_STEP | 0x10 / 0x30 | 19 | cycle(f64) pc(u16) opcode A X Y SP P b1 b2 |
| RAM/IO/DRIVE_RAM_WRITE | 0x11/0x12/0x31 | 15 | cycle addr(u16) value pc(u16) access |
| VIC_REG_WRITE | 0x20 | 13 | cycle rasterY(u16) kind value |
| SID_REG_WRITE | 0x22 | 12 | cycle reg(u16) value |
| IEC_LINE_CHANGE | 0x23 | 11 | cycle lines(u16 bitfield) |
| MARK | 0x01 | variable | cycle len(u16) label(len) |

(`access` byte: 0=read, 1=write. Reserved, never emitted: CIA 0x21, VIA 0x32,
GCR 0x33, MEDIA_WRITE 0x40.)

### Deferred index build (worker thread)

The live run loop (`runtime-controller.tick()`) drains the trace once per completed
frame, feeding the binary firehose (zero-alloc; this per-frame drain is what keeps
the ~15–140 MiB/s firehose from filling RAM — the prior JSON path OOM'd the daemon).
On `stop()`:

1. the `.c64retrace` is finalized immediately (flush + close, ~12 ms);
2. `stop()` returns instantly and kicks `startBackgroundIndex` on a **worker
   thread** (`binary-log-index-worker.ts`) — the daemon never freezes on the decode;
3. the indexer **streams** the log in bounded windows (no whole-file read — fixes
   the >2 GiB `ERR_FS_FILE_TOO_LARGE` cap), builds into a temp `.duckdb`, and
   **atomically renames** it onto the final path on success (a concurrent reader
   never sees a half-written/locked store);
4. readers call `awaitIndex(path)` to block only until the index is ready.

### One read path + lazy-on-read

Every trace read goes through the daemon's `trace/read` op (BUG-029: only the daemon
process can open a store it owns). Before opening, the daemon calls `ensureIndex`:
if the `.duckdb` is missing but the `.c64retrace` authority exists, it **rebuilds
the index lazily** from the log (recovers an orphaned store, e.g. a multi-GB trace
whose index never built). `resolveStorePath` passes a missing `.duckdb` through when
its `.c64retrace` exists, so `trace_store_*` triggers the rebuild. Index failures are
recorded + surfaced (`trace index unavailable: <reason>`), not silently swallowed.

