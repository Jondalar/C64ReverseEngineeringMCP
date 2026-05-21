# Spec 700 — Runtime Optimization

Status: DRAFT  
Created: 2026-05-20 CEST  
Owner: runtime / fidelity

## 1. Goal

Bring the integrated VICE-shaped runtime from the post-622 baseline toward stable realtime or better, without changing emulation semantics.

The current VIC-II result is treated as correctness-critical. Any optimization that changes visible pixels, raster timing, IEC/DD00 timing, KERNAL LOAD/SAVE behavior, or VICE1541 behavior is a bug unless it is explicitly justified by VICE source parity and covered by gates.

Primary target:

- Integrated runtime reaches >= 1.0x PAL realtime on the M4 Pro reference machine.
- If profiling shows a hard plateau before 1.0x, document the bottleneck with profiler evidence and keep all correctness gates green.

Non-goals:

- No frame skipping.
- No alternate simplified renderer.
- No "larger logical tick" that skips C64/VIC/CIA/1541 cycles.
- No reintroduction of global per-cycle lockstep for `drive1541="vice"`.
- No drive worker/thread split unless deterministic synchronization cost is proven favorable.

## 2. Current Baseline

Spec 622 §4.0 removed the un-VICE-shaped forced global `CycleLockstepScheduler` for `drive1541="vice"`.

Observed effect from Spec 622:

- Throughput improved from about `0.50x` to about `0.82x` realtime.
- `616` LOAD matrix: `15/16` green, with `the_pawn_s1.g64` documented expected-fail.
- `617` SAVE matrix: `9/9` green.
- `motm` DD00 swimlane: `0` mismatches.
- `lnr-s1` large KERNAL LOAD completed.
- Scramble / KRILL-style `$DD00` timing improved because event-catchup is closer to VICE's event model than the former forced lockstep.

This means the next optimization pass must start from the post-622 event-catchup path, not from old cycle-lockstep assumptions.

## 3. Hard Constraints

### 3.1 VIC-II Fidelity

The current VIC-II output is the visual oracle for this optimization spec.

All VIC-related changes require:

- pixel-diff gate against known-good snapshots,
- raster/cycle state sanity checks,
- no lost badline/sprite/border behavior,
- no hidden fallback renderer.

### 3.2 Tick Semantics

The CPU `tick()` path is the logical VICE-style `CLK_INC` equivalent. It advances the machine by one C64 cycle and calls the VIC/CIA/SID hooks at the correct points.

Increasing the "tick size" is not a valid optimization if it means fewer observable cycles. The valid optimization forms are:

- reduce JavaScript cost per tick,
- batch only spans proven to have no intermediate observable events,
- specialize hot paths without changing state order,
- remove redundant bridging/allocation.

### 3.3 Threading

Node.js does not automatically make one emulator session multi-threaded. Existing worker-thread usage is for parallel scenario execution, not for splitting one live C64 session.

A separate 1541 worker is not a first-line optimization:

- `$DD00` fastloaders need tight event ordering between C64 CIA2 and drive VIA/IEC state,
- SharedArrayBuffer/Atomics synchronization can cost more than it saves,
- the current measured hot path is still dominated by VIC drawing and drive CPU execution, not by idle host-thread availability.

Worker threads remain useful for CI and batch test parallelism.

## 4. Component Potential

### 4.1 VIC Draw Pipeline

Files:

- `src/runtime/headless/vic/literal/vicii-draw-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-cycle.ts`

Profile signal from Spec 622 before §4.0:

- `draw_graphics`: about `10.4%`
- `vicii_cycle`: about `9.3%`
- `draw_sprites`: about `6.8%`
- `draw_sprites8`: about `5.9%`
- `update_sprite_xpos`: about `4.9%`
- `vicii_draw_cycle`: about `3.9%`
- `draw_graphics8`: about `3.8%`

Potential: very high.

Findings:

- Many hot buffers are already typed arrays, which is good.
- `colors` is still a JS `number[]`; this can create less stable element access than a fixed typed array.
- Hot functions repeatedly cross object boundaries through `vicii.*`, `raster.*`, and shared state objects.
- The draw code has small, per-cycle/per-pixel helper calls where V8 monomorphism matters.

Recommended work:

- Re-profile post-622 first; old percentages are directionally useful but stale.
- Convert immutable numeric tables such as `colors` to typed arrays where safe.
- Hoist stable object references and scalar fields inside the hot draw functions.
- Keep hot helper call sites monomorphic: same object shapes, same array kinds, stable numeric return types.
- Consider specialized draw variants only when they are direct literal equivalents of the current code and pixel-diff clean.

Expected gain: medium to high, likely the biggest remaining pool. A realistic first pass target is `+10%` to `+25%` throughput if the profiler still matches Spec 622.

Risk: high. VIC correctness must gate every change.

### 4.2 Drive 6502 Core

File:

- `src/runtime/headless/vice1541/drive_6510core.ts`

Profile signal from Spec 622:

- `drive_6510core_execute`: about `15.3%`

Potential: high.

Findings:

- The generated/literal 6510 core contains many nested helper functions inside the execute path.
- This can force V8 to allocate or maintain function contexts and can show up as function-context overhead.
- Opcode state uses object-shaped structures in places where scalar locals or typed tables may be cheaper.

Recommended work:

- Audit with `--trace-opt --trace-deopt` and a CPU profile before editing.
- Hoist helper functions out of hot execute scope where this does not change VICE-shaped ownership or state ordering.
- Replace avoidable per-call object state in opcode dispatch with stable scalar locals or typed tables.
- Keep the source mapping to VICE explicit; do not "rewrite" the CPU core into a new emulator.

Expected gain: medium to high, likely `+5%` to `+15%`.

Risk: medium-high. LOAD/SAVE/DD00 gates must remain green.

### 4.3 C64 CPU Core

File:

- `src/runtime/headless/cpu/cpu65xx-vice.ts`

Profile signal from Spec 622:

- CPU cycle/micro-op functions were smaller than VIC and drive core but still measurable.

Potential: medium.

Findings:

- Trace/bus object allocation is mostly guarded, so do not optimize trace paths first.
- The hot `tick()` path is correctness-sensitive because it defines CPU/VIC/CIA/SID order.
- Public getters/setters are not the primary issue if hot internals use direct fields.

Recommended work:

- Keep `tick()` order identical.
- Reduce helper overhead only where profiler proves it is hot.
- Avoid object creation in hot per-cycle paths.
- Keep microcoded instruction stepping unchanged unless covered by CPU/VIC timing gates.

Expected gain: low to medium, likely `+2%` to `+8%`.

Risk: high if tick order changes; otherwise medium.

### 4.4 1541 Rotation / GCR

File:

- `src/runtime/headless/vice1541/rotation.ts`

Profile signal from Spec 622:

- `rotation_1541_gcr`: about `1.6%`

Potential: low to medium.

Findings:

- Some fields are typed as unions such as `Uint32Array | number[]`, which can produce polymorphic access.
- This subsystem is correctness-sensitive for G64/D64, weak sectors, CRC behavior, halftracks, and copy protection.

Recommended work:

- Stabilize hot arrays to one concrete type where VICE parity permits.
- Do not simplify rotation semantics.
- Keep Pawn/CRC expected-fail documentation separate from performance changes.

Expected gain: small, likely `+1%` to `+3%`.

Risk: medium-high because disk behavior is fragile.

### 4.5 Integrated Session / Scheduler

Files:

- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/kernel/event-catchup-strategy.ts`
- `src/runtime/headless/kernel/headless-machine-kernel.ts`

Potential: medium.

Findings:

- Spec 622 removed the main scheduler performance and correctness bug: forced global lockstep in vice-drive mode.
- The remaining risk is accidental object allocation or repeated bridge computation around instruction stepping, status sampling, and IEC line propagation.
- The event-catchup model is now a correctness feature, not just a performance feature.

Recommended work:

- Keep `drive1541="vice"` on event-catchup unless an explicit opt-in requests cycle lockstep for diagnostics.
- Profile bridge overhead around `catchUpDrive`, `iecLineDrive`, and CIA2 writes.
- Avoid status/debug object creation during hot running unless a trace is active.
- Do not merge C64 and drive into one global cycle loop again.

Expected gain: low to medium, likely `+2%` to `+5%`.

Risk: high if DD00 timing changes.

### 4.6 UI / WebSocket / Debug Panels

Files:

- UI/server code around integrated session status and debug rendering.
- `ui/src/v3/tabs/Live.tsx`
- `src/workspace-ui/v3-ws-server.ts`

Potential: separate from core runtime throughput.

Findings:

- UI FPS and emulator Mcyc/s must be measured separately.
- Heavy debug status snapshots can make the UI feel slow even when the emulation core is correct.
- There is currently no emulator-core host-pacing/throttle abstraction.
- Live mode is paced indirectly by the browser:
  - `Live.tsx` calls `session/run` with `cycles: 19705`,
  - then calls `session/screenshot`,
  - then schedules the next iteration with `setTimeout(tick, 20)`.
- The server `session/run` handler only executes the requested C64 cycle budget. It does not sleep, throttle, or decide realtime/warp policy.
- The current disabled Warp button in `MachineControls.tsx` is a UI placeholder only.

Recommended work:

- Add separate metrics for emulation throughput and UI frame/render latency.
- Throttle debug/status snapshots when the user is not inspecting them.
- Do not optimize renderer UI by changing C64/VIC state generation.
- Move live pacing policy out of the React polling loop and into an explicit runtime/session pacing mode.

Expected gain: user-perceived responsiveness can improve, but this may not increase emulation Mcyc/s.

Risk: low if isolated.

### 4.7 Worker Threads

Potential: low for one live session, high for batch test throughput.

Findings:

- Existing worker pool is appropriate for scenario/test parallelism.
- A live drive-worker split would need deterministic shared-cycle synchronization.
- DD00 fastloaders can require very frequent C64-drive synchronization, which reduces the value of a separate thread.

Recommendation:

- Do not start with live-session multithreading.
- Use workers to run independent scenarios, load matrices, and profile batches in parallel.
- Revisit drive-worker only after VIC and drive-core monomorphism work is exhausted.

## 5. Required Gates

Every optimization batch must run:

- `npm run build:mcp`
- `npm run check:1541-fidelity`
- 616 LOAD matrix
- 617 SAVE matrix
- 618 DD00/custom-loader gates when touching IEC/CIA/drive timing
- VIC pixel-diff snapshots when touching any VIC file
- Throughput benchmark before/after with the same seed, disk, machine mode, and runtime flags

Recommended benchmark scenarios:

- BASIC idle/warmup
- KERNAL LOAD large file
- Scramble/KRILL `$DD00` fastloader window
- Maniac Mansion or another known VIC-sensitive visual scene
- MOTM or Polarbear custom-loader window

## 6. Execution Plan

### 700.0 Baseline Freeze

Record post-622 numbers before any new code change:

- exact commit,
- Node version,
- machine,
- runtime flags,
- Mcyc/s and realtime ratio,
- UI FPS separately,
- all gate results.

No optimization starts until this is written down.

### 700.1 Profiling Harness

Create or formalize a repeatable runtime perf command.

Requirements:

- headless,
- deterministic scenario,
- warmup separated from measurement,
- reports C64 cycles, wall time, drive cycles, and realtime ratio,
- can optionally run Node CPU profiling.

### 700.2 Monomorphism / Deopt Audit

Run a focused V8 audit:

- CPU profile,
- `--trace-opt`,
- `--trace-deopt`,
- check for megamorphic inline caches in VIC draw and drive CPU hot paths.

Output is a ranked list of hot call sites, not code changes.

### 700.3 VIC Draw Pass 1

Small safe optimizations only:

- typed immutable tables,
- local reference hoisting,
- stable numeric operations,
- no algorithmic rewrite.

Gates:

- pixel diff zero,
- runtime benchmark improved or neutral,
- all loader gates unchanged.

### 700.4 VIC Draw Pass 2

Only if 700.3 is clean:

- specialize proven-hot draw paths,
- reduce per-pixel/per-cycle helper overhead,
- keep literal behavior visible in code comments.

### 700.5 Drive Core Pass

Reduce closure/context/object overhead in `drive_6510core.ts`.

Rules:

- VICE source ownership remains clear.
- No semantic CPU rewrite.
- No changed interrupt/alarm ordering.

### 700.6 CPU Tick Pass

Only profiler-backed changes in the C64 CPU hot tick/execute path.

Rules:

- no changed tick order,
- no changed VIC/CIA/SID hook order,
- no larger logical cycles.

### 700.7 UI Responsiveness Pass

Separate UI/debug overhead from core emulation.

Rules:

- no runtime semantics changes,
- status snapshots can be throttled,
- debugger fidelity remains available when requested.

### 700.8 Threading Decision

Write a short decision record:

- keep workers for batch tests,
- reject live drive-worker for now unless a prototype proves better than event-catchup,
- document synchronization requirements if revisited.

### 700.9 Warp / Host Pacing Mode

Implement VICE-style Warp as host pacing, not as an emulation shortcut.

Current state:

- No true host-pacing layer exists in the runtime core.
- The Live UI acts as an implicit realtime driver by requesting one PAL-frame cycle budget (`19705`) roughly every `20ms`.
- The backend `session/run` endpoint is already unthrottled for the requested cycle budget.

Required model:

- Add an explicit pacing mode:
  - `realtime`
  - `warp`
  - optional later: `fixed-ratio`
- Realtime mode targets PAL cadence by scheduling frame/cycle chunks against wall-clock time.
- Warp mode removes the PAL wall-clock wait and runs larger chunks as fast as the host allows.
- Both modes call the same `IntegratedSession.runFor(..., { cycleBudget })` path.
- The emulated machine must see the same number and order of CPU/VIC/CIA/SID/IEC/1541 cycles for a given cycle budget.

Implementation guidance:

- Do not change CPU/VIC/drive tick sizes.
- Do not skip frames in the emulation.
- In warp mode, only reduce UI/audio work:
  - send latest framebuffer less often,
  - drop or disable realtime audio,
  - keep input events ordered at cycle boundaries or at chunk boundaries with documented latency.
- Prefer a backend-owned runloop over React-driven polling:
  - UI sends `session/set_pacing { mode }`,
  - backend advances the session in chunks,
  - backend emits frames/status at configured presentation cadence.
- Keep `session/run` as a deterministic manual stepping primitive.

Warp acceptance gates:

- Run `N` cycles in realtime mode and warp mode from the same snapshot; compare CPU/VIC/CIA/drive state.
- Pixel snapshot after the same frame count is byte-identical.
- 616/617/618 gates are unchanged.
- DD00 custom-loader gates are unchanged.
- No oracle capture may rely on wall-clock timing in warp mode; compare by cycle, PC, event, or frame number only.

## 7. Acceptance Criteria

Spec 700 is complete when:

- runtime reaches >= `1.0x` realtime on the reference machine, or the remaining bottleneck is proven and documented,
- VIC pixel gates are zero-diff,
- `check:1541-fidelity` has `0 FAIL`,
- 616/617/618 gates remain green with documented expected-fails unchanged,
- no global vice-drive cycle-lockstep regression,
- no hidden simplified runtime path,
- VICE-style Warp is documented as host-pacing only, with no semantic cycle skipping,
- all changes are committed in small, profiler-backed batches.

## 8. Current Recommendation

Do not start with threads and do not "increase the tick".

Start with:

1. freeze the post-622 baseline,
2. re-profile the event-catchup runtime,
3. optimize the VIC draw path for monomorphic typed-array access,
4. then reduce drive CPU closure/object overhead.
5. implement Warp only after the pacing layer is explicit, so it cannot accidentally become a second emulator mode.

This order matches the known hot-path evidence and preserves the DD00 correctness gained by Spec 622.
