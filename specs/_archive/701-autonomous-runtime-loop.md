# Spec 701 — Autonomous Runtime Loop

Status: DONE (2026-05-21 CEST)  
Created: 2026-05-21 CEST  
Owner: runtime / debugger / v3 UI

Implemented on branch `codex/615-gcr-decode-fidelity`:
`RuntimeController` (`src/runtime/headless/debug/runtime-controller.ts`) owns
the paced loop + run/pause/pacing/breakpoints + self-halt; `debug/*` +
`session/set_pacing` WS API; UI reduced to commands + visualization. §7 live
binary VIC frame transport (raw RGBA push, latest-frame-wins, no per-frame
PNG); UI `<canvas>` blit. PAL presents every frame (50fps) per user request.
Tests: `tests/unit/debug/runtime-controller.test.ts` 8/8; smoke `npm run
smoke:701` 10/10 (incl. frame push). Gates: build:mcp + check:1541-fidelity
(0 FAIL) + smoke:v3-ws (7/7) green. NTSC pacing + fixed-ratio remain the
documented later extension (§5.2/§5.4).

## 1. Problem

The integrated headless runtime is currently deterministic when called directly, but the live v3 UI owns the practical timing loop.

Current state:

- `IntegratedSession.runFor(...)` advances only when a caller invokes it.
- `ui/src/v3/tabs/Live.tsx` drives live execution by calling `session/run` roughly every `20ms`.
- `session/run` in `src/workspace-ui/v3-ws-server.ts` advances one requested cycle budget and returns.
- Run/pause state is held by the UI (`runState`), not by the core/session.
- Breakpoint checking exists inside `runFor(...)`, but live halt/resume behavior depends on the UI polling loop and command handling.

This is not VICE-shaped. In VICE, the machine core runs autonomously at its configured pacing, and the UI/monitor observes or commands it. The GUI does not own the emulation clock.

## 2. Goal

Move live execution ownership into the backend/runtime.

The core/session must own:

- run state,
- pacing mode,
- breakpoints,
- stop reason,
- breakpoint hit metadata,
- step/continue semantics.

The UI must become a command and visualization layer.

## 3. Non-Goals

- Do not change CPU/VIC/CIA/SID/IEC/1541 tick semantics.
- Do not reintroduce global cycle lockstep for `drive1541="vice"`.
- Do not use React timers as the emulation clock.
- Do not implement Warp by skipping emulated cycles.
- Do not make monitor correctness depend on screenshot polling.

## 4. Runtime Model

Introduce a backend-owned run loop per live session.

State:

```ts
type RuntimeRunState =
  | "running"
  | "paused"
  | "stopped";

type RuntimePacingMode =
  | "pal"
  | "warp"
  | "fixed-ratio";

interface RuntimeStopInfo {
  reason: "pause" | "breakpoint" | "step" | "jam" | "error";
  pc: number;
  cycles: number;
  breakpointId?: number;
}
```

The loop advances the existing `IntegratedSession` with `runFor(..., { cycleBudget, breakpoints })`.

The loop, not the UI, decides:

- how many cycles to run per chunk,
- whether to sleep to maintain PAL pacing,
- whether to run flat-out in Warp,
- when to stop on breakpoint,
- when to broadcast stopped/running state,
- when to publish presentation frames/status over WebSocket.

## 5. Pacing

### 5.1 PAL Pacing

PAL pacing targets C64 wall-clock speed:

- about `985248` C64 cycles/sec,
- about `19656` to `19705` cycles per visible PAL frame depending on the local convention already used by the runtime.

The implementation must schedule by accumulated cycle debt, not by assuming one UI frame request equals one emulation frame.

Internally, PAL still computes every VIC-II cycle and every PAL frame. Presentation throttling is allowed only after the internal frame exists.

Default live presentation target:

- PAL core cadence: about `50Hz`.
- PAL WebSocket/UI presentation cadence: `25fps` by default, i.e. publish every second completed frame or latest completed frame at that cadence.

The skipped presentation frame is not skipped in emulation. It is only not sent to the UI.

### 5.2 NTSC Pacing

NTSC support is a later extension of the same pacing layer.

Required model:

- NTSC core cadence: about `60Hz`, using the correct NTSC C64 cycle rate and VIC geometry for the selected machine.
- NTSC WebSocket/UI presentation cadence: `30fps` by default, i.e. publish every second completed frame or latest completed frame at that cadence.

