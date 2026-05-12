#!/usr/bin/env node
// Sprint 96 — investigate FILE NOT FOUND. After LOAD"*",8,1 completes
// with FNF, dump drive DOS state: directory track, file table, error
// channel, head position, last GCR-buffer access.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

// Track drive PC visits + head moves during LOAD attempt.
const pcHist = new Map();
const headMoves = [];
let lastTrack = -1;
let lastSeen1c00 = 0;

// Patch drive bus to count track-buffer reads.
let trackBufReads = 0;
let trackBufWrites = 0;
const origRead = session.drive.bus.read.bind(session.drive.bus);
session.drive.bus.read = (a) => {
  // VIA2 PB ($1C00) reads = head/motor control. VIA2 PA ($1C01) = GCR data byte.
  if ((a & 0xfff0) === 0x1c00) trackBufReads++;
  return origRead(a);
};
const origWrite = session.drive.bus.write.bind(session.drive.bus);
session.drive.bus.write = (a, v) => {
  if ((a & 0xfff0) === 0x1c00) trackBufWrites++;
  return origWrite(a, v);
};

const headPos = session.headPosition;
function snapshotHead() {
  try {
    return { halftrack: headPos.getHalftrack?.() ?? -1 };
  } catch { return { halftrack: -1 }; }
}

// Step until KERNAL prints FNF (or budget).
const W = (n) => "$" + (n & 0xff).toString(16).padStart(2, "0");
const W4 = (n) => "$" + (n & 0xffff).toString(16).padStart(4, "0");
for (let i = 0; i < 8_000_000; i++) {
  session.runFor(1);
  const dpc = session.drive.cpu.pc;
  pcHist.set(dpc & 0xff00, (pcHist.get(dpc & 0xff00) ?? 0) + 1);
  const head = snapshotHead();
  if (head.halftrack !== lastTrack) {
    headMoves.push({ c64Cyc: session.c64Cpu.cycles, halftrack: head.halftrack });
    lastTrack = head.halftrack;
  }
}

const ram = session.drive.bus.ram;
console.log(`=== Sprint 96 FILE NOT FOUND probe ===`);
console.log(`final c64PC=${W4(session.c64Cpu.pc)} drvPC=${W4(session.drive.cpu.pc)}`);
console.log(`drive RAM:`);
console.log(`  $77=${W(ram[0x77])} (LISTEN cmd)  $79=${W(ram[0x79])} (listener active)`);
console.log(`  $85=${W(ram[0x85])} (last byte)  $98=${W(ram[0x98])} (bit count)`);
// Drive DOS error code at $1C..$26 area; filename buffer at $0200+.
console.log(`  buffer scan ($0200..$0700, 32-byte rows, ASCII-printable):`);
for (let base = 0x0200; base < 0x0700; base += 32) {
  let line = "";
  let any = false;
  for (let i = 0; i < 32; i++) {
    const c = ram[base + i];
    if (c >= 0x21 && c < 0x7e) { line += String.fromCharCode(c); any = true; }
    else if (c === 0) line += ".";
    else { line += "?"; if (c !== 0xa0 && c !== 0x20) any = true; }
  }
  if (any) console.log(`    $${base.toString(16)}: ${line}`);
}
// Job queue at $0000..$0005 (jobs for tracks 1..5? actually $00..$05 for buffers 0..5).
console.log(`  job queue $00..$05: ${[...ram.slice(0x00, 0x06)].map(W).join(" ")}`);
console.log(`  header table $06..$0F: ${[...ram.slice(0x06, 0x10)].map(W).join(" ")}`);
console.log(`\nVIA2 ($1C00) traffic: reads=${trackBufReads} writes=${trackBufWrites}`);
console.log(`Head moves observed: ${headMoves.length}`);
for (const h of headMoves.slice(0, 30)) {
  console.log(`  c64Cyc=${h.c64Cyc} halftrack=${h.halftrack}`);
}

// Top drive PC pages.
const topPages = [...pcHist.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10);
console.log(`\nTop drive PC pages:`);
for (const [page, count] of topPages) {
  console.log(`  ${W4(page)}: ${count}`);
}
