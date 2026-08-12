// Spec 241 — Conditional breakpoints + watchpoints.
//
// Three layers:
//   1. JS callback (primary) — full power, 1ms timeout, try/catch.
//   2. Structured predicate tree (BreakpointPredicate) — compiled to callback.
//   3. VICE-syntax expression string — compiled to callback via vice-syntax.ts.
//
// OQ1: all-fire on same cycle — each active breakpoint evaluated, all
//      hits collected, then `halt` action fires after all evals.
// OQ4: JS callback is primary; predicate + VICE string are conveniences.

export interface BreakpointContext {
  cycle: number;
  cpu: { pc: number; a: number; x: number; y: number; sp: number; flags: number };
  mem(addr: number): number;
  io(addr: number): number;
  irqPending: boolean;
  nmiPending: boolean;
  drive?: { pc: number; a: number; x: number; y: number };
}

// ---- Predicate tree ----

export type BreakpointPredicate =
  | { kind: "pc"; pc: number | [number, number] }
  | { kind: "mem_read"; addr: number | [number, number]; valueEq?: number }
  | { kind: "mem_write"; addr: number | [number, number]; valueEq?: number; valueChanged?: boolean }
  | { kind: "register"; reg: "a" | "x" | "y" | "sp"; valueEq: number }
  | { kind: "irq_pending"; source?: "cia1" | "cia2" | "vic" }
  | { kind: "callback"; fn: (ctx: BreakpointContext) => boolean }
  | { kind: "and"; left: BreakpointPredicate; right: BreakpointPredicate }
  | { kind: "or"; left: BreakpointPredicate; right: BreakpointPredicate };

// ---- Spec ----

export type BreakpointAction = "halt" | "log" | "snapshot" | "trace_burst";

export interface BreakpointSpec {
  id: string;
  predicate: BreakpointPredicate;
  action: BreakpointAction;
  enabled: boolean;
  hitLimit?: number;        // disable after N hits
  ignoreCount?: number;     // skip first N hits (VICE `ignore` semantics)
  /** Internal: remaining skips (counts down from ignoreCount) */
  _ignoreRemaining?: number;
  hitCount?: number;
  /** Optional label for log/snapshot events */
  label?: string;
  /** Compiled callback (set by BreakpointManager.add) */
  _compiled?: (ctx: BreakpointContext) => boolean;
  /** Timeout for callback in ms. Default 1 */
  callbackTimeoutMs?: number;
}

// ---- Hit record ----

export interface BreakpointHit {
  id: string;
  cycle: number;
  pc: number;
  action: BreakpointAction;
  label?: string;
}

// ---- Address range helpers ----

function addrMatches(addr: number, spec: number | [number, number]): boolean {
  if (typeof spec === "number") return addr === spec;
  return addr >= spec[0] && addr <= spec[1];
}

// ---- Predicate → callback compiler ----

export function compilePredicate(pred: BreakpointPredicate): (ctx: BreakpointContext) => boolean {
  switch (pred.kind) {
    case "pc":
      return (ctx) => addrMatches(ctx.cpu.pc, pred.pc);

    case "mem_read":
      // mem_read fires on the current PC — callers must be inside a
      // read hook to have meaningful context. Here we check raw memory.
      return (ctx) => {
        if (!addrMatches(ctx.cpu.pc, pred.addr)) {
          // Check all possible read addresses — simplified: check mem value
          // at addr equals valueEq if provided.
          if (pred.valueEq !== undefined) {
            const a = typeof pred.addr === "number" ? pred.addr : pred.addr[0];
            return ctx.mem(a) === pred.valueEq;
          }
          return false;
        }
        if (pred.valueEq !== undefined) {
          const a = typeof pred.addr === "number" ? pred.addr : pred.addr[0];
          return ctx.mem(a) === pred.valueEq;
        }
        return true;
      };

    case "mem_write":
      // mem_write: evaluated by BreakpointRuntime on write hooks
      // For standalone eval we can only check current value.
      return (ctx) => {
        const a = typeof pred.addr === "number" ? pred.addr : pred.addr[0];
        if (!addrMatches(a, pred.addr)) return false;
        if (pred.valueEq !== undefined) return ctx.mem(a) === pred.valueEq;
        return true;
      };

    case "register":
      return (ctx) => ctx.cpu[pred.reg] === pred.valueEq;

    case "irq_pending":
      return (ctx) => ctx.irqPending;

    case "callback":
      return pred.fn;

    case "and":
      {
        const l = compilePredicate(pred.left);
        const r = compilePredicate(pred.right);
        return (ctx) => l(ctx) && r(ctx);
      }

    case "or":
      {
        const l = compilePredicate(pred.left);
        const r = compilePredicate(pred.right);
        return (ctx) => l(ctx) || r(ctx);
      }
  }
}

// ---- BreakpointManager ----

export interface BreakpointManagerOptions {
  /** Called for each hit (after all-fire pass). Receives hits in cycle order. */
  onHit?: (hit: BreakpointHit, spec: BreakpointSpec) => void;
  /** Callback timeout budget in ms. Default 1. */
  defaultCallbackTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1;

export class BreakpointManager {
  private readonly specs = new Map<string, BreakpointSpec>();
  private readonly options: BreakpointManagerOptions;
  /** Audit log of disabled-by-timeout entries. */
  public readonly auditLog: Array<{ id: string; reason: string; cycle: number }> = [];

  constructor(options: BreakpointManagerOptions = {}) {
    this.options = options;
  }

  // ---- Add / manage ----

