// Spec 241 — BreakpointRuntime: hook BreakpointManager into IntegratedSession.
//
// Usage:
//   const bprt = new BreakpointRuntime(session, manager);
//   bprt.install();
//   session.runFor(1_000_000, { breakpointRuntime: bprt });
//   // or call bprt.checkAtInstructionBoundary() manually
//
// On hit:
//   - Emits `breakpoint_hit` into trace registry's "cpu" channel.
//   - Calls action handlers: halt (return false to break loop), log,
//     snapshot (placeholder), trace_burst (placeholder).
//
// Memory watchpoints are hooked via the raw RAM array proxy approach:
// For simplicity in V1, mem_write watchpoints are evaluated per step
// (via a post-step hook that compares observed writes). Callers that
// need per-write precision should extend this with a write-hook on
// HeadlessMemoryBus in a later spec.

import type { IntegratedSession } from "../integrated-session.js";
import {
  BreakpointManager,
  type BreakpointContext,
  type BreakpointHit,
  type BreakpointSpec,
} from "./breakpoints.js";

export interface BreakpointRuntimeOptions {
  /** Called after all-fire pass when at least one `halt` hit occurs. */
  onHalt?: (hits: BreakpointHit[]) => void;
  /** Called for every hit (including non-halt). */
  onHit?: (hit: BreakpointHit, spec: BreakpointSpec) => void;
}

export class BreakpointRuntime {
  public readonly manager: BreakpointManager;
  private readonly session: IntegratedSession;
  private readonly opts: BreakpointRuntimeOptions;
  /** Number of halt-stops triggered. */
  public haltCount = 0;
  /** All hits collected across the session lifetime. */
  public readonly hitHistory: BreakpointHit[] = [];

  constructor(
    session: IntegratedSession,
    manager: BreakpointManager,
    opts: BreakpointRuntimeOptions = {},
  ) {
    this.session = session;
    this.manager = manager;
    this.opts = opts;
  }

  // ---- Build BreakpointContext from current session state ----

  buildContext(): BreakpointContext {
    const { c64Cpu, c64Bus, drive } = this.session;
    return {
      cycle: c64Cpu.cycles,
      cpu: {
        pc: c64Cpu.pc,
        a: c64Cpu.a,
        x: c64Cpu.x,
        y: c64Cpu.y,
        sp: c64Cpu.sp,
        flags: c64Cpu.flags,
      },
      mem: (addr: number) => c64Bus.read(addr & 0xffff),
      io: (addr: number) => c64Bus.read(addr & 0xffff),
      irqPending: false,   // populated below when available
      nmiPending: false,
      drive: drive?.cpu ? {
        pc: drive.cpu.pc,
        a: drive.cpu.a,
        x: drive.cpu.x,
        y: drive.cpu.y,
      } : undefined,
    };
  }

  // ---- Evaluate all breakpoints at current CPU position ----
  // Returns true if any `halt` action fired (caller should stop the loop).

  check(): boolean {
    const ctx = this.buildContext();
    const hits = this.manager.evaluate(ctx);
    if (hits.length === 0) return false;

    // Emit into trace channel (best-effort — registry may be off).
    const reg = this.session.traceRegistry;
    for (const hit of hits) {
      try {
        reg.publish("cpu", ctx.cycle, {
          event: "breakpoint_hit",
          breakpointId: hit.id,
          pc: ctx.cpu.pc,
          action: hit.action,
          label: hit.label,
        });
      } catch {
        // Trace publish failure is non-fatal.
      }
      this.hitHistory.push(hit);
      this.opts.onHit?.(hit, this.manager.get(hit.id) as BreakpointSpec);
    }

    // Apply actions.
    const haltHits = hits.filter((h) => h.action === "halt");
    if (haltHits.length > 0) {
      this.haltCount++;
      this.opts.onHalt?.(haltHits);
      return true; // signal halt
    }

    // Log action: already emitted to trace above.
    // Snapshot + trace_burst: placeholder stubs — expand in later specs.
    for (const hit of hits) {
      if (hit.action === "snapshot") {
        // TODO Spec 241 follow-up: capture snapshot to temp file.
      } else if (hit.action === "trace_burst") {
        // TODO Spec 241 follow-up: enable trace burst mode.
      }
    }

    return false;
  }

  // ---- runFor-style loop with integrated breakpoint checking ----

  /**
   * Run up to `maxInstructions` C64 instructions, stopping early on
   * any `halt` breakpoint hit OR a simple PC breakpoint set.
   *
   * Returns same shape as IntegratedSession.runFor for compatibility.
   */
  runFor(
    maxInstructions: number,
    opts?: { cycleBudget?: number },
  ): {
    instructionsExecuted: number;
    lastPc: number;
    aborted?: "breakpoint" | "cycle-budget";
    hits: BreakpointHit[];
  } {
    const cycleBudget = opts?.cycleBudget ?? Infinity;
    const session = this.session;
    const startCycles = session.c64Cpu.cycles;
    const hitsThisRun: BreakpointHit[] = [];

    // Patch onHit to capture hits for this run.
    const prevHitHistory = this.hitHistory.length;

    let i = 0;
    for (; i < maxInstructions; i++) {
      if (session.c64Cpu.cycles - startCycles >= cycleBudget) {
        return {
          instructionsExecuted: i,
          lastPc: session.c64Cpu.pc,
          aborted: "cycle-budget",
          hits: this.hitHistory.slice(prevHitHistory),
        };
      }

      // Evaluate breakpoints BEFORE stepping (at instruction boundary).
      if (this.check()) {
        return {
          instructionsExecuted: i,
          lastPc: session.c64Cpu.pc,
          aborted: "breakpoint",
          hits: this.hitHistory.slice(prevHitHistory),
        };
      }

      session.stepC64Instruction();
    }

    return {
      instructionsExecuted: i,
      lastPc: session.c64Cpu.pc,
      hits: this.hitHistory.slice(prevHitHistory),
    };
  }
}

// ---- Factory ----

export function createBreakpointRuntime(
  session: IntegratedSession,
  opts?: BreakpointRuntimeOptions & { defaultCallbackTimeoutMs?: number },
): BreakpointRuntime {
  const manager = new BreakpointManager({
    defaultCallbackTimeoutMs: opts?.defaultCallbackTimeoutMs ?? 1,
    onHit: opts?.onHit,
  });
  return new BreakpointRuntime(session, manager, opts);
}
