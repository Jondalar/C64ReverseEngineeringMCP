# Spec 217 - DuckDB trace store and zoomable runtime evidence

**Status:** DONE 2026-05-08 — `scripts/trace-store-query.mjs` provides DuckDB-backed SQL query CLI against `trace.duckdb` files. Used during motm investigation 2026-05-08 to query 6.4M bus events + 40M instructions across stage-1 window (commits 746097c, 903fb68). Stored traces under `samples/traces/v2-baseline/motm-spec218-hybrid60-headless-store-2026-05-08/`. master_clock + typed event-extras + parquet+duckdb tables all functional. Original ready-for-implementation 2026-05-07.
**Revision history:**
- v1 (2026-05-07): initial proposal
- v2 (2026-05-07): master-clock definition, typed event-extras (no
  `details_json`), backpressure policy, `schema_version` meta-table,
  Spike-A throughput target, rollup-level definition, diff output
  format, chip-event typed columns, retention policy, memory
  high-water target
- v3 (2026-05-07): drive `_clock_zero` + `drive_to_c64_offset`,
  post-hoc rollups only for Spike A/B/C, DuckDB ingestion path left
  to Spike-A evidence with fallback ladder
- final (2026-05-07): `schema_version=2` after master_clock semantic
  change, `drive_to_c64_offset` measurement procedure (VICE/headless),
  unknown-value encoding (`''`), `run_id` format spec, fallback
  ordering rule (highest-throughput passing, not first), throughput
  failure escape valve (halt + re-architect), `chip_events`
  provenance note (VICE=derived, headless=direct)
**Sprint:** TBD
**Depends on:** 205 trace contract, 123 event-indexed search, 124 VICE swimlane
**Supersedes for long runs:** JSONL-as-primary-storage in
- 011 (headless trace): per-event JSONL append in trace channels
- 122 (M5.1 trace registry): per-event JSONL channel mode
- 123 (event-indexed search): JSONL-scan-based index build
- 124 (VICE swimlane): JSONL-walked swimlane producer
- 205-A: trace channel `jsonl` mode for long captures (ring mode survives)

## Problem

Full VICE/headless traces from `LOAD"*",8,1` until "game running" are
too large for text JSONL. Even short full traces can be many GiB as
text. That makes the raw artifact slow to write, expensive to parse,
hard to index, and unsuitable for LLM workflows.

Observed scale reference: a motm VICE full trace of about 120 seconds
can produce roughly 15 GiB of JSONL. At that rate, JSONL full capture
is not merely inconvenient; it is the wrong architecture.

The desired workflow is still correct:

1. Capture the full run from a stable entry point to the target state.
2. Keep enough raw evidence to zoom into any later failure point.
3. Let agents query small, explainable windows.
4. Compare VICE and headless by C64 anchors, occurrence counts, bus
   events, and shared clock ranges.

The missing layer is a compact analytical trace store.

## Decision

Add DuckDB to the C64RE stack for runtime trace analytics.

Use DuckDB for local analytical queries and Parquet/ZSTD for large
trace partitions. Keep JSONL as an export/debug compatibility format,
not as the primary persisted representation for long full traces.

Do not write SQL, Parquet, JSONL, or `JSON.stringify` from the emulator
hot path. Runtime code may only append compact events to memory-backed
chunk buffers. Persistence happens asynchronously or at controlled flush
points through a trace sink.

DuckDB is embedded and local, like SQLite from an operations
perspective, but optimized for analytical scans and columnar data. It
can read and write Parquet directly, including compressed Parquet.

### Node client

Use the current DuckDB Node client stack during the spike:

- Preferred app-level package: `@duckdb/node-api`
- Avoid new code built on the deprecated legacy `duckdb` npm package
  unless the spike proves `@duckdb/node-api` unusable in this repo.

### Storage shape

Each runtime capture writes one trace directory:

```text
analysis/runtime/<session-id>/trace/
  trace.duckdb                  # optional catalog/cache DB
  instructions.parquet          # full CPU instruction stream
  bus-events.parquet            # DD00, 1800, memory/io accesses
  chip-events.parquet           # irq, cia, via, vic, gcr, iec edges
  anchors.parquet               # named anchors + occurrence counts
  rollups.parquet               # zoom-out windows
  summary.json                  # small human/tool summary
```

The first implementation may use only `trace.duckdb` tables if that is
faster to land. The target shape is Parquet as durable data plus DuckDB
views for querying.

### `run_id` and `session-id` format

`run_id` (column in every table) equals the existing
`<session-id>` from `analysis/runtime/<session-id>/`. Format:

```
YYYYMMDDTHHMMSSZ-<8-hex-random>     # e.g. 20260507T072742Z-69a53baa
```

UTC timestamp at ms precision plus 8-hex random suffix = collision-free
for >1 capture/sec on the same machine. Format is stable across the
existing VICE session-manager + headless capture scripts.

