// Spec 861 D3 — what the code costs on the machine.
//
// The runtime records; C64RE evaluates. Nothing new is asked of the runtime
// (§5): the trace already carries one row per retired instruction with `clock`,
// `pc`, the opcode, its operand bytes and the registers, plus every read and
// write on the `mem` channel. Everything below is derived from those two
// streams.
//
// THE ARITHMETIC, per instruction instance (§4.2):
//
//   measured   Δclock between this row and the one before it. `clock` is the
//              post-instruction cycle minus one on the cycle-exact core, a
//              constant offset, so the difference is exactly the cycles the
//              instruction took — including every cycle the VIC stole from it.
//   static     the cycle table (§3.1). The page crossing is EXACT here, not a
//              span: `abs,X`/`abs,Y` from the operand and the pre-state index
//              (the previous row's registers are this row's pre-state), and
//              `(zp),Y` from the traced read of the pointer itself. Branch taken
//              and its page crossing follow from the next row's `pc`.
//   entry      an interrupt dispatch costs 7, and it belongs to the ENTRY, not
//              to the instruction before it. Recognised from the traced reads of
//              the vector ($FFFE/$FFFF, $FFFA/$FFFB) with the three stack writes
//              beside them; a `brk` carries its own pair and is not an entry.
//   stolen     measured − static − entry. On the drive CPU there is no DMA, so
//              stolen must be zero — a free consistency check (§7.8).
//
// Rows are grouped by `seq`, not by clock: the trace is one ordered stream and a
// retired instruction's own accesses — and any interrupt dispatch that ran
// before it — are the events between the previous CPU row and this one. That is
// exact where a clock window is merely close.

import { disasm6502 } from "../monitor/disasm6502.js";
import { crossesPage, differentPage, opcodeTiming } from "./cycles.js";

export interface InsnRow { seq: number; clock: number; pc: number; opcode: number; b1: number; b2: number; a: number; x: number; y: number; sp: number; p: number }
export interface MemRow { seq: number; clock: number; pc: number | null; kind: string; addr: number; value: number | null }

/** Where the capture's frame boundary is, and how big a frame is on that machine. */
export interface Anchor {
  clock: number;
  line: number;
  cycle: number;
  cyclesPerLine: number;
  linesPerFrame: number;
}

export const ANCHOR_LABEL = "861-anchor";

/** `861-anchor line=0 cycle=0 cpl=63 lpf=312` — the mark the capture leaves in the store. */
export function anchorLabel(a: Omit<Anchor, "clock">): string {
  return `${ANCHOR_LABEL} line=${a.line} cycle=${a.cycle} cpl=${a.cyclesPerLine} lpf=${a.linesPerFrame}`;
}

export function parseAnchorLabel(label: string, clock: number): Anchor | null {
  if (!label.startsWith(ANCHOR_LABEL)) return null;
  const n = (k: string): number | null => {
    const m = new RegExp(`${k}=(-?\\d+)`, "u").exec(label);
    return m ? Number(m[1]) : null;
  };
  const line = n("line"), cycle = n("cycle"), cpl = n("cpl"), lpf = n("lpf");
  if (line === null || cycle === null || cpl === null || lpf === null || cpl <= 0 || lpf <= 0) return null;
  return { clock, line, cycle, cyclesPerLine: cpl, linesPerFrame: lpf };
}

/**
 * Which raster line and cycle a clock lands on, counted from the anchor.
 *
 * The cycle is 1..63, which is how a VIC-II raster chart, vicspector and 859's
 * own record number them; the anchor's own `cycle` comes from the runtime's
 * raster counter, which is 0-based. Verified against 859 on the same machine and
 * the same store: the line and the cycle are the ones it records.
 */
export function rasterAt(anchor: Anchor, clock: number): { line: number; cycle: number; frame: number } {
  const frameCycles = anchor.cyclesPerLine * anchor.linesPerFrame;
  const fromFrameStart = anchor.line * anchor.cyclesPerLine + anchor.cycle;
  const pos = clock - anchor.clock + fromFrameStart;
  const frame = Math.floor(pos / frameCycles);
  const inFrame = ((pos % frameCycles) + frameCycles) % frameCycles;
  return { line: Math.floor(inFrame / anchor.cyclesPerLine), cycle: (inFrame % anchor.cyclesPerLine) + 1, frame };
}

// --------------------------------------------------------------- evaluation

