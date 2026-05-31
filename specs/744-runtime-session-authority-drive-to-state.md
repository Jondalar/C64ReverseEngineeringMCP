# Spec 744 — Runtime Session Authority + Drive-to-State Orchestration

**Status:** 744.4 DONE (744.4c Runtime Daemon shipped, 2026-05-31) — there is now a
process-stable C64RE Runtime Daemon that owns the runtime; the UI and the MCP are
both clients of it, share the same live session, and an MCP reconnect / browser
reload does NOT reset the runtime (acceptance gate `e2e:744-4c` 9/9). 744.4a (single
in-process authority) + 744.4b (MCP co-host, RETIRED) were interim. §7 drive-to-state
orchestration (`runtime_swap_disk_and_continue`) remains open. Created after BUG-027
showed that the binary trace path, media write-through and Live UI can each be partly
correct while the product still cannot drive a real multi-disk game to an observable
state through MCP.

**Owner:** runtime session service / MCP runtime facade / Live UI backend /
media orchestration / trace startup packaging
**Depends on:** Specs 724, 726.B, 742, 743
**Related bugs:** BUG-027, BUG-013, BUG-025
**Solution design:** `docs/runtime-daemon-solution-design.md`

## 1. Problem

The product runtime has no single process-stable session authority.

Current behavior is split:

- MCP `runtime_*` tools start `IntegratedSession` instances inside the MCP
  process.
- Live UI / WS startup can start a different `IntegratedSession` inside another
  process.
- The session registry is a process-local singleton map.
- Media mount/swap semantics are not owned by one service.
- Trace worker resolution depends on whether code is executed from source or
  built output.
- MCP exposes low-level run/type/swap primitives, but not a reliable
  "drive this title to the next meaningful state" workflow.
- The 744.4b interim implementation moved the split rather than solving it:
  MCP can co-host the Live WS, but then the Runtime is owned by the MCP process.
  A MCP reconnect resets the runtime; a separately-started UI WS still owns a
  different session. That is not the product architecture.

This violates the product vision: there must be one Headless runtime that a
human and an LLM can jointly use. A human must be able to attach the UI to the
same session the LLM started, and the LLM must be able to inspect/control the
same session the human is driving in the UI. Two private session worlds are not
acceptable.

That split made BUG-027 possible:

1. `runtime_session_start(trace_out=...)` failed because the binary trace worker
   was resolved as `src/.../binary-log-worker.js`.
2. A disk-swap-prompting game could not be advanced headlessly with confidence.
3. A runtime session could consume a core while not being actively driven by a
   tool call.

## 2. Product Rule

There is exactly one product runtime session authority, and it is neither
"owned by the UI" nor "owned by the MCP".

The product topology is mandatory:

```text
C64RE Runtime Daemon / Runtime Authority
  owns IntegratedSession(s)
  owns RuntimeSessionService
  owns session ids and status
  owns run/pause/stop/close
  owns media mount/swap/eject through Spec 742 MediaRef/MountedMedia
  owns trace start/finalize through Spec 726.B
  owns checkpoint/ring state
  is stable across MCP reconnects and browser reloads

MCP runtime tools
  are clients/adapters of the Runtime Daemon
  never create product IntegratedSession instances directly

Live UI
  is a client/adapter of the Runtime Daemon
  never creates product IntegratedSession instances directly

Scenario / playbook runners
  are clients/adapters of the Runtime Daemon
```

### 2.1 Prohibited Product Topologies

These are explicitly forbidden as final/product architecture:

- **MCP-hosted Runtime:** the MCP stdio process owns the Runtime and co-hosts WS.
  This fails the stability requirement because MCP reconnect/restart destroys or
  replaces the Runtime.
- **UI-hosted Runtime:** the UI/WS process owns the Runtime and MCP cannot attach
  except by creating a second private session.
- **Two Singletons:** MCP and UI each have a `runtimeSessions` singleton in
  different OS processes. A singleton is only shared inside one process; this is
  not shared runtime authority.
