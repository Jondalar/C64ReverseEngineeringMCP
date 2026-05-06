// Spec 146 — IRQ/NMI entry sequencing.
//
// VICE 6510core.c DO_INTERRUPT macro (lines 436-530):
//   2 dummy reads at PC, PC+1
//   3 pushes (PCH, PCL, P)
//   2 vector reads ($FFFE/$FFFF for IRQ, $FFFA/$FFFB for NMI)
// Total 7 cycles.
//
// Run via: npx tsx tests/unit/cpu/interrupt-entry.test.ts

import { strict as assert } from "node:assert";
import { Cpu65xxVice, type BusEvent } from "../../../src/runtime/headless/cpu/cpu65xx-vice.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

class FlatMem {
  public ram = new Uint8Array(0x10000);
  read(a: number): number { return this.ram[a & 0xffff]!; }
  write(a: number, v: number): void { this.ram[a & 0xffff] = v & 0xff; }
}

function setVector(mem: FlatMem, vec: number, target: number): void {
  mem.ram[vec] = target & 0xff;
  mem.ram[vec + 1] = (target >> 8) & 0xff;
}

test("IRQ entry: 7 cycles, PC + P pushed, I=1, vector loaded", () => {
  const mem = new FlatMem();
  setVector(mem, 0xfffe, 0xea31);
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x1234);
  cpu.flags = 0; // I clear so IRQ can enter
  cpu.sp = 0xff;
  const before = cpu.cycles;
  const target = cpu.serviceInterrupt(0xfffe, false);
  // VICE DO_INTERRUPT (src/6510core.c:436): 2 dummy reads + PCH/PCL
  // pushes + P push + 2 vector reads = 7 cycles.
  const elapsed = cpu.cycles - before;
  assert.equal(elapsed, 7, `service should advance 7 cycles (VICE IRQ_CYCLES), got ${elapsed}`);
  assert.equal(target, 0xea31);
  assert.equal(cpu.pc, 0xea31);
  // PCH/PCL pushed.
  assert.equal(mem.ram[0x01ff], 0x12, "PCH on stack");
  assert.equal(mem.ram[0x01fe], 0x34, "PCL on stack");
  // P pushed with B=0 (IRQ, not BRK).
  const pushedP = mem.ram[0x01fd]!;
  assert.equal(pushedP & 0x10, 0, "B=0 for IRQ");
  // I=1 after entry.
  assert.equal(cpu.flags & 0x04, 0x04);
  // SP decremented by 3.
  assert.equal(cpu.sp, 0xfc);
});

test("BRK entry: pushes P with B=1", () => {
  const mem = new FlatMem();
  setVector(mem, 0xfffe, 0xe000);
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x2000);
  cpu.flags = 0;
  cpu.sp = 0xff;
  cpu.serviceInterrupt(0xfffe, true);
  const pushedP = mem.ram[0x01fd]!;
  assert.equal(pushedP & 0x10, 0x10, "B=1 for BRK");
});

test("IRQ entry: 2 dummy reads at PC and PC+1 emitted", () => {
  const mem = new FlatMem();
  setVector(mem, 0xfffe, 0xea31);
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x4400);
  cpu.flags = 0;
  cpu.sp = 0xff;
  const events: BusEvent[] = [];
  cpu.enableBusTrace(true);
  cpu.addBusListener(ev => events.push(ev));
  cpu.serviceInterrupt(0xfffe, false);
  const dummy = events.filter(e => e.kind === "DUMMY_READ");
  assert.ok(dummy.length >= 2, `expected ≥2 DUMMY_READ events, got ${dummy.length}`);
  assert.equal(dummy[0]!.addr, 0x4400);
  assert.equal(dummy[1]!.addr, 0x4401);
  // Vector reads (READ) at $FFFE/$FFFF.
  const reads = events.filter(e => e.kind === "READ");
  const vecReads = reads.filter(e => e.addr === 0xfffe || e.addr === 0xffff);
  assert.equal(vecReads.length, 2);
});

test("NMI entry: vector at $FFFA/$FFFB", () => {
  const mem = new FlatMem();
  setVector(mem, 0xfffa, 0xfe43);
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x5000);
  cpu.flags = 0;
  cpu.serviceInterrupt(0xfffa, false);
  assert.equal(cpu.pc, 0xfe43);
});

test("Edge-detected NMI fires once per low-going edge", () => {
  const mem = new FlatMem();
  setVector(mem, 0xfffa, 0xfe00);
  setVector(mem, 0xfffe, 0xee00);
  // Place RTI at the NMI handler so it returns cleanly.
  mem.ram[0xfe00] = 0x40; // RTI
  // Filler NOPs at $0200.
  for (let i = 0x0200; i < 0x0220; i++) mem.ram[i] = 0xea;
  const cpu = new Cpu65xxVice({ memBus: mem });
  cpu.reset(0x0200);
  cpu.flags = 0;
  cpu.sp = 0xff;
  // Run a few NOPs — NMI not asserted yet.
  for (let i = 0; i < 4; i++) cpu.executeCycle();
  assert.ok(cpu.pc >= 0x0200 && cpu.pc < 0x0220, "still in NOP block");
  // Assert NMI line — edge detected on next opcode boundary.
  cpu.nmiLine = true;
  // Run until we leave the NOP block (NMI taken).
  let safety = 50;
  while (safety-- > 0 && cpu.pc !== 0xfe00) cpu.executeCycle();
  assert.equal(cpu.pc, 0xfe00, "NMI taken to $FE00");
});
// ============================================================
// runner
// ============================================================
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${c.name}\n  ${(e as Error).message}`); }
}
console.log(`interrupt-entry: ${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ""}`);
if (fail) process.exit(1);
