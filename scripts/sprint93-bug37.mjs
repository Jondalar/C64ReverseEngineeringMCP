#!/usr/bin/env node
// Bug 37 — find why SCNKEY detects $CB but never copies to $C5/$0277.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { console.error(`Disk not found`); process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

const { session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
});
session.resetCold();

// Warm to BASIC ready.
session.runFor(800_000);
console.log(`Warm done. PC=$${session.c64Cpu.pc.toString(16)}`);

const RD = (a) => session.c64Bus.read(a);
function dumpKbState(label) {
  const cb = RD(0x00cb), c5 = RD(0x00c5), c6 = RD(0x00c6);
  const cc = RD(0x00cc), d0 = RD(0x00d0), d4 = RD(0x00d4);
  const c4 = RD(0x00c4);
  const sz = RD(0x0289);
  const repEnable = RD(0x028a);
  const repCnt = RD(0x028b);
  const repDel = RD(0x028c);
  const buf0 = RD(0x0277), buf1 = RD(0x0278);
  const dc01 = RD(0xdc01);
  const v028f = RD(0x028f) | (RD(0x0290) << 8);
  const v028d = RD(0x028d);
  console.log(`${label}: $C4=${c4.toString(16)} $C5=${c5.toString(16)} $C6=${c6} $CB=${cb.toString(16)} $028C=${repDel} $028D=${v028d.toString(16)} $028F=${v028f.toString(16).padStart(4,"0")} buf0=${buf0.toString(16)} $DC01=${dc01.toString(16)}`);
}

dumpKbState("ready");

// Hold L for 5M cyc.
session.keyboard.queueKeyEvent("L", 0, 5_000_000);
console.log(`Held L for 5M cyc at kbCyc=${session.keyboard.currentCycle()}`);
for (let i = 0; i < 20; i++) {
  session.runFor(50_000);
  dumpKbState(`hold[${i}]`);
}
