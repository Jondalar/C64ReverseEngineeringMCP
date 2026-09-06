// Spec 826 — routine signatures: registers, flags, zero page, stack, patched
// operands. Computed from 819's routine nodes and the report's instruction
// stream; written as rows of its own (producer "826", replacement unit the
// artifact stem) so a re-seed replaces them whole and never touches 819's node.
//
// 826 D1  signature = in / out / clobbers / preserves over locations, by
//         liveness on the block graph: memory cells, flags, stack slots and
//         patched operands through the textbook backward dataflow; the three
//         registers through a forward SYMBOLIC pass (A = entry(A) | const |
//         a stack slot | unknown, sets at joins) so a value moved through
//         `txa; pha … pla; tax` is a save, not a use, and `txa; sta $F4` is
//         a use of X, not of A
// 826 D2  a `jsr` contributes the callee's summary — routines in reverse
//         topological order of CALLS (Tarjan), recursive SCCs iterated to a
//         fixpoint; ROM through the platform ABI (D4); another owner through
//         RESOLVES_TO (826.0 T2); anything else → `partial`, site named,
//         propagated to every caller
// 826 D3  a write into an instruction's operand bytes is the location
//         `op:$XXXX`: `out` of the writer, `in` of the instruction's routine
// 826 D5  stack height per block; `pha pha rts` with constants → JUMPS_TO;
//         `pla pla rts` → returns_to caller's caller; `tsx; lda $0101,x` →
//         reads_return_address; height ≠ 0 at an exit → unbalanced_at
// 826 D6  arguments at the call site by a backward slice in the caller's
//         block (one straight-line predecessor): PASSES edges beside 819's
//         CALLS, joined by (from, to, evidence_key)
// 826 D7  the signature JSON is the `evidence` of a SIGNATURE self-edge on
//         the routine (store.replaceGenerated inserts, it cannot update 819's
//         row); `edgesOutOf(id, ["SIGNATURE"])[0].evidence` reads it back

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PlatformKb } from "../../platform-kb/read.js";
import { platformKindForAddress, type PlatformAbi, type PlatformTag } from "../../platform-kb/schema.js";
import { deriveProjectId, derivePlatformId, parseId, platformForCtx, type Ctx } from "../ids.js";
import { GraphStore, readProjectSlug, type EdgeInput, type NodeInput } from "../store.js";
import { BRANCHES, effects, indexRegister, type Loc } from "../isa-6502.js";
import { ownerFromAnalysisPath } from "./control-flow.js";

export const SIGNATURE_PRODUCER = "826";
export const SIGNATURE_VERSION = 1;

// ------------------------------------------------------------------ shapes

export interface SignatureIn { loc: string; confidence: "certain" | "inferred"; first_use: string }
export interface SignatureOut { loc: string; last_def: string }
export interface SignatureStack {
  /** SP delta at the exits when they agree, else null */
  delta: number | null;
  /** every rts/rti leaves at height 0 and no height is unknown */
  balanced: boolean;
  tricks: string[];
  returns_to?: "caller's caller";
  reads_return_address?: true;
  unbalanced_at?: string;
  unknown?: true;
}
export interface Signature {
  in: SignatureIn[];
  out: SignatureOut[];
  clobbers: string[];
  preserves: string[];
  stack: SignatureStack;
  /** `root` names the original site when the reason travelled up from a callee */
  partial: { because: string; site: string; root?: string } | null;
  version: number;
}

export type ArgSource = "imm" | "mem" | "zp" | "op" | "reg" | "callee" | "flag" | "unknown";
export interface ArgEvidence {
  source: ArgSource;
  value?: number;
  from?: string;
  site?: string;
  /** the one step followed for `reg` and for a store of an immediate */
  via?: string;
  indexed?: "X" | "Y";
  indirect?: true;
}

export interface SeedSignaturesOptions {
  projectDir: string;
  /** one report; omitted → every `*_analysis.json` under the project */
  analysisPath?: string;
  owner?: string;
  ctx?: Ctx;
  slug?: string;
  platformDb?: string;
}

export interface SeedSignaturesOwnerResult {
  owner: string;
  routines: number;
  signed: number;
  partial: number;
  unknownStack: number;
  passes: number;
  dispatches: number;
  ms: number;
}

export interface SeedSignaturesResult {
  owners: SeedSignaturesOwnerResult[];
  routines: number;
  signed: number;
  partial: number;
  unknownStack: number;
  passes: number;
  dispatches: number;
  sccRounds: number;
  ms: number;
}

// ------------------------------------------------------------------ report

interface Instruction {
  address: number;
  size: number;
  bytes?: number[];
  mnemonic: string;
  addressingMode: string;
  operandText: string;
  operandValue?: number;
  targetAddress?: number;
  provenance: "confirmed_code" | "probable_code";
}
interface Report {
  mapping: { startAddress: number; endAddress: number };
  codeAnalysis?: { instructions: Instruction[]; basicBlocks?: Array<{ start: number; end: number; successors: number[] }> };
  probableCodeAnalysis?: { instructions: Instruction[] };
}

