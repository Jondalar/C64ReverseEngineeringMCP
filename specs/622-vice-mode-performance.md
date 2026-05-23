# Spec 622 — vice-mode Headless Performance

**Status:** §4.0 IMPLEMENTED + merged to master (commit `2d9e4de`, 2026-05-20): dropped forced `useCycleLockstep` in vice mode → **0.50×→0.82× realtime** AND a $DD00 timing/correctness fix (7-game loader matrix reaches graphics with ZERO JAMs, byte-identical output). §4.1 (VIC draw hot path), §4.2 (drive 6510 core), §4.3 (scheduler) remain open candidates.
**Parent specs:** `specs/600-runtime-proof-gates.md` (literal-port renderer is the proof oracle — must NOT be weakened), `specs/611-new-vice1541-side-by-side.md`, `specs/618-fastloader-dd00.md`.
**Branch:** landed on master (was `codex/615-gcr-decode-fidelity`, merged).

## 1. Problem

In `drive1541Implementation="vice"` mode the headless emulator runs at
**~0.50× realtime**, so disk loads take ~2× their real-hardware wall time.
A 36 KB KERNAL load (LNR s1 boot) = ~127 s realtime-equivalent → ~250 s
wall; the C64 sits in "LOADING" for minutes and feels stuck even though it
is loading correctly. User verdict: performance "unterirdisch".

This spec captures the measured cost breakdown and an **in-place,
output-preserving** optimization plan. It does NOT propose changing the
renderer.

## 2. Measurements (2026-05-20)

Throughput, vice-mode motm fastloader window, `node` (Opus harness):

| Config | Throughput | vs realtime |
|---|---|---|
| baseline (literal-port, vice drive) | 0.49 Mcyc/s | 0.50× |
| legacy DriveCpu tick gated OFF | 0.46 Mcyc/s | 0.46× |

VICE x64sc (native C) = 0.985 Mcyc/s realtime. We are ~2× slower = the
JS-vs-C gap, dominated by the VIC renderer.

Gating the co-resident legacy DriveCpu gave **no speedup** (it was already
quiet/no-op) — so that is NOT the bottleneck. (Flag added regardless:
`C64RE_VICE_LEGACY_DRIVE=1` opt-in, commit `b687885`.)

### 2.1 Profile (`node --prof`, vice-mode motm, 25M-cycle window)

```
Summary: 92.8% JavaScript, 4.2% GC, 7.1% unaccounted

VIC literal renderer (~55% total):
  draw_graphics            10.4%   vicii-draw-cycle.ts:201 (called ×8/cycle)
  vicii_cycle               9.3%   vicii-cycle.ts:254 (per-cycle VIC timing)
  draw_sprites              6.8%   vicii-draw-cycle.ts:332
  draw_sprites8             5.9%   vicii-draw-cycle.ts:445
  update_sprite_xpos        4.9%   vicii-draw-cycle.ts:438
  vicii_draw_cycle          3.9%   vicii-draw-cycle.ts:620 (orchestrator)
  draw_graphics8            3.8%   vicii-draw-cycle.ts:230
  get_trigger_candidates    2.2%   vicii-draw-cycle.ts:300
  draw_colors_6569          0.8%   vicii-draw-cycle.ts:554
  draw_border8              0.7%

vice drive (~17%):
  drive_6510core_execute   15.3%   drive_6510core.ts:232
  rotation_1541_gcr         1.6%   rotation.ts:377

C64 CPU + scheduler (~12%):
  executeCycle              4.5%   cycle-lockstep-scheduler.ts:21
  executeMicroOp            1.4%   cpu65xx-vice.ts:742
  executeCycle              1.1%   cycle-wrappers.ts:97
  stepC64Instruction        0.9%
  startInstructionCycle     0.6%, executeFinalOp 0.6%, ...

Builtins (deopt signal):
  KeyedLoadIC_Megamorphic   1.1%   (polymorphic/keyed property loads)
  FastNewFunctionContextFunction 0.5%
```

