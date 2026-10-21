# Spec 910 — A sandbox is a daemon of its own: one way to start it, one way to run, every runtime tool proven equal on it, and it never writes back

**Status:** BUILT on `spec/910` (2026-10-21; both halves; extended the same day by P5–P7, the run model). Not merged; the TRX64 pin is bumped by the owner.
**Repo:** both.
- TRX64 (capability): a daemon that never writes a medium back into the file it was opened from; one
  run model (the machine free-runs, a run may end itself after N cycles or at a breakpoint); no
  `--headless` mode and no hidden warm-up run.
- C64RE (meaning and memory): one driver for every sandbox, the parity proof, one end path, and every
  tool on the one run model.

**Number:** 910 (registry: `specs/README.md`).
**Origin:** the owner, 2026-10-15, after a day of sandbox issues from one reporter (#89, #91 and the
Windows set):
- "Offensichtlich ist die Sandbox nicht 100% paritätisch mit dem Daemon. Das war so NIE definiert. Sie
  MUSS quasi ein Daemon sein, nur ohne die Intention, dass ein Mensch sie bedient, und die Sandbox nach
  Laufen wieder weg."
- "1 Session für das UI share *und* N Sandboxes parallel bleibt."
- He wants it fixed in the core, so that the shared machine and the sandboxes both profit, "statt Tesafilm
  um jedes Loch".

- Extended 2026-10-21 after TRX64 #20 (a sandbox `reset cold` "did not reboot" a GMod2 cart: it did,
  then ran 5 M cycles past the cold start before answering, and no breakpoint could stop it):
  "Die Sandbox soll sich 1:1 (also 100% deckungsgleich!) wie der normale Daemon verhalten. Das hatten
  wir schon 3 mal in den letzten Wochen … RIESEN BUG! Lücken analyse, alle schliessen." And: "dieses
  uralte Konzept 'es gibt freerunning vs cycle budget' ist Fuppes … es gibt NUR freerunning und evtl.
  beende ich es nach N zyklen automatisch."

**Depends on:** 906 (sandbox sessions, the parity table `src/runtime/sandbox-parity.ts`). P1–P4 change
nothing in the shared session; P5–P7 change the shared daemon too (one run model for every daemon).

---

## §1 The problem

**Who:** the LLM that needs a machine of its own (to test, step, trace, compare, depack), next to the
one shared machine the human sees.

**What it wants:** a machine that is the same daemon as the shared one and answers every runtime tool
the same way. It should be invisible to the UI, started for a purpose, and gone when the purpose is
reached or failed.

**What happens today** (read from the code, 2026-10-15). The binary is the same one: every sandbox is a
`trx64-daemon` wrapped by `SandboxSession` (`src/reel/sandbox-session.ts`). Above that wrapper there are
three drivers, and each boots, mounts, traces and ends in its own way:

| Driver | File | Used by |
|---|---|---|
| `runSandbox` (one-shot, its own step language, its own `media/open`) | `src/reel/run-sandbox.ts:258` | `runtime_sandbox_run`, `src/reel/sweep.ts:62`, `src/scenario/cli.ts:219`, `src/cost/capture.ts:50` |
| `runScenario` (the reel, its own `media/mount` at `:285` and `:412`) | `src/reel/run-scenario.ts:158` | `runtime_scene_reel` |
| `startSandboxSession` + `bootSandbox` (session) | `src/runtime/sandbox-sessions.ts:183` | `runtime_sandbox_start` → every `runtime_*` tool by `session_id` |

What that cost on one day:
- **#91:** only the session driver copied the medium, and only when no project was given. The one-shot
  run, its `insert` steps, the reel and later mounts handed the daemon the project's file, and the
  daemon writes a disk back into the file it was given.
- **The #91 fix is a list.** `SandboxSession.call()` rewrites the path only for the methods in
  `MEDIA_PATH_METHODS` (`src/reel/sandbox-session.ts:165`), plus the monitor's `mount` / `swapcrt`. A
  daemon method added later that takes a path slips past it. That is the next #91.