export interface Instance {
  seq: number;
  /** the trace row's clock: the instruction's last cycle */
  clock: number;
  pc: number;
  opcode: number;
  mnemonic: string;
  measured: number;
  /** the cycle table's answer, with the page crossing and the branch resolved from the trace */
  staticCycles: number | null;
  /** true when nothing about this instance had to be left as a span */
  exact: boolean;
  /** why it is not exact, when it is not */
  inexactWhy?: string;
  /** 7 per interrupt dispatch that ran before this instruction */
  entryCycles: number;
  /** how the dispatch was recognised, when there was one */
  entryVia?: "vector-reads" | "no-successor";
  stolen: number;
  line: number | null;
  cycleInLine: number | null;
}

export interface RoutineCost {
  id: string;
  label: string;
  start: number;
  end: number;
  instances: number;
  calls: number;
  measured: number;
  staticTotal: number;
  stolen: number;
  entries: number;
}

export interface LineCost { line: number; cycles: number; stolen: number; instances: number }

/**
 * Why a lane cannot be evaluated at all, when it cannot.
 *
 * THE ONE CASE, and it is the drive (§7.8): `drive_pc` is not an instruction
 * stream. The drive's 6502 runs with a null sink and its PC is SAMPLED at each
 * C64 instruction boundary and deduplicated (`Machine::sample_pc_change`), and
 * the record carries no opcode at all — `write_drive_cpu_step` writes a zero
 * with the comment "not observable in sampled mode". So Δclock between two rows
 * is not the cycles an instruction took (several drive instructions can pass
 * between samples) and there is no opcode to price.
 *
 * This is refused rather than answered. Priced anyway, the drive's own ROM comes
 * back as a stream of BRKs with minus a million stolen cycles, which is worse
 * than no answer — and §7.8's whole point is that the drive has no DMA, so a
 * wrong "stolen" there would discredit the arithmetic everywhere else.
 */
export interface LaneProblem { lane: string; why: string; whatWouldFixIt: string }

export const DRIVE_LANE_PROBLEM: LaneProblem = {
  lane: "drive8",
  why:
    "the drive lane is a deduplicated PC SAMPLE, not a stream of retired instructions: the runtime "
    + "samples the drive's program counter at each C64 instruction boundary and records it without an "
    + "opcode, so there is nothing to price and the difference between two rows is not the cycles an "
    + "instruction took",
  whatWouldFixIt:
    "one row per RETIRED drive instruction carrying its opcode and operand bytes — the record format "
    + "already has the fields (pc, opcode, b1, b2, a, x, y, sp, p, clk) and the reader already projects "
    + "them as cpu='drive8'; only the producer is missing, which is the drive core calling the same "
    + "retire hook the C64 core calls instead of the run loop sampling its PC",
};

export interface TraceCostReport {
  cpu: string;
  /** set when the lane cannot be evaluated at all; every total below is then zero */
  laneProblem?: LaneProblem;
  rows: number;
  evaluated: number;
  anchor: Anchor | null;
  anchorWhy: string;
  frames: number;
  measured: number;
  staticTotal: number;
  stolen: number;
  entries: number;
  /** §4.2 / §7.3 — which of the two recognitions fired, counted */
  entriesVia: { vectorReads: number; noSuccessor: number };
  inexact: number;
  /** the instances whose static cost could not be pinned, with the reason */
  inexactSamples: Instance[];
  /** the instances where measured ≠ static (+ entry): the stolen cycles, largest first */
  stolenSamples: Instance[];
  perRoutine: RoutineCost[];
  perLine: LineCost[];
  unattributed: { instances: number; why: Record<string, number> };
  instances: Instance[];
  notes: string[];
}

export interface RoutineSpan { id: string; label: string; start: number; end: number }

export interface EvaluateOptions {
  cpu?: string;
  anchor?: Anchor | null;
  /** only these addresses (a range the caller named) */
  range?: { start: number; end: number };
  routines?: RoutineSpan[];
  /** keep at most this many instances in the report (the aggregates always see all of them) */
  keepInstances?: number;
}

const BRANCH_OPCODES = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xb0, 0xd0, 0xf0]);

