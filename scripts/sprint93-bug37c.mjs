#!/usr/bin/env node
// Bug 37 — trace what happens AFTER CHRIN consumes a char from buffer.
// Single-step from "L typed" forward, log all PC transitions outside
// the well-known KERNAL CHRIN polling loop ($E5CD-$E69D / $E632 area).

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
console.log(`Warm. PC=$${session.c64Cpu.pc.toString(16)}`);

session.keyboard.queueKeyEvent("L", 0, 5_000_000);
console.log(`L queued`);

const RD = (a) => session.c64Bus.read(a);
const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");

// Phase 1: run until $C6 == 1 (buffer just filled).
let i = 0;
while (i < 5_000_000) {
  session.runFor(1);
  i++;
  if (RD(0x00c6) > 0) break;
}
console.log(`After ${i} steps: $C6=${RD(0x00c6)} buf0=$${RD(0x0277).toString(16)} PC=${W(session.c64Cpu.pc)} cyc=${session.c64Cpu.cycles}`);

// Phase 2: run another 100 instructions step-by-step, log every PC.
const inputLoopRange = (pc) => pc >= 0xe5cd && pc <= 0xe6d0;
const trace = [];
for (let k = 0; k < 200; k++) {
  const pc = session.c64Cpu.pc;
  trace.push({ k, pc, c6: RD(0x00c6), buf0: RD(0x0277), c5: RD(0x00c5), d3: RD(0x00d3), d6: RD(0x00d6), d0: RD(0x00d0), a: session.c64Cpu.a, x: session.c64Cpu.x, y: session.c64Cpu.y });
  session.runFor(1);
}
console.log(`\nFirst 30 PCs after $C6=1:`);
for (const r of trace.slice(0, 30)) console.log(`  k=${r.k} PC=${W(r.pc)} A=${r.a.toString(16).padStart(2,"0")} $C5=${r.c5.toString(16)} $C6=${r.c6} $D3=${r.d3} $D6=${r.d6} $D0=${r.d0.toString(16)} buf0=${r.buf0.toString(16)}`);

console.log(`\nNon-CHRIN-loop PCs in 200 steps (PC < $E5CD or > $E6D0):`);
for (const r of trace) {
  if (!inputLoopRange(r.pc)) console.log(`  k=${r.k} PC=${W(r.pc)} $C6=${r.c6} buf0=${r.buf0.toString(16)} $D3=${r.d3} $D6=${r.d6}`);
}

// Phase 3: run further, dump screen RAM @ $0400 + cursor.
session.runFor(500_000);
console.log(`\nAfter +500k cyc: PC=${W(session.c64Cpu.pc)} $C6=${RD(0x00c6)} $D3(col)=${RD(0x00d3)} $D6(row)=${RD(0x00d6)}`);
const cursorAddr = 0x0400 + RD(0x00d6) * 40 + RD(0x00d3);
console.log(`Cursor at ${W(cursorAddr)}: $${RD(cursorAddr).toString(16)} (next 16: ${[...Array(16).keys()].map(i => RD(cursorAddr+i).toString(16).padStart(2,"0")).join(" ")})`);
const r24 = [...Array(40).keys()].map(i => {
  const b = RD(0x0400 + 24 * 40 + i);
  if (b >= 1 && b <= 26) return String.fromCharCode(b + 64);
  if (b === 32) return " ";
  if (b === 0) return "@";
  return ".";
}).join("");
console.log(`Row 24: |${r24}|`);
const r23 = [...Array(40).keys()].map(i => {
  const b = RD(0x0400 + 23 * 40 + i);
  if (b >= 1 && b <= 26) return String.fromCharCode(b + 64);
  if (b === 32) return " ";
  if (b === 0) return "@";
  return ".";
}).join("");
console.log(`Row 23: |${r23}|`);
