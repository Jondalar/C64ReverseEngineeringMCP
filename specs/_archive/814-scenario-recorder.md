# Spec 814 — The scenario recorder: play it once, get the file

**Status:** BUILT 2026-08-20 — all nine deliverables, gated by
`npm run smoke:814` (39 checks, including the end-to-end one: a recorded journal is
emitted, parsed back, and REPLAYED on a real machine to the capture it names).
Amended the same day: **a key press IS recorded.** The first cut dropped
`session/key_down` with a warning, reasoning that a raw press "carries no text" — which
was the wrong question. It carries the matrix key NAME, which is exactly what
`session/key_down` takes back, and the duration it was held for, which is what `I type`
cannot express at all. So the vocabulary gained a step shaped like the joystick one:

```gherkin
  And I hold the key "SPACE" for 3 frames
```

That is not a nicety. A title that scans the matrix itself — `lda $DC01` in its own IRQ,
which is the ordinary way a menu reads SPACE or a letter — sees a key only if it is DOWN
at the moment of the scan. `I type` plays a queue out at the typing pace and can miss it
entirely. The key name is validated against the matrix's own list (`C64_KEY_NAMES`,
compile-time exhaustive against `C64KeyName`), so a name that does not exist is a red
line in the editor rather than a press that silently never happens.

One limit remains, stated rather than hidden: the anchor watcher reads the text screen
only — in a bitmap mode it says nothing rather than inventing an anchor out of pixels.
**Repos:** C64RE owns the recorder, the overlay, the editor and the save path. The
runtime gains one thing, and it is a fact about a machine: an input journal with
cycles (`session/input_journal`).
**Number:** 814 (registry: `specs/README.md`; reserved in 813 §7).
**Depends on:** 813 (the predicates and regions the recorder writes — it can only
emit what the parser reads, so 813 had to ship first), 812 (the step vocabulary and
the executor that replays the result), 810 (the file format and where the files
live).
**Origin:** the owner, 2026-08-18: *"Ich zeichne im C64RE UI die Steps für ein
Szenario auf, wie ein Makro-Recorder in Excel."* Shape decided the same day: a
button at the top, the finished macro as an overlay with a validating editor, and
the option to save it to disk.

---

## §1 The file already exists, in the run you just did

Writing a `.feature` by hand means guessing: how many frames until the menu, how
long to hold fire, when the load is done. You find out by running it, being wrong,
and editing the number. Meanwhile the run you were guessing about already happened
— you did it yourself, with your hands, and every input landed on an exact cycle
the machine knows.

The recorder takes that run and writes the file. This is 812 turned around: 812
replays a written schedule, 814 writes a schedule from a play-through.

## §2 The daemon stamps, never the browser

A recorded press is only worth anything if it carries the cycle it actually landed
on. If the UI timestamps its own click, what gets recorded is the WS round-trip and
the render loop — the recording is then a measurement of the network, and replaying
it lands somewhere else.

So the runtime keeps a journal: every input it applies while armed, with the cycle
it was applied at. The recorder reads that journal. Nothing about the recording is
derived from wall-clock time on the client, ever.

```
session/input_journal { arm: true|false }
  → { armedAtCycle, entries: [{ cycle, kind: "key"|"joystick"|"insert", ... }] }
```

## §3 What comes out is 813's vocabulary, not a transcript

A transcript of key events is not a scenario. The gaps between inputs have to
become steps, and a gap can be written two ways (812 §1, 813 §1):

- **as a wait** — `I wait 170 frames`, exact and brittle;
- **as a state anchor** — `I wait until the screen shows "PRESS FIRE" within 1200
  frames`, which survives a runtime change.

The recorder PROPOSES the second wherever it can see one, and falls back to the
first. It can see one when, in the gap, something appeared that was not there
before: text on the screen (813 §3), the drive going busy and idle again, the CPU
settling in a new place. What it cannot do is know which of those the human meant —
so every proposed anchor is written into the file, where a human reads it and keeps
or replaces it. That is what the editor in §5 is for.

