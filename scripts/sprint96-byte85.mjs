#!/usr/bin/env node
// Sprint 96 — read drive's $85 (byte being assembled by ACPTR) at each
// drive-cycle the bit-loop ROR $85 fires. Compare to expected $28.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) { process.exit(2); }

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();
session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

const W = (n) => "$" + n.toString(16).toUpperCase().padStart(4, "0");
const RD = (a) => session.drive.bus.ram[a];

// Run until drive enters ACPTR ($E9C9).
for (let i = 0; i < 5_000_000; i++) {
  session.runFor(1);
  if (session.drive.cpu.pc === 0xea18) break; // ROR $85 instruction
}

// Now log $85 every time PC hits ROR $85 ($EA18).
const samples = [];
let lastByte = -1;
for (let i = 0; i < 200_000; i++) {
  session.runFor(1);
  const dpc = session.drive.cpu.pc;
  if (dpc === 0xea18) {
    samples.push({
      drvCyc: session.drive.cpu.cycles,
      c64Cyc: session.c64Cpu.cycles,
      byte85_before: RD(0x85),
      bitCount: RD(0x98),
    });
  }
  // Stop when bit count reaches 0 (last bit shifted in) AND we left the loop
  if (samples.length > 12) break;
}

console.log(`ROR $85 hits during byte receive:`);
for (const s of samples) {
  console.log(`  drvCyc=${s.drvCyc} c64Cyc=${s.c64Cyc} $85(before ROR)=$${s.byte85_before.toString(16).padStart(2,"0")} bitCount=${s.bitCount}`);
}

// After bits received, run a bit more then dump.
session.runFor(2000);
console.log(`\nAfter bit loop: $85=${RD(0x85).toString(16)} $98=${RD(0x98)} drvPC=${W(session.drive.cpu.pc)} $79=${RD(0x79)} $77=${RD(0x77).toString(16)}`);