- **Mirrored Sessions:** MCP and UI each run an emulator and synchronize state.
  Shared authority means one machine state, not two emulators kept approximately
  aligned.
- **Raw WS as LLM workflow:** the LLM must not be asked to speak the browser Live
  protocol. MCP remains the LLM-facing API.

### 2.2 Required Product Topology

```text
C64RE Runtime Daemon
  ├── RuntimeSessionService
  ├── IntegratedSession(s)
  ├── MediaService / MountedMedia
  ├── TraceService
  └── Checkpoint/Ring service

MCP process
  └── runtime_* tools -> Runtime API client -> Runtime Daemon

Browser UI / HTTP process
  └── Live adapter -> Runtime API client -> Runtime Daemon
```

No product path may create a private `IntegratedSession` that cannot be observed
or controlled by the other product surface.

The Runtime Daemon may expose HTTP, WS, JSON-RPC, or another local transport.
The transport is an implementation detail. The ownership rule is not negotiable:
one daemon process owns the product runtime state.

The LLM must not be required to speak raw WebSocket. MCP remains the LLM-facing
API. MCP runtime tools may internally call the same runtime backend that the UI
uses, but the consuming LLM sees stable MCP tools, not a browser/UI protocol.

### 2.3 Shared-Attach Contract

The shared runtime must support co-working:

- If the LLM starts a session through MCP, the UI can attach to that same
  session id, render its screen, inspect status, pause/run it, mount media, and
  show trace state.
- If the human starts or drives a session through the UI, MCP can list/find that
  session id and call `runtime_session_status`, `runtime_render_screen`,
  `runtime_mark`, `runtime_trace_finalize`, media tools, and bounded run tools
  against the same machine state.
- Both surfaces see the same CPU/VIC/CIA/SID/1541 state, mounted media,
  checkpoint/ring state and trace lifecycle.
- Commands are serialized by the runtime authority. If one surface is actively
  running the machine, the other surface gets an explicit busy/run-state result,
  not a second hidden runner.

### 2.4 Run Modes

The authority must distinguish these modes:

- **Tool-bounded MCP mode:** a runtime tool advances the machine for a bounded
  budget and then returns to idle. No autonomous loop remains active after the
  tool returns.
- **Live UI mode:** the UI may request continuous interactive playback. This is
  explicit, visible in status, and stoppable by pause/close.

Starting a trace is not a run mode. `trace_out` attaches passive capture; it must
not start a background run loop.

## 3. Boundary To Existing Specs

744 does not replace the existing runtime specs.

| Spec | Owns | 744 uses it for |
|---|---|---|
| 726.B | Binary `.c64retrace` timeline + DuckDB index | Starting/finalizing trace from the shared session authority. |
| 742 | MediaRef / MountedMedia / write-through | All disk/crt/prg mount and swap operations. |
| 743 | Maincpu CLOCK/alarm correctness | Long drive-to-state runs, pause/resume, and Inspector stability. |
| 724 | One UI entry / project path | Live UI must attach to the same runtime authority as MCP. |

Do not solve 744 by refactoring 726, 742 or 743 again unless a concrete bug is
inside that owned layer.

## 4. Required Runtime Service Shape

Names may change, but these responsibilities must exist inside the Runtime
Daemon. Product MCP/UI adapters must call this service across the daemon
transport; they must not instantiate the service as an independent process-local
authority.

