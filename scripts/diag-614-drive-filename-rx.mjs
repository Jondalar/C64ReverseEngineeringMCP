#!/usr/bin/env node
// After LOAD"$",8: inspect drive RAM filename buffer + DOS error code.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { mountMedia } = await import("../dist/runtime/headless/media/mount.js");

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/POLARBEAR.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 15 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

const vice = session.kernel.drive1541;
const drv = vice.unit;
const cpud = drv.cpud;
function drvR(a) {
  const fn = cpud?.read_func_ptr?.[(a >> 8) & 0xff];
  return fn ? fn(drv, a) & 0xff : 0;
}
function hex(n,w=2) { return (n&((1<<(w*4))-1)).toString(16).padStart(w,"0"); }

console.log("Drive RAM $0200-$0260 (filename buffer area):");
for (let a = 0x0200; a <= 0x0260; a += 16) {
  let l = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16; i++) {
    const b = drvR(a + i);
    l += hex(b) + " ";
  }
  l += " | ";
  for (let i = 0; i < 16; i++) {
    const b = drvR(a + i);
    l += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".";
  }
  console.log(l);
}

// $0274-$0277 are filename name + length in 1541 DOS
console.log("\nDrive RAM $0270-$0290 (file table):");
for (let a = 0x0270; a <= 0x0290; a += 16) {
  let l = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16; i++) l += hex(drvR(a + i)) + " ";
  console.log(l);
}

// Error indicator: $26 in drive zero page = error number
console.log(`\nDrive zero-page $26 (error number) = $${hex(drvR(0x0026))}`);
// $25 = error code byte
console.log(`Drive zero-page $25 = $${hex(drvR(0x0025))}`);
// $80 area = command channel buffer
console.log(`\nDrive cmd channel $0200-$020F (cmd buffer):`);
let l = "  ";
for (let i = 0; i < 16; i++) l += hex(drvR(0x0200 + i)) + " ";
console.log(l);
l = "  ASCII: ";
for (let i = 0; i < 16; i++) {
  const b = drvR(0x0200 + i);
  l += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".";
}
console.log(l);
