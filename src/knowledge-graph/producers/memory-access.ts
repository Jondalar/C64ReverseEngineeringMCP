// Spec 820 — the memory access graph: READS / WRITES / *_INDIRECT / USES_ZP /
// USES_HARDWARE / REFERENCES_DATA, from the EXISTING discovery output.
//
// 820 D1  one classification, from the instruction pools ram-state.ts and
//         c64-hardware.ts already walk: load/compare mnemonics → READS,
//         stores → WRITES, read-modify-write → both. `,x`/`,y` = the base is
//         stated (indexed=true), the reach is not.
// 820 D2  USES_ZP / USES_HARDWARE are DERIVED extra rows whose `to` is the
//         platform node — `$D018` is one node whoever writes it.
// 820 D3  the target of an indirect access is unknown, and unknown is a value:
//         the *_INDIRECT edge points at the POINTER (`c64:zp:0020`), evidence
//         carries `pointer_zp` and `target: "unknown"`. The built schema has
//         `to_id NOT NULL` (818), so "no target" is expressed as "the pointer is
//         the target", not as NULL. A same-routine construction with a constant
//         target adds a SECOND edge (READS/WRITES, `inferred`, `via_zp`); it
//         never replaces the first. 821 answers the unknown with origin=runtime.
// 820 D4  the routine is the `from`, the instruction is evidence.
// 820 D5  REFERENCES_DATA from what already names data: pointer xrefs on
//         segments, indirect-pointer constant targets, table bases, copy sources.
// 820 D6  idempotent: producer "820", replacement unit = the artifact stem.

import { readFileSync } from "node:fs";
import { PlatformKb } from "../../platform-kb/read.js";
import type { PlatformTag } from "../../platform-kb/schema.js";
import { deriveProjectId, derivePlatformId, platformForCtx, type Ctx } from "../ids.js";
import { platformKindForAddress } from "../../platform-kb/schema.js";
import { GraphStore, readProjectSlug, type EdgeInput, type NodeInput } from "../store.js";
import { ownerFromAnalysisPath } from "./control-flow.js";

const PRODUCER = "820";
const READ_MNEMONICS = new Set(["lda", "ldx", "ldy", "cmp", "cpx", "cpy", "adc", "sbc", "and", "ora", "eor", "bit"]);
const WRITE_MNEMONICS = new Set(["sta", "stx", "sty"]);
const RMW_MNEMONICS = new Set(["inc", "dec", "asl", "lsr", "rol", "ror"]);
const DIRECT_MODES = new Set(["zp", "zp,x", "zp,y", "abs", "abs,x", "abs,y"]);
const INDIRECT_MODES = new Set(["(zp),y", "(zp,x)"]);

interface Instruction {
  address: number;
  mnemonic: string;
  addressingMode: string;
  operandText: string;
  operandValue?: number;
  targetAddress?: number;
  isControlFlow?: boolean;
  provenance: "confirmed_code" | "probable_code";
}
interface Report {
  mapping: { startAddress: number; endAddress: number };
  codeAnalysis?: { instructions: Instruction[] };
  probableCodeAnalysis?: { instructions: Instruction[] };
  segments?: Array<{ xrefs?: Array<{ sourceAddress: number; targetAddress: number; type: string; operandText?: string }> }>;
  codeSemantics?: {
    indirectPointers?: Array<{ start: number; end: number; zeroPageBase: number; constantTarget?: number; provenance: string }>;
    tableUsages?: Array<{ instructionAddresses: number[]; tableBases: number[]; provenance: string }>;
    copyRoutines?: Array<{ start: number; end: number; sourceBases: number[]; destinationBases: number[]; provenance: string }>;
  };
}

export interface SeedMemoryAccessOptions {
  projectDir: string;
  analysisPath: string;
  owner?: string;
  ctx?: Ctx;
  slug?: string;
  platformDb?: string;
}

export interface SeedMemoryAccessResult {
  owner: string;
  edges: Record<string, number>;
  /** instruction-level classification, for the gate's "counts reconcile" */
  classified: { reads: number; writes: number; rmw: number; indirect: number; hardware: number; zp: number };
  indirectResolved: number;
  ms: number;
}

const hex4 = (a: number) => a.toString(16).toLowerCase().padStart(4, "0");

