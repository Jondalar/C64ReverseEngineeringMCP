# Capture Scenarios (Spec 812)

Drive a C64 from a written schedule and get screenshots or a release GIF out of it.
Every run is on a private throwaway machine, and the same file always produces the
same bytes.

## Why

A recipe made of separate tool calls is not repeatable. "Press down, then run about
two million instructions" is two seconds with the stick held — a menu that samples
once per frame scrolls right past the entry you wanted. Run it again with a slightly
different budget and you land somewhere else.

In a scenario, every step carries its own duration and every anchor is an absolute
machine cycle.

## Hello world

```gherkin
Scenario: boot to READY
  Given a bare machine
  When I wait 170 frames
  And I capture "ready"
  Then it booted
```

```
runtime_scene_reel
  feature_path = scenarios/hello.feature
  out_path     = hello.gif
```

## Vocabulary

`Given` — where the machine starts:

```gherkin
  Given the disk "side1.g64"        # also: cart / cartridge / image / medium / snapshot
  Given a bare machine
```

`When` / `And` — the steps, in written order:

| Step | Meaning |
|---|---|
| `I wait 170 frames` | advance. Also `I wait 3000000 cycles` |
| `I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"` | keys into the keyboard buffer |
| `I hold joystick 2 down and fire for 3 frames` | press AND release, held for 3 frames |
| `I wait until the drive is idle within 9000 frames` | wait for a condition, with a timeout |
| `I wait until the screen shows "PRESS FIRE" within 1200 frames` | wait for text on the screen |
| `I hold the key "SPACE" for 3 frames` | one key, held. For a title that scans the matrix itself |
| `I insert the disk "side2.d64"` | eject, wait, insert. Also `swap in` / `turn to` |
| `I capture "title"` | take a picture, on a frame boundary |

`Then` — criteria. Two are checked automatically:

```gherkin
  Then the reel has at least 5 screens
  And the reel is at most 512000 bytes
  And the title screen is legible        # verbal — reported, not checked
```

## Key tokens

Quotes inside a quoted Gherkin string would be unreadable, so:

| Token | Key |
|---|---|
| `{RETURN}` | RETURN |
| `{QUOTE}` | `"` |
| `{SPACE}` | space |

```gherkin
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"     # LOAD"*",8,1 + RETURN
```

## Waiting for a condition

The predicates. All need `within N frames` — a predicate that never fires fails
with the state it reached instead of hanging.

```gherkin
  And I wait until the drive is idle within 9000 frames
  And I wait until the screen is still for 90 frames within 2000 frames
  And I wait until the CPU reaches $C001 within 600 frames
  And I wait until the screen shows "READY." within 300 frames
  And I wait until "score" changes within 600 frames
  And I wait until $C05F is $03 within 600 frames
```

`the drive is idle` means it WORKED and then STOPPED. Right after a `LOAD` the drive
has not spun up yet, so a bare is-it-idle test would pass instantly.

`the screen is still` does not work at a BASIC prompt: the cursor blinks about every
20 frames, so no window longer than a blink is reachable. Use `the drive is idle`, a
`CPU reaches`, or a plain wait there.

## Waiting on what the screen says

A cycle count is exact and it rebuilds a reel byte for byte — but change the runtime
and the same number lands somewhere else, silently. Waiting on a STATE heals itself:

```gherkin
  And I wait until the screen shows "PRESS FIRE" within 1200 frames
  And I capture "title"
```

The C64 text screen is characters, one byte per cell, so this is a substring match —
no image comparison. Matching is per row, case-insensitive, and runs of spaces
collapse, so a padded menu entry still matches what you read on screen.

The report says which cycle it fired on, so drift stays visible:

```
waits (each one fired on its own state, at this cycle):
  cycle 26181793   I wait until the screen shows "PRESS FIRE" within 1200 frames — after 812 of 1200 frames
```

In a bitmap mode there is no character matrix. The run says so at once instead of
timing out 1200 frames later.

## Regions

