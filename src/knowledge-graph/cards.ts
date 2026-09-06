// Spec 823 D1 — the aggregates a tool needs, in the LIBRARY, never composed in
// a handler. Three consumers (CLI, UI, MCP) read one implementation: a node
// card, a neighbourhood walk, the shortest paths, the project overview.

import { isPlatformId } from "./ids.js";
import { CONTROL_FLOW_TYPES } from "./schema.js";
import type { EdgeHit, Graph, ResolvedNode } from "./query.js";

export type Direction = "in" | "out" | "both";
export type EdgeKind =
  | "calls" | "jumps" | "branches" | "reads" | "writes" | "references" | "calls_rom"
  | "uses_zp" | "uses_hardware" | "changes_banking" | "handles_irq" | "contains" | "indirect" | "any";
export type OriginFilter = "static" | "runtime" | "human" | "any";

const KIND_TYPES: Record<Exclude<EdgeKind, "any">, readonly string[]> = {
  calls: ["CALLS"],
  jumps: ["JUMPS_TO"],
  branches: ["BRANCHES_TO"],
  reads: ["READS", "READS_INDIRECT"],
  writes: ["WRITES", "WRITES_INDIRECT"],
  references: ["REFERENCES_DATA"],
  calls_rom: ["CALLS_ROM"],
  uses_zp: ["USES_ZP"],
  uses_hardware: ["USES_HARDWARE"],
  changes_banking: ["CHANGES_BANKING"],
  handles_irq: ["HANDLES_IRQ", "HANDLES_NMI"],
  contains: ["CONTAINS"],
  indirect: ["READS_INDIRECT", "WRITES_INDIRECT"],
};

export function typesForKind(kind: EdgeKind | undefined): readonly string[] | undefined {
  if (!kind || kind === "any") return undefined;
  return KIND_TYPES[kind];
}

function originMatches(e: EdgeHit, origin: OriginFilter | undefined): boolean {
  if (!origin || origin === "any") return true;
  if (origin === "human") return e.layer === "human";
  return e.origin === origin;
}

/** A ref is an id, an address (`$D018`, `d018`, `bank:07:$8000`) or a name. */
export function resolveRef(graph: Graph, ref: string, bank?: number): ResolvedNode[] {
  const text = ref.trim();
  const banked = text.match(/^bank:([0-9a-f]{1,4}):(\$?[0-9a-f]{1,4})$/iu);
  if (banked) return graph.nodesAt({ address: parseInt(banked[2]!.replace("$", ""), 16), bank: parseInt(banked[1]!, 16) });
  if (text.includes(":")) {
    const n = graph.resolve(text);
    return n.dangling ? [] : [n];
  }
  let nodes = graph.find(text);
  if (bank !== undefined) nodes = nodes.filter((n) => n.bank === bank || n.platform);
  return nodes;
}

export interface NodeCard {
  id: string;
  kind: string;
  address: string;
  range: string | null;
  bank: number | null;
  owner: string | null;
  platform: boolean;
  dangling: boolean;
  generatedLabel: string | null;
  humanName: string | null;
  layers: string[];
  orphaned: boolean;
  confidence?: string;
  attrs: Record<string, unknown>;
  subsystems: string[];
  edgeCounts: { in: Record<string, number>; out: Record<string, number> };
  hardware: string[];
  rom: string[];
  zeroPage: string[];
  runtime: { observed: boolean; edges: number; runs: string[] };
  next: Array<{ tool: string; args: Record<string, unknown> }>;
}

const hex = (a: number) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;

