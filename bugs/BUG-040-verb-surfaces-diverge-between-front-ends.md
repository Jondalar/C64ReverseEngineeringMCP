# Bug: Verb surfaces diverge between the two front-ends, and `pause` means two different things

- **ID:** BUG-040
- **Date:** 2026-08-14
- **Reporter:** human (typed `/pause` in the C64RE monitor)
- **Area:** runtime
- **Severity:** high (feature parity between front-ends is a stated requirement; and one verb is actively ambiguous)
- **Status:** partly fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: `spec-808-rewind-transport` / `spec-809-marks-and-branches`
- Surface: C64RE web monitor (`MONITOR` panel, session `integrated-1`) vs the TRX64 cockpit
- Tool / endpoint: WS `monitor/exec` vs `trx64-cli` `exec_line`

## What happened

`/pause` and `/freeze` in the C64RE monitor answer `unknown command`. Both work in the
TRX64 cockpit.

The `/` prefix is a **trx64-cli convention**: `exec_line` handles `/verb` itself and only
falls through to `monitor/exec` for everything else. The daemon's monitor has no
`/`-prefixed verbs at all, so C64RE — which talks to `monitor/exec` directly — never sees
the cockpit layer or anything in it.

Where the two surfaces stand:

| | TRX64 cockpit | C64RE monitor |
|---|---|---|
| pause the machine | `/pause` | **missing** |
| run the machine | `/run` | **missing** |
| mount media | `/mount` | **missing** |
| warp pacing | `/warp` | **missing** |
| reset | `/reset` | `reset` ✓ |
| power | `/power` | `power` ✓ |

Reset and power reached the daemon at some point; run, pause, mount and warp never did.

**And worse than missing: `pause` without the slash DOES exist in the C64RE monitor — and
means something else.** Spec 808 added it as the transport pause (stop playback). So the
same word stops the machine in one front-end and stops a replay in the other. That
ambiguity was introduced by 808 without checking what the name already meant elsewhere.

## Expected

Every verb that changes machine state exists in the **daemon**, so both front-ends have it
by construction. The `/` prefix stays as client-side input sugar for the same verb. And one
word means one thing on every surface.

## Repro steps

1. Open the C64RE workspace monitor on a live session.
2. Type `/pause` → `unknown command: /pause. Try 'help'.`
3. Type `/freeze` → same.
4. In the TRX64 cockpit, `/pause` pauses the machine.
5. In the C64RE monitor, `pause` is accepted — and stops transport playback, not the machine.

## Evidence

```text
> /pause
unknown command: /pause. Try 'help'.
> /freeze
unknown command: /freeze. Try 'help'.
```

## Scope guess

- `crates/trx64-cli/src/engine.rs` — `exec_line`, the `/verb` table (`run`, `pause`,
  `mount`, `warp`, `power`, `reset`, `window`, `quit`)
- `crates/trx64-daemon/src/main.rs` — `run_monitor`, which has `reset`/`power`/`pause` but
  no `run`/`mount`/`warp`
- The daemon already has the CAPABILITY behind all of them (`session/play`,
  `session/pause`, `session/warp`, `media/mount`) since the 808 rebuild — what is missing
  is the monitor verb in front of it.

## Notes / follow-up

- **Same family as BUG-037** ("two divergent monitor command processors"), which was fixed
  by consolidating the *parsers*. The split came back one layer up: not two parsers now,
  but two verb SETS, because the cockpit kept a private layer above the shared one.
- Root cause is the one named in `project_trx64_daemon_owns_all_state`: a client that owns
  anything about the machine has to have it reconciled by hand, forever. Here the client
  owns a verb table.
- The owner's conclusion, worth recording because it goes further than this bug: input
  routing, validation and nearly all output formatting belong in the daemon. `/verbs` and
  monitor verbs go straight through; even the `!` filesystem verbs belong there, because
  when the daemon runs in a container (`wl-trx64`) **its** filesystem is the one holding
  the disks — a `ls` showing the laptop answers the wrong question. What legitimately
  stays client-side: `quit`, window open/close, terminal-local rendering (scrollback,
  clear, colour) and the keystroke capture itself.
- One consequence of moving output formatting: the daemon does not know the terminal
  width. The client should **report** its width on connect and on resize rather than
  formatting locally — same shape as the audio-epoch fix, where the client reports what it
  is instead of guessing what the daemon needs.

---

## Resolution — daemon side done, C64RE UI side still open

- **Root cause:** the `/` prefix is a `trx64-cli` convention. `exec_line` handles `/verb`
  itself and only falls through to `monitor/exec` for the rest, so the daemon has no
  `/`-verbs and a front-end without a cockpit layer never sees anything in it. `run`,
  `warp`, `mount` and `eject` existed only there.
- **Fixed:** `run` and `warp` are daemon monitor verbs now, and `pause` means ONE thing on
  every surface — it stops the machine **and** the transport, and prints the ringbuffer
  range. The cockpit's `/warp` delegates to the daemon verb, so both front-ends execute one
  implementation and print one wording.
- **Gate:** `machine_verbs_exist_in_the_daemon_and_pause_means_one_thing` — pause stops
  both and reports the buffer, run sets the intent, warp toggles daemon state, and all
  three appear in the monitor help.
- **STILL OPEN — `mount` / `eject` as monitor verbs.** `media/mount` is a large inline
  handler rather than a reusable function, and extracting it is exactly the work
  **BUG-041** does (the `media_path` content detection). Folded in there rather than
  extracted twice.
- **STILL OPEN — the C64RE UI must render status the way the TUI does.** Unifying the
  verbs is half the job: if the workspace UI keeps composing its own status display, the
  two surfaces drift again through the OUTPUT instead of the input. `session/state` now
  carries `transport` (mode, direction, position, range), `warp` and `audioEpoch`, and
  every transport reply carries a ready-to-print `message`. The UI should render those
  rather than derive its own — same rule, same reason: one place computes, everyone else
  displays.
- **Regression risk:** low. Verbs were added, not changed, with one deliberate exception:
  bare `pause` in the C64RE monitor used to stop only the replay and now stops the machine
  too. That is the point of the fix, and it is the meaning a human expects from the word.
