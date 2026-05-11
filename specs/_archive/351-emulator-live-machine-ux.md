# Spec 351 — Emulator Live machine UX

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Depends:** 350

## Goal

Make `Live` the primary human operating surface for the headless C64 VM.
It should feel like a focused emulator/debugger cockpit, not a set of
debug buttons around an image.

## Required regions

```text
Header/status:
  project, session id, connection, run state, cycle, fps

Machine controls:
  Power Cycle, Reset, Run/Pause, Step, Snapshot, Warp placeholder

Main area:
  C64 screen
  Inspector

Lower area:
  Monitor with [max]

Media strip:
  Drive 8/9 status, mounted file, mount/eject/swap actions
```

## Machine controls

- `Power Cycle`: full cold boot/reset sequence.
- `Reset`: normal C64 reset.
- `Run/Pause`: toggles VM execution.
- `Step`: one instruction or one debugger step using the runtime monitor
  semantics.
- `Snapshot`: stores a runtime snapshot and shows the created id/path.
- `Warp`: reserved control, disabled until implemented.

There must be no LOAD/RUN convenience buttons in V1 of this UI.

## Screen behavior

Running state:

- Click on the C64 screen focuses keyboard input into the VM.
- A visible focus indicator shows whether keyboard input is captured.
- The screen keeps C64 aspect/proportions and scales responsively.
- The screen must not be hard-coded to one desktop pixel size.

Frozen state:

- Pause freezes a stable machine state.
- Explore overlay becomes available.
- Keyboard capture is suspended while Explore tools are active.
- Resume removes Explore overlay and returns keyboard input behavior.

## Inspector

The right inspector shows current runtime state:

- CPU: PC, A, X, Y, SP, flags, current opcode.
- VIC: raster line/cycle, mode, bank, screen pointer, charset/bitmap
  pointer, border/background colors.
- CIA1/CIA2: key registers, timers, IRQ state, relevant port bits.
- IEC: ATN/CLK/DATA current state.
- Drive 8/9: motor, LED, track, sector where available, image path.
- Breakpoints/watches summary.

The inspector should show exact values, not explanatory prose.

## Empty/error states

- If no frame is available, show a stable C64-screen-sized empty state.
- If screenshot/frame fetch fails, show the error in the inspector/status
  area, not as collapsed raw text in the middle of the page.
- If the backend disconnects, controls disable clearly.

## Acceptance

- User can mount media, power cycle, pause, resume, reset, step, and take
  a snapshot from Live without changing tabs.
- Clicking the screen captures keyboard input while running.
- Pausing freezes the visual state and activates Explore affordances.
- No auto LOAD/RUN happens when selecting a disk.
- Inspector reflects at least CPU, VIC, IEC, and drive state.