## Master-clock Definition

`master_clock` is the cross-source comparison anchor. Defined as
**c64-PAL-cycles since the run's declared clock-zero** (985_248 Hz
reference).

| source / cpu | formula |
|---|---|
| VICE c64 | `master_clock = vice_c64_clock - vice_c64_clock_zero` |
| VICE drive (1 MHz) | `master_clock = round((vice_drive_clock - vice_drive_clock_zero) × 985248 / 1000000) + drive_to_c64_offset` |
| headless c64 | `master_clock = headless_c64_cycles - headless_c64_clock_zero` |
| headless drive | `master_clock = round((headless_drive_cycles - headless_drive_clock_zero) × 985248 / 1000000) + drive_to_c64_offset` |

Mapping done by the producer at append time, not by the writer or
query layer. Producers without a known mapping must set
`master_clock = NULL` and document why in `summary.json`.

The producer must persist clock-zero metadata. C64 and drive clocks do
not have to share the same native zero point. Drive events must be
aligned through an explicit `drive_to_c64_offset` in master-clock
cycles. For a cold-reset capture this offset is normally `0`; for
captures attached after reset, resumed from snapshot, or assembled
from monitor history, it must be measured or declared unknown.

### `drive_to_c64_offset` measurement

| source | procedure |
|---|---|
| VICE | At the **first** sample where both clocks come back from a single `getRegisters` round-trip: `drive_to_c64_offset = vice_c64_clock - round(vice_drive_clock × 985248 / 1000000)`. Stored in meta at session-start. |
| headless | Producer asserts c64 and drive share a single zero-point at cold-reset; offset = `0`. Resume-from-snapshot must compute and persist offset before first event append. |
| derived/imported | If neither clock pair is observable at the same moment, set `drive_to_c64_offset = ''` (empty string = unknown). Diff queries will refuse to align drive events when offset is unknown. |

### Encoding of unknown values in `meta.value`

`meta.value` is `TEXT NOT NULL`. Unknown bigint/integer values are
encoded as the **empty string `''`**. Readers parse non-empty values
with `BigInt`/`Number` and treat `''` as `undefined` (or SQL `NULL`
when projected into typed columns). No mixing of literal `null`
strings, JSON nulls, or sentinel numbers.

Anchor occurrence-N matching across sources uses `master_clock`,
with a tolerance window declared per query (default ±256 cycles).

## Schema Version

Every trace store carries a `meta` table from day 1:

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES
  ('schema_version', '2'),
  ('writer_version', '<git sha>'),
  ('captured_at', '<iso8601>'),
  ('source', 'vice|headless'),
  ('c64_clock_hz', '985248'),
  ('drive_clock_hz', '1000000'),
  ('c64_clock_zero', '<ubigint>'),
  ('drive_clock_zero', '<ubigint>'),
  ('drive_to_c64_offset', '<bigint master-clock cycles>');
