# Bug: two run flags, so pause does not stop the machine

- **ID:** BUG-048
- **Date:** 2026-08-15
- **Reporter:** llm (WL1 session, verified here against the source)
- **Area:** runtime
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: TRX64 `main`, 0.4.1 (the `wl-trx64` play sidecars)
- Surface: daemon JSON-RPC (`transport/toggle`, `debug/run`, `session/state`)
- Project dir: n/a
- Tool / endpoint / tab: `crates/trx64-daemon/src/main.rs`

## What happened

Pause did not stop the machine, and `session/state` reported `runState: "running"`
for a machine nobody was advancing.

The daemon carried **two** flags for the one fact "the machine should advance":

| flag | read by | set by |
|---|---|---|
| `play_intent` | `session/tick`, the transport | `session/play`, `session/pause`, `transport/toggle`, power, autostart |
| `session.running` | the `--stream` loop, `free_run_input_warning` | `debug/run`, `debug/continue`, power, reset, CRT mount |

The WL editor starts the machine with `debug/run` and pauses it with F11 →
`transport/toggle`. The pause branch cleared `play_intent` and `transport.playing`
and never touched `session.running`, so the flag the debugger path runs on stayed
true and the machine kept consuming cycles.

`session/state` then reported the **OR** of the two:

```rust
let run_state = if st.play_intent || st.session.running { "running" } else { "paused" };
```

One expression cannot be right when its two inputs are set and cleared by
different verbs. It answered "running" for a frozen machine and "running" for a
paused one — two opposite lies from the same line.

`session/tick` papered over the gap by translating one flag into the other on
every tick:

```rust
if st.session.running {
    st.play_intent = true;
    st.session.running = false;
}
```

That block is the tell. It exists only because the tick could not trust the flag
it read.

## Expected

The machine runs or it does not. Pause stops it whoever started it, and
`runState` reports that one fact.

## Repro steps

1. `session/power {op:"on"}`
2. `debug/run {}` — the machine advances
3. `transport/toggle {}` — replies `action: "pause"`
4. `session/tick` — the machine keeps consuming cycles
5. `session/state` — `runState: "running"`

## Evidence

WL1 reported both halves independently; both reproduce from the source. The
second half is visible without running anything: `main.rs:8607` was an OR over
two independently-managed fields.

## Scope guess

`crates/trx64-daemon/src/main.rs` — `play_intent` (the field), `session/tick`,
`session/play`, `session/pause`, `transport/toggle`, the monitor `run`/`pause`
verbs, `session/state`.

## Notes / follow-up

This is Spec 808's own bug, half-fixed. 808 removed the CLI cockpit's private
`running: AtomicBool` because two truths about one fact need reconciling forever
— and then kept a second copy inside the daemon, with a doc comment declaring the
split deliberate:

> *Distinct from `session.running`, which stays what it was: the AUTONOMOUS loop's
> flag (debug/run), which must be false for a manual tick to be legal.*

The tick did not enforce that; it adopted the flag instead. The seam was closed
to a client's width and left open to a daemon's.

One detail in the original report is wrong and worth recording: the play sidecars
run **without** `--stream` (see `docker/Dockerfile`'s ENTRYPOINT), so no autonomous
loop is running there. The cycles come from `debug/run` → `run_debug_control` →
`run_until_break(.., DEBUG_RUN_BUDGET, ..)`, a bounded synchronous chunk per call.
Same flag asymmetry, different pump.

---

## Resolution

- **Root cause:** two fields for one fact. `play_intent` and `session.running`
  were set and cleared by disjoint sets of verbs, read by disjoint code paths,
  and reported as an OR.
- **Fix commit:** `session.running` is now the only run flag. `play_intent` is
  deleted; every verb that starts the machine sets `session.running`, every verb
  that stops it clears it, `session/tick` advances on it, and `session/state`
  reports it straight. The tick's adopt block is gone — with one flag there is
  nothing to translate.
- **Gate proving the fix:** `pause_stops_a_machine_started_by_the_debugger`
  (daemon lib tests) — starts the machine the way the editor does (`debug/run`),
  pauses it the way F11 does (`transport/toggle`), and asserts the clock stands
  still across four ticks and that `runState` says `paused`. Then the reverse
  pairing, `session/play` + `debug/pause`. Full workspace: 1020 passed.
- **Regression risk:** low-to-moderate — the flag is read in ~45 places. Behaviour
  is preserved by construction: the tick used to adopt `session.running` into
  `play_intent` on entry, so every op that set it (power on, reset, a CRT mount)
  already made the machine run. The one real change is that a pause now also
  stops a debugger-started machine, which is the fix.
