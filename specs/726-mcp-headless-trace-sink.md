# Spec 726 — Headless Trace Sink + Marks (close the capture gap)

**Status:** DONE for the current DuckDB sink (2026-05-29); ARCHITECTURE
CORRECTED for the next trace implementation (2026-05-30). The shipped
TraceRunController streams to DuckDB (queue + async drain, no RAM cap);
`runtime_session_start(trace_out, trace_domains)` enables passive producers +
starts the run; `runtime_session_run`/`until` chunk + drain; new default tools
`runtime_mark` / `runtime_trace_finalize` / `runtime_trace_status`. Invariant
proven by `scripts/smoke-trace-sink.mjs` (10/10: producers passive + chunked
traced run == untraced + real trace.duckdb). default=76, full=274.
probe-tool-surface 18/18, probe-single-path 25/25, no runtime:proof.

**Correction (2026-05-30):** the shipped DuckDB writer is acceptable as a
queryable trace MVP, but it is NOT the final architecture for endless traces,
rewind/forward or "record everything" runtime work. The Runtime strand is our
own emulator product for LLMs. The authoritative timeline must be a compact
binary runtime trace log; DuckDB is a derived query index, not the hot path and
not the only source of truth.

**726.B priority:** Trace V2 is not an optional someday optimization. It is the
required next implementation slice for endless tracing and rewind/forward. The
current JSON/DuckDB writer is proof-only for that use-case and must not be used
as the long-running interactive trace architecture.

**726.B Slice 1 SHIPPED (2026-05-30).** The binary `.c64retrace` timeline is now
the authority for the live MCP trace path; DuckDB is a rebuildable query index
built FROM the log. `runtime_session_start(trace_out=…)` streams binary; finalize
builds the index. What landed:
- `trace/binary-format.ts` — versioned append-only format (`C64RETR1`), file
  header carries run metadata (rebuild is self-contained), self-delimiting
  events.
- `trace/binary-log-writer.ts` + `binary-log-worker.ts` — the emulator thread
  only fills preallocated 1 MiB chunks; a `worker_threads` Worker is the ONLY
  disk boundary (overlaps the next run chunk). Backpressure is block-only at the
  binary-append boundary (drain, emulator paused); DuckDB never backpressures the
  emulator. No-drop.
- `trace/binary-log-indexer.ts` — `.c64retrace → trace.duckdb` via the DuckDB
  Appender (columnar, ~8× faster than INSERT-VALUES; finalize lag 44 s → 5.5 s
  for 3 M events). Reconstructs the exact `trace_run`/`trace_event`/`trace_mark`
  reader schema (§6a) so every existing reader works unchanged. Rebuildable any
  time from the log alone.
- Zero-alloc CPU firehose: `kernel-trace.ts` `CpuBinarySink` routes
  `publishCpuInstruction` primitives straight to the encoder — no event object,
  no publish wrapper, no observer loop — for the hottest channel. Other broadly-
  captured channels use a precomputed fast path (no trigger matching).

**§2a.1 perf gate GREEN** (`scripts/smoke-trace-perf.mjs`, best-of-3): broad
binary trace overhead **5.7%** (≤10%), trace-on **2.05× PAL** (interactive play
while tracing), DuckDB index lag off-budget, **0 drops**.

**Binary today vs reserved.** Encoded binary (live): `CPU_STEP` /
`DRIVE_CPU_STEP` (zero-alloc sink), `RAM_WRITE` / `IO_WRITE` / `DRIVE_RAM_WRITE`
(bus, encode-from-data), `IEC_LINE_CHANGE`, `VIC_REG_WRITE`, `SID_REG_WRITE`,
`MARK`. RESERVED (opcode + encoder defined, no live producer yet):
`CIA_EVENT`, `VIA_REG_WRITE`, `GCR_EVENT`, `MEDIA_WRITE`.

**Honest residue → 726.B-2.** Strategy was "encode-from-data": non-CPU channels
still allocate the producer's `data` object before the observer encodes it (CPU
is already zero-alloc via the sink). True zero-alloc for the bus/iec/vic
producers + streaming (not read-whole-file) indexing + a `runtime_trace_rebuild`
tool are the remaining 726.B-2 work. The legacy JSON-streaming sink is kept ONLY
for the advanced scenario/test path; it is not the product path.

Gates: `smoke-trace-sink` 30/30, `smoke-trace-binary` 18/18, `smoke-trace-perf`
4/4, `probe-single-path` 25/25, `probe-tool-surface` 23/23 (default=99 — no new
tools), `smoke-trace-store-writer-reader-e2e` 8/8.

