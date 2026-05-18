// Spec 615 acceptance §4 #1 — LOAD"$",8 on POLARBEAR.d64 must echo
// directory entries (not "?FILE NOT FOUND ERROR").
//
// Run via: npx tsx tests/spec-615/load-dollar-polarbear.test.ts

import { resolve as resolvePath } from "node:path";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

await mountMedia(
  session,
  8,
  resolvePath(import.meta.dirname, "..", "..", "samples/POLARBEAR.d64"),
);

session.resetCold("pal-default");
session.runFor(2_000_000);

const drv = session.kernel.drive1541.unit;
const htAfterAttach = drv.drives[0]?.current_half_track ?? 0;
console.log(`Post-attach drv.current_half_track = ${htAfterAttach} (Codex saw HT37, target HT36)`);

session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 15 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

function decodeScreen(ram: Uint8Array): string {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i]! & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}

const screen = decodeScreen((session.c64Bus as { ram: Uint8Array }).ram);
console.log(`c64.cycles = ${session.c64Cpu.cycles}  c64 PC = $${session.c64Cpu.pc.toString(16)}`);
console.log(`Post-LOAD drv.current_half_track = ${drv.drives[0]?.current_half_track ?? 0}`);
console.log("Screen (25x40):");
for (let row = 0; row < 25; row++) {
  console.log(`| ${screen.slice(row * 40, row * 40 + 40)}`);
}

const errored = /FILE NOT FOUND/.test(screen);
const sawSearching = /SEARCHING FOR/.test(screen);
const sawReady = /READY/.test(screen);
console.log("");
console.log(`SEARCHING FOR : ${sawSearching}`);
console.log(`READY         : ${sawReady}`);
console.log(`FILE NOT FOUND: ${errored}`);
if (errored) {
  console.log("STILL RED — drive can't read directory.");
  process.exit(1);
}
console.log("GREEN — no error in directory load.");
