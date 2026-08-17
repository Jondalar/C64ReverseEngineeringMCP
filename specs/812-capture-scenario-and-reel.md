# Spec 812 — Capture scenario: a deterministic input schedule, and the reel it produces

**Status:** BUILT 2026-08-17 — all six deliverables shipped, all five gates green
(`cargo test -p trx64-cli --test e2e_812_capture_scenario`, `npm run smoke:812`).
Open: nothing in this spec. The reel-authoring half — which screens tell the story,
near-duplicate removal, the ≥5-screens rule as a check rather than a note — is
deliberately left to the caller for now (§7); promote it here if it turns out to
need a tool of its own.
**Repos:** both. Execution + encoding → TRX64 (`trx64cli reel`, `trx64-core::gif89a`).
Authoring, selection and the MCP door → C64RE (`runtime_scene_reel`).
**Number:** 812 (registry: `specs/README.md`).
**Depends on:** 787/788 (scratch instances — the isolation this runs in), the existing
`scenario_player.rs` (the cycle-anchored schedule this extends).
**Relates to:** 810 owns the *goal* notation (Gherkin, Given/When/Then, acceptance).
812 owns the *schedule* underneath it. 810 compiles down to 812; 812 never evaluates a
goal.
**Origin:** [C64RE issue #3](https://github.com/Jondalar/C64ReverseEngineeringMCP/issues/3)
— a CSDb-format release GIF, today hand-orchestrated per project against a
privately-spawned daemon.

---

## §1 The one thing that is missing, and it is missing twice

A capture recipe today reads *"press down, then run about two million instructions"*.
Two million instructions is not a moment; it is two seconds of C64 time with the stick
held. A menu that samples once per frame scrolls through it. Run the same recipe again
with a slightly different budget and it stops somewhere else.

That is issue #3's problem — the reel cannot be rebuilt — and it is issue #2's problem —
the boot cannot be repeated. **Both are the same absence: no clock.** One artifact fixes
both, and the second fix is free: a scenario that replays to the same bytes twice is the
determinism test.

The clock is half-built already. `ScenarioPlayer` (`trx64-core/src/scenario_player.rs`,
ported from the TS) schedules steps at an absolute `at_cycle` or `at_frame` and fires
them from the machine clock, never from wall time. Its `JoystickScript` variant already
carries `duration_frames`. What it cannot do is take a picture, wait for a condition, or
run anywhere but on the caller's machine.

## §2 A scenario is JSON. Gherkin is a front end, not a second format

810 chose Gherkin for goals because a human reads it. A schedule is not read by a human
in the same way — it is generated, diffed, and replayed byte-for-byte. So the executor's
input is JSON, and if 810 later wants `When the intro is skipped` it compiles that to
this. One executor. Two notations at most, never two engines.

```jsonc
{
  "name": "release-reel",
  "media": "…/side1.g64",
  "cyclesPerFrame": 19656,          // PAL; the schedule's unit
  "reel": { "delayMs": 700, "maxBytes": 512000 },
  "steps": [
    { "wait":  { "frames": 260 } },                    // cold boot → READY
    { "type":  { "text": "LOAD\"*\",8,1\r" } },
    { "waitUntil": { "screenStable": { "frames": 120 }, "timeoutFrames": 3000 } },
    { "shot":  { "label": "title" } },
    { "joy":   { "port": 2, "down": true, "frames": 2 } },   // press AND release
    { "wait":  { "frames": 20 } },
    { "joy":   { "port": 2, "fire": true, "frames": 2 } },
    { "waitUntil": { "screenStable": { "frames": 90 }, "timeoutFrames": 2000 } },
    { "shot":  { "label": "menu-selected" } }
  ]
}
```

Steps in file order. Each carries its own duration; nothing is implied by what the next
call happens to do. `joy` is a press *and* its release — the shape that was not
expressible before, and the direct cause of the wrong menu entry in issue #2's second
attempt.

## §3 Two kinds of waiting, and both are needed

`wait` is exact and reproducible to the cycle. It is also brittle: a fix that shifts
timing by 200 cycles invalidates every stored scenario that used it.

`waitUntil` survives that. Three predicates, all cheap and all already readable from the
machine:

- `pc: "$C001"` — the CPU reached an address.
- `screenStable: { frames: N }` — the rendered frame has not changed for N frames.
- `driveIdle: true` — the 1541 has stopped stepping.

with a mandatory `timeoutFrames`, because a predicate that never fires must fail loudly
rather than hang a capture.

**The scenario records which kind each step used**, so when a replay diverges, the file
itself says whether the scenario was brittle or we were.

## §4 A shot lands on a frame boundary

`session/screenshot` renders `vic.displayed`, the frozen previous frame. Ask for it
mid-frame and you get the one before the interesting one; 808 already taught this. So
`shot` first advances to the next raster-line-0 boundary, then captures, and records the
cycle it actually fired at. That cycle goes in the manifest: a reel is re-derivable from
its own output.

## §5 It runs in its own process, never in the shared session

Doctrine rule 2: the session the human sees is one, and point work gets its own
sandbox. A capture run boots cold, types, and throws its machine away — exactly a 787
scratch instance, and `trx64cli boot` already is one (`boot_engine` →
`create_embedded_state`, no daemon, no port).

So the executor is `trx64cli reel`. No WebSocket, no port allocation, no budget-reaper:
the process ends when the reel is written. The reporter of #3 built a private daemon by
hand for this; the point of the spec is that nobody should have to.

## §6 The reel is GIF89a, and it needs no quantization

CSDb wants exactly 384×272 including border, GIF, ≤ 512000 bytes, hard cuts, uniform
delay. That happens to be what the VIC already produces:

- `render_canvas_indices` returns **384×272, one byte per pixel, 4-bit colour index** —
  `CANVAS_W`/`CANVAS_H` are the VICE x64sc PAL canvas, border included.
- `COLODORE` is **16 RGB entries**.

A GIF global colour table is 16 entries; the pixel data is exactly those indices. There
is no palette to build, nothing to dither, and no colour drifts between frames — the
opposite of the client-side `quantize` path in use today. Per frame: LZW over the index
buffer, `disposal = 2`, one uniform delay, Netscape loop block.

`trx64-core::gif89a` is written here rather than pulled in, for three reasons: the
input is already palette-indexed so the encoder is small; it keeps the byte clamp
inside the thing that knows the frames; and it adds no dependency to a GPL workspace.

**The clamp is honest.** Over `maxBytes`, drop frames — never silently re-encode at
lower fidelity, never truncate the file. Report which frames were dropped and why.

**Verification is structural.** The gate parses the produced GIF as GIF89a blocks
(header → LSD → GCT → per-frame GCE + image descriptor + LZW sub-blocks → trailer) and
counts frames. Scanning for the `21 F9` GCE marker is not verification — that byte pair
occurs inside LZW pixel data, which is the trap the reporter hit.

## §7 Who owns what

**TRX64** executes and encodes: run the schedule, take the frames, write the GIF.
It knows nothing about releases, menus, or what a good screenshot is.

**C64RE** authors and selects: which waypoints tell the story of this release, the
natural playthrough order, near-duplicate removal, the ≥ 5-screens rule, where the
scenario file lives in the project. The MCP tool `runtime_scene_reel` writes the
scenario, invokes the binary through the existing `src/sandbox/trx64cli.ts` bridge, and
registers the result as a project artifact.

That is the Leitregel applied unchanged: capability → TRX64, meaning → C64RE.

## §8 Determinism falls out, and it is the gate

Two runs of one scenario from a cold boot must produce **byte-identical GIFs**. That is
the acceptance test for this spec, and it is simultaneously the instrument issue #2
needs: if the same schedule diverges, the divergence is ours and reproducible without
anyone's private disk.

Gates:

1. `a_scenario_replays_to_the_same_bytes` — same file, two cold runs, identical output.
2. `a_reel_is_a_wellformed_gif89a` — block-structure parse, frame count, 16-entry GCT,
   uniform delay, ≤ maxBytes, 384×272.
3. `a_joystick_press_spans_the_frames_it_says` — a 2-frame press is visible to the
   machine for 2 frames and released after, measured at CIA1.
4. `a_shot_lands_on_a_frame_boundary` — the recorded capture cycle is a raster-0 cycle.
5. `a_predicate_that_never_fires_times_out` — loud failure, not a hang.

## §9 What this spec does not do

- **It does not evaluate a goal.** No pass/fail on content, no acceptance, no baseline.
  That is 810, and it sits on top.
- **It does not drive the live session.** Not an option, not a flag.
- **It does not choose the screens.** It executes the waypoints it is given.
- **It does not replace `trx64cli boot`.** `boot` mints a snapshot; `reel` produces
  frames. `reel` may later grow `--dump` and subsume it, but not in this spec.

## §10 Deliverables

| # | Where | What |
|---|-------|------|
| 1 | TRX64 `trx64-core/src/gif89a.rs` | GIF89a encoder over palette indices + block-structure parser (used by the gate) |
| 2 | TRX64 daemon | `session/frame_indices` — the 384×272 index buffer + palette, so the capture path is an API and not a private field read |
| 3 | TRX64 `trx64-cli/src/reel_cmd.rs` | scenario parse → isolated boot → step execution → frames → GIF + manifest |
| 4 | TRX64 `trx64cli reel` | subcommand, `--json` envelope |
| 5 | C64RE `runtime_scene_reel` | MCP tool: waypoints → scenario file → binary → artifact. Registered in `DEFAULT_TOOLS` |
| 6 | Both | the five gates of §8 |

## §11 What building it taught

**The GIF encoder was wrong in a way our own tests could not see.** The first
version widened the LZW code at `next_code == 1 << code_size`, and a decoder
written from the same understanding read it back perfectly — eight green tests
over a stream no real library accepts. An outside decoder rejected it on the first
try (`broken data stream`). A decoder learns each dictionary entry one code late,
so it counts one behind the encoder; the encoder must widen *strictly past* the
current width. The gate is now an opt-in probe (`TRX64_GIF_PROBE=<path>`) that
writes a reel plus its source indices for something that is not ours to check.
Agreeing with yourself is not verification.

**`driveIdle` had to mean "worked, then stopped".** Written as "is the drive idle",
it fired instantly after a `LOAD` — the C64 was still printing SEARCHING and the
drive had not spun up — and the reel captured the prompt. It now requires the
busy→idle edge, and says so when the drive never became busy at all. Same shape as
the rule that a control is worthless until it reaches the state.

**And the busy signal is the LED, not the motor.** A 1541 keeps spinning after a
load finishes, so `motorOn` answers a different question. The repo had already
learned this once, in `drive_status`.

**`screenStable` cannot be used at a BASIC prompt.** The cursor blinks about every
20 frames, so no stability window longer than a blink is ever reachable. The
timeout message now reports the longest still stretch it saw and names the three
predicates that do work there, because the first failure gave no clue.