export function nodeCard(graph: Graph, node: ResolvedNode): NodeCard {
  const ins = node.platform || node.dangling ? graph.edgesInto(node.id) : graph.edgesInto(node.id);
  const outs = node.platform || node.dangling ? [] : graph.edgesOutOf(node.id);
  const count = (edges: EdgeHit[]) => {
    const c: Record<string, number> = {};
    for (const e of edges) c[e.type] = (c[e.type] ?? 0) + 1;
    return c;
  };
  const labelOf = (e: EdgeHit) => e.toNode.symbol ? `${hex(e.toNode.address)} ${e.toNode.symbol}` : hex(e.toNode.address);
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const runtime = [...ins, ...outs].filter((e) => e.origin === "runtime");
  const runs = uniq(runtime.map((e) => String(e.evidence.run_id ?? "")).filter(Boolean));
  // the generated label and the human name, separately (823 tool table)
  const rows = graph.store.db.prepare("SELECT layer, name FROM nodes WHERE id = ?").all(node.id) as Array<{ layer: string; name: string | null }>;
  const generatedLabel = node.platform ? node.name : rows.find((r) => r.layer === "generated")?.name ?? null;
  const humanName = rows.find((r) => r.layer === "human")?.name ?? null;
  const subsystems = ins.filter((e) => e.type === "CONTAINS" && /:sub:/.test(e.from)).map((e) => e.from);
  const next: NodeCard["next"] = [];
  if (ins.some((e) => CONTROL_FLOW_TYPES.includes(e.type as never))) next.push({ tool: "graph_edges", args: { ref: node.id, direction: "in", kind: "calls" } });
  if (outs.some((e) => e.type === "WRITES" || e.type === "READS")) next.push({ tool: "graph_edges", args: { ref: node.id, direction: "out", kind: "writes" } });
  if (outs.some((e) => e.type.endsWith("_INDIRECT"))) next.push({ tool: "graph_edges", args: { ref: node.id, direction: "out", kind: "indirect" } });
  return {
    id: node.id,
    kind: node.kind,
    address: hex(node.address),
    range: node.endAddress !== null && node.endAddress !== node.address ? `${hex(node.address)}-${hex(node.endAddress)}` : null,
    bank: node.bank,
    owner: node.owner,
    platform: node.platform,
    dangling: node.dangling,
    generatedLabel,
    humanName,
    layers: node.layers,
    orphaned: node.orphaned,
    confidence: node.confidence,
    attrs: node.attrs,
    subsystems,
    edgeCounts: { in: count(ins), out: count(outs) },
    hardware: uniq(outs.filter((e) => e.type === "USES_HARDWARE").map(labelOf)),
    rom: uniq(outs.filter((e) => e.type === "CALLS_ROM").map(labelOf)),
    zeroPage: uniq(outs.filter((e) => e.type === "USES_ZP").map(labelOf)),
    runtime: { observed: runtime.length > 0, edges: runtime.length, runs },
    next,
  };
}

export interface WalkOptions {
  direction?: Direction;
  kind?: EdgeKind;
  origin?: OriginFilter;
  depth?: 1 | 2;
  limit?: number;
}

export interface Walk {
  ref: string;
  roots: string[];
  direction: Direction;
  kind: EdgeKind;
  origin: OriginFilter;
  depth: number;
  edges: EdgeHit[];
  total: number;
  truncated: boolean;
}

