#!/usr/bin/env node
// Spec 297c..g smoke — emitPixel() decoder for modes 1-7.
//
// Direct unit test of emitPixel() using hand-built display pipe state.
// Avoids fighting KERNAL IRQs that overwrite patched VIC regs/RAM
// during integration testing. Integration verification via the
// real-game corpus capture (= 296e) once 297k bridges raster_changes
// lane writes into the cycle pump.

import {
  emitPixel, computeVideoMode,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/cycle-pumped-renderer.js";
import {
  newDisplayPipeState,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/vic/display-pipe.js";
import {
  VicFramebuffer,
} from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/peripherals/vic-renderer.js";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}

console.log("smoke-vic-297cdefg-modes-1to7 (decoder unit tests)");

const fb = new VicFramebuffer(true);
function readPx(x, y) {
  const off = (y * fb.width + x) * 4;
  return [fb.pixels[off], fb.pixels[off+1], fb.pixels[off+2]];
}
function expectColor(actual, palIdx, label) {
  const [r, g, b] = fb.palette[palIdx & 0x0f];
  const ok2 = actual[0] === r && actual[1] === g && actual[2] === b;
  if (!ok2) console.log(`    ${label}: expected pal[${palIdx}]=(${r},${g},${b}) got (${actual[0]},${actual[1]},${actual[2]})`);
  return ok2;
}

// ---------------------------------------------------------------------------
// computeVideoMode
// ---------------------------------------------------------------------------
ok("computeVideoMode: D011=0 D016=0 → mode 0", computeVideoMode(0, 0) === 0);
ok("computeVideoMode: MCM only → mode 1", computeVideoMode(0, 0x10) === 1);
ok("computeVideoMode: BMM only → mode 2", computeVideoMode(0x20, 0) === 2);
ok("computeVideoMode: BMM+MCM → mode 3", computeVideoMode(0x20, 0x10) === 3);
ok("computeVideoMode: ECM only → mode 4", computeVideoMode(0x40, 0) === 4);
ok("computeVideoMode: ECM+MCM → mode 5 (illegal)", computeVideoMode(0x40, 0x10) === 5);
ok("computeVideoMode: ECM+BMM → mode 6 (illegal)", computeVideoMode(0x60, 0) === 6);
ok("computeVideoMode: ECM+BMM+MCM → mode 7 (illegal)", computeVideoMode(0x60, 0x10) === 7);

// ---------------------------------------------------------------------------
// Mode 0 (std text)
// ---------------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0x80;       // MSB set → fg pixel
  pipe.cbuf.reg = 0x0e;       // light blue
  emitPixel(fb, 100, 100, pipe, 0, 0x06, 0, 0, 0);
  ok("mode 0: bit=1 → cbuf color", expectColor(readPx(100, 100), 0x0e, "mode 0 fg"));
  pipe.gbuf.reg = 0x00;       // MSB clear → bg
  emitPixel(fb, 101, 100, pipe, 0, 0x06, 0, 0, 0);
  ok("mode 0: bit=0 → d021 bg", expectColor(readPx(101, 100), 0x06, "mode 0 bg"));
}

// ---------------------------------------------------------------------------
// Mode 1 (mc text)
// ---------------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  // hires sub-mode: cbuf bit 3 clear
  pipe.cbuf.reg = 0x07;        // mc bit 3 clear → hires
  pipe.gbuf.reg = 0x80;
  emitPixel(fb, 100, 100, pipe, 1, 0x06, 0x02, 0x05, 0);
  ok("mode 1 hires: bit=1 → cbuf low 3 bits", expectColor(readPx(100, 100), 0x07, "mc hires fg"));
  // mc sub-mode: cbuf bit 3 set, top 2 bits of gbuf select
  pipe.cbuf.reg = 0x0f;        // bit 3 set → mc; low bits = mc fg
  pipe.gbuf.reg = 0x40;        // top 2 bits = 01 → d022
  emitPixel(fb, 100, 100, pipe, 1, 0x06, 0x02, 0x05, 0);
  ok("mode 1 mc: top 2 bits=01 → d022", expectColor(readPx(100, 100), 0x02, "mc01"));
  pipe.gbuf.reg = 0x80;        // top 2 bits = 10 → d023
  emitPixel(fb, 100, 100, pipe, 1, 0x06, 0x02, 0x05, 0);
  ok("mode 1 mc: top 2 bits=10 → d023", expectColor(readPx(100, 100), 0x05, "mc10"));
  pipe.gbuf.reg = 0xc0;        // top 2 bits = 11 → cbuf low 3 bits
  pipe.cbuf.reg = 0x0a;        // bit 3 set, low 3 = 010
  emitPixel(fb, 100, 100, pipe, 1, 0x06, 0x02, 0x05, 0);
  ok("mode 1 mc: top 2 bits=11 → cbuf low 3", expectColor(readPx(100, 100), 0x02, "mc11"));
}

