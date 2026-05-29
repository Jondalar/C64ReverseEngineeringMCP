# Headless trace sink audit (Spec 726.1)

**Date:** 2026-05-29. Audit-only — input for 726.2/726.3. No code change.

Goal: persist a queryable `trace.duckdb` from the LIVE headless session via MCP.
This audit reads the existing pipeline and finds it is **almost entirely
present** — the gap is MCP wiring + two real design constraints.

## 1. The pipeline already exists (Spec 708)

`RuntimeController` (`debug/runtime-controller.ts:132`) already owns a trace-run
controller: `readonly traceRun = new TraceRunController()`. And the MCP layer
already has a shared per-session registry:
`ensureRuntimeController(session_id, session)` / `getRuntimeController(sessionId)`
(`debug/runtime-controller.ts:567/579`), used by both `runtime.ts` and the WS.

`TraceRunController` (`trace/trace-run.ts`):
- `start(def, { controller, outputPath })` — enables the def's channels on
  `session.kernel.trace()`, registers ONE observer, optionally captures an
  at-start checkpoint, sets `active`.
- `mark(label)` — pushes `{ cycle, label }` to `run.marks`.
- `stop()` — disposes the observer, restores channel state, optional at-stop
  checkpoint, then flushes everything via `writeTraceRun` → DuckDB and closes.
- `status()` — active/runId/eventCount/bytes/marks/overflow.

`writeTraceRun` (`trace/trace-run-store.ts`) writes tables `trace_run`,
`trace_event` (`run_id, seq, cycle, channel, trigger_kind, capture_kind,
data_json`), `trace_mark` (`run_id, cycle, label`).

→ **The binding point is `ctrl.traceRun`.** No new trace infra is needed; 726
wires MCP tools to `ensureRuntimeController(session).traceRun.start/mark/stop`.

## 2. RuntimeTraceDefinition (what to pass)

`trace-definition.ts`:
- `domains: ("c64-cpu"|"drive8-cpu"|"iec"|"vic"|"sid"|"memory")[]`
  (`domainsToChannels`: c64-cpu→cpu, drive8-cpu→drive_pc, iec→iec, vic→vic,
  sid→sid, memory→io+bus_access).
- `triggers` (≥1) FILTER which events are retained: `pc-range`, `mem-access`
  (read/write/any), `iec-transition`, `raster-window`, `monitor-stop`,
  `manual-mark`.
- `captures` (≥1) further SELECT by kind: `cpu-row`, `mem-row`, `iec-row`,
  `vic-row`, `checkpoint-ref`.
- `retention`, optional `checkpointPolicy` (`none|at-start|on-trigger|at-stop`),
  optional `stop` (`cycle-budget|event-count|manual`).

A "capture everything in the file" def (for the use-case) = e.g.
`domains: [c64-cpu, memory]`, `triggers: [{pc-range 0x0000..0xffff c64-cpu},
{mem-access any 0..0xffff}]`, `captures: [cpu-row, mem-row]`,
`retention: "evidence"`. 726.2 builds this from the tool's `trace_domains` input.

## 3. CRITICAL constraint #1 — buffer-then-flush, NOT streaming (cap 500k)

The observer buffers matched events **in memory** (`events[]`) and `stop()`
flushes them in ONE batch. `MAX_BUFFERED_EVENTS = 500_000`; on overflow it
silently stops capturing (`capturing=false`, `overflow=true`).

Implication for the use-case ("trace EVERYTHING for the whole boot+play"):
- motm boot is ~133 M cycles; cpu_step on that would be tens of millions of
  events → **massively over the 500k cap → silent truncation.**
- So a single full-session cpu_step capture is NOT feasible as-is. The realistic
  shapes are:
  1. **Agent-paced short windows** (the swimlane model): start → run a short
     `until` window → finalize → one small `trace.duckdb` per phase. Matches the
     use-case's "tag marks per phase". Preferred.
  2. **Narrow triggers**: `pc-range` to the file/region of interest, not
     0..ffff — keeps the executed-PC set for THAT region small enough.
  3. (Larger change, out of 726) streaming flush + raised/removed cap.

Spec 726.2's wording "append rows incrementally as it executes" is therefore
**inaccurate** — capture is in-memory, written once at finalize. 726.2 must
either (a) keep buffer-then-flush + document the cap + lean on agent pacing /
narrow triggers, or (b) add incremental flushing (bigger). **Recommend (a)** for
726; note streaming as a follow-up if full-session cpu_step traces are needed.

## 4. CRITICAL constraint #2 — channels must be PRODUCING, not just enabled

`controller.start` calls `trace.configureChannel(c, {mode:"ring"})` to enable
the SINK, but the trace PRODUCERS must actually emit. The bus-access producer is
gated by `enableBusAccessTrace` at IntegratedSession construction; iec/drive by
`traceIec`/`traceDrive`. So a session started WITHOUT those opts will enable the
channel but receive no `bus_access` events → empty `mem-row` capture.

→ `runtime_session_start(trace_out, trace_domains)` MUST also enable the matching
producers at construction (`enableBusAccessTrace` for `memory`, `traceIec` for
`iec`, `traceDrive` for `drive8-cpu`). Verify per-domain in 726.2; the cpu/vic
producers' enablement also needs confirming.

## 5. Observer fires during `runtime_session_run`

Once `ctrl.traceRun.start(...)` is active, the registered observer captures on
every trace event the session emits — including a plain `session.runFor` driven
by `runtime_session_run`/`runtime_until`. So NO per-run "append" call is needed;
the run loop just executes and the observer collects. Confirmed by the observer
being registered on `session.kernel.trace()` (the shared registry), not on a
scenario-specific path.

## 6. 726.2/726.3 binding plan (grounded)

- **726.2:** `runtime_session_start` gains `trace_out` + `trace_domains`. When
  set: enable the matching producers (constraint #4); `ensureRuntimeController(
  session)`; build a capture-def from domains (broad triggers + matching
  captures); `ctrl.traceRun.start(def, {controller: ctrl, outputPath: trace_out})`.
  `runtime_session_run`/`until` capture via the live observer (constraint #5).
- **Finalize:** `runtime_trace_finalize(session_id)` → `ctrl.traceRun.stop()` →
  `writeTraceRun`. (Auto-flush on session close as a safety net.) — resolves OQ1.
- **726.3:** `runtime_mark(session_id, label)` → `ctrl.traceRun.mark(label)`.
  `runtime_trace_status` (optional) → `ctrl.traceRun.status()` so the agent can
  watch `eventCount`/`overflow` and finalize before the 500k cap.
- Tier: `runtime_mark` + `runtime_trace_finalize` (+ status) = default.
- Document the cap + the agent-paced-windows pattern in the tool descriptions
  (`runtime_session_start trace_out`: "for full traces, pace with until + marks
  and finalize per phase; capture is capped at 500k events per run").

## 7. Risks / notes
- The 500k cap is the dominant design fact — surface it in the description so the
  LLM paces correctly instead of silently truncating.
- Producer enablement (#4) is the most likely "empty store" bug — gate it per
  domain and cover it in the 726 smoke (assert mem-row rows actually land).
- `gatherMediaIdentity` reads `kernel.drive1541.getAttachedMedia()` — present
  (Spec 723/724). Media identity in `trace_run` will populate for mounted disks.
- No emulator behaviour change: the observer is passive; producers already exist.
