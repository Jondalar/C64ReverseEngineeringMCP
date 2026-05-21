// Spec 623 §4.2/§4.3 — interrupt-aware stepping + flow-focus tests.
//
// Drives the FlowTracker with a scripted mini-6502 (just the opcodes the
// classifier cares about: JSR/RTS/RTI/BRK/NOP + a one-shot pending IRQ/NMI)
// so JSR/interrupt nesting is exercised deterministically without the full
// emulator. Run via: npx tsx tests/unit/debug/stepping.test.ts

import { strict as assert } from "node:assert";
import { FlowTracker, type SteppableSession } from "../../../src/runtime/headless/debug/stepping.js";

const NOP = 0xea, JSR = 0x20, RTS = 0x60, RTI = 0x40, BRK = 0x00;

// Minimal session: a 64K memory + pc/sp, runFor honoring breakpoints +
// instruction cap, with a one-shot pending IRQ/NMI taken before the next op.
class MiniCpu implements SteppableSession {
  mem = new Uint8Array(0x10000);
  c64Cpu = { pc: 0, sp: 0xff, cycles: 0, a: 0, x: 0, y: 0, flags: 0x20 };
  pendingIrq = false;
  pendingNmi = false;
  private p = 0x20;

  constructor() {
    // distinct IRQ ($3000) + NMI ($3100) vectors
    this.mem[0xfffe] = 0x00; this.mem[0xffff] = 0x30;
    this.mem[0xfffa] = 0x00; this.mem[0xfffb] = 0x31;
  }
  c64Bus = { read: (a: number) => this.mem[a & 0xffff]! };

  private push(v: number) { this.mem[0x100 + this.c64Cpu.sp] = v & 0xff; this.c64Cpu.sp = (this.c64Cpu.sp - 1) & 0xff; }
  private pull(): number { this.c64Cpu.sp = (this.c64Cpu.sp + 1) & 0xff; return this.mem[0x100 + this.c64Cpu.sp]!; }

  private stepInstr(): void {
    const c = this.c64Cpu;
    // hardware interrupt taken before executing the next opcode
    if (this.pendingNmi) { this.pendingNmi = false; this.enterInt(0x3100); return; }
    if (this.pendingIrq) { this.pendingIrq = false; this.enterInt(0x3000); return; }
    const op = this.mem[c.pc]!;
    c.cycles += 2;
    if (op === JSR) {
      const target = this.mem[c.pc + 1]! | (this.mem[c.pc + 2]! << 8);
      const ret = (c.pc + 2) & 0xffff; // 6502: JSR pushes addr of last byte
      this.push(ret >> 8); this.push(ret & 0xff);
      c.pc = target & 0xffff;
    } else if (op === RTS) {
      const lo = this.pull(), hi = this.pull();
      c.pc = (((hi << 8) | lo) + 1) & 0xffff;
    } else if (op === RTI) {
      this.p = this.pull(); const lo = this.pull(), hi = this.pull();
      c.pc = ((hi << 8) | lo) & 0xffff;
    } else if (op === BRK) {
      const ret = (c.pc + 2) & 0xffff;
      this.push(ret >> 8); this.push(ret & 0xff); this.push(this.p | 0x10);
      c.pc = 0x3000;
    } else { // NOP / anything else: 1 byte
      c.pc = (c.pc + 1) & 0xffff;
    }
  }
  private enterInt(vec: number): void {
    const c = this.c64Cpu;
    this.push(c.pc >> 8); this.push(c.pc & 0xff); this.push(this.p & ~0x10);
    c.pc = vec & 0xffff; c.cycles += 7;
  }

  runFor(n: number, opts?: { breakpoints?: Set<number>; cycleBudget?: number }) {
    const bps = opts?.breakpoints;
    let i = 0;
    for (; i < n; i++) {
      if (bps && bps.has(this.c64Cpu.pc & 0xffff)) {
        return { instructionsExecuted: i, lastPc: this.c64Cpu.pc, aborted: "breakpoint" as const };
      }
      this.stepInstr();
    }
    return { instructionsExecuted: i, lastPc: this.c64Cpu.pc };
  }
}

interface Case { name: string; run: () => void; }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// ---- tests ----

test("step into advances one instruction (main flow)", () => {
  const s = new MiniCpu(); s.mem[0x1000] = NOP; s.c64Cpu.pc = 0x1000;
  const ft = new FlowTracker();
  ft.stepInto(s);
  assert.equal(s.c64Cpu.pc, 0x1001);
  assert.equal(ft.currentFlow(), "main");
});

test("step into ENTERS a pending IRQ (VICE-correct)", () => {
  const s = new MiniCpu(); s.mem[0x1000] = NOP; s.c64Cpu.pc = 0x1000; s.pendingIrq = true;
  const ft = new FlowTracker();
  ft.stepInto(s);
  assert.equal(s.c64Cpu.pc, 0x3000, "z lands in the IRQ handler entry");
  assert.equal(ft.currentFlow(), "irq");
});