**§6a reader-alignment corrected (2026-05-30):** the convenience readers
previously SELECTed from legacy `meta`/`instructions` tables synthesized by a
compat-view shim over a 726 store — §6a forbids that. The readers now consume
the live-writer `trace_run`/`trace_event`/`trace_mark` schema DIRECTLY via inline
projections (`src/runtime/trace-store/schema726.ts`); legacy Spec-217 native-store
reads are isolated in `queries-legacy217.ts` (reached only for a non-726 store).
Proven by `scripts/smoke-trace-store-writer-reader-e2e.mjs` (8/8 against the
Murder fixture `run_live-capture_mprewdk9`): no reader SQL on `meta`/
`instructions`, `trace_store_query` raw SQL is the escape hatch only.
smoke-trace-sink 30/30.
**Owner:** MCP server / runtime trace
**Source:** `docs/llm-human-c64re-swimlane.md` + the Murder project use-case
`docs/USECASE_trace_to_disasm.md` (trace → dynamic analysis → better disasm).
**Purpose:** let an LLM persist a headless execution trace to a queryable
`trace.duckdb` from the LIVE session, so the existing reader tools
(`runtime_query_events`, `trace_store_*`, swimlane/taint/follow/profile) actually
have a store to read. Today the readers exist but **no tool writes the store**.

## 0. Product Use-Cases From The LLM-Human Swimlane

These are the product use-cases that 726 must enable for an LLM running in an
isolated session. The LLM must be able to do them through MCP default tools,
without using the V3 WebSocket server directly and without enabling
`C64RE_FULL_TOOLS`.

### UC1 — Trace-first reverse engineering

User goal: "Run the game first; figure out what actually executes before
disassembling everything."

Flow:

1. LLM inventories media with `inspect_disk` / `extract_disk` / `extract_crt`.
2. LLM starts Headless with `runtime_session_start(trace_out=..., trace_domains=...)`.
3. LLM drives the session with `runtime_type`, `runtime_joystick`,
   `runtime_session_run` / `runtime_until`.
4. LLM marks phases: `runtime_mark("boot")`, `runtime_mark("title")`,
   `runtime_mark("loader-start")`, `runtime_mark("gameplay")`.
5. LLM finalizes trace and queries it:
   `trace_store_top_pcs`, `trace_store_bus_find`, `runtime_swimlane_slice`,
   `runtime_profile_loader`.
6. LLM uses executed PC sets and bus/memory access sets to choose entry points,
   data ranges and payloads for `disasm_prg` / `disasm_menu`.

Canonical `.d64` / `.g64` disk boot command sequence:

```text
runtime_session_start(disk_path=<disk>, trace_out=<trace.duckdb>)
runtime_session_run(... until stable BASIC READY ...)
runtime_mark("basic-ready")
runtime_type("LOAD\"*\",8,1\rRUN\r")
runtime_session_run(... until stable title/loaded screen ...)
runtime_mark("loaded-or-title")
runtime_trace_finalize()
```

For disks where `LOAD"*",8,1` is not appropriate, first run
`LOAD"$",8` to inspect the directory, then issue the selected `LOAD` command.
The trace remains active across all typed commands and custom-loader phases.

Required 726 result: a real `trace.duckdb` exists after the live run. Reader
tools must not need a pre-existing scenario trace or hand-written WS client.

### UC2 — Disassembly-first, trace-as-validation

User goal: "I already have disassembly; now validate which routines are real and
which labels/branches are wrong."

Flow:

1. LLM runs `analyze_prg` / `disasm_prg` / `disasm_menu`.
2. LLM starts a targeted trace on the live session with `trace_out`, narrowed
   `trace_domains` / `trace_families`, and marks around candidate phases.
3. LLM queries executed PCs, RAM reads/writes and IO accesses.
4. LLM updates annotations with `propose_annotations`, `save_finding`,
   `link_payload_to_asm`.

Required 726 result: tracing can be started from a live session after static work
has already begun; trace evidence is reusable offline and can improve the
existing disassembly.

### UC3 — Change-first, trace-as-regression/evidence

User goal: "Patch/crack/change something, then prove what changed."

Flow:

1. LLM or human applies a code/data/media intervention through the current or
   future patch/overlay path.
2. LLM runs the changed session with `trace_out`.
3. LLM marks before/after points and captures screens/checkpoints.
4. LLM compares trace slices or summaries against an earlier trace:
   `runtime_swimlane_slice`, `runtime_trace_taint`, `runtime_follow_path`,
   `trace_store_query`.
5. LLM records the result as a finding and links it to the changed code/media.

Required 726 result: trace capture is not tied to the original pristine run. It
works equally for experiments and intervention branches.

### UC4 — Human-assisted loader/protection trace

User goal: "I will play/press fire/change disk; you trace the loader and tell me
what happened."

Flow:

1. LLM starts Headless with `trace_out`.
2. Human tells the LLM what to press or when to continue.
3. LLM drives input via `runtime_type` / `runtime_joystick` and stamps marks for
   human-observed phases.
4. LLM queries IEC, `$DD00`, drive PC and bus events around the marks.

Required 726 result: marks are first-class trace rows. Trace capture must support
long interactive sessions with continuous streaming to DuckDB, not a tiny
in-memory ring.

### UC5 — Frozen visual evidence back to code/data

User goal: "This logo/sprite/text is on screen; tell me which bytes/file/code
made it."

Flow:

1. LLM captures a checkpoint / frozen frame with `runtime_session_snapshot` and
   `runtime_vic_inspect_at`.
2. LLM queries trace rows around the frame/mark to find the writes and code path
   that filled the RAM/VIC region.
3. LLM links visual evidence to payload/disassembly with
   `link_payload_to_asm`, `save_finding`, `link_entities`.

Required 726 result: trace marks and checkpoint references can align a frozen
visual state with the writes and executed code that produced it.

### UC6 — Offline repeated questioning

User goal: "Do not rerun the game for every question."

Flow:

1. LLM captures one broad evidence trace.
2. Later, the LLM asks many different questions against the same
   `trace.duckdb`: top PCs, memory writes, loader phases, IRQ origins,
   DD00/IEC transitions, drive-side behavior.

Required 726 result: the DuckDB trace is a durable project artifact. Runtime
does not need to be alive for `trace_store_*` queries.

## 1. Problem (the capture gap)

The trace→disasm use-case needs: capture once (boot + play, trace everything to
DuckDB), then query offline a hundred times to drive a better disassembly
(executed-PC set = code, read/write set = data, decompressed images, real entry
points).

Current MCP surface (post-Spec 725):

- ✅ **Readers** (default): `runtime_query_events`, `trace_store_info/query/
  bus_find/top_pcs/anchor_list/anchor_find`, `runtime_swimlane_slice`,
  `runtime_trace_taint`, `runtime_follow_path`, `runtime_profile_loader` — all
  take a `duckdb_path`.
- ✅ **Live session** (default): `runtime_session_start/run/status/snapshot`,
  `runtime_monitor_*`, `runtime_type/joystick/load_prg/render_screen`,
  `runtime_media_*` — but the session trace is an in-memory ring (small
  capacity), NOT persisted.
- ❌ **No tool persists a `trace.duckdb` from a live session.** The pipeline
  exists in code — `TraceRunController` (Spec 708, `trace/trace-run.ts`) enables
  the needed channels, registers ONE observer, collects marks, and flushes via
  `writeTraceRun` (`trace/trace-run-store.ts`) into `trace_run` / `trace_event`
  / `trace_mark` DuckDB tables — but it is only reachable through
  `runtime_run_scenario` (advanced tier, and last attempt hung ~40 min on a
  160 M-cycle single budget). The default capture workflow has no practical
  writer.

So the chain breaks at capture: the LLM can drive the live session and can query
a DuckDB, but cannot produce the DuckDB from that session.

This is not a UI inconvenience. It breaks the product contract: the LLM can only
complete the static half of the swimlane, while runtime evidence requires an
external human/developer path.

## 2. Goal

Bind the runtime trace producer to the LIVE session and expose it as default MCP
tools. The shipped 726.A path writes a queryable DuckDB store; the corrected
726.B goal is a binary runtime trace timeline with a rebuildable DuckDB query
index.

Reuse the Spec 708 producer/channel model. Do NOT build a parallel trace path.
The high-volume path must be binary, chunked and append-only; DuckDB indexing
must be off-hot-path.

## 2a. HARD INVARIANT — trace must NOT influence the runtime

Enabling a trace (`trace_out`) MUST NOT change emulator behaviour: identical
instruction sequence, identical CPU/VIC/CIA/drive state, identical cycle counts,
with or without tracing. Trace is pure observation.

How the design guarantees it:
- The observer is **passive** — it reads events the kernel already emits; it
  never drives or mutates the machine.
- The async DuckDB drain runs **while the emulator is paused** (between
  run-chunks, inside the I/O `await`); the emulator clock does not advance during
  the drain.
- Chunking `runFor(N)` into `k × runFor(N/k)` yields the **identical** stepped
  sequence/state (runFor is resumable + deterministic) — chunking is behaviour-
  neutral.
- **Producer enablement is the one risk:** `enableBusAccessTrace` / `traceIec` /
  `traceDrive` must ONLY emit events, never add cycles or alter state. 726.2
  MUST verify this and the guard below MUST prove it.
- Wall-clock slowdown is a product performance concern, not a correctness
  waiver. Trace V2 must meet the performance budget below; "it only slows the
  host" is not an acceptable completion argument.

