# Spec 900 — Scenario checks, and a runner with no agent in it

**Status:** DONE (2026-09-30)
**Repo:** C64RE only. TRX64 gains nothing: every fact a check reads (`session/read_memory`,
`session/state`, the text screen) exists.

## §1 What is wrong

A `.feature` file says what must hold after a run — its `Then` lines — and nothing reads
them. The parser sorts each into byte-exact or verbal (`classifyCriterion`, 810) and stops
there; `runtime_scene_reel` prints them. So a project that writes scenarios against its
own builds (LN_Engine: 23 files, run against real carts on every change) feeds the steps
to `runtime_sandbox_run`, gets bytes back, and has an agent judge every `Then` — tokens on
every run, and nothing `make` or CI can call.

## §2 The checks

A `Then` is **checked** when it is written in the notation below, and **unchecked**
otherwise. Unchecked is reported, never a failure: prose is how a scenario starts, and a
file converts one line at a time.

The notation is the one `I wait until …` already speaks — the same predicate said as a
fact instead of a wait — widened where a check needs more than a wait did:

| `Then …` | holds when |
|---|---|
| `$8EF2 is $01` | the byte is $01 |
| `$40 is $26 $40 $26 $40 $26 $55` | the bytes from $40 on are these, in order |
| `$B0 is not $00` | the byte is anything else |
| `$8EF2 is one of $01, $02` | the byte is one of these |
| `$8EF2@ram is $01` | the same, read through a lens — `cpu` (default), `ram`, `io`, `rom`, `cart`, as `read_memory` |
| `the CPU is at $0812` | PC is $0812 |
| `the screen shows "READY."` | the text screen contains it (813's substring rule) |

A line that STARTS like a check (`$…` or `the CPU is at`) and does not parse is a parse
error, not an unchecked line: a typo must not turn a check into prose that nobody reads.

**Position.** A `Then` is checked where it stands. LN_Engine's files interleave —
`Then` a fall has started, `And I wait 60 frames`, `Then` the fall has ended — so each
criterion records how many steps precede it, and the runner checks it right after that
step. A `Then` before any step is checked once the medium is in.

## §3 The doors

One evaluator, two doors.

- **`c64re scenario run <file.feature|dir>… [--scenario <name>] [--json] [--project <dir>] [--jobs N]`.**
  A fresh private machine per scenario (the `runtime_sandbox_run` runner, unchanged in
  kind), so the same file gives the same bytes. One line per scenario — `PASS`, `FAIL`,
  `UNCHECKED` (nothing in it is checkable yet), `SKIP` (starts from a mark: that needs the
  live session; or asks for a capture: that is a reel), `ERROR` (the run itself failed —
  a wait that timed out, a missing medium). A FAIL lists each failed check with its line,
  what was expected and what was there. A line that does not parse is reported and counts
against the run, but the scenarios that did parse still run — LN_Engine's first pass had
29 such lines across 25 files, and one of them must not hide the rest. Exit 1 on any
FAIL, ERROR or unparsed line. `--json` carries the
  same. Media resolve beside the `.feature` file first, then in the project; the model is
  the scenario's `# model:`, else the project's. `--jobs` runs that many machines at once.
- **`runtime_sandbox_run`** takes `Then …` entries in `steps`, checked where they stand
  and reported in a `checks:` section. In a tool call a `Then` has to be checkable — prose
  there has no reader but the caller.

## §4 Not in this spec

810's acceptance store — a human says yes once and the state becomes the baseline. A
check here is written into the file; nothing is frozen. Regions (`"score" shows …`) stay
the reel's: a sandbox run has no region store. A frame per scenario for documentation is
`runtime_scene_reel`'s job. Where command-line doors are collected is 880 §8.5.

`Feature:` lines are read as Gherkin writes them: a title, starting nothing. The parser
reported them as "outside any Scenario" before, which every LN_Engine file begins with.

## §5 Acceptance

- Hermetic (in CI): every row of §2 parses to its check; a malformed check is an issue;
  prose is unchecked; interleaved `Then` lines carry their position.
- Against a daemon: a generated PRG and `.feature` through `c64re scenario run` — PASS,
  a FAIL with expected/actual and exit 1, UNCHECKED for prose, a `Then` between two waits
  checked at its position (the byte differs before and after), `--json`, and the same
  checks through `runtime_sandbox_run`.

## §6 As built

`e2e:900-checks` (hermetic, in CI) 23/23. `smoke:900` 12/12: a generated PRG gated on the
joystick fire bit, so `$C000` is $01 before the press and $02 after — a check decided in
the wrong place gives the wrong answer; PASS/FAIL/UNCHECKED/SKIP/ERROR, exit codes,
`--json --jobs 2` in file order, and the same verdicts through `runtime_sandbox_run`.
On LN_Engine's real carts (read-only): all 25 files parse to 39 scenarios; one converted
`Then` ran and FAILED against a cart rebuilt after the values in its comment were taken —
the runner reporting the build, which is its job. About 20 s per 700-frame scenario;
`--jobs` is how a directory stays fast.
