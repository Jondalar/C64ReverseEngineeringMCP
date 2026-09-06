// Spec 821 — the runtime producer: one `.c64retrace` → rows with origin=runtime.
//
// 821 D2  one row per (pc, effective address, access, run); the row IS the
//         observation — count, first/last cycle, mutations, the first 8 values
// 821 D3  a runtime observation CONFIRMS. It is a new row beside the static one;
//         nothing in this file can write origin ≠ runtime / confidence ≠ observed
//         (the option that tries is refused by name) or touch an existing row
// 821 D4  the binary log is read through the ONE streaming reader
//         (`streamCaptureEvents`) — no DuckDB, no daemon, bounded memory
// 821 D5  bank context is reconstructed from the run's own writes to $01 / $DD00 /
//         the cart bank register and stamped `inferred` until the run wrote it
// 821 D6  a run is a node — `<slug>:sub:run-<id>` — and the replacement unit
//         (store `run_owner` = the run id): the same file twice is one set of rows
// 821 D7  interrupt entries → HANDLES_IRQ / HANDLES_NMI from the run node
//
// Read off the producer (`../TRX64/crates/trx64-trace/src/lib.rs`) and both local
// captures before a line was written — three facts a naive reader gets wrong:
//   - a bus record's `pc` is the CPU's LIVE pc at the access, already past the
//     operand bytes: `sta $D016` at $FD0F carries pc=$FD12. The retiring CPU_STEP
//     FOLLOWS the accesses it made, at the same cycle. So accesses are buffered and
//     attributed to the NEXT CPU_STEP; the bus pc is a fallback for a capture with
//     no cpu domain, and is labelled as such.
//   - every C64 bus access arrives as op 0x11 (RAM_WRITE), the I/O window included;
//     IO_WRITE (0x12) has no live producer. Classification is by ADDRESS.
//   - opcode/operand fetches are not on the bus lane; pointer fetches ARE — a
//     `lda ($20),y` shows as reads of $20, $21 and the effective address.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { FlowKind } from "../../analysis/flow-focus.js";
import { disasm6502, type AddressingMode } from "../../monitor/disasm6502.js";
import { PlatformKb, type PlatformNode } from "../../platform-kb/read.js";
import { ACCESS_WRITE, TraceOp, type DecodedEvent } from "../../trace/binary-format.js";
import { streamCaptureEvents, type CaptureHeader } from "../../trace/capture-stream.js";
import { deriveProjectId, deriveSubsystemId, IdRuleError, type Ctx } from "../ids.js";
import { GraphStore, readProjectSlug, type EdgeInput, type NodeInput } from "../store.js";

export const RUNTIME_PRODUCER = "821";
const ORIGIN = "runtime" as const;
const CONFIDENCE = "observed" as const;
/** Edge types this producer writes. READS/WRITES/USES_* are 820's types with a different origin. */
export const RUNTIME_EDGE_TYPES = ["READS", "WRITES", "USES_ZP", "USES_HARDWARE", "HANDLES_IRQ", "HANDLES_NMI", "EXECUTES"] as const;
/** Static access types whose presence at a pc means "the static side saw this instruction" (D3). */
const STATIC_ACCESS_TYPES = ["READS", "WRITES", "READS_INDIRECT", "WRITES_INDIRECT", "USES_ZP", "USES_HARDWARE", "REFERENCES_DATA"];

const MAX_VALUES = 8;
const DEFAULT_MAX_ROWS_PER_PC = 4096;
/** An instruction makes at most a handful of accesses (an interrupt entry adds 3 pushes);
 *  more than this without a retiring step means the cpu domain is missing mid-stream. */
const PENDING_FLUSH = 64;

export interface ImportRuntimeTraceOptions {
  projectDir: string;
  tracePath: string;
  /** default: `TraceFileMeta.runId` from the file header */
  runId?: string;
  /** artifact stem whose routines win when several contain a pc; also scopes the static-edge check */
  owner?: string;
  /** context for the `addr` nodes this run creates; default `{ space: "ram" }` */
  ctx?: Ctx;
  slug?: string;
  platformDb?: string;
  /** the `_analysis.json` of the image the run executed — enables the opcode-mismatch check (D2) */
  analysisPath?: string;
  /** the NMI handler address ($FFFA/$FFFB) when the image states one (D7) */
  nmiVector?: number;
  /** the cart bank register the project's cart type names (EasyFlash: $DE00) — D5 */
  cartBankRegister?: number;
  /** OQ1 — distinct effective addresses one pc keeps as rows before it collapses into spans */
  maxRowsPerPc?: number;
  /** D3 — accepted only as "runtime"; anything else is refused, by name. */
  origin?: string;
  /** D3 — accepted only as "observed"; anything else is refused, by name. */
  confidence?: string;
}