/** The addresses control could legitimately reach from this instruction. */
function successorsOf(row: InsnRow): Set<number> | null {
  const bytes = [row.opcode, row.b1, row.b2];
  const d = disasm6502((a) => bytes[(a - row.pc) & 0xffff] ?? 0, row.pc);
  const next = (row.pc + d.size) & 0xffff;
  if (d.mnemonic === "rts" || d.mnemonic === "rti" || d.mnemonic === "brk" || d.mnemonic === "jam") return null;
  if (d.mnemonic === "jmp") return d.mode === "ind" ? null : new Set([d.operand ?? next]);
  if (d.mnemonic === "jsr") return new Set([d.operand ?? next]);
  if (BRANCH_OPCODES.has(row.opcode)) return new Set([next, d.target ?? next]);
  return new Set([next]);
}

export function evaluateTrace(
  insns: readonly InsnRow[],
  mem: readonly MemRow[],
  options: EvaluateOptions = {},
): TraceCostReport {
  const notes: string[] = [];
  const anchor = options.anchor ?? null;
  const keep = options.keepInstances ?? 20000;

  // A lane that carries no opcodes is not an instruction stream, and pricing it
  // would produce a number rather than an answer.
  if (insns.length > 10 && insns.every((r) => r.opcode === 0 && r.b1 === 0 && r.b2 === 0)) {
    return {
      cpu: options.cpu ?? "c64",
      laneProblem: (options.cpu ?? "c64").startsWith("drive")
        ? DRIVE_LANE_PROBLEM
        : { lane: options.cpu ?? "c64", why: "every row in this lane has a zero opcode, so it is not a stream of retired instructions", whatWouldFixIt: DRIVE_LANE_PROBLEM.whatWouldFixIt },
      rows: insns.length, evaluated: 0, anchor,
      anchorWhy: "not read: the lane cannot be evaluated",
      frames: 0, measured: 0, staticTotal: 0, stolen: 0, entries: 0,
      entriesVia: { vectorReads: 0, noSuccessor: 0 },
      inexact: 0, inexactSamples: [], stolenSamples: [], perRoutine: [], perLine: [],
      unattributed: { instances: 0, why: {} }, instances: [], notes,
    };
  }

  // mem rows grouped by the CPU row they belong to: everything after the
  // previous CPU row's seq and up to this one's.
  const byInsn = new Map<number, MemRow[]>();
  {
    let k = 0;
    const sorted = [...mem].sort((a, b) => a.seq - b.seq);
    for (const row of insns) {
      const bucket: MemRow[] = [];
      while (k < sorted.length && sorted[k]!.seq < row.seq) { bucket.push(sorted[k]!); k += 1; }
      byInsn.set(row.seq, bucket);
    }
  }

  const instances: Instance[] = [];
  let measured = 0, staticTotal = 0, stolen = 0, entries = 0, inexact = 0, evaluated = 0;
  const entriesVia = { vectorReads: 0, noSuccessor: 0 };

  for (let i = 1; i < insns.length; i += 1) {
    const row = insns[i]!;
    const prev = insns[i - 1]!;
    const next = insns[i + 1];
    const delta = row.clock - prev.clock;
    if (delta <= 0) { notes.push(`row ${row.seq} has a clock that does not advance (${prev.clock} → ${row.clock}) — skipped`); continue; }

    const window = byInsn.get(row.seq) ?? [];
    let entry = interruptEntries(window, row.opcode);
    let via: "vector-reads" | "no-successor" | undefined = entry > 0 ? "vector-reads" : undefined;
    if (entry === 0) {
      // §4.2's fallback, for a runtime that does not trace the vector reads: the
      // pc is not a successor of the instruction before it, and the stack
      // pointer dropped by the three bytes a dispatch pushes. Kept live so the
      // arithmetic does not depend on one recording choice — §7.3 reports which
      // of the two actually fires.
      const succ = successorsOf(prev);
      if (succ && !succ.has(row.pc) && ((prev.sp - row.sp) & 0xff) >= 3) { entry = 1; via = "no-successor"; }
    }
    const entryCycles = entry * 7;

    const t = opcodeTiming(row.opcode);
    let staticCycles: number | null = t ? t.base : null;
    let exact = t !== undefined;
    let inexactWhy: string | undefined;
    if (!t) inexactWhy = `opcode $${row.opcode.toString(16).padStart(2, "0")} is a JAM — it never retires, so it has no cycle count`;

    if (t?.pageCross) {
      const cross = pageCrossOf(row, prev, window);
      if (cross === null) { exact = false; inexactWhy = "the page crossing could not be decided from the trace"; staticCycles = t.base; }
      else if (cross) staticCycles = t.base + 1;
    }
    if (t?.branch) {
      const bytes = [row.opcode, row.b1, row.b2];
      const d = disasm6502((a) => bytes[(a - row.pc) & 0xffff] ?? 0, row.pc);
      const nextEntry = next ? interruptEntries(byInsn.get(next.seq) ?? [], next.opcode) : 0;
      if (!next || nextEntry > 0) {
        exact = false;
        inexactWhy = next ? "an interrupt was dispatched after this branch, so the next pc does not say whether it was taken" : "this is the last row in the window, so the next pc is not known";
      } else if (next.pc === d.target) {
        staticCycles = t.base + 1 + (differentPage((row.pc + d.size) & 0xffff, d.target ?? 0) ? 1 : 0);
      } else if (next.pc === ((row.pc + d.size) & 0xffff)) {
        staticCycles = t.base;
      } else {
        exact = false;
        inexactWhy = `the next pc ($${next.pc.toString(16)}) is neither the branch target nor the fall-through`;
      }
    }

    const theft = staticCycles === null ? 0 : delta - staticCycles - entryCycles;
    const raster = anchor ? rasterAt(anchor, row.clock) : null;
    const instance: Instance = {
      seq: row.seq, clock: row.clock, pc: row.pc, opcode: row.opcode,
      mnemonic: disasm6502((a) => [row.opcode, row.b1, row.b2][(a - row.pc) & 0xffff] ?? 0, row.pc).mnemonic,
      measured: delta, staticCycles, exact, entryCycles, stolen: theft,
      line: raster ? raster.line : null, cycleInLine: raster ? raster.cycle : null,
    };
    if (inexactWhy) instance.inexactWhy = inexactWhy;
    if (via) instance.entryVia = via;

    if (options.range && (row.pc < options.range.start || row.pc > options.range.end)) continue;

    evaluated += 1;
    measured += delta;
    staticTotal += staticCycles ?? 0;
    stolen += theft;
    entries += entry;
    if (via === "vector-reads") entriesVia.vectorReads += entry;
    else if (via === "no-successor") entriesVia.noSuccessor += entry;
    if (!exact) inexact += 1;
    if (instances.length < keep) instances.push(instance);
  }

  // ---- aggregates
  const perRoutine = new Map<string, RoutineCost>();
  const unattributedWhy: Record<string, number> = {};
  let unattributed = 0;
  for (const inst of instances) {
    const hits = (options.routines ?? []).filter((r) => inst.pc >= r.start && inst.pc <= r.end);
    if (hits.length !== 1) {
      unattributed += 1;
      const why = hits.length === 0 ? "no routine in the graph covers this address" : `${hits.length} routines cover this address — residency decides, and it has not (§4.4)`;
      unattributedWhy[why] = (unattributedWhy[why] ?? 0) + 1;
      continue;
    }
    const r = hits[0]!;
    const cur = perRoutine.get(r.id) ?? { id: r.id, label: r.label, start: r.start, end: r.end, instances: 0, calls: 0, measured: 0, staticTotal: 0, stolen: 0, entries: 0 };
    cur.instances += 1;
    cur.measured += inst.measured;
    cur.staticTotal += inst.staticCycles ?? 0;
    cur.stolen += inst.stolen;
    cur.entries += inst.entryCycles > 0 ? 1 : 0;
    if (inst.pc === r.start) cur.calls += 1;
    perRoutine.set(r.id, cur);
  }

  // Per raster line, and the two halves are attributed differently on purpose.
  //
  // OCCUPANCY is split across the lines the instruction actually ran on: an
  // instruction that starts on one line and retires on the next spent cycles on
  // both, and charging all of them to the line it ended on makes a line report
  // more than the 63 cycles it has.
  //
  // STOLEN stays on the line the instruction RETIRED on, because that is where
  // it was stalled: a bad line stretches the instruction it interrupts, so the
  // instruction ends on the bad line. §7.2 measures exactly that — every line
  // with a stolen cycle is a line 859 calls a bad line.
  const lines = new Map<number, LineCost>();
  const bump = (line: number, cycles: number, stolen: number, count: number): void => {
    const cur = lines.get(line) ?? { line, cycles: 0, stolen: 0, instances: 0 };
    cur.cycles += cycles;
    cur.stolen += stolen;
    cur.instances += count;
    lines.set(line, cur);
  };
  for (const inst of instances) {
    if (inst.line === null || !anchor) continue;
    bump(inst.line, 0, inst.stolen, 1);
    let left = inst.measured;
    let at = inst.clock;
    while (left > 0) {
      const here = rasterAt(anchor, at);
      const onThisLine = Math.min(left, here.cycle);   // `cycle` is 1-based: how many of this line are behind us
      bump(here.line, onThisLine, 0, 0);
      left -= onThisLine;
      at -= onThisLine;
    }
  }

  const frames = anchor && insns.length > 1
    ? Math.max(1, Math.round((insns[insns.length - 1]!.clock - insns[0]!.clock) / (anchor.cyclesPerLine * anchor.linesPerFrame)))
    : 0;

  return {
    cpu: options.cpu ?? "c64",
    rows: insns.length,
    evaluated,
    anchor,
    anchorWhy: anchor ? `the capture's frame boundary at clock ${anchor.clock}, line ${anchor.line} cycle ${anchor.cycle}, ${anchor.cyclesPerLine}×${anchor.linesPerFrame}` : "no frame anchor in this store — raster positions are not reported (§4.2 takes the anchor from the capture's advance to a frame boundary)",
    frames,
    measured, staticTotal, stolen, entries, entriesVia, inexact,
    inexactSamples: instances.filter((i) => !i.exact).slice(0, 10),
    stolenSamples: [...instances].filter((i) => i.stolen !== 0).sort((a, b) => Math.abs(b.stolen) - Math.abs(a.stolen)).slice(0, 10),
    perRoutine: [...perRoutine.values()].sort((a, b) => b.measured - a.measured),
    perLine: [...lines.values()].sort((a, b) => a.line - b.line),
    unattributed: { instances: unattributed, why: unattributedWhy },
    instances,
    notes,
  };
}

