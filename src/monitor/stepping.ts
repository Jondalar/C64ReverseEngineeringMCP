// Spec 623 §4.2 + §4.3 — interrupt-aware stepping + C64RE flow-focus.
//
// VICE model (src/monitor/monitor.c mon_instructions_step/next/return +
// monitor_check_icount / monitor_check_icount_interrupt):
//
//   - `z`/step  = true step-into. One instruction. If an IRQ/NMI is accepted
//                 before the next main-flow opcode, z enters the interrupt
//                 path. Correct, not suppressed.
//   - `n`/next  = step-over. NOT "break at PC+len". VICE keeps a
//                 wait_for_return_level: a JSR or an accepted IRQ/NMI is a
//                 NESTED flow that must return (RTS/RTI) before the monitor
//                 stops in the caller flow again. So `n` from main runs
//                 THROUGH an IRQ and stops back in main flow.
//   - `ret`     = run until the current frame returns via RTS/RTI.
//
// VICE's CPU core calls monitor_check_icount(pc) at each instruction boundary
// and monitor_check_icount_interrupt() when an IRQ/NMI is accepted. Our
// runFor(1) advances exactly one instruction OR one interrupt-entry (the
// entry lands at the handler with atBoundary=true; the first handler opcode
// is NOT folded in — verified against cpu65xx-vice.serviceInterrupt). So we
// reconstruct the same events by classifying each single step from the
// stack-pointer delta + the opcode that was at the pre-step PC:
//
//   op==BRK ($00)            → interrupt entry, flow=brk   (SP-3)
//   op==JSR ($20)            → call                         (SP-2)
//   op==RTS ($60)            → return                       (SP+2)
//   op==RTI ($40)            → interrupt return             (SP+3)
//   else SP dropped by 3     → hardware IRQ/NMI pre-empted op (op not run);
//                              flow = nmi if PC landed on the $FFFA vector,
//                              else irq
//   else                     → normal main-flow instruction
//
// No 6502 instruction pushes exactly 3 bytes except BRK and the hardware
// interrupt sequence, so the SP-3/op!=BRK test is an unambiguous interrupt
// detector. §4.3 adds an optional flow-focus layer (focus main|irq|nmi|brk +
// `sf`/`nf`) so a debugging session can keep its stepping context on one
// control-flow path across periodic raster IRQs.

export type CpuFlowKind = "main" | "irq" | "nmi" | "brk" | "trap";
export type FocusMode = "auto" | CpuFlowKind | "none";

export interface CpuRegs { a: number; x: number; y: number; sp: number; p: number; }

export interface CpuFlowFrame {
  kind: CpuFlowKind;
  enteredAtPc: number;
  enteredAtCycle: number;
  stackSpAtEntry: number;
  returnPc?: number;
  regs?: CpuRegs; // register snapshot at the moment the flow was entered
}

// Minimal session surface the engine needs (keeps it decoupled + testable).
export interface SteppableSession {
  c64Cpu: { pc: number; sp: number; cycles: number; a: number; x: number; y: number; flags: number };
  c64Bus: { read(a: number): number };
  runFor(n: number, opts?: { breakpoints?: Set<number>; cycleBudget?: number }):
    { instructionsExecuted: number; lastPc: number; aborted?: string };
}

const OP_BRK = 0x00, OP_JSR = 0x20, OP_RTI = 0x40, OP_RTS = 0x60;

// Bound on single-stepping while skipping a nested flow (a non-returning
// subroutine = VICE's "n runs forever"; we stop and report instead).
const SKIP_CAP = 5_000_000;
// Safety budget for flow-focus re-entry (Spec 623 §4.3 focus-timeout).
const FOCUS_CAP = 5_000_000;

type StepEventType = "normal" | "jsr" | "rts" | "rti" | "int";
export interface StepResult {
  ev: StepEventType;
  flow?: CpuFlowKind;   // set when ev === "int"
  pc0: number; op0: number; pc1: number; sp0: number; sp1: number; cyc: number;
  cycleAbs: number; regs: CpuRegs; // post-step absolute cycle + register snapshot
}