**Guard (mandatory):** `scripts/smoke-trace-sink.mjs` runs the SAME scenario
twice — once with `trace_out`, once without — and asserts byte-identical final
state: PC/A/X/Y/SP/flags, cpu.cycles, drive clk, and a RAM hash. Any divergence
= the trace influenced the runtime = blocker (fix the producer, do not ship).

## 2a.1 Trace V2 Performance Budget

Trace V2 must be measured against the same runtime scenario with tracing off and
on:

- Broad binary evidence trace overhead must be <= 10% versus trace-off for the
  same executed-cycle budget.
- If the trace-off runtime reaches PAL realtime on the test machine, trace-on
  must remain >= 0.9x PAL.
- If the trace-off runtime is below PAL, trace-on must remain >= 90% of the
  trace-off throughput.
- DuckDB indexing lag is allowed and may be minutes behind during heavy capture;
  it must not be part of the realtime budget.
- The binary log writer may exert backpressure only when the append-only binary
  log itself cannot accept chunks. DuckDB/index backpressure must never stall the
  emulator.

The acceptance gate must report trace-off throughput, trace-on throughput,
overhead percentage, binary-log bytes written, DuckDB index lag and whether any
loss/drop occurred.

## 2b. Architectural Directive — One Producer, Binary Timeline, Query Indexes

There must be **one runtime event production path**, not two trace systems.

Required shape:

```text
runtime chips / bus / drive
  -> existing KernelTraceController channels
  -> one TraceRunController observer
  -> compact binary event chunks (typed arrays / ArrayBuffer)
  -> sinks:
       1. append-only .c64retrace binary log (timeline authority)
       2. DuckDB index writer derived from the binary log
       3. optional live/UI/debug readers
```

### Binding rules

1. Do **not** build a second MCP-only trace capture path.
2. Do **not** make V3 WebSocket capture the authoritative trace path.
3. Do **not** use the checkpoint ring as trace history.
4. Do **not** query small diagnostic rings as durable evidence.
5. Do use preallocated binary chunks as the hot-path transport between passive
   observer and writer.
6. Backpressure policy for evidence traces is **block/slow only at the binary
   append boundary**, never silent drop. DuckDB indexing is derived and may lag;
   it must never backpressure the emulator.
7. DuckDB is a query/index projection. It is not the emulator hot path and not
   the sole timeline authority.

Terminology:

- **Checkpoint ring** = Spec 705.B restorable machine-state keyframes for rewind,
  pin, inspect and branch. It is not an event log.
- **Binary runtime trace log** = append-only `.c64retrace` event timeline. It is
  the durable authority for endless trace and rewind/forward evidence.
- **Trace-event queue/ring** = bounded transport buffer for runtime events while
  streaming binary chunks to the writer. It is not the durable store.
- **TraceDB / DuckDB** = query index used by `trace_store_*`,
  `runtime_query_events`, swimlane, taint, follow-path and loader profiling. It
  may be rebuilt from the binary log.

This means the answer is not "ringbuffer OR traces". The answer is:

```text
events are produced once
events are encoded into binary chunks
binary chunks append to the durable .c64retrace log
DuckDB indexes are built from that log for fast queries
checkpoint ring remains separate machine-state infrastructure
```

- Capture is session-driven + incremental, not scenario-batch.
- One run = one binary trace log plus a query index (`trace.duckdb`) that can be
  rebuilt.
- The agent stamps phase marks (`boot-complete`, `title`, `scene-1`) so Phase-B
  queries scope by game phase.
- No emulator behaviour change — trace is a passive observer.

## 2c. Trace V2 Hot-Path Contract — Binary, Not JSON

The current `trace_event(... data_json)` path is useful for product proof, but
is too expensive for endless traces. The endless/rewind-grade implementation
must use channel-specific binary records on the emulator hot path:

- no per-event JS object allocation for core CPU/RAM/IO events;
- no `JSON.stringify` in the hot path;
- no SQL row construction in the emulator thread;
- fixed event opcodes and typed fields, for example:
  `CPU_STEP`, `RAM_WRITE`, `IO_WRITE`, `VIC_REG_WRITE`, `CIA_EVENT`,
  `SID_REG_WRITE`, `IEC_LINE_CHANGE`, `DRIVE_CPU_STEP`, `DRIVE_RAM_WRITE`,
  `VIA_REG_WRITE`, `GCR_EVENT`, `MEDIA_WRITE`, `MARK`;
- writer must be outside the emulator hot path. Prefer a Worker/child process;
  the emulator thread may only fill/flip fixed-size binary chunks;
- DuckDB ingestion consumes chunks in large columnar batches.

