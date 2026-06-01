# Spec 746 — Live Trace + Scrub Workbench Charter (the shared anchor + firehose model)

**Status:** CHARTER (2026-06-01) — architecture + build-list, not a single slice.
**Pairs with:** 744.4c (shared runtime daemon — DONE), 705/705.B (checkpoint ring),
707 (.c64re snapshot), 708 (declarative trace defs), 726/726.B (binary trace),
712 (rewind/branch/diff), 231 (scenarios).
**Why this exists:** the heavy machinery is built but the user (the human DRIVING
Wasteland_EF) cannot actually USE it from the live session — the wiring + tools +
UI + docs are missing. This charter names the goal, the data model the user
ratified, what already exists, and exactly what to build to make it usable. It is
written so it does NOT disappear into the backend again.

## 0. The goal (user's words, ratified)

Take a game apart with the LLM as sidekick — **statically** (disassembly) AND **at
runtime** — then let the LLM **experiment with Scenarios, spec-driven, until the
outcome matches the user's spec.** For that the user needs, in parallel, on ONE
shared live session (human + LLM):

- **Scrubbing** — rewind→forward over the checkpoint ring.
- **Tracing** — toggleable on the RUNNING process, streamed (NOT JSON/DuckDB on the
  hot path — that is what spun the fan).
- **An enhanced monitor** vs VICE.
- **Graphics-scrub** — render the memory footprint as bitmap/charset/sprite to spot
  graphics patterns by eye (static today; live-RAM later).

## 1. The data model (the architecture the user reasoned out, confirmed correct)

> Heavy ANCHOR every 0.5 s + light deterministic STREAM in between.

```
Checkpoint A ───────── trace firehose ───────── Checkpoint B
 (full state,           │                         (full state)
  every 0.5s,           ├─ CPU_STEP firehose (C64 + 1541): the user's lane fields
  the ANCHOR)           │     A X Y SP $00 $01 NV-BDIZC LIN CYC STOPWATCH PC + IRQ vec
                        │     → this IS the swimlane / offline-stepping = the TRUTH
                        └─ (optional) RAM/IO/VIC/SID/IEC write-deltas = random-access
                              accelerator, NOT required for reconstruction
```

**Ratified invariants:**
- **Only the CPU writes RAM.** Snapshot-A RAM + the CPU instruction stream =
  every in-between RAM state, byte-exact, by re-simulation. Self-mod code is just a
  CPU write → re-sim catches it. So the user's lane fields are SUFFICIENT for
  reconstruction; write-deltas are an optimization (instant random-access without
  re-simming from A).
- **Autonomous chip state** (CIA timers, SID ADSR, VIC raster, drive head angle)
  ticks per-cycle without an instruction. The user accepts NOT streaming it in the
  trace — it is ANCHORED in the snapshot (every 0.5s) and reconstructed by re-sim
  from the nearest anchor (≤ ~500k cycles, drift-free because the anchor is never
  far). `reSID` PCM is snapshot-registers-only (no sample stream) — irrelevant for
  logic/RAM reconstruction.
- **Recorded truth vs re-sim:** for the user's PORT-DEBUG case (vice1541), a buggy
  port makes a re-sim diverge from what REALLY ran. So the recorded CPU_STEP
  firehose is the ANCHOR OF TRUTH (not a re-sim), and the recorded PC stream
  doubles as a checksum on any reconstruction (re-sim PC stream == recorded ⇒
  in-between state is provably correct; mismatch ⇒ snapshot gap or nondeterminism =
  a found bug).
- **Media** (.d64/.g64/.crt + cart flash) changes only on mount/write → checkpoint
  level (content-addressed, pooled once), NOT per step.

## 2. What ALREADY exists (audited 2026-06-01, real code)

Do NOT rebuild these. They are done and correct.

