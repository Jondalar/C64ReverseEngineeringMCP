// Spec 153 — SO (Set Overflow) input pin for Cpu65xxVice.
//
// VICE reference:
//   src/drive/drivecpu.c:219-223  drivecpu_set_overflow() — sets P_OVERFLOW directly
//   src/6510core.c:153-162        LOCAL_SET_OVERFLOW / drivecpu_rotate()
//   src/6510core.c:2528-2530      PHP DRIVE_CPU byte_ready_edge check
//   src/6510core.c:2816-2818      BVC DRIVE_CPU byte_ready_edge check
//   src/6510core.c:2935-2937      BVS DRIVE_CPU byte_ready_edge check
//
// Run via: npx tsx tests/unit/cpu/so-pin.test.ts

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

/** Step one full instruction boundary (fetch + all micro-ops). */
function stepInstruction(cpu: Cpu65xxVice): void {
  cpu.executeCycle();
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();
}

const P_OVERFLOW = 0x40;

// ----------------------------------------------------------------
// Test 1: SO high — no V change.
// ----------------------------------------------------------------
test("SO held high: V flag not set", () => {
  const mem = new FlatMem();
  mem.ram[0x0200] = 0xea; // NOP
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);

  // Ensure V is clear.
  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;
  // SO stays high (default).
  assert.equal(cpu.soLine, 1);

  stepInstruction(cpu);

  assert.equal(cpu.reg_p & P_OVERFLOW, 0, "V must remain clear while SO=high");
});

// ----------------------------------------------------------------
// Test 2: SO high → low transition → V set after next executeCycle.
// ----------------------------------------------------------------
test("SO high→low: V set in P register after next cycle", () => {
  const mem = new FlatMem();
  mem.ram[0x0200] = 0xea; // NOP
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);

  // Ensure V is clear.
  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;

  // Drop SO low — edge detected on NEXT executeCycle call.
  cpu.setSoLine(0);

  // First cycle tick: edge fires → V set.
  cpu.executeCycle();

  assert.equal(cpu.reg_p & P_OVERFLOW, P_OVERFLOW, "V must be set on first cycle after SO high→low");
});

// ----------------------------------------------------------------
// Test 3: SO stays low — V set ONLY ONCE (not on every cycle).
// ----------------------------------------------------------------
test("SO stays low: V set once, not repeatedly each cycle", () => {
  const mem = new FlatMem();
  // Loop of NOPs so we can keep stepping.
  for (let i = 0x0200; i < 0x0210; i++) mem.ram[i] = 0xea;
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);

  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;

  // Edge: high → low.
  cpu.setSoLine(0);
  cpu.executeCycle(); // edge fires, V set.
  assert.equal(cpu.reg_p & P_OVERFLOW, P_OVERFLOW, "V set on first cycle after edge");

  // Now clear V manually to verify it isn't re-set while SO stays low.
  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;

  // Step another full instruction with SO still low.
  stepInstruction(cpu);

  assert.equal(cpu.reg_p & P_OVERFLOW, 0, "V must NOT be re-set while SO stays low (no new edge)");
});

// ----------------------------------------------------------------
// Test 4: SO low → high transition — V unchanged.
// ----------------------------------------------------------------
test("SO low→high: V unchanged (no V-clear from SO)", () => {
  const mem = new FlatMem();
  mem.ram[0x0200] = 0xea; // NOP
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);

  // Pre-set SO low so prevSoLine = 0.
  cpu.setSoLine(0);
  cpu.executeCycle(); // consume edge, V set.

  // Now raise SO back high.
  cpu.setSoLine(1);
  // Clear V manually to see if the rising edge incorrectly sets it.
  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;

  cpu.executeCycle(); // rising edge — must NOT set V.

  assert.equal(cpu.reg_p & P_OVERFLOW, 0, "V must NOT be set on SO low→high (rising edge is ignored)");
});