/** Every instruction's memory classification — exported so the gate can reconcile counts. */
export function classifyInstruction(i: Instruction): { kind: "read" | "write" | "rmw"; mode: "direct" | "indirect"; target?: number; pointer?: number; indexed: boolean } | undefined {
  const mn = i.mnemonic.toLowerCase();
  // NOT `isControlFlow`: discovery sets that flag on every instruction with an
  // absolute operand (`lda $D011` carries isControlFlow=true — 819 §1's typing
  // defect, seen from the other side). Control flow is decided by mnemonic;
  // the read/write/rmw sets exclude jsr/jmp/branches by construction.
  const kind = READ_MNEMONICS.has(mn) ? "read" : WRITE_MNEMONICS.has(mn) ? "write" : RMW_MNEMONICS.has(mn) ? "rmw" : undefined;
  if (!kind) return undefined;
  if (INDIRECT_MODES.has(i.addressingMode)) {
    if (i.operandValue === undefined) return undefined;
    return { kind, mode: "indirect", pointer: i.operandValue & 0xff, indexed: true };
  }
  if (!DIRECT_MODES.has(i.addressingMode)) return undefined;
  const target = i.targetAddress ?? i.operandValue;
  if (target === undefined) return undefined;
  return { kind, mode: "direct", target: target & 0xffff, indexed: i.addressingMode.endsWith(",x") || i.addressingMode.endsWith(",y") };
}

