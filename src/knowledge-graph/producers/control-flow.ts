// Spec 819 — the first producer of project nodes: routines, labels and the
// control-flow edges, from the EXISTING discovery output (`_analysis.json`).
// No disassembler of its own; the report is the input and the producer is a
// pure function of it, which is what makes re-seeding idempotent (818 D6).
//
// 819 D1  routine  = entry point ∪ jsr target ∪ block-graph root, keyed at its
//                    address under the artifact's ctx; name = the disassembler's
//                    own deterministic label W<HEX4>
// 819 D2  extent   = reach over basicBlocks.successors, stopping at other
//                    routine starts; an attribute, never part of the id
// 819 D3  edges    = one per xref, typed by the INSTRUCTION, not the xref's
//                    `type` (the discovery tags every non-jsr/jmp absolute
//                    operand `branch`; a `sta $D011` is not a branch)
// 819 D4  CALLS_ROM to the platform's rom node; a target that is ALSO an
//                    in-image instruction (RAM under ROM) gets both edges,
//                    `inferred`, with the ambiguity named
// 819 D5  a target with no instruction: inside the image → routine with
//                    attrs.undecoded; outside → an `addr` node, dangling-visible

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { PlatformKb } from "../../platform-kb/read.js";
import type { PlatformTag } from "../../platform-kb/schema.js";
import { deriveProjectId, derivePlatformId, platformForCtx, type Ctx } from "../ids.js";
import { GraphStore, readProjectSlug, type EdgeInput, type NodeInput } from "../store.js";

const PRODUCER = "819";
const BRANCHES = new Set(["bcc", "bcs", "beq", "bne", "bmi", "bpl", "bvc", "bvs"]);

interface Instruction {
  address: number;
  mnemonic: string;
  addressingMode: string;
  operandText: string;
  targetAddress?: number;
  provenance: "confirmed_code" | "probable_code";
}
interface Xref { sourceAddress: number; targetAddress: number; type: string; mnemonic?: string }
interface Block { start: number; end: number; successors: number[] }
interface Report {
  mapping: { startAddress: number; endAddress: number };
  entryPoints?: Array<{ address: number; source?: string }>;
  codeAnalysis?: { entryPoints?: Array<{ address: number; source?: string }>; instructions: Instruction[]; basicBlocks: Block[]; xrefs: Xref[] };
  probableCodeAnalysis?: { instructions: Instruction[]; xrefs: Xref[] };
}

export interface SeedControlFlowOptions {
  projectDir: string;
  analysisPath: string;
  /** artifact stem, lowercased; default: `<file>_analysis.json` → `<file>` */
  owner?: string;
  /** default `{ space: "ram", owner }` */
  ctx?: Ctx;
  slug?: string;
  platformDb?: string;
}

export interface SeedControlFlowResult {
  owner: string;
  slug: string;
  ctx: Ctx;
  routines: number;
  labels: number;
  addrNodes: number;
  edges: Record<string, number>;
  ambiguousRomCalls: number;
  ms: number;
}

function hex4(a: number): string {
  return a.toString(16).toUpperCase().padStart(4, "0");
}

export function ownerFromAnalysisPath(analysisPath: string): string {
  return basename(analysisPath).replace(/_analysis\.json$/u, "").toLowerCase();
}

