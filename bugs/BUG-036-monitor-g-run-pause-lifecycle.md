# Bug: Monitor has no coherent pause/resume — `g` only sets PC, "Run" calls a missing op

- **ID:** BUG-036
- **Date:** 2026-06-03
- **Reporter:** human (Wasteland testing) + llm (VICE cross-check)
- **Area:** ui-v3 / runtime
- **Severity:** high (core interactive debug loop is broken)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened
On the **live workbench monitor** (`MonitorPanel` → WS `monitor/exec`,
`v3-ws-server.ts:~1812`), `g` does NOT resume continuous execution the way the Run
button does. Its handler:
```
g:  ctrl.pause()                       // halt the autonomous loop FIRST
    if (addr) c64Cpu.pc = addr
    if (no breakpoints):  s.runFor(20_000)        // runs ONE frame, then stops
    else:                 runFor-loop until a bp  // synchronous, cap 20M instr
    → ends HALTED
```
So `g` is a **bounded synchronous burst** (one frame with no breakpoints, else
run-to-breakpoint) that leaves the session paused. The **Run button** is
`ctrl.run()` / `ctrl.continue()` → **continuous autonomous free-run**
(`runState = running`, live-paced). They diverge: `g` does not "unpause" into
free-running, and with no breakpoint it advances only one frame.

This is also not VICE-faithful: VICE `g` resumes and free-runs until a breakpoint
hits (endless), it does not stop after one frame.

Note (corrected): the run-state machine ALREADY EXISTS —
`RuntimeController.run()` / `continue()` / `pause()` / `runState`
(`src/runtime/headless/debug/runtime-controller.ts:~199`). `g` simply bypasses it
(it pauses + drives `runFor` by hand) instead of entering the running state. There
is no explicit `pause` command verb either (you stop by landing on a `bk`).

(The earlier draft of this bug described a different, DEAD monitor path —
`Monitor.tsx` → `runtime/call` → `MonitorAPI.goto` = set-PC-only. That path is the
second, divergent monitor tracked by BUG-037; the LIVE monitor is `monitor/exec`.)

## Expected (VICE is the reference)
VICE drives resume via the `exit_mon` flag — the monitor loop breaks and the CPU
continues when a command sets it:
- `g <addr>` → `mon_jump`: set PC **and** `exit_mon = exit_mon_change_flow` (resume).
- `g` (no addr) → `mon_go`: `exit_mon = exit_mon_continue` (resume at current PC).
- `x` / `exit` → leave monitor, continue. `z`/`n`/`return`/`until` arm a step/temp-bp
  then resume.

Our runtime is autonomous (self-runs @ ~1 MHz, Spec 701), so the analog is a session
**run-state** (`running` | `halted`): `bk`/`pause` → halt the loop; `g`/`x`/`resume`
→ un-halt (optionally set PC first); `z`/`n`/`ret`/`until` → un-halt with a stop
condition. The Run and Pause UI buttons must drive the same one path.

## Repro steps
1. Open the v3 workbench Live tab, start/attach a session, let it free-run (Run).
2. `bk $0810` → hits → halts. (works)
3. `g` with no breakpoint set → expect: resume free-running. Actual: advances ONE
   frame (`s.runFor(20_000)`) then stops ("ran 1 frame").
4. `g` ≠ the Run button (`ctrl.run()` continuous free-run). No explicit `pause` verb.

## Expected (corrected)
`g [addr]` should (optionally set PC then) enter the continuous running state via the
existing `ctrl.run()`/`continue()` — free-run until a breakpoint — i.e. the SAME path
the Run button uses, VICE-faithful. Add an explicit `pause` verb (= `ctrl.pause()`).
The Run/Pause buttons and `g`/`x`/`pause` must all drive the one `runState` machine.

## Evidence
- LIVE `g` handler (pause + bounded burst): `src/workspace-ui/v3-ws-server.ts:~1809-1836`.
- Run-state API already present: `src/runtime/headless/debug/runtime-controller.ts:~199`
  (`continue()` → `run()`), plus `run()`/`pause()`/`runState`.
- Step/focus verbs (already wired to FlowTracker, NOT broken): `monitor/exec`
  `z/n/ret/focus/sf/nf` → `ctrl.flow.*` (`v3-ws-server.ts:~1853-1899`).
- VICE reference: `monitor.c` `mon_go`/`mon_jump` + `exit_mon` (continue-until-bp).

## Notes
Smaller than first thought: the run-state machine exists; `g` just needs to use it
(and add `pause`). The proper model + button parity belong to Spec 754 §3.1.
Focus/step (Spec 623 §4.3) is already done and live — not part of this bug.

## Resolution

Fixed in Spec 754 P1 (§3.1). The monitor command dispatch was extracted into the
one canonical processor `src/runtime/headless/debug/monitor-shell.ts`
(`runMonitorCommand`); `monitor/exec` is now a thin adapter. `g` → `ctrl.continue()`
(enters the SAME running run-state the Run button uses), `g <addr>` → set PC + continue,
`x` → resume alias, with a parked-on-breakpoint skip. The old bounded-burst
(`ctrl.pause()` + 1-frame `runFor`, ending HALTED) is gone. `until <addr>` is the
synchronous run-to-landing (lands halted; the agent path stays `runtime_until`).
Halting is the toolbar Pause (`debug/pause`); no `pause` verb (VICE-faithful).

**Gate:** `npm run e2e:754` Part B (22/22) — `g` enters running, `g <addr>` sets PC,
`x` resumes, `until` lands halted at the target, and a breakpoint halts a RUNNING
machine (resume→bp→pause under warp). + `probe:single-path` 25/25.