```ts
interface RuntimeSessionService {
  start(input: RuntimeStartRequest): Promise<RuntimeSessionHandle>;
  get(sessionId: string): RuntimeSessionHandle | undefined;
  list(): RuntimeSessionSummary[];
  attach(sessionId: string, client: RuntimeClientKind): Promise<RuntimeSessionHandle>;
  close(sessionId: string): Promise<void>;

  run(sessionId: string, input: RuntimeRunRequest): Promise<RuntimeRunResult>;
  pause(sessionId: string, reason?: string): Promise<RuntimeStatus>;
  resume(sessionId: string): Promise<RuntimeStatus>;
  status(sessionId: string): RuntimeStatus;

  mountMedia(sessionId: string, input: RuntimeMediaMountRequest): Promise<RuntimeMediaResult>;
  swapMedia(sessionId: string, input: RuntimeMediaSwapRequest): Promise<RuntimeMediaResult>;
  ejectMedia(sessionId: string, device: "drive8" | "cart"): Promise<RuntimeMediaResult>;

  startTrace(sessionId: string, input: RuntimeTraceStartRequest): Promise<RuntimeTraceStatus>;
  markTrace(sessionId: string, label: string): Promise<RuntimeTraceStatus>;
  finalizeTrace(sessionId: string): Promise<RuntimeTraceResult>;
}
```

`IntegratedSession` becomes an implementation detail behind this service, not a
thing every caller constructs directly.

`RuntimeClientKind` is at least `"mcp"` or `"ui"`. It is used for ownership,
status and command arbitration only; it must not create separate emulators.

### 4.1 Runtime Daemon API Surface

The daemon must expose a stable local API for both adapters:

- session: `start`, `list`, `attach`, `status`, `close`;
- control: `run`, `pause`, `resume`, bounded step/wait operations;
- media: `mount`, `swap`, `eject`, mounted-media status;
- trace: `startTrace`, `markTrace`, `statusTrace`, `finalizeTrace`;
- render/inspect: current frame/screenshot/status needed by Live UI and MCP;
- arbitration: explicit busy/run-state responses when commands overlap.

The MCP adapter can be implemented as direct in-process calls only in tests. In
the product path it must be a client of the daemon.

The UI adapter can be implemented as WS push + request/response, but it remains
a client of the daemon. It must not own `IntegratedSession`.

## 5. Session Lifecycle Rules

### 5.1 Start

`runtime_session_start` must:

- resolve project-local or absolute media through the 742 media service;
- request exactly one session in the Runtime Daemon authority;
- optionally start a 726.B trace;
- return the session id, media refs, run state, trace state and project path.

If the Runtime Daemon is not reachable, product MCP tools must fail with an
actionable "runtime daemon not running" error or call an explicitly-designed
daemon-start command. They must not silently create a private `IntegratedSession`
inside the MCP process.

### 5.2 Idle

MCP-created sessions must not free-run when no runtime tool call is active.

Rules:

- after `runtime_session_start`, the session is either paused or runs only the
  explicit startup budget documented in the tool output;
- after `runtime_session_run` returns, the session is not burning CPU in the
  background;
- `runtime_session_start(trace_out=...)` attaches trace capture only; it must not
  create/start a `RuntimeController` loop;
- `runtime_session_close` is available as a default runtime tool and releases
  trace writers, audio, media handles and timers;
- long-running Live UI mode is explicit and visible in status.

`runtime_session_close` is cleanup. It is not the primary fix for idle CPU burn.
Idle safety must hold before close is called.

### 5.3 UI Live Mode

The Live UI may run continuously for interactive use, but it must be a client of
the same runtime authority.

The UI must show:

- connection state;
- session id;
- run state;
- mounted media refs;
- trace state if active.

If the MCP starts a session, the UI can observe/attach to that session. If the UI
starts a session, MCP can inspect/control that session by id. This is a product
requirement, not a nice-to-have.

### 5.4 Process Lifetime

Runtime lifetime is owned by the Runtime Daemon, not by clients:

- MCP reconnect must not reset, close, or fork runtime sessions.
- Browser reload must not reset, close, or fork runtime sessions.
- Workspace HTTP restart must not reset runtime sessions unless it is the daemon
  process itself.
- Closing the Runtime Daemon is the explicit operation that ends the runtime
  authority and all owned sessions.

## 6. Trace Startup Packaging

`runtime_session_start(trace_out=...)` must work from every supported runtime
mode:

- built `dist/`;
- source/dev execution;
- MCP launched from an arbitrary project directory.

The binary trace worker may not be resolved by assuming that a `.js` worker sits
next to a `.ts` source file.

Allowed implementation strategies:

- robust resolver that finds the emitted `dist` worker when running built code;
- dev resolver that loads the TypeScript worker through the same runtime as the
  parent process;
- embedded worker source string;
- single-file worker bundle emitted during build.

Acceptance is path-based, not implementation-based: an external LLM can start a
trace from a project directory outside the repo without module-not-found.

## 7. Drive-To-State Orchestration

The MCP needs high-level runtime operations, not only primitive stepping.

### 7.1 Screen/State Waits

Add or harden default-tool operations for:

- wait until screen stable;
- wait until screen text/prompt matches a predicate;
- wait until drive idle/busy transition completes;
- wait until IEC/drive activity quiets;
- run until PC/raster/mark with clear timeout diagnostics.

The output must include:

- stop reason;
- elapsed cycles/instructions/frames;
- current screenshot hash or text summary when available;
- trace mark suggestion if tracing is active.

### 7.2 Disk-Swap Prompt Flow

A multi-disk title needs a single documented operation:

```text
runtime_swap_disk_and_continue(
  session_id,
  drive=8,
  media=<project media ref/path>,
  confirm_input="\r",
  wait_for={ screen_not_contains: "INSERT", stable_frames: 3 }
)
```

The exact tool name can change, but the product capability must exist.

It must:

1. resolve the target disk through Spec 742 media ownership;
2. persist/eject the outgoing disk through the same path as every other mount;
3. insert the new disk;
4. emulate the media-change semantics required by the running program;
5. send the optional confirm input (`RETURN` by default for disk prompts);
6. run until the prompt advances or a bounded failure result is returned.

Failure must be diagnostic:

- prompt still visible;
- drive did not see media change;
- drive error channel status;
- timeout with last stable screen hash/text;
- mounted media id/name.

### 7.3 Human-Assisted Flow

The LLM must be able to stop and ask the user:

```text
Human: "The game asks for side 3. Should I mount wasteland_s3...?"
```

Then continue with a machine-readable action:

```json
{
  "tool": "runtime_swap_disk_and_continue",
  "args": {
    "session_id": "integrated-1",
    "media": "input/disk/wasteland_s3[...].g64",
    "confirm_input": "\r"
  }
}
```

This belongs in the 728 playbook and 730 next-step flow once implemented.

## 8. MCP Tool Surface

The default surface must expose enough runtime control for a fresh external LLM
to drive a game without full tools:

Required default tools or equivalent facades:

- `runtime_session_start`
- `runtime_session_status`
- `runtime_session_run`
- `runtime_session_close`
- `runtime_type`
- `runtime_joystick`
- `runtime_media_mount` / `runtime_media_swap`
- `runtime_swap_disk_and_continue` or equivalent high-level disk-prompt flow
- `runtime_mark`
- `runtime_trace_status`
- `runtime_trace_finalize`
- `trace_store_info`
- `trace_store_top_pcs`
- `runtime_query_events`

No default tool may instruct the LLM to use the old V3 WS server directly. If the
runtime authority is exposed over WS internally, MCP tools hide that transport.

The default surface must also make daemon state explicit:

- `runtime_server_status` or equivalent: reports daemon reachable/unreachable,
  endpoint, version, project dir and active sessions.
- `runtime_session_list` or equivalent: lets MCP discover UI-created sessions.
- Every `runtime_*` tool response must identify the daemon endpoint and session
  id it operated on when ambiguity is possible.

## 9. Non-Goals

- No VICE product workflow.
- No broad emulator rewrite.
- No new second UI.
- No automated full gameplay bot.
- No "just wait longer" solution.
- No raw WebSocket client as the documented LLM path.
- No second hidden runtime session to "mirror" UI or MCP. Shared state must be
  real shared authority, not synchronization between two emulators.
