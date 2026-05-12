#!/usr/bin/env node
// Sprint 96 — find where headless CPU loops during LOAD"*",8,1 timeout.
// Build a histogram of C64 PCs sampled during the bit-bang phase.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);
session.runFor(2_500_000); // get past typing into ATN/LISTEN

const RD = (a) => session.c64Bus.read(a);
const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");

// Now sample PC every instruction for 500k instructions (covers byte
// transfer + timeout). Build histogram and find longest stretches per PC.
const histPc = new Map();
const histDrvPc = new Map();
const N = 1_000_000;
let lastPc = -1;
let stickyStart = -1;
const stickyEvents = [];
for (let i = 0; i < N; i++) {
  session.runFor(1);
  const pc = session.c64Cpu.pc;
  histPc.set(pc, (histPc.get(pc) ?? 0) + 1);
  const dpc = session.drive.cpu.pc;
  histDrvPc.set(dpc, (histDrvPc.get(dpc) ?? 0) + 1);
  if (pc === lastPc) {
    if (stickyStart < 0) stickyStart = i;
  } else {
    if (stickyStart >= 0 && (i - stickyStart) > 5000) {
      stickyEvents.push({ pc: lastPc, from: stickyStart, len: i - stickyStart });
    }
    stickyStart = -1;
  }
  lastPc = pc;
  // Bail if "?" appears at row 9 col 0 = $0400 + 360 = $0568 — wait
  // KERNAL prints to current cursor row. "?DEVICE NOT PRESENT" goes to
  // wherever the cursor currently is, after the LOAD command echo. Just
  // rely on PC histogram instead.
}
console.log(`Sampled ${N} instructions. Final PC=${W(session.c64Cpu.pc)} cyc=${session.c64Cpu.cycles}`);

console.log(`\nTop 15 C64 PCs by instruction count:`);
const sortedPc = [...histPc.entries()].sort((a, b) => b[1] - a[1]);
for (const [pc, cnt] of sortedPc.slice(0, 15)) console.log(`  ${W(pc)}: ${cnt}`);

console.log(`\nTop 10 drive PCs:`);
const sortedDPc = [...histDrvPc.entries()].sort((a, b) => b[1] - a[1]);
for (const [pc, cnt] of sortedDPc.slice(0, 10)) console.log(`  ${W(pc)}: ${cnt}`);

console.log(`\nStuck-PC events (same PC > 5000 cycles):`);
for (const ev of stickyEvents.slice(-10)) console.log(`  PC=${W(ev.pc)} from=${ev.from} for ${ev.len} cycles`);

console.log(`\nFinal screen rows 5-12:`);
const dec = (b) => {
  if (b === 0) return "@";
  if (b >= 1 && b <= 26) return String.fromCharCode(b + 64);
  if (b === 32) return " ";
  if (b === 0xa0) return "#";
  if (b >= 0x30 && b <= 0x3f) return String.fromCharCode(b);
  return ".";
};
for (let r = 5; r < 13; r++) {
  let s = "";
  for (let c = 0; c < 40; c++) s += dec(RD(0x0400 + r*40 + c));
  console.log(`R${r}: |${s}|`);
}
