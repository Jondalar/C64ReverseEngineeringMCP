// Spec 146 — Cpu65xxVice opcode tests grouped by addressing mode.
//
// VICE 6510core.c is the reference. Each test cites the dispatcher
// case that defines cycle count + bus access pattern.
//
// Run via: npx tsx tests/unit/cpu/opcodes-by-mode.test.ts

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
// IMMEDIATE — VICE 6510core.c LDA #imm = 2 cycles, fetch_imm.
// ============================================================
test("imm: LDA #$42 = 2 cycles, A=0x42, NZ updated", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0xa9; mem.ram[0x0201] = 0x42; // LDA #$42
  const cy = step(cpu);
  assert.equal(cy, 2);
  assert.equal(cpu.a, 0x42);
  assert.equal(cpu.flag_z, 1, "Z clear");
  assert.equal(cpu.flag_n, 0, "N clear");
});

test("imm: LDA #$00 sets Z", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0xa9; mem.ram[0x0201] = 0x00;
  step(cpu);
  assert.equal(cpu.flag_z, 0, "Z set (flag_z==0 means Z bit set)");
});

test("imm: LDX #$80 sets N", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0xa2; mem.ram[0x0201] = 0x80;
  step(cpu);
  assert.equal(cpu.x, 0x80);
  assert.equal(cpu.flag_n, 0x80);
});

// ============================================================
// ZERO PAGE — LDA $nn = 3 cycles.
// ============================================================
test("zp: LDA $42 = 3 cycles", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0042] = 0xab;
  mem.ram[0x0200] = 0xa5; mem.ram[0x0201] = 0x42;
  const cy = step(cpu);
  assert.equal(cy, 3);
  assert.equal(cpu.a, 0xab);
});

test("zp_write: STA $42 = 3 cycles, mem[$42]=A", () => {
  const { cpu, mem } = newCpu();
  cpu.a = 0x55;
  mem.ram[0x0200] = 0x85; mem.ram[0x0201] = 0x42;
  const cy = step(cpu);
  assert.equal(cy, 3);
  assert.equal(mem.ram[0x0042], 0x55);
});

// ============================================================
// ZERO PAGE,X — LDA $nn,X = 4 cycles.
// ============================================================
test("zpx: LDA $40,X = 4 cycles, X=2 → reads $42", () => {
  const { cpu, mem } = newCpu();
  cpu.x = 2;
  mem.ram[0x0042] = 0xcd;
  mem.ram[0x0200] = 0xb5; mem.ram[0x0201] = 0x40;
  const cy = step(cpu);
  assert.equal(cy, 4);
  assert.equal(cpu.a, 0xcd);
});

test("zpx wrap: LDA $FF,X X=1 wraps to $00", () => {
  const { cpu, mem } = newCpu();
  cpu.x = 1;
  mem.ram[0x0000] = 0x99;
  mem.ram[0x0200] = 0xb5; mem.ram[0x0201] = 0xff;
  step(cpu);
  assert.equal(cpu.a, 0x99);
});

// ============================================================
// ABSOLUTE — LDA $nnnn = 4 cycles.
// ============================================================
test("abs: LDA $1234 = 4 cycles", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x1234] = 0x77;
  mem.ram[0x0200] = 0xad; mem.ram[0x0201] = 0x34; mem.ram[0x0202] = 0x12;
  const cy = step(cpu);
  assert.equal(cy, 4);
  assert.equal(cpu.a, 0x77);
});

test("abs_write: STA $1234 = 4 cycles", () => {
  const { cpu, mem } = newCpu();
  cpu.a = 0x66;
  mem.ram[0x0200] = 0x8d; mem.ram[0x0201] = 0x34; mem.ram[0x0202] = 0x12;
  const cy = step(cpu);
  assert.equal(cy, 4);
  assert.equal(mem.ram[0x1234], 0x66);
});

