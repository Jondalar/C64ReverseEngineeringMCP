# Bug: a multi-GB `.c64retrace` took the whole MCP server down ("Connection closed")

- **ID:** BUG-052
- **Date:** 2026-08-18
- **Reporter:** llm
- **Area:** trace
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: `79cfe700` (master, 2026-08-17)
- Surface: mcp default
- Tool / endpoint / tab: `runtime_loader_lens` (and `validate_extraction`, same readers)

## What happened

`runtime_loader_lens` against a finalized 2,136,107,703-byte capture (118,496,006
events) returned `Connection closed` and every `mcp__c64-re__*` tool went away
until the client reconnected. The daemon was untouched — it is a separate process
and kept running — so only the MCP server died.

## Expected

Either the call completes, however slowly, or it fails with a normal tool error.
Never a dead server.

## Repro steps

1. Arm a trace with `domains: ["c64-cpu","memory","drive8-cpu","drive-mechanism"]`.
2. Drive a real boot → menu → intro → disk swap sequence.
3. `runtime_trace_finalize` — 118 M events, ~2.1 GB.
4. `runtime_loader_lens capture_path=<that file> hypothesis=<...>`.

## Evidence

```text
Events: 118496006  bytes: 2136107703
→ runtime_loader_lens → "Connection closed"
→ all 151 mcp__c64-re__* tools unavailable until /mcp
→ runtime_session_status on the same session works immediately after reconnect
```

## Scope guess (optional)

`src/trace/loader-lens.ts:492,505,515,525`

## Notes / follow-up

- `validate_extraction` was worse: it called three `*FromCaptureFile` readers in a
  row, so the same multi-GB log was read and decoded **three times**.

---

## Resolution (fill on fix)

- **Root cause:** two allocations, both unbounded in the size of the capture.
  `readFileSync(path)` pinned the whole log in one buffer, and
  `decodeEventStream` then materialized **one JS object per event** — 118 M of
  them. The V8 heap dies, and because the readers run in the MCP server process,
  the transport dies with it; the client only ever sees the socket close.
  The indexer next door already knew this and says so in a comment
  ("The .c64retrace must NOT be read whole into one Buffer") — it streams in
  bounded windows. The loader-lens readers never got the message. Two readers of
  one format, one of them right.
- **Fix commit:** this change.
  - `src/trace/capture-stream.ts` (new) — the ONE streaming reader, extracted from
    the indexer's own window loop: bounded windows, tail carried across the
    boundary, each event handed to a visitor, nothing retained. The indexer now
    calls it too, so there is one loop rather than two.
  - `loader-lens.ts` — `buildReadSet` / `buildCartReadSet` / `buildLandingMap`
    became FOLDS (`push`/`finish`); the array-taking functions stay as thin
    wrappers, so every existing caller and test is unchanged. The landing map
    folds both source lanes in its own single pass.
  - `readSetsFromCaptureFile` — one pass for both lanes plus the identity block;
    `validate_extraction` uses it instead of reading the file three times.
  - `captureMetaFromFile` reads the header window, never the log.
  - `MAX_COMPLETED_RUNS` — past 250 000 landing runs the capture is a firehose and
    the map would be noise; it now throws a readable tool error naming the fix
    (re-capture a narrower window) instead of growing until the process dies.
  - `runtime_loader_lens` runs through the BUG-039 job registry: it settles inside
    a 20 s grace window exactly as before, and past it hands back a `job_id` so a
    long fold cannot trip the host's ~180 s stall limit either. Note that the job
    registry alone would NOT have fixed this — the job runs in the same process,
    so an OOM still kills the server. Streaming is the fix; the job is the other
    failure mode.
- **Gate proving the fix:** `npm run smoke:bug052` — 16 checks. Forces a 64 KiB
  read window so the window loop and its cross-boundary carry actually run,
  asserts the streamed results are byte-identical to the in-memory path for both
  lanes and the landing map, and measures the heap while folding: growth must stay
  under what a materialized `DecodedEvent[]` would cost on its own. Plus the
  firehose cap throwing a readable error.
- **Regression risk:** low. The existing loader-lens / validate-extraction /
  cart-read-set suites pass unchanged (11 + 8 + 6 + 23 + 32), and the trace-query
  suite passes against the rebuilt indexer.