- No MCP-owned Runtime as the product topology.
- No UI-owned Runtime as the product topology.
- No "current process singleton" claim unless MCP and UI clients are proven to
  hit the same daemon process in the actual product topology.
- No hidden `C64RE_FULL_TOOLS` requirement.

## 10. Acceptance Gates

### 10.1 Worker packaging

New gate:

```text
e2e-runtime-trace-start-from-project
```

Runs the MCP server from a temp/project cwd outside the repo and proves:

- `runtime_session_start(trace_out=...)` succeeds;
- `.c64retrace` is created;
- `runtime_trace_finalize` creates/query-builds `trace.duckdb`;
- `trace_store_info` and `trace_store_top_pcs` read it.

### 10.2 No idle free-run

New gate:

```text
probe-runtime-idle-ownership
```

Starts a session through MCP, performs no run call for a short interval, and
asserts:

- CPU cycle count does not advance beyond documented startup budget;
- no background loop remains active;
- `runtime_session_close` releases the session.

Live UI continuous mode may have a separate test, but must be explicit.

### 10.3 Runtime Daemon Authority

New gate:

```text
e2e-runtime-daemon-authority
```

Proves:

- one Runtime Daemon process is started explicitly;
- UI connects to that daemon as a client;
- MCP connects to that daemon as a client;
- sessions created through MCP are visible through the UI/status service;
- the UI can attach to the MCP-created session and observe the same frame/cycle;
- the UI can pause/run that MCP-created session and MCP status sees the same
  state transition;
- sessions created through the UI/status service are visible through MCP;
- MCP can inspect/control the UI-created session by id;
- both surfaces report the same session id, mounted media, trace state and run
  state;
- MCP reconnect does not reset or fork the session;
- browser reload does not reset or fork the session;
- there is no product `startIntegratedSession` path outside the daemon.

This must be an end-to-end product-topology test. An in-process singleton test is
insufficient and may only be kept as a lower-level unit test.

### 10.4 Multi-disk drive-to-state

New gate:

```text
e2e-runtime-disk-swap-prompt
```

Use a small synthetic disk-swap fixture first. Real Wasteland is an optional
manual/product smoke, not the only gate.

The fixture must:

1. boot from disk A;
2. display "INSERT SIDE B";
3. poll the drive/media state in the same style a game would;
4. continue only after disk B is mounted and RETURN is sent;
5. emit a trace mark or screen state proving advancement.

Acceptance:

- MCP-only flow gets past the prompt;
- trace remains active across the swap;
- outgoing media persists according to Spec 742;
- failure output is diagnostic if the wrong disk is provided.

### 10.5 Wasteland manual proof

Manual proof is acceptable but not the only automated gate:

```text
Wasteland side 1 -> Start/menu -> insert requested side -> in-game/map state
```

Required evidence:

- trace file path;
- marks around menu, prompt, swap, in-game;
- mounted media refs;
- screenshot hashes or PNGs for prompt and post-swap state;
- no raw WS client;
- no VICE tools.

## 11. Implementation Slices

### 744.1 — Audit + service boundary

- Map every `startIntegratedSession` caller.
- Classify: product runtime, test helper, export/smoke, dev-only.
- Define `RuntimeSessionService` module and migrate product MCP start/status/run
  to it without changing behavior.
- Add `runtime_session_close` if missing.

### 744.2 — Trace worker packaging fix

- Fix `binary-log-worker` resolution for source/dev + built dist + arbitrary cwd.
- Add `e2e-runtime-trace-start-from-project`.

### 744.3 — Idle ownership

- Ensure MCP sessions do not free-run outside tool calls.
- Keep Live UI continuous mode explicit.
- Add `probe-runtime-idle-ownership`.

### 744.4 — Shared UI/MCP authority

744.4 is split into explicit sub-slices. Only 744.4c satisfies the product
architecture.