| Built | File |
|---|---|
| Checkpoint ring (128 MiB, 25-frame, evict-oldest, pin, disk-pooled) | `kernel/runtime-checkpoint-ring.ts`, `debug/runtime-controller.ts:498` |
| `.c64re` snapshot (magic+gz+sha256, dump/undump) | `kernel/native-snapshot.ts`, `kernel/snapshot-persistence.ts` |
| **Zero-alloc binary CPU_STEP firehose** (the user's lane), worker-thread, 1 MiB chunks | `trace/binary-log-writer.ts`, `binary-log-worker.ts`, `trace/trace-run.ts:202` |
| `.c64retrace` = timeline AUTHORITY; DuckDB = rebuildable index at `stop()` | `trace/binary-log-indexer.ts`, `trace/trace-run.ts` |
| Declarative `RuntimeTraceDefinition` + `validateTraceDefinition` | `trace/trace-definition.ts` |
| `TraceRunController.start/stop/status/mark` — **start is NOT ctor-bound; the CPU firehose registers at start()** | `trace/trace-run.ts:131` |
| WS: `checkpoint/list|capture|pin|unpin|restore`, `snapshot/dump|undump`, `trace/run/start|stop|status|mark` | `workspace-ui/v3-ws-server.ts:775,920,944` |
| Swimlane / offline-stepping (C64 PC/op/IO + 1541 PC/op/IO + IEC lanes) | `v2/swimlane.ts`, `v2/swimlane-render.ts`, tool `runtime_swimlane_slice` |
| Trace-store query (SQL, top_pcs, bus_find, anchors) | `server-tools/trace-store.ts` |
| Scenarios (deterministic recipe: snapshot+inputs+cycleBudget; run/save/load) | `v2/scenario.ts`, `v2/scenario-registry.ts` |
| Graphics-scrub (render artifact bytes as charset/bitmap/sprite) | UI Scrub tab (static, file-backed) |

**Key correction vs earlier belief:** the CPU_STEP firehose CAN start/stop
mid-session (channels enabled dynamically, sink registered at `start()`). ONLY the
iec/drive/bus PRODUCERS are construction-time (`integrated-session.ts:475-529`).

## 3. The actual gaps (why it is not usable from Wasteland today)

Audited, concrete, small — wiring, not architecture:

- **G1 — no `runtime_trace_start` MCP tool.** The only way to start a trace is
  `runtime_session_start(trace_out=…)` at creation. The daemon's default session
  (`daemon/run.ts:52`) is created WITHOUT `trace_out`. The WS `trace/run/start`
  exists but is not exposed to the LLM. → the LLM cannot trace the running session.
- **G2 — `runtime_trace_finalize` / `runtime_trace_status` are not daemon-routed**
  (`headless.ts:425,444` call `getRuntimeController()` locally → "no session" in
  daemon mode). Same class as BUG-028.
- **G3 — full-domain traces need producers at construction.** CPU-only firehose
  works mid-session; iec/drive/memory need the producers, which the default session
  lacks. → either build the default session WITH producers, or make producers
  runtime-toggleable.
- **G4 — no LLM checkpoint/scrub tools.** WS has checkpoint/restore; the MCP layer
  exposes none (`runtime_checkpoint_*` missing) → the LLM cannot rewind/scrub.
- **G5 — swimlane/trace-store tools need an explicit `duckdb_path`** with no
  "the live session's current trace" default → clumsy for the LLM mid-run.
- **G6 — UI: no trace start/stop control on the Live tab; no swimlane viewer; no
  scrub timeline bound to the ring.** The human can't drive any of this from the UI.

## 4. What to build (persistence / tools / docs / UI)

Scoped to "make the ratified model usable", in dependency order. Each is a slice;
each ships with a gate. Decisions the user must still make are flagged **[OQ]**.

### 4.1 Runtime wiring (unblocks everything)
- **746.1 — DONE (2026-06-01).** Default daemon session built trace-ready: `daemon/run.ts`
  now starts it with `traceIec/traceDrive/enableBusAccessTrace` on (OQ1 = producers-on).
  So a full-domain (iec/drive/memory) trace can start mid-session on the running default
  session. Closes G3.
- **746.2 — DONE (2026-06-01).** `runtime_trace_start` MCP tool + a new WS
  `trace/start_domains` method (builds `captureAllDef(domains)` + starts on the shared
  controller — no pre-registered definition needed). Routes to the daemon in daemon mode;
  `output` resolved caller-side (project-agnostic). Closes G1.
- **746.3 — DONE (2026-06-01).** `runtime_trace_finalize` + `runtime_trace_status`
  daemon-routed (isDaemonMode branch → `trace/run/stop` + `trace/run/status`). Closes G2.
  Gate `npm run e2e:746` (12/12): trace_status (no trace, no throw) → trace_start on the
  RUNNING session → status active → run+mark → finalize (store written) → the store holds
  1.53M events incl. 844918 CPU-firehose rows → swimlane renders 88387 stepping lanes
  (read post-teardown). KNOWN GAP: reading the store via an MCP tool WHILE the daemon is
  live hits a DuckDB cross-process lock = **BUG-029** (fix = route trace-store READS
  through the daemon too; fold into 746.5).

### 4.2 Checkpoint / scrub tools (LLM can rewind)
- **746.4 — DONE (2026-06-01).** MCP checkpoint tools `runtime_checkpoint_list/
  capture/pin/unpin/restore` → the existing WS `checkpoint/*` RPCs (daemon-routed;
  in-process fallback via `ensureRuntimeController`). Closes G4 — the LLM can now
  scrub/rewind + pin evidence on the SAME ring the human scrubs. Gate
  `npm run e2e:746-checkpoint` (9/9): list/capture/pin → restore REWINDS the shared
  session (cycles 2.0M→1.0M, the UI sees the same jump) → unpin; a SECOND MCP sees
  the same ring.
- **746.5 — DONE (2026-06-01, with BUG-029).** All trace-store READERS route to the
  daemon when one is live (the only process that can open a store the daemon holds a
  cross-process lock on): new WS `trace/read` op-dispatch (swimlane/query_events/
  follow_path/taint/profile_loader/sql) + `daemonTraceRead` helper in `runtime.ts`;
  `runtime_swimlane_slice/query_events/follow_path/trace_taint/profile_loader` routed.
  The `trace_store_*` tools (different layer, `trace-store/queries.ts withConn`) made
  READ_ONLY-first so they too read a live-daemon store concurrently. Gate `e2e:746`
  14/14 (6d swimlane + 6e trace_store_query both read WHILE the daemon is live).
  STILL OPEN sub-item: default `duckdb_path` to the live session's current trace when
  omitted (convenience) — deferred; the path is passed explicitly today.

### 4.3 Persistence
- **746.6 — Trace + checkpoint persistence layout under the project.** Define where
  a session's `.c64retrace` + `trace.duckdb` + pinned `.c64re` checkpoints live
  (e.g. `<project>/runtime/<session>/…`), naming, and retention (ring is transient;
  pinned/dumped are durable). **[OQ2]**: keep `.c64retrace` after finalize (it's the
  authority; DuckDB rebuildable from it) or discard once indexed? Recommendation:
  KEEP the `.c64retrace` (it's the truth; DuckDB is a cache).
- **746.7 — Scenario ↔ checkpoint bridge.** Promote a pinned checkpoint + the
  recorded input/media/intervention events into a durable `Scenario` (712.4 path),
  so the spec-driven experiment loop can re-run it. Wire `runtime_promote_branch`
  end-to-end on the shared session.

### 4.4 Semantic layer (findings, not just rows)
- **746.8 — bridge trace evidence → knowledge.** A trace query / swimlane window the
  LLM judges meaningful becomes a `save_finding` with the trace anchor (runId +
  cycle range + marks) as evidence, queryable via `project_search`. DuckDB answers
  "where was $D020 written"; the knowledge layer answers "what this routine does".
  Keep them distinct; this slice is the link.

### 4.5 UI (the human can drive it)
- **746.9 — Live-tab trace control**: start/stop/mark buttons + domain pickers +
  active-trace status (runId, events, marks, store path) on the Live tab. The human
  toggles tracing on the running session.
- **746.10 — Swimlane viewer**: render `runtime_swimlane_slice` (C64 + 1541 lanes
  = the user's fields) as a scrollable offline-stepping view, cycle-scrubbed,
  PC-clickable → jump to disasm (static↔runtime glue via `resolve_pc`).
- **746.11 — Scrub timeline bound to the ring**: a checkpoint timeline (the Snapshots
  tab) where the human scrubs rewind→forward, pins, branches; restore drives the
  shared session so the LLM sees the same state.
- **746.12 — Graphics-scrub on LIVE RAM**: point the existing graphics Scrub tab at
  the running session's RAM (not just file artifacts) so the human/LLM spots
  charset/bitmap/sprite patterns in the live footprint while the game runs.

## 5. Acceptance (when this charter is "usable")
- From the running Wasteland_EF session, the LLM can: `runtime_trace_start` →
  `runtime_mark` → run → `runtime_trace_finalize` → `runtime_swimlane_slice` and read
  the C64+1541 stepping lanes — WITHOUT pre-declaring trace at session_start.
- The LLM can `runtime_checkpoint_capture` / `restore` / `pin` to scrub + pin
  evidence; a pinned checkpoint promotes to a Scenario the LLM can re-run.
- The human, in the UI Live tab, can start/stop a trace, watch the swimlane, scrub
  the checkpoint timeline, and graphics-scrub live RAM — all on the SAME session the
  LLM drives (744.4c).
- The fan does not spin: tracing stays on the binary path (726.B, ≤10% overhead);
  no JSON/DuckDB on the hot path.

## 6. Open questions (decide before building the affected slice)
- **OQ1 — DECIDED (2026-06-01):** producers **on-by-default** (A). Trace AN/AUS is ONE
  control (WS `trace/run/*`) reachable from **THREE entry points: the UI (Live-tab
  button), the API (`runtime_trace_start` MCP tool), and a Monitor command** — for both
  human and LLM, on the running shared session. Producers-on makes the toggle trivial
  (channels+observer only, no new passive-proof). The three-gate control is the binding
  requirement; 746.2/746.9 + a new Monitor `trace` command all call the same WS path.
- **OQ2 — DECIDED (2026-06-01):** `.c64retrace` (binary) is the KEPT authority; the
  `.duckdb` is a DISCARDABLE cache, built on-demand from the binary log when a query
  needs it. Code finding that drove this: the indexer is content-LOSSLESS (every event
  1:1, `binary-log-indexer.ts:107-126`) BUT writes a `data_json` column = 5-10× LARGER
  than the binary + NOT reverse-rebuildable. So keeping the binary (not the DuckDB)
  saves MORE disk, keeps rebuildability + the raw recorded truth (the user's port-debug
  anchor). Cost: first query after a trace must index (~5.5s / 3M events, off the
  hot path). Implication for 746.6 layout: `.c64retrace` durable; `.duckdb` is a
  regenerable cache (safe to evict; rebuild via `indexBinaryLog`).
- **OQ3 — DECIDED (2026-06-01):** ring budget is **configurable per session, default
  128 MiB** (~2.6 min). Bytes-based (not cycle/time — keeps RAM bounded even when
  checkpoint size varies with dirty media). A `ringBudgetBytes?` option at session
  start + a WS `checkpoint/set_budget` to bump it live (e.g. 256 MiB for a long
  multi-load loader). The ring already estimates per-checkpoint bytes
  (`estimateCheckpointBytes`), so the budget is enforced as today, just no longer a
  hard constant.
- **OQ4 — DECIDED (2026-06-01):** write-delta streaming is **DEFERRED — measure first**.
  The MVP is CPU-firehose + snapshot ONLY (sufficient for reconstruction: only the CPU
  writes RAM, re-sim from the nearest anchor ≤500k cyc rebuilds any in-between state).
  Write-deltas (RAM/IO/VIC) are PURELY a random-access accelerator (jump to cycle T
  without re-simming). Build them ONLY if the UI scrub via re-sim proves too slow.
  Saves work + trace size now; revisit after measuring scrub latency.

## 7. Non-goals
- NOT rebuilding the ring / binary trace / swimlane / scenarios (they exist).
- NOT moving DuckDB onto the hot path (it is a rebuildable index, always).
- NOT a second runtime/UI (744.4c daemon + the one product UI are the surfaces).
