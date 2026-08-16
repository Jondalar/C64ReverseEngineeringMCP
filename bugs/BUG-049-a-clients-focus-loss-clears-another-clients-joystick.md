# Bug: a client's focus loss clears another client's joystick

- **ID:** BUG-049
- **Date:** 2026-08-15
- **Reporter:** human (GitHub issue #1, external user)
- **Area:** runtime
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: TRX64 `main` (reported against a binary self-reporting 0.2.0)
- Surface: MCP `runtime_joystick` + the workspace UI's WASD→joystick path, same session
- Tool / endpoint: `session/joystick_set`, `session/release_keys`,
  `crates/trx64-daemon/src/main.rs`, `ui/src/workbench/tabs/Live.tsx`

## What happened

`runtime_joystick` (port 2) drove the title menu of a game and then did nothing at
all once the game was in play. The browser UI's own WASD→port-2 path worked in the
same session, in the same game state, at around the same time. It read like the MCP
tool path was broken and the UI path was not.

It is not. Measured end to end against a sandbox daemon with nothing else attached —
using C64RE's own built client and the exact payload `runtime_joystick` sends — the
tool reaches the CPU:

```
cleared                   CPU reads $DC00 = $ff
joystickSet right=true    CPU reads $DC00 = $f7    bit 3 low
joystickSet up+fire       CPU reads $DC00 = $ee    bits 0+4 low
```

What breaks it is the other client:

```
MCP client sets right=true                 $DC00 = $f7
then UI session/release_keys               $DC00 = $ff
then a UI keyup (full-port joystick_set)   $DC00 = $ff
```

Two mechanisms, both in the shared-state family:

1. **`session/release_keys` cleared BOTH joysticks**, globally
   (`main.rs`, the focus-loss policy inherited from the TS `ws-server.ts:1459-1461`).
   The browser sends it on window `blur` **and** on every teardown of its input
   effect — whose deps are `[sessionId, runState, joyMode]`, so a mere run-state
   change fired a full input reset at the machine. A human alt-tabbing threw away a
   joystick an agent was holding.
2. **`session/joystick_set` writes the whole port**, not single bits. Every UI keyup
   sends all five bits, so the last writer wins outright.

The UI never noticed either one, because it re-sends its complete stick on every key
event and therefore heals itself within milliseconds. A tool that sets the state once
has nothing that re-asserts it.

## The evidence that hid the bug

The reporter's register readback — `$DC00` unchanged at `$7F` — looked like proof
that the injection never arrived. It proves nothing: `Machine::read_full` is the
side-effect-free peek, and at `$DC00` it returned `cia1.peek(addr)`, the bare latch.
The keyboard and both joysticks pull those pins low, and none of that was in the
peek, so the monitor showed the last value the KERNAL wrote while scanning and never
a key or a stick. Anyone debugging input through `runtime_monitor_memory` was
measuring nothing and had no way to tell.

Neither `$DC00` nor `$DC01` has a read side effect — that is `$DC0D` — so the peek
had no reason to answer differently from the CPU in the first place.

## Repro steps

1. Attach the workspace UI to a session and put a game in play.
2. `runtime_joystick` port 2, `right=true`.
3. Switch focus away from the browser window (or change the run state).
4. The direction is gone; the game never sees it.

## Resolution

- **Root cause:** one joystick state per port on a shared machine, writable in full
  by any client, plus a focus-loss policy that spoke for input it did not own. Same
  family as BUG-048: shared state, and every client assuming it is alone.
- **Fix:**
  - `session/release_keys` releases KEYS only. Clearing a stick has its own verb,
    `session/joystick_clear`, which takes a `port`.
  - `Live.tsx` clears only the port it drives (`joyMode`), and only when it was
    actually holding something. Teardown still releases the UI's own keys — a key
    left pressed because a dependency changed would be worse — which is safe now
    that `release_keys` no longer reaches a joystick.
  - `$DC00`/`$DC01` peeks compose the pins. The formula moved into
    `keyboard::cia1_pa_pins` / `cia1_pb_pins`, one copy, used by both the CPU read
    (`FullBus::io_read`) and the peek (`Machine::read_full`, `peek_lens`). It had
    been written out twice and present in only one of them.
- **Gate proving the fix:**
  `a_joystick_survives_another_clients_focus_loss_and_is_visible_to_a_peek` —
  asserts the peek sees the stick at all (the second half of the bug), that
  `release_keys` leaves it held, that `joystick_clear` still releases it, and the
  same for port 1 on `$DC01`. Workspace: 1022 passed.
- **Regression risk:** low. The removed lines were a policy, not a mechanism, and the
  verb that implements the policy properly already existed.
- **Still open for the reporter:** their binary self-reports 0.2.0 while the commit
  they cite is 0.4.1 — they are not testing what they think. The decisive run is the
  same in-game test with no UI attached.