#### 744.4a — In-process service facade (interim, not product-complete)

- Wrap integrated-session-manager + RuntimeController into `RuntimeSessionService`.
- Migrate local callers to the facade where useful.
- Gate in-process sharing.
- This is allowed as groundwork only. It does not prove product co-working.

#### 744.4b — MCP co-hosted WS (rejected as final product topology)

- MCP co-hosting WS can demonstrate one process, but it makes the MCP process the
  Runtime owner.
- It fails the product requirement because MCP reconnect/restart resets the
  runtime and a separately-started UI WS still creates a second authority.
- Keep only as a dev/transitional mode if useful, clearly marked non-product.
- It must not be documented as the product solution.

#### 744.4c — Runtime Daemon Authority (required)

- Add a product Runtime Daemon entrypoint, e.g. `runtime:server` /
  `scripts/start-runtime-server.mjs`.
- Move product `IntegratedSession` ownership into that daemon process.
- UI Live connects to the daemon as a client.
- MCP `runtime_*` tools connect to the daemon as clients/proxies.
- If the daemon is unavailable, MCP fails clearly or starts it through an
  explicit daemon-start command; it never silently creates a private session.
- Retire or dev-label standalone `start-v3-server.mjs` and MCP co-hosting as
  non-product paths.
- Add `e2e-runtime-daemon-authority`.

### 744.5 — Disk prompt orchestration

- Add high-level disk-swap-and-continue operation.
- Implement media-change semantics on top of Spec 742.
- Add synthetic `e2e-runtime-disk-swap-prompt`.
- Document the Wasteland manual proof flow.

### 744.6 — Playbook / orchestrator integration

- Update Spec 728 playbooks and Spec 730 `agent_next_step` recommendations:
  when a game prompts for another side, recommend the high-level disk-swap flow,
  not raw WS and not internal media tools.

## 12. Done Criteria

Spec 744 is DONE when:

- there is one product Runtime Daemon authority for MCP + Live UI;
- `runtime_session_start(trace_out=...)` works from an arbitrary project cwd;
- MCP-created sessions do not free-run while idle;
- sessions can be closed cleanly;
- a disk-swap-prompting flow can be driven through MCP with trace active;
- no default product instructions mention starting the V3 WS server directly;
- BUG-027 is fixed with gates and resolution filled.

744 is not DONE if the shared authority only works because MCP co-hosts the WS or
because UI and MCP happen to run in one test process. The product proof must use
the real client/server topology: Runtime Daemon + UI client + MCP client.

---

## 744.4 Interim Implementation Notes (2026-05-31)

These notes document what was built before the architecture was tightened. They
are **not** DONE criteria and must not be read as permission to keep the product
topology this way.

### 744.4a — RuntimeSessionService authority (in-process groundwork)

### Split points removed
Both surfaces constructed sessions directly:
- MCP `runtime_session_start` / `runtime_diagnose_mm` → `startIntegratedSession`
  (`src/server-tools/headless.ts`).
- UI bootstrap → `startIntegratedSession` (`scripts/start-v3-server.mjs`).
The session-manager + controller registry were ALREADY module singletons, but no
single API owned the lifecycle and product callers reached past it.

### Service shape (`src/runtime/headless/runtime-session-service.ts`)
`runtimeSessions` (singleton) wraps integrated-session-manager + the controller
registry into one authority:
`start` (session + controller, PAUSED, no loop) · `get` · `list` · `attach`
(re-wires the broadcast sink → UI observes an MCP session and vice-versa) ·
`status` · `run`/`pause`/`resume` · `close` (finalize trace → dispose controller →
drop session, idempotent). Both surfaces import it; within one process they share
the SAME session ids + controllers (real shared state, not mirrors).

### Migrated onto the authority
- MCP `runtime_session_start`, `runtime_session_close`, `runtime_diagnose_mm`.
- UI `scripts/start-v3-server.mjs` (no private UI-only session).