export interface ImportRuntimeTraceResult {
  runId: string;
  runNodeId: string;
  slug: string;
  tracePath: string;
  traceBytes: number;
  formatVersion: number;
  eventCount: number;
  cpuSteps: number;
  accesses: number;
  distinctPcs: number;
  cycleStart: number;
  cycleEnd: number;
  /** "retire" = attributed to the retiring CPU_STEP; "bus" = the bus record's live pc (no cpu domain) */
  pcSource: "retire" | "bus" | "mixed";
  rows: Record<(typeof RUNTIME_EDGE_TYPES)[number] | "collapsedSpans", number>;
  addrNodes: number;
  /** pcs no routine contains — attached to an addr node, nothing dropped */
  unattributedPcs: number;
  notes: { opcodeMismatch: number; noStaticEdge: number };
  /** the static access rows the D3 check could see (0 = no static access producer has run; the note is then not written) */
  staticAccessEdges: number;
  irqEntries: number;
  nmiEntries: number;
  collapsedPcs: number;
  marks: string[];
  ms: number;
  peakRssMb: number;
}

// ------------------------------------------------------------------ flow lane
// The FlowTracker classification of `src/analysis/flow-focus.ts` (`deriveFlow`),
// replayed incrementally so a 118 M-step firehose is never materialized (D4).
// Same rules, same limitation: an NMI taken from main flow with no vector hint
// reads as `irq`.

const OP_BRK = 0x00, OP_JSR = 0x20, OP_PLP = 0x28, OP_RTI = 0x40, OP_PHA = 0x48, OP_RTS = 0x60, OP_PLA = 0x68, OP_PHP = 0x08, OP_TXS = 0x9a;

function stackEffect(op: number): number {
  switch (op) {
    case OP_PHA: case OP_PHP: return -1;
    case OP_PLA: case OP_PLP: return +1;
    case OP_JSR: return -2;
    case OP_RTS: return +2;
    case OP_RTI: return +3;
    case OP_BRK: return -3;
    default: return 0;
  }
}

class FlowTracker {
  private readonly stack: FlowKind[] = [];
  private prevSp: number | undefined;
  constructor(private readonly nmiVector: number | undefined) {}

  private current(): FlowKind {
    return this.stack.length ? this.stack[this.stack.length - 1]! : "main";
  }

  /** The lane this step runs in; `entry` is set when a hardware/BRK entry preceded it. */
  step(pc: number, opcode: number, sp: number): { lane: FlowKind; entry?: FlowKind } {
    const op = opcode & 0xff;
    let entry: FlowKind | undefined;
    if (this.prevSp !== undefined && op !== OP_TXS && op !== OP_BRK) {
      const delta = (this.prevSp + stackEffect(op) - (sp & 0xff)) & 0xff;
      if (delta === 3) {
        const isNmi = (this.nmiVector !== undefined && (pc & 0xffff) === (this.nmiVector & 0xffff)) || this.current() !== "main";
        entry = isNmi ? "nmi" : "irq";
        this.stack.push(entry);
      }
    }
    if (op === OP_BRK) { entry = "irq"; this.stack.push("irq"); }
    const lane = this.current();
    if (op === OP_RTI && this.stack.length) this.stack.pop();
    this.prevSp = sp & 0xff;
    return { lane, entry };
  }
}

// ------------------------------------------------------------------ bank lens (D5)

type Lens = "ram" | "rom" | "io" | "chr";

/** What the CPU sees at `ea` under `$01` — the PLA's LORAM/HIRAM/CHAREN rules, reads and writes apart. */
function lensFor(ea: number, p01: number, write: boolean): Lens {
  const lo = p01 & 3;
  if (ea >= 0xe000) return !write && (p01 & 2) ? "rom" : "ram";
  if (ea >= 0xd000) {
    if (lo === 0) return "ram";
    if (p01 & 4) return "io";
    return write ? "ram" : "chr";
  }
  if (ea >= 0xa000 && ea <= 0xbfff) return !write && lo === 3 ? "rom" : "ram";
  return "ram";
}

const hex2 = (n: number) => (n & 0xff).toString(16).padStart(2, "0");
const hex4 = (n: number) => (n & 0xffff).toString(16).padStart(4, "0");

// ------------------------------------------------------------------ the fold

interface Obs {
  pc: number;
  ea: number;
  write: boolean;
  count: number;
  first: number;
  last: number;
  mutations: number;
  values: number[];
  flow: FlowKind;
  flows?: Partial<Record<FlowKind, number>>;
  bankCtx: string;
  bankConf: "observed" | "inferred";
  bankVariants?: Set<string>;
  lens: Lens;
  opcode: number;
  b1: number;
  b2: number;
  viaZp?: number;
  /** an access the instruction implies rather than names: the static side has no edge for it by construction (820 OQ2) */
  role?: "pointer" | "vector" | "interrupt-push" | "stack";
  pcSource: "retire" | "bus";
}

