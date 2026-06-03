// Spec 754 §3.3e — observers: the ONE abstraction that subsumes VICE's
// break / watch / trace(point) / condition / command. An observer is
//   { name, trigger, condition?, action }
// and is evaluated IN the execution path (not run-then-rewind):
//   - exec  triggers are checked at the instruction boundary (runFor),
//   - load/store triggers fire from the CPU bus hook (store()/loadRead()),
// gated by a PER-ADDRESS watch table (user decision 2026-06-03): idle cost is
// zero (the CPU's `accessWatch` is null when no load/store observer is active),
// and an active observer only pays the condition eval on its EXACT address —
// no over-eval on hot pages.
//
// v1 actions: `break` (halt at the trigger) and `log` (print + continue =
// VICE tracepoint). `mark`/`cmd`/`trace <scope>` are v1.1 (they need the
// controller / monitor wired into the registry).

import type { IntegratedSession } from "../integrated-session.js";

export type ObsTrigger = "exec" | "load" | "store";
export type ObsAction = "break" | "log";

/** The minimal CPU surface the registry wires the per-address gate into. */
export interface ObservableCpu {
  accessWatch: Uint8Array | null;
  onObservedAccess: ((kind: "READ" | "WRITE", addr: number, value: number) => void) | null;
}

export interface Observer {
  name: string;
  trigger: ObsTrigger;
  lo: number;
  hi: number;
  condSrc?: string;
  cond?: CondNode;
  action: ObsAction;
  enabled: boolean;
  hits: number;
  ignoreLeft: number;
}

// ---- condition AST + evaluator -----------------------------------------
type CondNode =
  | { t: "num"; v: number }
  | { t: "id"; v: keyof CondEnv }
  | { t: "bin"; op: string; l: CondNode; r: CondNode };

interface CondEnv { a: number; x: number; y: number; pc: number; sp: number; fl: number; rl: number; val: number; addr: number; }
const ID_NAMES: ReadonlySet<string> = new Set(["a", "x", "y", "pc", "sp", "fl", "rl", "val", "addr"]);

function evalNode(n: CondNode, env: CondEnv): number {
  if (n.t === "num") return n.v;
  if (n.t === "id") return env[n.v] ?? 0;
  const l = evalNode(n.l, env), r = evalNode(n.r, env);
  switch (n.op) {
    case "==": return l === r ? 1 : 0;
    case "!=": return l !== r ? 1 : 0;
    case "<": return l < r ? 1 : 0;
    case ">": return l > r ? 1 : 0;
    case "<=": return l <= r ? 1 : 0;
    case ">=": return l >= r ? 1 : 0;
    case "&&": return (l && r) ? 1 : 0;
    case "||": return (l || r) ? 1 : 0;
    default: return 0;
  }
}

