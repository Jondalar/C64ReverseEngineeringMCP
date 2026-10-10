# Spec 899 — A scripted run can press a key anywhere in the frame and watch every frame

**Status:** DONE (2026-10-10). The runtime half (Spec 901) is on TRX64 main (e0ac127) and not released yet: the live gate runs against a build of it, and every new option refuses by name on a runtime without it.
**Repo:** C64RE (the step notation and its report). TRX64: Spec 901 (cycle-exact input, the frame probe).
**Number:** 899 (registry: `specs/README.md`).
**Origin:** issues #67 and #68 (Mike, the Mega Vault VIC-20 → C64 port, 2026-10-10). Owner
decision, same day: TRX64 delivers the capability, C64RE the Gherkin on top.

---

## §1 What is wrong

**Input always lands on a frame boundary (#67).** Every step of `runtime_sandbox_run` /
`runtime_scene_reel` lasts whole frames, and the machine is deterministic, so a scripted key
or fire press reaches the game at the same beam position every run. A bug that depends on
where the beam is when input arrives never shows. The case: the port's boot did
`lda $D011 / ora #$10 / sta $D011` after setting up the raster IRQ. Bit 7 reads the beam's
line bit 8 but writes the IRQ line's bit 8, so with the beam below line 255 the IRQ line
became 507, which PAL never reaches. In VICE about 1 press in 5 hit it, but every TRX64 run passed.

**A `Then` is decided only where it stands (#68).** `Then $D01C@io is $04` is checked at the
end of the step before it. A state that is wrong for a few game ticks, such as the laser sprite
drawn white and hires before it turns multicolour, falls between two checks. Sampling every
2–20 frames over several hundred frames never caught it. A hundred `I wait 1 frames` /
`Then …` pairs would work in principle, but they still sample only once per frame, at a
boundary rather than at a raster line.

## §2 Decision

**D1 — An input offset, reproducible.** A step that presses something (`I type …`,
`I hold joystick …`, `I press …`) can be shifted inside the frame:

- `input_offset_cycles: N` on the call shifts every input step by N cycles past its frame
  boundary;
- `jitter_seed: S` gives each input step its own seeded offset within the frame.

The result reports the offset each step used, so a failing run replays exactly with the same
offsets. Without either, nothing changes: today's runs keep their bytes.

**D2 — A sweep.** `sweep: K` runs the same steps K times, with offsets spread evenly across
one frame of the machine's model (PAL 19656 / NTSC 17095 cycles), and returns PASS/FAIL per
offset plus the first failing offset. Each run is its own sandbox daemon, so a sweep keeps the
budget rules of `runtime_sandbox_run`.

**D3 — A check that holds over a window.**
`Then $D01C@io is $04 throughout the next 600 frames` (also `… at every frame for N frames`)
is decided by Spec 901's frame probe in assert mode. It reports PASS, or the first frame and
cycle where the value failed and what it was.
An optional `at raster line L` samples where the frame was actually displayed. The default is
the line after the visible area, so the check sees the frame that was shown.

**D4 — A sample series.** `read_series: ["$D01C:1@io", "$D029:1@io"]` with `every_frames: 1`
over a window returns a compact table: only the rows where a value changed, each with its frame
and cycle. The same notation is available in a `.feature` file for `c64re scenario run`.

**D5 — One notation.** D1–D4 live in `src/project-knowledge/scenario-gherkin.ts`, so the
sandbox, the scene reel and `c64re scenario run` parse them the same way. Tool descriptions
and `docs/` describe them.

## §3 Out

- No randomness that cannot be replayed. Every offset is in the result.
- No new emulation. The beam position, input timing and sampling are TRX64's (Spec 901).
- No shared-session sweep. A sweep only ever uses sandbox daemons.

## §4 Acceptance

- A fault-injection build of the `$D011` case (Mega Vault `port/v2/test_d011_v2.tas`, or a
  synthetic PRG that does the same read-modify-write after arming a raster IRQ) fails at some
  offsets of a `sweep: 8` and passes at the others. Replaying a failing offset fails again.
  The healed build passes at every offset.
- A synthetic PRG that holds a register at a wrong value for 3 frames out of every 200 fails
  `Then … throughout the next 600 frames` at the first such frame, naming frame, cycle and value.
  The same PRG with the glitch removed passes.
- `read_series` over 600 frames of that PRG returns only the changing rows.
- Runs without D1–D4 replay byte-identical to before (existing scenario e2e).

---

## §5 What was decided while building it

- **Where an offset counts from.** From the point the step would have pressed at — the schedule's
  own clock, which is a whole number of frames on from where the steps began. A sweep needs only
  that the offsets cover one frame, not that the clock sits at the VIC's frame start.
- **`I type`** has no cycle of its own in the runtime. An offset runs the machine that far first,
  and in the sandbox the step's own duration gives it back, so later steps keep their place. A
  reel's `I type` has no duration, so there the later steps move by the offset.
- **A hold of N frames** schedules its release too, `N` frames after the press, before the run:
  a release called after the run could find the clock already past it.
- **A seeded offset** depends on the seed and the step's index only (a 32-bit mix), never on the
  other steps.
- **The default sample line** is the line after the model's visible window (288 on PAL, 12 on
  NTSC), read from `session/models`, not kept here.
- **`is not` / `is one of` over a window** read the probe's series (it holds every change, and
  between changes the value does not move) instead of assert mode, which can only say `is`.
- **`every N frames`** is read from the per-frame change rows; nothing runs twice.
- **A probe stopped by a breakpoint or watchpoint** is an undecided check, not a failure; the
  scenario runner reports it as ERROR, with the stop in words.
- **A green run with the input moved** is not recorded as the emulator's pass for the C64
  Ultimate gate: it is a probe, not the run of record.
- **The reel** takes the offset options and refuses a series step (it reports pictures); its
  `Then` lines stay as they were.
- **`read_memory`'s length is hex, a series read's is decimal** (`$` makes it hex). `read_memory`
  was left alone.