// ---------------------------------------------------------------------------
// Mode 2 (std bitmap)
// ---------------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.vbuf.reg = 0x1f;        // high nibble = 1 (white), low = $f (light grey)
  pipe.gbuf.reg = 0x80;
  emitPixel(fb, 100, 100, pipe, 2, 0x06, 0, 0, 0);
  ok("mode 2: bit=1 → vbuf>>4 (= 0x01 white)", expectColor(readPx(100, 100), 0x01, "bmp fg"));
  pipe.gbuf.reg = 0x00;
  emitPixel(fb, 100, 100, pipe, 2, 0x06, 0, 0, 0);
  ok("mode 2: bit=0 → vbuf low nibble (= 0x0f light grey)", expectColor(readPx(100, 100), 0x0f, "bmp bg"));
}

// ---------------------------------------------------------------------------
// Mode 3 (mc bitmap)
// ---------------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.vbuf.reg = 0x1f;        // upper=1, lower=f
  pipe.cbuf.reg = 0x07;
  pipe.gbuf.reg = 0x40;        // top 2 = 01 → vbuf upper (= 1)
  emitPixel(fb, 100, 100, pipe, 3, 0x06, 0, 0, 0);
  ok("mode 3 mc: top 2=01 → vbuf upper", expectColor(readPx(100, 100), 0x01, "mc bmp 01"));
  pipe.gbuf.reg = 0x80;        // top 2 = 10 → vbuf lower (= f)
  emitPixel(fb, 100, 100, pipe, 3, 0x06, 0, 0, 0);
  ok("mode 3 mc: top 2=10 → vbuf lower", expectColor(readPx(100, 100), 0x0f, "mc bmp 10"));
  pipe.gbuf.reg = 0xc0;        // top 2 = 11 → cbuf
  emitPixel(fb, 100, 100, pipe, 3, 0x06, 0, 0, 0);
  ok("mode 3 mc: top 2=11 → cbuf", expectColor(readPx(100, 100), 0x07, "mc bmp 11"));
  pipe.gbuf.reg = 0x00;        // top 2 = 00 → d021
  emitPixel(fb, 100, 100, pipe, 3, 0x06, 0, 0, 0);
  ok("mode 3 mc: top 2=00 → d021", expectColor(readPx(100, 100), 0x06, "mc bmp 00"));
}

// ---------------------------------------------------------------------------
// Mode 4 (ECM text)
// ---------------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  // vbuf high 2 bits select ext bg index
  pipe.vbuf.reg = 0x40;        // bits 6-7 = 01 → ext bg 1 = d022
  pipe.cbuf.reg = 0x0e;
  pipe.gbuf.reg = 0x00;        // bit=0 → ext bg
  emitPixel(fb, 100, 100, pipe, 4, 0x06, 0x02 /* red */, 0x05, 0x01);
  ok("mode 4: vbuf bit 6 set, gbuf=0 → ext bg 1 (d022 red)",
     expectColor(readPx(100, 100), 0x02, "ecm bg 1"));
  pipe.vbuf.reg = 0x80;        // bits 6-7 = 10 → ext bg 2 = d023
  emitPixel(fb, 100, 100, pipe, 4, 0x06, 0x02, 0x05 /* green */, 0x01);
  ok("mode 4: vbuf bit 7 set, gbuf=0 → ext bg 2 (d023 green)",
     expectColor(readPx(100, 100), 0x05, "ecm bg 2"));
  pipe.vbuf.reg = 0xc0;        // bits 6-7 = 11 → ext bg 3 = d024
  emitPixel(fb, 100, 100, pipe, 4, 0x06, 0x02, 0x05, 0x01 /* white */);
  ok("mode 4: vbuf bits 6-7 set, gbuf=0 → ext bg 3 (d024 white)",
     expectColor(readPx(100, 100), 0x01, "ecm bg 3"));
  pipe.gbuf.reg = 0x80;        // bit=1 → cbuf
  emitPixel(fb, 100, 100, pipe, 4, 0x06, 0x02, 0x05, 0x01);
  ok("mode 4: gbuf bit=1 → cbuf fg",
     expectColor(readPx(100, 100), 0x0e, "ecm fg"));
}

// ---------------------------------------------------------------------------
// Modes 5-7 (illegal — palette[0] black)
// ---------------------------------------------------------------------------
{
  const pipe = newDisplayPipeState();
  pipe.gbuf.reg = 0xff;
  pipe.cbuf.reg = 0x0e;
  for (const mode of [5, 6, 7]) {
    emitPixel(fb, 100, 100, pipe, mode, 0x06, 0x02, 0x05, 0x01);
    ok(`mode ${mode} (illegal): always palette[0] black`,
       expectColor(readPx(100, 100), 0x00, `mode ${mode}`));
  }
}

console.log(`\nsummary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
