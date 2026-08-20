# Bug: F9/F10/F12 moved the machine and nobody drew the result

- **ID:** BUG-053
- **Date:** 2026-08-20
- **Reporter:** human
- **Area:** ui-v3 / runtime
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: TRX64 `ede9556`, C64RE `88367568`
- Surface: ui-v3 (Live tab) — the terminal cockpit is unaffected
- Project dir: n/a (live shared session)
- Tool / endpoint / tab: Live tab, `transport/key`

## What happened

In the C64RE UI, F11 pauses and resumes. F9, F10 and F12 do nothing at all.

## Expected

The four transport keys the daemon advertises, all of them, on both front-ends:
F9 frame back, F10 play backwards, F11 pause/play, F12 frame forward.

## Repro steps

1. Live tab, machine running.
2. F11 → pauses. Picture freezes, run-state flips. Correct.
3. F9 / F12 → nothing visible.
4. F10 → nothing visible.

## Evidence

The keys were not lost, and the wire was not the problem. `transport/key` was
called, answered, and the machine actually moved:

```text
transport/key {key: 12}  →  {"handled": true, "verb": "frame +1", "transport": {...}}
session/state            →  c64Cycles advanced by one frame
```

The canvas kept showing the frame from the moment of the pause.

## Scope guess (optional)

`TRX64 crates/trx64-daemon/src/streaming.rs` (the pump),
`ui/src/workbench/tabs/Live.tsx` (the reply).

## Notes / follow-up

The terminal front-end never showed this because it renders from its own poll —
it asks for a frame, so it always has the current one. The browser is PUSHED to,
which makes "who presents this?" a question the terminal never has to answer.

---

## Resolution (fill on fix)

- **Root cause:** two, and both are the same shape — a paused machine was assumed
  to be a MOTIONLESS machine.

  1. The VIC frame push lived inside the pump's `if running` branch
     (`streaming.rs`). The rewind transport moves the machine from inside a
     JSON-RPC handler; the pump is the only thing that pushes pictures; while
     paused it pushed none. So `frame -1` / `frame +1` did exactly what they were
     asked and the result was never drawn. The same hole swallowed a monitor `z`
     or `n` on a paused machine.
  2. `play back` sets a DIRECTION and leaves the stepping to the pump — and the
     pump ticked the transport only in that same `if running` branch. So F10 in
     the one state you press it in, paused, took no step at all.

  On top of both: `transport/key` answers `handled:false` with a reason for a key
  it cannot use, and errors ("no anchors yet — the ring fills while the machine
  RUNS") for a move it cannot make. The Live tab discarded the whole reply, so a
  correct and informative refusal reached nobody and read as a dead key.

- **Fix commit:** this branch.
  - `streaming.rs`: the paused branch ticks the transport when a direction is set,
    and presents one frame when the machine MOVED — `paused_present_due(force, clk,
    last)`, i.e. the forced present that already existed for `checkpoint/restore`,
    OR a changed master clock. Deliberately not "present every iteration while
    paused": a canvas render costs real time (the multicolour-bitmap path most),
    and a frozen machine would pay it 50×/s to redraw the identical picture.
  - `Live.tsx`: prints the daemon's own words under the screen for a few seconds —
    `reason`, else `message`, else the transport line. Nothing is composed in the
    client, so the browser cannot word the same event differently from the terminal.

- **Gate proving the fix:**
  - `streaming.rs::a_paused_machine_that_moved_owes_a_frame` — the present rule on
    its own: same clock and no force → no push; stepped back, stepped forward, or
    forced → push.
  - `main.rs::play_back_steps_a_paused_machine` — cadence 1, run, pause, `play
    back`, one wall-clock step's worth of time, tick → the machine's clock MOVED
    and the transport holds it. Red before the fix (the pump never ticked it).
  - Full suites green: `trx64-daemon` 176, `trx64-core` 294.

- **Regression risk:** low. The running branch is untouched; the paused branch
  only gained work it does when something actually changed.
