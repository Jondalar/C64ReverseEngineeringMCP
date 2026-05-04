// Spec 103 (M2.1) — CPU cycle + interrupt fidelity tests.
//
// v1 covers:
//   M2.1c — IRQ entry cycle delta (7 cycles), NMI entry, NMI-during-IRQ
//   M2.1d — BRK / RTI / JSR / RTS stack-ordering byte-by-byte
//   (M2.1a/b already covered by scripts/cpu-equivalence.mjs)
//
// Deferred per spec fallback path:
//   M2.1e RDY/stall — moves to Spec 105 / M2.3 (VIC fidelity), opt-in flag
//   M2.1f cpu_bus trace channel — existing eof-trace.ts covers most;
//                                  extension is a follow-up.
//   Lorenz suite — license-blocked; existing 1880-case opcode harness
//                  + this file's IRQ/stack fixtures form the substitute.

import { Cpu6510Cycled } from "../cpu/cpu6510-cycled.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- Tracing memory: 64K RAM with read/write log ----

interface TracingMemory {
  read(a: number): number;
  write(a: number, v: number): void;
  trace: { kind: "r" | "w"; addr: number; value: number }[];
  ram: Uint8Array;
}

function makeRam(): TracingMemory {
  const ram = new Uint8Array(0x10000);
  const trace: { kind: "r" | "w"; addr: number; value: number }[] = [];
  return {
    read(a: number): number {
      const v = ram[a & 0xffff]!;
      trace.push({ kind: "r", addr: a & 0xffff, value: v });
      return v;
    },
    write(a: number, v: number): void {
      const vv = v & 0xff;
      ram[a & 0xffff] = vv;
      trace.push({ kind: "w", addr: a & 0xffff, value: vv });
    },
    trace, ram,
  };
}

function runUntilBoundary(cpu: Cpu6510Cycled, maxCycles = 50): number {
  let cycles = 0;
  do {
    cpu.executeCycle();
    cycles++;
    if (cycles >= maxCycles) break;
  } while (!cpu.isAtInstructionBoundary());
  return cycles;
}

// --- M2.1c — IRQ entry: 7 cycles, vector $FFFE/$FFFF ---

export function runIrqEntryCycleTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const mem = makeRam();
  // IRQ vector → $0400.
  mem.ram[0xfffe] = 0x00;
  mem.ram[0xffff] = 0x04;
  // Pre-load NOP at $0200 (current PC).
  mem.ram[0x0200] = 0xea;
  // Handler at $0400: RTI.
  mem.ram[0x0400] = 0x40;
  const cpu = new Cpu6510Cycled(mem);
  cpu.reset(0x0200);
  cpu.flags = 0x20; // I clear, allow IRQ
  cpu.sp = 0xff;
  cpu.irqLine = true;

  const cyclesBefore = cpu.cycles;
  const cycles = runUntilBoundary(cpu, 20);
  const elapsed = cpu.cycles - cyclesBefore;

  out.push(check("IRQ entry takes 7 cycles", elapsed === 7, `got=${elapsed}`));
  out.push(check("PC = IRQ vector $0400 after entry", cpu.pc === 0x0400, `pc=$${cpu.pc.toString(16)}`));
  out.push(check("I flag set after IRQ entry", (cpu.flags & 0x04) !== 0, `flags=$${cpu.flags.toString(16)}`));
  // Stack: PCH at $01ff, PCL at $01fe, P at $01fd. PC pushed = next-instr addr = $0200.
  out.push(check("stack[0x1ff] = PCH ($02)", mem.ram[0x01ff] === 0x02, `got=$${mem.ram[0x01ff]!.toString(16)}`));
  out.push(check("stack[0x1fe] = PCL ($00)", mem.ram[0x01fe] === 0x00, `got=$${mem.ram[0x01fe]!.toString(16)}`));
  // P pushed has B clear for IRQ (vs BRK which sets B).
  const pushedFlags = mem.ram[0x01fd]!;
  out.push(check("pushed P has B clear (IRQ, not BRK)", (pushedFlags & 0x10) === 0, `pushed=$${pushedFlags.toString(16)}`));
  out.push(check("SP decremented by 3", cpu.sp === 0xfc, `sp=$${cpu.sp.toString(16)}`));
  void cycles;

  return out;
}