The required guarantee is behavioral and performance-bounded: enabling a
lossless evidence trace must not alter emulated cycles, device state, media
state or execution order, and must satisfy §2a.1.

## 3. Relationship To Ring, Dump/Undump, Rewind and TraceDB

726 does not replace the existing runtime evidence architecture. It connects the
missing capture edge.

### 3.1 Checkpoint ring is transient state, not event evidence

Spec 705.B's ring stores recent restorable machine checkpoints. It exists so a
human or agent can rewind/pin after discovering an interesting state.

It does **not** answer:

- which instruction wrote this byte;
- which PC range executed during the loader;
- when `$DD00` or IEC changed;
- what drive PC was doing during a fastloader phase.

Those are trace-index questions. 726 must write a queryable trace index from the
binary event timeline, not expand the checkpoint ring into a trace substitute.

### 3.2 Dump/undump is durable machine state, not timeline history

Spec 707 `.c64re` dump stores a complete machine checkpoint and embedded mutable
media state. It answers: "Restore this exact machine state."

It does **not** answer: "How did we get here?" That requires trace events and
marks. 726 may reference checkpoint IDs and dump paths, but the authoritative
event timeline is the binary trace log. `trace.duckdb` is the query index.

### 3.3 Rewind uses checkpoints plus replay events

Spec 712 rewind/branch-diff consumes checkpoints, external input/media events,
interventions and retained traces. 726 provides the retained trace side.

If a branch is replayed or changed, a new trace run must be capturable from that
branch. Tracing cannot be limited to pristine scenario runs.

### 3.4 DuckDB is the query index, not the hot-path authority

Spec 708 already defines TraceDB as the persistent evidence store:

- definition/version;
- checkpoint/media/experiment linkage;
- runtime cycle range;
- marks;
- queryable event rows.

726 keeps the query contract, but corrects the storage authority for the Runtime
strand: DuckDB is the searchable projection; the append-only binary trace log is
the source of truth for endless traces and rewind/forward. It must not introduce
JSONL side paths, ad-hoc logs, or V3-WS-only capture paths.

## 3.5 Rewind/Forward Uses Checkpoints + Binary Delta Timeline

Rewind/forward cannot depend on reconstructing the machine from DuckDB JSON
rows. The required model is:

```text
periodic checkpoint keyframes
  + binary trace/delta events between keyframes
  + external input/media/intervention events
  -> deterministic restore/replay to any retained point
```

For a C64 + 1541 this is intentionally feasible: RAM/IO/media state is small
enough that binary state-change records are practical. The implementation should
prefer simple binary deltas over over-engineered database abstractions.

## 4. Tasks

### 726.1 — Audit (no code change) — DONE (2026-05-29)
`docs/headless-trace-sink-audit.md`. Findings: the pipeline is already present —
`RuntimeController` owns `traceRun = new TraceRunController()`, reachable via the
shared `ensureRuntimeController(session_id, session)` registry; the observer
fires on a plain `runtime_session_run`. Binding point = `ctrl.traceRun.start/
mark/stop`. Two design constraints REFINE 726.2:
- **Current writer is buffer-then-flush, cap 500k (BAD — 726.2 replaces it):**
  events buffer in RAM, flushed once at `stop()`; a full-session trace overflows
  + silently truncates. **726.2 reworks it into an async STREAMING writer:** the
  sync hot-path observer enqueues into a bounded queue; a background async drain
  batch-`INSERT`s into the open DuckDB store during the run; `stop()` drains the
  remainder + closes. No RAM cap, no truncation; the 500k constant becomes a
  backpressure threshold (evidence trace blocks rather than drops). Agent pacing
  (`until` + marks) is for query SCOPE, not a memory limit.
- **Producers must be enabled, not just channels:** `bus_access` needs
  `enableBusAccessTrace`, iec/drive need `traceIec`/`traceDrive` at session
  construction. → `runtime_session_start(trace_out, trace_domains)` must enable
  the matching producers per domain, else the store is empty.

### 726.2 — Streaming trace sink (code)
- **Rework `TraceRunController` from buffer-then-flush to async streaming**
  (the core change): the sync hot-path observer enqueues rows into a bounded
  queue; a background async drain opens the store at `start()` and continuously
  batch-`INSERT`s (reusing the existing 500-row-batched `writeTraceRun` insert
  path, split into per-batch appends) while the run executes; `stop()` drains
  the remainder + closes. No 500k RAM buffer; the constant becomes a
  backpressure threshold. Backpressure for an evidence trace = BLOCK (slow the
  run), never silent drop.
