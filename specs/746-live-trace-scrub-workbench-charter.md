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
- **746.6 — DONE (2026-06-01, partial — default layout).** Live traces now default to
  `<project>/runtime/<session_id>/live_<ts>.duckdb` (session-scoped), with the kept
  `.c64retrace` authority (OQ2) next to the discardable `.duckdb` cache. Explicit
  `output=` paths still honoured (project-relative or absolute). Verified: a
  no-`output` `trace/start_domains` writes under `runtime/integrated-1/`. REMAINING:
  a retention sweeper for transient stores + moving pinned `.c64re` checkpoint dumps
  under the same tree — deferred (the default layout is the load-bearing part).
- **746.6 (orig) — Trace + checkpoint persistence layout under the project.** Define where
  a session's `.c64retrace` + `trace.duckdb` + pinned `.c64re` checkpoints live
  (e.g. `<project>/runtime/<session>/…`), naming, and retention (ring is transient;
  pinned/dumped are durable). **[OQ2]**: keep `.c64retrace` after finalize (it's the
  authority; DuckDB rebuildable from it) or discard once indexed? Recommendation:
  KEEP the `.c64retrace` (it's the truth; DuckDB is a cache).
- **746.7 — DEFERRED (feature, not wiring).** Scenario ↔ checkpoint bridge. AUDIT
  (2026-06-01): `runtime_promote_branch` exists + is daemon-routed, BUT it promotes
  from the `RewindManager`'s OWN snapshot map (`v2/rewind.ts`), which is a SEPARATE
  world from the live `checkpointRing` (`kernel/runtime-checkpoint-ring.ts`). Promoting
  a LIVE ring checkpoint → Scenario needs the RewindManager married to the ring
  (record input/media/intervention events between ring keyframes, build a branch from a
  ring checkpoint — 712 §5.2-5.4). That is real feature work, not the "make-usable"
  wiring this charter front-loads. Deferred to a dedicated 712-follow-up slice.

### 4.4 Semantic layer (findings, not just rows)
- **746.8 — DEFERRED (partly already possible).** Bridge trace evidence → knowledge.
  AUDIT (2026-06-01): `save_finding` already accepts `addressRange` + `evidence`, so the
  LLM can TODAY save a finding citing a trace anchor (runId + cycle range + marks) as
  free-text/range evidence. A dedicated structured trace-evidence type (auto-link a
  swimlane window → finding, queryable join) is a knowledge-layer FEATURE, not wiring.
  Deferred; the manual path works now.

### 4.5 UI (the human can drive it)
- **746.9 — DONE (2026-06-01).** Live-tab trace control: a "⏺ Trace" toggle in the
  MachineControls bar (next to Snapshot/Warp/Audio) starts/stops a full-domain trace
  (cpu+drive+iec+memory) on the shared session via `trace/start_domains` / `trace/run/
  stop`; reflects backend trace state on mount (`trace/run/status`); red active style
  (`wb-trace-on`) + store-path tooltip. This is the UI gate of OQ1's three-gate control
  (UI ✓ + API `runtime_trace_start` ✓; Monitor command = 746.9b). ui:build clean;
  button + `trace/start_domains` verified in the bundle.
- **746.9b — DONE (2026-06-01).** Monitor `trace` command (the THIRD OQ1 gate):
  `trace on [domains...] | off | status | mark "<label>"` via `monitor/exec` — builds
  `captureAllDef(domains)` (default cpu+drive+iec+memory), no pre-registered definition
  (distinct from the advanced `tracedb <def-id>` command). Verified: on→status(active)→
  mark→off round-trips on the shared session. **All three OQ1 control gates now live:
  UI button + `runtime_trace_start` API + Monitor `trace` command.** REMAINING: UI
  domain-picker + live events/marks readout (cosmetic).
- **746.10 — DONE (2026-06-01).** Swimlane viewer wired to the live trace. The
  existing Trace tab called the WRONG path (`runtime/call swimlaneSlice` = the
  backend-less AgentQueryApi bridge → always "no data"). Fixed: the tab now resolves
  the session's store via the new `trace/current` WS method (active or last-finalized
  run, exposed via `TraceRunController.currentStorePath()` + `lastStorePath/lastRunId`
  that survive stop()), then reads the swimlane THROUGH the daemon (`trace/read` op
  swimlane — concurrent-safe, BUG-029). Returns the user's lane fields
  (cycle/c64Pc/c64Op + drive lanes). Verified end-to-end: trace on→run→off→
  `trace/current`→`trace/read` = 100000 rows with {cycle,c64Pc,c64Op}. UI shows clear
  guidance when no trace / still-recording. REMAINING (cosmetic): PC-click→disasm jump
  via resolve_pc; live (pre-stop) swimlane from the binary log.
- **746.11 — PENDING (UI feature — build with visual iteration).** Scrub timeline
  bound to the RING. The backend is READY: WS `checkpoint/list|capture|pin|unpin|
  restore` + the MCP `runtime_checkpoint_*` tools (746.4, gated 9/9) — restore rewinds
  the shared session. What remains is a NEW React timeline component (the existing
  Snapshots tab shows the RewindManager branch-tree, a SEPARATE world from the live
  ring). This is real UI work that needs the human's eye at the screen (cf. the hero-
  layout iteration), not blind autonomous build — deferred to a hands-on session.
- **746.12 — PENDING (UI feature — build with visual iteration).** Graphics-scrub on
  LIVE RAM. The static `ScrubPanel` (App.tsx:2065) renders charset/bitmap/sprite from
  ARTIFACT bytes via `/api/scrub/*`; pointing it at the running session's RAM needs a
  live-RAM byte source (a `memread` slice → the same renderer). Substantial UI work in
  the large App.tsx — deferred to a hands-on session.

