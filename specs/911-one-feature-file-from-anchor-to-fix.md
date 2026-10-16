# Spec 911 — One feature file takes a fix from an anchor to a verdict: a script runs it, the LLM only finds, writes and judges

**Status:** BUILT on branch spec/911 (2026-10-16), not merged. Owner: "Ja Bau." S8 (a fresh agent finds the loop) is by hand and not yet done.
**Repo:** C64RE. The runs use what TRX64 already has (private daemons, snapshot dump/undump,
memory writes, the scenario step program); no TRX64 change is planned. If a cartridge-ROM write
into a running sandbox turns out to be missing, that one capability goes to TRX64 (§5).
**Number:** 911 (registry: `specs/README.md`).
**Origin:** owner, 2026-10-16, writing to a reporter whose Claude kept building its own
routines instead of using C64RE and TRX64:

> Not: boot game, wait for something specific, watch, again.
> Instead: LLM finds problematic situation · rewind to crucial point before · snapshot · run
> snapshot in sandbox · stop · LLM creates fix · run again with fix 1 · stop · LLM judges ·
> loop till fix found. Only where LLM is in the sentence Claude decides. The rest should be a
> python script.

Then, on comparing it with our tools: "Ich glaube das würde uns helfen", "ob nicht beides
zusammen geht" — the candidate and the scenario as one thing.
**Depends on:** 905 (anchor → variants → build, built), 900 (`c64re scenario run`, built),
906 (sandbox sessions and their limits, built). Spec 910 (sandbox = daemon) is independent;
this spec uses the sandbox start that exists today.

---

## §1 The problem

**Who:** the LLM in an RE project, fixing or changing a game's code. Also the owner at the
workbench, and a reporter's agent that should not need its own tooling.

**What they want:** the owner's loop above. A machine-side script does the mechanical steps:
start from the instant, apply each fix, play the inputs, stop, check. The LLM does only four
things: find the instant, write fixes, judge, decide to go round again.

**What happens today:** the loop exists in two halves that do not fit.

- **The candidate** (`runtime_candidate_create` / `_variant` / `_run`, `src/candidates/`) has
  the anchor, the source variants and the path into the build (`_choose`, `_derive_delta`,
  `_verify_build`).
  - A run plays a fixed cycle budget. There is no stop on a condition.
  - Its inputs are a separate format, `[{atCycle, kind, payload}]`.
  - Its verdict is a diff of the whole machine against the baseline (`run.ts:98-108`), not
    "did the fix do what it should".
  - It can only be driven through MCP.
- **The scenario** (`.feature`, `c64re scenario run`, `src/scenario/cli.ts`) has a CLI with
  an exit code, `wait until <predicate> within N frames`, and checked `Then` lines.
  - It has no step that puts code into the machine.
  - `Given the mark "<name>"` is reported SKIP, "a mark lives in the shared session"
    (`cli.ts:170-171`).
- **The anchor** (`runtime_anchor_set`, `src/server-tools/anchor-tools.ts:49-115`) is a
  TRX64 mark plus a graph node.
  - Its machine state lives only in the ring.
  - After a daemon restart, or once the ring rolls past it, `runtime_candidate_run` refuses
    with "set the anchor again" (`run.ts:41-45`).
  - A script days later cannot start from it.
- **No MCP tool** runs a `.feature` and returns a verdict. `runtime_scene_reel` makes a GIF;
  `runtime_sandbox_run` takes steps, not a file.

**Why it matters:** an agent that cannot find one way through builds its own: a stepper in
6502, a trace parser, a boot-and-watch loop. The reporter's Claude did exactly that. Every
such detour costs hours, and the results are not in the project.

**Worked example (the target):**