- `runtime_session_start` gains optional `trace_out` (resolved `.duckdb` path
  under the project) + `trace_domains`/`trace_families` (default: cpu_step +
  bus + iec/drive + vic + irq, per the use-case schema). When set: enable the
  matching trace PRODUCERS at construction (constraint #4 —
  `enableBusAccessTrace`/`traceIec`/`traceDrive` per domain), then
  `ctrl.traceRun.start(def, {controller, outputPath})` opens the store + drain.
- `runtime_session_run` / `runtime_until` capture via the already-registered
  observer; rows stream to DuckDB as they execute (no per-run append call, no
  cap).
- Finalize (`runtime_trace_finalize`, or auto on session close) drains + closes.
- Sessions WITHOUT `trace_out` are unchanged (persistence is opt-in per session).

### 726.B — Trace V2 binary timeline — Slice 1 DONE (2026-05-30); 726.B-2 open
Slice 1 (DONE):
- ✅ Hot-path `TraceEventRow`/`data_json` replaced by binary chunk encoders for
  the live trace; CPU firehose is zero-alloc (primitive sink).
- ✅ DuckDB reader tools fed from an indexer that builds/rebuilds `trace.duckdb`
  from `.c64retrace` (Appender ingest).
- ✅ Channel schemas/opcodes for CPU, RAM, IO, VIC, SID, IEC, drive CPU, drive
  RAM; CIA, VIA, GCR, media RESERVED (encoder defined, no producer yet).
- ✅ `worker_threads` writer Worker = the only disk boundary; emulator thread
  fills fixed-size chunks only.
- ✅ No-drop evidence mode: block/slow only at the binary append boundary;
  DuckDB indexing never backpressures the emulator; no silent truncation.
- ✅ Equivalence guard (`smoke-trace-sink` Part 1) + binary-format guard
  (`smoke-trace-binary`): byte-identical final state, rebuildable index.
- ✅ §2a.1 performance gate (`smoke-trace-perf`): measured 5.7% overhead,
  2.05× PAL, 0 drops.

726.B-2 (open):
- True zero-alloc for the bus/iec/vic producers (kill the producer-side `data`
  object alloc the same way CPU was killed).
- Streaming indexer (decode the log incrementally instead of read-whole-file) for
  very large traces; optional incremental index during the run.
- `runtime_trace_rebuild(retrace_path, duckdb_path)` default tool (rebuild is a
  library fn today; finalize already builds the index).
- Emit the reserved opcodes once their producers exist (CIA/VIA/GCR/media).

### 726.3 — Marks + surface + descriptions (code)
- New tool `runtime_mark(session_id, label)` → `controller.mark(label)`; stamps
  `trace_mark(run_id, cycle, label)`. Default tier.
- Tier: `runtime_mark` + the new trace-finalize tool (if separate) = default
  (they are part of the capture workflow). `runtime_run_scenario` stays advanced.