/** OQ1 — a pc past `maxRowsPerPc` distinct addresses keeps counts per address, not rows. */
interface Collapsed {
  pc: number;
  write: boolean;
  counts: Uint32Array; // per ea
  distinct: number;
  count: number;
  first: number;
  last: number;
  mutations: number;
  values: number[];
  flow: FlowKind;
  bankCtx: string;
  bankConf: "observed" | "inferred";
  p01: number;
  opcode: number;
  b1: number;
  b2: number;
  viaZp?: number;
  pcSource: "retire" | "bus";
}

interface Access { cycle: number; addr: number; value: number; busPc: number; write: boolean; oldValue?: number }

interface Step { pc: number; opcode: number; b1: number; b2: number; x: number; lane: FlowKind; entry?: FlowKind; cycle: number }

interface Instr { address: number; opcode: number }

function indirectShape(mode: AddressingMode, b1: number, b2: number, x: number): { pointer: [number, number]; viaZp?: number; role: "pointer" | "vector" } | undefined {
  if (mode === "(zp),y") return { pointer: [b1, (b1 + 1) & 0xff], viaZp: b1, role: "pointer" };
  if (mode === "(zp,x)") { const base = (b1 + x) & 0xff; return { pointer: [base, (base + 1) & 0xff], viaZp: base, role: "pointer" }; }
  if (mode === "ind") { const v = b1 | (b2 << 8); return { pointer: [v, (v & 0xff00) | ((v + 1) & 0xff)], role: "vector" }; }
  return undefined;
}

function pushValue(values: number[], v: number): void {
  if (values.length < MAX_VALUES && !values.includes(v)) values.push(v);
}

// ------------------------------------------------------------------ the importer