`vicii_cycle()` calls `vicii_draw_cycle()` every C64 cycle
(vicii-cycle.ts:288); `vicii_draw_cycle` calls `draw_graphics(0..7)` +
`draw_sprites` + `draw_colors8` (8 pixels/cycle). So the per-pixel draw
work runs ~8× per cycle, ~63504 cycles/frame, ~50 frames/s = the dominant
cost.

## 3. Hard constraints (user mandate 2026-05-20)

1. **Literal-port stays the sole renderer.** No alternate/per-frame/
   rasterized renderer, no frame-skipping, no "render only when displayed".
   Spec 309 made literal-port the sole renderer and Spec 600 proof gates
   depend on its per-cycle pixel accuracy.
2. **Pixel-identical output.** Every optimization must produce byte-identical
   framebuffers vs the current code. Verify via PNG/`dbuf` diff on the proof
   oracle scenes (`samples/screenshots/proof/*.png`) — zero pixel delta.
3. **No accuracy loss** in VIC timing, bad-line/DMA/BA, sprite DMA, or the
   drive cycle model.

So this is pure **micro-optimization of the existing hot functions** + the
drive core + dispatch, not an architecture change.

## 4. Candidate optimizations (in-place, output-preserving)

Ranked by leverage × safety. Each must be measured + pixel-diff-verified
independently.

### 4.0 STRUCTURAL — stop forcing useCycleLockstep in vice mode — **IMPLEMENTED 2026-05-20 (commit `2d9e4de`). PERFORMANCE *AND* $DD00 TIMING/CORRECTNESS FIX.**

**This was not a perf-only change.** Removing the un-VICE-shaped forced
global per-cycle `CycleLockstepScheduler` (→ EventCatchupStrategy, VICE's
event-driven `iecbus_cpu_*_conf1 → drive_cpu_execute_one` model) fixed the
`$DD00` fastloader bit-bang timing.

**Correctness result (the bigger one):** post-§4.0 the full 7-game loader
matrix reaches game graphics with ZERO JAMs. Before §4.0 (forced lockstep)
**polarbear + IM2 JAMmed** at `$1463` on a corrupt `$DD00` byte stream — the
forced per-cycle co-step skewed the C64↔drive bit-bang handshake timing.
Scramble (KRILL `$DD00`), polarbear (KERNAL→`$DD00`), IM2 (`$06xx`), motm
(`$07xx`) all now load correctly. So the forced lockstep was the **`$DD00`
fastloader timing root-cause candidate** (see Spec 618 matrix), not just a
perf cost.

**Performance result:** throughput 0.50× → 0.82× realtime (+64%).

**Fidelity preserved:** motm gold fastloader swimlane 73728-byte overlap /
0 mismatches; lnr-s1 KERNAL load 35990 bytes complete (ST=$40); 616 load
15/16 exit 0; 617 save 9/9 exit 0; same cycle-progress as lockstep → VIC
output unchanged; proof-gate oracles use the legacy drive (unaffected).

The force was removed (integrated-session.ts); `useCycleLockstep` is now
opt-driven (default false → EventCatchupStrategy) for vice mode too, still
reachable via the explicit opt + `C64RE_VICE_LEGACY_DRIVE` for bisects.


**Finding (2026-05-20).** `drive1541="vice"` force-sets
`useCycleLockstep=true` (integrated-session.ts:477), switching the WHOLE
C64/VIC into the per-cycle `CycleLockstepSchedulerImpl`. This is NOT
VICE-shaped and is the prime structural perf cost (`executeCycle` 4.5% +
per-cycle dispatch granularity on top of the VIC).

Why it is leftover, not needed:
- The **drive is already event-driven**. `afterCycleSync` for vice =
  `undefined` (Codex 2026-05-19): the per-c64-cycle drive tick (Spec 614.3)
  was reverted as "over-engineering — VICE's `drive_cpu_execute_one` is
  event-driven from `iecbus_cpu_*_conf1`, NOT per c64 cycle." The 1541 now
  catches up ONLY at `$DD00` R/W via the bridge `pushFlush.one/all →
  vice.tickToClock(clk)` + `additionalCatchUp` at instruction boundaries.
  That is exactly VICE's model.