```

Empty string `''` for any of `c64_clock_zero`, `drive_clock_zero`,
`drive_to_c64_offset` means **unknown**.

Schema-version bump rules:
- additive column = no version bump (readers ignore unknown columns)
- breaking column rename / type change = bump version + writer rejects
  reads of newer schema with a clear migration message
- **semantic change to an existing column** (even without a structural
  rename) bumps the version. v1 stored absolute clocks in
  `master_clock`; v2 stores relative-to-zero clocks. Readers must check
  `schema_version` before interpreting `master_clock`.

## Canonical Tables

### `instructions`

One row per CPU instruction boundary.

| column | type | note |
|---|---|---|
| `run_id` | text | session id |
| `seq` | ubigint | monotonically increasing per stream |
| `cpu` | text | `c64` or `drive8` |
| `clock` | ubigint | CPU-local clock from source |
| `master_clock` | ubigint | normalized comparison clock when known |
| `pc` | usmallint | program counter |
| `opcode` | utinyint | first instruction byte |
| `b1` | utinyint | operand byte 1 or null |
| `b2` | utinyint | operand byte 2 or null |
| `a` | utinyint | accumulator |
| `x` | utinyint | X |
| `y` | utinyint | Y |
| `sp` | utinyint | stack pointer |
| `p` | utinyint | status flags |
| `source` | text | `vice` or `headless` |

### `bus_events`

One row per relevant bus/memory event. **No `details_json` column.**
Hot path must not stringify; sparse extras live in `bus_event_extras`
side-table.

| column | type | note |
|---|---|---|
| `run_id` | text | session id |
| `seq` | ubigint | event sequence (producer-assigned, monotonic per stream) |
| `cpu` | text | `c64` or `drive8` — side that caused the event |
| `clock` | ubigint | source clock |
| `master_clock` | ubigint | normalized comparison clock (see Master-clock) |
| `pc` | usmallint | PC at event if known |
| `kind` | text | `read`, `write`, `line_change`, `irq_assert`, `irq_clear`, `irq_service`, `gcr_byte_ready`, `gcr_sync`, `motor`, `density`, `head_step` |
| `addr` | usmallint | address if memory/io event, NULL otherwise |
| `value` | utinyint | value if applicable, NULL otherwise |
| `old_value` | utinyint | previous value if applicable, NULL otherwise |
| `line_atn` | boolean | decoded IEC ATN line state (NULL if not an IEC event) |
| `line_clk` | boolean | decoded IEC CLK line state |
| `line_data` | boolean | decoded IEC DATA line state |
| `source` | text | `vice` or `headless` |

### `bus_event_extras`

Sparse key/value side-table for extras that don't fit typed columns.
Producers append at most a handful of rows per parent event. Hot-path
appends already-encoded `key`/`value` strings — no JSON serialization.

| column | type | note |
|---|---|---|
| `run_id` | text | session id |
| `parent_seq` | ubigint | foreign key to `bus_events.seq` |
| `key` | text | e.g. `cia_pra`, `cia_prb`, `via_ifr`, `gcr_zone` |
| `value` | text | already-formatted (`"$43"`, `"3"`, `"true"`) |

### `chip_events`

For IRQ/timer/chip edge data that is not naturally a bus access.
**No `details_json` here either.** Same `chip_event_extras` side-table
pattern.

| column | type | note |
|---|---|---|
| `run_id` | text | session id |
| `seq` | ubigint | event sequence (producer-assigned, monotonic per stream) |
| `cpu` | text | `c64` or `drive8` |
| `clock` | ubigint | source clock |
| `master_clock` | ubigint | normalized clock |
| `pc` | usmallint | PC at event if known |
| `chip` | text | `cia1`, `cia2`, `via1`, `via2`, `vic`, `gcr` |
| `kind` | text | `timer_underflow`, `timer_reload`, `irq_assert`, `irq_clear`, `irq_service`, `ifr_set`, `ifr_clear`, `ier_write`, `raster_line`, `frame_start`, `motor`, `density`, `head_step`, `byte_ready`, `sync_edge` |
| `unit` | utinyint | sub-unit (0=T1, 1=T2 for timers; raster line; etc.) — meaning depends on `kind` |
| `value` | utinyint | new value if applicable |
| `old_value` | utinyint | previous value if applicable |
| `source` | text | `vice` or `headless` |

`chip_event_extras (run_id, parent_seq, key, value)` mirrors bus_event_extras.

### Provenance — VICE vs headless

`chip_events` from VICE are **producer-derived** signals: VICE binmon
does not emit raw IRQ-line transitions or VIA timer-underflow events.
The VICE producer must synthesize them by inspecting cpuhistory
(PC at IRQ vector entry, CIA/VIA register reads/writes), and may
miss events that fall between cpuhistory bursts.

`chip_events` from headless are **direct chip-side emissions** from the
emulator's chip backends (Spec 203 IRQ ring, Spec 205-A trace channels)
and are exhaustive at chip-emit granularity.

Diff queries comparing VICE and headless `chip_events` must annotate
provenance and not silently equate counts. `trace_diff` reports flag
this as `provenance: vice=derived, headless=direct`.

Required first event families:

- VIA1/VIA2 IFR set/clear (`chip='via1'|'via2'`, `kind='ifr_set'|'ifr_clear'`, `value=ifr_byte`)
- VIA1/VIA2 IER writes (`kind='ier_write'`, `value=new_ier`)
- VIA1/VIA2 Timer A/B underflow/reload (`kind='timer_underflow'|'timer_reload'`, `unit=0|1`)
- drive IRQ assert/clear/service (`kind='irq_assert'|'irq_clear'|'irq_service'`)
- CIA IRQ assert/clear/service
- IEC ATN/CLK/DATA line changes (also in `bus_events` with `line_*` cols; chip-side captures the cause)
- GCR byte-ready/SYNC/motor/head/density changes
- VIC raster/frame transitions (`chip='vic'`, `kind='raster_line'`, `unit=raster`, or `kind='frame_start'`)

### `anchors`

Anchors are the bridge between VICE and headless.

| column | type | note |
|---|---|---|
| `run_id` | text | session id |
| `source` | text | `vice` or `headless` |
| `cpu` | text | `c64` or `drive8` |
| `name` | text | semantic name |
| `pc` | usmallint | address |
| `occurrence` | ubigint | Nth visit to that PC/name |
| `clock` | ubigint | source clock |
| `seq` | ubigint | instruction/event sequence |

Default motm anchors:

- `ab_entry` = C64 `$4000`
- `bitbang_tx_24bit` = C64 `$425C`
- `bitbang_tx_inner` = C64 `$4294`
- `rx_wait` = C64 `$43C7`
- `rx_byte` = C64 `$43CF`
- `wait_loader_completion` = C64 `$4370`
- `game_handoff` = C64 `$F500`
- `drive_rx_wait` = drive `$07BE`
- `drive_rx_active` = drive `$0714`
- `drive_rom_idle` = drive `$F55D/$F560`

### `rollups`

Precomputed zoom-out windows. **Levels are concrete and fixed:**

| level | window size | rationale |
|---|---|---|
| 0 | 100_000 master-clocks (~100ms PAL) | tight zoom for byte-level analysis |
| 1 | 1_000_000 (~1s) | second-scale phase detection |
| 2 | 10_000_000 (~10s) | scene-scale (KERNAL load, fastloader install) |
| 3 | 100_000_000 (~100s) | full-run overview |

Rollups are built **post-hoc** by `RollupBuilder` reading the persisted
instruction/event tables. Producers do not maintain rollup aggregators
and do not write rollup rows during capture. This keeps the hot path
limited to chunk-buffer appends.

Future live/streaming rollups may be added later as a separate feature,
but they are out of scope for Spike A/B/C.

JSON columns are allowed here because rollups are query-output
artifacts, not hot-path capture rows.

| column | type | note |
|---|---|---|
| `run_id` | text | session id |
| `source` | text | `vice` or `headless` |
| `level` | utinyint | 0..3 (see table above) |
| `window_index` | ubigint | floor(master_clock / window_size) |
| `clock_start` | ubigint | inclusive (= window_index × window_size) |
| `clock_end` | ubigint | exclusive |
| `cpu` | text | `c64` or `drive8` |
| `top_pcs_json` | json | `[{pc, count}, ...]` top 16 |
| `bus_counts_json` | json | `{addr_kind: count, ...}` |
| `irq_counts_json` | json | `{kind: count, ...}` per chip |
| `phase` | text | optional detected phase tag (e.g. `kernal_load`, `fastloader_install`, `fastloader_rx`) |

## Trace Writer Pipeline

The existing trace registry/ring-buffer idea remains useful for live
inspection and bounded debug windows, but it is not sufficient for
multi-minute full capture. Spec 217 introduces a writer pipeline:

```text
runtime / VICE monitor
  -> TraceEventProducer
  -> channel-specific TraceChunkBuffer
  -> TraceWriterQueue
  -> TraceSink
  -> DuckDB / Parquet
  -> AnchorBuilder + RollupBuilder
  -> LLM zoom exports