**Every step carries who made it.** The session is shared — the human and the LLM
drive the same machine — so a recording is *what happened to this machine*, all of
it, and then says where each piece came from:

```gherkin
  And I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"    # by: human
  And I wait until the drive is idle within 9000 frames
  And I hold joystick 2 fire for 3 frames         # by: llm
```

Recording only the human's half would be tidier and wrong: if the LLM loads
something mid-recording, that step is missing from the replay and the scenario
stops working two lines later. Recording everything and MARKING it keeps the file
correct and lets the editor throw out what does not belong — "drop everything the
LLM did" is then one click, and a hand editor just deletes the lines.

The daemon already tags every input with its source, so the mark is carried, not
invented.

The rule is hard: **the recorder may only emit lines the parser accepts.** A
recorder that writes its own dialect is a text generator. Every emitted line goes
through `parseFeature` before the overlay opens, and a line that does not survive
that is a bug in the recorder, not a warning for the user.

## §4 The `Given` comes from the session, and the file says which

Recording rarely starts at power-on. The daemon knows how its current machine came
to be, so the recorder asks rather than guessing:

- a medium is mounted and the machine has not been power-cycled since →
  `Given the disk "…"`, and the file is self-contained: a paste is enough.
- anything else → the recorder writes a snapshot and emits `Given the snapshot
  "rec-….c64re"`. Honest, and worthless without the file beside it.

The overlay states which of the two it chose and why, because the difference
decides whether the scenario can be shared.

## §5 The overlay: an editor that speaks the same grammar as the parser

Stop recording and the finished macro opens as an overlay over the Live tab, in an
editor with three properties:

1. **It validates with the REAL parser.** Not a regex, not a second grammar in the
   browser — `parseFeature`, the same function the executor runs. Errors are shown
   on the line they belong to, with the parser's own message.
2. **Autocomplete comes from the parser's vocabulary**, exported for the purpose —
   the step forms, the predicates, the region forms, the key tokens. Never a list
   typed into the editor.
3. **It is editable**, because the recorder proposes and the human decides: swap a
   `wait` for an anchor, drop the three fumbled keypresses, rename a capture.
4. **It can filter by who did it** — the `# by:` marks of §3 — so a session the LLM
   was also touching becomes your macro in one click, without hunting for the lines.

Point 1 and 2 are one rule with two faces, and it is the rule this repo learned the
hard way the same week: a client that keeps its own copy of what a verb is becomes
a second authority, and a second authority drifts. The cockpit did exactly that and
answered `unknown command: /turbo` for a verb the daemon had. An editor with a
hand-written verb list is the same mistake with a nicer font.

## §6 Saving

The overlay saves to `<project>/scenarios/<name>.feature` — 810's location, so the
file is picked up by everything that already reads scenarios, and versioned by git
like the rest of them. Through the workspace HTTP API, which is where the UI's
persistence goes (the WS is the live-runtime transport only).

Saving is refused while the parser reports an error. A `.feature` that does not
parse is not a scenario, and writing one produces a file that fails at the moment
someone else tries to use it.

## §7 Where it lives, and what moves with it

**In the top bar** (`MachineControls`), with PLAY / PAUSE / snapshot. Arming a
recorder is a transport state like running or warping — it is on or it is not, and
you must see it AT ALL TIMES. A recorder you forgot is armed produces a file full
of everything you did while thinking. The top bar is the only strip that is always
on screen.

- **REC** arms the journal and shows it, unmistakably.
- **STOP** disarms and opens the overlay.

The overlay lies over the screen, the way the inspect overlay already does. It adds
nothing to the bottom of the tab.

**812's shutter moves up with it.** The bottom of the Live tab currently stacks the
filmstrip and the reel strip, and it cannot keep growing. The shutter is the same
gesture as REC from the other end — one takes pictures out of a run, the other
takes the run — so it belongs in the same place: the button in the top bar, the
thumbnails and the download in an overlay. That REMOVES a strip from the bottom
instead of adding one, and the two features stop being two idioms for one idea.