// ----------------------------------------------------------------
// Test 5: SO + IRQ same cycle — V set AND IRQ dispatches normally.
// ----------------------------------------------------------------
test("SO + IRQ same cycle: V set, IRQ dispatch unaffected", () => {
  const mem = new FlatMem();
  // IRQ vector → $E000.
  mem.ram[0xfffe] = 0x00; mem.ram[0xffff] = 0xe0;
  // NOPs at handler.
  for (let i = 0xe000; i < 0xe010; i++) mem.ram[i] = 0xea;
  // NOP at start.
  for (let i = 0x0200; i < 0x0210; i++) mem.ram[i] = 0xea;

  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);

  // I flag clear so IRQ can fire.
  cpu.reg_p = cpu.reg_p & ~0x04;
  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;

  // Assert IRQ and SO falling edge simultaneously.
  cpu.irqLine = true;
  cpu.setSoLine(0);

  // Step one cycle — SO edge detected (V set) at top of executeCycle,
  // then IRQ dispatch proceeds if we hit a boundary.
  // Step through until boundary (IRQ handler or instruction end).
  let safety = 30;
  while (safety-- > 0 && !cpu.isAtInstructionBoundary()) {
    cpu.executeCycle();
  }
  cpu.executeCycle(); // boundary — IRQ may dispatch here.
  while (!cpu.isAtInstructionBoundary()) cpu.executeCycle();

  // V must be set (from SO edge).
  assert.equal(cpu.reg_p & P_OVERFLOW, P_OVERFLOW, "V set despite concurrent IRQ");

  // IRQ must eventually dispatch CPU to $E000.
  safety = 50;
  while (safety-- > 0 && cpu.pc !== 0xe000) {
    cpu.executeCycle();
    if (cpu.isAtInstructionBoundary() && cpu.pc !== 0xe000) {
      cpu.executeCycle();
    }
  }
  assert.equal(cpu.pc, 0xe000, "IRQ handler reached at $E000 — IRQ not suppressed by SO");
});

// ----------------------------------------------------------------
// Test 6: SO + NMI same cycle — V set AND NMI dispatches normally.
// ----------------------------------------------------------------
test("SO + NMI same cycle: V set, NMI dispatch unaffected", () => {
  const mem = new FlatMem();
  // NMI vector → $D000.
  mem.ram[0xfffa] = 0x00; mem.ram[0xfffb] = 0xd0;
  for (let i = 0xd000; i < 0xd010; i++) mem.ram[i] = 0xea;
  for (let i = 0x0200; i < 0x0210; i++) mem.ram[i] = 0xea;

  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.reg_p = cpu.reg_p & ~P_OVERFLOW;

  // Assert NMI and SO falling edge simultaneously.
  cpu.nmiLine = true;
  cpu.setSoLine(0);

  // Drive until NMI dispatched + handler reached.
  let safety = 60;
  while (safety-- > 0 && cpu.pc !== 0xd000) {
    cpu.executeCycle();
  }

  assert.equal(cpu.pc, 0xd000, "NMI handler reached at $D000 — NMI not suppressed by SO");
  assert.equal(cpu.reg_p & P_OVERFLOW, P_OVERFLOW, "V set despite concurrent NMI");
});

// ----------------------------------------------------------------
// Test 7: setSoLine API — verifies soLine field reflects set value.
// ----------------------------------------------------------------
test("setSoLine API: field reflects caller-supplied level", () => {
  const mem = new FlatMem();
  mem.ram[0x0200] = 0xea;
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);

  assert.equal(cpu.soLine, 1, "default SO = 1 (high / inactive)");
  cpu.setSoLine(0);
  assert.equal(cpu.soLine, 0, "SO = 0 after setSoLine(0)");
  cpu.setSoLine(1);
  assert.equal(cpu.soLine, 1, "SO = 1 after setSoLine(1)");
});

// ================================================================
// Runner
// ================================================================
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${c.name}\n  ${(e as Error).message}`); }
}
console.log(`so-pin: ${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ""}`);
if (fail) process.exit(1);
