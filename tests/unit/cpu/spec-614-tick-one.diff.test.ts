// Spec 614.1 (§3.1) — Cpu65xxVice.tickOne() diff-test.
//
// Pin-test: tickOne() must be observationally identical to
// executeCycle() at every cycle boundary. Today the former is a
// thin alias over the latter; this test exists so a future refactor
// (e.g. inlining the CLK_INC body into tickOne()) cannot silently
// desync the two entry points without flagging here.
//
// Pattern: follows feedback_c_to_ts_diff_test — drive two
// independent Cpu65xxVice instances with identical RAM + identical
// program stream, advance one with tickOne() and the other with
// executeCycle(), and assert byte-equal state every cycle.
//
// Run via: npx tsx tests/unit/cpu/spec-614-tick-one.diff.test.ts

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

function loadProgram(mem: FlatMem, start: number, prog: number[]): void {
  for (let i = 0; i < prog.length; i++) {
    mem.ram[(start + i) & 0xffff] = prog[i]! & 0xff;
  }
}

function snapshot(cpu: Cpu65xxVice): string {
  return [
    `pc=${cpu.reg_pc.toString(16)}`,
    `a=${cpu.reg_a.toString(16)}`,
    `x=${cpu.reg_x.toString(16)}`,
    `y=${cpu.reg_y.toString(16)}`,
    `sp=${cpu.reg_sp.toString(16)}`,
    `p=${cpu.reg_p.toString(16)}`,
    `clk=${cpu.clk}`,
    `boundary=${cpu.isAtInstructionBoundary() ? 1 : 0}`,
  ].join(" ");
}

function buildCpus(programStart: number, prog: number[]): {
  cpuA: Cpu65xxVice; cpuB: Cpu65xxVice;
} {
  const memA = new FlatMem();
  const memB = new FlatMem();
  loadProgram(memA, programStart, prog);
  loadProgram(memB, programStart, prog);
  // Reset vector → programStart.
  memA.ram[0xfffc] = programStart & 0xff;
  memA.ram[0xfffd] = (programStart >> 8) & 0xff;
  memB.ram[0xfffc] = programStart & 0xff;
  memB.ram[0xfffd] = (programStart >> 8) & 0xff;
  const cpuA = new Cpu65xxVice({ memBus: memA });
  const cpuB = new Cpu65xxVice({ memBus: memB });
  cpuA.reset(programStart);
  cpuB.reset(programStart);
  return { cpuA, cpuB };
}

test("tickOne() == executeCycle() for 100 cycles of mixed opcodes", () => {
  // Deterministic mixed-opcode stream that exercises multiple
  // addressing modes (impl, imm, zp, abs), branches, and a JMP
  // back so we loop within 100 cycles without runaway.
  //
  //   $0800: LDA #$42       ; A9 42       2 cy
  //   $0802: STA $20        ; 85 20       3 cy
  //   $0804: LDX #$05       ; A2 05       2 cy
  //   $0806: LDY #$00       ; A0 00       2 cy
  //   $0808: INY            ; C8          2 cy
  //   $0809: DEX            ; CA          2 cy
  //   $080A: BNE $0808      ; D0 FC       2/3 cy
  //   $080C: STA $0300      ; 8D 00 03    4 cy
  //   $080F: NOP            ; EA          2 cy
  //   $0810: JMP $0800      ; 4C 00 08    3 cy
  const prog = [
    0xa9, 0x42,
    0x85, 0x20,
    0xa2, 0x05,
    0xa0, 0x00,
    0xc8,
    0xca,
    0xd0, 0xfc,
    0x8d, 0x00, 0x03,
    0xea,
    0x4c, 0x00, 0x08,
  ];
  const { cpuA, cpuB } = buildCpus(0x0800, prog);
  for (let i = 0; i < 100; i++) {
    cpuA.tickOne();
    cpuB.executeCycle();
    assert.equal(
      snapshot(cpuA),
      snapshot(cpuB),
      `desync at cycle ${i + 1}:\n  A=${snapshot(cpuA)}\n  B=${snapshot(cpuB)}`,
    );
  }
});