export function seedMemoryAccess(options: SeedMemoryAccessOptions): SeedMemoryAccessResult {
  const t0 = process.hrtime.bigint();
  const report = JSON.parse(readFileSync(options.analysisPath, "utf8")) as Report;
  const owner = options.owner ?? ownerFromAnalysisPath(options.analysisPath);
  const ctx: Ctx = options.ctx ?? { space: "ram", owner };
  const slug = options.slug ?? readProjectSlug(options.projectDir);
  const platformTag: PlatformTag = platformForCtx(ctx);
  let platform: PlatformKb | undefined;
  try { platform = new PlatformKb(options.platformDb); } catch { platform = undefined; }

  const instructions = new Map<number, Instruction>();
  for (const i of report.codeAnalysis?.instructions ?? []) instructions.set(i.address, i);
  for (const i of report.probableCodeAnalysis?.instructions ?? []) if (!instructions.has(i.address)) instructions.set(i.address, i);

  const store = GraphStore.open(options.projectDir);
  try {
    // ---- containment from 819's routines (D4): innermost routine holding pc
    const routines = store.db.prepare(
      "SELECT id, address, end_address FROM nodes WHERE layer = 'generated' AND kind = 'routine' AND run_owner = ? ORDER BY address",
    ).all(owner) as Array<{ id: string; address: number; end_address: number | null }>;
    const containerOf = (pc: number): string | undefined => {
      let best: { id: string; address: number } | undefined;
      for (const r of routines) {
        if (r.address <= pc && (r.end_address ?? r.address) >= pc && (!best || r.address > best.address)) best = r;
      }
      return best?.id;
    };

    const nodes: NodeInput[] = [];
    const nodeIds = new Set<string>();
    const addNode = (n: NodeInput): string => {
      const id = n.id ?? deriveProjectId(n.parts!);
      if (!nodeIds.has(id)) { nodeIds.add(id); nodes.push(n); }
      return id;
    };
    const addrNode = (address: number, attrs: Record<string, unknown> = {}): string =>
      addNode({ parts: { slug, ctx: { space: ctx.space }, kind: "addr", address }, kind: "addr", attrs, origin: "static", confidence: "inferred" });
    // The target of a direct access. Zero page, I/O and ROM belong to the
    // platform by definition — their id derives from the address alone, so
    // `$20` is one node whoever writes it, documented or not (undocumented →
    // a dangling platform id, visible, never a project-private copy). RAM is
    // the platform's only where the platform documents it ($0400 screen,
    // $0314 vectors); everything else is this project's address.
    const targetNode = (address: number): string => {
      const kind = platformKindForAddress(platformTag, address);
      if (kind !== "ram") return derivePlatformId(platformTag, address);
      const p = platform?.node(platformTag, address);
      return p ? p.id : addrNode(address);
    };
    const fromOf = (pc: number): string => containerOf(pc) ?? addrNode(pc, { ownerless: true });

    const edges: EdgeInput[] = [];
    const keys = new Set<string>();
    const counts: Record<string, number> = {};
    const addEdge = (e: EdgeInput) => {
      const k = `${e.from}|${e.type}|${e.to}|${e.evidenceKey ?? ""}`;
      if (keys.has(k)) return;
      keys.add(k);
      edges.push(e);
      counts[e.type] = (counts[e.type] ?? 0) + 1;
    };

    const classified = { reads: 0, writes: 0, rmw: 0, indirect: 0, hardware: 0, zp: 0 };
    let indirectResolved = 0;
    const constructions = (report.codeSemantics?.indirectPointers ?? []).filter((c) => c.constantTarget !== undefined);

    for (const i of [...instructions.values()].sort((a, b) => a.address - b.address)) {
      const c = classifyInstruction(i);
      if (!c) continue;
      const mn = i.mnemonic.toLowerCase();
      const from = fromOf(i.address);
      const confidence = i.provenance === "confirmed_code" ? "certain" : "inferred";
      const key = `src:${hex4(i.address)}`;
      // zero-page and indirect modes carry no operandText in the report; render it
      const operand = i.operandText || (i.operandValue !== undefined ? `$${i.operandValue.toString(16).toUpperCase().padStart(2, "0")}` : "");
      const rendered = i.addressingMode === "(zp),y" ? `(${operand}),y` : i.addressingMode === "(zp,x)" ? `(${operand},x)` : i.addressingMode.endsWith(",x") ? `${operand},x` : i.addressingMode.endsWith(",y") ? `${operand},y` : operand;
      const evidence: Record<string, unknown> = {
        source_address: i.address, mnemonic: mn, addressing_mode: i.addressingMode, operand,
        instruction: `${mn} ${rendered}`.trim(), provenance: i.provenance, indexed: c.indexed,
      };
      if (ctx.bank !== undefined) evidence.bank = ctx.bank;
      const types = c.kind === "read" ? ["READS"] : c.kind === "write" ? ["WRITES"] : ["READS", "WRITES"];
      if (c.kind === "read") classified.reads += 1; else if (c.kind === "write") classified.writes += 1; else classified.rmw += 1;

      if (c.mode === "indirect") {
        classified.indirect += 1;
        const zpLo = derivePlatformId(platformTag, c.pointer!);
        const zpHi = derivePlatformId(platformTag, (c.pointer! + 1) & 0xff);
        const ev = { ...evidence, pointer_zp: c.pointer, target: "unknown" };
        for (const t of types) addEdge({ from, type: `${t}_INDIRECT`, to: zpLo, evidenceKey: key, origin: "static", confidence: "heuristic", evidence: ev });
        addEdge({ from, type: "USES_ZP", to: zpLo, evidenceKey: key, origin: "static", confidence, evidence: { ...evidence, role: "pointer_base" } });
        addEdge({ from, type: "USES_ZP", to: zpHi, evidenceKey: key, origin: "static", confidence, evidence: { ...evidence, role: "pointer_base" } });
        classified.zp += 1;
        // D3 second edge: a same-routine construction with a constant target
        const routine = routines.find((r) => r.id === from);
        const built = routine ? constructions.find((k) => k.zeroPageBase === c.pointer && k.start >= routine.address && k.end <= (routine.end_address ?? routine.address)) : undefined;
        if (built) {
          indirectResolved += 1;
          for (const t of types) addEdge({ from, type: t, to: targetNode(built.constantTarget!), evidenceKey: key, origin: "static", confidence: "inferred", evidence: { ...evidence, via_zp: c.pointer, constructed_at: built.start } });
        }
        continue;
      }

      const target = c.target!;
      const to = targetNode(target);
      for (const t of types) addEdge({ from, type: t, to, evidenceKey: key, origin: "static", confidence, evidence });
      if (target < 0x100) {
        classified.zp += 1;
        addEdge({ from, type: "USES_ZP", to: derivePlatformId(platformTag, target), evidenceKey: key, origin: "static", confidence, evidence: { ...evidence, role: c.indexed ? "indexed_base" : "direct" } });
      } else if (platformTag === "c64" ? target >= 0xd000 && target <= 0xdfff : target >= 0x1800 && target <= 0x1c0f) {
        classified.hardware += 1;
        addEdge({ from, type: "USES_HARDWARE", to: derivePlatformId(platformTag, target), evidenceKey: key, origin: "static", confidence, evidence });
      }
    }

    // ---- D5 REFERENCES_DATA
    const dataRef = (pc: number, target: number, source: string, extra: Record<string, unknown> = {}) => {
      const from = fromOf(pc);
      const to = platform?.node(platformTag, target)?.id ?? addrNode(target, { role: "data" });
      addEdge({ from, type: "REFERENCES_DATA", to, evidenceKey: `src:${hex4(pc)}`, origin: "static", confidence: "inferred", evidence: { source_address: pc, source, ...extra } });
    };
    for (const seg of report.segments ?? []) for (const x of seg.xrefs ?? []) if (x.type === "pointer") dataRef(x.sourceAddress, x.targetAddress, "segment-pointer-xref", { operand: x.operandText });
    for (const k of constructions) dataRef(k.start, k.constantTarget!, "indirect-pointer-construction", { zeroPageBase: k.zeroPageBase });
    for (const t of report.codeSemantics?.tableUsages ?? []) for (const base of t.tableBases) for (const pc of t.instructionAddresses.slice(0, 1)) dataRef(pc, base, "table-usage");
    for (const c of report.codeSemantics?.copyRoutines ?? []) for (const base of c.sourceBases.slice(0, 4)) dataRef(c.start, base, "copy-routine-source");

    store.replaceGenerated(PRODUCER, owner, nodes, edges);
    return { owner, edges: counts, classified, indirectResolved, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } finally {
    store.close();
    platform?.close();
  }
}