export function importRuntimeTrace(options: ImportRuntimeTraceOptions): ImportRuntimeTraceResult {
  const t0 = process.hrtime.bigint();
  // D3 — refused by name, before anything is read.
  if (options.origin !== undefined && options.origin !== ORIGIN) {
    throw new IdRuleError("runtime-origin", `a runtime import writes origin="${ORIGIN}" only — "${options.origin}" refused (821 D3: runtime confirms, never promotes)`);
  }
  if (options.confidence !== undefined && options.confidence !== CONFIDENCE) {
    throw new IdRuleError("runtime-confidence", `a runtime import writes confidence="${CONFIDENCE}" only — "${options.confidence}" refused (821 D3)`);
  }
  const tracePath = resolve(options.tracePath);
  if (!existsSync(tracePath)) throw new Error(`no capture at ${tracePath}`);
  const slug = options.slug ?? readProjectSlug(options.projectDir);
  const ctx: Ctx = options.ctx ?? { space: "ram" };
  const maxRowsPerPc = Math.max(16, options.maxRowsPerPc ?? DEFAULT_MAX_ROWS_PER_PC);
  let peakRss = process.memoryUsage().rss;
  const rss = () => { const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; };

  let platform: PlatformKb | undefined;
  try { platform = new PlatformKb(options.platformDb); } catch { platform = undefined; }

  // ---- the static side this run confirms: routines (819) and the pcs that have static access rows (820)
  const store = GraphStore.open(options.projectDir);
  interface RoutineRow { id: string; owner: string | null; address: number; end_address: number | null }
  const routinesByPage = new Map<number, RoutineRow[]>();
  const staticPcs = new Set<number>();
  let staticAccessEdges = 0;
  try {
    const routines = store.db.prepare("SELECT DISTINCT id, owner, address, end_address FROM nodes WHERE kind = 'routine' ORDER BY address, id").all() as unknown as RoutineRow[];
    for (const r of routines) {
      const end = r.end_address ?? r.address;
      for (let page = r.address >> 8; page <= end >> 8; page += 1) {
        const list = routinesByPage.get(page) ?? [];
        list.push(r);
        routinesByPage.set(page, list);
      }
    }
    const placeholders = STATIC_ACCESS_TYPES.map(() => "?").join(",");
    const rows = store.db.prepare(
      `SELECT evidence, owner FROM edges WHERE layer = 'generated' AND origin = 'static' AND type IN (${placeholders})`,
    ).all(...STATIC_ACCESS_TYPES) as unknown as Array<{ evidence: string; owner: string | null }>;
    for (const row of rows) {
      if (options.owner !== undefined && row.owner !== null && row.owner !== options.owner) continue;
      staticAccessEdges += 1;
      const ev = JSON.parse(row.evidence) as Record<string, unknown>;
      const pc = typeof ev.pc === "number" ? ev.pc : typeof ev.source_address === "number" ? ev.source_address : undefined;
      if (pc !== undefined) staticPcs.add(pc & 0xffff);
    }
  } catch (error) {
    store.close();
    throw error;
  }

  // ---- the static instruction at a pc, for the opcode-mismatch check (D2)
  const staticOpcode = new Map<number, number>();
  if (options.analysisPath) {
    const report = JSON.parse(readFileSync(resolve(options.analysisPath), "utf8")) as {
      codeAnalysis?: { instructions?: Instr[] };
      probableCodeAnalysis?: { instructions?: Instr[] };
    };
    for (const i of report.codeAnalysis?.instructions ?? []) staticOpcode.set(i.address, i.opcode);
    for (const i of report.probableCodeAnalysis?.instructions ?? []) if (!staticOpcode.has(i.address)) staticOpcode.set(i.address, i.opcode);
  }

  const routineOf = (() => {
    const cache = new Map<number, string | undefined>();
    return (pc: number): string | undefined => {
      if (cache.has(pc)) return cache.get(pc);
      let best: RoutineRow | undefined;
      for (const r of routinesByPage.get(pc >> 8) ?? []) {
        if (pc < r.address || pc > (r.end_address ?? r.address)) continue;
        if (!best) { best = r; continue; }
        const ownerHit = (x: RoutineRow) => options.owner !== undefined && x.owner === options.owner;
        if (ownerHit(r) && !ownerHit(best)) best = r;
        else if (ownerHit(r) === ownerHit(best) && r.address > best.address) best = r; // innermost
      }
      const id = best?.id;
      cache.set(pc, id);
      return id;
    };
  })();

  // ---- stream the capture (D4): fold as the events go past, keep nothing else
  const obs = new Map<number, Obs>();
  const perPc = new Map<number, number>(); // (pc<<1|w) → distinct eas kept as rows
  const collapsed = new Map<number, Collapsed>();
  const pending: Access[] = [];
  const irq = new Map<number, { flow: FlowKind; count: number; first: number; last: number }>();
  const exec = new Map<string, { steps: number; first: number; last: number; pcs: Set<number> }>();
  const pcsSeen = new Set<number>();
  const marks: string[] = [];
  const cartBanks = new Set<number>();
  let header: CaptureHeader | undefined;
  let cpuSteps = 0;
  let accesses = 0;
  let cycleMin = Number.POSITIVE_INFINITY;
  let cycleMax = Number.NEGATIVE_INFINITY;
  let busFallbacks = 0;
  let retireAttributions = 0;
  const flow = new FlowTracker(options.nmiVector);
  // D5 — the reconstruction: pre-run defaults, inferred until the run writes them.
  let p01 = 0x37, p01Observed = false;
  let dd00 = 0x97;
  let cart: number | undefined;
  const bankCtx = () => `01=${hex2(p01)} dd00=${hex2(dd00)} cart=${cart === undefined ? "-" : hex2(cart)}`;

  const fold = (a: Access, step: Step | undefined): void => {
    const pc = step ? step.pc : a.busPc;
    const pcSource: "retire" | "bus" = step ? "retire" : "bus";
    const lane: FlowKind = step ? step.lane : "main";
    const lens = lensFor(a.addr, p01, a.write);
    const ctxNow = bankCtx();
    const conf = p01Observed ? "observed" : "inferred";
    let viaZp: number | undefined;
    let role: Obs["role"];
    let opcode = -1, b1 = 0, b2 = 0;
    if (step) {
      opcode = step.opcode; b1 = step.b1; b2 = step.b2;
      const d = disasm6502((addr) => (addr === pc ? step.opcode : addr === ((pc + 1) & 0xffff) ? step.b1 : step.b2), pc);
      const shape = indirectShape(d.mode, step.b1, step.b2, step.x);
      if (shape) {
        if (!a.write && (a.addr === shape.pointer[0] || a.addr === shape.pointer[1])) role = shape.role;
        else viaZp = shape.viaZp;
      }
      if (a.addr >= 0x0100 && a.addr <= 0x01ff) {
        if (step.entry && a.write) role = "interrupt-push";
        else if (d.mode === "impl" || step.opcode === OP_JSR) role = "stack"; // rts/rti/pha/pla/php/plp/brk pops+pushes, jsr's return address
      }
    }
    const w = a.write ? 1 : 0;
    const pcKey = (pc << 1) | w;
    const mutated = a.write && a.oldValue !== undefined && a.oldValue !== a.value ? 1 : 0;

    // A pointer fetch / vector fetch / interrupt push is at most two addresses per pc
    // and is a different fact from the data access it serves: never collapsed with it.
    const c = role ? undefined : collapsed.get(pcKey);
    if (c) {
      if (c.counts[a.addr] === 0) c.distinct += 1;
      c.counts[a.addr] += 1;
      c.count += 1;
      c.last = a.cycle;
      c.mutations += mutated;
      pushValue(c.values, a.value);
      return;
    }
    const key = (pc * 65536 + a.addr) * 2 + w;
    const o = obs.get(key);
    if (o) {
      o.count += 1;
      o.last = a.cycle;
      o.mutations += mutated;
      pushValue(o.values, a.value);
      if (o.flow !== lane) { o.flows ??= { [o.flow]: o.count - 1 }; o.flows[lane] = (o.flows[lane] ?? 0) + 1; }
      else if (o.flows) o.flows[lane] = (o.flows[lane] ?? 0) + 1;
      if (o.bankCtx !== ctxNow) { o.bankVariants ??= new Set([o.bankCtx]); o.bankVariants.add(ctxNow); }
      return;
    }
    const n = role ? 0 : (perPc.get(pcKey) ?? 0) + 1;
    if (!role) perPc.set(pcKey, n);
    if (n > maxRowsPerPc) {
      // OQ1 — this pc is a copy/fill loop: fold what it has into per-address counts and go on counting.
      const cc: Collapsed = {
        pc, write: a.write, counts: new Uint32Array(65536), distinct: 0, count: 0, first: a.cycle, last: a.cycle, mutations: 0, values: [],
        flow: lane, bankCtx: ctxNow, bankConf: conf, p01, opcode, b1, b2, viaZp, pcSource,
      };
      for (const [k, x] of obs) {
        if (x.pc !== pc || x.write !== a.write || x.role) continue;
        if (cc.counts[x.ea] === 0) cc.distinct += 1;
        cc.counts[x.ea] += x.count;
        cc.count += x.count;
        cc.first = Math.min(cc.first, x.first);
        cc.last = Math.max(cc.last, x.last);
        cc.mutations += x.mutations;
        for (const v of x.values) pushValue(cc.values, v);
        obs.delete(k);
      }
      cc.distinct += 1;
      cc.counts[a.addr] += 1;
      cc.count += 1;
      cc.mutations += mutated;
      pushValue(cc.values, a.value);
      collapsed.set(pcKey, cc);
      return;
    }
    obs.set(key, {
      pc, ea: a.addr, write: a.write, count: 1, first: a.cycle, last: a.cycle, mutations: mutated, values: [a.value],
      flow: lane, bankCtx: ctxNow, bankConf: conf, lens, opcode, b1, b2, viaZp, role, pcSource,
    });
  };

  const applyBankWrite = (a: Access): void => {
    if (!a.write) return;
    if (a.addr === 0x0001) { p01 = a.value; p01Observed = true; }
    else if (a.addr === 0xdd00) dd00 = a.value;
    else if (options.cartBankRegister !== undefined && a.addr === options.cartBankRegister) cart = a.value;
  };

  const flushPending = (step: Step | undefined): void => {
    for (const a of pending) {
      fold(a, step);
      applyBankWrite(a); // the access itself is recorded under the context it was made in
      if (step) retireAttributions += 1; else busFallbacks += 1;
    }
    pending.length = 0;
  };

  let stream: ReturnType<typeof streamCaptureEvents> | undefined;
  try {
    stream = streamCaptureEvents(tracePath, (ev: DecodedEvent) => {
      if (ev.cycle < cycleMin) cycleMin = ev.cycle;
      if (ev.cycle > cycleMax) cycleMax = ev.cycle;
      switch (ev.op) {
        case TraceOp.CPU_STEP: {
          cpuSteps += 1;
          const pc = ev.pc! & 0xffff;
          const r = flow.step(pc, ev.opcode!, ev.sp!);
          const step: Step = { pc, opcode: ev.opcode! & 0xff, b1: ev.b1! & 0xff, b2: ev.b2! & 0xff, x: ev.x! & 0xff, lane: r.lane, entry: r.entry, cycle: ev.cycle };
          if (r.entry) {
            const e = irq.get(pc);
            if (e) { e.count += 1; e.last = ev.cycle; } else irq.set(pc, { flow: r.entry, count: 1, first: ev.cycle, last: ev.cycle });
          }
          pcsSeen.add(pc);
          const rid = routineOf(pc);
          if (rid) {
            const x = exec.get(rid);
            if (x) { x.steps += 1; x.last = ev.cycle; x.pcs.add(pc); } else exec.set(rid, { steps: 1, first: ev.cycle, last: ev.cycle, pcs: new Set([pc]) });
          }
          flushPending(step);
          if ((cpuSteps & 0xfffff) === 0) rss();
          return;
        }
        case TraceOp.RAM_WRITE:
        case TraceOp.IO_WRITE: {
          accesses += 1;
          pending.push({ cycle: ev.cycle, addr: ev.addr! & 0xffff, value: ev.value! & 0xff, busPc: ev.pc! & 0xffff, write: (ev.access! & 1) === ACCESS_WRITE, oldValue: ev.oldValue });
          if (pending.length >= PENDING_FLUSH) flushPending(undefined); // no cpu domain (or a gap in it): the bus pc is what there is
          return;
        }
        case TraceOp.MARK: {
          if (marks.length < 32 && ev.label !== undefined) marks.push(ev.label);
          return;
        }
        case TraceOp.CART_READ: {
          if (ev.bank !== undefined) cartBanks.add(ev.bank);
          return;
        }
        default:
          return; // drive-side and VIC/SID/IEC lanes: not attributable to a C64 pc (§7)
      }
    }, (h) => { header = h; });
    flushPending(undefined);
  } catch (error) {
    store.close();
    platform?.close();
    throw error;
  }
  rss();
  if (!stream || !header) { store.close(); platform?.close(); throw new Error(`${tracePath}: no header decoded`); }
  const meta = header.meta;
  const runId = options.runId ?? meta.runId;
  if (!runId) { store.close(); platform?.close(); throw new Error(`${tracePath}: the header names no runId and none was given`); }
  const runName = `run-${runId.toLowerCase().replace(/[^a-z0-9_.\-]+/gu, "-")}`;
  const runNodeId = deriveSubsystemId(slug, runName);

  // ---- from ids: the routine containing pc, else the shared addr node (D2 / 820 D4)
  const nodes: NodeInput[] = [];
  const nodeIds = new Set<string>();
  const addrCtx = (a: number): Ctx => (ctx.space === "crt" && ctx.bank !== undefined && a >= 0x8000 && a <= 0xbfff ? { space: "crt", bank: ctx.bank } : { space: "ram" });
  const addrNode = (a: number): string => {
    const id = deriveProjectId({ slug, ctx: addrCtx(a), kind: "addr", address: a });
    if (!nodeIds.has(id)) {
      nodeIds.add(id);
      nodes.push({ id, kind: "addr", name: null, attrs: {}, origin: ORIGIN, confidence: CONFIDENCE, evidence: [{ run_id: runId }] });
    }
    return id;
  };
  const kbCache = new Map<number, PlatformNode | undefined>();
  const kbNode = (a: number): PlatformNode | undefined => {
    if (!platform) return undefined;
    if (!kbCache.has(a)) kbCache.set(a, platform.node("c64", a));
    return kbCache.get(a);
  };
  /** The node an effective address lands on: the platform node when the platform file has one
   *  OF THE KIND THE LENS SHOWS (a RAM read under BASIC ROM is not `c64:rom:a000`), else the addr node. */
  const targetOf = (ea: number, lens: Lens): string => {
    const n = kbNode(ea);
    if (n) {
      const want: string[] = lens === "io" ? ["io"] : lens === "rom" ? ["rom"] : ["zp", "ram"];
      if (want.includes(n.kind)) return n.id;
    }
    return addrNode(ea);
  };
  const unattributed = new Set<number>();
  let opcodeMismatch = 0;
  let noStaticEdge = 0;
  const fromOf = (pc: number, opcode: number, implicit = false): { from: string; note?: string } => {
    const rid = routineOf(pc);
    const notes: string[] = [];
    if (opcode >= 0 && staticOpcode.size > 0) {
      const so = staticOpcode.get(pc);
      if (so !== undefined && so !== opcode) notes.push("opcode mismatch");
    }
    // an implied stack access has no static edge by construction — not a miss
    if (staticAccessEdges > 0 && !implicit && !staticPcs.has(pc)) notes.push("no static edge");
    if (notes.includes("opcode mismatch")) opcodeMismatch += 1;
    if (notes.includes("no static edge")) noStaticEdge += 1;
    if (rid && !notes.includes("opcode mismatch")) return { from: rid, note: notes[0] };
    unattributed.add(pc);
    return { from: addrNode(pc), note: notes[0] };
  };

  // ---- edges
  const edges: EdgeInput[] = [];
  const counts: ImportRuntimeTraceResult["rows"] = { READS: 0, WRITES: 0, USES_ZP: 0, USES_HARDWARE: 0, HANDLES_IRQ: 0, HANDLES_NMI: 0, EXECUTES: 0, collapsedSpans: 0 };
  const evKey = (pc: number) => `run:${runId}:pc:${hex4(pc)}`;
  const uses = new Map<string, { from: string; type: "USES_ZP" | "USES_HARDWARE"; to: string; pc: number; ea: number; reads: number; writes: number; first: number; last: number; flow: FlowKind; bankCtx: string; bankConf: string; note?: string }>();
  const noteUses = (from: string, type: "USES_ZP" | "USES_HARDWARE", to: string, o: { pc: number; ea: number; write: boolean; count: number; first: number; last: number; flow: FlowKind; bankCtx: string; bankConf: string }, note?: string) => {
    const k = `${from}|${type}|${to}|${o.pc}`;
    const u = uses.get(k);
    if (u) {
      if (o.write) u.writes += o.count; else u.reads += o.count;
      u.first = Math.min(u.first, o.first);
      u.last = Math.max(u.last, o.last);
    } else uses.set(k, { from, type, to, pc: o.pc, ea: o.ea, reads: o.write ? 0 : o.count, writes: o.write ? o.count : 0, first: o.first, last: o.last, flow: o.flow, bankCtx: o.bankCtx, bankConf: o.bankConf, note });
  };
  const instrOf = (pc: number, opcode: number, b1: number, b2: number): { mnemonic?: string; addr_mode?: string } => {
    if (opcode < 0) return {};
    const d = disasm6502((addr) => (addr === pc ? opcode : addr === ((pc + 1) & 0xffff) ? b1 : b2), pc);
    return { mnemonic: d.mnemonic, addr_mode: d.mode };
  };

  const sortedObs = [...obs.values()].sort((a, b) => a.pc - b.pc || a.ea - b.ea || Number(a.write) - Number(b.write));
  for (const o of sortedObs) {
    const { from, note } = fromOf(o.pc, o.opcode, o.role === "stack" || o.role === "interrupt-push");
    const to = targetOf(o.ea, o.lens);
    const type = o.write ? "WRITES" : "READS";
    const evidence: Record<string, unknown> = {
      pc: o.pc, ea: o.ea, run_id: runId, count: o.count, first_cycle: o.first, last_cycle: o.last, mutations: o.mutations, values: o.values,
      flow: o.flow, bank_ctx: o.bankCtx, bank_ctx_conf: o.bankConf, lens: o.lens, pc_source: o.pcSource, ...instrOf(o.pc, o.opcode, o.b1, o.b2),
    };
    if (o.opcode >= 0) evidence.opcode = o.opcode;
    if (o.flows) evidence.flow_counts = o.flows;
    if (o.bankVariants) evidence.bank_ctx_variants = [...o.bankVariants].sort();
    if (o.viaZp !== undefined) evidence.via_zp = o.viaZp;
    if (o.role) evidence.role = o.role;
    if (note) evidence.note = note;
    edges.push({ from, type, to, evidenceKey: evKey(o.pc), origin: ORIGIN, confidence: CONFIDENCE, evidence });
    counts[type] += 1;
    if (o.ea < 0x100) noteUses(from, "USES_ZP", to, o, note);
    else if (o.lens === "io") noteUses(from, "USES_HARDWARE", to, o, note);
  }
  // OQ1 — collapsed pcs: one row per contiguous span, to the span's first address
  for (const c of [...collapsed.values()].sort((a, b) => a.pc - b.pc || Number(a.write) - Number(b.write))) {
    const { from, note } = fromOf(c.pc, c.opcode);
    const type = c.write ? "WRITES" : "READS";
    let start = -1;
    let spanCount = 0;
    const flush = (end: number) => {
      const lens = lensFor(start, c.p01, c.write);
      const evidence: Record<string, unknown> = {
        pc: c.pc, ea: start, span_end: end, distinct: end - start + 1, run_id: runId, count: spanCount, first_cycle: c.first, last_cycle: c.last,
        mutations: c.mutations, values: c.values, flow: c.flow, bank_ctx: c.bankCtx, bank_ctx_conf: c.bankConf, pc_source: c.pcSource,
        note: note ? `${note}; collapsed` : "collapsed", ...instrOf(c.pc, c.opcode, c.b1, c.b2),
      };
      if (c.opcode >= 0) evidence.opcode = c.opcode;
      if (c.viaZp !== undefined) evidence.via_zp = c.viaZp;
      edges.push({ from, type, to: targetOf(start, lens), evidenceKey: evKey(c.pc), origin: ORIGIN, confidence: CONFIDENCE, evidence });
      counts[type] += 1;
      counts.collapsedSpans += 1;
    };
    for (let a = 0; a <= 0x10000; a += 1) {
      const hit = a < 0x10000 && c.counts[a]! > 0;
      if (hit && start < 0) { start = a; spanCount = 0; }
      if (hit) spanCount += c.counts[a]!;
      if (!hit && start >= 0) { flush(a - 1); start = -1; }
    }
  }
  for (const u of [...uses.values()].sort((a, b) => a.pc - b.pc || a.ea - b.ea)) {
    const evidence: Record<string, unknown> = {
      pc: u.pc, ea: u.ea, run_id: runId, count: u.reads + u.writes, reads: u.reads, writes: u.writes, first_cycle: u.first, last_cycle: u.last,
      flow: u.flow, bank_ctx: u.bankCtx, bank_ctx_conf: u.bankConf, derived_from: "READS+WRITES",
    };
    if (u.note) evidence.note = u.note;
    edges.push({ from: u.from, type: u.type, to: u.to, evidenceKey: evKey(u.pc), origin: ORIGIN, confidence: CONFIDENCE, evidence });
    counts[u.type] += 1;
  }
  // D7 — interrupt entries, from the run node to the handler
  let irqEntries = 0;
  let nmiEntries = 0;
  for (const [pc, e] of [...irq.entries()].sort((a, b) => a[0] - b[0])) {
    const type = e.flow === "nmi" ? "HANDLES_NMI" : "HANDLES_IRQ";
    if (e.flow === "nmi") nmiEntries += e.count; else irqEntries += e.count;
    const rid = routineOf(pc);
    const to = rid ?? addrNode(pc);
    if (!rid) unattributed.add(pc);
    edges.push({ from: runNodeId, type, to, evidenceKey: evKey(pc), origin: ORIGIN, confidence: CONFIDENCE, evidence: { pc, run_id: runId, count: e.count, first_cycle: e.first, last_cycle: e.last, flow: e.flow } });
    counts[type] += 1;
  }
  // used-in-this-run (785 §2.1): the routines the run retired instructions in — never "unused"
  for (const [rid, x] of [...exec.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    edges.push({ from: runNodeId, type: "EXECUTES", to: rid, evidenceKey: `run:${runId}`, origin: ORIGIN, confidence: CONFIDENCE, evidence: { run_id: runId, steps: x.steps, distinct_pcs: x.pcs.size, first_cycle: x.first, last_cycle: x.last } });
    counts.EXECUTES += 1;
  }

  // ---- the run node (D6)
  const pcSource: ImportRuntimeTraceResult["pcSource"] = busFallbacks === 0 ? "retire" : retireAttributions === 0 ? "bus" : "mixed";
  const traceBytes = statSync(tracePath).size;
  const cycleStart = Number.isFinite(cycleMin) ? cycleMin : meta.cycleStart;
  const cycleEnd = Number.isFinite(cycleMax) ? cycleMax : meta.cycleStart;
  const runAttrs: Record<string, unknown> = {
    run_id: runId, def_id: meta.defId, def_name: meta.defName, domains: meta.domains, media_sha: meta.mediaSha ?? null, media_name: meta.mediaName ?? null,
    created_at: meta.createdAt, cycle_start: cycleStart, cycle_end: cycleEnd, trace_path: tracePath, trace_bytes: traceBytes, format_version: header.version,
    events: stream.eventCount, cpu_steps: cpuSteps, accesses, distinct_pcs: pcsSeen.size, pc_source: pcSource,
    opcode_check: staticOpcode.size > 0 ? "analysis" : "none", static_access_edges: staticAccessEdges,
    irq_entries: irqEntries, nmi_entries: nmiEntries, collapsed_pcs: collapsed.size, max_rows_per_pc: maxRowsPerPc,
    bank_ctx_final: bankCtx(), bank_ctx_conf: p01Observed ? "observed" : "inferred", cart_banks_read: [...cartBanks].sort((a, b) => a - b), marks,
  };
  nodes.push({ id: runNodeId, kind: "run", name: runId, attrs: runAttrs, origin: ORIGIN, confidence: CONFIDENCE, evidence: [{ trace_path: tracePath, trace_bytes: traceBytes }] });

  // ---- the invariant, checked on what is about to be written (D3, §4)
  for (const n of nodes) if (n.origin !== ORIGIN || n.confidence !== CONFIDENCE) throw new IdRuleError("runtime-origin", `node ${n.id ?? "?"} is ${n.origin}/${n.confidence}`);
  for (const e of edges) if (e.origin !== ORIGIN || e.confidence !== CONFIDENCE) throw new IdRuleError("runtime-origin", `edge ${e.from} ${e.type} ${e.to} is ${e.origin}/${e.confidence}`);

  try {
    store.replaceGenerated(RUNTIME_PRODUCER, runId, nodes, edges);
  } finally {
    store.close();
    platform?.close();
  }
  rss();

  return {
    runId, runNodeId, slug, tracePath, traceBytes, formatVersion: header.version, eventCount: stream.eventCount, cpuSteps, accesses,
    distinctPcs: pcsSeen.size, cycleStart, cycleEnd, pcSource, rows: counts, addrNodes: nodeIds.size, unattributedPcs: unattributed.size,
    notes: { opcodeMismatch, noStaticEdge }, staticAccessEdges, irqEntries, nmiEntries, collapsedPcs: collapsed.size, marks,
    ms: Number(process.hrtime.bigint() - t0) / 1e6, peakRssMb: peakRss / 1048576,
  };
}

/** D6 — removing the run removes its rows and nothing else (shared addr nodes stay, by the store's rule). */
export function removeRuntimeRun(projectDir: string, runId: string): { deletedNodes: number; deletedEdges: number } {
  const store = GraphStore.open(projectDir);
  try {
    const r = store.replaceGenerated(RUNTIME_PRODUCER, runId, [], []);
    return { deletedNodes: r.deletedNodes, deletedEdges: r.deletedEdges };
  } finally {
    store.close();
  }
}

/** The run node id a run id maps to — the same derivation the importer uses. */
export function runNodeIdFor(slug: string, runId: string): string {
  return deriveSubsystemId(slug, `run-${runId.toLowerCase().replace(/[^a-z0-9_.\-]+/gu, "-")}`);
}