// ============================================================
// ABSOLUTE,X — LDA $nnnn,X. 4 cycles no page-cross, 5 with cross.
// ============================================================
test("absx: LDA $1200,X X=4 = 4 cycles (no page cross)", () => {
  const { cpu, mem } = newCpu();
  cpu.x = 4;
  mem.ram[0x1204] = 0x88;
  mem.ram[0x0200] = 0xbd; mem.ram[0x0201] = 0x00; mem.ram[0x0202] = 0x12;
  const cy = step(cpu);
  assert.equal(cy, 4);
  assert.equal(cpu.a, 0x88);
});

test("absx page-cross: LDA $12FF,X X=2 = 5 cycles", () => {
  const { cpu, mem } = newCpu();
  cpu.x = 2;
  mem.ram[0x1301] = 0x99;
  mem.ram[0x0200] = 0xbd; mem.ram[0x0201] = 0xff; mem.ram[0x0202] = 0x12;
  const cy = step(cpu);
  assert.equal(cy, 5);
  assert.equal(cpu.a, 0x99);
});

// ============================================================
// (ZP),Y — LDA ($nn),Y. 5 cycles no cross, 6 with cross.
// ============================================================
test("indy: LDA ($40),Y = 5 cycles no cross", () => {
  const { cpu, mem } = newCpu();
  cpu.y = 4;
  mem.ram[0x0040] = 0x00; mem.ram[0x0041] = 0x12;
  mem.ram[0x1204] = 0xbe;
  mem.ram[0x0200] = 0xb1; mem.ram[0x0201] = 0x40;
  const cy = step(cpu);
  assert.equal(cy, 5);
  assert.equal(cpu.a, 0xbe);
});

test("indy page cross: LDA ($40),Y Y=2 base $12FF → 6 cycles", () => {
  const { cpu, mem } = newCpu();
  cpu.y = 2;
  mem.ram[0x0040] = 0xff; mem.ram[0x0041] = 0x12;
  mem.ram[0x1301] = 0x77;
  mem.ram[0x0200] = 0xb1; mem.ram[0x0201] = 0x40;
  const cy = step(cpu);
  assert.equal(cy, 6);
  assert.equal(cpu.a, 0x77);
});

// ============================================================
// RMW — INC $nnnn double-write pattern (read + write old + write new).
// VICE 6510core.c CASE_INC_ABS: 6 cycles.
// ============================================================
test("abs_rmw: INC $1234 = 6 cycles, mem++", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x1234] = 0x10;
  mem.ram[0x0200] = 0xee; mem.ram[0x0201] = 0x34; mem.ram[0x0202] = 0x12;
  const cy = step(cpu);
  assert.equal(cy, 6);
  assert.equal(mem.ram[0x1234], 0x11);
});

test("RMW emits dummy_write_ea_old (bus trace shows 2 stores)", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0050] = 0x10;
  mem.ram[0x0200] = 0xe6; mem.ram[0x0201] = 0x50; // INC $50
  cpu.enableBusTrace(true);
  const writes: { addr: number; value: number; kind: string }[] = [];
  cpu.addBusListener((ev) => {
    if (ev.kind === "WRITE" || ev.kind === "DUMMY_WRITE") {
      writes.push({ addr: ev.addr, value: ev.value, kind: ev.kind });
    }
  });
  step(cpu);
  // VICE pattern: dummy write of OLD value, then write of NEW value.
  const ramWrites = writes.filter(w => w.addr === 0x50);
  assert.equal(ramWrites.length, 2, `expected 2 writes to $50, got ${JSON.stringify(ramWrites)}`);
  assert.equal(ramWrites[0]!.value, 0x10);
  assert.equal(ramWrites[0]!.kind, "DUMMY_WRITE");
  assert.equal(ramWrites[1]!.value, 0x11);
  assert.equal(ramWrites[1]!.kind, "WRITE");
});