export function seedControlFlow(options: SeedControlFlowOptions): SeedControlFlowResult {
  const t0 = process.hrtime.bigint();
  const report = JSON.parse(readFileSync(options.analysisPath, "utf8")) as Report;
  const owner = options.owner ?? ownerFromAnalysisPath(options.analysisPath);
  const ctx: Ctx = options.ctx ?? { space: "ram", owner };
  const slug = options.slug ?? readProjectSlug(options.projectDir);
  const platformTag: PlatformTag = platformForCtx(ctx);
  let platform: PlatformKb | undefined;
  try { platform = new PlatformKb(options.platformDb); } catch { platform = undefined; }

  const code = report.codeAnalysis;
  const instructions = new Map<number, Instruction>();
  for (const i of code?.instructions ?? []) instructions.set(i.address, i);
  for (const i of report.probableCodeAnalysis?.instructions ?? []) if (!instructions.has(i.address)) instructions.set(i.address, i);
  const inImage = (a: number) => a >= report.mapping.startAddress && a <= report.mapping.endAddress;

  // ---- blocks: reach, containment, block-of-address
  const blocks = [...(code?.basicBlocks ?? [])].sort((a, b) => a.start - b.start);
  const blockByStart = new Map<number, Block>(blocks.map((b) => [b.start, b]));
  const blockOf = (a: number): Block | undefined => {
    let lo = 0, hi = blocks.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = blocks[mid]!;
      if (a < b.start) hi = mid - 1;
      else if (a > b.end) lo = mid + 1;
      else return b;
    }
    return undefined;
  };
  const successorOf = new Set<number>();
  for (const b of blocks) for (const s of b.successors) successorOf.add(s);

  // ---- routine starts (D1)
  const xrefs: Xref[] = [...(code?.xrefs ?? []), ...(report.probableCodeAnalysis?.xrefs ?? [])];
  const entries = new Map<number, string | undefined>();
  for (const e of [...(report.entryPoints ?? []), ...(code?.entryPoints ?? [])]) if (instructions.has(e.address)) entries.set(e.address, e.source);
  const callTargets = new Set<number>();
  const branchTargets = new Set<number>();
  for (const x of xrefs) {
    if (x.type === "fallthrough") continue;
    const src = instructions.get(x.sourceAddress);
    const mn = (x.mnemonic ?? src?.mnemonic ?? "").toLowerCase();
    if (mn === "jsr") callTargets.add(x.targetAddress);
    else if (BRANCHES.has(mn)) branchTargets.add(x.targetAddress);
  }
  const routineStarts = new Set<number>();
  for (const a of entries.keys()) routineStarts.add(a);
  for (const a of callTargets) if (instructions.has(a)) routineStarts.add(a);
  for (const b of blocks) if (!successorOf.has(b.start) && instructions.has(b.start)) routineStarts.add(b.start); // block-graph roots
  for (const a of branchTargets) if (callTargets.has(a) && instructions.has(a)) routineStarts.add(a);

  // ---- extents (D2): reach over successors, stop at other routine starts
  const reach = new Map<number, Set<number>>(); // routine start → block starts
  for (const start of routineStarts) {
    const seen = new Set<number>();
    const stack = [start];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      if (s !== start && routineStarts.has(s)) continue;
      const b = blockByStart.get(s);
      if (!b) continue;
      seen.add(s);
      for (const n of b.successors) stack.push(n);
    }
    reach.set(start, seen);
  }
  const extentEnd = (start: number): number => {
    let end = instructions.get(start) ? start : start;
    for (const s of reach.get(start) ?? []) end = Math.max(end, blockByStart.get(s)!.end);
    return end;
  };
  // container of a pc: the routine whose reach holds pc's block (first by address)
  const containerByBlock = new Map<number, number>();
  for (const start of [...routineStarts].sort((a, b) => a - b)) {
    for (const s of reach.get(start) ?? []) if (!containerByBlock.has(s)) containerByBlock.set(s, start);
  }
  const containerOf = (pc: number): number | undefined => {
    const b = blockOf(pc);
    if (b) return containerByBlock.get(b.start);
    // probable-code island: the nearest routine start at or before pc within the same owner
    let best: number | undefined;
    for (const s of routineStarts) if (s <= pc && (best === undefined || s > best)) best = s;
    return best;
  };

  // ---- labels (D1): jmp/branch targets that are not routines
  const labelStarts = new Set<number>();
  for (const x of xrefs) {
    if (x.type === "fallthrough") continue;
    const src = instructions.get(x.sourceAddress);
    const mn = (x.mnemonic ?? src?.mnemonic ?? "").toLowerCase();
    if ((mn === "jmp" && src?.addressingMode !== "ind") || BRANCHES.has(mn)) {
      if (instructions.has(x.targetAddress) && !routineStarts.has(x.targetAddress)) labelStarts.add(x.targetAddress);
    }
  }

  // ---- nodes
  const nodes: NodeInput[] = [];
  const nodeIds = new Set<string>();
  const routineId = (a: number) => deriveProjectId({ slug, ctx, kind: "routine", address: a });
  const labelId = (a: number) => deriveProjectId({ slug, ctx, kind: "label", address: a });
  const addrId = (a: number) => deriveProjectId({ slug, ctx: { space: ctx.space }, kind: "addr", address: a });
  const provenanceOf = (a: number) => instructions.get(a)?.provenance ?? "probable_code";
  const confidenceOf = (a: number) => (provenanceOf(a) === "confirmed_code" ? "certain" : "heuristic") as "certain" | "heuristic";

  const addNode = (n: NodeInput): string => {
    const id = n.id ?? deriveProjectId(n.parts!);
    if (!nodeIds.has(id)) { nodeIds.add(id); nodes.push(n); }
    return id;
  };
  for (const start of routineStarts) {
    const attrs: Record<string, unknown> = { provenance: provenanceOf(start) };
    const entrySource = entries.get(start);
    if (entries.has(start)) attrs.entry_source = entrySource ?? "unknown";
    addNode({ parts: { slug, ctx, kind: "routine", address: start }, kind: "routine", name: `W${hex4(start)}`, endAddress: extentEnd(start), attrs, origin: "static", confidence: confidenceOf(start) });
  }
  for (const start of labelStarts) {
    addNode({ parts: { slug, ctx, kind: "label", address: start }, kind: "label", name: `W${hex4(start)}`, attrs: { provenance: provenanceOf(start) }, origin: "static", confidence: confidenceOf(start) });
  }

  // ---- edges (D3/D4/D5)
  const edges: EdgeInput[] = [];
  const edgeKeys = new Set<string>();
  const counts: Record<string, number> = {};
  let ambiguous = 0;
  const addEdge = (e: EdgeInput) => {
    const key = `${e.from}|${e.type}|${e.to}|${e.evidenceKey ?? ""}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(e);
    counts[e.type] = (counts[e.type] ?? 0) + 1;
  };
  const targetNode = (target: number, viaJsr: boolean): string => {
    if (instructions.has(target)) return routineStarts.has(target) ? routineId(target) : labelStarts.has(target) ? labelId(target) : addNode({ parts: { slug, ctx, kind: "label", address: target }, kind: "label", name: `W${hex4(target)}`, attrs: {}, origin: "static", confidence: "inferred" });
    if (inImage(target)) {
      // inside the image, not decoded: a routine we could not follow (D5)
      return viaJsr
        ? addNode({ parts: { slug, ctx, kind: "routine", address: target }, kind: "routine", name: `W${hex4(target)}`, attrs: { undecoded: true }, origin: "static", confidence: "inferred" })
        : addNode({ parts: { slug, ctx, kind: "label", address: target }, kind: "label", name: `W${hex4(target)}`, attrs: { undecoded: true }, origin: "static", confidence: "inferred" });
    }
    return addNode({ parts: { slug, ctx: { space: ctx.space }, kind: "addr", address: target }, kind: "addr", name: null, attrs: {}, origin: "static", confidence: "inferred" });
  };

  for (const x of xrefs) {
    // 820.2 found this: discovery emits a `fallthrough` xref for every jsr
    // (source = the jsr, target = pc+3). Typed by the source's mnemonic that
    // became a CALLS edge to the return address — 330 phantom calls on
    // lnr_boot. Adjacency is not an 818 edge type; skip it.
    if (x.type === "fallthrough") continue;
    const src = instructions.get(x.sourceAddress);
    if (!src) continue;
    const mn = src.mnemonic.toLowerCase();
    const isJsr = mn === "jsr";
    const isJmp = mn === "jmp" && src.addressingMode !== "ind";
    const isBranch = BRANCHES.has(mn);
    if (!isJsr && !isJmp && !isBranch) continue; // memory operand mistyped `branch` — 820's
    const container = containerOf(x.sourceAddress);
    const from = container !== undefined ? routineId(container) : addNode({ parts: { slug, ctx: { space: ctx.space }, kind: "addr", address: x.sourceAddress }, kind: "addr", name: null, attrs: { ownerless: true }, origin: "static", confidence: "heuristic" });
    const confidence = src.provenance === "confirmed_code" ? "certain" : "heuristic";
    const evidence: Record<string, unknown> = {
      source_address: x.sourceAddress, mnemonic: mn, addressing_mode: src.addressingMode, operand: src.operandText,
      instruction: `${mn} ${src.operandText}`.trim(), provenance: src.provenance,
    };
    if (ctx.bank !== undefined) evidence.bank = ctx.bank;
    const key = `src:${x.targetAddress === undefined ? "" : hex4(x.sourceAddress).toLowerCase()}`;
    const target = x.targetAddress;

    if (isJsr) {
      const rom = platform?.node(platformTag, target);
      const romNode = rom && rom.kind === "rom" ? derivePlatformId(platformTag, target) : undefined;
      const inImageCode = instructions.has(target) || inImage(target);
      if (romNode && inImageCode) {
        // D4: two memories at one address — both edges, named ambiguity
        ambiguous += 1;
        const amb = { ...evidence, ambiguity: "ram-under-rom", candidates: [targetNode(target, true), romNode] };
        addEdge({ from, type: "CALLS", to: targetNode(target, true), evidenceKey: key, origin: "static", confidence: "inferred", evidence: amb });
        addEdge({ from, type: "CALLS_ROM", to: romNode, evidenceKey: key, origin: "static", confidence: "inferred", evidence: amb });
      } else if (romNode) {
        addEdge({ from, type: "CALLS_ROM", to: romNode, evidenceKey: key, origin: "static", confidence, evidence });
      } else {
        addEdge({ from, type: "CALLS", to: targetNode(target, true), evidenceKey: key, origin: "static", confidence, evidence });
      }
    } else if (isJmp) {
      addEdge({ from, type: "JUMPS_TO", to: targetNode(target, false), evidenceKey: key, origin: "static", confidence, evidence });
    } else {
      addEdge({ from, type: "BRANCHES_TO", to: targetNode(target, false), evidenceKey: key, origin: "static", confidence, evidence });
    }
  }

  // ---- containment (D2): every label reached from a routine
  for (const start of routineStarts) {
    const set = reach.get(start) ?? new Set<number>();
    for (const l of labelStarts) {
      const b = blockOf(l);
      if (b && set.has(b.start)) {
        addEdge({ from: routineId(start), type: "CONTAINS", to: labelId(l), evidenceKey: "", origin: "static", confidence: confidenceOf(l), evidence: {} });
      }
    }
  }

  // ---- write
  const store = GraphStore.open(options.projectDir);
  try {
    store.replaceGenerated(PRODUCER, owner, nodes, edges);
    if (platform) store.setMeta("platform_kb_revision", platform.meta().source_revision ?? "unknown");
  } finally {
    store.close();
    platform?.close();
  }

  return {
    owner, slug, ctx,
    routines: [...nodeIds].filter((id) => id.includes(":routine:")).length,
    labels: [...nodeIds].filter((id) => id.includes(":label:")).length,
    addrNodes: [...nodeIds].filter((id) => id.includes(":addr:")).length,
    edges: counts,
    ambiguousRomCalls: ambiguous,
    ms: Number(process.hrtime.bigint() - t0) / 1e6,
  };
}