/** Advance exactly one instruction (or one interrupt entry) and classify it. */
export function stepOne(s: SteppableSession): StepResult {
  const pc0 = s.c64Cpu.pc & 0xffff;
  const sp0 = s.c64Cpu.sp & 0xff;
  const op0 = s.c64Bus.read(pc0) & 0xff;
  const cyc0 = s.c64Cpu.cycles;
  s.runFor(1);
  const pc1 = s.c64Cpu.pc & 0xffff;
  const sp1 = s.c64Cpu.sp & 0xff;
  const cycleAbs = s.c64Cpu.cycles;
  const regs: CpuRegs = { a: s.c64Cpu.a & 0xff, x: s.c64Cpu.x & 0xff, y: s.c64Cpu.y & 0xff, sp: sp1, p: s.c64Cpu.flags & 0xff };
  const pushed = (sp0 - sp1) & 0xff;

  let ev: StepEventType;
  let flow: CpuFlowKind | undefined;
  if (op0 === OP_BRK) { ev = "int"; flow = "brk"; }
  else if (op0 === OP_JSR) { ev = "jsr"; }
  else if (op0 === OP_RTS) { ev = "rts"; }
  else if (op0 === OP_RTI) { ev = "rti"; }
  else if (pushed === 3) {
    // A hardware IRQ/NMI was accepted instead of executing op0.
    const nmiVec = (s.c64Bus.read(0xfffa) | (s.c64Bus.read(0xfffb) << 8)) & 0xffff;
    flow = (pc1 === nmiVec) ? "nmi" : "irq";
    ev = "int";
  } else ev = "normal";
  return { ev, flow, pc0, op0, pc1, sp0, sp1, cyc: cycleAbs - cyc0, cycleAbs, regs };
}

export type StepStop =
  | { reason: "done"; pc: number; cyc: number }
  | { reason: "user-bp"; pc: number; cyc: number }
  | { reason: "cap"; pc: number; cyc: number }
  | { reason: "focus-timeout"; pc: number; cyc: number; flow: CpuFlowKind };

/**
 * Run at full speed until execution returns to `retAddr` at stack level
 * >= `targetSp` (the matching RTS/RTI), or a user breakpoint inside the
 * skipped flow is hit. Used to skip a JSR subroutine or run through an
 * interrupt handler. Interrupts that fire inside the skipped flow are
 * naturally run through (no breakpoint there) and balance out on RTI.
 */
function runUntilReturn(
  s: SteppableSession, retAddr: number, targetSp: number, userBps: Set<number>,
): StepStop {
  const bps = new Set(userBps); bps.add(retAddr & 0xffff);
  let guard = 0;
  while (guard++ < 10000) {
    const r = s.runFor(SKIP_CAP, { breakpoints: bps });
    const pc = s.c64Cpu.pc & 0xffff;
    const cyc = s.c64Cpu.cycles;
    if (r.aborted !== "breakpoint") return { reason: "cap", pc, cyc };
    if (pc === (retAddr & 0xffff)) {
      if ((s.c64Cpu.sp & 0xff) >= targetSp) return { reason: "done", pc, cyc };
      s.runFor(1); // recursion: same return addr at a deeper level — step past
      continue;
    }
    if (userBps.has(pc)) return { reason: "user-bp", pc, cyc };
    s.runFor(1); // some other stop — nudge past and keep going
  }
  return { reason: "cap", pc: s.c64Cpu.pc & 0xffff, cyc: s.c64Cpu.cycles };
}

/**
 * Per-session control-flow tracker. Maintains the interrupt/trap frame stack
 * (Spec 623 §4.3) so flow-focus stepping knows whether execution is currently
 * in main / irq / nmi / brk flow. The frame stack is precise while stepping;
 * a cold break from free-run defaults to `main` (best-effort, documented).
 */
export class FlowTracker {
  stack: CpuFlowFrame[] = [];
  focus: FocusMode = "auto";

  currentFlow(): CpuFlowKind {
    return this.stack.length ? this.stack[this.stack.length - 1]!.kind : "main";
  }

  /** Resolve the focus the next focus-step should target. */
  effectiveFocus(): CpuFlowKind {
    return this.focus === "auto" || this.focus === "none" ? this.currentFlow() : this.focus;
  }

  reset(): void { this.stack = []; }

  private apply(r: StepResult): void {
    if (r.ev === "int") {
      this.stack.push({
        kind: r.flow!, enteredAtPc: r.pc1, enteredAtCycle: r.cycleAbs,
        stackSpAtEntry: r.sp0, returnPc: r.pc0, regs: r.regs,
      });
    } else if (r.ev === "rti") {
      if (this.stack.length) this.stack.pop();
    }
    // jsr/rts/normal don't change the interrupt-flow kind (call depth is
    // tracked structurally via runUntilReturn, not the flow stack).
  }

  /** Snapshot of the flow context for the UI (Spec 623 §4.3 focus panel). */
  flowState(): {
    focus: FocusMode; current: CpuFlowKind;
    stack: Array<{ kind: CpuFlowKind; pc: number; returnPc: number; cycle: number; regs?: CpuRegs }>;
  } {
    return {
      focus: this.focus,
      current: this.currentFlow(),
      // pc = handler-entry PC; returnPc = where the INTERRUPTED level resumes;
      // regs = the interrupted level's registers at the moment it was suspended
      // (the IRQ/NMI sequence leaves A/X/Y untouched, so this snapshot is the
      // parent flow's A/X/Y; PC+P came off the stack).
      stack: this.stack.map((f) => ({
        kind: f.kind, pc: f.enteredAtPc, returnPc: f.returnPc ?? f.enteredAtPc,
        cycle: f.enteredAtCycle, regs: f.regs,
      })),
    };
  }

