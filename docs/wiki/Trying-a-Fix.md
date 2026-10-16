# Trying a Fix

You found the place where a game goes wrong and you have an idea for how to change
it. This page is how you try the idea — and a second, and a third — from exactly the
instant before the problem, without booting the game over and over and without
touching the machine you are watching.

The work is split in two. **You** (or your assistant) decide: where the problem
starts, what the fixes are, which one is right. **A script** does the rest: it starts
every machine from that instant, puts each fix in, plays the inputs, stops when the
thing you are waiting for happens, and checks what you said has to be true.

## The loop

1. Name the instant — an **anchor**.
2. Write each fix as a source file.
3. Write one scenario that lists the fixes and says what has to be true afterwards.
4. Run it. Read the verdict per fix.
5. Write the next fix, or choose one and take it into the build.

## 1. Name the instant

Bring the machine to the moment just before the problem — the frame before a sprite
goes wrong, the second before a level loads — and set an anchor there:

```
runtime_anchor_set
  name = before_lift
  why  = just before the lift at level 3
```

An anchor is a name on the machine's recent past **and a file in your project**,
`knowledge/anchors/before_lift.c64re`. The file is what matters: it is still there
after the session is closed, after the machine has run on for an hour, and the next
day. Setting an anchor does not move, pause or change the machine.

If you have no session at hand, a scenario can make the anchor itself from a boot:

```gherkin
Scenario: get to the lift
  Given the disk "game.d64"
  When I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"
  And I wait until the drive is idle within 9000 frames
  And I wait until the CPU reaches $0B00 within 4000 frames
  And I set the anchor "before_lift"
  Then the CPU is at $0B00
```

Run it with `c64re scenario run`. An anchor that already exists is replaced only if
you add `--replace-anchors`; otherwise the run says which one is in the way.

## 2. Write the fixes

A fix is a source file in your project, assembled with the project's assembler
(64tass for `.tas`, KickAssembler for `.asm`). Its own origin must be the address it
is tried at:

```
* = $0a20
        lda #$2a
        sta $0310
        rts
```

A fix may go into RAM, or into a bank of an EasyFlash cartridge (a patch to the ROM
as the cartridge holds it).

## 3. Write the scenario

```gherkin
Feature: level 3 no longer crashes when the lift is used

Scenario: the lift at level 3
  Given the mark "before_lift"
  And variant "fix1" assembles "fixes/lift-fix1.tas" at $0A20
  And variant "fix2" assembles "fixes/lift-fix2.tas" at $0A20
  And variant "fix2" assembles "fixes/lift-fix2-table.tas" at roml bank 3 $9100
  When I hold joystick 2 down for 10 frames
  And I wait until the CPU reaches $0B00 within 500 frames
  Then $0310 is $2A throughout the next 50 frames
```

- `Given the mark "before_lift"` starts from the anchor's file.
- `And variant "<name>" assembles "<file>" at $ADDR` names a fix. Say the name again
  for a second place; `at roml bank 3 $9100` (or `romh`) puts that part into a
  cartridge bank. The file is looked up beside the `.feature` file, then in the
  project.
- `When` / `And` are the steps — the same ones as in
  [Capture Scenarios](Capture-Scenarios). `I wait until … within N frames` is the stop:
  the run ends when the condition holds, not after a number of cycles you guessed.
- `Then` lines say what has to be true. They alone decide whether a fix passed.

The **baseline** — the same scenario with no fix at all — always runs beside your
variants, so you can see what the fix changed.

## 4. Run it

```
c64re scenario run scenarios/lift.feature
```

or, as a tool, `runtime_feature_run` — the same code, the same answer. Each run gets a
machine of its own, up to four at once; the machine you are watching is not touched.

## 5. Read the result

```
FAIL  baseline  wait until the CPU reaches $0B00: not within 500 frames (PC now $0812)
PASS  fix1      1 checked  (also changed: $C000-$C0FF, 256 bytes)
FAIL  fix2      line 10: $0310 is $2A throughout the next 50 frames — got $00
→ candidate cand-7 (scenarios/lift.feature:3)
```

- **PASS / FAIL** come from the `Then` lines, and from nothing else. A wait that never
  happened is a FAIL, saying so.
- **also changed** lists the memory a fix changed besides what it was meant to — RAM
  and the I/O area, compared with the baseline at the end of the run. It is
  information, not a verdict: a fix that passes and also changes something is still a
  pass, and you decide whether the extra change is acceptable. The fix's own bytes and
  registers that move by themselves (the raster, the timers) are left out.
- The exit code is **0** when a fix passed, **1** when none did, **2** when a line of
  the file does not parse or no run could run at all — so `make` and CI can use it.
- `--json` gives the same answer as data.

Read it, then change a fix and run the file again.

## 6. Choose, and into the build

Every run of a scenario with fixes is kept in your project as a **candidate**
(`knowledge/candidates/`): the file, the anchor, each fix's bytes, its verdict, and the
history of every run of that scenario. Running the file again adds to the same
candidate.

```
runtime_candidate_list                    what was tried, and what it did
runtime_candidate_choose        id, variant
runtime_candidate_derive_delta  id        the chosen fix as files to put into your build
runtime_candidate_verify_build  id        builds, then checks the image holds the bytes
```

`runtime_candidate_verify_build` runs your project's own build command, reads the image
it made — a PRG, or a cartridge image bank by bank — and compares every byte of the
chosen fix. It answers GREEN, or RED naming the first address that does not have it.

## Finding the place to start

A crash or a wrong room that you can only reach by moves is found by a map, not by hand:
[Mapping a Game](Mapping-a-Game) lists every state reachable from an anchor, the moves
between them and the moves that crash, and writes the goal as an anchor. Start from the
anchor on the way to the crash, and try the fix as above.

## Good to know

- An anchor file is a snapshot of the machine **with its media embedded**; it can be
  large for a cartridge.
- A scenario with fixes cannot set an anchor — every machine would write the same
  file. Make the anchor in a scenario of its own.
- A fix is a file, not a line in the scenario. A few raw bytes are a `.tas` with a
  `.byte` line; `runtime_inject_range` writes that file for you from a `.bin`.
- `Given the mark` needs the anchor's file. An anchor set before anchors kept a file
  is skipped, and the run says which one to set again.
