# Bug: the machine free-runs between two calls, so no boot recipe is repeatable

- **ID:** BUG-050
- **Date:** 2026-08-17
- **Reporter:** human (GitHub issue #2), reproduced with a control here
- **Area:** runtime
- **Severity:** high
- **Status:** open

## Environment

- Branch / commit: `master` @ 4734d877 (C64RE), `main` @ a257693 (runtime)
- Surface: mcp default — `runtime_session_start` / `runtime_media_mount` /
  `runtime_session_run`, and the daemon RPCs underneath them
- Project dir: a throwaway probe dir; the live session was never touched
- Tool / endpoint: `session/power`, `media/mount`, `debug/run`, `session/state`

## What happened

A session is left **RUNNING** after the operations a client uses to set it up.
The machine advances at roughly real time (measured: **1,985,352 cycles in 2000 ms
of wall clock**, ≈ 993k cycles/s) while the client is composing its next call. So
every gap between two calls — a round trip, an LLM thinking, a human reading a
screenshot — is part of the machine's state, and no two attempts at the same
recipe start their first command from the same place.

The consequence is issue #2 exactly: the same disk, the same typed
`LOAD"*",8,1`, the same joystick sequence, and three different outcomes.

There is a second, sharper form of the same defect. `session/power op:"on"` sets
`session.running = true`, so the machine starts before the client can stop it.
Ten power-cycles, each followed immediately by `debug/pause`:

```
  0: power-on reports 0, state reports 0,     pc=$fce2
  1: power-on reports 0, state reports 0,     pc=$fce2
  2: power-on reports 0, state reports 19657, pc=$fd77   <-- one whole frame ahead
  3: power-on reports 0, state reports 0,     pc=$fce2
  4: power-on reports 0, state reports 0,     pc=$fce2
  5: power-on reports 0, state reports 19657, pc=$fd77   <-- again
  6..9: 0, pc=$fce2
```

Two of ten fresh machines were already a frame into the KERNAL reset before the
pause landed. **There is no way over the API to obtain a machine that is stopped
at a known cycle.** That is the whole bug in one sentence.

## Expected

After the calls that set a session up, the machine stands still until the client
runs it. A client that owns the clock can then express a recipe as a schedule,
and the same schedule gives the same machine.

Powering on should not start the machine, or should offer not to. "Fresh
machine" must mean one cycle count, not two.

## Repro steps

1. Spawn the runtime the way C64RE spawns it (streaming on by default, Spec 767).
2. `media/mount` a disk.
3. Read `session/state` twice, 2 s apart, doing nothing in between.
4. Power-cycle repeatedly, pausing immediately each time, and read the clock.

Minimal call sequence:

```text
media/mount   { session_id: "integrated-1", path: "<disk>" }
session/state -> { streamPump: true, runState: "running", c64Cycles: 39314 }
[sleep 2000 ms]
session/state -> DELTA 1985352 cycles, still running
```

## Evidence

The reproduction, and the control that closes it. Same recipe every time —
power-cycle, mount, wait N ms, type `LOAD"*",8,1`, run 2M, run 8M, hash the
screen. **The only variable is how long the caller took to send its first
command.**

Golden-Disk-style G64, machine left running (what a client gets today):

```text
  delay   cycles@type    cyclesEnd     PC     screen
      0        19657     10083620   $e5d4   9c49e4383f736466
    300       294856     10358813   $e5cd   1341238aa5b04784
    900       884563     10948515   $e5d4   4abd0060ce678ece
   1800      1788783     11852727   $e5d1   cdbc9492c52f278f
   3000      2968212     13032190   $0159   0078942da4ac9128

  distinct screens: 5 of 5      distinct PCs: 4 of 5
```

Same disk, same delays, one line added — `debug/pause` right after the mount,
and the boot expressed in cycles instead of milliseconds:

```text
  delay   cycles@type    cyclesEnd     PC     screen
      0      3000002     13000007   $0186   f203291302916f21
    300      3000002     13000007   $0186   f203291302916f21
    900      3000002     13000007   $0186   f203291302916f21
   1800      3000002     13000007   $0186   f203291302916f21
   3000      3000002     13000007   $0186   f203291302916f21

  distinct screens: 1 of 5      distinct PCs: 1 of 5
```

A second disk (a 1988 D64), uncontrolled, diverges the same way — 5 of 5 distinct
screens, 5 of 5 distinct PCs. Controlled, it collapses to one screen; its PC
differs on the first row only, and that difference is exactly the 19657 cycles of
the power-on race above.

**The machine is deterministic. The recipe was the variable.** Spec 812's reel
runs 100+ million cycles through a fastloader from a cold boot and hashes
identically three times in a row — on the same core, driven by a schedule instead
of by call timing.

## Scope guess

- `crates/trx64-daemon/src/main.rs` — `session/power` sets `st.session.running =
  true` on power-on; `media/mount` leaves the controller running.
- `src/server-tools/headless.ts:193` — `runtime_session_run` picks between a
  blocking bounded run and `runCapped` depending on `streamPump`. The daemon
  streams by default (Spec 767), so the capped path is the normal one. It is not
  itself the leak — after it returns the machine is paused (measured: delta 0) —
  but `runCapped` also returns on a wall-clock **deadline** with the machine
  still running (`daemon-client.ts:331`), which would leak on a slow host.
- No tool in the MCP surface pauses the session after setting it up.

## Notes / follow-up

- This is the same defect family as BUG-048 and BUG-049: one piece of shared
  machine state that each client assumes it alone moves.
- The reporter's attempt 3 ends at `$C001 LDA $1f / BPL` with `CINV` still
  `$EA31` — the game's IRQ never installed. That is consistent with keys arriving
  at a boot that was further along (or less far) than the recipe assumed, but it
  is NOT proven here: reproducing that specific end state needs the reporter's
  own two disk sides.
- A fix is not merely "pause after mount": the fix that makes recipes repeatable
  is that a client can express the whole schedule at once. Spec 812 already does
  this for capture; the same shape would serve boot recipes.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