- Descriptions capability-first (no `Spec NNN`; Use-trigger + alternative
  pointer; e.g. `runtime_mark` "Not for querying marks — use
  trace_store_anchor_list").
- Update `tier-tools.ts` DEFAULT_TOOLS + `scripts/probe-tool-surface.mjs`
  (add the new tool(s) to the required-facade positive guard).

### 726.4 — Inventory + docs
- Refresh `docs/tool-surface-inventory.{md,json}`.
- Update the Murder `USECASE_trace_to_disasm.md` "gap" section → closed
  (capture path = `runtime_session_start trace_out` + `runtime_mark` +
  finalize). Note: the Murder doc lives in the project, update it there if asked.

## 5. Gates

```sh
npm run build:mcp
node scripts/probe-tool-surface.mjs
node scripts/probe-single-path.mjs
node scripts/smoke-trace-sink.mjs     # equivalence guard + capture→query (30/30)
node scripts/smoke-trace-binary.mjs   # 726.B binary log + rebuildable index (18/18)
node scripts/smoke-trace-perf.mjs     # 726.B §2a.1 perf budget (4/4)
```

Plus a small capture→query smoke (`scripts/smoke-trace-sink.mjs`): boot a
synthetic disk with `trace_out`, run a few hundred K cycles, `runtime_mark`,
finalize, then `runtime_query_events` / `trace_store_top_pcs` return rows from
the written `trace.duckdb`.

**No `runtime:proof`** — the trace observer is passive; no emulator behaviour
changes. (If wiring the observer into the run loop measurably changes timing,
that is a bug to fix, not a reason to run the 7-game gate.)

## 6. Acceptance

- A default-surface LLM can: `runtime_session_start(trace_out=…)` →
  `runtime_session_run`/`runtime_until` + `runtime_mark(...)` across phases →
  finalize → a `trace.duckdb` with `cpu_step` + bus + `trace_mark` rows.
- Offline (store-only, no live session): the convenience readers
  `trace_store_info`, `trace_store_top_pcs`, `trace_store_bus_find`,
  `trace_store_anchor_list`, `trace_store_anchor_find`, `runtime_query_events`,
  `runtime_swimlane_slice`, `runtime_trace_taint`, `runtime_follow_path` and
  `runtime_profile_loader` read the **same schema written by the 726 writer**.
  Raw `trace_store_query` working by itself is NOT acceptance.
- `disasm_prg` pass 2 can consume the executed-PC set as `entry_points[]` (the
  use-case payoff — measured separately in the project).
- **Trace does not influence the runtime (§2a):** the equivalence guard proves
  byte-identical final state (registers, cycles, drive clk, RAM hash) with vs
  without `trace_out`.
- **Trace V2 performance budget (§2a.1):** broad binary trace overhead is <= 10%
  versus trace-off; DuckDB index lag does not stall the emulator; no loss/drop.
- No new parallel trace path: capture reuses `TraceRunController` + the store.
- Default surface stays façade-first; `runtime_run_scenario` + `vice_trace_*`
  stay advanced. `probe-tool-surface` + `probe-single-path` GREEN.

## 6a. Mandatory Schema Alignment — No Reader/Writer Drift

The current DuckDB index schema is the source of truth for the shipped 726
reader tools:

```text
trace_run
trace_event(run_id, seq, cycle, channel, trigger_kind, capture_kind, data_json)
trace_mark(run_id, cycle, label)
```

All convenience readers must target that schema until 726.B replaces the hot
path with `.c64retrace` + rebuildable DuckDB indexes. They must not query old
Spec-217 tables such as `meta` or `instructions`.

Required reader behavior:

- `trace_store_info`: reads `trace_run`, counts `trace_event`, counts channels,
  counts `trace_mark`.
- `trace_store_top_pcs`: reads `trace_event WHERE channel='cpu'` and extracts
  PC from `data_json`.
- `trace_store_bus_find`: reads bus/access channels from `trace_event` and
  extracts address/value/op from `data_json`.
- `trace_store_anchor_list` / `trace_store_anchor_find`: read `trace_mark`.
- `runtime_query_events`: maps `family` to writer `channel`, then applies
  cycle/pc/addr filters through `trace_event.cycle` and `data_json`.
- Higher-level readers (`swimlane`, `taint`, `follow-path`, `profile-loader`)
  must either consume this schema directly or share the same adapter.

Acceptance store:

```text
/Users/alex/Development/C64/Cracking/Murder/traces/smoke/trace.duckdb
run_id = run_live-capture_mprewdk9
```

That store was produced by the live 726 trace sink and contains:

```text
trace_event, trace_mark, trace_run
```

No `meta`. No `instructions`.

Mandatory smoke:

```sh
node scripts/smoke-trace-store-writer-reader-e2e.mjs \
  /Users/alex/Development/C64/Cracking/Murder/traces/smoke/trace.duckdb \
  run_live-capture_mprewdk9
```

It must assert:

- `trace_store_info` succeeds and reports run/event/channel/mark counts.
- `trace_store_top_pcs cpu=c64` succeeds and returns top C64 PCs.
- `runtime_query_events family=cpu pc_start=$E5CD pc_end=$E5CD` returns at
  least one CPU event when the store contains that PC.
- No reader SQL references `meta` or `instructions`.
- `trace_store_query` is allowed as an escape hatch, but cannot be the only
  passing reader.

No workaround is accepted. Updating agent flows to raw SQL strings instead of
fixing wrappers is explicitly out of scope and fails this spec.

## 7. Open questions
- **OQ1** — finalize trigger: explicit `runtime_trace_finalize(session_id)` vs
  auto-flush on session stop vs incremental flush per `runtime_session_run`.
  Incremental append + a single close is simplest; decide in 726.1.
- **OQ2** — default trace domains: full (cpu_step+bus+iec+drive+vic+irq) is the
  use-case ask but is the heaviest. Allow `trace_domains` to narrow; pick a
  sensible default (cpu_step + bus + marks) in 726.2.
- **OQ3 — RESOLVED by the streaming writer:** no RAM cap, so long runs are
  bounded only by disk. Agent pacing (`until` + marks) is for query SCOPE, not a
  memory limit. Disk-size guard (warn/cap) can be a later option; not required.
- **OQ4** — drain backpressure tuning: queue depth + whether to expose a
  `fast`/`lossy` mode later. Default = block (lossless evidence). Settle in 726.2.

## 8. Prompt For Implementation Session

```text
Implement Spec 726 (headless trace sink + marks). Read the whole spec first,
especially §2a (hard invariant) and §2b (one-producer architecture).

NON-NEGOTIABLE:
- Trace must NOT influence the runtime. Same instruction sequence, same
  CPU/VIC/CIA/drive state, same cycle counts, with or without trace_out. The
  observer is passive; the async DuckDB drain runs only while the emulator is
  paused (between run-chunks, inside the I/O await).
- One production path only (§2b): runtime chips -> KernelTraceController channels
  -> ONE TraceRunController observer. The shipped 726 implementation streams to
  DuckDB; the corrected 726.B architecture must stream binary chunks to an
  append-only .c64retrace log and build DuckDB as a query index. Do NOT build a
  second trace path. Do NOT use the checkpoint ring as event history.
- Streaming, not buffer-then-flush: no 500k RAM cap, no end-of-run single flush,
  no silent truncation. Backpressure for evidence traces = block/slow only at
  the binary append boundary, never because DuckDB indexing is behind, never
  silent drop.
- Trace V2 is not complete without the §2a.1 performance gate: report trace-off
  throughput, trace-on throughput, overhead, PAL ratio, binary bytes written,
  DuckDB index lag and loss/drop count.

ORDER (guard-first — prove the invariant before wiring):
1. Build scripts/smoke-trace-sink.mjs FIRST. It runs the SAME scenario twice —
   with trace_out and without — and asserts byte-identical final state:
   PC/A/X/Y/SP/flags, cpu.cycles, drive clk, and a RAM hash. Run it against the
   CURRENT code with the producers (enableBusAccessTrace/traceIec/traceDrive)
   toggled to PROVE producer-enablement does not change emulation. If it
   diverges, that is the blocker to fix before anything else.
2. Decide streaming granularity. runtime_session_run uses a SYNCHRONOUS runFor
   that blocks the event loop, so a single long call cannot drain mid-run unless
   you CHUNK it: when a trace is active, run runFor in sub-chunks and
   `await ctrl.traceRun.drain()` between chunks. Chunking runFor(N) into
   k*runFor(N/k) must be behaviour-neutral (verify with the guard). The until/pc/
   raster paths: chunk their budget similarly or drain per-call. Pick + document.
3. Store streaming API (trace-run-store.ts): extract appendTraceEvents(store,
   runId, rows[]) (the batched trace_event INSERT) + writeTraceRunHeader(store,
   run, def) (trace_run + trace_mark, at stop). Keep writeTraceRun = header +
   append + marks for the scenario/test path.
4. TraceRunController (trace-run.ts): open the store at start(); observer
   enqueues into a bounded queue (NOT the unbounded events[]); drain() async
   batch-appends from the queue; stop() drains the remainder, writes the header,
   closes. Reuse the existing observer/trigger/capture logic unchanged.
5. MCP wiring: runtime_session_start gains trace_out (resolved .duckdb under the
   project) + trace_domains. When set: enable the matching producers at session
   construction (constraint #4: enableBusAccessTrace for memory, traceIec for
   iec, traceDrive for drive8-cpu); ensureRuntimeController(session); build a
   capture-def from trace_domains; ctrl.traceRun.start(def, {controller,
   outputPath}). runtime_session_run/until chunk + drain. Add runtime_mark
   (-> ctrl.traceRun.mark) and runtime_trace_finalize (-> ctrl.traceRun.stop;
   auto on session close). Optional runtime_trace_status (-> ctrl.traceRun.status).
6. tier-tools.ts: runtime_mark + runtime_trace_finalize (+ status) = default.
   probe-tool-surface: add them to the required-facade positive guard. Rewrite
   any new tool descriptions capability-first (no Spec NNN; Use-trigger +
   alternative pointer).
7. Refresh docs/tool-surface-inventory.{md,json}. Close the gap section in the
   Murder project docs/USECASE_trace_to_disasm.md (capture path now exists).

The binding point already exists: RuntimeController owns
`readonly traceRun = new TraceRunController()` (debug/runtime-controller.ts),
reachable via ensureRuntimeController(session_id, session)
(debug/runtime-controller.ts). The whole pipeline (channels, observer,
writeTraceRun, the trace_run/trace_event/trace_mark schema) exists — 726 reworks
the writer to stream and wires it to the live MCP surface.

GATES (no runtime:proof — passive observer):
   npm run build:mcp
   node scripts/smoke-trace-sink.mjs        # the equivalence guard + capture->query
   node scripts/probe-tool-surface.mjs
   node scripts/probe-single-path.mjs

Acceptance: a default-surface LLM (no C64RE_FULL_TOOLS, no WebSocket) can run
runtime_session_start(trace_out) -> session_run/until + runtime_mark across
phases -> finalize -> a trace.duckdb with cpu_step + bus + trace_mark rows;
offline trace_store_*/runtime_query_events return rows; the equivalence guard is
GREEN (trace did not influence the runtime). Report: new tools, default/full
counts, guard result.
```
