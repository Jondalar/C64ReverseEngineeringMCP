#!/usr/bin/env node
// Bug 37 — single-step around $EB30 to capture X register at CPX #$FF.

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

// Step instruction-at-a-time. When PC enters $EAE0-$EB47 SCNKEY decode,
// log every step. Look specifically at $EAE4 (TAX after PETSCII lookup)
// and $EB30 (CPX #$FF).
const trace = [];
let logging = false;
let logCount = 0;
const MAX_LOG = 200;
for (let i = 0; i < 5_000_000 && logCount < MAX_LOG; i++) {
  session.runFor(1);
  const pc = session.c64Cpu.pc;
  if (pc >= 0xeae0 && pc <= 0xeb47) {
    if (!logging) { logging = true; trace.push(`-- enter SCNKEY decode at i=${i} --`); }
    trace.push(`  PC=$${pc.toString(16)} A=${session.c64Cpu.a.toString(16)} X=${session.c64Cpu.x.toString(16)} Y=${session.c64Cpu.y.toString(16)} F5=${session.c64Bus.read(0xf5).toString(16)} F6=${session.c64Bus.read(0xf6).toString(16)} CB=${session.c64Bus.read(0xcb).toString(16)} C5=${session.c64Bus.read(0xc5).toString(16)} C6=${session.c64Bus.read(0xc6)}`);
    logCount++;
  } else if (logging) {
    trace.push(`-- exit decode (PC=$${pc.toString(16)}) --`);
    logging = false;
  }
}
for (const line of trace) console.log(line);
console.log(`Final $C5=${session.c64Bus.read(0xc5).toString(16)} $C6=${session.c64Bus.read(0xc6)} $0277=${session.c64Bus.read(0x0277).toString(16)}`);
