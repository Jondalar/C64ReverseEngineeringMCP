# Spec 350 — Emulator Workbench UX master

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Supersedes UX surface of:** 260-269
**Keeps architecture from:** 260, 272

## Goal

Replace the current tab-heavy V3 debug UI with a focused human
emulator workbench. The browser UI is for operating and inspecting the
headless C64 runtime, not for scenario/export automation. LLM-facing
scenario and export flows remain available through runtime APIs/tools.

## Product cut

The emulator UI has one primary purpose: operate a live C64 machine and
inspect its exact frozen/runtime state.

Top-level UI:

```text
C64RE Analysis Dashboard
  [C64 Emulator] -> opens dedicated Emulator Workbench window/tab

Emulator Workbench
  Live
  Trace
```

`Live` contains C64 screen, machine controls, media mounting, inspector,
and monitor. `Trace` contains the swimlane/timeline workbench.

Explore is not a top-level tab. Explore tools appear inside Live only
when the VM is paused/frozen.

## Layout target

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ C64 Emulator       project: Murder       paused/frozen       cycle ...      │
│ [Power] [Reset] [Run/Pause] [Step] [Snapshot] [Warp*]  Drive 8: motm.g64    │
├────────────────────────────────────────────┬───────────────────────────────┤
│                                            │ Inspector                     │
│              C64 SCREEN                    │ CPU / VIC / CIA / IEC        │
│                                            │ Drive 8/9                     │
│ running: click focuses keyboard into VM    │ Breakpoints / watches         │
│ frozen: drag/select explores screen state  │                               │
├────────────────────────────────────────────┴───────────────────────────────┤
│ Monitor                                                       [max]         │
│ >                                                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

`*` Rewind/forward/warp may be disabled placeholders until the runtime
capability is complete, but the UX location is reserved.

## Remove from first human UI pass

- Top-level `Scenarios` tab.
- Top-level `Export` tab.
- `LOAD"*",8,1` button.
- `RUN` button.
- Separate `Snapshots` tab.
- Separate `Media` tab as a main work surface.

These flows are not deleted from backend APIs. They are removed from the
first human emulator surface to keep the UI focused.

## Required behavior

- Screen is the visual anchor of the Live view.
- Keyboard input goes directly into the VM after the user clicks the C64
  screen while running.
- When paused/frozen, screen click/drag is captured by Explore tools
  instead of keyboard input.
- Media mount is explicit and does not auto-type LOAD/RUN.
- Reset and power cycle are distinct controls.
- Monitor is always available under the screen and can be maximized.
- Inspector updates with the active session state and selected context.
- Trace selection can jump back to Live at the selected cycle/snapshot
  when runtime support exists.

## Acceptance

- Dashboard has a single `C64 Emulator` action that opens the workbench.
- Workbench opens into Live with screen, controls, inspector, monitor,
  and media status visible without switching tabs.
- There are only `Live` and `Trace` top-level workbench tabs.
- Scenario/export controls are not visible in the first workbench pass.
- Existing runtime APIs remain callable by LLM tools.