```

### Hot-path rule

The emulator/monitor hot path must only do cheap appends:

```ts
trace.publishCpuInstruction(side, pc, opcode, regs, clock);
trace.publishBusEvent(side, addr, access, value, pc, clock);
```

Those calls append into typed or packed chunk buffers. They must not:

- allocate large per-event object graphs in tight loops
- stringify JSON
- execute SQL
- write files per event
- block on DuckDB/Parquet I/O

### Chunk buffers

Instruction-heavy channels should use column-oriented chunks from the
start:

```ts
interface InstructionChunk {
  source: "headless" | "vice";
  cpu: "c64" | "drive8";
  count: number;
  seq: BigUint64Array;
  clock: BigUint64Array;
  masterClock: BigUint64Array;
  pc: Uint16Array;
  opcode: Uint8Array;
  b1: Uint8Array;
  b2: Uint8Array;
  a: Uint8Array;
  x: Uint8Array;
  y: Uint8Array;
  sp: Uint8Array;
  p: Uint8Array;
}
```

Bus/chip events may start as compact struct arrays if sparse enough,
but should still flush in batches.

Initial chunk target: 64 Ki to 1 Mi rows per instruction chunk, tuned
by smoke performance. The chunk size is an implementation parameter,
not a schema contract.

### Writer queue

`TraceWriterQueue` owns backpressure policy:

- bounded in-memory queue (default capacity: 4 chunks, ~256 MiB worst-case
  for 1M-row instruction chunks)
- **producer BLOCKS when queue is full** — no silent drop, no async
  discard
- producer-stall is measured + reported via `trace_writer_stats`
  (`stall_total_ms`, `stall_event_count`, `chunks_dropped` always
  zero unless explicit `--allow-drop` flag passed)
- explicit flush on session stop
- summary reports any drop events (must be zero by default)

For headless, writer flush may be synchronous at chunk boundaries in
the first spike if performance is acceptable. For VICE long captures,
the design should assume a background writer or a producer/consumer
loop so monitor capture is not dominated by disk writes.

### Memory high-water target

In-memory chunk-buffer aggregate must stay below **512 MiB resident**
during steady-state capture. With 1M-row instruction chunks at ~12B/row
(packed typed arrays) and 4-chunk queue depth = ~50 MiB instructions
+ scratch for bus/chip events. If a chunk doesn't flush within the
queue limit, producer blocks — keeps RSS bounded.

### Parquet write strategy

Chunks DO NOT each become a separate parquet file (would explode
small-file count and kill compression).

Strategy:

1. Hot path appends to typed-array chunks (RAM only).
2. `TraceSink` flushes chunks into a session-local `trace.duckdb`
   table through the fastest ingestion path proven by Spike A. Preferred
   target: DuckDB Appender or Arrow/record-batch ingestion without
   per-row SQL and without JSON stringify.
3. If the preferred path is unavailable in `@duckdb/node-api`, Spike A
   evaluates the fallback paths below in order and selects the
   **highest-throughput option that meets acceptance**, not the first
   one that scrapes by:
   - DuckDB Appender with per-row binding
   - Arrow/IPC batch files imported by DuckDB
   - Temporary uncompressed Parquet chunk files imported/compacted by
     DuckDB
   - Batched `INSERT` (last resort)

   All paths must meet the DuckDb-sink throughput acceptance
   (≥500K instr-row appends/sec). **If no path meets the target,
   halt Spike A and re-architect — do not silently lower the
   target.**
4. At session-close (or on `--compact-now` flag), DuckDB
   `COPY ... TO '<table>.parquet' (FORMAT PARQUET, COMPRESSION ZSTD,
   ROW_GROUP_SIZE 1_000_000)` writes one parquet file per table.
5. After successful parquet write, `trace.duckdb` may be deleted to
   save disk; or kept as catalog/cache (config flag).

This keeps:
- one duckdb file (intermediate, RAM/disk-cheap append target)
- one parquet file per table (final, ZSTD-compressed columnar)
- no per-chunk small-file proliferation

### Sinks

Define a small sink interface:

```ts
interface TraceSink {
  writeInstructionChunk(chunk: InstructionChunk): Promise<void>;
  writeBusEventChunk(chunk: BusEventChunk): Promise<void>;
  writeChipEventChunk(chunk: ChipEventChunk): Promise<void>;
  close(): Promise<TraceSinkSummary>;
}
```

Required sinks:

- `DuckDbTraceSink` - primary sink; writes DuckDB tables and/or Parquet
  files.
- `JsonlTraceSink` - compatibility/window export only.
- `NullTraceSink` - smoke/performance baseline.

### Index and rollup builders

Anchors and rollups are built from the stored tables, not by scraping
raw JSONL:

```text
DuckDB/Parquet -> AnchorBuilder -> anchors.parquet
DuckDB/Parquet -> RollupBuilder -> rollups.parquet
DuckDB/Parquet -> CadenceReporter -> markdown/json reports
```

This makes zoom-out and LLM windows reproducible even when the raw full
trace is too large for direct inspection.

## Spike A - Bring DuckDB into the C64RE stack

Goal: prove dependency, local query, and Parquet write/read in this
TypeScript repo.

Deliverables:

- Add DuckDB dependency behind a small adapter module.
- New module: `src/runtime/trace-store/duckdb-store.ts`
- New module: `src/runtime/trace-store/chunk-buffer.ts`
- New module: `src/runtime/trace-store/trace-sink.ts`
- New CLI: `scripts/trace-store-smoke.mjs`
- Smoke writes a synthetic instruction table and bus event table,
  exports ZSTD Parquet, queries it back through DuckDB, and validates
  counts/filters.
- Document install caveats in `docs/tools/headless.md` or a new
  `docs/runtime-trace-store.md`.

Acceptance:

- `npm run build:mcp` passes.
- New smoke command passes on macOS arm64.
- Smoke proves the hot path appends to chunks and the sink writes
  batches, not one DB/JSON operation per event.
- **Throughput target: ≥1M instruction-row appends per second**
  measured on `NullTraceSink` (= raw chunk-buffer ingest rate; matches
  ~1× PAL realtime headless throughput). Stretch: ≥10M/sec batched (=
  ~10× warp).
- **DuckDB-sink throughput target: ≥500K instruction-row appends per
  second** including DuckDB Appender overhead (allows real-time
  capture with headroom).
- Producer-stall counter exposed in `trace_writer_stats`. Smoke run
  reports stall total in console output.

```sql
select pc, count(*)
from instructions
where cpu = 'c64'
group by pc
order by count(*) desc
limit 20;
```

```sql
select *
from bus_events
where addr in (0xdd00, 0x1800)
order by master_clock
limit 100;
```

Out of scope:

- VICE capture changes.
- Headless runtime integration.

## Spike B - Headless runtime PoC

Goal: capture a bounded headless run into the new store without JSONL
as primary output.

Scope:

- Source: existing kernel trace registry from Spec 205.
- Scenario: short true-drive KERNAL LOAD smoke plus a synthetic motm
  window if available.
- Write `instructions`, `bus_events`, `chip_events`, `anchors`, and
  `rollups`.
- Preserve the existing ring buffer for live use; add chunk-buffer
  capture for full persisted traces.

Deliverables:

- New CLI: `scripts/headless-trace-store-capture.mjs`
- New query CLI: `scripts/trace-store-query.mjs`
- Existing JSONL channels remain available but are not required.
- Register generated `.duckdb` / `.parquet` artifacts in the knowledge
  layer with roles:
  - `runtime-trace-store`
  - `runtime-trace-parquet`
  - `runtime-trace-index`
  - `runtime-trace-rollup`

Acceptance:

- Capture does not emit per-instruction JSONL unless `--jsonl-export`
  is explicitly passed.
- Runtime trace publication does not call `JSON.stringify`, direct fs
  writes, or DuckDB APIs from per-instruction hot path.
- Query by C64 PC returns occurrence counts.
- Query by `$DD00` returns event windows.
- `trace_zoom --anchor rx_wait --occurrence N --before 200 --after 200`
  emits a small markdown/JSON swimlane.
- `trace_transaction_swimlane --anchor <name> --occurrence N` emits
  a transaction-by-transaction view that joins CPU instructions,
  IO access, resolved bus line state, opposite-side IO observation,
  and follow-up CPU branch/state change on one shared clock.
- File size is materially smaller than equivalent JSONL. First target:
  at least 5x smaller for instruction-heavy traces. For the observed
  motm 120s case (~15 GiB JSONL), first target is below 3 GiB and
  stretch target is below 1.5 GiB.

Out of scope:

- Full motm fix.
- Full UI timeline.

## Spike C - VICE runtime trace PoC

Goal: write VICE CPU history and monitor/bus samples into the same
DuckDB/Parquet schema.

Scope:

- Start from `scripts/vice-180s-baseline.mjs` and
  `scripts/vice-runtime-trace-motm.mjs`.
- Preserve existing sparse VICE baseline outputs during spike.
- Add `--store duckdb` or a new store capture script.
- Treat VICE CPU history bursts as producer chunks. Do not expand them
  into JSONL and re-import them.

Deliverables:

- New CLI: `scripts/vice-trace-store-capture.mjs`
- VICE C64 CPU history -> `instructions(cpu='c64', source='vice')`
- VICE drive CPU history -> `instructions(cpu='drive8', source='vice')`
- Monitor reads for `$DD00`, `$1800`, `$180D`, `$180E`, `$1C00`,
  `$1C04-$1C07` -> `bus_events` / `chip_events`
- Anchor builder for motm `ab.prg` PCs.
- Rollup builder for PC histograms and IRQ/timer cadence.

Acceptance:

- Can capture from `LOAD"*",8,1` to observed game-running state or
  bounded emulated seconds.
- Can capture the 120s motm case without producing a full JSONL file.
- Can answer:
  - top C64 PCs per time window
  - top drive PCs per time window
  - `$43C7 -> $43CF` escape occurrence windows
  - drive ROM excursion cadence
  - `$DD00` and `$1800` values around a window
- Exports a small LLM-readable swimlane for one anchor occurrence.

Out of scope:

- Perfect VICE internals without monitor support.
- Replacing binary monitor transport.

## Migration Plan

### Phase 0 - Freeze current JSONL behavior

- Keep all current JSONL tools working.
- Mark JSONL long-run full traces as legacy/compat in docs.
- Add warnings to long-run full-trace scripts when output is JSONL.
- Add a hard warning when estimated JSONL output is likely to exceed
  1 GiB. The warning must point to trace-store capture.

### Phase 1 - Store adapter and headless PoC

- Implement Spike A.
- Implement Spike B.
- Wire chunk-buffer capture behind the existing trace registry without
  breaking ring-buffer live inspection.
- Make `headless_trace_*` tools able to read either JSONL or trace
  store based on artifact role/path.

### Phase 2 - VICE store PoC

- Implement Spike C.
- Add one motm VICE baseline capture in trace-store format.
- Add comparison query scripts for H4' cadence analysis:
  - RX iterations/sec around `$43CF`
  - drive ROM excursions/sec
  - VIA timer/IRQ event cadence
  - `$031A/$031B/$031D` sampled values if available

### Phase 3 - Replace primary capture paths

- `headless-runtime-trace.mjs` writes trace store by default.
- `vice-runtime-trace-motm.mjs` writes trace store by default.
- Full JSONL is not a default mode. JSONL is opt-in only for bounded
  exports:
  - `--jsonl-export-window`
  - `--jsonl-export-anchor <name>:<occurrence>`
  - `--jsonl-export-max-rows <n>`
- Knowledge registration prefers trace-store artifacts over raw JSONL.

### Phase 4 - UI timeline and LLM zoom

- Workspace UI consumes rollups for zoom-out.
- Transaction swimlane is a first-class zoom mode for LLM and human
  reverse-engineering work. It must show causality, not just adjacent
  rows: CPU instruction -> IO write/read -> resolved bus/chip state ->
  opposite-side IO read/write -> following CPU branch/state.
- Timeline lanes:
  - C64 PC/routine phase
  - Drive PC/routine phase
  - `$DD00` / `$1800`
  - IEC lines
  - IRQ/timer events
  - GCR motor/head/sync/data
- Clicking a rollup window calls `trace_zoom_window`.
- Deep zoom renders swimlane rows.
- Transaction zoom can be scoped by anchor/occurrence, PC range, IO
  address, bus-line edge, or "first divergence vs VICE".

### Phase 5 - Deprecate duplicate tools

- Keep old scripts for replaying historical artifacts.
- New work uses trace-store tools.
- Remove or archive duplicate scripts only after all CI/smokes and docs
  are migrated.

## Tool Mapping

### Existing headless tools

| Current tool/script | Keep | New capability |
|---|---:|---|
| `headless_trace_tail` | yes | read last rows from store or JSONL |
| `headless_trace_find_pc` | yes | query `instructions where cpu=? and pc=?` |
| `headless_trace_find_access` | yes | query `bus_events where addr=?` |
| `headless_trace_slice` | yes | resolve seq/window from store |
| `headless_trace_build_index` | replace internals | build anchors/rollups in store |
| `scripts/headless-runtime-trace.mjs` | migrate | default trace store, optional JSONL export |
| `scripts/headless-full-trace.mjs` | merge/archive later | superseded by store capture |
| `scripts/headless-swimlane-capture.mjs` | keep temporarily | producer of small debug windows; later backed by store |
| `scripts/bus-trace-motm.mjs` | migrate | `bus_events` channel query/export |

### Existing VICE tools

| Current tool/script | Keep | New capability |
|---|---:|---|
| `vice_trace_build_index` | migrate | build store anchors/rollups |
| `vice_trace_zoom_overview` | keep | query `rollups` |
| `vice_trace_zoom_window` | keep | query instructions/events around window |
| `scripts/vice-180s-baseline.mjs` | migrate | write store baseline; JSONL optional |
| `scripts/vice-runtime-trace-motm.mjs` | migrate | write VICE store session |
| `scripts/vice-iec-capture.mjs` | keep temporarily | small targeted bus/swimlane export |

### Diff and swimlane tools

| Current tool/script | Keep | New capability |
|---|---:|---|
| `scripts/diff-trace.mjs` | migrate | compare store-backed event windows |
| `scripts/runtime-trace-diff.mjs` | migrate/archive | use anchor+occurrence store queries |
| `scripts/swimlane-diff.mjs` | keep | accept store window exports |
| `scripts/swimlane-diff-v2.mjs` | merge later | single canonical swimlane command |
| `scripts/swimlane-full-diff.mjs` | archive after migration | full JSONL diff replaced by store queries |
| `scripts/lib/trace-diff.mjs` | keep | add trace-store reader |

### New tools

| New tool/script | Purpose |
|---|---|
| `trace_store_info` | summarize available tables, row counts, time ranges |
| `trace_store_query` | restricted SQL/query presets for agents |
| `trace_anchor_find` | list anchors and occurrence counts |
| `trace_zoom_window` | export LLM-sized swimlane around anchor/window |
| `trace_transaction_swimlane` | side-by-side CPU/IO/bus transaction view for step-by-step analysis |
| `trace_first_divergence` | find first mismatching transaction between VICE and headless after an anchor |
| `trace_cadence_report` | compare rates for PC ranges, IRQs, bus events |
| `trace_export_jsonl` | explicit compatibility export |
| `trace_export_markdown` | small report artifact for findings/specs |
| `trace_writer_stats` | chunk counts, write throughput, dropped data, compression ratio |

## Query Presets

### PC occurrence lookup

```sql
select occurrence, clock, seq
from anchors
where source = 'vice'
  and cpu = 'c64'
  and name = 'rx_wait'