// --- M2.1c — NMI entry: 7 cycles, vector $FFFA/$FFFB ---

export function runNmiEntryCycleTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const mem = makeRam();
  // NMI vector → $0500.
  mem.ram[0xfffa] = 0x00;
  mem.ram[0xfffb] = 0x05;
  mem.ram[0x0200] = 0xea;
  mem.ram[0x0500] = 0x40; // RTI
  const cpu = new Cpu6510Cycled(mem);
  cpu.reset(0x0200);
  cpu.flags = 0x24; // I set: should NOT block NMI
  cpu.sp = 0xff;
  cpu.nmiLine = true;
  // NMI is edge-triggered: prevNmi=false → see edge on first
  // executeCycle. Trigger by toggling line via field if needed; the
  // microcoded core compares `nmiLine && !prevNmi`.
  const cyclesBefore = cpu.cycles;
  const cycles = runUntilBoundary(cpu, 20);
  const elapsed = cpu.cycles - cyclesBefore;

  out.push(check("NMI entry takes 7 cycles", elapsed === 7, `got=${elapsed}`));
  out.push(check("PC = NMI vector $0500 after entry", cpu.pc === 0x0500, `pc=$${cpu.pc.toString(16)}`));
  out.push(check("I flag set after NMI entry", (cpu.flags & 0x04) !== 0, `flags=$${cpu.flags.toString(16)}`));
  out.push(check("NMI even with I=1 (edge-triggered, not maskable)",
    cpu.pc === 0x0500));
  void cycles;

  return out;
}

// --- M2.1d — BRK stack ordering: PC+2 / flags-with-B ---

export function runBrkStackOrderingTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const mem = makeRam();
  // BRK vector → $0600.
  mem.ram[0xfffe] = 0x00;
  mem.ram[0xffff] = 0x06;
  // BRK at $0200, padding byte at $0201, RTI at $0600.
  mem.ram[0x0200] = 0x00; // BRK
  mem.ram[0x0201] = 0xea; // pad
  mem.ram[0x0600] = 0x40; // RTI
  const cpu = new Cpu6510Cycled(mem);
  cpu.reset(0x0200);
  cpu.flags = 0x20;
  cpu.sp = 0xff;

  const cyclesBefore = cpu.cycles;
  runUntilBoundary(cpu, 20);
  const elapsed = cpu.cycles - cyclesBefore;

  out.push(check("BRK takes 7 cycles", elapsed === 7, `got=${elapsed}`));
  out.push(check("BRK PC = vector $0600", cpu.pc === 0x0600));
  // BRK pushes PC+2 (skips the padding byte after the BRK opcode).
  out.push(check("BRK stack[0x1ff] = PCH ($02)", mem.ram[0x01ff] === 0x02));
  out.push(check("BRK stack[0x1fe] = PCL ($02) — PC+2 not PC+1",
    mem.ram[0x01fe] === 0x02, `got=$${mem.ram[0x01fe]!.toString(16)}`));
  // Pushed flags have B set (signals BRK vs IRQ).
  const pushedFlags = mem.ram[0x01fd]!;
  out.push(check("BRK pushed P has B set",
    (pushedFlags & 0x10) !== 0, `pushed=$${pushedFlags.toString(16)}`));
  // CPU's own B flag should be cleared after push (real 6502 quirk).
  out.push(check("CPU register B flag cleared after push",
    (cpu.flags & 0x10) === 0, `flags=$${cpu.flags.toString(16)}`));

  return out;
}

// --- M2.1d — RTI restores flags + PC, no PC adjustment ---

export function runRtiStackPullTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const mem = makeRam();
  // Pre-fill stack with: P=$24 at $1fd, PCL=$22 at $1fe, PCH=$03 at $1ff
  mem.ram[0x01fd] = 0x24;
  mem.ram[0x01fe] = 0x22;
  mem.ram[0x01ff] = 0x03;
  // RTI at $0200.
  mem.ram[0x0200] = 0x40;
  // NOP at $0322 (return target).
  mem.ram[0x0322] = 0xea;
  const cpu = new Cpu6510Cycled(mem);
  cpu.reset(0x0200);
  cpu.sp = 0xfc; // about to pop three

  const cyclesBefore = cpu.cycles;
  runUntilBoundary(cpu, 20);
  const elapsed = cpu.cycles - cyclesBefore;

  out.push(check("RTI takes 6 cycles", elapsed === 6, `got=${elapsed}`));
  out.push(check("RTI PC = $0322 (popped, no +1)", cpu.pc === 0x0322, `pc=$${cpu.pc.toString(16)}`));
  out.push(check("RTI restored flags = $24 (B + unused masked)",
    (cpu.flags & 0xcf) === (0x24 & 0xcf),
    `flags=$${cpu.flags.toString(16)}`));
  out.push(check("RTI SP = $ff (popped 3)", cpu.sp === 0xff, `sp=$${cpu.sp.toString(16)}`));

  return out;
}