```gherkin
Feature: level 3 no longer crashes when the lift is used

Scenario: the lift at level 3
  Given the mark "before_lift"
  And variant "fix1" assembles "fixes/lift-fix1.tas" at $0A20
  And variant "fix2" assembles "fixes/lift-fix2.tas" at $0A20
  And variant "fix2" assembles "fixes/lift-fix2-table.tas" at roml bank 3 $9100
  When I hold joystick 2 down for 10 frames
  And I wait until the CPU reaches $0B00 within 500 frames
  Then $D020 is $00 throughout the next 50 frames
```

`c64re scenario run lift.feature` runs the baseline, `fix1` and `fix2` on three private
machines at once and prints:

```
FAIL  baseline  wait until the CPU reaches $0B00: not within 500 frames
PASS  fix1      1 checked  (also changed: $C000-$C0FF, 256 bytes)
FAIL  fix2      $D020 is $02 at frame 12, expected $00
→ candidate cand-7 (lift.feature:3)
```

It exits 0 because a variant passed. The LLM reads that, picks `fix1` or writes `fix3`, and
runs it again.

**Parts (MECE):**

- **P1 Start point that lasts:** an anchor is a file in the project. A scenario starts from it
  without the shared session, any time later, and a scenario can make one itself (boot, play,
  wait until the instant, set the anchor) with no session at all.
- **P2 Fix in the file:** a `.feature` names variants. Each variant is source assembled at an
  address in RAM or in a cartridge ROM bank. The baseline always runs alongside.
- **P3 Stop and judge:** a run ends at its steps (incl. `wait until`). The `Then` lines alone
  decide PASS/FAIL per variant. The whole-machine difference against the baseline is reported
  as side effects and decides nothing.
- **P4 One door for script and LLM:** `c64re scenario run` and one MCP tool run the same file
  through the same code and return the same result.
- **P5 Memory:** every run of a file with variants is kept as the candidate record in the graph.
  The record holds per-variant verdicts, history and the choice. `choose`, `derive_delta` and
  `verify_build` read it. The old candidate inputs and runner are gone.
- **P6 Taught:** the agent docs and the wiki show the loop as THE way to try a fix, with the
  owner's split (the LLM decides; the script runs).

## §2 Scenarios — what proves it is solved

```gherkin
Scenario: S1 an anchor outlives the ring
  Given an anchor "a1" set on a sandbox session at a known instant
  When  the daemon is ended and a new private machine starts from "a1"
  Then  its registers and RAM equal the state at "a1"
  And   knowledge/anchors/a1.c64re exists in the project

Scenario: S1b a feature makes the anchor itself
  Given a feature: the test PRG, `wait until the CPU reaches $XXXX within N frames`,
        `And I set the anchor "a2"`
  When  `c64re scenario run` runs it
  Then  knowledge/anchors/a2.c64re exists, its PC is $XXXX, and a graph anchor node names it
  And   a second feature starting `Given the mark "a2"` runs from that state

Scenario: S2 variants run beside the baseline, in parallel
  Given a feature with 3 variants (one in RAM, one in a cartridge ROM bank)
  When  `c64re scenario run` runs it
  Then  4 results come back — baseline + 3 — each from its own private machine
  And   at most 4 machines are alive at once
  And   each variant's bytes are in its machine at the stated address before the first step

Scenario: S3 the stop is a condition, not a cycle count
  Given a feature whose `wait until the CPU reaches $XXXX within N frames` holds for fix1 only
  When  it runs
  Then  fix1 continues to its Then lines; the baseline is FAIL "not within N frames"

Scenario: S4 Then decides; the diff only informs
  Given fix1 passes its Then line and also changes RAM elsewhere
  Then  fix1 is PASS, and the result lists the other change as a side effect
  And   a variant with no difference to the baseline but a failing Then is FAIL

Scenario: S5 script and LLM get the same answer
  When  the same file runs via the CLI (--json) and via the MCP tool
  Then  the verdicts and side effects are identical
  And   the CLI exits 0 if any variant passed, 1 if none did, 2 on a parse/ERROR

Scenario: S6 the run is remembered and goes into the build
  Given a run of the feature with variants
  Then  a candidate record exists, linked to the anchor and the feature file
  When  the LLM chooses fix1, derives the delta and verifies the build
  Then  verify_build is GREEN with fix1's bytes, RED naming the first address without them

Scenario: S7 the shared machine never moves; the old door is gone
  Then  the shared session's cycle is unchanged across S1–S6
  And   runtime_candidate_create / _variant / _run are not in the tool list
  And   an old candidate record (inputs + cycle budget) is still listed and can still be
        chosen, derived and verified

Scenario: S8 a fresh agent finds the loop
  Given a fresh agent with only the onboarding, doctrine and wiki
  When  it is asked to try two fixes for a given crash at a given anchor
  Then  it writes a .feature with two variants and runs it — no own stepper, no own script
```