order by occurrence;
```

### Motm receive throughput

```sql
select
  floor(clock / 1000000) as mcycle,
  count(*) as rx_instr
from instructions
where source = ?
  and cpu = 'c64'
  and pc between 0x43cf and 0x43f1
group by 1
order by 1;
```

### Drive ROM excursion cadence

```sql
select
  floor(clock / 1000000) as mcycle,
  count(*) as rom_instr
from instructions
where source = ?
  and cpu = 'drive8'
  and pc >= 0xf000
group by 1
order by 1;
```

### VIA timer/IRQ activity

```sql
select kind, chip, count(*)
from chip_events
where source = ?
  and kind in ('timer_underflow', 'irq_assert', 'irq_service')
group by 1, 2
order by 3 desc;
```

## Diff Output Format

When comparing VICE vs headless captures, `trace_diff` produces a
small markdown report plus a parquet annotations table.

### Markdown report (LLM-readable)

```markdown
# Trace diff: motm 2026-05-07

Anchor: `rx_wait` (c64 PC=$43C7)

| metric | VICE | headless | delta |
|---|---:|---:|---:|
| total occurrences | 1247 |  893 | -354 (-28%) |
| occurrences before master_clock=50_000_000 | 412 | 401 | -11 |
| max-Y at first occurrence | 0x30 | 0x30 | 0 |
| avg cycles in loop per occurrence | 240 | 268 | +28 (+12%) |

