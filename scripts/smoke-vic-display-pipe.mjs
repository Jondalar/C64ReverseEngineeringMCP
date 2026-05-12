#!/usr/bin/env node
// Spec 296a-3 smoke — display pipe state shape + transfer rules.

import {
  newDisplayPipeState, resetDisplayPipe,
  latchPipeRegs, advancePipeStages, samplePipe0, shiftGbufOnePixel,
  sampleVmode11, sampleVmode16, holdVmode16Pipe2,
} from "../dist/runtime/headless/vic/display-pipe.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-display-pipe — Spec 296a-3");

// 1. Initial state all zero
{
  const s = newDisplayPipeState();
  ok("init: all zero", s.gbuf.pipe0===0 && s.gbuf.pipe1===0 && s.gbuf.reg===0 &&
                       s.vbuf.pipe0===0 && s.cbuf.pipe0===0 &&
                       s.xscroll_pipe===0 && s.vmode11_pipe===0);
  ok("init: gbuf_mc_flop = 1 (set by reset semantics)", s.gbuf_mc_flop === 1);
}

// 2. samplePipe0 visible+!vborder writes pipe0 + xscroll
{
  const s = newDisplayPipeState();
  samplePipe0(s, true, false, 0x05, 0xa5, 0x42, 0x07);
  ok("visible: gbuf.pipe0 = newGbuf", s.gbuf.pipe0 === 0xa5);
  ok("visible: xscroll_pipe = d016 & 7", s.xscroll_pipe === 5);
  ok("visible: vbuf.pipe0 = newVbuf", s.vbuf.pipe0 === 0x42);
  ok("visible: cbuf.pipe0 = newCbuf & 0xf", s.cbuf.pipe0 === 0x07);
}

// 3. samplePipe0 NOT visible → gbuf.pipe0 = 0, xscroll unchanged
{
  const s = newDisplayPipeState();
  samplePipe0(s, true, false, 0x05, 0xa5, null, null);
  samplePipe0(s, false, false, 0x07, 0xff, null, null);
  ok("not visible: gbuf.pipe0 = 0", s.gbuf.pipe0 === 0);
  ok("not visible: xscroll_pipe holds previous", s.xscroll_pipe === 5);
}

// 4. advancePipeStages: pipe0 → pipe1
{
  const s = newDisplayPipeState();
  s.gbuf.pipe0 = 0x11; s.vbuf.pipe0 = 0x22; s.cbuf.pipe0 = 0x03;
  advancePipeStages(s);
  ok("advance: pipe1 picks up pipe0", s.gbuf.pipe1===0x11 && s.vbuf.pipe1===0x22 && s.cbuf.pipe1===0x03);
}

// 5. latchPipeRegs: pipe1 → reg + reset mc_flop
{
  const s = newDisplayPipeState();
  s.gbuf.pipe1 = 0xab; s.vbuf.pipe1 = 0xcd; s.cbuf.pipe1 = 0x05;
  s.gbuf_mc_flop = 0;
  latchPipeRegs(s);
  ok("latch: reg picks up pipe1", s.gbuf.reg===0xab && s.vbuf.reg===0xcd && s.cbuf.reg===0x05);
  ok("latch: mc_flop reset to 1", s.gbuf_mc_flop === 1);
}

// 6. shiftGbufOnePixel: gbuf.reg <<= 1 + toggle mc_flop
{
  const s = newDisplayPipeState();
  s.gbuf.reg = 0x81; s.gbuf_mc_flop = 1;
  shiftGbufOnePixel(s);
  ok("shift: gbuf.reg <<= 1 (& 0xff)", s.gbuf.reg === 0x02);
  ok("shift: mc_flop toggles", s.gbuf_mc_flop === 0);
  shiftGbufOnePixel(s);
  ok("shift: mc_flop toggles back", s.gbuf_mc_flop === 1);
}

// 7. vmode samplers
{
  const s = newDisplayPipeState();
  sampleVmode16(s, 0xff);
  ok("vmode16: keeps only bit 4", s.vmode16_pipe === 0x10);
  holdVmode16Pipe2(s);
  ok("vmode16_pipe2 = vmode16_pipe", s.vmode16_pipe2 === 0x10);
  sampleVmode11(s, 0xff);
  ok("vmode11: keeps only bits 6-5", s.vmode11_pipe === 0x60);
}

// 8. Reset clears all
{
  const s = newDisplayPipeState();
  s.gbuf.reg = 0xff; s.vmode11_pipe = 0x60; s.xscroll_pipe = 7;
  resetDisplayPipe(s);
  ok("reset: all zero except mc_flop", s.gbuf.reg===0 && s.vmode11_pipe===0 && s.xscroll_pipe===0);
  ok("reset: mc_flop back to 1", s.gbuf_mc_flop === 1);
}

// 9. Full draw_graphics8 inner loop simulation:
//   pre: pipe0 = new fetch from cycle N. pipe1 = fetch from cycle N-1.
//   reg = fetch from cycle N-2 (latched at xscroll_pipe of cycle N-1).
//   loop emits 8 pixels using reg.
{
  const s = newDisplayPipeState();
  // Setup cycle N
  samplePipe0(s, true, false, 3, 0x55, 0xaa, 0x05);
  // Cycle prev had also sampled
  s.gbuf.pipe1 = 0xf0; s.vbuf.pipe1 = 0xbb; s.cbuf.pipe1 = 0x07;
  // Cycle N-2 reg currently in use
  s.gbuf.reg = 0x18; s.vbuf.reg = 0x42; s.cbuf.reg = 0x09;
  s.xscroll_pipe = 3;
  // Inner loop for 8 pixels
  for (let i = 0; i < 8; i++) {
    if (i === s.xscroll_pipe) latchPipeRegs(s);
    if (i === 4) sampleVmode16(s, 0x10);
    if (i === 7) holdVmode16Pipe2(s);
    shiftGbufOnePixel(s);
  }
  // After loop reg should reflect what was pipe1 at start (= 0xf0 fully shifted = 0)
  ok("after 8 shifts: gbuf.reg = 0", s.gbuf.reg === 0);
  // mc_flop trace: start 1; latch at i=3 resets to 1; 5 more shifts (i=3..7)
  // toggle 5 times → 1→0→1→0→1→0. End = 0.
  ok("after loop: mc_flop = 0 (latch at i=3 reset + 5 shifts)", s.gbuf_mc_flop === 0);
  // vbuf/cbuf reg latched from pipe1
  ok("vbuf.reg latched at xscroll", s.vbuf.reg === 0xbb);
  ok("cbuf.reg latched at xscroll", s.cbuf.reg === 0x07);
  ok("vmode16_pipe2 holds vmode16_pipe at pixel 7", s.vmode16_pipe2 === 0x10);
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