| # | Solves | Test | Where it runs |
|---|---|---|---|
| S1 | P1 | `scripts/e2e-911-anchor-file.mjs` → `e2e:911-anchor` | `gate.sh` |
| S1b | P1 | `e2e:911-anchor`, `── S1b` | `gate.sh` |
| S2 | P2 | `scripts/e2e-911-variants.mjs` → `e2e:911-variants` (own test PRG + own test CRT, made in the script) | `gate.sh` |
| S3 | P3 | same script, `── S3` | `gate.sh` |
| S4 | P3 | same script, `── S4` | `gate.sh` |
| S5 | P4 | `scripts/e2e-911-one-door.mjs` → `e2e:911-door` | `gate.sh` |
| S6 | P5 | `scripts/e2e-911-candidate.mjs` → `e2e:911-candidate` | `gate.sh` |
| S7 | P5 | in `e2e:911-candidate` + `check:tool-surface` | `gate.sh` |
| S8 | P6 | agent run on a throwaway copy of a real corpus project, by hand — an agent's judgement is not a gate | — |

## §3 Decision

- **D1 Anchor = mark + file.** `runtime_anchor_set` also writes `snapshot/dump` to
  `knowledge/anchors/<name>.c64re`. The media are embedded, as every `.c64re` does. The graph
  node gets the path.
  - `Given the mark "<name>"` in the scenario runner resolves to that file. The SKIP at
    `cli.ts:170` goes; a mark without a file is still SKIP and says so.
  - `runtime_anchor_goto` on the shared session is unchanged: it uses the ring while the
    mark is there.
  - `runtime_anchor_drop` deletes the file.
  - New step `And I set the anchor "<name>"`: in a private run it dumps the machine to
    the same file and records the same graph node. That is how a script makes an anchor from
    a boot (medium or PRG, typing, `wait until`) without the shared session. An existing
    anchor of that name is replaced only when the run also passes `--replace-anchors`;
    otherwise the step is an ERROR naming it.
  - Lost: nothing. The ring stays the fast path for the shared machine.
- **D2 Variant line.** The new step is
  `And variant "<name>" assembles "<path>" at [roml|romh bank <n> ]$<addr>`. It is repeated
  for several targets of one variant.
  - Assembly uses `assembleTarget` (`src/candidates/variant.ts`): the project's assembler,
    and the load address must equal the target.
  - A file with no variant line runs as today: one machine, no baseline.
  - Inline source and raw bytes are not in the grammar; a fix is a file the project keeps.
- **D3 One machine per run, in parallel.**
  - The baseline and each variant run as their own `runSandbox` (`src/reel/run-sandbox.ts`),
    from the same origin and with the same steps. The worker pool already exists in
    `cli.ts:137-147`.
  - Default parallelism is min(4, CPUs), the sandbox limit from 906.
  - A variant's targets are written after the origin is loaded and before the first step.
    RAM uses the daemon's memory write; cartridge ROM uses the bank write the candidate
    patches use today in `sandbox/runMany`.
  - `sandbox/runMany` is no longer used by C64RE.
  - Lost: runMany's clone-inside-one-daemon speed. Clones cannot play a step program with
    `wait until`, and a step program is the point.