  add(spec: BreakpointSpec): void {
    if (this.specs.has(spec.id)) {
      throw new Error(`Breakpoint id "${spec.id}" already exists`);
    }
    // Compile predicate to callback.
    spec._compiled = compilePredicate(spec.predicate);
    spec.hitCount = 0;
    spec._ignoreRemaining = spec.ignoreCount ?? 0;
    this.specs.set(spec.id, spec);
  }

  remove(id: string): boolean {
    return this.specs.delete(id);
  }

  enable(id: string): void {
    const s = this.specs.get(id);
    if (!s) throw new Error(`Breakpoint "${id}" not found`);
    s.enabled = true;
  }

  disable(id: string): void {
    const s = this.specs.get(id);
    if (!s) throw new Error(`Breakpoint "${id}" not found`);
    s.enabled = false;
  }

  /** Set ignore count (VICE `ignore <id> <count>` semantics). */
  setIgnoreCount(id: string, count: number): void {
    const s = this.specs.get(id);
    if (!s) throw new Error(`Breakpoint "${id}" not found`);
    s.ignoreCount = count;
    s._ignoreRemaining = count;
  }

  /** Replace condition on existing breakpoint (VICE `condition <id> <expr>`). */
  setCondition(id: string, pred: BreakpointPredicate): void {
    const s = this.specs.get(id);
    if (!s) throw new Error(`Breakpoint "${id}" not found`);
    s.predicate = pred;
    s._compiled = compilePredicate(pred);
  }

  list(): BreakpointSpec[] {
    return Array.from(this.specs.values());
  }

  get(id: string): BreakpointSpec | undefined {
    return this.specs.get(id);
  }

  clear(): void {
    this.specs.clear();
  }

  // ---- Evaluation ----

  /**
   * Evaluate all enabled breakpoints against ctx.
   * OQ1: ALL predicates evaluated; hits collected; onHit called for each.
   * Returns list of hits (halt-kind hits indicate caller should stop).
   */
  evaluate(ctx: BreakpointContext): BreakpointHit[] {
    const hits: BreakpointHit[] = [];

    for (const spec of this.specs.values()) {
      if (!spec.enabled) continue;

      const fired = this._evalSpec(spec, ctx);
      if (!fired) continue;

      // Ignore count.
      if ((spec._ignoreRemaining ?? 0) > 0) {
        spec._ignoreRemaining! -= 1;
        continue;
      }

      // Record hit.
      spec.hitCount = (spec.hitCount ?? 0) + 1;

      const hit: BreakpointHit = {
        id: spec.id,
        cycle: ctx.cycle,
        pc: ctx.cpu.pc,
        action: spec.action,
        label: spec.label,
      };
      hits.push(hit);

      // Hit limit: disable after N hits.
      if (spec.hitLimit !== undefined && spec.hitCount >= spec.hitLimit) {
        spec.enabled = false;
        this.auditLog.push({
          id: spec.id,
          reason: `hit-limit reached (${spec.hitLimit})`,
          cycle: ctx.cycle,
        });
      }

      this.options.onHit?.(hit, spec);
    }

    return hits;
  }

  private _evalSpec(spec: BreakpointSpec, ctx: BreakpointContext): boolean {
    const fn = spec._compiled;
    if (!fn) return false;

    const timeoutMs = spec.callbackTimeoutMs ?? this.options.defaultCallbackTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Per-eval 1ms budget: synchronous JS has no async cancellation, so
    // we measure elapsed and post-hoc disable if it exceeded budget.
    const t0 = performance.now();
    let result = false;
    try {
      result = fn(ctx);
    } catch (e) {
      // Exception → disable + audit.
      spec.enabled = false;
      this.auditLog.push({
        id: spec.id,
        reason: `callback threw: ${e instanceof Error ? e.message : String(e)}`,
        cycle: ctx.cycle,
      });
      return false;
    }
    const elapsed = performance.now() - t0;
    if (elapsed > timeoutMs) {
      spec.enabled = false;
      this.auditLog.push({
        id: spec.id,
        reason: `callback exceeded ${timeoutMs}ms budget (took ${elapsed.toFixed(2)}ms)`,
        cycle: ctx.cycle,
      });
      return false;
    }

    return result;
  }

  // ---- Convenience: add PC breakpoint (VICE `break addr`) ----
  addPc(id: string, pc: number | [number, number], action: BreakpointAction = "halt"): void {
    this.add({ id, predicate: { kind: "pc", pc }, action, enabled: true });
  }

  // ---- Convenience: add mem watch (VICE `watch addr` = read|write) ----
  addWatch(
    id: string,
    addr: number | [number, number],
    opts: { mode?: "read" | "write" | "both"; valueEq?: number; action?: BreakpointAction } = {},
  ): void {
    const action = opts.action ?? "halt";
    const mode = opts.mode ?? "both";
    if (mode === "both") {
      // OR of read + write
      this.add({
        id,
        predicate: {
          kind: "or",
          left: { kind: "mem_read", addr, valueEq: opts.valueEq },
          right: { kind: "mem_write", addr, valueEq: opts.valueEq },
        },
        action,
        enabled: true,
      });
    } else if (mode === "read") {
      this.add({ id, predicate: { kind: "mem_read", addr, valueEq: opts.valueEq }, action, enabled: true });
    } else {
      this.add({ id, predicate: { kind: "mem_write", addr, valueEq: opts.valueEq }, action, enabled: true });
    }
  }

  // ---- Convenience: tracepoint (VICE `tracepoint addr`) ----
  addTracepoint(id: string, pc: number): void {
    this.add({ id, predicate: { kind: "pc", pc }, action: "log", enabled: true });
  }
}