As with PAL, presentation throttling must not skip internal VIC-II work.

### 5.3 Warp Pacing

Warp is host pacing only:

- no wall-clock sleep,
- larger cycle chunks,
- UI/audio/frame publication throttled,
- same emulated cycle order as PAL mode.

Warp is allowed to be slower than realtime if the host cannot compute faster than realtime. Warp means "unthrottled", not "fake faster".

Warp presentation target:

- publish latest completed frame at a bounded UI rate, e.g. `15fps` to `30fps`,
- do not queue every generated frame if the UI cannot keep up,
- prefer "latest frame wins" over accumulating a WebSocket backlog.

### 5.4 Fixed Ratio

Optional later mode:

- `0.5x`, `1.0x`, `2.0x`, etc.
- Uses the same pacing engine as PAL, with a scaled cycle/sec target.

## 6. Debugger Ownership

Breakpoints must be core-owned.

Required behavior:

- Breakpoint list lives in backend/session debug state.
- Run loop checks breakpoints before each instruction through the existing `runFor` breakpoint path or an equivalent internal primitive.
- On breakpoint hit, loop stops itself immediately.
- Backend records stop info:
  - breakpoint number/id,
  - PC,
  - cycles,
  - registers.
- Backend broadcasts `debug/stopped`.
- UI displays the stopped state; it does not infer it from a failed or delayed poll.

Resume semantics:

- `debug/continue` must not immediately re-hit the same breakpoint unless explicitly requested.
- Implement a deterministic "step past current breakpoint once" rule or a temporary ignore-until-PC-changes rule.
- This rule must be backend-owned and covered by tests.

Step semantics:

- `debug/step` executes exactly one instruction while paused.
- `debug/next` can be added later, but must be defined separately.
- Step does not depend on Live tab frame polling.

## 7. WebSocket API

Replace live timing ownership with command/state APIs.

Required commands:

- `debug/run { session_id, pacing? }`
- `debug/pause { session_id }`
- `debug/continue { session_id }`
- `debug/step { session_id }`
- `debug/break_add { session_id, pc }`
- `debug/break_del { session_id, id }`
- `debug/break_list { session_id }`
- `debug/state { session_id }`
- `session/set_pacing { session_id, mode, ratio? }`

Required broadcasts:

- `debug/running`
- `debug/paused`
- `debug/stopped`
- `debug/breakpoint_hit`
- `session/frame_available`
- `session/state`
- optional binary frame payloads for presentation frames

Live frame transport:

- The Live UI must not use `session/screenshot` PNG/base64 as its normal
  frame stream.
- `session/screenshot` remains a manual/export/debug primitive.
- Default live transport should be a binary WebSocket frame:
  - metadata: session id, frame number, C64 cycle, width, height, pixel
    format,
  - payload: latest completed frame.
- Preferred first implementation:
  - palette-indexed 8-bit pixels plus 16-color RGBA palette, or
  - raw RGBA if simpler.
- Raw RGBA is acceptable on localhost at 25/30fps:
  `392 * 272 * 4 ~= 426KiB/frame`, about `10.6MiB/s` at 25fps.
- Palette-indexed is cheaper and C64-shaped:
  `392 * 272 ~= 107KiB/frame`, about `2.7MiB/s` at 25fps.
- PNG/base64 is too much per-frame CPU/GC/IO overhead for live display.

MPEG/H.264 policy:

- MPEG/H.264 is appropriate for export/recording and optional remote
  spectator streaming.
- It is not the default debugger display transport because it adds encoder
  latency, decoder buffering, GOP/keyframe behavior, and makes exact
  frame-level debugger presentation harder.
- If added later, it must be a presentation-only stream. The monitor and
  debugger still consume exact backend state and frame numbers, not decoded
  video timing.

Compatibility:

- Keep `session/run` only as a deterministic manual/headless primitive.
- `session/run` must no longer be used by the Live UI as the timing source.

## 8. UI Responsibilities

The v3 Live UI must not own the emulation clock.

Required changes:

- Buttons send backend commands:
  - Run -> `debug/run`
  - Pause -> `debug/pause`
  - Step -> `debug/step`
  - Warp -> `session/set_pacing { mode: "warp" }` plus `debug/run`
