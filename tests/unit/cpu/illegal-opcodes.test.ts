// Spec 146 — illegal/undocumented opcode coverage.
//
// VICE 6510core.c handles 256 opcodes including stable illegals
// (LAX, SAX, DCP, ISB, RLA, RRA, SLO, SRE, ANC, ASR/ALR, ARR) and
// JAM/KIL ($02, $12, $22, $32, $42, $52, $62, $72, $92, $B2, $D2,
// $F2). This test exercises the doctrine-required pieces:
//  * stable illegals: functional equivalence with VICE
//  * JAM: CPU halt + jammed state + lastJamOpcode/Pc captured
//
// Run via: npx tsx tests/unit/cpu/illegal-opcodes.test.ts

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

function newCpu(): { cpu: Cpu65xxVice; mem: FlatMem } {
  const mem = new FlatMem();
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  return { cpu, mem };
}

function step(cpu: Cpu65xxVice, max = 16): number {
  const start = cpu.cycles;
  cpu.executeCycle();
  let n = 1;
  while (!cpu.isAtInstructionBoundary() && n < max) {
    cpu.executeCycle();
    n++;
  }
  return cpu.cycles - start;
}

// ============================================================
// LAX = LDA + LDX (illegal $A7 zp, $AF abs, $A3 indx, $B3 indy, etc.)
// ============================================================
test("LAX zp ($A7): A=X=mem[zp]", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0050] = 0x77;
  mem.ram[0x0200] = 0xa7; mem.ram[0x0201] = 0x50;
  step(cpu);
  assert.equal(cpu.a, 0x77);
  assert.equal(cpu.x, 0x77);
});

// ============================================================
// SAX = mem ← A & X (illegal $87 zp, $8F abs, $83 indx, $97 zpy)
// ============================================================
test("SAX abs ($8F): mem ← A & X", () => {
  const { cpu, mem } = newCpu();
  cpu.a = 0xf0; cpu.x = 0x0f;
  mem.ram[0x0200] = 0x8f; mem.ram[0x0201] = 0x00; mem.ram[0x0202] = 0x40;
  step(cpu);
  assert.equal(mem.ram[0x4000], 0xf0 & 0x0f, "SAX: $4000 = A & X = 0");
});

// ============================================================
// DCP = DEC + CMP (illegal $C7 zp, etc.)
// ============================================================
test("DCP zp ($C7): mem--, then CMP A,mem", () => {
  const { cpu, mem } = newCpu();
  cpu.a = 0x10;
  mem.ram[0x0050] = 0x11;
  mem.ram[0x0200] = 0xc7; mem.ram[0x0201] = 0x50;
  step(cpu);
  assert.equal(mem.ram[0x0050], 0x10, "decremented");
  // A == new mem → Z=1, C=1.
  assert.equal(cpu.flags & 0x02, 0x02, "Z set (A==mem)");
  assert.equal(cpu.flags & 0x01, 0x01, "C set (A>=mem)");
});

// ============================================================
// SLO = ASL + ORA (illegal $07 zp, etc.)
// ============================================================
test("SLO zp ($07): mem<<1, A |= shifted", () => {
  const { cpu, mem } = newCpu();
  cpu.a = 0x01;
  mem.ram[0x0050] = 0x40;
  mem.ram[0x0200] = 0x07; mem.ram[0x0201] = 0x50;
  step(cpu);
  assert.equal(mem.ram[0x0050], 0x80, "ASL: $40 << 1 = $80");
  assert.equal(cpu.a, 0x81, "ORA: 0x01 | 0x80");
});

// ============================================================
// JAM/KIL halts CPU, sets jammed flag, captures opcode + PC.
// ============================================================
test("KIL $02: sets jammed=true, captures opcode + PC", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0x02; // KIL
  cpu.executeCycle();
  assert.ok(cpu.jammed, "CPU halted");
  assert.equal(cpu.lastJamOpcode, 0x02);
  assert.equal(cpu.lastJamPc, 0x0200);
});

test("KIL $12, $22, ... all halt", () => {
  const jamOpcodes = [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xb2, 0xd2, 0xf2];
  for (const op of jamOpcodes) {
    const { cpu, mem } = newCpu();
    mem.ram[0x0200] = op;
    cpu.executeCycle();
    assert.ok(cpu.jammed, `opcode $${op.toString(16)} should halt`);
    assert.equal(cpu.lastJamOpcode, op);
  }
});

test("After JAM, executeCycle continues to advance clk but PC frozen", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0x02; // KIL
  cpu.executeCycle();
  const pcAtHalt = cpu.pc;
  const clkAtHalt = cpu.cycles;
  for (let i = 0; i < 10; i++) cpu.executeCycle();
  assert.equal(cpu.pc, pcAtHalt, "PC frozen post-JAM");
  assert.ok(cpu.cycles > clkAtHalt, "clk still advancing");
});

// ============================================================
// runner
// ============================================================
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${c.name}\n  ${(e as Error).message}`); }
}
console.log(`illegal-opcodes: ${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ""}`);
if (fail) process.exit(1);
