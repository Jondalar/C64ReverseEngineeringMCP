# Bug: trace-store reads fail while the daemon process is live (DuckDB cross-process lock)

- **ID:** BUG-029
- **Date:** 2026-06-01
- **Reporter:** llm
- **Area:** trace-store / runtime daemon
- **Severity:** medium
- **Status:** open <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: master (post Spec 746.1/.2/.3 live-trace wiring)
- Surface: MCP + standalone runtime daemon (`ws://127.0.0.1:4312`) + a finalized trace store
- Tool / endpoint: `runtime_swimlane_slice` / `runtime_query_events` / `trace_store_*`
- Session: `integrated-1` (shared daemon session)

## What happened

After `runtime_trace_finalize` writes a `trace.duckdb`, an MCP tool that reads that
store (`runtime_swimlane_slice`, `trace_store_query`, …) fails with:

```
IO Error: Could not set lock on <trace.duckdb>
```

…as long as the **daemon process is still running**. The daemon (which wrote the
store via `indexBinaryLog`) closes its own store handle in `closeTraceRunStore`
(finally), but a separate reader PROCESS (the MCP / a tool) still cannot open the
file. Once the daemon process EXITS, the same store opens + reads fine (read-only,
all 1.5M events visible).

So: the live-trace pipeline (746) captures + finalizes correctly — only the
**concurrent read while the daemon is alive** is blocked.

## Expected

The LLM/UI can read a finalized (or even an actively-streaming, last-flushed) trace
store while the daemon keeps running — the whole point of the shared daemon is
human+LLM working the live session simultaneously, including querying its traces.

## Repro steps

1. `runtime_trace_start` on the running daemon session, run, `runtime_trace_finalize`.
2. `runtime_swimlane_slice(run_id, duckdb_path=<the store>, …)` → "Could not set lock".
3. Kill the daemon → the same read succeeds.

## Evidence

- `scripts/e2e-746-live-trace.mjs` test 7/8 read the store ONLY AFTER daemon teardown
  (events=1531575, cpu=844918, swimlane rows=88387) — proves the data is there + the
  reader works once the daemon is gone.
- `withDuckDb` (`src/server-tools/runtime.ts`) was changed to open READ_ONLY first
  (746.3) — read-only concurrent opens work across processes in `@duckdb/node-api`
  when no writer holds the file, but the LIVE daemon still holds a lock the read-only
  open collides with.

## Scope guess

The daemon process retains a write-lock on the `.duckdb` even after
`closeTraceRunStore`. Likely a cached/leaked `DuckDBInstance` in the daemon process
(another reader — e.g. `vic_inspect` checkpoint path, or the trace-run store not
fully released), OR `@duckdb/node-api` keeping the file locked at the
process/instance-cache level. Options to fix:
- Route trace-store READS through the DAEMON too (a `trace/query` WS method that reads
  inside the daemon process, same handle ownership) — consistent with 744.4c "one
  authority". This is the cleanest: the LLM's `runtime_swimlane_slice` in daemon mode
  → daemon-side read, no cross-process lock.
- OR ensure the daemon fully releases every `.duckdb` handle after indexing + never
  re-opens it for reads (force every daemon-side store open to be short-lived + closed).
- OR copy/snapshot the `.duckdb` for the reader (ugly; defeats the point).

Recommendation: **route reads through the daemon** (a `trace/query`-family WS method),
mirroring how 746.2/.3 route start/finalize. Then `runtime_swimlane_slice` /
`runtime_query_events` / `trace_store_*` get an `isDaemonMode` branch like the rest.

## Notes / follow-up

- Does NOT block 746.1/.2/.3 (start/finalize/status on the live session — those pass
  12/12 in e2e:746). Blocks the LLM reading a trace WHILE the daemon runs.
- Maps to Spec 746 build-list item 746.5 (live-trace default duckdb_path) — fold the
  daemon-routed read into that slice.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