/**
 * How many interrupt dispatches ran before this instruction.
 *
 * A dispatch reads the vector — $FFFE/$FFFF for IRQ and BRK, $FFFA/$FFFB for NMI
 * — and pushes three bytes onto the stack. Both halves are required, so a routine
 * that merely reads $FFFE is not mistaken for one. A `brk` carries its own pair
 * INSIDE its own instruction, so one pair is subtracted for it.
 */
function interruptEntries(window: readonly MemRow[], opcode: number): number {
  let pairs = 0;
  let stackWrites = 0;
  const reads = new Set<number>();
  for (const e of window) {
    if (e.kind === "write" && e.addr >= 0x0100 && e.addr <= 0x01ff) stackWrites += 1;
    if (e.kind !== "read") continue;
    if (e.addr === 0xfffe || e.addr === 0xffff || e.addr === 0xfffa || e.addr === 0xfffb) reads.add(e.addr);
    if (reads.has(0xfffe) && reads.has(0xffff)) { pairs += 1; reads.delete(0xfffe); reads.delete(0xffff); }
    if (reads.has(0xfffa) && reads.has(0xfffb)) { pairs += 1; reads.delete(0xfffa); reads.delete(0xfffb); }
  }
  if (pairs === 0 || stackWrites < 3 * pairs) pairs = Math.min(pairs, Math.floor(stackWrites / 3));
  if (opcode === 0x00 && pairs > 0) pairs -= 1; // the BRK's own vector read
  return Math.max(0, pairs);
}