- **VIC cycle-accuracy does NOT come from the lockstep scheduler.** Per
  Spec 425 the C64 CPU calls `vicii_cycle()` from inside `tick()` every
  cycle, in BOTH scheduler paths. Proof: the Spec 600 proof-gate
  screenshots (`test-*-screenshots.mjs`) run with `useCycleLockstep=false`
  (legacy/eventCatchup) and produce the pixel-exact oracle PNGs. So
  eventCatchup already yields a cycle-accurate VIC.
- Therefore the forced lockstep only adds finer-than-VICE per-cycle C64
  stepping (per-cycle IRQ-pin update + per-cycle BA bus-stall) with no
  drive-accuracy or VIC-accuracy justification that eventCatchup lacks.

VICE reference model (what we should match):
- `maincpu_mainloop` (src/maincpu.c) — C64 CPU runs instruction-by-
  instruction; **alarm contexts** (VIC raster, CIA timers) fire at
  scheduled clocks. NOT a global per-cycle co-step of C64+drive.
- `iecbus_cpu_read_conf1` / `iecbus_cpu_write_conf1` (src/iecbus/iecbus.c)
  call `drive_cpu_execute_one/all(clock)` AT the `$DD00` access instant —
  event-driven drive catch-up to the exact clock.
- `drive_cpu_execute_all` also called periodically from the main loop.
- Our `EventCatchupStrategy` (instruction-stepped C64 + `catchUpDrive` at
  instruction boundaries) + the bridge `pushFlush` (drive catch-up at
  `$DD00` events) is the faithful analog.

**Smallest rebuild plan:**
1. Remove the `if (opts.drive1541 === "vice") this.useCycleLockstep = true;`
   force (integrated-session.ts:476-477). Let `useCycleLockstep` follow
   `opts` (default false → `EventCatchupStrategy`).
2. Keep the vice-drive bridge unchanged: `pushFlush.one/all` →
   `vice.tickToClock(effClk)` at every `$DD00` R/W, `additionalCatchUp` at
   instruction boundaries. Verify `effClk` passed to the bridge is the
   exact CPU-cycle of the bus access in eventCatchup (the bus access already
   carries the live `c64Cpu.cycles` stamp — confirm no off-by-one).
3. Leave the cycle-lockstep scheduler code in place + reachable via the
   explicit `useCycleLockstep` opt (probes / bisects).
4. No change to the VIC, the drive core, or the IEC primitives.

**Decisive verification (revert if any fails):**
- 7-game proof-oracle pixel diff = ZERO (confirms VIC accuracy unaffected
  → lockstep was NOT providing needed C64 cycle-accuracy).
- 616/617 byte-fidelity + chain + `check:1541-fidelity` 0 FAIL (drive load
  accuracy).
- motm gold fastloader swimlane still 0 byte-divergence (the `$DD00`/`$1800`
  handshake stays cycle-exact under eventCatchup).
- Throughput measure — expect the largest single jump here (drops the
  per-cycle C64 scheduler dispatch).

If the pixel diff is non-zero, the lockstep WAS supplying per-cycle C64
timing (IRQ-pin / BA bus-stall granularity) that eventCatchup lacks — then
keep lockstep and pursue §4.1+ instead. The experiment is low-risk and
self-falsifying.

### 4.1 VIC draw hot path (~35% in draw_*) — highest leverage

- **C-1 Property-access hoisting.** The draw functions read `vicii.dbuf`,
  `vicii.dbuf_offset`, `vicii.color_latency`, `vicii.last_color_*` etc.
  repeatedly inside per-pixel loops. Hoist the per-cycle-stable ones into
  locals once per `vicii_draw_cycle` call. Investigate the
  `KeyedLoadIC_Megamorphic` source — likely a `vicii.*` access on an object
  whose shape V8 sees as polymorphic. Pinning `vicii`'s shape (stable field
  init order, no late-added props) can de-megamorphize all hot reads.