test("tickOne() == executeCycle() across instruction boundaries (200 cycles)", () => {
  // Branch-heavy + memory writes to verify mid-instruction cycles
  // (page-cross, branch taken/not-taken) stay locked.
  //
  //   $0900: LDA #$01      ; A9 01     2 cy
  //   $0902: STA $40       ; 85 40     3 cy
  //   $0904: LDX #$00      ; A2 00     2 cy
  //   $0906: INX           ; E8        2 cy
  //   $0907: CPX #$10      ; E0 10     2 cy
  //   $0909: BNE $0906     ; D0 FB     2/3 cy
  //   $090B: STX $41       ; 86 41     3 cy
  //   $090D: JMP $0900     ; 4C 00 09  3 cy
  const prog = [
    0xa9, 0x01,
    0x85, 0x40,
    0xa2, 0x00,
    0xe8,
    0xe0, 0x10,
    0xd0, 0xfb,
    0x86, 0x41,
    0x4c, 0x00, 0x09,
  ];
  const { cpuA, cpuB } = buildCpus(0x0900, prog);
  for (let i = 0; i < 200; i++) {
    cpuA.tickOne();
    cpuB.executeCycle();
    assert.equal(snapshot(cpuA), snapshot(cpuB), `desync at call ${i + 1}`);
  }
  // NOTE: 200 tickOne() calls do not necessarily produce clk=200.
  // Cpu65xxVice's single-dispatch fast path for short opcodes
  // (microcode.length <= 1, startInstructionCycle:815-820) advances
  // clk by the full instruction-cycle count in one call. True
  // 1-call-per-1-clk semantics is a Spec 614.3 (CycleSchedulerVice)
  // requirement, not a 614.1 deliverable. 614.1 only pins the
  // alias contract: tickOne() === executeCycle() at every call.
});

test("tickOne() reaches instruction boundary with expected clk delta", () => {
  // Per Spec 614 §3.1: the drive scheduler ticks the c64 CPU until
  // a target clk is reached, then queries `isAtInstructionBoundary()`
  // to decide whether to fire boundary-aligned drive alarms. This
  // test pins that contract on isolated instructions: ticking until
  // boundary regained must produce the canonical 6502 cycle count.
  //
  // (See note in test 2: a single tickOne() call may itself consume
  // multiple clks via the single-dispatch fast path. The boundary
  // flag and final clk delta are the stable invariants — number of
  // tickOne() calls to reach them is not.)
  const instructions: { name: string; bytes: number[]; cycles: number }[] = [
    { name: "LDA #$42",   bytes: [0xa9, 0x42],       cycles: 2 },
    { name: "LDX #$33",   bytes: [0xa2, 0x33],       cycles: 2 },
    { name: "LDY #$77",   bytes: [0xa0, 0x77],       cycles: 2 },
    { name: "NOP",        bytes: [0xea],             cycles: 2 },
    { name: "INX",        bytes: [0xe8],             cycles: 2 },
    { name: "STA $20",    bytes: [0x85, 0x20],       cycles: 3 },
    { name: "STA $0300",  bytes: [0x8d, 0x00, 0x03], cycles: 4 },
    { name: "JMP $0900",  bytes: [0x4c, 0x00, 0x09], cycles: 3 },
  ];
  for (const { name, bytes, cycles } of instructions) {
    const { cpuA } = buildCpus(0x0800, bytes);
    const startClk = cpuA.clk;
    // Leave the boundary, then tick until back on it (or guard trips).
    cpuA.tickOne();
    let guard = 16;
    while (!cpuA.isAtInstructionBoundary() && guard-- > 0) cpuA.tickOne();
    assert.ok(guard > 0, `${name}: tickOne never returned to boundary`);
    assert.equal(
      cpuA.clk - startClk, cycles,
      `${name}: clk advanced by ${cpuA.clk - startClk}, expected ${cycles}`,
    );
  }
});

// ============================================================
// runner
// ============================================================
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${c.name}\n  ${(e as Error).message}`); }
}
console.log(`spec-614-tick-one.diff: ${pass}/${cases.length} pass${fail ? `, ${fail} fail` : ""}`);
if (fail) process.exit(1);
