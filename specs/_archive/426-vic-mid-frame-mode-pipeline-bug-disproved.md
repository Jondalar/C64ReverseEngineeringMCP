# Spec 426 — VIC mid-frame mode-change pipeline bug

**Status:** OPEN 2026-05-12
**Branch:** `vic_bugs`
**Depends on:** 425 (CLK_INC contract — green)
**Doctrine:** 1:1 VICE port. Mid-frame raster-split mode changes
must produce identical pixel output to VICE x64sc.

## Symptom

**Impossible Mission II (Epyx 1988) title screen renders as striped
junk** instead of the multicolor bitmap shown by VICE x64sc.

Reference (correct, VICE):
- 1988 IMPOSSIBLE MISSION II logo + reactor artwork
- Light blue background + grey bitmap details
- Smooth bitmap area below 1-2 char rows of title text

Our headless / V3 UI output:
- Top row = grey/white text-mode chargen pattern
- Bitmap area = horizontal stripes (~10 pixel high greys), uniform
  pattern, no actual bitmap detail

Both Scramble Infinity (Krill loader) and Polar Bear render
correctly through their own mode transitions. IM2 fails uniquely
because its raster-split between **mode 3 (MCM bitmap)** and
**mode 5 (illegal — ECM+MCM, no BMM)** happens per scanline, and
mid-frame mode changes are not pixel-clean in our port.

## Evidence

- CPU is alive: PC progresses through IM2 code ($1xxx range,
  occasionally $b266). Not in a JAM.
- VIC programmed correctly for steady state:
  - bank = 3 ($C000 — verified from CIA2 PA=$04)
  - D018 = $08 → screen at $C000, bitmap at $E000
  - vbank_phi2 / vaddr_mask = $C000 / $FFFF (Spec 309 fix)
  - Matrix fetch confirmed: vbuf populated with `FF FF FF...`
- RAM contents:
  - `ram[$E000..]` = `ff ff ea e5 e6 e6 e6 e6 7f 7f aa 55 ...`
    (real bitmap data, not zeros)
  - `ram[$C000..]` = uniform `FF FF FF...` at title; varied later
  - color RAM at $D800 offset 0..15 = `00 00 00...`, offset 40+ =
    `FF FF FF...` (consistent with palette init in cells 0..39
    pending)
- VIC inspector snapshot in UI: **mode oscillates between 3 and 5**
  across raster lines. End-of-frame samples land in mode-5
  (ECM=1, BMM=0, MCM=1 = illegal mode → black-only output).
- Framebuffer dump: **only 2 distinct colors present** ($0 black +
  $F white) across all 162240 bytes. Multicolor bitmap mode 3
  with vbuf=$FF cbuf=$0F should emit 4 colors per pair, not 2.

## Hypothesis

1. **D011/D016 mid-frame writes (raster split) land 1+ cycles off**
   from VICE timing. IM2's title-bar→bitmap transition writes
   $D011 to flip BMM bit at a specific raster cycle. Our literal
   port's `reg11_delay` pipeline or `vmode11_pipe` sampling may
   apply the change at the wrong pixel.
2. Spec 425 fixed CLK_INC + BA-stall placement so vicii_cycle runs
   at every CPU clock. This should have been the gating piece. It
   is not sufficient → the bug is **inside vicii-draw-cycle.ts**
   or **vicii-cycle.ts** mode-change handling, not the surrounding
   scheduler.
3. Candidate mechanisms (require investigation):
   - `vmode11_pipe |= ... rising edge` (draw-cycle.c:246) vs
     `&= ... falling edge` (draw-cycle.c:254) — the two-stage
     update interpolates between OLD and NEW values across pixels
     0..7. If the register write happens during a CYCLE BOUNDARY
     vs MID-CYCLE, our port may misread.
   - `reg11_delay = vicii.regs[0x11]` at vicii-cycle.ts line 473.
     This is captured AFTER the mid-cycle write in our path,
     because we no longer pump VIC from session — every CPU clock
     calls `vicii_cycle()` from `tick()`, which runs AT the end of
     the clock increment. The CPU's mid-cycle reg write should
     land BEFORE the next vicii_cycle, not before the current one.
   - `vmode16_pipe2` 1-cycle pipeline of vmode16_pipe. The bug may
     be a missing reg-change kludge in `draw-cycle.c:160-186`
     "some kludge magic to fix $d023 glitch at MCM=0 -> 1 during
     MC and non-MC chars" — TS port copies the code byte-for-byte
     but may rely on different cycle ordering.

## Reproduction

```bash
node scripts/debug-im2-boot.mjs
# inspect /tmp/im2-t060s.png (= 60s post-RUN)
# expected: blue IM2 title bitmap
# actual: striped junk
```

Live in browser:
```
samples/impossible_mission_ii[epyx_1987](!).g64
mount drive 8, LOAD"*",8,1 + RUN
```

## What is known clean

- CPU pipeline ✓ (smoke:cpu-fidelity 31/31)
- CIA timers ✓ (smoke:cia-fidelity 22/22)
- IEC + drive ✓ (motm canary, Krill loader)
- MM s1 character select ✓
- Scramble Infinity in-game ✓ (minor top stripe artifact,
  separate raster-split timing tweak)
- Polar Bear title + F7-into-instructions ✓ (mode 1 MCM text)
- Spec 309 banking fix ($3FFF→$FFFF vaddr_mask) ✓
- Spec 425 CLK_INC contract ✓

## Out of scope

- IM2 game-state / fastloader stall (PC oscillates init range for
  >360s without progression; may share root cause or may be
  independent IEC/timer/IRQ bug — investigated separately).
- VIC raster-cache layer (=`vicii-raster-cache.ts`, not in literal
  port path).
- VicIIVice (= legacy renderer, not active default).

## Acceptance

- IM2 title screen renders matching VICE x64sc reference within
  visual tolerance (= identical mode raster split pixels).
- Framebuffer ≥ 4 distinct color values across visible bitmap area
  (= proves MCM 4-pair palette is being honored).
- No regression: smoke gates + MM s1 + Scramble + Polar Bear.

## Next step

Audit `vicii-draw-cycle.ts` mode-pipe section against VICE
`viciisc/vicii-draw-cycle.c:227-295` (draw_graphics8) line by
line, focusing on:
- `reg11_delay` capture timing
- `vmode11_pipe` rising/falling edge handling
- `vmode16_pipe`/`vmode16_pipe2` 1-cycle delay
- `gbuf_mc_flop` reset condition (= line 312-315)

If 1:1 line match: investigate IF `vicii_cycle()` is being called
at the exact same clock offset as VICE's CLK_INC.
