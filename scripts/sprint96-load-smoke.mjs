#!/usr/bin/env node
import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);
const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({ diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true });
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);
session.runFor(40_000_000);
const ram = session.c64Bus.ram;
const W = (n) => "$"+(n & 0xff).toString(16).padStart(2,"0");
const screenBase = 0x0400;
for (let row = 0; row < 16; row++) {
  let line = "";
  for (let col = 0; col < 40; col++) {
    const c = ram[screenBase + row*40 + col];
    line += (c >= 0x20 && c < 0x60) ? String.fromCharCode(c).toUpperCase()
      : (c >= 0x01 && c < 0x1b) ? String.fromCharCode(0x40 + c) : ".";
  }
  console.log(`r${row.toString().padStart(2,"0")}: ${line}`);
}
console.log(`\ndrvPC=$${session.drive.cpu.pc.toString(16)} drvA=$${session.drive.cpu.a.toString(16)} c64PC=$${session.c64Cpu.pc.toString(16)}`);
console.log(`drive RAM $77=${W(session.drive.bus.ram[0x77])} $79=${W(session.drive.bus.ram[0x79])} $85=${W(session.drive.bus.ram[0x85])}`);
