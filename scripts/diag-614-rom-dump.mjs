#!/usr/bin/env node
import { resolve as resolvePath } from "node:path";
const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { mountMedia } = await import("../dist/runtime/headless/media/mount.js");

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/synthetic/blank.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);

const bus = session.c64Bus;
function hex(n, w = 2) { return (n & ((1 << (w * 4)) - 1)).toString(16).padStart(w, "0"); }
console.log("C64 KERNAL $EE10-$EEFF:");
for (let a = 0xee10; a <= 0xeeff; a += 16) {
  let line = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16; i++) line += hex(bus.read(a + i) & 0xff) + " ";
  console.log(line);
}
console.log("\nC64 KERNAL $ED00-$ED40:");
for (let a = 0xed00; a <= 0xed40; a += 16) {
  let line = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16; i++) line += hex(bus.read(a + i) & 0xff) + " ";
  console.log(line);
}

const vice = session.kernel.drive1541;
const drv = vice.unit;
const cpud = drv.cpud;
function drvR(addr) {
  const fn = cpud?.read_func_ptr?.[(addr >> 8) & 0xff];
  return fn ? fn(drv, addr) & 0xff : -1;
}
console.log("\nDrive ROM $EA00-$EB40:");
for (let a = 0xea00; a <= 0xeb40; a += 16) {
  let line = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16; i++) line += hex(drvR(a + i)) + " ";
  console.log(line);
}
console.log("\nDrive ROM $E840-$E910 (ATN handler region):");
for (let a = 0xe840; a <= 0xe910; a += 16) {
  let line = `  $${hex(a,4)}: `;
  for (let i = 0; i < 16; i++) line += hex(drvR(a + i)) + " ";
  console.log(line);
}