// --- M2.1d — JSR pushes PC-1, RTS pops + adds 1 ---

export function runJsrRtsRoundTripTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const mem = makeRam();
  // Layout: $0200: JSR $0500 ; $0203: NOP ; $0500: RTS
  mem.ram[0x0200] = 0x20;
  mem.ram[0x0201] = 0x00;
  mem.ram[0x0202] = 0x05;
  mem.ram[0x0203] = 0xea; // NOP target after RTS
  mem.ram[0x0500] = 0x60; // RTS
  const cpu = new Cpu6510Cycled(mem);
  cpu.reset(0x0200);
  cpu.sp = 0xff;

  // Run JSR.
  let cycles = runUntilBoundary(cpu, 20);
  out.push(check("JSR takes 6 cycles", cycles === 6, `got=${cycles}`));
  out.push(check("JSR PC = $0500 (target)", cpu.pc === 0x0500, `pc=$${cpu.pc.toString(16)}`));
  out.push(check("JSR pushed PCH ($02) at $1ff", mem.ram[0x01ff] === 0x02));
  // JSR pushes PC-1 = $0202 (last byte of JSR instr), so PCL = $02.
  out.push(check("JSR pushed PCL ($02) at $1fe — PC-1 convention",
    mem.ram[0x01fe] === 0x02, `got=$${mem.ram[0x01fe]!.toString(16)}`));
  out.push(check("JSR SP decremented by 2", cpu.sp === 0xfd, `sp=$${cpu.sp.toString(16)}`));

  // Run RTS.
  cycles = runUntilBoundary(cpu, 20);
  out.push(check("RTS takes 6 cycles", cycles === 6, `got=${cycles}`));
  out.push(check("RTS PC = $0203 (popped+1, falls through to NOP)",
    cpu.pc === 0x0203, `pc=$${cpu.pc.toString(16)}`));
  out.push(check("RTS SP = $ff (popped 2)", cpu.sp === 0xff, `sp=$${cpu.sp.toString(16)}`));

  return out;
}

// --- M2.1c — NMI takes priority over IRQ ---

export function runNmiOverIrqPriorityTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const mem = makeRam();
  mem.ram[0xfffa] = 0x00; mem.ram[0xfffb] = 0x05; // NMI → $0500
  mem.ram[0xfffe] = 0x00; mem.ram[0xffff] = 0x04; // IRQ → $0400
  mem.ram[0x0200] = 0xea;
  mem.ram[0x0400] = 0x40; // RTI
  mem.ram[0x0500] = 0x40; // RTI
  const cpu = new Cpu6510Cycled(mem);
  cpu.reset(0x0200);
  cpu.flags = 0x20; // I clear
  cpu.sp = 0xff;
  cpu.nmiLine = true;
  cpu.irqLine = true;

  runUntilBoundary(cpu, 20);
  out.push(check("NMI wins when both pending: PC = $0500",
    cpu.pc === 0x0500, `pc=$${cpu.pc.toString(16)}`));
  out.push(check("IRQ stays pending (irqLine still true)",
    cpu.irqLine === true));

  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllCpuFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M2.1c IRQ entry (7 cyc)",        runner: runIrqEntryCycleTest },
    { name: "M2.1c NMI entry (7 cyc)",        runner: runNmiEntryCycleTest },
    { name: "M2.1c NMI > IRQ priority",        runner: runNmiOverIrqPriorityTest },
    { name: "M2.1d BRK stack ordering",        runner: runBrkStackOrderingTest },
    { name: "M2.1d RTI stack pull",            runner: runRtiStackPullTest },
    { name: "M2.1d JSR/RTS round-trip",        runner: runJsrRtsRoundTripTest },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