/** Tiny recursive-descent parser for the condition grammar. */
function parseCond(src: string): CondNode {
  const toks = src.match(/<=|>=|==|!=|&&|\|\||[<>()]|\$[0-9a-fA-F]+|%[01]+|[0-9]+|[a-zA-Z]+/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  const parsePrimary = (): CondNode => {
    const t = next();
    if (t === undefined) throw new Error("unexpected end of condition");
    if (t === "(") { const e = parseOr(); if (next() !== ")") throw new Error("missing )"); return e; }
    if (/^\$[0-9a-fA-F]+$/.test(t)) return { t: "num", v: parseInt(t.slice(1), 16) };
    if (/^%[01]+$/.test(t)) return { t: "num", v: parseInt(t.slice(1), 2) };
    if (/^[0-9]+$/.test(t)) return { t: "num", v: parseInt(t, 10) };
    const id = t.toLowerCase();
    if (ID_NAMES.has(id)) return { t: "id", v: id as keyof CondEnv };
    throw new Error(`unknown term '${t}' (use a/x/y/pc/sp/fl/rl/val/addr, $hex, == != < > <= >= && ||)`);
  };
  const parseCmp = (): CondNode => {
    let l = parsePrimary();
    while (peek() && ["==", "!=", "<", ">", "<=", ">="].includes(peek()!)) {
      const op = next()!; l = { t: "bin", op, l, r: parsePrimary() };
    }
    return l;
  };
  const parseAnd = (): CondNode => {
    let l = parseCmp();
    while (peek() === "&&") { next(); l = { t: "bin", op: "&&", l, r: parseCmp() }; }
    return l;
  };
  function parseOr(): CondNode {
    let l = parseAnd();
    while (peek() === "||") { next(); l = { t: "bin", op: "||", l, r: parseAnd() }; }
    return l;
  }
  const tree = parseOr();
  if (i < toks.length) throw new Error(`trailing '${toks[i]}' in condition`);
  return tree;
}

// ---- the registry -------------------------------------------------------
export class ObserverRegistry {
  readonly execWatch = new Uint8Array(0x10000);
  readonly accessWatch = new Uint8Array(0x10000);
  execActive = false;
  haltRequested = false;
  lastHalt: { name: string; message: string; pc: number } | null = null;
  readonly logs: string[] = []; // ring of recent `do log` lines
  private observers: Observer[] = [];
  private cpu: ObservableCpu | null = null;

  constructor(private readonly session: IntegratedSession) {}

  attach(cpu: ObservableCpu): void { this.cpu = cpu; this.rebuild(); }

  /** Parse + register an observer. Returns the created observer or an error. */
  add(spec: { name: string; trigger: ObsTrigger; lo: number; hi: number; condSrc?: string; action: ObsAction }): Observer | { error: string } {
    let cond: CondNode | undefined;
    if (spec.condSrc) {
      try { cond = parseCond(spec.condSrc); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    }
    const existing = this.observers.findIndex((o) => o.name === spec.name);
    const obs: Observer = {
      name: spec.name, trigger: spec.trigger, lo: spec.lo & 0xffff, hi: spec.hi & 0xffff,
      condSrc: spec.condSrc, cond, action: spec.action, enabled: true, hits: 0, ignoreLeft: 0,
    };
    if (existing >= 0) this.observers[existing] = obs; else this.observers.push(obs);
    this.rebuild();
    return obs;
  }

  remove(name: string): boolean {
    const n = this.observers.length;
    this.observers = this.observers.filter((o) => o.name !== name);
    if (this.observers.length !== n) { this.rebuild(); return true; }
    return false;
  }
  setEnabled(name: string, on: boolean): boolean {
    const o = this.observers.find((x) => x.name === name);
    if (!o) return false;
    o.enabled = on; this.rebuild(); return true;
  }
  setIgnore(name: string, n: number): boolean {
    const o = this.observers.find((x) => x.name === name);
    if (!o) return false;
    o.ignoreLeft = Math.max(0, n | 0); return true;
  }
  list(): readonly Observer[] { return this.observers; }
  get active(): boolean { return this.observers.some((o) => o.enabled); }

  /** Recompute the per-address watch tables + CPU wiring from the enabled set. */
  private rebuild(): void {
    this.execWatch.fill(0); this.accessWatch.fill(0);
    this.execActive = false;
    let anyAccess = false;
    for (const o of this.observers) {
      if (!o.enabled) continue;
      const tbl = o.trigger === "exec" ? this.execWatch : this.accessWatch;
      for (let a = o.lo; a <= o.hi; a++) tbl[a & 0xffff] = 1;
      if (o.trigger === "exec") this.execActive = true; else anyAccess = true;
    }
    if (this.cpu) {
      // Idle = zero cost: the CPU only pays the `accessWatch[addr]` index when a
      // load/store observer is actually active (else the field is null).
      this.cpu.accessWatch = anyAccess ? this.accessWatch : null;
      this.cpu.onObservedAccess = anyAccess ? (k, a, v) => this.onAccess(k, a, v) : null;
    }
  }

  /**
   * Exec observers — called by runFor BEFORE executing the instruction at pc
   * (gated by execActive + execWatch[pc]). Returns true if a break-action
   * matched → the caller halts with PC at the watched instruction.
   */
  onExec(pc: number): boolean {
    let halt = false;
    for (const o of this.observers) {
      if (!o.enabled || o.trigger !== "exec" || pc < o.lo || pc > o.hi) continue;
      if (!this.matches(o, pc, pc, 0)) continue;
      if (this.fire(o, pc, undefined)) { halt = true; this.lastHalt = { name: o.name, message: `exec $${hx4(pc)}`, pc }; }
    }
    return halt;
  }

  /** Load/store observers — called by the CPU bus hook during an instruction. */
  onAccess(kind: "READ" | "WRITE", addr: number, value: number): void {
    const want: ObsTrigger = kind === "WRITE" ? "store" : "load";
    const pc = this.session.c64Cpu.pc & 0xffff;
    for (const o of this.observers) {
      if (!o.enabled || o.trigger !== want || addr < o.lo || addr > o.hi) continue;
      if (!this.matches(o, pc, addr, value)) continue;
      if (this.fire(o, pc, value, addr)) {
        this.haltRequested = true;
        this.lastHalt = { name: o.name, message: `${want} $${hx4(addr)}=$${hx2(value)}`, pc };
      }
    }
  }

  /** cond + ignore-count gate; bumps hits when it actually triggers. */
  private matches(o: Observer, pc: number, addr: number, value: number): boolean {
    if (o.cond) {
      const c = this.session.c64Cpu;
      const peek = (a: number) => this.session.c64Bus.peek(a & 0xffff, "cpu") & 0xff;
      const rl = (peek(0xd012) | ((peek(0xd011) & 0x80) << 1)) & 0x1ff;
      const env: CondEnv = { a: c.a & 0xff, x: c.x & 0xff, y: c.y & 0xff, pc: pc & 0xffff, sp: c.sp & 0xff, fl: c.flags & 0xff, rl, val: value & 0xff, addr: addr & 0xffff };
      if (evalNode(o.cond, env) === 0) return false;
    }
    if (o.ignoreLeft > 0) { o.ignoreLeft--; return false; }
    o.hits++;
    return true;
  }

  /** Run the action; return true if it requests a halt (break). */
  private fire(o: Observer, pc: number, value?: number, addr?: number): boolean {
    if (o.action === "break") return true;
    // log (= VICE tracepoint): print + continue.
    const where = o.trigger === "exec" ? `exec $${hx4(pc)}` : `${o.trigger} $${hx4(addr ?? 0)}=$${hx2(value ?? 0)}`;
    this.pushLog(`obs ${o.name}: ${where}  pc=$${hx4(pc)} a=$${hx2(this.session.c64Cpu.a)} cyc=${this.session.c64Cpu.cycles}`);
    return false;
  }

  private pushLog(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }
}

const hx2 = (n: number) => (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
const hx4 = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