- UI polls or receives screenshots/status independently of emulation advancement.
- Screenshot/frame refresh may use a timer or backend `frame_available` events, but it must not advance the machine.
- Default Live UI presentation:
  - PAL: `25fps`
  - NTSC: `30fps`
  - Warp: bounded latest-frame stream, `15fps` to `30fps`
- The UI may display fewer frames than the emulated VIC-II generates.
- The UI must not request one emulated frame per rendered browser frame.
- The UI should paint binary frame payloads to a canvas/ImageBitmap path,
  not replace an `<img>` with PNG data URLs for every frame.
- Monitor updates from `debug/stopped` and `debug/state`.

The UI is a window onto the machine, not the machine clock.

## 9. Gates

### 9.1 Core Determinism

From the same snapshot:

1. Run `N` cycles via direct `session/run`.
2. Run `N` cycles via backend autonomous loop in PAL mode.
3. Compare CPU/VIC/CIA/drive state.

Expected: identical.

### 9.2 Breakpoint Determinism

Set a breakpoint at a known PC.

Required:

- backend stops at the breakpoint without UI polling,
- reported PC equals breakpoint PC,
- cycle count is stable across repeated runs,
- continue does not immediately re-hit the same breakpoint unless requested,
- one-step while paused advances exactly one instruction.

### 9.3 UI Independence

Run backend loop while the Live UI is disconnected or not polling screenshots.

Required:

- machine advances,
- breakpoints still stop,
- `debug/state` reports correct final state after reconnect.

### 9.4 Presentation Throttle

Run PAL core pacing with presentation set to `25fps`.

Required:

- internal VIC frame counter advances at PAL cadence,
- UI receives roughly every second completed frame,
- CPU/VIC/CIA/drive state after `N` internal frames matches a no-presentation run,
- WebSocket does not build an unbounded frame backlog.
- live presentation does not call `renderToPng` / `session/screenshot` for
  every frame.
- binary frame transport reports stable frame number and cycle metadata.

Run NTSC later with presentation set to `30fps` under the same rules.

### 9.5 Loader Regression

Run existing gates after replacing Live timing ownership:

- `npm run build:mcp`
- `npm run check:1541-fidelity`
- 616 LOAD matrix
- 617 SAVE matrix
- 618 DD00/custom-loader gates

### 9.6 Warp Equivalence

From the same snapshot:

- run `N` cycles PAL paced,
- run `N` cycles Warp paced,
- compare state and pixel snapshot.

Expected: identical for equal cycle count.

## 10. Implementation Plan

### 701.1 Runtime Controller

Add a backend runtime controller around `IntegratedSession`.

Responsibilities:

- session run state,
- pacing mode,
- loop lifecycle,
- chunk scheduling,
- internal frame accounting,
- presentation frame throttle,
- breakpoint list,
- stop info,
- event broadcast hooks.

### 701.2 Backend API

Add the `debug/*` and `session/set_pacing` WebSocket handlers.

Keep `session/run` as a manual primitive, but remove it from live timing use.

### 701.3 Breakpoint Semantics

Move all live breakpoint ownership into the controller.

Implement deterministic continue-past-current-breakpoint behavior.

### 701.4 UI Conversion

Update Live controls:

- remove frame-driving `session/run` loop,
- use backend commands,
- receive or poll screenshots/status without advancing emulation,
- default to PAL `25fps` / NTSC `30fps` presentation,
- wire Warp button to pacing state.

### 701.5 Tests

Add controller-level tests for:

- run/pause,
- breakpoint hit,
- continue,
- step,
- UI-disconnected run,
- PAL vs Warp equal-cycle equivalence.

## 11. Acceptance Criteria

Spec 701 is complete when:

- [x] the backend owns live run/pause/pacing/breakpoint state,
- [x] the UI no longer calls `session/run` as a frame clock,
- [x] breakpoints halt deterministically without UI polling
      (smoke:701 — loop self-halts at $EA31, no polling),
- [x] Warp is host-pacing only and state-equivalent for equal cycles
      (controller test: PAL/Warp chunking == unchunked, equal cycles ⇒ equal state),
- [x] existing 1541/VIC/load/save/custom-loader gates remain green
      (build:mcp + check:1541-fidelity 0 FAIL + smoke:v3-ws 7/7),
- [x] manual headless `session.runFor(...)` remains available for tests and scripts.
- [x] §7 live binary frame transport (no per-frame PNG/base64); UI canvas blit;
      latest-frame-wins.
