# Bug: Trace aborts on backpressure during the fastloader firehose AND wedges (finalize can't recover)

- **ID:** BUG-030
- **Date:** 2026-06-02
- **Reporter:** llm
- **Area:** runtime / trace
- **Severity:** high
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: master (post Spec 744.x runtime daemon + runtime_trace_start)
- Surface: mcp full + standalone runtime daemon (`ws://127.0.0.1:4312`)
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Session: `integrated-1`; trace via `runtime_trace_start`
- Game: Wasteland (1988) — custom 2-bit `$DD00` fastloader, heavy event rate during disk loads

## What happened

Tracing a live in-game session (`runtime_trace_start` domains `c64-cpu`+`drive8-cpu`+`iec`)
through Wasteland's disk loads (entering/leaving a location → the custom fastloader runs the
`$FF00`/`$FDxx` byte loop millions of times) **aborts the trace on backpressure**:

```
runtime_trace_finalize
-> Error: trace backpressure ceiling: 256 unflushed chunks (~256 MiB) —
   the trace sink worker cannot keep up; aborting trace
```

Two distinct problems:

1. **The sink worker can't keep up with the fastloader firehose.** The custom loader
   generates an enormous event rate (the `$FF00` recv/store loop + drive `$03xx`/`$05xx`
   per byte). Capturing across a disk load blows the 256-chunk / ~256 MiB ceiling and the
   trace is aborted — so exactly the moments we most need to trace (loads / map-writeback /
   save) are the ones that kill the trace. The resulting `.c64retrace` is an 819-byte stub;
   no usable data, no DuckDB index.

2. **After the abort the trace is WEDGED.** The trace stays "active" but every
   `runtime_trace_finalize` re-throws the same backpressure-abort, and `runtime_trace_start`
   refuses with "trace already active on session integrated-1 — stop it first
   (trace/run/stop)". There is no exposed `trace/stop` that succeeds — the only recovery is
   killing the daemon (kill :4312 + `/mcp reload`). So one backpressured trace bricks all
   further tracing on the session until a daemon restart.

This is the SECOND in-game trace failure mode (cf. the earlier run whose async DuckDB index
was simply never built — different symptom, same "can't trace through the loads" theme).

## Expected

1. A trace survives a disk-load firehose — via stronger backpressure handling: block/throttle
   the producer (slow the sim while the sink drains) instead of aborting, or a larger/adaptive
   buffer, or domain-aware sampling. Losing the whole trace at the load boundary defeats
   loader/persistence RE.
2. A backpressured/aborted trace must leave the session in a clean state — a
   `runtime_trace_stop` (or `runtime_trace_finalize`) that **always** clears the active-trace
   flag and frees the sink, so `runtime_trace_start` can begin a fresh trace without a daemon
   restart. An abort should never wedge the session.

## Repro steps

1. `runtime_trace_start integrated-1 domains=[c64-cpu,drive8-cpu,iec]` on an in-game session.
2. Drive through a disk load (enter/leave a location, or any fastloader transfer) via
   `runtime_session_run`.
3. `runtime_trace_finalize` → backpressure-abort.
4. `runtime_trace_finalize` again → same abort (wedged).
5. `runtime_trace_start` → "trace already active … stop it first" (no working stop).

## Evidence

```text
runtime_trace_finalize integrated-1
-> Error: trace backpressure ceiling: 256 unflushed chunks (~256 MiB) — the trace sink worker
   cannot keep up; aborting trace   (headless.ts / runtime-daemon-client.ts:243)

runtime_trace_start integrated-1
-> Error: trace already active on session integrated-1 — stop it first (trace/run/stop)

# resulting file: runtime/integrated-1/live_mpw85xor.c64retrace = 819 bytes (stub, unusable)
```

## Scope guess (optional)

- Sink-worker throughput vs the fastloader event rate; the 256-chunk hard ceiling aborts
  instead of applying producer backpressure (pause the sim tick until the sink drains).
- The abort path doesn't reset the session's `trace active` state nor free the worker →
  wedge. Need an idempotent stop that works even after an abort.

## Notes / follow-up

- Workaround attempted: lighter domains (`c64-cpu` only) — couldn't even start (wedged from
  the prior abort). Likely still firehoses during the loader even at one domain.
- Practical impact on Wasteland RE: blocks capturing the in-game map-load coords, the
  area-leave map-writeback, and the save write targets — i.e. the persistence analysis.
- Lower-firehose writes (the in-game `Save` command, which does NOT reload a map) may trace
  fine once the wedge is cleared — worth a test after the fix.

---

## Resolution

- **Root cause:** TWO, both from the Spec 746.x trace hardening.
  1. *Abort:* the daemon `session/run` handler (`v3-ws-server.ts`) did ONE
     synchronous `s.runFor(cycleBudget)` and never drained the trace. The per-frame
     drain added for the OOM fix lives only in the free-run tick loop (`debug/run`),
     NOT in the bulk-run path. So a long firehose run buffered the writer's
     `pendingSend` monotonically until it crossed `MAX_PENDING_CHUNKS` (256) →
     `fail()` → whole trace aborted. The ceiling meant to prevent OOM killed the
     trace because the bulk path never fed the worker.
  2. *Wedge:* `trace-run.ts stop()` did `await writer.finalize()`, which re-throws
     `writer.error` (the backpressure error) BEFORE reaching `this.active = null`.
     So stop threw, `active` stayed true, `finalize` kept re-aborting, and
     `trace_start` refused with "already active". Only a daemon kill recovered.
- **Fix:**
  1. *Survive:* `session/run` now runs in bounded segments (100k cycles) and drains
     the trace between them when a trace is active — producer-side backpressure (the
     sim pauses per segment while the 1 MiB-chunk worker writes to SSD), so
     `pendingSend` stays tiny and the ceiling is never approached.
  2. *No wedge:* `stop()` claims `this.active = null` UP FRONT and wraps
     `writer.finalize()` in try/catch — a poisoned writer becomes a graceful abort
     (dispose the worker, record `aborted=true` + `lastError`, return the best-effort
     run) instead of a throw. The drained `.c64retrace` prefix stays on disk and is
     lazy-rebuildable. A backpressured/aborted trace can always be stopped + a fresh
     `trace_start` begins, no daemon restart. (`MAX_PENDING_CHUNKS` is now env-overridable.)
- **Fix commit:** (this change)
- **Gate proving the fix:** `npm run e2e:bug030` (`scripts/e2e-bug030-trace-backpressure.mjs`)
  9/9 — Part A: a 3M-cycle firehose through `session/run` with ceiling=4 SURVIVES
  (2.76M events captured, clean stop, restart). Part B: a poisoned writer → `stop()`
  returns cleanly (aborted, no throw) + `isActive()===false` + restart works.
- **Regression risk:** low — `session/run` segmenting preserves breakpoint semantics;
  `stop()` teardown is now strictly more defensive. Regressions green: probe-708 19/19,
  leak 14/14, 746 14/14, 744-4c 10/10, index-streaming 10/10.
