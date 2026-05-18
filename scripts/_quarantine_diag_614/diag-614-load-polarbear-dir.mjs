#!/usr/bin/env node
// LOAD"$",8 + LIST against POLARBEAR.d64 (real disk with directory).

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "samples/POLARBEAR.d64"));
session.resetCold("pal-default");
session.runFor(2_000_000);

session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target1 = session.c64Cpu.cycles + 15 * PAL_HZ;
while (session.c64Cpu.cycles < target1) session.runFor(200_000);

session.typeText('LIST\r', 80_000, 80_000);
const target2 = session.c64Cpu.cycles + 4 * PAL_HZ;
while (session.c64Cpu.cycles < target2) session.runFor(200_000);

// Decode screen RAM
function decodeScreen(ram) {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i] & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
const ram = session.c64Bus.ram;
const screen = decodeScreen(ram);

console.log(`c64.cycles = ${session.c64Cpu.cycles}`);
console.log(`c64 PC = $${session.c64Cpu.pc.toString(16)}`);
console.log("Screen (25x40):");
for (let row = 0; row < 25; row++) {
  console.log(`| ${screen.slice(row*40, row*40+40)}`);
}