test("step over a JSR lands after the call", () => {
  const s = new MiniCpu();
  // $1000: JSR $2000 ; $1003: NOP    | $2000: NOP ; $2001: RTS
  s.mem[0x1000] = JSR; s.mem[0x1001] = 0x00; s.mem[0x1002] = 0x20; s.mem[0x1003] = NOP;
  s.mem[0x2000] = NOP; s.mem[0x2001] = RTS;
  s.c64Cpu.pc = 0x1000;
  const ft = new FlowTracker();
  const stop = ft.stepOver(s, new Set());
  assert.equal(stop.reason, "done");
  assert.equal(s.c64Cpu.pc, 0x1003, "n steps over the subroutine to the next instruction");
  assert.equal(ft.currentFlow(), "main");
});

test("step over RUNS THROUGH a pending IRQ and stays in main flow", () => {
  const s = new MiniCpu();
  // main: $1000 NOP ; $1001 NOP    | IRQ handler $3000: NOP ; $3001 RTI
  s.mem[0x1000] = NOP; s.mem[0x1001] = NOP;
  s.mem[0x3000] = NOP; s.mem[0x3001] = RTI;
  s.c64Cpu.pc = 0x1000; s.pendingIrq = true;
  const ft = new FlowTracker();
  const stop = ft.stepOver(s, new Set());
  assert.equal(stop.reason, "done");
  assert.equal(s.c64Cpu.pc, 0x1001, "n ran the IRQ handler to RTI then advanced one main instruction");
  assert.equal(ft.currentFlow(), "main", "not parked in the IRQ handler");
  assert.equal(ft.stack.length, 0, "flow stack balanced (no leaked irq frame)");
});

test("step over stops at a user breakpoint inside the subroutine", () => {
  const s = new MiniCpu();
  s.mem[0x1000] = JSR; s.mem[0x1001] = 0x00; s.mem[0x1002] = 0x20; s.mem[0x1003] = NOP;
  s.mem[0x2000] = NOP; s.mem[0x2001] = NOP; s.mem[0x2002] = RTS;
  s.c64Cpu.pc = 0x1000;
  const ft = new FlowTracker();
  const stop = ft.stepOver(s, new Set([0x2001]));
  assert.equal(stop.reason, "user-bp");
  assert.equal(s.c64Cpu.pc, 0x2001);
});

test("flow stack: stepInto into IRQ then RTI returns to main", () => {
  const s = new MiniCpu();
  s.mem[0x1000] = NOP; s.mem[0x3000] = RTI; s.c64Cpu.pc = 0x1000; s.pendingIrq = true;
  const ft = new FlowTracker();
  ft.stepInto(s); // takes IRQ
  assert.equal(ft.currentFlow(), "irq");
  assert.equal(ft.stack.length, 1);
  ft.stepInto(s); // RTI back to main
  assert.equal(ft.currentFlow(), "main");
  assert.equal(ft.stack.length, 0);
});

test("focus=main: sf runs through a pending IRQ and stops back in main", () => {
  const s = new MiniCpu();
  s.mem[0x1000] = NOP; s.mem[0x1001] = NOP;
  s.mem[0x3000] = NOP; s.mem[0x3001] = RTI;
  s.c64Cpu.pc = 0x1000; s.pendingIrq = true;
  const ft = new FlowTracker(); ft.focus = "main";
  const stop = ft.stepFocus(s, new Set());
  assert.equal(stop.reason, "done");
  assert.equal(ft.currentFlow(), "main", "did not park in the IRQ handler");
  assert.equal(ft.stack.length, 0, "flow stack balanced");
  // The IRQ pre-empted $1000 (it never executed); after running the handler
  // to RTI we're back in main flow at the pre-empted instruction. The next
  // `sf` executes it. (Spec 623 §4.3: stop when again in the selected flow.)
  assert.equal(s.c64Cpu.pc, 0x1000);
  // A second sf now advances one mainline instruction.
  ft.stepFocus(s, new Set());
  assert.equal(s.c64Cpu.pc, 0x1001);
});

test("focus=irq: sf stops inside the IRQ handler", () => {
  const s = new MiniCpu();
  s.mem[0x1000] = NOP; s.mem[0x3000] = NOP; s.mem[0x3001] = RTI;
  s.c64Cpu.pc = 0x1000; s.pendingIrq = true;
  const ft = new FlowTracker(); ft.focus = "irq";
  const stop = ft.stepFocus(s, new Set());
  assert.equal(stop.reason, "done");
  assert.equal(ft.currentFlow(), "irq");
  assert.equal(s.c64Cpu.pc, 0x3000, "stops at the IRQ handler entry");
});

// ---- runner ----
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  ok   ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}`); console.log(`       ${(e as Error).message}`); }
}
console.log(`\nstepping: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
