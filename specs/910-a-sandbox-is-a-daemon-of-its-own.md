# Spec 910 — A sandbox is a daemon of its own: one way to start it, every runtime tool proven equal on it, and it never writes back

**Status:** PROPOSED (2026-10-15).
**Repo:** both.
- TRX64 (capability): a daemon that never writes a medium back into the file it was opened from.
- C64RE (meaning and memory): one driver for every sandbox, the parity proof, and one end path.

**Number:** 910 (registry: `specs/README.md`).
**Origin:** the owner, 2026-10-15, after a day of sandbox issues from one reporter (#89, #91 and the
Windows set):
- "Offensichtlich ist die Sandbox nicht 100% paritätisch mit dem Daemon. Das war so NIE definiert. Sie
  MUSS quasi ein Daemon sein, nur ohne die Intention, dass ein Mensch sie bedient, und die Sandbox nach
  Laufen wieder weg."
- "1 Session für das UI share *und* N Sandboxes parallel bleibt."
- He wants it fixed in the core, so that the shared machine and the sandboxes both profit, "statt Tesafilm
  um jedes Loch".

**Depends on:** 906 (sandbox sessions, the parity table `src/runtime/sandbox-parity.ts`). It changes
nothing in the shared session.

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
```

| # | Solves | Scenario | Test | Where it runs |
|---|---|---|---|---|
| S1 | P1 | one driver | `scripts/check-one-sandbox-driver.mjs` (static, over the source) | `gate.sh` + `gates.yml` |
| S2 | P1 | one-shot, reel and session alike | `scripts/e2e-910-sandbox-paths.mjs` → `e2e:910` | `gate.sh` (needs the daemon) |
| S3 | P2 | every working tool proven equal | `scripts/e2e-910-parity.mjs` → `e2e:910-parity` | `gate.sh` (needs the daemon) |
| S4 | P2 | ui-only refuses by name | same | same |
| S5 | P3 | no write-back by any method | TRX64 `crates/trx64-daemon/tests/no_writeback.rs` + `e2e:910` | TRX64 pre-push gate + `gate.sh` |
| S6 | P3 | shared write-back unchanged | `e2e:910` | `gate.sh` |
| S7 | P4 | one end | `e2e:910` | `gate.sh` |
| — | P1–P4 | a real game | by hand: a real disk that saves (a corpus game), and one real CRT, both run through all three ways; the source files are byte-identical | — |

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

## §4 Out

- The shared machine: unchanged. It is the one the UI shows, the human co-drives it, it is never
  power-cycled, and it writes back only through `runtime_media_persist`.
- The C64 Ultimate backend: sandboxes stay on the emulator, as today.
- New sandbox features: this spec makes the existing ones one thing; it adds no capability.

## §5 Decisions taken while building

(filled in at the end)
