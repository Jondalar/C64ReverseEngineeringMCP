#!/usr/bin/env node
// Verify hypothesis: HL stage-1 stores $11 to $0763 (operand of motm
// runtime LDA). Real hardware should store $00.
//
// Approach: run probe to motm install completion, dump:
//   - drive RAM $0763 (operand byte = X count from stage-1)
//   - drive RAM $0762-$0764 (full LDA instruction bytes)
//   - drive ZP[$01] history during stage-1

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

// Run for 60s then capture final state. Stage-1 finishes within first
// ~25M c64 cycles. Runtime fastloader keeps running. Final $0763 reflects
// stage-1's last STA $0763.
const PAL_HZ = 985248;
const target = session.c64Cpu.cycles + 60 * PAL_HZ;
let firstStage1Capture = null;
const t0 = Date.now();
const samples = [];

while (session.c64Cpu.cycles < target) {
  session.runFor(50_000);
  if ((Date.now() - t0) > 600_000) break;
  // Sample $0763 every ~50k c64 cycles to track when it changes.
  const ram = session.drive.bus.ram;
  samples.push({ tick: session.c64Cpu.cycles, op: ram[0x0762], lo: ram[0x0763], hi: ram[0x0764] });
}

const ram = session.drive.bus.ram;
firstStage1Capture = {
  tick: session.c64Cpu.cycles,
  operand_lo: ram[0x0763],
  operand_hi: ram[0x0764],
  bytes_0760_to_0770: [...ram.subarray(0x0760, 0x0770)],
  zp00: ram[0x00],
  zp01: ram[0x01],
  zp06: ram[0x06],
  zp07: ram[0x07],
  zp08: ram[0x08],
};

// Find when $0763 first became non-zero or changed
console.log("=== $0763 history (first 20 changes) ===");
let prev = -1;
let changes = 0;
for (const s of samples) {
  if (s.lo !== prev) {
    console.log(`  c64=${s.tick} op=$${s.op.toString(16).padStart(2,"0")} $0763=$${s.lo.toString(16).padStart(2,"0")} $0764=$${s.hi.toString(16).padStart(2,"0")}`);
    prev = s.lo;
    if (++changes >= 20) break;
  }
}

if (!firstStage1Capture) {
  console.log("Stage-1 LDA never planted at $0762. Probe may not have reached install.");
  process.exit(1);
}

console.log("=== Stage-1 self-modified state ===");
console.log(`Capture clock: c64=${firstStage1Capture.tick}`);
console.log(`Drive $0762 (LDA opcode):     $${firstStage1Capture.bytes_0760_to_0770[2].toString(16).padStart(2,"0")} (expect B9)`);
console.log(`Drive $0763 (operand low):    $${firstStage1Capture.operand_lo.toString(16).padStart(2,"0")} <-- HYPOTHESIS: $11 in HL, $00 in real hardware`);
console.log(`Drive $0764 (operand high):   $${firstStage1Capture.operand_hi.toString(16).padStart(2,"0")} (expect 03)`);
console.log("");
console.log(`Effective LDA target: $${(firstStage1Capture.operand_hi * 256 + firstStage1Capture.operand_lo).toString(16).padStart(4,"0")},Y`);
console.log("");
console.log(`Drive $0760-$076F bytes: ${firstStage1Capture.bytes_0760_to_0770.map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
console.log("");
console.log(`Drive ZP[$00..$08] at capture: 00=$${firstStage1Capture.zp00.toString(16)} 01=$${firstStage1Capture.zp01.toString(16)} 06=$${firstStage1Capture.zp06.toString(16)} 07=$${firstStage1Capture.zp07.toString(16)} 08=$${firstStage1Capture.zp08.toString(16)}`);

if (firstStage1Capture.operand_lo === 0x11) {
  console.log("\n*** HYPOTHESIS CONFIRMED: HL stage-1 produces $11 (= shifted layout, byte 18 read as next-S). ***");
} else if (firstStage1Capture.operand_lo === 0x00) {
  console.log("\n*** HYPOTHESIS REJECTED: HL stage-1 produces $00 (= correct layout). Bug elsewhere. ***");
} else {
  console.log(`\n*** UNEXPECTED: HL stage-1 produces $${firstStage1Capture.operand_lo.toString(16)} (neither $11 nor $00). ***`);
}
