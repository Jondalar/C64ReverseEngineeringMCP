#!/usr/bin/env node
// Smoking-gun test: HL stage-1 writes $11 to drive $0763 (operand of
// motm runtime LDA). Hypothesis says correct value is $00.
//
// Test: detect when stage-1 writes $0763 = $11, force-overwrite to $00,
// continue running. If motm progresses past 512 bytes, hypothesis proven.

import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const { session } = startIntegratedSession({
  diskPath: resolvePath(repoRoot, "samples/motm.g64"),
  mode: "true-drive",
  useMicrocodedCpu: true,
});
session.resetCold("pal-default");
session.runFor(800_000);
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

const PAL_HZ = 985248;
const target = session.c64Cpu.cycles + 60 * PAL_HZ;
let patched = false;
let patchClock = 0;

while (session.c64Cpu.cycles < target) {
  session.runFor(20_000);
  const ram = session.drive.bus.ram;

  // Detect stage-1 completion: $0762=$B9 + $0763 set to non-zero
  if (!patched && ram[0x0762] === 0xb9 && ram[0x0763] !== 0x00) {
    const oldLo = ram[0x0763];
    ram[0x0763] = 0x00;
    patched = true;
    patchClock = session.c64Cpu.cycles;
    console.log(`*** PATCHED at c64 clock ${patchClock}: $0763 was $${oldLo.toString(16).padStart(2,"0")} -> forced to $00 ***`);
  }
}

const ram = session.drive.bus.ram;

console.log("\n=== Final state after 60s run with patch ===");
console.log(`c64 PC: $${session.c64Cpu.pc.toString(16)}`);
console.log(`drive PC: $${session.drive.cpu.pc.toString(16)}`);
console.log(`drive $0763 (final): $${ram[0x0763].toString(16).padStart(2,"0")}`);
console.log(`drive ZP[$00] (job/idle): $${ram[0x00].toString(16).padStart(2,"0")} (= $80 means idle, $00 means active)`);
console.log(`drive ZP[$06] (track): $${ram[0x06].toString(16).padStart(2,"0")}`);
console.log(`drive ZP[$07] (sector): $${ram[0x07].toString(16).padStart(2,"0")}`);
console.log(`drive ZP[$08] (last mode): $${ram[0x08].toString(16).padStart(2,"0")}`);

// Inspect destination buffer at $4500-$4600 (cmd_load_dad target start)
// to see if c64 RX'd file content
const c64Ram = session.c64Bus?.ram ?? session.c64?.bus?.ram ?? session.c64Cpu?.bus?.ram;
if (c64Ram) {
  const samp = [...c64Ram.subarray(0x4500, 0x4520)].map(b=>b.toString(16).padStart(2,"0")).join(" ");
  console.log(`\nc64 dest $4500-$451F: ${samp}`);
  // Compare to expected dad content at offset 2 (after PRG load addr)
  // PRG dad load addr from manifest = 17b * 4 + ... actually just check it's non-zero
  const allZero = c64Ram.subarray(0x4500, 0x6FFF).every(b => b === 0);
  if (allZero) {
    console.log("c64 dest range $4500-$6FFF is ALL ZEROS — dad NOT loaded.");
  } else {
    let nonZeroCount = 0;
    for (let i = 0x4500; i < 0x6FFF; i++) if (c64Ram[i] !== 0) nonZeroCount++;
    console.log(`c64 dest range $4500-$6FFF: ${nonZeroCount} non-zero bytes (= dad partially or fully loaded).`);
  }
}
