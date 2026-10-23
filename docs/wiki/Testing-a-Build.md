# Testing a Build

You changed a game: a port, a trainer, a saver, a fix. It works today. The question is
whether it still works after the next build, and the one after. A check you did by hand
once is gone the moment you stop looking; two features of a project were lost that way
without anyone noticing. A **test scenario** is that check written down: one file per
behaviour, run after every build, the same bytes giving the same verdict.

## The idea

A test starts the machine from a known state, puts **the build's bytes** into it, plays
fixed inputs and states what has to be true afterwards. It is run twice in one go: with
your bytes, and without them (the **baseline**). A test that passes without your bytes
proves nothing, so the baseline is part of the test.

## 1. Make the start state

The state the tests start from is a scenario that ends in `And I set the anchor`:

```gherkin
Scenario: get to the first level
  Given the disk "game.d64"
  When I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"
  And I wait until the drive is idle within 9000 frames
  And I wait until the CPU reaches $0B00 within 4000 frames
  And I set the anchor "level1"
  Then the CPU is at $0B00
```

Run it once with `c64re scenario run`. It writes `knowledge/anchors/level1.c64re`, a file in
the project. (A `.c64re` snapshot from anywhere works too: `Given the snapshot "states/level1.c64re"`.)

## 2. One test per behaviour

```gherkin
Scenario: the trainer keeps the lives at 9
  Given the mark "level1"
  And variant "build" loads "build/trainer.prg"
  When I hold joystick 2 fire for 30 frames
  And I wait for 200 frames
  Then $0035 is $09
  And the baseline fails
```

- `And variant "build" loads "<file>"` puts built bytes into the machine as they are.
  - A file ending in `.prg` brings its own load address; its first two bytes are the
    address and are not loaded. `loads "build/trainer.prg" at $0900` places it elsewhere.
  - Any other file is headerless and needs `at`: `loads "build/patch.bin" at $47A5`.
    No address is ever guessed from the bytes; without `at` the line is refused.
  - In a cartridge bank: `loads "build/bank3.bin" at roml bank 3 $8000` (or `romh`).
  - Several `loads` (and `assembles`) lines under one name are one variant.
- `Then the baseline fails` says the start state's own code must **not** show the facts.
  `Then the baseline passes` says it must (the change must not alter this behaviour).

## 3. The verdict

A scenario with a baseline line is a test. It is **PASS only when every variant passes
all its `Then` lines and the baseline does what the line says.** The report names the part
that failed:

```
FAIL  baseline  1 checked (required to fail)
PASS  build     1 checked
FAIL  baseline should fail but passed: the start state already shows these facts, the test cannot see the change
```

A test needs a variant: with nothing to compare, the file is refused when it is read.
A scenario without a baseline line is a *trial* (see [Trying a Fix](Trying-a-Fix)): it passes
when any variant passes, and its run is kept as a candidate. A test keeps no candidate.
With `--json`, each scenario carries `"mode": "test"` or `"mode": "trial"`.

## 4. Run the whole folder after every build

```
c64re scenario run tests/
```

or `runtime_feature_run` with the folder. Without `c64re` on the path, from a checkout:
`node <checkout>/dist/cli.js scenario run tests/`. The exit code is 0 only when every test
passed, so `make` and CI can use it. Each test runs on machines of its own; the machine you
are watching is not touched.
