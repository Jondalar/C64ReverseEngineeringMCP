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

Three predicates. All need `within N frames` — a predicate that never fires fails
with the state it reached instead of hanging.

```gherkin
  And I wait until the drive is idle within 9000 frames
  And I wait until the screen is still for 90 frames within 2000 frames
  And I wait until the CPU reaches $C001 within 600 frames
```

`the drive is idle` means it WORKED and then STOPPED. Right after a `LOAD` the drive
has not spun up yet, so a bare is-it-idle test would pass instantly.

`the screen is still` does not work at a BASIC prompt: the cursor blinks about every
20 frames, so no window longer than a blink is reachable. Use `the drive is idle`, a
`CPU reaches`, or a plain wait there.

## Joystick

The duration is required. A press with no stated end is the bug this format exists to
prevent.

```gherkin
  And I hold joystick 2 down for 3 frames          # a tap
  And I hold joystick 2 down and fire for 3 frames # together
  And I hold joystick 1 up for 100 frames          # held
```

Directions: `up`, `down`, `left`, `right`, `fire`. Ports 1 and 2.

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
  media_path   = /path/to/27_Golden_Disk_64_03_1992_s1.d64   # optional: resolves the Given
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

## Which machine it runs on

Its own. A fresh emulator process on its own port, started and killed by the call.

Your session is untouched. If you watch your own session while a scenario runs, you
are watching a different machine and will see nothing happen.

## The GIF

CSDb release format: GIF89a, 384x272 including the border, hard cuts (`disposal 2`),
one uniform delay, at most 512000 bytes.

Frames come straight from the VIC's own 4-bit colour indices against the 16-entry
COLODORE table, so there is no quantization step at all.

Over the byte ceiling, whole frames are dropped from the middle outwards — the first
and last survive longest — and the report names what went. Frames are never
re-encoded at lower fidelity and the file is never truncated.

## Screenshots by hand

The Live tab has a shutter: **📷 Capture**, a frame delay, **⬇ Download CSDb GIF**.
Capture, reorder, rename, drop, download. Same encoder, same output format.

Capturing there is read-only — it asks for the frame the machine is already showing
and does not advance it.

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