Mark a box, compare its bytes. In text mode a rectangle is an address set —
`screen base + row*40 + col` plus the matching colour RAM — so the comparison is
exact and blind to the sprites and raster splits happening around it.

```gherkin
  Given the disk "game.d64"
  And the region "score" covers 30,1 to 37,1

  When I wait until "score" changes within 600 frames
  And I wait until "score" shows "001250" within 600 frames
  And I capture "scored"
  Then "score" is unchanged
```

A region defined in the file is local to it. A bare name is looked up in the project
store:

```gherkin
  Given the region "lives"          # no rectangle -> the project's own region entity
```

A local definition wins over a stored one of the same name, and the report says so —
otherwise you edit the entity, nothing changes, and you go looking for why:

```
regions:
  score    30,1-37,1   local (shadows entity region/score)
  lives    14,0-15,0   entity region/lives
```

A stored region that has MOVED since it was accepted is reported and NOT followed.

## Other predicates

```gherkin
  And I wait until $C05F is $03 within 600 frames
```

## Keys that are HELD, not typed

`I type` is for text — a BASIC line, a `LOAD`. It plays a queue through the matrix at
the typing pace.

That is the wrong tool for a title that reads the keyboard itself. A menu doing
`lda $DC01` in its own IRQ scans once a frame, and a key that is not DOWN at that
moment is a key it never sees. So a held key is its own step, with a duration, exactly
like the joystick:

```gherkin
  And I hold the key "SPACE" for 3 frames
  And I hold the keys "L_SHIFT+A" for 2 frames
```

The names are the matrix's own: letters and digits as themselves, plus `SPACE`,
`RETURN`, `RUN_STOP`, `L_SHIFT`, `R_SHIFT`, `CTRL`, `C_EQ`, `HOME`, `DEL`, `F1`, `F3`,
`F5`, `F7`, `CRSR_RT`, `CRSR_DN`, `LARROW`, `UP_ARROW`, `POUND`, `RESTORE`. A name that
is not one of those is a parse error, not a press that quietly never happens.

## Joystick

The duration is required. A press with no stated end is the bug this format exists to
prevent.

```gherkin
  And I hold joystick 2 down for 3 frames          # a tap
  And I hold joystick 2 down and fire for 3 frames # together
  And I hold joystick 1 up for 100 frames          # held
```

Directions: `up`, `down`, `left`, `right`, `fire`. Ports 1 and 2.

## Swapping a disk

Two-sided games ask for the other side and then wait. The swap is one step:

```gherkin
Scenario: Brubaker reaches chapter 1 on side 2
  Given the disk "27_Golden_Disk_64_03_1992_s1.d64"

  When I wait 170 frames
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"
  And I wait until the drive is idle within 9000 frames
  And I type "RUN{RETURN}"
  And I wait 900 frames
  And I capture "title"

  And I insert the disk "27_Golden_Disk_64_03_1992_s2.d64"
  And I type "{RETURN}"
  And I wait until the drive is idle within 9000 frames
  And I wait 300 frames
  And I capture "chapter-1"

  Then the reel has at least 2 screens
```

`I insert the disk "…"` ejects, waits, and inserts, so the drive sees the door open
and close and re-reads the new side. `I swap in` and `I turn to` mean the same thing.

Three things the step does NOT do:

- **It does not answer the prompt.** The game is waiting for a key — usually
  RETURN or SPACE. Type it yourself, after the insert.
- **It does not wait for the load.** Follow it with
  `I wait until the drive is idle within N frames`.
- **It does not take `media_path`.** That parameter resolves the medium in `Given`
  and nothing else. A medium named in an `insert` step is looked for next to the
  `.feature` file first, then in the project dir, and the run stops if it is nowhere.

Without the insert, the game sits on its swap prompt for the rest of the scenario, and
every capture from there on is that same prompt.

## A real one

Boot a two-sided magazine disk into chapter 1:

```gherkin
Scenario: Brubaker boots to chapter 1
  Given the disk "27_Golden_Disk_64_03_1992_s1.d64"

  When I wait 170 frames
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"
  And I wait until the drive is idle within 9000 frames
  And I wait 60 frames
  And I capture "loaded"

  And I type "RUN{RETURN}"
  And I wait 900 frames
  And I capture "title"

  And I hold joystick 2 up for 4 frames
  And I wait 40 frames
  And I hold joystick 2 fire for 8 frames
  And I wait 900 frames
  And I capture "selected"

  And I wait 1500 frames
  And I capture "intro-1"
  And I type "{SPACE}"
  And I wait 1200 frames
  And I capture "intro-2"

  And I insert the disk "27_Golden_Disk_64_03_1992_s2.d64"
  And I type "{RETURN}"
  And I wait until the drive is idle within 9000 frames
  And I wait 300 frames
  And I capture "chapter-1"

  Then the reel has at least 5 screens
```

## Running it

```
runtime_scene_reel
  feature_path = scenarios/brubaker-boot.feature
  out_path     = brubaker.gif
  media_path   = /path/to/27_Golden_Disk_64_03_1992_s1.d64   # optional: resolves the Given ONLY
  delay_ms     = 900                                          # optional, default 700
```

Output:

```
REEL Brubaker boots to chapter 1 → /…/brubaker.gif
ran on a private machine (port 60618), started and ended by this call.
Your own session was not touched, and nothing you do to it — pause, warp,
keys — reaches or disturbs this run.
8 frames · 384x272 · 46122 bytes of 512000 · 90 cs per frame · 16 colours

captures (the cycle each one landed on — a reel is re-derivable from these):
  loaded          cycle 8471737
  title           cycle 26181793
  …
criteria:
  PASS  the reel has at least 5 screens  (8 captured)
  ----  the chapter-1 room is drawn  (verbal — needs a human once)
```

`media_path` resolves the medium in `Given`, and nothing else. A medium named in
an `insert` step is looked for next to the `.feature` file first, then in the
project dir. If it is nowhere, the run stops and says so — mounting the wrong side
leaves the game asking to turn the disk, and every capture after that is the same
prompt.

## Which machine it runs on

Its own. A fresh emulator process on its own port, started and killed by the call.

Your session is untouched. If you watch your own session while a scenario runs, you
are watching a different machine and will see nothing happen.

## The GIF

Animated GIF format: GIF89a, 384x272 including the border, hard cuts (`disposal 2`),
one uniform delay, at most 512000 bytes.

Frames come straight from the VIC's own 4-bit colour indices against the 16-entry
COLODORE table, so there is no quantization step at all.

Over the byte ceiling, whole frames are dropped from the middle outwards — the first
and last survive longest — and the report names what went. Frames are never
re-encoded at lower fidelity and the file is never truncated.

## Screenshots by hand

The Live tab's top bar has a shutter: **📷 Capture** keeps the frame on screen, and
**🎞 Shots** opens the pictures you kept — reorder, rename, drop, set the delay,
**⬇ Download animated GIF**. Same encoder, same output format.

Capturing there is read-only — it asks for the frame the machine is already showing
and does not advance it.

The button next to it is **⏺ REC**, which records what you do as a scenario instead
of as pictures. See [Recording Scenarios](Recording-Scenarios).

## Determinism

Same file, two runs, byte-identical GIF. Verified over a real G64 boot through a
fastloader, 100M+ cycles.

That makes a scenario a regression test as much as a recipe: run it after a change
and compare.

## Gotchas

- Keys typed into a machine that is still booting are lost. `I wait 170 frames`
  first.
- A `LOAD` and a following `RUN` need a wait between them. The editor is not reading
  the keyboard mid-LOAD.
- A capture lands on a frame boundary, so it is always a whole picture.
- No `capture` step at all is refused before anything runs.
- Two captures of a machine that has not moved are the SAME picture, and the report
  says so. That is not a broken encoder — it means the machine was waiting for
  something. Look at the screen before assuming otherwise.
