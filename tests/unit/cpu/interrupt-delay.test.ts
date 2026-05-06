// Spec 146 — interrupt delay tracking (branch + I-flag-clear).
//
// VICE: src/maincpu.c interrupt_check_irq_delay (lines 484-505) +
// interrupt_check_nmi_delay (lines 457-479).
// Pattern: cycle-stamp lastBranchTakeCycle (set on taken-branch w/o
// page-cross) and lastIFlagClearCycle (set on CLI/PLP-clearing-I/
// RTI-clearing-I) determine when a pending IRQ may dispatch.
//
// Run via: npx tsx tests/unit/cpu/interrupt-delay.test.ts

import { strict as assert } from "node:assert";
import { Cpu65xxVice } from "../../../src/runtime/headless/cpu/cpu65xx-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

class FlatMem {
  public ram = new Uint8Array(0x10000);
  read(a: number): number { return this.ram[a & 0xffff]!; }
  write(a: number, v: number): void { this.ram[a & 0xffff] = v & 0xff; }
}

test("Taken branch w/o page cross: cpu.lastBranchTakeCycle stamped", () => {
  const mem = new FlatMem();
  // BNE +$10 at $0200; Z flag clear so branch taken.
  mem.ram[0x0200] = 0xd0; mem.ram[0x0201] = 0x10;
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.flag_z = 1; // Z clear → BNE takes
  // Step until at next boundary.
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  assert.equal(cpu.pc, 0x0212, "branch taken to $0212");
  assert.ok(cpu.lastBranchTakeCycle > 0, "branch stamp set");
});

test("CLI sets lastIFlagClearCycle stamp", () => {
  const mem = new FlatMem();
  mem.ram[0x0200] = 0x58; // CLI
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.flags = 0x04; // I=1
  cpu.executeCycle(); // fetch
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  assert.equal(cpu.flags & 0x04, 0, "I cleared by CLI");
  assert.ok(cpu.lastIFlagClearCycle > 0, "I-flag-clear stamp set");
  assert.ok(cpu.lastIFlagClearInstrLen > 0, "instr-len recorded");
});

test("PLP clearing I sets lastIFlagClearCycle stamp", () => {
  const mem = new FlatMem();
  // Push P=$00 (I=0), then PLP.
  // Setup: SP=$FE, mem[$01FF]=$00, PLP at $0200.
  mem.ram[0x01ff] = 0x00;
  mem.ram[0x0200] = 0x28; // PLP
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.flags = 0x04; // start with I=1
  cpu.sp = 0xfe;
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  assert.equal(cpu.flags & 0x04, 0, "I cleared by PLP");
  assert.ok(cpu.lastIFlagClearCycle > 0, "PLP stamp");
});

test("PLP setting I does NOT touch lastIFlagClearCycle", () => {
  const mem = new FlatMem();
  mem.ram[0x01ff] = 0x04; // P with I=1
  mem.ram[0x0200] = 0x28; // PLP
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.flags = 0; // start with I=0
  cpu.sp = 0xfe;
  cpu.lastIFlagClearCycle = 0;
  cpu.lastIFlagClearInstrLen = 0;
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  assert.equal(cpu.flags & 0x04, 0x04, "I now set");
  assert.equal(cpu.lastIFlagClearCycle, 0, "no stamp on I=0→1");
});

test("IRQ deferred while CLI just executed (1-instruction delay)", () => {
  const mem = new FlatMem();
  // Vectors.
  mem.ram[0xfffe] = 0x00; mem.ram[0xffff] = 0xe0;
  // Program: CLI, NOP, NOP, ...
  mem.ram[0x0200] = 0x58; // CLI
  for (let i = 0x0201; i < 0x0220; i++) mem.ram[i] = 0xea;
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.flags = 0x04; // I=1 entering
  cpu.irqLine = true; // IRQ pending throughout
  // Step CLI to completion.
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  // CLI complete; I now 0. Per VICE, IRQ must wait for the NEXT
  // opcode (NOP) to also complete before dispatch.
  assert.equal(cpu.flags & 0x04, 0, "I=0 after CLI");
  assert.equal(cpu.pc, 0x0201, "PC at NOP after CLI");
  // Step the next instruction. Must NOT be IRQ entry — should run NOP.
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  assert.equal(cpu.pc, 0x0202, `expected NOP completed → PC=$0202; got $${cpu.pc.toString(16)}`);
  // Now IRQ may dispatch on next boundary.
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
  // After this step, PC should be in handler ($E000) OR at $0203
  // depending on where the dispatch landed. Either way, at least
  // one of these two paths must show IRQ taken eventually.
  let safety = 20;
  while (safety-- > 0 && cpu.pc !== 0xe000) cpu.executeCycle();
  assert.equal(cpu.pc, 0xe000, "IRQ eventually dispatches to handler");
});

// ============================================================
// runner
// ============================================================
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${c.name}\n  ${(e as Error).message}`); }
}
console.log(`interrupt-delay: ${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ""}`);
if (fail) process.exit(1);
