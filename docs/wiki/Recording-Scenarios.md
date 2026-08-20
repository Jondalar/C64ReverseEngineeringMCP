# Recording Scenarios (Spec 814)

Play the run once, get the `.feature` file.

This is [Capture Scenarios](Capture-Scenarios) turned around. That page is about
writing a schedule and running it; this one is about doing the thing with your hands
and letting the machine write the schedule down.

## Why

Writing a scenario by hand means guessing. How many frames until the menu? How long
to hold fire? When is the load done? You find out by being wrong, editing the number,
and running it again.

Meanwhile the run you were guessing about already happened. You did it yourself, and
every input landed on an exact cycle the machine knows.

## Using it

In the Live tab's top bar:

| Button | What it does |
|---|---|
| **📷 Capture** | Keep the frame on screen right now. Never moves the machine. |
| **🎞 Shots** | The pictures you kept — reorder, rename, drop, build the GIF. |
| **⏺ REC** | Arm the recorder. Press it again to stop and see the file. |

Then: press REC, play, press STOP. The finished scenario opens in an editor over the
screen.

REC lives in the top bar on purpose. Arming a recorder is a transport state like
running or warping — it is on or it is not, and you have to be able to see that at
all times. A recorder you forgot is armed produces a file full of everything you did
while thinking.

While it is armed the button shows how many inputs it has: `⏺ REC ● 12`.

## What it records

Three things, because these are the three things a C64 can *receive*:

- what you typed,
- the joystick,
- a medium going in.

Scrubbing, rewinding, stepping and poking memory are **not** recorded. Those are
things done *to* the machine by an operator, not inputs the machine can receive, and
a scenario that replayed them would not be replaying a session.

Shots you take while recording become `I capture` steps. Shots taken outside the
recording do not.

Keys come out two ways, and the difference matters:

```gherkin
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"     # text you typed
  And I hold the key "SPACE" for 4 frames          # a key you pressed and held
```

A key you press on the C64 keyboard is written down as a **held** key, for exactly as
long as you held it. That is not the same thing as typing it: a title that scans the
matrix itself sees a key only if it is DOWN during its scan, and a typed string played
out at the typing pace can miss it entirely.

## The cycles come from the daemon, never the browser

A recorded press is only worth something if it carries the cycle it actually landed
on. If the UI timestamped its own click, what got recorded would be the WebSocket
round-trip plus the render loop — a measurement of the network — and replaying it
would put the press somewhere else entirely.

So the runtime keeps the journal and stamps every input itself. The browser says
*what* was pressed. It never says *when*.

## Waits become anchors where it can see one

A gap between two inputs can be written two ways:

```gherkin
  And I wait 170 frames                                    # exact, and brittle
  And I wait until the drive is idle within 9000 frames    # survives a change
```

The recorder proposes the second wherever something *appeared* during the gap — text
on the screen, or the drive going busy and then idle again — and falls back to the
first where nothing did.

It cannot know which of those you meant. That is the one judgement it refuses to
make, so it writes its proposal into the file and you keep it or replace it in the
editor.

The timeout it writes has room in it. A timeout that is merely the measured wait goes
red the first time the machine is a little slower.

## Every step says who made it

The session is shared: you and the LLM drive the same machine. So a recording is
*what happened to this machine*, all of it, and then says where each piece came from.

```gherkin
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"     # by: human
  And I wait until the drive is idle within 9000 frames
  And I hold joystick 2 fire for 3 frames          # by: llm
```

Recording only your half would be tidier and wrong — if the LLM loaded something
mid-recording, that step would be missing and the replay would stop two lines later.

The mark is a **comment**, not a new dialect. The same line parses with it, without
it, or with either value.

In the editor, **drop the LLM's steps** removes them in one click. By hand: delete
the lines.

## The Given comes from the session

Recording rarely starts at power-on, so the recorder asks the machine rather than
guessing:

- a medium is mounted → `Given the disk "…"`, and the file is self-contained. A paste
  is enough for someone else to run it.
- nothing mounted → `Given a bare machine`, plus a note. If the machine was not
  actually at power-on, save a snapshot next to the file and change the `Given`
  yourself — honest, and worthless without the file beside it.

The overlay states which of the two it chose and why, because that decides whether
the scenario can be shared.

## The editor

Three things about it:

1. **It validates with the real parser.** Not a regex, not a second grammar in the
   browser — the same function the executor runs. A bad line gets a red dot in the
   gutter and the parser's own message beside it.
2. **The completions are the parser's vocabulary**, exported for the purpose. There
   is no hand-typed verb list anywhere in the browser: a client that keeps its own
   copy of what a verb is becomes a second authority, and a second authority drifts.
3. **It is editable**, because the recorder proposes and you decide. Swap a wait for
   an anchor, drop the three fumbled keypresses, rename a capture.

Click a suggestion to insert it; the caret lands on the first `<placeholder>`.

## Saving

**⬇ Save to project** writes `<project>/scenarios/<name>.feature` — the same place
everything else reads scenarios from, and versioned by git like the rest of them.

Saving is refused while the parse is red, in the overlay *and* again on the server. A
`.feature` that does not parse is not a scenario; writing one just produces a file
that fails at the moment somebody else tries to use it.

The name is a filename, not a path.

## What comes out

```gherkin
Scenario: recorded run
  Given the disk "game.d64"
  # a medium is mounted, so this file is self-contained — a paste is enough
  When I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"     # by: human
  And I wait until the drive is idle within 1140 frames
  And I wait 20 frames
  And I hold joystick 2 fire for 3 frames           # by: llm
  And I wait 50 frames
  And I capture "title"                             # by: human
  And I wait 50 frames
  Then the run reaches the same place               # placeholder — say what you want checked
```

Note the last line. The recorder cannot know what you were trying to prove, so it
writes a placeholder and says so. Replace it with what you actually want checked —
see [Scenario Goals and Acceptance](Scenario-Goals-and-Acceptance).

Then run it exactly like any other scenario:

```
runtime_scene_reel
  feature_path = scenarios/recorded-run.feature
  out_path     = recorded.gif
```

## Limits, stated rather than hidden

- **Anchors need the text screen.** Matching text on a C64 text screen is a table
  lookup — the screen *is* characters. In a bitmap mode there is nothing to look up,
  so the recorder says nothing there instead of inventing an anchor out of pixels.
  Drive anchors still work.
- **A press still held when you stop** is closed at the end of the recording, and
  said out loud.
- **A mount power-cycles the machine**, so the cycle counter restarts mid-recording.
  That is noted in the file, and the steps stay in the order they happened.
- **The journal is capped.** A recorder left armed for a very long time stops adding
  and tells you how many inputs it dropped, rather than growing without bound or
  quietly losing the end.

## Gotchas

- REC records inputs, not time. If you sit and think for two minutes, that becomes a
  long `I wait` — trim it in the editor.
- Stop the recording *before* you start editing. The overlay is a snapshot of what
  was recorded, not a live view.
- A recording that captures nothing produces a scenario that `runtime_scene_reel`
  refuses, because it would build an empty reel. Take at least one shot.