## §8 What this spec does not do

- **It does not record captures for you.** Where the pictures go is an authoring
  decision (812 §7). The recorder emits `I capture "…"` where the human pressed the
  shutter during the recording, and nowhere else.
- **It does not record mouse-driven UI actions** — scrubbing, rewinding, poking
  memory in the monitor. Those are things done TO the machine by the operator, not
  inputs a C64 can receive, and a scenario that replayed them would not be
  replaying a session.
- **It does not deduplicate or beautify.** A recorded run is what happened. The
  editor is where it becomes what you meant.

## §9 Deliverables

All built 2026-08-20. What each turned into is named after it.

**C64RE**

1. `src/project-knowledge/scenario-vocabulary.ts` — the step/predicate/region forms
   as DATA, exported from where the parser already knows them, for the editor's
   autocomplete and for the recorder's emitter. **The drift teeth are two
   compile-time assertions**: `STEP_KINDS` and `PREDICATE_KINDS` in the parser are
   checked against the `Step`/`Predicate` types in BOTH directions, so adding a kind
   and forgetting the list fails the BUILD; the smoke then asserts the vocabulary
   covers every kind, and parses every `sample` in it.
1b. A trailing `# comment` on a step or criterion line, stripped before matching —
   `stripTrailingComment`, quote-aware, because `I type "LOAD{QUOTE}#1{QUOTE}"` is a
   real line and a naive split would cut a C64 command in half.
2. `src/reel/record-scenario.ts` — journal → steps: gap analysis, anchor proposal,
   the `Given` decision of §4, and the emitted text, run through `parseFeature`
   before it is handed out. Pure: journal in, text out, so it is gated without a
   machine. It also segments on a clock that RESTARTS — a mount power-cycles the
   machine, and sorting the events by cycle would have quietly reordered everything
   after the mount to the front.
3. `ui/…/RecorderButton.tsx` — the armed indicator, the two actions, and the WATCHER
   that produces the anchor proposals (text appearing on the screen; the drive going
   busy then idle). The browser decides only WHEN to look; every observation carries
   the cycle the daemon reported in the same breath.
4. `ui/…/ScenarioOverlay.tsx` — the overlay, the editor, per-line errors,
   autocomplete, the by-whom filter, save.
5. `POST /api/scenario/save` → `<project>/scenarios/<name>.feature`. It re-parses
   server-side and refuses a red file, and it treats the name as a FILENAME so a save
   cannot climb out of the project.
5b. `ReelStrip` moved to the same shape — shutter in the top bar, thumbnails and
   download in an overlay — so the bottom of the Live tab loses a strip rather than
   gaining one.

**TRX64**

6. `session/input_journal { arm }` — the armed input journal with cycles. The only
   new machine fact. Recorded from the SAME pre-dispatch hook that flips the control
   owner, so one place sees every input with its `source`; a `push()` in each handler
   is the shape that leaves one handler out and nobody notices until a replay is
   missing a keystroke. Capped at 20 000 entries, and it SAYS how many it dropped.

## §10 Gates

- A recorded journal → emitted text → `parseFeature` → the SAME steps, for keys,
  joystick holds, an insert and a capture. Round-trip, not eyeballed.
- A scenario recorded from a medium replays under `runtime_scene_reel` and produces
  the same captures. That is the whole promise, so it is gated end to end.
- The editor's autocomplete list is derived from the vocabulary module: a gate adds
  a step form to the parser and asserts the list grew, so the two cannot drift.
- Saving with a parse error is refused, and the message names the line.
- The recorder emits a state anchor where one exists and a plain wait where none
  does, both replayable.
- A step recorded from an LLM input carries `# by: llm`, a human one `# by: human`,
  and BOTH parse to the same step as the unmarked line — the mark is a comment, not
  a dialect.
- Dropping the LLM's lines leaves a scenario that still parses.
