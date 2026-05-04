# Spec 105 — Headless M2.3: VIC-II Fidelity

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 2, story M2.3
Depth: deep
Predecessors: Sprint 70+ (Phase A), Sprint 73 (modes), Sprint 74
(sprites), Sprint 78 (raster IRQ), Spec 098 (M1.1), Spec 103 (M2.1
RDY)

## Motivation

VIC Phase A shipped: text mode, multicolor text, bitmap, ECM, sprites,
collision, raster IRQ. Hardware fidelity edge cases that demos and
raster effects depend on are still open: mid-frame `$D011/$D016`
writes, exact bad-line cycle timing, sprite-sprite + sprite-data
collision lifecycle, sprite Y-expansion crunch, mid-line color writes,
raster IRQ jitter (CPU-stall-aware), `$DD00` bank visibility, chargen
banking, and the VIC badline → CPU RDY tie-in.

## Acceptance

- All 8 sprites: position (X 9-bit), expand X/Y, priority bit,
  multicolor, collision (sprite-sprite + sprite-data), enable bit.
  Pixel-accurate output to framebuffer.
- Bad lines steal cycles 0-39 of CPU access. Asserted via instrumented
  fixture.
- Mid-frame register writes to `$D011 / $D016 / $D018 / $D020 / $D021
  / $D022-$D026` produce per-line effects matching reference.
- Open-border tricks: clearing DEN ($D011 bit 4) at the right cycle
  prevents bad lines for that frame.
- Raster IRQ jitter ≤ 7 cycles (real HW); FLI/FLD demos achievable.
- Sprite Y-expansion crunch: toggling expansion mid-line produces
  HW-correct DMA stretch.
- Sprite-data collision register `$D01F` clears on read and is sticky
  between reads.
- VIC bank ($DD00 bits 0-1 inverted) selects the video matrix base
  correctly.
- Chargen ROM visibility at `$1000-$1FFF` and `$9000-$9FFF` through
  VIC.
- VIC's badline-derived RDY pin drives CPU correctly (M2.1 tie-in).

## Sub-stories

### M2.3a — Per-cycle scanline simulator
Rewrite the VIC hot path from line-at-a-time to per-cycle for cycles
0-62 (PAL) / 0-64 (NTSC). Required for cycle-correct badlines, sprite
DMA, and IRQ jitter. Keep line-at-a-time fallback under
`mode: "fast"`.

### M2.3b — Sprite DMA + crunch
Implement Y-expansion crunch logic. One synthetic test per sprite.

### M2.3c — Mid-frame register write tests
Synthetic fixtures that write `$D011/$D016` at a known cycle and
assert the framebuffer effect.

### M2.3d — Open-border tests
Clear DEN at specific cycle; assert no badline that frame.

### M2.3e — Raster IRQ jitter
Synthetic raster IRQ that measures cycle-after-IRQ jitter; assert
≤ 7 cycles.

### M2.3f — Collision register lifecycle
Synthetic test moves sprites into collisions; asserts `$D01E/$D01F`
values and read-clear behavior.

### M2.3g — Bank-switch visibility
Write `$DD00`; check video matrix base.

### M2.3h — Documentation
`docs/vic-fidelity-notes.md` lists gaps (e.g. NTSC raster-line-262
quirk, color RAM half-byte readback) and references.

## Deliverables

- EDIT `src/runtime/headless/c64/vic.ts` (per-cycle hot path,
  mid-line writes, sprite crunch)
- NEW `src/runtime/headless/c64/vic-fidelity-tests.ts`
- EDIT scheduler RDY tie-in with Spec 103
- `docs/vic-fidelity-notes.md`
- ~12 synthetic fixtures `samples/synthetic/vic/*.prg`

## Test fixtures

12 synthetic PRGs covering: badline-cycle, mid-line $D011, mid-line
$D016, open-border (top), open-border (bottom), sprite Y-crunch,
sprite-sprite collision, sprite-data collision, $DD00 bank switch,
FLD, FLI, raster IRQ jitter measurement. VICE goldens per fixture
(PNG + state hash).

## Dependencies

- Spec 098.
- Spec 103 (RDY pin).
- Spec 094 (trace channels for cycle-by-cycle VIC state).

## Risks and mitigations

- **Per-cycle rewrite is large and on the hot path**: render
  performance can drop. Mitigation: keep line-at-a-time as `mode:
  "fast"` fallback; per-cycle only in `true-drive` and
  `debug-vice-compare` modes.
- **PAL vs NTSC scanline differences**: 312 vs 262. Mitigation:
  profile-driven via Spec 100 reset profile.
- **Sprite-crunch logic obscure**: thin documentation. Mitigation:
  study VICE source plus hardware testing references; cite in
  fidelity notes.
- **Collision read-clear ambiguity**: pick VICE behavior, document.
- **Open-border timing**: 1-cycle delta determines whether trick
  works. Mitigation: fixtures assert within a 1-cycle window.
- **Memory and CPU hit**: per-cycle rewrite may drop perf 5-10x.
  Mitigation: profile, optimize inner loop, consider WASM later if
  blocking.

## Fallback paths

- Per-cycle rewrite too big for one sprint: split across this spec
  plus a follow-up; ship Y-crunch, collision, and bank switch first
  as line-at-a-time additions.
- Mid-frame write tests fail on legacy line-at-a-time: feature-flag
  the per-line-effect path; merge per-cycle later.
- Raster IRQ jitter test fails on legacy CPU: only enforce on
  microcoded mode.

## Exit criteria

- 12 fidelity fixtures green.
- Spec 097 LOAD smoke green (regression).
- Existing VIC mode tests (Sprint 73) green.
- Existing sprite tests (Sprint 74) green.

## File-touch list

- EDIT `src/runtime/headless/c64/vic.ts` (large)
- NEW `src/runtime/headless/c64/vic-fidelity-tests.ts`
- EDIT `src/runtime/headless/scheduler/cycle-wrappers.ts` (RDY tie-in)
- NEW `docs/vic-fidelity-notes.md`
- NEW `samples/synthetic/vic/*.prg`

## Out of scope

- VIC-II 8565 / 6569R5 chip-revision quirks.
- DTV-specific extensions.
- VIC-I (VIC-20).
- Sub-pixel hi-res tricks (mid-pixel color changes).