- **Parity is classified, not proven.** `SANDBOX_PARITY` gives every tool a verdict (`works` / `ui-only`),
  and the gate checks that every registered tool has one. Whether a `works` tool really answers the same
  on a sandbox is checked only for a hand-picked handful in `scripts/e2e-906-sandbox-session.mjs` (trace
  start / status / finalize, save / load vsf, rip, render, scenario save).
- **The end differs per driver:** what is finalized, what is recorded in the step log, which scratch is
  removed, and what "ended" means.

**What happens in the daemon itself** (read from the code, 2026-10-21, TRX64 `43e48cf`; `T` =
`crates/trx64-daemon/src/main.rs`, `S` = `streaming.rs`). The first part above treated the daemon as
the same in both roles. It is not: C64RE starts every sandbox with `--headless`, and that flag is a
second run model.
- **Two run models.**
  - `--headless` (`T:95`) means "only advances on an explicit session/run". There is no advance loop,
    and the daemon starts paused at cycle 0 (`build_state`, `T:18669`).
  - The normal daemon starts running, but its only advance loop is the A/V stream pump. That pump
    exists only while an A/V client is subscribed (`S:252-329`). The MCP connects with `?av=0`, so the
    shared daemon with no UI tab does not advance either (C64RE #63).
- **Hidden warm-up runs that no breakpoint stops.** `run_cycle_budget` (`T:1907`) only gets the
  `Session` and never sees `st.mon`.
  - Headless `do_power_on` runs 5 M cycles before answering (`T:1745-1752`). That covers every power
    door: monitor `reset cold` / `power on`, `session/reset`, `session/power`, every cart insert,
    eject, mount and swap, `project/set`, and `session/create` with a model.
  - The warm reset runs 5 M cycles on **both** daemons: monitor `reset` (`T:4701`) and `session/reset`
    soft (`T:7826`). The two doors also leave `running` differently.
  - Other fixed runs on the live machine that see no breakpoints:
    - `runtime/overlay_run` (`T:9039`);
    - transport step-forward (`T:16193`, NullSink, no trace);
    - `run_scenario` (`T:15081`);
    - `audio/export` (`T:15380`, and it unhooks the pump's SID);
    - `debug/memory_access_map` (`T:11866`).
- **Five advance hosts, each with its own per-frame work.** These are the pump (`S:510-632`),
  `session/run` (`T:7178`), `frame_probe` (`T:16999`), `session/tick` (`T:11952`) and the blocking
  10 M `debug/continue` (`T:2382`). Each one decides for itself:
  - when a checkpoint anchor is taken. On `session/run` that is one per call, before the advance,
    whatever the call spans.
  - whether the recorder is fed;
  - whether observer `log`/`mark`/`cmd` actions are drained. `session/run` never drains them.
  - whether a stop is pushed to clients.

  So a sandbox's ring and marks depend on how a client chunks its calls.
- **The cap overshoots.** `debug/run {cycles}` is checked after a whole frame (`T:15794`), so it stops up
  to a frame late. `session/run` stops on the cycle. That difference is why clients keep both.
- **C64RE builds on the split.**
  - `runCapped` vs blocking `run()` is chosen from `streamPump` (`src/runtime/runtime-methods.ts:89-138`,
    `src/server-tools/headless.ts:279`).
  - Boot, `runtime_type`, `runtime_joystick`, `waitForBasic`, the reel, the state-map search and
    `runtime_sandbox_run` pause the machine and push `session/run` chunks.
  - Tool texts say "the machine free-runs between calls" (`headless.ts:829`, `:921`) and "the sandbox
    is PAUSED: it advances only when a tool runs it" (`runtime-sandbox-session.ts:36`). Each is wrong
    on one of the two daemons.

**Why it matters:** every driver and every hand-picked list is a place where the sandbox and the
shared machine drift apart. A reporter's assistant finds those places one at a time, and each one
costs an issue, a fix, a retest and a release.

### Parts (MECE)

- **P1 One driver.** Every machine of the LLM's own is started, driven and ended through one lifecycle:
  start a session, drive it with the same `runtime_*` calls the shared machine takes, end it. One-shot
  runs, reels, sweeps, scenario runs and cost captures are scripts over that lifecycle, with no boot,
  mount or end code of their own.
- **P2 Parity proven.** Every runtime tool that works on the shared machine is called on a sandbox and on
  a shared-style daemon with the same inputs, and the answers are compared. A tool that does not work on
  a sandbox is refused by name, with its reason, from one table.
- **P3 Never write back.** A sandbox daemon never writes any medium into the file it was opened from,
  through any method, now or later. The shared machine keeps its write-back.
- **P4 One end.** Every way a sandbox ends (reached, failed, budget, idle, owner gone, end call) does the
  same things in the same order: finalize a recording trace, record the outcome, remove the scratch, and
  stop the daemon.
- **P5 One run model.** Every daemon has one way to run: the machine free-runs. A run can be given a
  stop: after N cycles, or at a breakpoint or watchpoint. It stops on that exact cycle or instruction.
  - There is no second model where the machine only moves when a request pushes cycles, no
    `--headless`, and no advance loop that exists only while someone watches.
  - Pace (real time or as fast as possible) is a setting of the run, not a mode of the daemon.
- **P6 No hidden runs.** No door (reset, power, cart insert/eject/swap, model change, project switch,
  overlay, scenario, export, access map, transport step) runs the machine behind the caller's back.
  - A door that implies running (power on, reset) leaves the machine free-running from cycle 0 / the
    reset vector, and breakpoints see every cycle of it.
  - A door that needs a measured stretch (export, access map) runs it as an ordinary run with a stop,
    on the same loop.
- **P7 One loop does the per-frame work.** Whatever drives the machine, the same loop does the work
  once per frame, whoever is subscribed and however the client chunks its calls:
  - the checkpoint anchor;
  - the recorder feed;
  - the observer drain;
  - the stop check;
  - the stop push.

  The A/V push is one more consumer of that loop, never its owner.

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 one driver
  Given the C64RE source
  When  the gate counts the places that start a sandbox daemon or open, mount or end its media
  Then  there is exactly one: the sandbox session lifecycle
  And   runtime_sandbox_run, runtime_scene_reel, the sweep, the scenario runner and the cost capture call it

Scenario: S2 one-shot, reel and session behave alike
  Given the same PRG, the same inputs and the same budget
  When  it runs through runtime_sandbox_run, through runtime_scene_reel, and as a session driven by runtime_* calls
  Then  the three end in the same machine state (registers, RAM hash, cycle count)

Scenario: S3 every working tool proven equal
  Given the built server's tool list
  When  every tool whose verdict is "works / session" is called with a generated fixture call on a sandbox and on a daemon started like the shared one (its own port, never :4312)
  Then  the answers are equal after normalising ids, ports, paths and times
  And   a new runtime tool without a verdict, or without a fixture call, makes the gate red

Scenario: S4 a UI-only tool refuses by name
  When  a tool marked ui-only is called with a sandbox id
  Then  it refuses with its reason from the table, and nothing is done

Scenario: S5 no write-back, whatever the method
  Given a D64 and a CRT that the program writes to (SAVE; an EasyFlash flash write)
  When  they are mounted in a sandbox by every way the daemon offers (start, media/open, mount, swap, ingress, the monitor's mount/swapcrt, swap_disk_and_continue)
  Then  the source files are byte-identical after every way the sandbox ends
  And   the sandbox itself saw its writes

Scenario: S6 the shared machine still writes back on purpose
  Given the shared machine with a disk mounted
  When  runtime_media_persist is called
  Then  the disk file holds the writes, as today

Scenario: S7 one end
  Given a sandbox with a recording trace
  When  it ends by reached, failed, budget, idle, owner gone and the end call (one run each)
  Then  in every case the trace is finalized and queryable, the outcome is in the step log, the scratch is gone and the port is free

Scenario: S8 a reset stops at the cart's cold start (TRX64 #20)
  Given a sandbox and a shared-style daemon, each with the same banked CRT whose cold start is at $800C
  And   an exec breakpoint at $800C (and one at $FCE2)
  When  the monitor's `reset cold`, `power off`/`power on`, `session/reset` cold and soft, and a cart re-insert are each done (one run each)
  Then  the machine stops at $FCE2 and then at $800C, within a few thousand cycles of the door
  And   the reply names the PC and cycle the door left the machine at (the reset vector, cycle 0 for a power-on), not one 5 M cycles later
  And   both daemons answer identically

Scenario: S9 one run model on both daemons
  Given a sandbox and a shared-style daemon with no A/V client
  When  the same PRG is run with a stop after N cycles, and then with a breakpoint
  Then  both stop on exactly the same cycle and PC as each other and as the old blocking session/run
  And   a running machine with no stop keeps advancing on both, with no client attached

Scenario: S10 no hidden run
  Given a breakpoint armed on an address the door's code passes through
  When  every door in P6 is used
  Then  either the breakpoint stops the machine, or the door does not run the machine at all
  And   the static check finds no fixed-cycle run outside the one loop

Scenario: S11 the ring does not depend on how the client chunks
  Given the same PRG run for 200 frames as one run, as 200 one-frame runs, and as 7 uneven runs
  Then  the checkpoint ring holds the same anchors (cycles) in all three
  And   an observer `log` action fires the same number of times in all three

Scenario: S12 the texts tell the truth
  When  the tool texts and replies of runtime_type, runtime_joystick, runtime_session_run, runtime_sandbox_start and runtime_sandbox_run are read
  Then  none says the machine free-runs or is paused "because it is a sandbox"; each describes the one model
```

There are no gates (owner, 2026-10-16). Each test is run by hand when the spec is built and when a
later change touches it.

| # | Solves | Scenario | Test |
|---|---|---|---|
| S1 | P1 | one driver | `scripts/check-one-sandbox-driver.mjs` (static, over the source) |
| S2 | P1 | one-shot, reel and session alike | `scripts/e2e-910-sandbox-paths.mjs` → `e2e:910` |
| S3 | P2 | every working tool proven equal | `scripts/e2e-910-parity.mjs` → `e2e:910-parity` |
| S4 | P2 | ui-only refuses by name | same |
| S5 | P3 | no write-back by any method | TRX64 `crates/trx64-daemon/tests/no_writeback.rs` + `e2e:910` |
| S6 | P3 | shared write-back unchanged | `e2e:910` |
| S7 | P4 | one end | `e2e:910` |
| S8 | P5, P6 | reset stops at the cart's cold start | TRX64 `crates/trx64-daemon/tests/one_run_model.rs` + `e2e:910-parity` (both daemons) |
| S9 | P5 | one run model, cycle-exact stops | TRX64 `one_run_model.rs` |
| S10 | P6 | no hidden run | TRX64 `one_run_model.rs` (every door) + a static check in it: no fixed-cycle run outside the loop |
| S11 | P7 | the ring does not depend on chunking | TRX64 `one_run_model.rs` |
| S12 | P5 | the texts tell the truth | `e2e:910-parity` reads the registered tool texts |
| — | P1–P7 | a real game | by hand: a real disk that saves (a corpus game), and one real banked CRT, both run through all three ways and on both daemons; the source files are byte-identical; the CRT stops at its cold start after `reset cold` |

## §3 Decision

- **D1 (P3, TRX64): the daemon owns "never write back".**
  - A start option (name decided in TRX64) makes the daemon open every medium it is handed into a copy
    in its own scratch dir, and persist only there. This holds for every method that takes a path, and
    for every way the daemon ends.
  - `session/state` reports that the option is on.
  - Without the option, nothing changes; the shared machine runs without it.
  - Lost: the C64RE-side rewrite. Any list of method names in a client can be outrun by the daemon.
- **D2 (P3, C64RE):** `SandboxSession.start` always passes the D1 option, and checks `session/state` that
  it took effect; if not, the sandbox refuses to start. `MEDIA_PATH_METHODS`, the monitor path rewrite
  and `copyMedium` are deleted.
- **D3 (P1):**
  - The session lifecycle in `src/runtime/sandbox-sessions.ts` is the one driver: start (boot via
    `bootSandbox`), drive (the same calls the runtime tools make), end (D5).
  - `runSandbox` and `runScenario` become scripts over it: their step languages map onto runtime calls,
    and the boot, `media/open` / `media/mount` and end code inside them is removed.
  - The sweep, the scenario CLI and the cost capture keep calling those scripts.
  - Lost: keeping the one-shot path separate "because it is simpler". It is the path that drifted.
- **D4 (P2): parity is proven, not classified.**
  - `SANDBOX_PARITY` stays the one table of verdicts.
  - Every `works / session` tool gets a fixture call: a small, deterministic input, generated where the
    schema allows and written by hand where it does not, all in one fixture file.
  - The parity test runs each one on a sandbox and on a daemon started the way the shared one is (own
    port), and compares the normalised answers.
  - A tool without a verdict or without a fixture call fails the gate.
  - The 906 hand-picked parity checks fold into this.
- **D5 (P4):** one `endSandbox(reason)` does finalize → record → remove scratch → stop, in that order, for
  every end reason and every caller. The keeper's owner-gone path calls the same steps.
- **D6 (P5, TRX64): one advance loop per daemon, always there.**
  - The loop that today lives in the A/V stream pump runs from startup on every daemon. It is gated
    only on `running` and the pace, never on a subscriber.
  - The A/V push is a consumer: frames and audio go out only while a client is subscribed.
  - `--headless` is removed. So are `streaming_enabled` as a run switch, `pump_idle`, and the
    `streamPump` field.
  - Every daemon starts running. A sandbox therefore boots like the shared machine does.
  - Lost: "a silent, deterministic, command-driven machine". Determinism comes from the exact stop
    (D7), not from a machine that does not move.
- **D7 (P5, TRX64): one bounded run, cycle-exact.**
  - `debug/run {cycles?, pace?}` is the one door that starts a run with a stop. The loop clamps each
    frame's step to the cycles left, so a cap stops on the same cycle the old `session/run` did.
  - Breakpoints and watchpoints stop it on the same instruction as `run_until_break`.
  - The reply carries the stop (reason, PC, cycle). A client can wait for it in the same call
    (`wait: true`) or take the `debug/paused` push.
  - `session/run` stays as a name only, for one release: it is `debug/run {cycles, wait: true}`.
  - The other blocking doors fold into this. Each becomes "start a run with a stop and wait":
    `debug/continue`'s 10 M blocking run, api `until`, monitor `until`/`n`/`ret`, `frame_probe`,
    `swap_disk_and_continue`, `session/tick` and `session/advance_to_frame`.
  - Pace defaults to real time on every daemon. A run that names `pace: "warp"` runs as fast as
    possible, and the pace goes back when the run stops (as `runCapped` asks today).
- **D8 (P6, TRX64): the doors do not run the machine.**
  - The 5 M warm-ups go: the headless `else` in `do_power_on`, monitor `reset` warm, and
    `session/reset` soft.
  - Power-on and both resets leave the machine running from the reset vector, through the loop.
    Their replies say where the machine stands, not where it would be later.
  - Monitor `reset` and `session/reset` leave the same `running` state.
  - `overlay_run`, `run_scenario`, `audio/export` and `memory_access_map` run through D7 with
    breakpoints live.
  - The transport step-forward at the head is a D7 run of one frame.
  - `audio/export` restores the SID hook it replaced (bumps `machine_generation`).
- **D9 (P7, TRX64): the per-frame work lives in the loop only.** The copies before the advance in
  `session/run` (`T:7235-7241`), `session/tick` (`T:11983-11990`) and `frame_probe`
  (`T:16985-16993`) go, along with their callers' advance code.
  - Anchors are captured per frame of machine time, by the loop.
  - The recorder counts cycles, not calls.
  - Observer actions are drained on every stop.
- **D10 (P5, C64RE): one run call.**
  - `runtime-methods.ts` gets one `runUntil({cycles?, wait})` over D7. `run()`, `runCapped()` and
    the `streamPump` branch in `runtime_session_run` go.
  - Boot (`session-boot.ts`), `waitForBasic`, `runtime_type`/`runtime_joystick` settle, the reel, the
    state-map search and `runtime_sandbox_run` stop pausing and pushing chunks. Each runs with a stop
    and waits.
  - Sandboxes are spawned without `--headless`. The option and its filters in
    `resolve-daemon-spawn.ts` go.
  - Tool texts describe the one model (S12).
  - The `runtime_session_export_audio` ui-only reason is corrected; the parity table decides it anew.
- **D11 (P5): the TRX64 #20 workaround is unnecessary.** After D8, `reset cold` with a breakpoint at
  the cart's cold start stops there. The reporter's retest closes #20.

## §4 Out

- The shared machine keeps its role: the UI shows it, the human co-drives it, it is never
  power-cycled by the LLM, and it writes back only through `runtime_media_persist`. Its run model
  changes with every daemon's (P5–P7).
- The C64 Ultimate backend: sandboxes stay on the emulator, as today.
- New sandbox features: this spec makes the existing ones one thing; it adds no capability.

## §5 Decisions taken while building

- **P5–P7 (TRX64, `spec/910` `4c65ce7`).**
  - **The loop.** `streaming::start_run_loop` starts with every daemon. The reSID engine and the SID hook
    exist only while an A/V client is subscribed.
  - **Embedded hosts.** `build_state(session, run_from_start)`: the daemon passes true. An embedded host
    (FFI, CLI cockpit) passes false: it has no loop thread and advances through `session/tick`, the same
    `advance_frames`. A host that relied on a reset running the boot now runs it itself.
  - **`wait`.** A waiting request releases the State lock on a condvar, and the loop keeps advancing.
    The four methods that can park run under `block_in_place`.
  - **`session/run`.** The old name of `debug/run {cycles, wait}`, with the old reply shape. Its default
    pace is warp, so the existing callers stay fast. `debug/run` defaults to real time. Both daemons
    behave the same.
  - **Instruction stepping stays.** Monitor `until`/`n`/`ret`/`sf`/`nf`, `z` and API `stepOver` are
    instruction-stepping verbs: they use VICE's interrupt-entry boundary and level counting, which a
    frame-granular run cannot give. They use one-instruction primitives, never a fixed-cycle run.
  - **The static check** (S10) allows run primitives only in:
    - the loop's own step functions;
    - the in-daemon sandbox fork (runs a copy);
    - `transport_move_to` (picture re-sim, then a restore);
    - the bare-machine `MachineTarget::run_for` / `switch_model`.
  - **S8 measured.** On a banked Ocean CRT with its cold start at $800C, every door stops at $FCE2 on
    the cycle its reply names, then at $800C 103 cycles later.
  - **Changed along the way:**
    - A traced run longer than 100 k cycles stops on the first instruction boundary at or past the cap.
      The old per-segment overshoot is gone.
    - A scenario replay stopped by a breakpoint ends with `stopped`.
    - API `until` and `overlay_run` push `debug/stopped`.
    - `audio/export` bumps `machine_generation`.
- **C64RE (`spec/910`).**
  - **D10.** `src/runtime/run-until.ts` is the one run: `debug/run {cycles?, pace?, wait}`, answering the stop
    `{reason, pc, cycles}`. `run()`, `runCapped()`, `runLive()` and the `streamPump` branch are gone; `runtime_session_run`,
    `runtime_type`/`runtime_joystick` (settle, hold), `waitForBasic`, the reel, the one-shot run, the state-map search
    and the boot all run with a stop and wait. A wait for a PC is one run with two stops (the breakpoint, the cap).
    `--headless` and its filters left `resolve-daemon-spawn.ts`. `runtime_session_export_audio` was tried on a sandbox
    (`audio/export` renders offline) and is `works / session`.
  - **The clock of a free-running daemon.** A fresh sandbox has already run when the first call arrives, so the boot takes
    its clock by stops (`session-boot.ts`): a power cycle with an exec breakpoint on `$FCE2` stops it on its first
    instruction at cycle 0, then `checkpoint/clear` (the ring held the anchors of the free-run before the cycle).
    A door that implies running (`media/open` of a PRG or a cartridge, a power cycle) is passed with breakpoints armed
    where the machine will stand — the PRG's entry, the PC it is at, `$FCE2`, and the vector at the top of an Ultimax
    cartridge's high ROM — so it is parked there, not stopped by a pause that lands at a wall-clock cycle (measured: 1 in
    600 PRG starts ran a frame before the pause). The same for `mountSandboxMedium`. Reels now start a cartridge at the
    reset vector (cycle 0), where the headless daemon ran 5 M hidden cycles first.
  - **D2.** `SandboxSession.start` passes `--scratch <its temp dir>/scratch` and refuses to start unless `session/state`
    says `noWriteback`. `MEDIA_PATH_METHODS`, the monitor path rewrite and `copyMedium` are deleted.
  - **D3.** `runtime/sandbox-sessions.ts` is the lifecycle: `startSandboxSession` (with `script: true` for a one-shot run,
    a reel, a search: not listed, not counted against the four, ended by the script), `sandboxCall`,
    `mountSandboxMedium`, `ejectSandboxDisk`, `endSandboxSession`. `runSandbox`, `runScenario` and `runSearch` are
    scripts over it; the sweep, the feature runner and the cost capture call `runSandbox`. `scripts/check-one-sandbox-driver.mjs`
    reads the source and fails on a second place.
  - **D5.** `runtime/sandbox-end.ts` is the one end: finalize a trace, record the outcome in the step log, stop the daemon,
    remove the scratch. The scratch goes after the daemon (a deviation from the order written in P4): the daemon's exit
    work writes into it, and a directory removed under a live daemon is recreated or fails its write. The keeper loads
    this module and runs `endFromKeeper` for owner gone and budget; with no record (the trace reader's daemon) it only
    signals the daemon.
  - **D4.** `scripts/lib/parity-fixtures.mjs` is the one fixture file (hand-written, plus a generated call for any tool
    whose schema asks for nothing but a session). `e2e:910-parity` runs it on a sandbox and on a daemon started without
    `--scratch`, compares normalised answers (ids, ports, paths, scratch copy names `001-name`, checkpoint counters,
    times), refuses ui-only tools by name, checks S12 on the registered texts and S8 (`reset cold` with breakpoints on
    `$FCE2` and the cold start, on both daemons). The 906 parity walk moved into it.
  - **Tests.** `check:one-sandbox-driver` (S1), `e2e:910` (S2, S5 with decoys and every door C64RE has, S6, S7 for
    reached/failed/budget/idle/owner gone/runtime exited), `e2e:910-parity` (S3, S4, S8, S12).
  - **Pin.** The runtime that C64RE starts must be TRX64 with `4c65ce7` and `d1be072` (run model, `--scratch`):
    a daemon without them rejects `--scratch` or lacks `debug/run {wait}`.