### 4.6 Execution-context focus (flow lanes)
- **746.13 — DONE (2026-06-03, C64 lane; gate `e2e:746-13` 24/24).** MAIN/IRQ/NMI focus
  for the trace, mirroring the Monitor's flow-focus (`FlowTracker`, Spec 623 §4.3,
  `stepping.ts`).
  **Built:** `v2/flow-focus.ts` `deriveFlow()` replays the FlowTracker classification
  (SP-delta-3 interrupt detector) over the cpu_step stream → a `c64Flow` lane; wired into
  `swimlaneSlice` (new `c64Flow` column + `focus`/`nmiVector` query params), surfaced in
  the markdown render (`flow` column) + JSONL, and exposed on `runtime_swimlane_slice`
  (`focus=main|irq|nmi`, `nmi_vector`) through both the daemon `trace/read` path and the
  local fallback. Pure reader-side: no format change, zero hot-path cost, runs on existing
  `.c64retrace`. (NOTE: `trace_store_query` stays raw SQL — the flow lane is derived in the
  swimlane reader, not a DuckDB column.) **Remaining: 746.13b** — the 1541 `DRIVE_CPU_STEP`
  drive-side flow lane (same replay, drive-ROM vectors).
  The Monitor pushes a flow frame on IRQ/NMI/BRK entry (SP−3 + a jump to the vector target
  with no JSR/JMP) and pops on RTI. The trace stores NONE of it: `CPU_STEP` (18 B —
  pc/opcode/A/X/Y/SP/P/b1/b2) carries no flow-kind, so the swimlane has no main/irq/nmi
  lane. The info is implicit per step (PC + opcode + SP-delta), so the FlowTracker logic
  replays over the recorded stream.

  **Ratified design (OQ5):**
  - **Build = A (derive-at-read), B-fallback.** The swimlane reader (746.10 layer) replays
    FlowTracker over the CPU_STEP stream → a derived `flow` column. NO format change (runs
    on existing `.c64retrace`), ZERO hot-path cost (the zero-alloc firehose stays
    untouched). Keep B (a 1-byte capture-time tag) in reserve ONLY if read-time derivation
    proves unreliable on the rare nested-IRQ-in-NMI / SMC-vector cases.
  - **3 lanes: `main | irq | nmi`.** `brk` folds into `irq` (shares the `$FFFE` vector);
    `trap` is dropped (vestigial in the single-path runtime — real KERNAL, no trap layer,
    Spec 723). Derive: IRQ/NMI entry = SP−3 + control-transfer to the vector target without
    JSR/JMP (BRK opcode `$00` → `irq`); RTI (`$40`) pops.
  - **Focus = filter param, LLM-FIRST.** These traces serve the LLM first — there is NO
    swimlane UX yet. So 746.13 ships a derived `flow` column + an optional `focus=main|irq|
    nmi` param on the LLM-facing reader (`runtime_swimlane_slice` / `trace_store_*`) that
    drops the other lanes' rows (the Monitor mental model). Row colour-coding is a pure UI
    concern with no surface today — deferred to whenever the swimlane UI is built
    (API-first doctrine: data + filter now, tint as a UI follow-up).
  - **C64-only first.** Apply to the C64 CPU_STEP stream now; the 1541 drive CPU
    (`DRIVE_CPU_STEP`, own IRQ/VIA flow + drive-ROM vectors) is a trivial follow-up reusing
    the same replay — deferred to a 746.13b slice.

## 4.7 Status summary (2026-06-01)
DONE + pushed: 746.1 (producers-on default session), 746.2 (runtime_trace_start),
746.3 (finalize/status daemon-routed), 746.4 (checkpoint MCP tools), 746.5 (all
trace readers daemon-routed, BUG-029), 746.6 (per-session persistence layout),
746.9 (Live-tab Trace button), 746.9b (Monitor `trace` command), 746.10 (Swimlane
viewer wired). The LLM + human can: start/stop a trace on the running shared session
from THREE gates (UI/API/Monitor), read the swimlane concurrently, and scrub/rewind
the checkpoint ring. DEFERRED as real features (not wiring): 746.7 (ring↔RewindManager
marriage), 746.8 (structured trace→finding), 746.11 + 746.12 (ring-scrub timeline +
live-RAM graphics-scrub UI — need visual iteration at the screen). DONE (2026-06-03):
746.13 (MAIN/IRQ/NMI flow-focus — derive-at-read, 3 lanes, LLM-first `c64Flow` column +
`focus=` filter on `runtime_swimlane_slice`, C64 lane; `e2e:746-13` 24/24). Remaining:
746.13b drive-side lane; UI tint deferred.

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
- **OQ5 — DECIDED (2026-06-03, 746.13 flow-focus):**
  - **(a) build →** **A (derive-at-read), B-fallback.** No format change, zero hot-path
    cost; runs on existing `.c64retrace`. Keep the 1-byte capture-tag (B) in reserve only
    if A proves unreliable on rare nested-IRQ-in-NMI / SMC-vector cases.
  - **(b) lanes →** **3: `main | irq | nmi`.** `brk` folds into `irq` (shared `$FFFE`
    vector); `trap` dropped (vestigial in the single-path runtime, Spec 723).
  - **(c) focus →** **filter param, LLM-first.** A `flow` column + a `focus=main|irq|nmi`
    filter on the reader (`runtime_swimlane_slice` / `trace_store_*`) — the LLM is the
    primary consumer; there is no swimlane UX yet. Row colour-coding deferred to a later UI
    follow-up (API-first; UI follows).
  - **(d) drive →** **C64-only first.** The 1541 `DRIVE_CPU_STEP` flow reuses the same
    replay later (746.13b follow-up).
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