// ============================================================
// IMPLIED — TXA, TAX, NOP = 2 cycles.
// ============================================================
test("imp: NOP = 2 cycles", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0xea;
  const cy = step(cpu);
  assert.equal(cy, 2);
});

test("imp: TXA = 2 cycles, A=X, NZ", () => {
  const { cpu, mem } = newCpu();
  cpu.x = 0x80;
  mem.ram[0x0200] = 0x8a;
  const cy = step(cpu);
  assert.equal(cy, 2);
  assert.equal(cpu.a, 0x80);
  assert.equal(cpu.flag_n, 0x80);
});

// ============================================================
// PUSH/POP — PHA = 3, PLA = 4 cycles.
// ============================================================
test("push: PHA = 3 cycles, decrements SP, pushes A", () => {
  const { cpu, mem } = newCpu();
  cpu.a = 0x42;
  cpu.sp = 0xff;
  mem.ram[0x0200] = 0x48;
  const cy = step(cpu);
  assert.equal(cy, 3);
  assert.equal(mem.ram[0x01ff], 0x42);
  assert.equal(cpu.sp, 0xfe);
});

test("pop: PLA = 4 cycles, increments SP, A=stack", () => {
  const { cpu, mem } = newCpu();
  cpu.sp = 0xfe;
  mem.ram[0x01ff] = 0x99;
  mem.ram[0x0200] = 0x68;
  const cy = step(cpu);
  assert.equal(cy, 4);
  assert.equal(cpu.a, 0x99);
  assert.equal(cpu.sp, 0xff);
});

// ============================================================
// JSR/RTS — JSR = 6 cycles, RTS = 6 cycles.
// ============================================================
test("jsr: JSR $1234 = 6 cycles, PC=$1234, return on stack", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x0200] = 0x20; mem.ram[0x0201] = 0x34; mem.ram[0x0202] = 0x12;
  const cy = step(cpu);
  assert.equal(cy, 6);
  assert.equal(cpu.pc, 0x1234);
});

// ============================================================
// Branches — BNE not taken = 2 cycles, taken no cross = 3, taken cross = 4.
// ============================================================
test("branch not taken: BNE = 2 cycles", () => {
  const { cpu, mem } = newCpu();
  cpu.flag_z = 0; // Z set
  mem.ram[0x0200] = 0xd0; mem.ram[0x0201] = 0x10;
  const cy = step(cpu);
  assert.equal(cy, 2);
});

test("branch taken no page cross: BNE = 3 cycles", () => {
  const { cpu, mem } = newCpu();
  cpu.flag_z = 1; // Z clear
  mem.ram[0x0200] = 0xd0; mem.ram[0x0201] = 0x10;
  const cy = step(cpu);
  assert.equal(cy, 3);
  assert.equal(cpu.pc, 0x0212);
});

// ============================================================
// IND JMP — JMP ($nnnn) = 5 cycles, 6502 page-wrap bug.
// ============================================================
test("ind jmp: JMP ($02FF) reads vector with page wrap bug", () => {
  const { cpu, mem } = newCpu();
  mem.ram[0x02ff] = 0x34;
  mem.ram[0x0200] = 0x00; // bug: hi byte read from $0200 not $0300
  mem.ram[0x0300] = 0xff;
  // Override PC to avoid hitting our own JMP setup.
  cpu.pc = 0x0500;
  mem.ram[0x0500] = 0x6c; mem.ram[0x0501] = 0xff; mem.ram[0x0502] = 0x02;
  const cy = step(cpu);
  assert.equal(cy, 5);
  // Bug: hi byte is mem[$0200], not mem[$0300]. mem[$0200]=0x00.
  assert.equal(cpu.pc, 0x0034, `expected $0034 (page-wrap), got $${cpu.pc.toString(16)}`);
});

// ============================================================
// runner
// ============================================================
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${c.name}\n  ${(e as Error).message}`); }
}
console.log(`opcodes-by-mode: ${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ""}`);
if (fail) process.exit(1);
