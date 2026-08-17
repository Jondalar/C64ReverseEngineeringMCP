# Spec 812 — Capture scenario: a written schedule, and the reel it produces

**Status:** BUILT 2026-08-17 — the notation, the executor, the encoder and the tool
are in; gates green (`npm run smoke:812` 32/32, `npm run e2e:810` 18/18 unchanged,
and the two machine-fact gates in the runtime). Open: nothing in this spec. The
authoring half — which screens tell the story, near-duplicate removal — is left to
the caller (§7); promote it here if it turns out to need a tool of its own.
**Repos:** C64RE owns the scenario, the schedule, the encoder and the tool. The
runtime gained exactly two things, and both are facts about a machine:
`session/frame_indices` and `session/advance_to_frame`.
**Number:** 812 (registry: `specs/README.md`).
**Vocabulary:** `../../TRX64/docs/concepts-snapshots-scenarios-overlays.md` §6 — one word
per thing across this area. 812 contributes `capture` and `reel`, and takes `scenario` in
its Gherkin sense.
**Depends on:** 810 (the notation and its parser — extended here, not duplicated),
787/788 (a scratch instance is a separate process), doctrine rule 2 as amended
2026-08-14 (C64RE may spawn an ephemeral sandbox; it carries a budget and ends
itself).
**Origin:** [C64RE issue #3](https://github.com/Jondalar/C64ReverseEngineeringMCP/issues/3)
— a CSDb-format release GIF, today hand-orchestrated per project against a
privately-spawned runtime.

---

## §1 The one thing that is missing, and it is missing twice

A capture recipe today reads *"press down, then run about two million
instructions"*. Two million instructions is not a moment; it is two seconds of C64
time with the stick held. A menu that samples once per frame scrolls through it.
Run the same recipe again with a slightly different budget and it stops somewhere
else.

That is issue #3's problem — the reel cannot be rebuilt — and it is issue #2's
problem — the boot cannot be repeated. **Both are the same absence: no clock.** One
artifact fixes both, and the second fix is free: a scenario that replays to the
same bytes twice is the determinism test.

## §2 It is written in Gherkin, in 810's files, through 810's parser

```gherkin
# targets: payload/golden-disk-title
Scenario: the release reel
  Given the disk "side1.g64"
  When I wait 170 frames
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"
  And I wait until the drive is idle within 8000 frames
  And I capture "title"
  And I hold joystick 2 down and fire for 3 frames
  And I wait until the screen is still for 90 frames within 2000 frames
  And I capture "menu"
  Then the reel has at least 5 screens
  And the title screen is legible
```

810 chose Gherkin for goals because a human reads and rewrites them. A capture
schedule is the same kind of document said at greater length, so it is the same
notation, the same `.feature` files, and **the same parser** — widened in exactly
two directions: a scenario may start from a MEDIUM instead of a mark, and its
`When` may be a list of driven steps instead of a branch run. A repo with two
notations for one idea ends up with two of everything, which is the trap 810 §4b
was already written to avoid.

A two-sided title asks for the other side mid-run, so there is a step for it:

```gherkin
  And I insert the disk "side2.d64"
```

Eject, give the drive time to notice, insert, take the clock back. It is the
hardware-style swap, not `runtime/swap_disk_and_continue` — that one is a stub
that reports success. Without this step the recipe for a two-sided game stops at
"Bitte Diskette wenden!" and everything past it is unwritable.

Steps run in written order and **each one that lasts states its own duration**.
`I hold joystick 2 down for 3 frames` is a press *and* its release; a press with no
stated end is not expressible, which is the point. `I wait until …` requires
`within N frames`, because a predicate that never fires must fail rather than hang.

`{RETURN}`, `{QUOTE}`, `{SPACE}` keep a `LOAD"*",8,1` readable inside a quoted
Gherkin string. Escaping would have been the first thing anyone got wrong, and
readability is the entire reason this is a feature file and not JSON.

## §3 Two kinds of waiting, and both are needed

A plain `I wait N frames` is exact and reproducible to the cycle. It is also
brittle: a fix that shifts timing invalidates every scenario that leaned on it.

`I wait until …` survives that. Three predicates, all readable from the machine:

- `the CPU reaches $C001`
- `the screen is still for N frames`
- `the drive is idle`

Two of them carry a lesson each, recorded in §11.

## §4 A capture lands on a frame boundary

`displayed` is the frozen previous frame. Ask for it mid-frame and you get the one
before the interesting one; 808 already paid for this. So a capture first advances
to the next raster wrap, then reads, and records the cycle it fired at. Those
cycles go in the report: a reel is re-derivable from its own output.

The boundary is found by watching the wrap, not by arithmetic — a one-cycle budget
still completes the instruction in flight, so `raster_cycle` can step over any
exact value. A wrap cannot be stepped over.

## §5 The machine emulates. A human or C64RE drives it.

This is the line the first build of this spec crossed, and §11 records how.

The runtime is asked only for things a machine can answer: run this many cycles,
present these keys, hold this stick, what is on the screen, where is the raster. It
learns nothing about schedules, waypoints, reels or GIFs.

The schedule runs on **C64RE's** side, against a private machine it spawns on its
own port and kills when the command ends — doctrine rule 2's ephemeral sandbox,
which is exactly what the reporter of #3 built by hand. It is a child process, not
a detached one: nothing survives the command, so there is nothing to reap.

**Driving it over a socket costs wall clock and nothing else**, because the machine
is PAUSED for the whole run and every advance is a bounded run in cycles. That is
not a hope; it is the measurement in BUG-050 — with the machine left running one
recipe gave five different outcomes, and paused with the boot expressed in cycles,
five for five identical.

## §6 The reel is GIF89a, and it needs no quantization

CSDb wants exactly 384×272 including border, GIF, ≤ 512000 bytes, hard cuts,
uniform delay. That happens to be what the VIC already produces: one byte per pixel
holding a 4-bit colour index, plus the sixteen RGB entries that go with it. A GIF
global colour table is a palette of that shape and GIF pixel data IS palette
indices — nothing to build, nothing to dither, and no colour that drifts between
frames.

The palette travels **with** the frame from the machine rather than being kept as a
second copy in C64RE. Per frame: LZW over the index buffer, `disposal = 2`, one
uniform delay, Netscape loop block.

**The clamp is honest.** Over `maxBytes`, whole frames are dropped from the middle
outwards, so the opening and closing shots go last, and the report names what went.
Never a silent re-encode at lower fidelity, never a truncated file.

**Verification is structural.** The gate parses the produced GIF as blocks. Scanning
for the `21 F9` marker is not verification — that byte pair occurs inside LZW pixel
data, which is the trap the reporter hit.

## §7 Who owns what

**The runtime** emulates. Two new RPCs, both machine facts: the displayed frame as
raw indices plus its palette, and "advance to the next frame boundary and tell me
the cycle".

**C64RE** writes the scenario, walks it, encodes the reel, and decides which screens
tell the story of a release — the playthrough order, near-duplicate removal, the
≥ 5-screens rule. That last part is a `Then` line the caller writes today; it is
checked, not enforced.

## §7b The other door: a shutter in the Live tab

A written scenario is for a reel that must be REBUILDABLE. The other half of the
same need has no schedule in it at all: you are already playing the game, you reach
a screen worth keeping, and you press a button. Scripting that would be absurd.

So the Live tab carries a shutter and a strip: capture, reorder, rename, drop, and
**Download CSDb GIF**. The reel is assembled in the browser by the same encoder the
tool uses, so a hand-shot reel and a scenario-shot reel are byte-for-byte the same
kind of file. The byte ceiling behaves the same way too — frames are dropped from
the middle outwards and the panel NAMES them, because a reel that quietly lost the
middle of the story would look finished and be wrong.

**Capturing there is read-only, and that is load-bearing.** This is the one session
a human co-drives; a screenshot must not move it. It asks for the frame the machine
is already displaying and advances nothing. Measured on a running machine: four
captures taken mid-raster (line 196–197) each came back as a complete 384×272 frame,
and the clock did not move across the call. The frame-boundary advance that a
SCHEDULED capture needs (§4) exists for stepping to a chosen point, not for this.

## §8 Determinism falls out, and it is the gate

The same scenario, run twice, must produce **byte-identical GIFs**. That is the
acceptance test, and it is simultaneously the instrument issue #2 needs: if one
schedule diverges, the divergence is ours and reproducible without anyone's private
disk.

Gates:

1. `27 the same scenario produces the same bytes` — same feature text, two runs.
2. `12–17` — block-structure parse, canvas, 16-entry table, hard cuts, honest clamp.
3. `advancing_to_a_frame_lands_on_the_raster_wrap` (runtime) — and idempotent.
4. `a_held_joystick_is_seen_for_every_frame_it_is_held` (runtime) — measured at CIA1.
5. `30 a predicate that never fires fails loudly` — with the state it reached.
6. `31/32` — the sandbox holds its own port while it lives and lets go when it ends.
7. `npm run e2e:810` unchanged at 18/18 — the notation was widened, not altered.

## §9 What this spec does not do

- **It does not evaluate a verbal goal.** A `Then` it can check, it checks; the rest
  are reported as verbal. Acceptance is 810's, and sits on top.
- **It does not drive the live session.** Not an option, not a flag.
- **It does not choose the screens.** It runs the scenario it is given.
- **It does not put a schedule in the runtime.** See §5.

## §10 Deliverables

| # | Where | What |
|---|-------|------|
| 1 | `src/project-knowledge/scenario-gherkin.ts` | the step vocabulary, in 810's parser: `Given the disk/cart/medium/snapshot`, `Given a bare machine`, and the six steps — `wait`, `type`, `hold joystick`, `wait until`, `capture`, `insert` |
| 2 | `src/reel/gif89a.ts` | GIF89a encoder over palette indices + the block-structure parser the gate uses |
| 3 | `src/reel/sandbox-session.ts` | an ephemeral private machine: own port, child process, budget, ends itself |
| 4 | `src/reel/run-scenario.ts` | walk the steps on a paused machine, collect the frames |
| 5 | `src/server-tools/scene-reel.ts` | `runtime_scene_reel`, registered in `DEFAULT_TOOLS` |
| 6 | runtime: `session/frame_indices`, `session/advance_to_frame` | the two machine facts, with their gates |
| 7 | `ui/src/workbench/components/ReelStrip.tsx` | the Live-tab shutter and strip (§7b), sharing the same encoder |
| 8 | `npm run smoke:812` | 32 checks |

## §11 What building it taught

**The first build put the executor in the emulator, and that was wrong.** A
`trx64cli reel` subcommand parsed scenarios, drove the machine through a schedule
and assembled GIFs — so the runtime knew what a waypoint and a release reel were.
The justification was that a socket between the schedule and the machine would
reintroduce timing non-determinism. **My own control measurement disproves it**:
driven over a WebSocket from a Node script, one recipe came back five for five
identical, to the cycle. A paused machine does not move while a call is in flight.
The whole executor moved to C64RE and the runtime kept two RPCs.

There is a second half to that mistake worth naming: the owner had said "like a
Gherkin test, as in 810" at the outset, and I built JSON, reasoning that Gherkin
could be a front end later. Choosing the second format is how a repo gets two of
everything; the notation was his call and it was already made.

**The GIF encoder was wrong in a way our own tests could not see.** The first
version widened the LZW code at `next_code == 1 << code_size`, and a decoder
written from the same understanding read it back perfectly — eight green tests over
a stream no real library accepts. An outside decoder rejected it on the first try
(`broken data stream`). A decoder learns each dictionary entry one code late, so it
counts one behind the encoder; the encoder must widen *strictly past* the current
width. When the encoder later moved from Rust to TypeScript, the port was gated
byte-for-byte against the verified original rather than re-derived — which is the
correct way to move a thing that was hard to get right.

**`the drive is idle` had to mean "worked, then stopped".** Written as "is the drive
idle", it fired instantly after a `LOAD` — the C64 was still printing SEARCHING and
the drive had not spun up — and the reel captured the prompt. It now requires the
busy→idle edge, and says so when the drive never became busy at all.

**And the busy signal is the LED, not the motor.** A 1541 keeps spinning after a
load finishes, so `motorOn` answers a different question. `drive_status` had already
learned this once.

**`the screen is still` cannot be used at a BASIC prompt.** The cursor blinks about
every 20 frames, so no stability window longer than a blink is ever reachable. The
timeout message now reports the longest still stretch it saw and names the
predicates that do work there.
