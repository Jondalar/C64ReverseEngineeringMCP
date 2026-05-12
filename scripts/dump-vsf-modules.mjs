#!/usr/bin/env node
// Walk VICE VSF modules, list each, then dump VIC-II regs[0x40].
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples/motm_menu_vice.vsf";
const buf = readFileSync(path);
console.log(`file size: ${buf.length}`);

// Direct scan: find each known module name as ASCII at NUL-aligned
// 16-byte offset. Print module data start + key fields. For VIC-II,
// extract regs[$D000-$D03F] and IRQ-related state.
const findModule = (name) => {
  for (let i = 0x3a; i + 16 <= buf.length; i++) {
    let m = true;
    for (let k = 0; k < name.length; k++) {
      if (buf[i + k] !== name.charCodeAt(k)) { m = false; break; }
    }
    if (m && buf[i + name.length] === 0) return i;
  }
  return -1;
};

const dumpModule = (name) => {
  const off = findModule(name);
  if (off < 0) { console.log(`module "${name}" not found`); return; }
  const dataStart = off + 22;
  // Size is at off+18 (LE u32), but field may include header (= module size)
  const size = buf.readUInt32LE(off + 18);
  const major = buf[off + 16];
  const minor = buf[off + 17];
  console.log(`@0x${off.toString(16).padStart(6, "0")}  module="${name}" v${major}.${minor}  size=${size}  data@0x${dataStart.toString(16)}`);
  return { off, dataStart, size, major, minor };
};

dumpModule("MAINCPU");
dumpModule("C64MEM");
dumpModule("CIA1");
dumpModule("CIA2");
dumpModule("SID");
const vic = dumpModule("VIC-II");
const cia2 = dumpModule("CIA2");
let p = 0x10000000; // unused after refactor

const readZ = (off, len) => {
  let s = "";
  for (let i = 0; i < len; i++) {
    const b = buf[off + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
};

while (p + 22 <= buf.length) {
  const name = readZ(p, 16);
  const major = buf[p + 16];
  const minor = buf[p + 17];
  const size = buf.readUInt32LE(p + 18);
  console.log(`@0x${p.toString(16).padStart(6, "0")}  module="${name.padEnd(12)}" v${major}.${minor}  size=${size}`);
  if (name === "VIC-II" || name === "VIC-IISC") {
    const dataStart = p + 22;
    console.log(`\n  --- VIC-II module bytes ---`);
    // model byte
    console.log(`  model = $${buf[dataStart].toString(16)}`);
    // regs[0x40] at dataStart+1
    console.log(`  regs[$D000-$D03F]:`);
    for (let row = 0; row < 4; row++) {
      const line = [];
      for (let col = 0; col < 16; col++) {
        const v = buf[dataStart + 1 + row * 16 + col];
        line.push(v.toString(16).padStart(2, "0"));
      }
      console.log(`    +${(row*16).toString(16).padStart(2,"0")}: ${line.join(" ")}`);
    }
    // raster_cycle / raster_line / IRQ
    const rcOff = dataStart + 1 + 0x40;
    console.log(`  raster_cycle = ${buf.readUInt32LE(rcOff)}`);
    console.log(`  cycle_flags  = $${buf.readUInt32LE(rcOff+4).toString(16)}`);
    console.log(`  raster_line  = ${buf.readUInt32LE(rcOff+8)}`);
    console.log(`  start_of_frame = ${buf[rcOff+12]}`);
    console.log(`  irq_status   = $${buf[rcOff+13].toString(16)}`);
    console.log(`  raster_irq_line = ${buf.readUInt32LE(rcOff+14)}`);
    console.log(`  raster_irq_triggered = ${buf[rcOff+18]}`);
  }
  if (name === "C64MEM") {
    const dataStart = p + 22;
    console.log(`  pport.data = $${buf[dataStart].toString(16)}  pport.dir = $${buf[dataStart+1].toString(16)}`);
    console.log(`  EXROM = ${buf[dataStart+2]} GAME = ${buf[dataStart+3]}`);
    // RAM at dataStart+4. Read screen pointer area for diagnostic.
    const ramOff = dataStart + 4;
    // Look at $0314/$0315 (IRQ vector LO/HI)
    const irqVecLo = buf[ramOff + 0x0314];
    const irqVecHi = buf[ramOff + 0x0315];
    console.log(`  IRQ vector @ $0314/15 = $${(irqVecHi*256+irqVecLo).toString(16).padStart(4,"0")}`);
    // Sample first row of screen RAM at $0400 (after CIA2 bank-select considered).
  }
  if (name === "CIA2") {
    const dataStart = p + 22;
    // CIA2 PA = bank select bits 0-1 (inverted)
    console.log(`  CIA2 first 16 bytes:`);
    const line = [];
    for (let i = 0; i < 16; i++) line.push(buf[dataStart+i].toString(16).padStart(2,"0"));
    console.log(`    ${line.join(" ")}`);
  }
  p += 22 + size;
}