- **D4 Judge.**
  - Verdict per run: PASS / FAIL / ERROR / UNCHECKED from the `Then` checks (`cli.ts:221`).
  - The file's exit code is 0 if the feature has no variants and all runs pass, or if it has
    variants and at least one variant passes. It is 1 otherwise, and 2 on a parse error or
    when every run is ERROR.
  - Side effects: at the end of each run, C64RE reads the variant's and the baseline's RAM,
    I/O, colour RAM and cartridge RAM, and lists the differing ranges. The variant's own
    targets are masked. This is plain memory reads, no cross-daemon diff.
- **D5 One door.**
  - The new MCP tool `runtime_feature_run` (`feature_path` or `feature`, `jobs?`) calls the
    same function the CLI calls and returns the same text, or JSON on request.
  - It is not named `runtime_scenario_*`: those names belong to the old scenario registry
    (`src/server-tools/runtime.ts:976ff`).
  - Removed: `runtime_candidate_create`, `runtime_candidate_variant`, `runtime_candidate_run`,
    and the alias `runtime_candidate_patch`.
- **D6 Candidate = record of a run.**
  - A run with variants writes `knowledge/candidates/<id>.json`, with these fields: feature
    path + scenario line, anchor, a per-variant `{targets with bytes, verdict, checks,
    sideEffects}`, `history[]` (one entry per run of the same file + scenario: same id, new
    entry), `chosen`.
  - The graph node keeps STARTS_FROM to the anchor and gets a link to the feature file.
  - `runtime_candidate_list`, `_choose`, `_derive_delta` and `_verify_build` keep their
    inputs. Old records (inputs + cycleBudget, no feature) stay readable: listed, choosable,
    derivable.
- **D7 Taught (P6).**
  - In `docs/agent-doctrine.md`, the candidate loop (now lines 266-273) is rewritten as the
    owner's loop with the split. One paragraph on who does what:
    - **LLM:** find the instant (graph, listing, a read-only ring scrub), set the anchor,
      write the fixes as files, read the verdicts, choose or write the next fix.
    - **Script:** `c64re scenario run` / `runtime_feature_run`.
    - Then `derive_delta` + `verify_build`.
    - A worked example in the same shape as §1's.
  - `docs/mcp-llm-playbooks` "Iterate Your Own Code" is regenerated from it.
  - The `c64re setup` block (`src/setup-cli.ts:11-31`) gets one line: "to try a fix: anchor,
    a .feature with variants, `runtime_feature_run`; never your own stepper or boot loop".
  - `docs/runtime-sandbox.md` drops the candidate_create/run recipe for the file.
  - **Wiki:** new page `Trying-a-Fix.md`, written for a human user. It covers the loop, the
    file format with the variant line, reading the result, choosing, and into the build.
    `Scenario-Goals-and-Acceptance.md` and `Capture-Scenarios.md` link to it.
    `Home.md` lists it.
  - No spec numbers in any of these.

## §4 Out

- The loop's iteration itself (fix → run → judge → next fix) stays with the LLM. No
  auto-search over fixes, no generated variants.
- Source of the whole project as a variant (a branch); variants are snippets at addresses —
  owner, 2026-10-16.
- Raw-byte variants in the file (they are a `.tas` with `.byte`).
- Changing the shared session's ring or `runtime_anchor_goto`.
- Spec 910's driver unification; this uses `runSandbox` as it is.
- A reel or capture step inside a variant run (capture scenarios stay with `runtime_scene_reel`).

## §5 Decisions taken while building

- **Writing code into a running sandbox, RAM and cartridge bank alike.** The runtime has no plain memory write
  into a running session. A run takes `checkpoint/capture` of the machine as it stands and `runtime/overlay_run`
  with `run_cycles: 0` against that checkpoint: the helper `apply_overlay_patches` that the removed `sandbox/runMany`
  used (RAM, or `roml`/`romh` + bank), here against a restore of the very state just captured, so only the patch
  differs. The baseline takes the same round trip with no patches, so baseline and variants start from the same
  kind of machine. Cartridge-bank writes work where the runtime's mapper supports an overlay (EasyFlash; others are
  refused by the runtime with its own text). No TRX64 change was needed.
