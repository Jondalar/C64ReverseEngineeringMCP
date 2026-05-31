# Spec 744 — Runtime Session Authority + Drive-to-State Orchestration

**Status:** ACTIVE (2026-05-31) — created after BUG-027 showed that the binary
trace path, media write-through and Live UI can each be partly correct while the
product still cannot drive a real multi-disk game to an observable state through
MCP.  
**Owner:** runtime session service / MCP runtime facade / Live UI backend /
media orchestration / trace startup packaging  
**Depends on:** Specs 724, 726.B, 742, 743  
**Related bugs:** BUG-027, BUG-013, BUG-025  

## 1. Problem

The product runtime has no single session authority.

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

That split made BUG-027 possible:

1. `runtime_session_start(trace_out=...)` failed because the binary trace worker
   was resolved as `src/.../binary-log-worker.js`.
2. A disk-swap-prompting game could not be advanced headlessly with confidence.
3. A runtime session could consume a core while not being actively driven by a
   tool call.

## 2. Product Rule

There is exactly one product runtime session authority.

```text
Project RuntimeSessionService
  owns RuntimeSession lifecycle
  owns session ids and status
  owns run/pause/stop/close
  owns media mount/swap/eject through Spec 742 MediaRef/MountedMedia
  owns trace start/finalize through Spec 726.B

MCP runtime tools
  call RuntimeSessionService

Live UI
  calls RuntimeSessionService

Scenario / playbook runners
  call RuntimeSessionService
```

No product path may create a private `IntegratedSession` that cannot be observed
or controlled by the other product surface.

The implementation may keep a single Node process or may expose the service over
HTTP/WS/stdio. The requirement is semantic ownership: one authority, one session
registry, one media model, one trace lifecycle.

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

Names may change, but these responsibilities must exist.

```ts
interface RuntimeSessionService {
  start(input: RuntimeStartRequest): Promise<RuntimeSessionHandle>;
  get(sessionId: string): RuntimeSessionHandle | undefined;
  list(): RuntimeSessionSummary[];
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

## 5. Session Lifecycle Rules

### 5.1 Start

`runtime_session_start` must:

- resolve project-local or absolute media through the 742 media service;
- create exactly one session in the runtime authority;
- optionally start a 726.B trace;
- return the session id, media refs, run state, trace state and project path.

### 5.2 Idle

MCP-created sessions must not free-run when no runtime tool call is active.

Rules:

- after `runtime_session_start`, the session is either paused or runs only the
  explicit startup budget documented in the tool output;
- after `runtime_session_run` returns, the session is not burning CPU in the
  background;
- `runtime_session_close` is available as a default runtime tool and releases
  trace writers, audio, media handles and timers;
- long-running Live UI mode is explicit and visible in status.

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
starts a session, MCP can inspect/control that session by id.

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

No default tool may instruct the LLM to use the old V3 WS server directly.

## 9. Non-Goals

- No VICE product workflow.
- No broad emulator rewrite.
- No new second UI.
- No automated full gameplay bot.
- No "just wait longer" solution.
- No raw WebSocket client as the documented LLM path.
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

### 10.3 Shared authority

New gate:

```text
smoke-runtime-session-authority
```

Proves:

- sessions created through MCP are visible through the UI/status service;
- sessions created through the UI/status service are visible through MCP;
- both surfaces report the same session id, mounted media and run state.

If implementation keeps one process, this can be an in-process service test. If
implementation uses HTTP/WS, it must be an end-to-end test.

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

- Remove/retire product paths where UI creates a private session unseen by MCP.
- UI status connects to the runtime authority and displays session id/run state.
- Add `smoke-runtime-session-authority`.

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

- there is one product runtime session authority for MCP + Live UI;
- `runtime_session_start(trace_out=...)` works from an arbitrary project cwd;
- MCP-created sessions do not free-run while idle;
- sessions can be closed cleanly;
- a disk-swap-prompting flow can be driven through MCP with trace active;
- no default product instructions mention starting the V3 WS server directly;
- BUG-027 is fixed with gates and resolution filled.