const REGS: Loc[] = ["A", "X", "Y"];
const hex2 = (n: number) => `$${(n & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;
const hex4 = (n: number) => `$${(n & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
const key4 = (n: number) => (n & 0xffff).toString(16).toLowerCase().padStart(4, "0");

/** `lda #$01` · `sta $F3` · `lda ($F4),y` · `bcs $1010` — the text of one instruction, from the report's fields. */
export function renderInstruction(i: Instruction): string {
  const mn = i.mnemonic.toLowerCase();
  const v = i.operandValue ?? i.targetAddress ?? 0;
  switch (i.addressingMode) {
    case "impl":
    case "acc":
      return mn;
    case "imm": return `${mn} #${hex2(v)}`;
    case "zp": return `${mn} ${hex2(v)}`;
    case "zp,x": return `${mn} ${hex2(v)},x`;
    case "zp,y": return `${mn} ${hex2(v)},y`;
    case "abs": return `${mn} ${hex4(i.targetAddress ?? v)}`;
    case "abs,x": return `${mn} ${hex4(i.targetAddress ?? v)},x`;
    case "abs,y": return `${mn} ${hex4(i.targetAddress ?? v)},y`;
    case "ind": return `${mn} (${hex4(i.targetAddress ?? v)})`;
    case "(zp,x)": return `${mn} (${hex2(v)},x)`;
    case "(zp),y": return `${mn} (${hex2(v)}),y`;
    case "rel": return `${mn} ${hex4(i.targetAddress ?? v)}`;
    default: return `${mn} ${i.operandText}`.trim();
  }
}
const siteOf = (i: Instruction) => `${hex4(i.address)} ${renderInstruction(i)}`;

/** Sort key over locations: registers, flags, zp, mem, stack slots, patched operands, the unknown cell. */
export function locRank(loc: string): number {
  const fixed = ["A", "X", "Y", "SP", "C", "Z", "N", "V", "D", "I"].indexOf(loc);
  if (fixed >= 0) return fixed;
  let m = loc.match(/^zp:\$([0-9A-F]{2})(\+[XY])?$/u);
  if (m) return 100 + parseInt(m[1]!, 16) * 4 + (m[2] === "+X" ? 1 : m[2] === "+Y" ? 2 : 0);
  m = loc.match(/^mem:\$([0-9A-F]{4})(\+[XY])?$/u);
  if (m) return 10_000 + parseInt(m[1]!, 16) * 4 + (m[2] === "+X" ? 1 : m[2] === "+Y" ? 2 : 0);
  m = loc.match(/^S\+(\d+)$/u);
  if (m) return 400_000 + Number(m[1]);
  m = loc.match(/^op:\$([0-9A-F]{4})$/u);
  if (m) return 500_000 + parseInt(m[1]!, 16);
  return 999_999;
}
const sortLocs = (xs: Iterable<string>) => [...new Set(xs)].sort((a, b) => locRank(a) - locRank(b) || a.localeCompare(b));

// ------------------------------------------------------------------ symbolic values

/** A set of atoms: `eA` entry value of A · `c:NN` constant · `sp:H` SP captured at height H · `s:K` caller's stack slot S+K · `?` unknown. */
type Sym = readonly string[];
const UNKNOWN: Sym = ["?"];
const symOf = (...atoms: string[]): Sym => [...new Set(atoms)].sort();
const symUnion = (a: Sym, b: Sym): Sym => {
  if (a.includes("?") || b.includes("?")) return UNKNOWN;
  const u = symOf(...a, ...b);
  return u.length > 6 ? UNKNOWN : u;
};
const symEq = (a: Sym, b: Sym) => a.length === b.length && a.every((x, i) => x === b[i]);
const symIs = (s: Sym, atom: string) => s.length === 1 && s[0] === atom;
const symConst = (s: Sym): number | undefined => (s.length === 1 && s[0]!.startsWith("c:") ? Number(s[0]!.slice(2)) : undefined);

interface State { A: Sym; X: Sym; Y: Sym; height: number | null; slots: Map<number, Sym> }
const entryState = (): State => ({ A: ["eA"], X: ["eX"], Y: ["eY"], height: 0, slots: new Map() });
const copyState = (s: State): State => ({ A: s.A, X: s.X, Y: s.Y, height: s.height, slots: new Map(s.slots) });
function mergeState(a: State, b: State): State {
  const height = a.height !== null && a.height === b.height ? a.height : null;
  const slots = new Map<number, Sym>();
  if (height !== null) {
    for (const [k, v] of a.slots) slots.set(k, b.slots.has(k) ? symUnion(v, b.slots.get(k)!) : UNKNOWN);
    for (const k of b.slots.keys()) if (!a.slots.has(k)) slots.set(k, UNKNOWN);
  }
  return { A: symUnion(a.A, b.A), X: symUnion(a.X, b.X), Y: symUnion(a.Y, b.Y), height, slots };
}
function stateEq(a: State, b: State): boolean {
  if (!symEq(a.A, b.A) || !symEq(a.X, b.X) || !symEq(a.Y, b.Y) || a.height !== b.height || a.slots.size !== b.slots.size) return false;
  for (const [k, v] of a.slots) { const w = b.slots.get(k); if (!w || !symEq(v, w)) return false; }
  return true;
}

// ------------------------------------------------------------------ callee summaries

interface Callee {
  kind: "summary" | "abi" | "unknown";
  /** node id of the callee (routine or rom), for `source: callee` */
  id?: string;
  in: string[];
  /** clobbers ∪ out − preserves */
  defs: string[];
  preserves: string[];
  partial: { because: string; site: string; root?: string } | null;
  returnsToCallersCaller: boolean;
  readsReturnAddress: boolean;
  reason?: string;
}
const UNKNOWN_CALLEE_DEFS = ["A", "X", "Y", "C", "Z", "N", "V"];
const unknownCallee = (reason: string, id?: string): Callee => ({ kind: "unknown", id, in: [], defs: UNKNOWN_CALLEE_DEFS, preserves: [], partial: null, returnsToCallersCaller: false, readsReturnAddress: false, reason });
const emptySummary = (id: string): Callee => ({ kind: "summary", id, in: [], defs: [], preserves: [], partial: null, returnsToCallersCaller: false, readsReturnAddress: false });

function calleeFromSignature(id: string, sig: Signature): Callee {
  const pres = new Set(sig.preserves);
  const defs = sortLocs([...sig.clobbers, ...sig.out.map((o) => o.loc)].filter((l) => !pres.has(l)));
  return {
    kind: "summary", id, in: sig.in.map((i) => i.loc), defs, preserves: sig.preserves, partial: sig.partial,
    returnsToCallersCaller: sig.stack.returns_to === "caller's caller", readsReturnAddress: sig.stack.reads_return_address === true,
  };
}
function calleeFromAbi(id: string, abi: PlatformAbi): Callee {
  const pres = new Set(abi.preserves);
  return { kind: "abi", id, in: [...abi.in], defs: sortLocs([...abi.clobbers, ...abi.out].filter((l) => !pres.has(l))), preserves: [...abi.preserves], partial: null, returnsToCallersCaller: false, readsReturnAddress: false };
}

// ------------------------------------------------------------------ owner context

interface OwnerCtx {
  owner: string;
  ctx: Ctx;
  slug: string;
  tag: PlatformTag;
  instructions: Map<number, Instruction>;
  inImage: (a: number) => boolean;
  leaders: Set<number>;
  /** 819's routine rows for the owner: start → id */
  routineIds: Map<number, string>;
  /** operand-byte address → the instruction that owns it */
  operandOwner: Map<number, Instruction>;
  /** operand bytes something writes (D3) */
  patchedOps: Set<number>;
  /** extra `op:` defs per writing instruction, from 820's WRITES rows */
  extraDefs: Map<number, string[]>;
  /** `${routineId}|src:xxxx` → 819's CALLS / CALLS_ROM target, for the PASSES join */
  callEdgeTo: Map<string, string>;
  /** routine / label node of this owner at an address (JUMPS_TO targets) */
  nodeAt: Map<number, string>;
  blockCache: Map<number, RawBlock>;
}

interface RawBlock {
  start: number;
  instrs: Instruction[];
  last: Instruction | undefined;
  /** address after the last instruction */
  next: number;
}

function findAnalysisJsons(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "knowledge" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findAnalysisJsons(p, out, depth + 1);
    else if (entry.endsWith("_analysis.json")) out.push(p);
  }
  return out.sort();
}

function loadOwner(store: GraphStore, analysisPath: string, options: SeedSignaturesOptions, slug: string): OwnerCtx {
  const report = JSON.parse(readFileSync(analysisPath, "utf8")) as Report;
  const owner = options.owner ?? ownerFromAnalysisPath(analysisPath);
  const ctx: Ctx = options.ctx ?? { space: "ram", owner };
  const tag = platformForCtx(ctx);
  const instructions = new Map<number, Instruction>();
  for (const i of report.codeAnalysis?.instructions ?? []) instructions.set(i.address, i);
  for (const i of report.probableCodeAnalysis?.instructions ?? []) if (!instructions.has(i.address)) instructions.set(i.address, i);
  const inImage = (a: number) => a >= report.mapping.startAddress && a <= report.mapping.endAddress;

  const routineIds = new Map<number, string>();
  const nodeAt = new Map<number, string>();
  const rows = store.db.prepare("SELECT id, kind, address, attrs FROM nodes WHERE layer = 'generated' AND run_owner = ? AND producer = '819' AND kind IN ('routine', 'label') ORDER BY kind DESC, address").all(owner) as Array<{ id: string; kind: string; address: number; attrs: string }>;
  for (const r of rows) {
    if (r.kind === "routine") {
      const attrs = JSON.parse(r.attrs) as { undecoded?: boolean };
      if (!attrs.undecoded && instructions.has(r.address)) routineIds.set(r.address, r.id);
      nodeAt.set(r.address, r.id);
    } else if (!nodeAt.has(r.address)) nodeAt.set(r.address, r.id);
  }

  // leaders: routine starts, branch / jmp targets, the instruction after a branch, the report's own block starts
  const leaders = new Set<number>(routineIds.keys());
  for (const b of report.codeAnalysis?.basicBlocks ?? []) if (instructions.has(b.start)) leaders.add(b.start);
  const operandOwner = new Map<number, Instruction>();
  for (const i of instructions.values()) {
    const mn = i.mnemonic.toLowerCase();
    if (BRANCHES.has(mn) || (mn === "jmp" && i.addressingMode === "abs")) {
      if (i.targetAddress !== undefined && instructions.has(i.targetAddress)) leaders.add(i.targetAddress);
    }
    if (BRANCHES.has(mn) || mn === "jmp" || mn === "rts" || mn === "rti" || mn === "brk" || mn === "jam") {
      if (instructions.has(i.address + i.size)) leaders.add(i.address + i.size);
    }
    for (let k = 1; k < i.size; k += 1) operandOwner.set((i.address + k) & 0xffff, i);
  }

  // D3: who writes into operand bytes — 820's WRITES rows, plus the direct stores of the stream (820 may not have run)
  const patchedOps = new Set<number>();
  const extraDefs = new Map<number, string[]>();
  const writes = store.db.prepare("SELECT to_id, evidence FROM edges WHERE layer = 'generated' AND type = 'WRITES' AND owner = ? AND producer = '820'").all(owner) as Array<{ to_id: string; evidence: string }>;
  for (const w of writes) {
    const ev = JSON.parse(w.evidence) as { source_address?: number; indexed?: boolean; via_zp?: number };
    if (ev.indexed === true && ev.via_zp === undefined) continue;
    let target: number;
    try { const p = parseId(w.to_id); if (p.form === "subsystem") continue; target = p.address; } catch { continue; }
    if (!operandOwner.has(target) || typeof ev.source_address !== "number") continue;
    patchedOps.add(target);
    const list = extraDefs.get(ev.source_address) ?? [];
    const loc = `op:${hex4(target)}`;
    if (!list.includes(loc)) list.push(loc);
    extraDefs.set(ev.source_address, list);
  }
  for (const i of instructions.values()) {
    const e = effects(i.mnemonic, i.addressingMode);
    if (!e.memWrite || (i.addressingMode !== "zp" && i.addressingMode !== "abs")) continue;
    const target = (i.targetAddress ?? i.operandValue);
    if (target !== undefined && operandOwner.has(target & 0xffff)) patchedOps.add(target & 0xffff);
  }

  const callEdgeTo = new Map<string, string>();
  const calls = store.db.prepare("SELECT from_id, type, to_id, evidence_key FROM edges WHERE layer = 'generated' AND owner = ? AND producer = '819' AND type IN ('CALLS', 'CALLS_ROM') ORDER BY type").all(owner) as Array<{ from_id: string; type: string; to_id: string; evidence_key: string }>;
  for (const c of calls) { const k = `${c.from_id}|${c.evidence_key}`; if (!callEdgeTo.has(k)) callEdgeTo.set(k, c.to_id); } // CALLS before CALLS_ROM

  return { owner, ctx, slug, tag, instructions, inImage, leaders, routineIds, operandOwner, patchedOps, extraDefs, callEdgeTo, nodeAt, blockCache: new Map() };
}

function rawBlock(o: OwnerCtx, start: number): RawBlock {
  const cached = o.blockCache.get(start);
  if (cached) return cached;
  const instrs: Instruction[] = [];
  let a = start;
  let last: Instruction | undefined;
  for (;;) {
    const i = o.instructions.get(a);
    if (!i) break;
    instrs.push(i);
    last = i;
    a = (a + i.size) & 0xffff;
    const mn = i.mnemonic.toLowerCase();
    if (BRANCHES.has(mn) || mn === "jmp" || mn === "rts" || mn === "rti" || mn === "brk" || mn === "jam") break;
    if (o.leaders.has(a)) break;
  }
  const b = { start, instrs, last, next: a };
  o.blockCache.set(start, b);
  return b;
}

// ------------------------------------------------------------------ the analysis of one routine

type ExitKind = "rts" | "rti" | "jam" | "brk" | "tail" | "dispatch" | "jmp-ind" | "undecoded" | "returns-to-callers-caller";
interface Exit { block: number; instr: Instruction; kind: ExitKind; height: number | null; target?: number }
interface CallSite { instr: Instruction; block: number; callee: Callee; to: string | undefined; target: number }

interface RoutineAnalysis {
  id: string;
  address: number;
  signature: Signature;
  calls: CallSite[];
  dispatches: Array<{ instr: Instruction; target: number }>;
  /** per block: instruction list and pre-states, for the D6 slice */
  blocks: Map<number, { instrs: Instruction[]; pre: Map<number, State>; succ: number[]; pred: number[] }>;
}

function memLoc(o: OwnerCtx, i: Instruction, pre: State): { read: string[]; write: string[] } {
  const e = effects(i.mnemonic, i.addressingMode);
  const v = i.operandValue ?? 0;
  const abs = (i.targetAddress ?? i.operandValue ?? 0) & 0xffff;
  const read: string[] = [];
  const write: string[] = [];
  const direct = (addr: number): string => (o.patchedOps.has(addr) ? `op:${hex4(addr)}` : addr < 0x100 ? `zp:${hex2(addr)}` : `mem:${hex4(addr)}`);
  const idxCell = (base: number, reg: "X" | "Y"): string => {
    // `tsx; lda $0101,x` — X holds SP captured at height H: the slot S+(n−H)
    const sym = reg === "X" ? pre.X : pre.Y;
    if (base >= 0x100 && base <= 0x1ff && sym.length === 1 && sym[0]!.startsWith("sp:")) {
      const k = (base - 0x100) - Number(sym[0]!.slice(3));
      return `S${k >= 0 ? "+" : ""}${k}`;
    }
    return base < 0x100 ? `zp:${hex2(base)}+${reg}` : `mem:${hex4(base)}+${reg}`;
  };
  let cell: string | undefined;
  switch (i.addressingMode) {
    case "zp": cell = direct(v & 0xff); break;
    case "abs": cell = direct(abs); break;
    case "zp,x": cell = idxCell(v & 0xff, "X"); break;
    case "zp,y": cell = idxCell(v & 0xff, "Y"); break;
    case "abs,x": cell = idxCell(abs, "X"); break;
    case "abs,y": cell = idxCell(abs, "Y"); break;
    case "(zp),y": read.push(`zp:${hex2(v)}`, `zp:${hex2(v + 1)}`); cell = "mem:?"; break;
    case "(zp,x)": read.push(`zp:${hex2(v)}+X`); cell = "mem:?"; break;
    case "ind": read.push(`mem:${hex4(abs)}`, `mem:${hex4(abs + 1)}`); break;
    default: break;
  }
  if (cell) {
    if (e.memRead) read.push(cell);
    if (e.memWrite) write.push(cell);
  }
  return { read, write };
}

function analyseRoutine(o: OwnerCtx, start: number, id: string, calleeAt: (o: OwnerCtx, target: number, site: Instruction) => Callee): RoutineAnalysis {
  // ---- blocks reachable from the start, edges from the last instruction
  const succ = new Map<number, number[]>();
  const pred = new Map<number, number[]>();
  const tails = new Map<number, { target: number; kind: ExitKind }>(); // block → tail call / exit by control transfer
  const order: number[] = [];
  const queue = [start];
  const seen = new Set<number>([start]);
  const edge = (from: number, to: number) => {
    succ.get(from)!.push(to);
    if (!pred.has(to)) pred.set(to, []);
    pred.get(to)!.push(from);
    if (!seen.has(to)) { seen.add(to); queue.push(to); }
  };
  const partialReasons: Array<{ because: string; site: string; root?: string; order: number }> = [];
  let partialSeq = 0;
  const notePartial = (because: string, site: string, root?: string) => partialReasons.push({ because, site, root, order: partialSeq++ });
  /** a callee's partial travels up as `callee partial: <root because>` with the root site kept, never as a nested string */
  const noteCalleePartial = (c: Callee, site: string) => {
    if (!c.partial) return;
    const rootBecause = c.partial.because.replace(/^callee partial: /u, "");
    notePartial(`callee partial: ${rootBecause}`, site, c.partial.root ?? c.partial.site);
  };
  const targets = (b: RawBlock): { flow: number[]; tail?: { target: number; kind: ExitKind } } => {
    const last = b.last;
    if (!last) return { flow: [] };
    const mn = last.mnemonic.toLowerCase();
    const flow: number[] = [];
    let tail: { target: number; kind: ExitKind } | undefined;
    const goto = (a: number, viaJump: boolean) => {
      if (a === start) { flow.push(a); return; }
      if (o.routineIds.has(a)) { tail = { target: a, kind: "tail" }; return; }
      if (o.instructions.has(a)) { flow.push(a); return; }
      if (viaJump) {
        if (platformKindForAddress(o.tag, a) === "rom" && !o.inImage(a)) { tail = { target: a, kind: "tail" }; return; }
        tail = { target: a, kind: "undecoded" };
        notePartial(o.inImage(a) ? "jumps into undecoded bytes" : "jumps outside the image", siteOf(last));
      } else {
        tail = { target: a, kind: "undecoded" };
        notePartial("falls into undecoded bytes", siteOf(last));
      }
    };
    if (BRANCHES.has(mn)) {
      if (last.targetAddress !== undefined) goto(last.targetAddress, true);
      goto(b.next, false);
    } else if (mn === "jmp") {
      if (last.addressingMode === "ind") { tail = { target: last.targetAddress ?? last.operandValue ?? 0, kind: "jmp-ind" }; notePartial("jmp (abs) vector", siteOf(last)); }
      else if (last.targetAddress !== undefined) goto(last.targetAddress, true);
    } else if (mn === "rts" || mn === "rti" || mn === "brk" || mn === "jam") {
      // exit — handled by the walk
    } else {
      goto(b.next, false);
    }
    return { flow, tail };
  };
  const blocks = new Map<number, RawBlock>();
  while (queue.length > 0) {
    const s = queue.shift()!;
    const b = rawBlock(o, s);
    blocks.set(s, b);
    order.push(s);
    succ.set(s, []);
    if (!pred.has(s)) pred.set(s, []);
    const t = targets(b);
    for (const a of t.flow) edge(s, a);
    if (t.tail) tails.set(s, t.tail);
  }

  // ---- forward symbolic pass (registers, stack)
  const calleeCache = new Map<number, Callee>();
  const calleeOf = (i: Instruction, target: number): Callee => {
    let c = calleeCache.get(i.address);
    if (!c) { c = calleeAt(o, target, i); calleeCache.set(i.address, c); }
    return c;
  };
  const isTerminalJsr = (i: Instruction): boolean => i.mnemonic.toLowerCase() === "jsr" && i.targetAddress !== undefined && calleeOf(i, i.targetAddress).returnsToCallersCaller;

  const step = (st: State, i: Instruction): State => {
    const s = copyState(st);
    const mn = i.mnemonic.toLowerCase();
    const e = effects(mn, i.addressingMode);
    const v = i.operandValue ?? 0;
    const patchedImm = i.addressingMode === "imm" && o.patchedOps.has((i.address + 1) & 0xffff);
    const push = (val: Sym) => { if (s.height !== null) { s.slots.set(-s.height, val); s.height += 1; } };
    const pop = (): Sym => {
      if (s.height === null) return UNKNOWN;
      s.height -= 1;
      const k = -s.height;
      const val = k >= 1 ? symOf(`s:${k}`) : (s.slots.get(k) ?? UNKNOWN);
      s.slots.delete(k);
      return val;
    };
    switch (mn) {
      case "lda": s.A = i.addressingMode === "imm" && !patchedImm ? symOf(`c:${v & 0xff}`) : loadSym(i, s, "A"); return s;
      case "ldx": s.X = i.addressingMode === "imm" && !patchedImm ? symOf(`c:${v & 0xff}`) : loadSym(i, s, "X"); return s;
      case "ldy": s.Y = i.addressingMode === "imm" && !patchedImm ? symOf(`c:${v & 0xff}`) : loadSym(i, s, "Y"); return s;
      case "tax": s.X = s.A; return s;
      case "tay": s.Y = s.A; return s;
      case "txa": s.A = s.X; return s;
      case "tya": s.A = s.Y; return s;
      case "tsx": s.X = s.height === null ? UNKNOWN : symOf(`sp:${s.height}`); return s;
      case "txs": case "tas": case "las": s.height = null; s.slots.clear(); if (mn === "las") { s.A = UNKNOWN; s.X = UNKNOWN; } return s;
      case "pha": push(s.A); return s;
      case "php": push(UNKNOWN); return s;
      case "pla": s.A = pop(); return s;
      case "plp": pop(); return s;
      case "jsr": {
        if (i.targetAddress === undefined) { s.A = UNKNOWN; s.X = UNKNOWN; s.Y = UNKNOWN; return s; }
        const c = calleeOf(i, i.targetAddress);
        for (const d of c.defs) { if (d === "A") s.A = UNKNOWN; else if (d === "X") s.X = UNKNOWN; else if (d === "Y") s.Y = UNKNOWN; }
        return s;
      }
      default:
        for (const w of e.writes) { if (w === "A") s.A = UNKNOWN; else if (w === "X") s.X = UNKNOWN; else if (w === "Y") s.Y = UNKNOWN; }
        return s;
    }
  };
  const loadSym = (i: Instruction, s: State, _reg: "A" | "X" | "Y"): Sym => {
    // `lda $0100+n,x` with X = SP captured at height H reads the caller's slot S+(n−H)
    const base = (i.targetAddress ?? i.operandValue ?? 0) & 0xffff;
    const idx = indexRegister(i.addressingMode);
    if (idx && (i.addressingMode === "abs,x" || i.addressingMode === "abs,y") && base >= 0x100 && base <= 0x1ff) {
      const sym = idx === "X" ? s.X : s.Y;
      if (sym.length === 1 && sym[0]!.startsWith("sp:")) {
        const k = (base - 0x100) - Number(sym[0]!.slice(3));
        return k >= 1 ? symOf(`s:${k}`) : (s.slots.get(k) ?? UNKNOWN);
      }
    }
    return UNKNOWN;
  };
  const stateIn = new Map<number, State>();
  stateIn.set(start, entryState());
  const work = [...order];
  let guard = 0;
  while (work.length > 0 && guard < 10_000) {
    guard += 1;
    const s = work.shift()!;
    const b = blocks.get(s)!;
    let st = stateIn.get(s);
    if (!st) continue;
    let terminated = false;
    for (const i of b.instrs) {
      st = step(st, i);
      if (isTerminalJsr(i)) { terminated = true; break; }
    }
    if (terminated) continue;
    const outState = st;
    for (const n of succ.get(s) ?? []) {
      const prev = stateIn.get(n);
      const merged = prev ? mergeState(prev, outState) : outState;
      if (!prev || !stateEq(prev, merged)) { stateIn.set(n, merged); if (!work.includes(n)) work.push(n); }
    }
  }

  // ---- per-block walk: pre-states, use/def, register consumption, stack facts, exits
  const use = new Map<number, Map<string, string>>();
  const def = new Map<number, Map<string, string>>();
  const defAll = new Map<string, string>(); // loc → some def site (for clobbers)
  const regUse: Array<{ reg: Loc; site: string; block: number; exact: boolean }> = [];
  const exits: Exit[] = [];
  const calls: CallSite[] = [];
  const dispatches: Array<{ instr: Instruction; target: number }> = [];
  const preOf = new Map<number, Map<number, State>>();
  let readsReturnAddress = false;
  let stackUnknown = false;
  const tricks = new Set<string>();
  let returnsTo: "caller's caller" | undefined;

  const consume = (st: State, reg: Loc, i: Instruction, block: number) => {
    const sym = reg === "A" ? st.A : reg === "X" ? st.X : reg === "Y" ? st.Y : UNKNOWN;
    for (const r of REGS) {
      if (sym.includes(`e${r}`)) regUse.push({ reg: r, site: siteOf(i), block, exact: symIs(sym, `e${r}`) });
    }
    for (const atom of sym) {
      const m = atom.match(/^s:(\d+)$/u);
      if (m) {
        const k = Number(m[1]);
        if (k === 1 || k === 2) readsReturnAddress = true;
        else { const u = use.get(block)!; const loc = `S+${k}`; if (!u.has(loc) && !def.get(block)!.has(loc)) u.set(loc, siteOf(i)); }
      }
    }
  };

  for (const s of order) {
    const b = blocks.get(s)!;
    const u = new Map<string, string>();
    const d = new Map<string, string>();
    use.set(s, u);
    def.set(s, d);
    const pre = new Map<number, State>();
    preOf.set(s, pre);
    let st = stateIn.get(s) ?? entryState();
    const addUse = (loc: string, i: Instruction) => { if (loc === "mem:?" || d.has(loc) || u.has(loc)) return; u.set(loc, siteOf(i)); };
    const addDef = (loc: string, i: Instruction) => { d.set(loc, siteOf(i)); if (!defAll.has(loc)) defAll.set(loc, siteOf(i)); };
    let terminated = false;
    for (const i of b.instrs) {
      pre.set(i.address, st);
      const mn = i.mnemonic.toLowerCase();
      const e = effects(mn, i.addressingMode);
      const mem = memLoc(o, i, st);
      const isMove = mn === "pha" || mn === "php" || mn === "tax" || mn === "tay" || mn === "txa" || mn === "tya" || mn === "brk";
      // consumption of registers: everything but the pure moves
      if (!isMove) for (const r of e.reads) if (r === "A" || r === "X" || r === "Y") consume(st, r, i, s);
      // flags read (branches, adc/sbc/rol/ror, rti); php / brk / pha are moves
      if (!isMove) for (const r of e.reads) if (r !== "A" && r !== "X" && r !== "Y" && r !== "SP") addUse(r, i);
      // memory
      for (const l of mem.read) addUse(l, i);
      // an instruction whose operand bytes are patched reads that operand (D3)
      for (let j = 1; j < i.size; j += 1) { const a = (i.address + j) & 0xffff; if (o.patchedOps.has(a)) addUse(`op:${hex4(a)}`, i); }
      if (mn === "jsr" && i.targetAddress !== undefined) {
        const c = calleeOf(i, i.targetAddress);
        for (const l of c.in) {
          if (l === "A" || l === "X" || l === "Y") consume(st, l as Loc, i, s);
          else if (l !== "SP") addUse(l, i);
        }
        const to = o.callEdgeTo.get(`${id}|src:${key4(i.address)}`);
        calls.push({ instr: i, block: s, callee: c, to, target: i.targetAddress });
        if (c.kind === "unknown") notePartial(c.reason ?? "callee unknown", siteOf(i));
        else noteCalleePartial(c, siteOf(i));
        for (const l of c.defs) addDef(l, i);
        if (c.returnsToCallersCaller) { exits.push({ block: s, instr: i, kind: "returns-to-callers-caller", height: st.height }); terminated = true; break; }
      } else {
        for (const w of e.writes) if (w !== "SP" || mn === "txs" || mn === "tas" || mn === "las") addDef(w, i);
        for (const l of mem.write) addDef(l, i);
        for (const l of o.extraDefs.get(i.address) ?? []) addDef(l, i);
      }
      if (mn === "txs" || mn === "tas" || mn === "las") { stackUnknown = true; tricks.add(mn === "txs" ? "txs" : mn); }
      // exits
      const next = step(st, i);
      if (mn === "rts") {
        const h = st.height;
        if (h !== null && h >= 2) {
          const hi = st.slots.get(-(h - 2));
          const lo = st.slots.get(-(h - 1));
          const hv = hi ? symConst(hi) : undefined;
          const lv = lo ? symConst(lo) : undefined;
          if (hv !== undefined && lv !== undefined) {
            const target = (((hv << 8) | lv) + 1) & 0xffff;
            dispatches.push({ instr: i, target });
            tricks.add(`rts-dispatch → ${hex4(target)}`);
            exits.push({ block: s, instr: i, kind: "dispatch", height: h, target });
            const c = calleeAt(o, target, i);
            if (c.kind === "unknown") notePartial(c.reason ?? "dispatch target unknown", siteOf(i));
            else noteCalleePartial(c, siteOf(i));
            for (const l of c.in) { if (l === "A" || l === "X" || l === "Y") consume(st, l as Loc, i, s); else if (l !== "SP") addUse(l, i); }
            for (const l of c.defs) addDef(l, i);
          } else {
            tricks.add("rts-dispatch (target unknown)");
            notePartial("rts-dispatch target unknown", siteOf(i));
            exits.push({ block: s, instr: i, kind: "dispatch", height: h });
          }
        } else if (h !== null && h === -2) {
          returnsTo = "caller's caller";
          tricks.add("returns-to-callers-caller");
          exits.push({ block: s, instr: i, kind: "rts", height: h });
        } else {
          exits.push({ block: s, instr: i, kind: "rts", height: h });
        }
      } else if (mn === "rti") {
        // `pla; tay; pla; tax; pla; rti` — the handler pops the KERNAL's IRQ frame ($FF48 pushed A X Y): balanced against that frame
        if (st.height === -3) tricks.add("kernal-irq-exit");
        exits.push({ block: s, instr: i, kind: "rti", height: st.height });
      }
      else if (mn === "jam") exits.push({ block: s, instr: i, kind: "jam", height: st.height });
      else if (mn === "brk") exits.push({ block: s, instr: i, kind: "brk", height: st.height });
      st = next;
    }
    if (terminated) continue;
    const tail = tails.get(s);
    if (tail && b.last) {
      if (tail.kind === "tail") {
        const c = calleeOf(b.last, tail.target);
        if (c.kind === "unknown") notePartial(c.reason ?? "tail-call target unknown", siteOf(b.last));
        else noteCalleePartial(c, siteOf(b.last));
        for (const l of c.in) { if (l === "A" || l === "X" || l === "Y") consume(st, l as Loc, b.last, s); else if (l !== "SP") addUse(l, b.last); }
        for (const l of c.defs) addDef(l, b.last);
        const to = o.callEdgeTo.get(`${id}|src:${key4(b.last.address)}`);
        if (b.last.mnemonic.toLowerCase() === "jmp") calls.push({ instr: b.last, block: s, callee: c, to, target: tail.target });
      }
      exits.push({ block: s, instr: b.last, kind: tail.kind, height: st.height, target: tail.target });
    }
  }

  // ---- classic liveness for non-register locations
  const liveIn = new Map<number, Set<string>>();
  for (const s of order) liveIn.set(s, new Set());
  let changed = true;
  guard = 0;
  while (changed && guard < 1000) {
    changed = false;
    guard += 1;
    for (const s of [...order].reverse()) {
      const out = new Set<string>();
      for (const n of succ.get(s) ?? []) for (const l of liveIn.get(n)!) out.add(l);
      const inSet = new Set<string>(use.get(s)!.keys());
      const d = def.get(s)!;
      for (const l of out) if (!d.has(l)) inSet.add(l);
      const prev = liveIn.get(s)!;
      if (inSet.size !== prev.size || [...inSet].some((l) => !prev.has(l))) { liveIn.set(s, inSet); changed = true; }
    }
  }

  // ---- dominators, may-def, exit reachability
  const dom = new Map<number, Set<number>>();
  dom.set(start, new Set([start]));
  for (const s of order) if (s !== start) dom.set(s, new Set(order));
  changed = true;
  guard = 0;
  while (changed && guard < 1000) {
    changed = false;
    guard += 1;
    for (const s of order) {
      if (s === start) continue;
      const ps = pred.get(s) ?? [];
      let acc: Set<number> | undefined;
      for (const p of ps) { const dp = dom.get(p)!; acc = acc ? new Set([...acc].filter((x) => dp.has(x))) : new Set(dp); }
      const next = new Set(acc ?? []);
      next.add(s);
      const prev = dom.get(s)!;
      if (next.size !== prev.size || [...next].some((x) => !prev.has(x))) { dom.set(s, next); changed = true; }
    }
  }
  const exitBlocks = new Set(exits.map((e) => e.block));
  const dominatesAllExits = (b: number): boolean => exitBlocks.size === 0 ? b === start : [...exitBlocks].every((e) => dom.get(e)!.has(b));
  const mayDefIn = new Map<number, Set<string>>();
  for (const s of order) mayDefIn.set(s, new Set());
  changed = true;
  guard = 0;
  while (changed && guard < 1000) {
    changed = false;
    guard += 1;
    for (const s of order) {
      const acc = new Set<string>();
      for (const p of pred.get(s) ?? []) { for (const l of mayDefIn.get(p)!) acc.add(l); for (const l of def.get(p)!.keys()) acc.add(l); }
      const prev = mayDefIn.get(s)!;
      if (acc.size !== prev.size || [...acc].some((l) => !prev.has(l))) { mayDefIn.set(s, acc); changed = true; }
    }
  }
  const reachesExit = new Set<number>();
  { const stack = [...exitBlocks]; while (stack.length) { const s = stack.pop()!; if (reachesExit.has(s)) continue; reachesExit.add(s); for (const p of pred.get(s) ?? []) stack.push(p); } }

  // ---- in: memory / flags / stack slots / patched operands
  const ins: SignatureIn[] = [];
  const EXCLUDED_IN = new Set(["mem:?", "S+1", "S+2", "SP"]);
  for (const loc of liveIn.get(start)!) {
    if (EXCLUDED_IN.has(loc) || loc === "A" || loc === "X" || loc === "Y") continue;
    // first use: BFS from entry through blocks that do not define it
    let firstUse: { site: string; block: number } | undefined;
    const q = [start];
    const vis = new Set<number>([start]);
    while (q.length && !firstUse) {
      const s = q.shift()!;
      const u = use.get(s)!;
      if (u.has(loc)) { firstUse = { site: u.get(loc)!, block: s }; break; }
      if (def.get(s)!.has(loc)) continue;
      for (const n of succ.get(s) ?? []) if (!vis.has(n)) { vis.add(n); q.push(n); }
    }
    if (!firstUse) continue;
    const certain = dominatesAllExits(firstUse.block) && !mayDefIn.get(firstUse.block)!.has(loc);
    ins.push({ loc, confidence: certain ? "certain" : "inferred", first_use: firstUse.site });
  }
  // ---- in: registers, from the symbolic consumption
  for (const r of REGS) {
    const uses = regUse.filter((u) => u.reg === r);
    if (uses.length === 0) continue;
    const first = uses[0]!;
    const certain = first.exact && dominatesAllExits(first.block);
    ins.push({ loc: r, confidence: certain ? "certain" : "inferred", first_use: first.site });
  }
  ins.sort((a, b) => locRank(a.loc) - locRank(b.loc) || a.loc.localeCompare(b.loc));

  // ---- preserves: written somewhere, and exactly the entry value at every proper exit
  const properExits = exits.filter((e) => (e.kind === "rts" || e.kind === "rti") && e.height === 0);
  const preserves: string[] = [];
  for (const r of REGS) {
    if (!defAll.has(r) || properExits.length === 0) continue;
    const ok = properExits.every((e) => { const st = preOf.get(e.block)!.get(e.instr.address)!; const sym = r === "A" ? st.A : r === "X" ? st.X : st.Y; return symIs(sym, `e${r}`); });
    if (ok) preserves.push(r);
  }

  // ---- clobbers / out
  const preserved = new Set(preserves);
  const clobbers = sortLocs([...defAll.keys()].filter((l) => !preserved.has(l)));
  const outLocs = new Set<string>();
  for (const s of reachesExit) for (const l of def.get(s)!.keys()) if (!preserved.has(l)) outLocs.add(l);
  const outs: SignatureOut[] = [];
  for (const loc of sortLocs(outLocs)) {
    // last def: from an exit block backwards
    let site: string | undefined;
    for (const e of [...exits].sort((a, b) => a.instr.address - b.instr.address)) {
      const q = [e.block];
      const vis = new Set<number>();
      while (q.length && !site) {
        const s = q.shift()!;
        if (vis.has(s)) continue;
        vis.add(s);
        const d = def.get(s)!;
        if (d.has(loc)) { site = d.get(loc)!; break; }
        for (const p of pred.get(s) ?? []) q.push(p);
      }
      if (site) break;
    }
    outs.push({ loc, last_def: site ?? defAll.get(loc) ?? "" });
  }

  // ---- stack summary
  const heights = exits.filter((e) => e.kind === "rts" || e.kind === "rti" || e.kind === "dispatch" || e.kind === "tail").map((e) => e.height);
  const known = heights.filter((h): h is number => h !== null);
  const delta = known.length === heights.length && known.length > 0 && known.every((h) => h === known[0]) ? known[0]! : null;
  const balanced = !stackUnknown && heights.length > 0 && exits.every((e) => (e.kind === "rts" && e.height === 0) || (e.kind === "rti" && (e.height === 0 || e.height === -3)) || (e.kind !== "rts" && e.kind !== "rti"));
  const stack: SignatureStack = { delta, balanced, tricks: [...tricks].sort() };
  if (returnsTo) stack.returns_to = returnsTo;
  if (readsReturnAddress) { stack.reads_return_address = true; stack.tricks.push("reads-return-address"); stack.tricks.sort(); }
  if (stackUnknown) stack.unknown = true;
  const odd = exits.find((e) => (e.kind === "rts" || e.kind === "rti") && e.height !== null && e.height !== 0 && !(e.kind === "rts" && e.height === -2) && !(e.kind === "rti" && e.height === -3));
  if (odd && stack.tricks.length === 0) stack.unbalanced_at = siteOf(odd.instr); // D5: only when no pattern explains it

  partialReasons.sort((a, b) => a.order - b.order);
  const first = partialReasons[0];
  const partial = first ? (first.root ? { because: first.because, site: first.site, root: first.root } : { because: first.because, site: first.site }) : null;

  const signature: Signature = { in: ins, out: outs, clobbers, preserves, stack, partial, version: SIGNATURE_VERSION };
  const blockInfo = new Map<number, { instrs: Instruction[]; pre: Map<number, State>; succ: number[]; pred: number[] }>();
  for (const s of order) blockInfo.set(s, { instrs: blocks.get(s)!.instrs, pre: preOf.get(s)!, succ: succ.get(s) ?? [], pred: pred.get(s) ?? [] });
  return { id, address: start, signature, calls, dispatches, blocks: blockInfo };
}

// ------------------------------------------------------------------ D6: the argument slice

function argsAt(o: OwnerCtx, ra: RoutineAnalysis, call: CallSite, kb: PlatformKb | undefined): Record<string, ArgEvidence> {
  const block = ra.blocks.get(call.block)!;
  // the slice: the caller's block up to the jsr, and ONE straight-line predecessor
  let seq: Instruction[] = block.instrs.slice(0, block.instrs.findIndex((i) => i.address === call.instr.address));
  const preAt = new Map<number, State>(block.pre);
  if (block.pred.length === 1) {
    const p = block.pred[0]!;
    const pb = ra.blocks.get(p);
    // sound whenever THIS block has exactly one predecessor: every path into it ran through that block's end
    if (pb && p !== call.block) { seq = [...pb.instrs, ...seq]; for (const [a, st] of pb.pre) preAt.set(a, st); }
  }
  const cellId = (a: number): string => {
    if (platformKindForAddress(o.tag, a) !== "ram") return derivePlatformId(o.tag, a);
    return kb?.node(o.tag, a)?.id ?? deriveProjectId({ slug: o.slug, ctx: { space: o.ctx.space }, kind: "addr", address: a });
  };
  const writesReg = (i: Instruction, r: Loc): boolean => {
    const mn = i.mnemonic.toLowerCase();
    if (mn === "jsr") { const c = i.targetAddress === undefined ? undefined : ra.calls.find((x) => x.instr.address === i.address)?.callee; return c ? c.kind === "unknown" || c.defs.includes(r) : true; }
    return effects(mn, i.addressingMode).writes.includes(r);
  };
  const regSource = (r: Loc, upto: number, depth: number): ArgEvidence => {
    for (let k = upto - 1; k >= 0; k -= 1) {
      const i = seq[k]!;
      if (!writesReg(i, r)) continue;
      const mn = i.mnemonic.toLowerCase();
      const site = siteOf(i);
      if (mn === "jsr") { const c = ra.calls.find((x) => x.instr.address === i.address); return { source: "callee", from: c?.to ?? c?.callee.id, site }; }
      const load = (mn === "lda" && r === "A") || (mn === "ldx" && r === "X") || (mn === "ldy" && r === "Y") || (mn === "lax" && (r === "A" || r === "X"));
      if (load) {
        if (i.addressingMode === "imm") {
          const opByte = (i.address + 1) & 0xffff;
          if (o.patchedOps.has(opByte)) return { source: "op", from: `op:${hex4(opByte)}`, site: `${hex4(i.address)} ${mn} #$xx (patched)` };
          return { source: "imm", value: (i.operandValue ?? 0) & 0xff, site };
        }
        const base = (i.targetAddress ?? i.operandValue ?? 0) & 0xffff;
        if (i.addressingMode === "zp" || i.addressingMode === "abs") return { source: base < 0x100 ? "zp" : "mem", from: cellId(base), site };
        if (i.addressingMode === "(zp),y" || i.addressingMode === "(zp,x)") return { source: "mem", from: derivePlatformId(o.tag, (i.operandValue ?? 0) & 0xff), indirect: true, site };
        const idx = indexRegister(i.addressingMode);
        if (idx) return { source: "mem", from: cellId(base), indexed: idx as "X" | "Y", site };
        return { source: "unknown", site };
      }
      const transfer: Record<string, Loc> = { tax: "A", tay: "A", txa: "X", tya: "Y" };
      if (transfer[mn] && depth > 0) {
        const src = regSource(transfer[mn]!, k, depth - 1);
        if (src.source === "imm") return { source: "imm", value: src.value, site, via: src.site };
        return { source: "reg", from: transfer[mn]!, site };
      }
      if (transfer[mn]) return { source: "reg", from: transfer[mn]!, site };
      return { source: "unknown", site };
    }
    return { source: "unknown" };
  };
  const flagSource = (f: string, upto: number): ArgEvidence => {
    for (let k = upto - 1; k >= 0; k -= 1) {
      const i = seq[k]!;
      const mn = i.mnemonic.toLowerCase();
      if (mn === "jsr") { const c = ra.calls.find((x) => x.instr.address === i.address); if (!c || c.callee.kind === "unknown" || c.callee.defs.includes(f)) return { source: "callee", from: c?.to ?? c?.callee.id, site: siteOf(i) }; continue; }
      if (!effects(mn, i.addressingMode).writes.includes(f as Loc)) continue;
      if (mn === "sec" || mn === "sed" || mn === "sei") return { source: "flag", value: 1, site: siteOf(i) };
      if (mn === "clc" || mn === "cld" || mn === "cli" || mn === "clv") return { source: "flag", value: 0, site: siteOf(i) };
      return { source: "flag", site: siteOf(i) };
    }
    return { source: "unknown" };
  };
  const memSource = (loc: string, upto: number): ArgEvidence => {
    for (let k = upto - 1; k >= 0; k -= 1) {
      const i = seq[k]!;
      const mn = i.mnemonic.toLowerCase();
      if (mn === "jsr") { const c = ra.calls.find((x) => x.instr.address === i.address); if (!c || c.callee.kind === "unknown" || c.callee.defs.includes(loc)) return { source: "callee", from: c?.to ?? c?.callee.id, site: siteOf(i) }; continue; }
      const w = memLoc(o, i, preAt.get(i.address) ?? entryState()).write;
      const extra = o.extraDefs.get(i.address) ?? [];
      if (!w.includes(loc) && !extra.includes(loc)) continue;
      const site = siteOf(i);
      const stored: Loc | undefined = mn === "sta" ? "A" : mn === "stx" ? "X" : mn === "sty" ? "Y" : undefined;
      const isOp = loc.startsWith("op:");
      if (stored) {
        const src = regSource(stored, k, 1);
        if (src.source === "imm") return { source: "imm", value: src.value, site, via: src.site };
        if (isOp) return { source: "op", from: loc, site };
        const m = loc.match(/^(?:zp|mem):\$([0-9A-F]+)/u);
        return { source: loc.startsWith("zp:") ? "zp" : "mem", from: m ? cellId(parseInt(m[1]!, 16)) : loc, site };
      }
      if (isOp) return { source: "op", from: loc, site };
      return { source: "unknown", site };
    }
    return { source: "unknown" };
  };
  const stackSource = (k: number, upto: number): ArgEvidence => {
    // S+3 is the most recent push before the jsr, S+4 the one before it
    let want = k - 2;
    for (let j = upto - 1; j >= 0 && want > 0; j -= 1) {
      const i = seq[j]!;
      const mn = i.mnemonic.toLowerCase();
      if (mn === "pha" || mn === "php") {
        want -= 1;
        if (want === 0) {
          if (mn === "php") return { source: "flag", site: siteOf(i) };
          const src = regSource("A", j, 1);
          if (src.source === "imm") return { source: "imm", value: src.value, site: siteOf(i), via: src.site };
          return { source: "reg", from: "A", site: siteOf(i) };
        }
      } else if (mn === "pla" || mn === "plp") want += 1;
    }
    return { source: "unknown" };
  };
  const upto = seq.length;
  const args: Record<string, ArgEvidence> = {};
  for (const loc of sortLocs(call.callee.in)) {
    if (loc === "A" || loc === "X" || loc === "Y") args[loc] = regSource(loc, upto, 1);
    else if (["C", "Z", "N", "V", "D", "I"].includes(loc)) args[loc] = flagSource(loc, upto);
    else if (/^S\+\d+$/u.test(loc)) args[loc] = stackSource(Number(loc.slice(2)), upto);
    else if (loc === "SP" || loc === "mem:?" || /\+[XY]$/u.test(loc)) continue; // a table family is consumed, never passed
    else args[loc] = memSource(loc, upto);
  }
  return args;
}

// ------------------------------------------------------------------ Tarjan

function tarjan(nodes: string[], edgesOf: (n: string) => string[]): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index += 1;
    stack.push(v); onStack.add(v);
    for (const w of edgesOf(v)) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      for (;;) { const w = stack.pop()!; onStack.delete(w); scc.push(w); if (w === v) break; }
      out.push(scc.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out; // reverse topological: callees before callers
}

// ------------------------------------------------------------------ the seed

export function seedSignatures(options: SeedSignaturesOptions): SeedSignaturesResult {
  const t0 = process.hrtime.bigint();
  const slug = options.slug ?? readProjectSlug(options.projectDir);
  const paths = options.analysisPath ? [options.analysisPath] : findAnalysisJsons(options.projectDir);
  if (paths.length === 0) throw new Error(`no _analysis.json under ${options.projectDir}`);
  let kb: PlatformKb | undefined;
  try { kb = new PlatformKb(options.platformDb); } catch { kb = undefined; }
  const store = GraphStore.open(options.projectDir);
  try {
    const owners = paths.map((p) => loadOwner(store, p, options.analysisPath ? options : { ...options, owner: undefined, ctx: undefined }, slug));
    const ownerById = new Map<string, OwnerCtx>();
    const routineOwner = new Map<string, { o: OwnerCtx; address: number }>();
    for (const o of owners) {
      ownerById.set(o.owner, o);
      for (const [a, id] of o.routineIds) routineOwner.set(id, { o, address: a });
    }
    const resolvesTo = store.db.prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'RESOLVES_TO' ORDER BY layer LIMIT 1");
    const storedSignature = store.db.prepare("SELECT evidence FROM edges WHERE from_id = ? AND to_id = ? AND type = 'SIGNATURE' AND layer = 'generated' LIMIT 1");
    const summaries = new Map<string, Signature>();

    /** the callee's id for a jsr target seen from an owner: this owner's routine, the ROM, another owner's routine via RESOLVES_TO */
    const calleeIdOf = (o: OwnerCtx, target: number): { id?: string; rom?: boolean; reason?: string } => {
      const own = o.routineIds.get(target);
      if (own) return { id: own };
      const undecodedOwn = o.nodeAt.get(target);
      if (undecodedOwn && undecodedOwn.includes(":routine:")) return { id: undecodedOwn, reason: `callee undecoded (${hex4(target)})` };
      const kind = platformKindForAddress(o.tag, target);
      if (kind === "rom" && !o.inImage(target)) return { id: derivePlatformId(o.tag, target), rom: true };
      let addrId: string | undefined;
      try { addrId = deriveProjectId({ slug: o.slug, ctx: { space: o.ctx.space }, kind: "addr", address: target }); } catch { addrId = undefined; }
      if (addrId) {
        const r = resolvesTo.get(addrId) as { to_id: string } | undefined;
        if (r && r.to_id.includes(":routine:")) return { id: r.to_id };
      }
      if (kind === "rom") return { id: derivePlatformId(o.tag, target), rom: true };
      return { reason: `callee unknown (${hex4(target)})` };
    };
    const calleeAt = (o: OwnerCtx, target: number, _site: Instruction): Callee => {
      const r = calleeIdOf(o, target);
      if (r.reason) return unknownCallee(r.reason, r.id);
      const id = r.id!;
      if (r.rom) {
        const abi = kb?.abi(o.tag, target);
        return abi ? calleeFromAbi(id, abi) : unknownCallee(`callee unknown (ROM ${hex4(target)} has no ABI row)`, id);
      }
      const s = summaries.get(id);
      if (s) return calleeFromSignature(id, s);
      if (routineOwner.has(id)) return emptySummary(id); // inside the SCC being iterated: the current (empty) iterate
      const row = storedSignature.get(id, id) as { evidence: string } | undefined;
      if (row) { try { return calleeFromSignature(id, JSON.parse(row.evidence) as Signature); } catch { /* fall through */ } }
      return unknownCallee(`callee unknown (${hex4(target)} has no signature)`, id);
    };

    // call graph over the loaded routines, for the SCC order
    const callTargets = new Map<string, string[]>();
    for (const [id, { o, address }] of routineOwner) {
      const ra = analyseRoutine(o, address, id, (oo, t) => { const r = calleeIdOf(oo, t); return r.id && routineOwner.has(r.id) ? emptySummary(r.id) : unknownCallee("pre-pass"); });
      const ts = new Set<string>();
      for (const c of ra.calls) { const r = calleeIdOf(o, c.target); if (r.id && routineOwner.has(r.id)) ts.add(r.id); }
      for (const d of ra.dispatches) { const r = calleeIdOf(o, d.target); if (r.id && routineOwner.has(r.id)) ts.add(r.id); }
      callTargets.set(id, [...ts].sort());
    }
    const sccs = tarjan([...routineOwner.keys()].sort(), (n) => callTargets.get(n) ?? []);
    const analyses = new Map<string, RoutineAnalysis>();
    let sccRounds = 0;
    for (const scc of sccs) {
      const recursive = scc.length > 1 || (callTargets.get(scc[0]!) ?? []).includes(scc[0]!);
      const rounds = recursive ? 8 : 1;
      for (let round = 0; round < rounds; round += 1) {
        sccRounds += 1;
        let stable = true;
        for (const id of scc) {
          const { o, address } = routineOwner.get(id)!;
          const ra = analyseRoutine(o, address, id, calleeAt);
          const prev = summaries.get(id);
          const same = prev !== undefined && JSON.stringify(prev) === JSON.stringify(ra.signature);
          if (!same) stable = false;
          summaries.set(id, ra.signature);
          analyses.set(id, ra);
        }
        if (stable) break;
        if (recursive && round === rounds - 1) {
          for (const id of scc) { const ra = analyses.get(id)!; if (!ra.signature.partial) ra.signature.partial = { because: "recursion did not converge", site: hex4(ra.address) }; summaries.set(id, ra.signature); }
        }
      }
    }

    // ---- write per owner
    const results: SeedSignaturesOwnerResult[] = [];
    let total = { routines: 0, signed: 0, partial: 0, unknownStack: 0, passes: 0, dispatches: 0 };
    for (const o of owners) {
      const t1 = process.hrtime.bigint();
      const nodes: NodeInput[] = [];
      const nodeIds = new Set<string>();
      const edges: EdgeInput[] = [];
      const edgeKeys = new Set<string>();
      const addEdge = (e: EdgeInput) => { const k = `${e.from}|${e.type}|${e.to}|${e.evidenceKey ?? ""}`; if (edgeKeys.has(k)) return; edgeKeys.add(k); edges.push(e); };
      const r = { owner: o.owner, routines: 0, signed: 0, partial: 0, unknownStack: 0, passes: 0, dispatches: 0, ms: 0 };
      for (const [address, id] of [...o.routineIds].sort((a, b) => a[0] - b[0])) {
        const ra = analyses.get(id);
        if (!ra) continue;
        r.routines += 1;
        const sig = ra.signature;
        if (sig.partial) r.partial += 1; else r.signed += 1;
        if (sig.stack.unknown) r.unknownStack += 1;
        addEdge({ from: id, type: "SIGNATURE", to: id, evidenceKey: "", origin: "static", confidence: sig.partial ? "inferred" : "certain", evidence: sig as unknown as Record<string, unknown> });
        for (const call of ra.calls) {
          if (!call.to) continue;
          const args = argsAt(o, ra, call, kb);
          const inline = call.callee.readsReturnAddress;
          if (Object.keys(args).length === 0 && !inline) continue;
          const ev: Record<string, unknown> = { site: siteOf(call.instr), source_address: call.instr.address, instruction: renderInstruction(call.instr), args };
          if (inline) ev.inline_args = true;
          if (call.callee.kind === "unknown") ev.callee_unknown = true;
          addEdge({ from: id, type: "PASSES", to: call.to, evidenceKey: `src:${key4(call.instr.address)}`, origin: "static", confidence: call.callee.partial || call.callee.kind === "unknown" ? "inferred" : "certain", evidence: ev });
          r.passes += 1;
        }
        for (const d of ra.dispatches) {
          let to = o.nodeAt.get(d.target);
          if (!to) {
            const rom = platformKindForAddress(o.tag, d.target) === "rom" && !o.inImage(d.target);
            if (rom) to = derivePlatformId(o.tag, d.target);
            else {
              to = deriveProjectId({ slug: o.slug, ctx: { space: o.ctx.space }, kind: "addr", address: d.target });
              if (!nodeIds.has(to)) { nodeIds.add(to); nodes.push({ id: to, kind: "addr", name: null, attrs: {}, origin: "static", confidence: "inferred" }); }
            }
          }
          const pushed = [(d.target - 1) >> 8, (d.target - 1) & 0xff];
          addEdge({ from: id, type: "JUMPS_TO", to, evidenceKey: `src:${key4(d.instr.address)}`, origin: "static", confidence: "inferred", evidence: { via: "rts-dispatch", source_address: d.instr.address, instruction: "rts", pushed: pushed.map((b) => hex2(b)), target: hex4(d.target), routine: hex4(address) } });
          r.dispatches += 1;
        }
      }
      store.replaceGenerated(SIGNATURE_PRODUCER, o.owner, nodes, edges);
      r.ms = Number(process.hrtime.bigint() - t1) / 1e6;
      results.push(r);
      total = { routines: total.routines + r.routines, signed: total.signed + r.signed, partial: total.partial + r.partial, unknownStack: total.unknownStack + r.unknownStack, passes: total.passes + r.passes, dispatches: total.dispatches + r.dispatches };
    }
    return { owners: results, ...total, sccRounds, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } finally {
    store.close();
    kb?.close();
  }
}
