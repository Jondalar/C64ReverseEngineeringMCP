#!/usr/bin/env node
import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);
const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({ diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true });
session.resetCold();
session.runFor(800_000);
const fname = process.env.LOAD_NAME ?? "*";
const runAfter = process.env.RUN_AFTER ?? "";  // e.g. "SYS 679"
const cmd = `LOAD"${fname}",8,1\r`;
console.log(`Typing: ${cmd.replace("\r","<RET>")}`);
session.typeText(cmd, 80_000, 80_000);
const budget = parseInt(process.env.RUN_BUDGET ?? "10000000", 10);
// First wait for LOAD to complete (give boot file time).
session.runFor(Math.min(budget, 8_000_000));
if (runAfter) {
  console.log(`Then typing: ${runAfter}<RET>`);
  session.typeText(runAfter + "\r", 80_000, 80_000);
  // Run remainder of budget after typing.
  const remaining = budget - 8_000_000 - 160_000;
  if (remaining > 0) session.runFor(remaining);
}
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
console.log(`\nC64 RAM $02A7..$02D7 (boot load target):`);
let h="", a="";
for (let i = 0; i < 48; i++) { const c = ram[0x02A7+i]; h+=c.toString(16).padStart(2,"0")+" "; a+=(c>=0x20&&c<0x7e)?String.fromCharCode(c):"."; }
console.log(`  ${h}`);
console.log(`load addr $C3/$C4 = $${ram[0xc4].toString(16).padStart(2,"0")}${ram[0xc3].toString(16).padStart(2,"0")}`);
console.log(`status $90 = ${W(ram[0x90])}`);
console.log(`\nMM target $0400..$042F:`);
let h2="";
for (let i = 0; i < 48; i++) h2 += ram[0x0400+i].toString(16).padStart(2,"0")+" ";
console.log(`  ${h2}`);
console.log(`MM target $0800..$081F:`);
let h3="";
for (let i = 0; i < 32; i++) h3 += ram[0x0800+i].toString(16).padStart(2,"0")+" ";
console.log(`  ${h3}`);
const screenStr = Array.from({length:1000},(_,i)=>{const c=ram[0x0400+i];return (c>=0x20&&c<0x60)?String.fromCharCode(c).toUpperCase():(c>=0x01&&c<0x1b)?String.fromCharCode(0x40+c):".";}).join("");
console.log(`\n[summary] READY: ${(screenStr.match(/READY\./g)??[]).length}  FNF: ${screenStr.includes("FILE NOT FOUND")}  DNP: ${screenStr.includes("DEVICE NOT PRESENT")}  LOAD ERR: ${screenStr.includes("LOAD ERROR")||screenStr.includes("LOAD  ERROR")}  ?: ${screenStr.includes("?")}`);
