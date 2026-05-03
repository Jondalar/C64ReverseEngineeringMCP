#!/usr/bin/env node
// Sprint 93.1 smoke — verify CIA1 keyboard typing path drives KERNAL
// scan code → $C5 → $0277 ring buffer end-to-end. Uses Maniac Mansion
// G64 only because IntegratedSession requires a disk image; nothing in
// this smoke loads from disk.

import { existsSync } from "node:fs";

const disk = process.argv[2] ?? "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) {
  console.error(`Disk not found: ${disk}`);
  process.exit(2);
}

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

const useMicrocoded = process.env.MICROCODED !== "0";
const useLockstep = process.env.LOCKSTEP !== "0";
console.log(`Mode: useMicrocodedCpu=${useMicrocoded} useCycleLockstep=${useLockstep}`);
const { sessionId, session } = startIntegratedSession({
  diskPath: disk,
  useCycleLockstep: useLockstep,
  useMicrocodedCpu: useMicrocoded,
});
session.resetCold();

console.log(`Session: ${sessionId}`);
console.log(`PC after reset: $${session.c64Cpu.pc.toString(16).toUpperCase()}`);

// Warmup until BASIC main loop reached or 8M cycles.
function step(instr) { session.runFor(instr); }
function dump(label) {
  const c5 = session.c64Bus.read(0x00c5);
  const c6 = session.c64Bus.read(0x00c6);
  const c4 = session.c64Bus.read(0x00c4);
  const buf = [0x0277,0x0278,0x0279,0x027a,0x027b].map((a)=>session.c64Bus.read(a).toString(16).padStart(2,"0")).join(" ");
  const dc00 = session.c64Bus.read(0xdc00);
  const dc01 = session.c64Bus.read(0xdc01);
  const cia1Irq = session.cia1.irqAsserted();
  const vicIrq = session.vic.irqAsserted();
  const cpuI = (session.c64Cpu.flags & 0x04) !== 0;
  const cpuIrqLine = session.c64Cpu.irqLine;
  const v314 = session.c64Bus.read(0x0314) | (session.c64Bus.read(0x0315) << 8);
  const ramAt00 = session.c64Bus.read(0x00);
  const ramAt01 = session.c64Bus.read(0x01);
  const dc0d = session.c64Bus.read(0xdc0d);
  console.log(`${label}: PC=$${session.c64Cpu.pc.toString(16).toUpperCase().padStart(4,"0")} cyc=${session.c64Cpu.cycles} I=${cpuI?1:0} irqLine=${cpuIrqLine?1:0} cia1Irq=${cia1Irq?1:0} $00/$01=${ramAt00.toString(16)}/${ramAt01.toString(16)} $0314=$${v314.toString(16).padStart(4,"0")} $DC0D=${dc0d.toString(16)} $C5=${c5.toString(16)} $C6=${c6} kbEv=${session.keyboard.pendingEventCount()}`);
}

dump("after-reset");
for (let i = 0; i < 8; i++) {
  step(150_000);
  dump(`warm[${i}]`);
}

// Real typing via typeText (press/release with gaps).
session.typeText("LIST\r", 80_000, 80_000);
console.log(`Queued LIST<RETURN> at kbCyc=${session.keyboard.currentCycle()}`);
// Run LONG enough for KERNAL+BASIC to process all 5 keys + execute.
session.runFor(2_000_000);
console.log(`After LIST: PC=$${session.c64Cpu.pc.toString(16)} cyc=${session.c64Cpu.cycles}`);

// Dump first 40 bytes of screen RAM ($0400) — see what landed.
function petsciiAscii(b) {
  if (b >= 1 && b <= 26) return String.fromCharCode(b + 64); // A-Z
  if (b >= 32 && b <= 63) return String.fromCharCode(b);
  return ".";
}
let scr = "";
for (let i = 0; i < 80; i++) scr += petsciiAscii(session.c64Bus.read(0x0400 + i));
console.log(`Screen $0400-$044F: |${scr}|`);
let scr2 = "";
for (let i = 80; i < 240; i++) scr2 += petsciiAscii(session.c64Bus.read(0x0400 + i));
console.log(`Screen $0450-$04EF: |${scr2}|`);
