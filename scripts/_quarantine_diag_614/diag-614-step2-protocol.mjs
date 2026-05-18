#!/usr/bin/env node
// Step-debug round 2: dump c64 KERNAL bytes $ED40-$EE10 + drive ROM
// $E990-$EA30 + step both sides 200 c64 instr and look for first
// state change (drive writing $1800, or $DD00 changing).

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 8 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const bus = session.c64Bus;
const iec = session.iecBus;
const vice = session.kernel.drive1541;
const drv = vice.unit;
const cpud = drv.cpud;
const via1 = drv.via1d1541;

function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }
function r8(a) { return bus.read(a & 0xffff) & 0xff; }
function drvR(addr) {
  const fn = cpud?.read_func_ptr?.[(addr >> 8) & 0xff];
  return fn ? fn(drv, addr) & 0xff : -1;
}

console.log("=== C64 KERNAL bytes $ED40-$EE10 ===");
for (let a = 0xed40; a <= 0xee10; a += 16) {
  let line = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16 && a + i <= 0xee10; i++) line += hex(r8(a + i)) + " ";
  console.log(line);
}
console.log("\n=== Drive ROM $E9C0-$EA30 ===");
for (let a = 0xe9c0; a <= 0xea30; a += 16) {
  let line = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16 && a + i <= 0xea30; i++) line += hex(drvR(a + i)) + " ";
  console.log(line);
}

console.log("\n=== Step 200 c64 instr, log state changes ===");
let lastDd00 = r8(0xdd00);
let lastDrvPb = via1.via[0] & 0xff;
let lastDrvPort = iec.core.drv_port & 0xff;
let lastDrvData8 = iec.core.drv_data[8] & 0xff;
let lastC64Pc = session.c64Cpu.pc;
let lastDrvPc = drv.cpu.cpu_regs.pc;
const events = [];
const c64PcCounts = new Map();
const drvPcCounts = new Map();
for (let i = 0; i < 400; i++) {
  session.runFor(1, { cycleBudget: 200 });
  const dd00 = r8(0xdd00);
  const drvPb = via1.via[0] & 0xff;
  const drvPort = iec.core.drv_port & 0xff;
  const drvData8 = iec.core.drv_data[8] & 0xff;
  const c64Pc = session.c64Cpu.pc;
  const drvPc = drv.cpu.cpu_regs.pc;
  c64PcCounts.set(c64Pc, (c64PcCounts.get(c64Pc) ?? 0) + 1);
  drvPcCounts.set(drvPc, (drvPcCounts.get(drvPc) ?? 0) + 1);

  if (dd00 !== lastDd00) {
    events.push(`i=${i} $DD00 $${hex(lastDd00)}→$${hex(dd00)} (c64@$${hex(c64Pc,4)})`);
    lastDd00 = dd00;
  }
  if (drvPb !== lastDrvPb) {
    events.push(`i=${i} drv PRB $${hex(lastDrvPb)}→$${hex(drvPb)} (drv@$${hex(drvPc,4)})`);
    lastDrvPb = drvPb;
  }
  if (drvData8 !== lastDrvData8) {
    events.push(`i=${i} drv_data[8] $${hex(lastDrvData8)}→$${hex(drvData8)} (drv@$${hex(drvPc,4)})`);
    lastDrvData8 = drvData8;
  }
  if (drvPort !== lastDrvPort) {
    events.push(`i=${i} drv_port $${hex(lastDrvPort)}→$${hex(drvPort)} (drv@$${hex(drvPc,4)})`);
    lastDrvPort = drvPort;
  }
}

console.log(`\n${events.length} state changes:`);
for (const e of events.slice(0, 40)) console.log(`  ${e}`);
console.log(`\nC64 PC histogram (top 8):`);
for (const [pc, n] of [...c64PcCounts.entries()].sort((a,b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  $${hex(pc,4)} : ${n}`);
}
console.log(`\nDrive PC histogram (top 8):`);
for (const [pc, n] of [...drvPcCounts.entries()].sort((a,b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  $${hex(pc,4)} : ${n}`);
}
