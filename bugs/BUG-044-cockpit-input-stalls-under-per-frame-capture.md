# Bug: Cockpit input stalls intermittently — Enter does nothing until the 3rd–8th try

- **ID:** BUG-044
- **Date:** 2026-08-14
- **Reporter:** human
- **Area:** other (cockpit TUI) / runtime
- **Severity:** high (the cockpit feels broken; a command you can SEE on the line does not run)
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## What happened

Recall a command with Up — it is **clearly visible** on the command line — press Enter, and
nothing happens. No echo, no output. Press Enter again, and again; somewhere around the
third to eighth attempt it goes through.

Reported after: `/mount <Tab>`, `!pwd`, `r`, then `!pwd` recalled from history.

## What was ruled out

Measured, not assumed:

- `!pwd` works as a one-shot (`trx64cli mon "!pwd"` prints the path) — the verb is fine.
- The log has **no dedup** (`push_log` appends every line), so a repeat is not being
  swallowed.
- Up/Down are the **only** history entry points — there is no Ctrl-R path to misbehave.
- The echo `> {line}` is **unconditional** for a non-empty line. No echo therefore means
  the Enter branch was not reached at all — not that the command ran quietly.
- Not BUG-043 (Tab leaving the line attached to history). That was real and is fixed, but
  it produces a WRONG command, not a missing one, and it is deterministic rather than
  "works on the 5th try".

## Mechanism

Intermittent, and eventually succeeding, is not a logic bug — it is a **stalled event
loop**. And the loop's own comment already documents this failure family from a previous
round:

> Handle EVERY queued event, then draw once. Drawing first (and handling one event per
> iteration) let the visible line lag behind the edit buffer whenever events arrived
> faster than frames — which is how a recalled history entry could be shown while the
> buffer already held the next one

The TUI loop polls at 50 ms and refreshes its panel snapshot every 50 ms via
`engine.snapshot()`, which is an RPC that takes the daemon's state lock. The pump thread
takes the same lock every 5 ms.

**What changed today:** Spec 808 made the default capture cadence **1** (60-second rewind
window). The pump now captures a full checkpoint **every frame — 50/s instead of 2/s** —
each one doing ring work while holding that lock, plus cart/disk auto-persist and the
recorder feed which moved onto the same pump path (BUG-041 work). The input loop is
competing with a far busier pump than it was this morning.

That fits the symptom precisely: keystrokes are not lost, they are *delayed*, and a
retried Enter eventually lands in a window where the lock is free.

## Expected

Input is never delayed by machine work. A key the user can see on the line runs when they
press Enter, the first time.

## Scope guess

- `crates/trx64-cli/src/tui.rs` — the 50 ms poll and the 50 ms `engine.snapshot()`
- `crates/trx64-daemon/src/main.rs` — `"session/tick"`, which now holds the state lock
  across autopersist + autocapture + recorder feed + the advance
- `stream_maybe_autocapture` at cadence 1

Two directions, and the choice matters:

1. **Shorten the lock hold in the pump** — capture into a staging buffer and hand it to
   the ring outside the critical section. Fixes the cause; more invasive.
2. **Stop the input loop blocking on the daemon** — the panel snapshot is for display, so
   a stale frame is harmless; it should never make a keystroke wait.

(2) is the one that matches the day's architecture rule: the client renders what it last
heard and never blocks on the machine to do it. (1) is worth doing anyway, because any
other client hits the same wall.

## Notes

Found by taking "it works on the 3rd try" seriously as a *timing* signal rather than
looking for a logic error — after two wrong hypotheses that both assumed a deterministic
bug.

---

## Resolution

- **Root cause:** the TUI refreshed its panel snapshot every 50 ms unconditionally, over an
  RPC that takes the daemon's state lock — while the cadence-1 default (Spec 808) made the
  pump hold that lock fifty times a second for a full checkpoint.
- **Fix:** direction (2) — the input queue is drained first, and the panel only refreshes
  when nothing is waiting. The panel is display; a stale frame is invisible and a swallowed
  keystroke is not.
- **Regression risk:** low. The panel can lag by one frame while the user types, which is
  the intended trade.
- **Still worth doing:** direction (1), shortening the lock hold in the pump itself, so any
  other client is protected too rather than only the one that learned to yield.