- **A mark starts exactly where it was dumped.** Opening a snapshot used to be followed by an advance to the next
  frame boundary (the probe for "is the VIC sweeping"), which moved the machine up to a frame. For `Given the mark`
  the run skips it (`startExactly`), so registers, clock and RAM equal the anchor's. Other snapshot origins
  (`Given the snapshot`) keep their old alignment, so recorded scenarios replay as before.
- **The anchor file is the machine at the call.** `runtime_anchor_set` names the checkpoint, then dumps. On a
  stopped machine (a sandbox between calls) that is the same instant; on a running shared machine it is a few
  milliseconds later, and the answer says how many cycles. A name that already has a file is refused; drop deletes
  the file, including an anchor that is only a file (the ring no longer holds it).
- **A run opens a copy of the anchor file**, in a scratch folder of its own, because the runtime lays an anchor's
  embedded media out beside the file it opens; parallel machines must not share one disk, and the project must
  not collect `_media` folders.
- **A wait that does not happen is FAIL (not ERROR) in scenarios with variants only.** A scenario without
  variants still reports it as ERROR, as before. In a variant run the steps after the failed wait do not run and its
  later `Then` lines are not decided.
- **Exit codes apply to every run of `c64re scenario run`**, not only to files with variants: 0 / 1 / 2 as D4 says
  (a parse error was 1 before and is 2 now). The default for `--jobs` is min(4, CPUs) (it was 1).
- **Side effects** are read as RAM (two 32 KiB reads, the largest one read takes), the I/O area ($D000-$DFFF: VIC,
  SID, CIAs, colour RAM, the cartridge's I/O windows, a peek with no side effects) and compared with the
  baseline's at the end of the run. Left out: the variant's own RAM bytes, the registers that move by themselves
  (raster, SID read-backs, CIA timers and clocks) and the chips' mirrors. The text lists the first six places, the
  JSON all of them. Cartridge ROM is not read (it does not change by running); a variant's bank bytes are checked by
  its own `Then` lines.
- **A scenario with variants cannot set an anchor** (every machine would write the same file) and cannot be swept
  (`--sweep`): both are ERRORs that say so.
- **The slot gate stays with the tool.** `runtime_feature_run` is gated like the doors that allocate memory, when the
  file has variants (the door that used to carry it, `runtime_candidate_variant`, is gone); the command line is not
  a door and is not gated.
- **Candidate key and shape.** One record per feature path (relative to the project) + scenario name; the
  scenario's line is stored and may move. A scenario that starts from a medium has no anchor and no STARTS_FROM
  edge, but its record links to the feature file (node kind `feature`, edge `FROM_FEATURE`). A feature passed to
  the tool as text is recorded as `(inline)` with its text. A re-run clears the choice if the chosen variant left
  the file, and the delta and build check if its bytes changed.
- **`runtime_inject_range`** put raw bytes into a candidate variant, which no longer exists, and raw bytes are not in
  the grammar (§4). It now writes the bytes as a source file (`* = $addr` and `.byte` lines) and returns the
  variant line to add. `runtime_candidate_remove_patch` went with `_patch` (its answer named a removed tool);
  `runtime_candidate_export` stays as the pointer to the list.
- **A reel refuses** an anchor step and variant lines, by name: a reel assembles pictures.
- **e2e:905** keeps the anchor doors, the 32-anchor limit and the build check (on a record as the old runner left it);
  its sections for the removed runner (three fixes at once, inputs, restart) are the feature run's now.
- **Seen on master, not touched:** `scripts/probe-mcp-llm-playbooks.mjs` check 9 fails for `runtime_sandbox_start`,
  `_list` and `_end` (default tools in no playbook); it is not in a gate.