/**
 * Did this instance's indexed read cross a page?
 *
 *  - `abs,X` / `abs,Y`: the base is the operand and the index is the pre-state,
 *    which is the PREVIOUS row's register (the trace's registers are post).
 *  - `(zp),Y`: the pointer is not in the instruction, so it comes from the two
 *    traced reads of the zero-page cell and the one after it.
 *
 * `null` when neither is available — reported as inexact rather than assumed.
 */
function pageCrossOf(row: InsnRow, prev: InsnRow, window: readonly MemRow[]): boolean | null {
  const bytes = [row.opcode, row.b1, row.b2];
  const d = disasm6502((a) => bytes[(a - row.pc) & 0xffff] ?? 0, row.pc);
  if (d.mode === "abs,x") return crossesPage(row.b1 | (row.b2 << 8), prev.x);
  if (d.mode === "abs,y") return crossesPage(row.b1 | (row.b2 << 8), prev.y);
  if (d.mode === "(zp),y") {
    const zp = row.b1;
    const lo = window.find((e) => e.kind === "read" && e.addr === zp);
    const hi = window.find((e) => e.kind === "read" && e.addr === ((zp + 1) & 0xff));
    if (!lo || !hi || lo.value === null || hi.value === null) return null;
    return crossesPage(lo.value | (hi.value << 8), prev.y);
  }
  return null;
}