## Cadence comparison: $43CF rx-iterations / Mc

| Mc-window | VICE | headless | delta |
|---:|---:|---:|---:|
| 30 | 18 | 18 | 0 |
| 31 | 145 |  98 | -47 |
| 32 | 312 | 156 | -156 |
...

## First divergence

Anchor `rx_wait` occurrence 412:
- VICE master_clock = 50_103_456, c64 Y = 0x18, drvPC = $07C1
- headless master_clock = 50_098_211, c64 Y = 0x1A, drvPC = $07BE
- Δ master_clock = -5245 cyc (within tolerance ±256 → MATCH)
- Δ Y = +2

Anchor `rx_wait` occurrence 413:
- VICE master_clock = 50_198_912, ...
- headless master_clock = 51_002_445 ...
- Δ master_clock = +803_533 (OUT-of-tolerance → DIVERGENCE)
- root analyzed in: chip_events between 50_198_912 and 51_002_445
- VICE: 47 IRQ assertions, 12 timer underflows, 8 byte_ready edges
- headless: 31 IRQ assertions, 8 timer underflows, 5 byte_ready edges
- delta: -16 IRQ, -4 timer, -3 byte_ready
```

### Annotations parquet (queryable)

```sql
CREATE TABLE diff_annotations (
  diff_id     TEXT,           -- vice_run_id + '_vs_' + headless_run_id
  anchor      TEXT,
  occurrence  UBIGINT,
  status      TEXT,           -- 'match', 'within_tolerance', 'divergence'
  vice_clock  UBIGINT,
  hl_clock    UBIGINT,
  delta_clock BIGINT,
  notes       TEXT
);
```

## Retention Policy

Trace artifacts are large; default retention:

- Per-game baseline: keep **most recent 2 captures** in
  `samples/traces/v2-baseline/<game>-<source>-<date>/`
- Older captures: archive script `scripts/trace-store-archive.mjs`
  moves to `samples/traces/archive/` and emits a manifest entry.
  Manual cleanup only — never auto-delete.
- Knowledge layer registers the **current** baseline as canonical;
  prior baselines marked `superseded`.
- `.gitignore` covers `samples/traces/**` (already in place via
  `samples/*` rule).

## Acceptance for Spec 217

- DuckDB is available through a repo-local adapter.
- Trace capture uses chunk buffers and batch sinks; no per-event DB or
  JSONL writes in the runtime hot path.
- Headless PoC writes and queries trace-store artifacts.
- VICE PoC writes and queries trace-store artifacts.
- A motm bug analysis can be produced without opening multi-GiB JSONL:
  - find `$43C7` occurrence windows
  - compare VICE/headless RX cadence
  - compare drive ROM excursion cadence
  - compare VIA timer/IRQ cadence
- Existing user-facing trace tools either still work or have an
  explicit migration note.
- JSONL remains possible for small windows and compatibility exports.
- The 120s motm full trace case is captured without full JSONL output.

## Risks

- Native Node package friction on macOS/CI. Mitigation: isolate behind
  adapter; fallback to DuckDB CLI for spike if package install fails.
- **Bundle-size impact:** `@duckdb/node-api` native binaries add
  ~50 MiB to the install footprint. Acceptable for a developer CLI;
  for MCP-server distribution we keep DuckDB optional behind a
  dynamic-import adapter so users without trace-store needs don't pull it.
- Over-modeling schema too early. Mitigation: first spike uses only
  instructions + bus_events tables, then adds chip/rollup later.
- Writer throughput below producer throughput. Mitigation: bounded
  queue, **producer blocks (no drop)**, large chunks, NullTraceSink
  baseline, writer stats, no silent data loss by default.
- Raw VICE monitor cannot expose every chip event cheaply. Mitigation:
  store what VICE can provide directly; derive rollups from sampled CPU
  history and targeted monitor reads.
- Parquet partition count explosion. Mitigation: one file per table per
  run for spike; partition later only if needed.
- **DuckDB Appender API binding mismatch:** `@duckdb/node-api` may not
  expose typed-array bindings as cleanly as the C/Python clients.
  Mitigation: Spike A specifically validates Appender perf with typed
  arrays; if API is missing, fall back to `INSERT INTO ... SELECT * FROM
  read_parquet(...)` with chunk-files (last resort, tolerates ~3×
  perf hit).

## Non-goals

- Replacing the project knowledge store.
- Running DuckDB as a server.
- Real-time UI streaming in the first spike.
- Deleting historical JSONL traces.

## References

- DuckDB official client overview: DuckDB is an in-process database
  with Node.js clients.
- DuckDB Node.js Neo client: `@duckdb/node-api` is the current
  high-level Node API.
- DuckDB Parquet docs: DuckDB reads/writes Parquet and supports
  compressed Parquet output, including ZSTD.