### Still call `startIntegratedSession` directly — and why (allowed)
- `v2/scenario.ts`, `v2/rewind.ts`, `export/{screenshot,audio-export,video}.ts` —
  **one-shot, non-interactive**: build a session, use it once, discard; never shared
  with the UI/MCP live surface. Migrating them is cosmetic, not required for shared
  authority.
- `src/runtime/headless/c64/*-fidelity-tests.ts`, `smoke/load-matrix.ts`,
  `regress/runner.ts`, `trace/eof-trace.ts`, all `scripts/*` — **test/dev/export**
  harnesses, not the product runtime.

### Idle root cause + why 744.3 missed it
744.3 added `runtime_session_close` (cleanup). But cleanup only stops a loop that
already started — it is not the idle-safety mechanism. The real contract is that the
MCP path NEVER schedules an autonomous loop: `runtime_session_start` creates a PAUSED
session (no `controller.run()`), trace capture is passive, and `runtime_session_run`
is a one-shot synchronous `runFor`. `probe-744-idle-ownership` enforces this on the
REAL MCP stdio server (cycles do not advance during an idle wait, with and without
`trace_out`). BUG-027's ~100% was a long synchronous `runFor` the user couldn't stop
(no close tool) — not a background loop; 744.3's close fixed the "couldn't stop it",
744.4 proves "no loop in the first place".

### Gates
- `npm run smoke:744-4` (16/16) — in-process shared authority: MCP-created session
  visible/controllable as UI (same session + controller instance, run/pause shared
  state), UI-created session visible to MCP, close idempotent, and the interactive
  entry points use the authority (no direct `startIntegratedSession`).
- `npm run probe:744-idle` (8/8) — real MCP stdio path: no cycle advance while idle
  (with + without trace), close releases.
- Preserved: `smoke-v3-ws` 7/7 (UI renders + broadcasts), `e2e:744-2` 5/5,
  `probe:744-3` 9/9, `probe-single-path` 25/25.

### 744.4 status — what remains
**Single authority WITHIN a process: DONE.** The remaining piece is **cross-process
co-hosting**: the MCP server (stdio, IDE-launched) and the UI WS server (port 4312,
human-launched) are still separate OS processes → separate module singletons, so a
human cannot yet attach to an LLM's MCP session in PRODUCTION (only in-process, which
the gate proves). The next slice (744.4b) makes one process host both — e.g. the MCP
`cli.ts` also serving the V3 WS — so the authority singleton is genuinely shared at
runtime. The WS server's internal handlers still call `getIntegratedSession` /
`ensureRuntimeController` directly; they hit the same singletons (consistent) but
could be routed through `runtimeSessions.get/attach` for purity.

---

## 744.4b Interim Implementation — MCP co-hosted WS (rejected as product topology)

744.4a shared sessions only in-process. 744.4b attempted to solve the
cross-process split by making the IDE-launched MCP process also host the Live WS
when `C64RE_RUNTIME_WS=<port>` is set.

That proved a useful lower-level fact: if MCP and WS run in one process, both can
hit the same `runtimeSessions` singleton. It does **not** satisfy this spec's
product architecture.

### Why 744.4b is insufficient

- It makes MCP the Runtime owner. MCP reconnect/restart resets or replaces the
  Runtime, which violates the process-lifetime contract.
- It conflicts with an already-running standalone/UI WS on the same port and can
  fall back into split ownership.
- It requires the Runtime to be coupled to the IDE/MCP host lifecycle instead of
  being a stable product daemon.
- Its gates prove one-process sharing, not a stable Runtime Daemon with two
  independent clients.

### Allowed disposition

- Keep 744.4b code only as a dev/transitional mode while 744.4c is being built.
- It must be labeled non-product wherever documented.
- It must not be the install default.
- It must not mark 744.4 complete.

### Required replacement

744.4c replaces 744.4b with a Runtime Daemon topology:

```text
Runtime Daemon owns sessions
UI connects as client
MCP connects as client
MCP reconnect does not reset sessions
Browser reload does not reset sessions
```

---

## 744.4c Implementation — Runtime Daemon (2026-05-31)

The product runtime is now owned by a process-stable daemon. The daemon IS the V3
runtime WS server (port 4312) — we did NOT invent a second API; the browser UI
already speaks that protocol, and the MCP adapter speaks it too as a client. Both
hit the ONE `runtimeSessions` authority that lives in the daemon process.

### Topology shipped
```
C64RE Runtime Daemon  (scripts/runtime-daemon.mjs, ws://127.0.0.1:4312)
  ├── runtimeSessions (authority) + IntegratedSession(s)
  ├── V3WsServer (the runtime WS — UI transport)
  └── session/create + session/close handlers (the daemon lifecycle ownership)

Browser UI  → ws://127.0.0.1:4312 (V3 protocol)            ─┐ same
MCP runtime_* tools → RuntimeDaemonClient → ws://…:4312     ─┘ daemon, same sessions
```

### What changed
- `src/workspace-ui/v3-ws-server.ts` — added `session/create` (start+resetCold+trace)
  and `session/close` handlers so the daemon owns session lifecycle for BOTH surfaces.
- `src/server-tools/runtime-daemon-client.ts` (new) — MCP-side V3 WS JSON-RPC client.
  `isDaemonMode()` = `C64RE_RUNTIME_ENDPOINT` set. If the endpoint is set but the
  daemon is unreachable, calls fail with an actionable error — never a silent
  in-process private session (§236).
- `src/server-tools/headless.ts` — `runtime_session_start/status/run/close` +
  `runtime_render_screen` route to the daemon when `isDaemonMode()`, else in-process
  (tests/dev). The start handler hits the daemon BEFORE any in-process create, so no
  product path creates an `IntegratedSession` outside the daemon (§96).
- `src/cli.ts` — the 744.4b co-host is RETIRED. The MCP is a daemon client; it no
  longer hosts the runtime. A stale `C64RE_RUNTIME_WS` only logs a deprecation.
- `scripts/runtime-daemon.mjs` (new) + `npm run runtime:daemon` — the canonical
  daemon entry (V3WsServer + a default booted session). `scripts/workspace.mjs`
  skips the standalone WS when `C64RE_RUNTIME_ENDPOINT` is set.
- README + `mcp-config-example.json` set `C64RE_RUNTIME_ENDPOINT=ws://127.0.0.1:4312`
  and document `npm run runtime:daemon` as the product runtime.

### Acceptance — `npm run e2e:744-4c` (9/9), proving design §84-97
1 daemon starts; 4 MCP `runtime_session_start` creates the session IN THE DAEMON and
the UI `session/list` sees it (MCP→UI), UI+MCP read the same cycle counter; 5 UI
`debug/run` advances the SAME session MCP reads (UI→MCP control, 0→709428); 6 MCP can
status the UI-booted default session (UI→MCP); 7 **MCP reconnect (a new MCP process)
still sees the session — NOT reset** (cycles=749436); 8 **browser reload (a new WS
connection) still sees the session — NOT reset**; 9 the start handler routes to the
daemon before any in-process create.

### Slice 2 (remaining, honest)
Only the acceptance-critical MCP tools (start/status/run/close/render) are
daemon-routed. The other ~59 `runtime_*` tools (monitor/step/breakpoints/media/
trace-detail/input/inspect/snapshot) still reach an in-process session; in daemon
mode they currently error "no session" until they are routed through the client.
`runtime_session_run` `until`-conditions are also daemon-slice-2. The daemon API +
client are built to extend tool-by-tool.

### Status
- **744.4a DONE** (single in-process authority). **744.4b RETIRED** (MCP co-host —
  reset on reconnect). **744.4c DONE** (Runtime Daemon — stable shared authority,
  acceptance §84-97 green). §7 drive-to-state orchestration remains open.