- **C-2 Monomorphize the draw dispatch.** `draw_graphics`/`draw_sprites`
  are module functions over module-`let` state — already cheap, but the
  ×8 unrolled calls + the `colors[]` plain-`number[]` lookup
  (vicii-draw-cycle.ts:189) could become a typed-array lookup (Int8Array)
  to avoid boxed-number/HOLEY-array deopts.
- **C-3 Skip provably-idle pixel work.** Within the literal model, when the
  beam is in a region whose output is fully determined by a single color
  (e.g. vertical/horizontal border with no sprites pending), the per-pixel
  branch chain can short-circuit to a memset-style fill of the 8-pixel
  group — IF and only if it yields identical `dbuf` bytes. This is an
  optimization of the SAME renderer (same output), not a different renderer.
  Must be gated behind exact-equivalence proof.

### 4.2 Drive 6510 core (~17%)

- **D-1** `drive_6510core_execute` (drive_6510core.ts:232) is the cycle-
  accurate drive 6502. Profile its inner micro-op dispatch for the same
  property-hoist / monomorphization wins as the C64 `cpu65xx-vice`.
- **D-2** `rotation_1541_gcr` (1.6%) runs per drive cycle; check for
  redundant recompute when the head is stationary between byte boundaries.

### 4.3 Scheduler / dispatch (~12%)

- **S-1** `executeCycle` appears in BOTH cycle-lockstep-scheduler (4.5%) and
  cycle-wrappers (1.1%) — possible double-dispatch layer. Verify the
  per-cycle call chain isn't wrapping the same work twice in vice mode.
- **S-2** GC 4.2% — hunt per-cycle allocations (closures, temp objects,
  `FastNewFunctionContextFunction` 0.5% = per-call closure creation). Hoist
  any per-cycle-allocated closure/array out of the hot loop.

## 5. Methodology

1. Re-profile with `node --prof` + `--prof-process` bottom-up to get exact
   hot lines + IC states for the targeted function BEFORE editing.
2. One optimization at a time. After each:
   - **Pixel-diff gate:** render the 7-game proof scenes
     (`scripts/test-game-screenshots-all.mjs` / the `samples/screenshots/proof/`
     oracles) and assert ZERO pixel delta vs pre-change.
   - **Throughput measure:** the §2 motm-window Mcyc/s probe.
   - **Regression gate:** `npm run check:1541-fidelity` 0 FAIL +
     616/617 byte-fidelity tests still green.
3. Keep only changes with measurable speedup AND zero pixel delta. Revert
   anything that risks output.

## 6. Acceptance

Spec is DONE when:
1. vice-mode throughput improves measurably (target ≥ 0.8× realtime; stretch
   1.0×) on the §2 motm window.
2. Pixel-identical output on all proof oracle scenes (0 delta).
3. `npm run check:1541-fidelity` 0 FAIL; 616/617 tests green; 600 runtime
   proof gates unaffected.
4. No renderer swap, no accuracy loss.

## 7. Non-goals

- Replacing or bypassing the literal-port renderer.
- Per-frame / rasterized / frame-skipping rendering.
- Reducing VIC or drive cycle accuracy.
- Native/WASM rewrite (separate long-horizon track; this spec is JS-level
  micro-opt only).

## 8. Notes / open questions

- The hard ~2× floor is the JS-vs-C gap. JS micro-opt can plausibly close
  part of it (target 0.8×) but not fully reach native C without a WASM hot
  core — explicitly out of scope here.
- If 0.8× proves unreachable by micro-opt alone, a follow-up spec may scope
  a WASM port of the VIC draw inner loop (still the SAME algorithm/output),
  which is the only path to true 1.0×+ while keeping pixel parity.
