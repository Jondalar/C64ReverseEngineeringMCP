# Spec 726 — Headless Trace Sink + Marks (close the capture gap)

**Status:** READY
**Owner:** MCP server / runtime trace
**Source:** `docs/llm-human-c64re-swimlane.md` + the Murder project use-case
`docs/USECASE_trace_to_disasm.md` (trace → dynamic analysis → better disasm).
**Purpose:** let an LLM persist a headless execution trace to a queryable
`trace.duckdb` from the LIVE session, so the existing reader tools
(`runtime_query_events`, `trace_store_*`, swimlane/taint/follow/profile) actually
have a store to read. Today the readers exist but **no tool writes the store**.

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

## 2. Goal

Bind the existing `TraceRunController` to the LIVE session and expose it as
default MCP tools, so capture is **incremental** (the agent paces the run with
`until`/marks, stops when enough is captured) — no all-at-once budget.

Reuse the Spec 708 pipeline (channels + single observer + `writeTraceRun`). Do
NOT build a parallel trace path.

## 3. Rule

- Capture is session-driven + incremental, not scenario-batch.
- One run = one `trace.duckdb` (`trace_run` + `trace_event` + `trace_mark`),
  re-queryable forever.
- The agent stamps phase marks (`boot-complete`, `title`, `scene-1`) so Phase-B
  queries scope by game phase.
- No emulator behaviour change — trace is a passive observer.

## 4. Tasks

### 726.1 — Audit (no code change) — DONE (2026-05-29)
`docs/headless-trace-sink-audit.md`. Findings: the pipeline is already present —
`RuntimeController` owns `traceRun = new TraceRunController()`, reachable via the
shared `ensureRuntimeController(session_id, session)` registry; the observer
fires on a plain `runtime_session_run`. Binding point = `ctrl.traceRun.start/
mark/stop`. Two design constraints REFINE 726.2:
- **Buffer-then-flush, cap 500k events** (NOT streaming): events buffer in RAM,
  flushed once at `stop()`. A full-session cpu_step trace overflows + silently
  truncates. → 726.2 keeps buffer-then-flush + leans on **agent-paced short
  windows + narrow triggers + finalize-per-phase** (the swimlane model);
  streaming-flush is a possible follow-up, not 726. The §2 wording "append rows
  incrementally" is corrected to this.
- **Producers must be enabled, not just channels:** `bus_access` needs
  `enableBusAccessTrace`, iec/drive need `traceIec`/`traceDrive` at session
  construction. → `runtime_session_start(trace_out, trace_domains)` must enable
  the matching producers per domain, else the store is empty.

### 726.2 — Live trace sink (code)
- `runtime_session_start` gains optional `trace_out` (resolved `.duckdb` path
  under the project) + `trace_domains`/`trace_families` (default: cpu_step +
  bus + iec/drive + vic + irq, per the use-case schema). When set, start a
  `TraceRunController` bound to the session and open the store.
- `runtime_session_run` (and `runtime_until`) append observed events to the open
  run as they execute. Capture is incremental; the agent paces with `until` +
  marks.
- A finalize path (`runtime_session_stop`/explicit `runtime_trace_finalize`, or
  on session close) flushes `writeTraceRun` + closes the store.
- Keep the in-memory ring for sessions WITHOUT `trace_out` (no behaviour change
  by default; persistence is opt-in per session).

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
- Offline (store-only, no live session): `runtime_query_events` /
  `trace_store_query` / `trace_store_top_pcs` return the captured rows; an
  executed-PC query over a file range returns in <1 s.
- `disasm_prg` pass 2 can consume the executed-PC set as `entry_points[]` (the
  use-case payoff — measured separately in the project).
- No new parallel trace path: capture reuses `TraceRunController` + `writeTraceRun`.
- Default surface stays façade-first; `runtime_run_scenario` + `vice_trace_*`
  stay advanced. `probe-tool-surface` + `probe-single-path` GREEN.

## 7. Open questions
- **OQ1** — finalize trigger: explicit `runtime_trace_finalize(session_id)` vs
  auto-flush on session stop vs incremental flush per `runtime_session_run`.
  Incremental append + a single close is simplest; decide in 726.1.
- **OQ2** — default trace domains: full (cpu_step+bus+iec+drive+vic+irq) is the
  use-case ask but is the heaviest. Allow `trace_domains` to narrow; pick a
  sensible default (cpu_step + bus + marks) in 726.2.
- **OQ3** — store size / rotation for long runs: cap, warn, or rely on the
  agent's `until`-paced short windows. Use-case prefers short paced windows.