export function edgesWalk(graph: Graph, roots: ResolvedNode[], options: WalkOptions = {}): Walk {
  const direction = options.direction ?? "out";
  const kind = options.kind ?? "any";
  const origin = options.origin ?? "any";
  const depth = options.depth ?? 1;
  const limit = Math.min(options.limit ?? 25, 200);
  const types = typesForKind(kind);
  const seen = new Set<string>();
  const out: EdgeHit[] = [];
  let frontier = roots.map((r) => r.id);
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const hits = [
        ...(direction !== "out" ? graph.edgesInto(id, types) : []),
        ...(direction !== "in" ? graph.edgesOutOf(id, types) : []),
      ].filter((e) => originMatches(e, origin));
      for (const e of hits) {
        const k = `${e.from}|${e.type}|${e.to}|${e.evidenceKey}|${e.layer}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(e);
        next.push(direction === "in" ? e.from : e.to);
      }
    }
    frontier = next;
  }
  return { ref: roots.map((r) => r.id).join(","), roots: roots.map((r) => r.id), direction, kind, origin, depth, edges: out.slice(0, limit), total: out.length, truncated: out.length > limit };
}

export interface PathResult {
  from: string;
  to: string;
  via: string;
  path: EdgeHit[] | undefined;
  frontier: number;
}

export function shortestPath(graph: Graph, from: string, to: string, via: "calls" | "calls+jumps" | "any" = "any", maxDepth = 8): PathResult {
  const types = via === "calls" ? ["CALLS", "CALLS_ROM"] : via === "calls+jumps" ? ["CALLS", "CALLS_ROM", "JUMPS_TO"] : [...CONTROL_FLOW_TYPES];
  const path = graph.path(from, to, { types, maxDepth });
  let frontier = 0;
  if (!path) {
    const seen = new Set<string>([from]);
    let fr = [from];
    for (let d = 0; d < maxDepth && fr.length; d += 1) {
      const next: string[] = [];
      for (const id of fr) for (const e of graph.edgesOutOf(id, types)) if (!seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
      fr = next;
    }
    frontier = seen.size - 1;
  }
  return { from, to, via, path, frontier };
}

export type Focus = "entries" | "irq" | "banking" | "hardware" | "rom" | "zp" | "subsystems" | "unknown" | "all";

export interface OverviewSection {
  id: string;
  label: string;
  count: number;
  top: Array<{ id: string; name: string | null; count: number }>;
}

export function overview(graph: Graph, focus: Focus = "all", topN = 10): OverviewSection[] {
  const db = graph.store.db;
  const want = (f: Focus) => focus === "all" || focus === f;
  const sections: OverviewSection[] = [];
  const groupTo = (types: string[], label: string, id: string) => {
    const rows = db.prepare(
      `SELECT to_id AS id, COUNT(*) AS n FROM edges WHERE type IN (${types.map(() => "?").join(",")}) AND layer = 'generated' GROUP BY to_id ORDER BY n DESC, to_id`,
    ).all(...types) as Array<{ id: string; n: number }>;
    sections.push({ id, label, count: rows.length, top: rows.slice(0, topN).map((r) => ({ id: r.id, name: graph.resolve(r.id).name, count: Number(r.n) })) });
  };
  if (want("entries")) {
    const rows = db.prepare("SELECT id, name FROM nodes WHERE kind = 'routine' AND layer = 'generated' AND json_extract(attrs, '$.entry_source') IS NOT NULL ORDER BY id").all() as Array<{ id: string; name: string | null }>;
    sections.push({ id: "entries", label: "Entry points", count: rows.length, top: rows.slice(0, topN).map((r) => ({ id: r.id, name: graph.resolve(r.id).name ?? r.name, count: 1 })) });
  }
  if (want("irq")) {
    const rows = db.prepare("SELECT to_id AS id, type FROM edges WHERE type IN ('HANDLES_IRQ','HANDLES_NMI') ORDER BY type, to_id").all() as Array<{ id: string; type: string }>;
    sections.push({ id: "irq", label: "IRQ / NMI handlers (runtime-observed)", count: rows.length, top: rows.slice(0, topN).map((r) => ({ id: r.id, name: `${r.type} ${graph.resolve(r.id).name ?? ""}`.trim(), count: 1 })) });
  }
  if (want("banking")) {
    const targets = ["c64:zp:0001", "c64:io:dd00", "c64:io:de00", "c64:io:de02"];
    const rows = db.prepare("SELECT from_id AS id, to_id, COUNT(*) AS n FROM edges WHERE type = 'WRITES' AND to_id IN (?,?,?,?) GROUP BY from_id, to_id ORDER BY n DESC").all(...targets) as Array<{ id: string; to_id: string; n: number }>;
    sections.push({ id: "banking", label: "Banking sites (writes to $01 / $DD00 / $DE00 / $DE02)", count: rows.length, top: rows.slice(0, topN).map((r) => ({ id: r.id, name: `${graph.resolve(r.id).name ?? ""} → ${r.to_id}`.trim(), count: Number(r.n) })) });
  }
  if (want("hardware")) groupTo(["USES_HARDWARE"], "Hardware registers by users", "hardware");
  if (want("rom")) groupTo(["CALLS_ROM"], "KERNAL / BASIC dependencies", "rom");
  if (want("zp")) groupTo(["USES_ZP"], "Zero page, hottest first", "zp");
  if (want("subsystems")) {
    const rows = db.prepare("SELECT id, name FROM nodes WHERE kind = 'subsystem' ORDER BY id").all() as Array<{ id: string; name: string | null }>;
    sections.push({ id: "subsystems", label: "Subsystems", count: rows.length, top: rows.slice(0, topN).map((r) => ({ id: r.id, name: r.name, count: graph.edgesOutOf(r.id, ["CONTAINS"]).length })) });
  }
  if (want("unknown")) {
    const rows = db.prepare("SELECT to_id AS id, COUNT(*) AS n FROM edges WHERE type IN ('READS_INDIRECT','WRITES_INDIRECT') AND layer = 'generated' GROUP BY to_id ORDER BY n DESC, to_id").all() as Array<{ id: string; n: number }>;
    const resolved = Number((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type IN ('READS','WRITES') AND origin = 'runtime'").get() as { n: number }).n);
    sections.push({ id: "unknown", label: `Indirect accesses with no runtime resolution (${resolved} runtime rows exist)`, count: rows.reduce((a, r) => a + Number(r.n), 0), top: rows.slice(0, topN).map((r) => ({ id: r.id, name: graph.resolve(r.id).name, count: Number(r.n) })) });
  }
  return sections;
}

export function isPlatform(id: string): boolean {
  return isPlatformId(id);
}