  // ---- VICE-compatible commands (§4.2) ----

  /** `z` / step — exactly one instruction; may enter an IRQ/NMI. */
  stepInto(s: SteppableSession): StepStop {
    const r = stepOne(s); this.apply(r);
    return { reason: "done", pc: s.c64Cpu.pc & 0xffff, cyc: r.cyc };
  }

  /**
   * `n` / next — advance exactly one instruction of the CURRENT flow, treating
   * a JSR subroutine and any accepted IRQ/NMI as nested flow to run through.
   */
  stepOver(s: SteppableSession, userBps: Set<number>): StepStop {
    let guard = 0;
    while (guard++ < 64) { // bounded retries; each interrupt costs one retry
      const pc0 = s.c64Cpu.pc & 0xffff;
      const sp0 = s.c64Cpu.sp & 0xff;
      const r = stepOne(s);
      // JSR + interrupt-skip both run a NESTED flow via runUntilReturn, which
      // balances entry+exit on its own — so the flow stack must NOT record
      // them here (apply would push a frame whose RTS/RTI is consumed inside
      // runUntilReturn and never popped). Only apply for single instructions.
      if (r.ev === "jsr") {
        const stop = runUntilReturn(s, (pc0 + 3) & 0xffff, sp0, userBps);
        if (stop.reason === "user-bp") return stop;
        return { reason: "done", pc: s.c64Cpu.pc & 0xffff, cyc: r.cyc };
      }
      if (r.ev === "int") {
        // An interrupt pre-empted the instruction at pc0; run the handler to
        // RTI (back to pc0 at sp0), then retry the original instruction.
        const stop = runUntilReturn(s, pc0, sp0, userBps);
        if (stop.reason === "user-bp") { this.apply(r); return stop; } // stopped inside handler
        continue;
      }
      // normal / rts / rti — one current-flow instruction completed.
      this.apply(r);
      return { reason: "done", pc: s.c64Cpu.pc & 0xffff, cyc: r.cyc };
    }
    return { reason: "cap", pc: s.c64Cpu.pc & 0xffff, cyc: 0 };
  }

  /** `ret` / return — run until the current frame returns via RTS/RTI. */
  runReturn(s: SteppableSession, userBps: Set<number>): StepStop {
    const sp0 = s.c64Cpu.sp & 0xff;
    let guard = 0;
    while (guard++ < SKIP_CAP) {
      const r = stepOne(s); this.apply(r);
      const pc = s.c64Cpu.pc & 0xffff;
      if (userBps.has(pc)) return { reason: "user-bp", pc, cyc: r.cyc };
      if ((r.ev === "rts" || r.ev === "rti") && (r.sp1 & 0xff) > sp0) {
        return { reason: "done", pc, cyc: r.cyc };
      }
    }
    return { reason: "cap", pc: s.c64Cpu.pc & 0xffff, cyc: 0 };
  }

  // ---- C64RE flow-focus extension (§4.3) ----

  /** `sf` / stepf — step into, stopping only when back in the target flow. */
  stepFocus(s: SteppableSession, userBps: Set<number>, target?: CpuFlowKind): StepStop {
    const want = target ?? this.effectiveFocus();
    let guard = 0;
    while (guard++ < FOCUS_CAP) {
      const r = stepOne(s); this.apply(r);
      const pc = s.c64Cpu.pc & 0xffff;
      if (userBps.has(pc)) return { reason: "user-bp", pc, cyc: r.cyc };
      if (this.currentFlow() === want) return { reason: "done", pc, cyc: r.cyc };
    }
    return { reason: "focus-timeout", pc: s.c64Cpu.pc & 0xffff, cyc: 0, flow: this.currentFlow() };
  }

  /** `nf` / nextf — step over calls + foreign flows, stop in target flow. */
  nextFocus(s: SteppableSession, userBps: Set<number>, target?: CpuFlowKind): StepStop {
    const want = target ?? this.effectiveFocus();
    let guard = 0;
    while (guard++ < FOCUS_CAP) {
      const pc0 = s.c64Cpu.pc & 0xffff;
      const sp0 = s.c64Cpu.sp & 0xff;
      const r = stepOne(s); this.apply(r);
      if (r.ev === "jsr") {
        const stop = runUntilReturn(s, (pc0 + 3) & 0xffff, sp0, userBps);
        if (stop.reason === "user-bp") return stop;
      }
      const pc = s.c64Cpu.pc & 0xffff;
      if (userBps.has(pc)) return { reason: "user-bp", pc, cyc: r.cyc };
      if (this.currentFlow() === want) return { reason: "done", pc, cyc: r.cyc };
    }
    return { reason: "focus-timeout", pc: s.c64Cpu.pc & 0xffff, cyc: 0, flow: this.currentFlow() };
  }
}