// ------------------------------------------------------------------- text

const hex4 = (a: number): string => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

export function formatTraceCost(report: TraceCostReport, title: string): string {
  const lines: string[] = [];
  lines.push(title);
  if (report.laneProblem) {
    lines.push(`  ${report.rows} rows on the ${report.laneProblem.lane} lane, and NONE of them can be priced.`);
    lines.push(`  Why: ${report.laneProblem.why}.`);
    lines.push(`  What would change that: ${report.laneProblem.whatWouldFixIt}.`);
    lines.push(`  No number is given here on purpose — a wrong one would look like an answer.`);
    return lines.join("\n");
  }
  lines.push(`  cpu ${report.cpu} · ${report.rows} instruction rows · ${report.evaluated} evaluated${report.frames ? ` · about ${report.frames} frame(s)` : ""}`);
  lines.push(`  anchor: ${report.anchorWhy}`);
  lines.push("");
  lines.push(`  measured ${report.measured} cycles · static ${report.staticTotal} · interrupt entries ${report.entries} (${report.entries * 7} cycles) · stolen ${report.stolen}`);
  if (report.entries > 0) {
    lines.push(`  entries recognised: ${report.entriesVia.vectorReads} from the traced vector reads, ${report.entriesVia.noSuccessor} from a pc that is no successor with the stack three lower`);
  }
  lines.push(`  ${report.evaluated - report.inexact} of ${report.evaluated} instances are exact against the cycle table; ${report.inexact} are not`);
  if (report.inexactSamples.length) {
    lines.push("  what could not be pinned:");
    for (const s of report.inexactSamples) lines.push(`    ${hex4(s.pc)} ${s.mnemonic} — ${s.inexactWhy}`);
  }
  if (report.stolenSamples.length) {
    lines.push("  stolen cycles, largest first:");
    for (const s of report.stolenSamples) {
      lines.push(`    ${hex4(s.pc)} ${s.mnemonic}  measured ${s.measured}  static ${s.staticCycles}  entry ${s.entryCycles}  stolen ${s.stolen}${s.line !== null ? `  line ${s.line} cycle ${s.cycleInLine}` : ""}`);
    }
  }

  if (report.perRoutine.length) {
    lines.push("");
    lines.push("  per routine (§4.3)");
    for (const r of report.perRoutine.slice(0, 20)) {
      const perCall = r.calls > 0 ? (r.measured / r.calls).toFixed(1) : "—";
      const perCallStatic = r.calls > 0 ? (r.staticTotal / r.calls).toFixed(1) : "—";
      const share = report.anchor && report.frames
        ? ` · ${((r.measured / (report.frames * report.anchor.cyclesPerLine * report.anchor.linesPerFrame)) * 100).toFixed(1)}% of the frame`
        : "";
      lines.push(
        `    ${r.label.padEnd(22)} ${hex4(r.start)}-${hex4(r.end)}  ${r.instances} instances  ${r.calls} call(s)  ` +
          `${perCall} cycles/call measured, ${perCallStatic} static  stolen ${r.stolen}${share}`,
      );
      if (report.frames > 0) lines.push(`      ${(r.calls / report.frames).toFixed(2)} calls per frame`);
    }
  }

  if (report.unattributed.instances > 0) {
    lines.push("");
    lines.push(`  unattributed: ${report.unattributed.instances} instance(s) — counted, never guessed (§4.4)`);
    for (const [why, n] of Object.entries(report.unattributed.why)) lines.push(`    ${n}× ${why}`);
  }

  const busy = report.perLine.filter((l) => l.stolen !== 0);
  if (report.perLine.length) {
    lines.push("");
    lines.push(`  per raster line: ${report.perLine.length} line(s) touched, ${busy.length} with stolen cycles`);
    for (const l of busy.slice(0, 20)) lines.push(`    line ${String(l.line).padStart(3)}  ${l.cycles} cycles  ${l.stolen} stolen  ${l.instances} instances`);
  }
  for (const n of report.notes.slice(0, 10)) lines.push(`  note: ${n}`);
  return lines.join("\n");
}
