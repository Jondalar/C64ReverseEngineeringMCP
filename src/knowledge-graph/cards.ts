// Spec 823 D1 — the aggregates a tool needs, in the LIBRARY, never composed in
// a handler. Three consumers (CLI, UI, MCP) read one implementation: a node
// card, a neighbourhood walk, the shortest paths, the project overview.

import { isPlatformId } from "./ids.js";
import { observedDomain } from "./query-runtime.js";
import { CONTROL_FLOW_TYPES } from "./schema.js";
import type { EdgeHit, Graph, ResolvedNode } from "./query.js";

/** 826 D7 — the routine's computed interface, locations as strings, on the card. */
export interface SignatureCard {
  in: string[];
  out: string[];
  clobbers: string[];
  preserves: string[];
  /** `balanced` · `unbalanced @$XXXX` · `unknown` */
  stack: string;
  /** `<because> @ <site>` when the summary is incomplete (826 D2), else null */
  partial: string | null;
  /** the human `abi` annotation, printed BESIDE the computed line, never merged (826 D8) */
  humanAbi: string | null;
}

/** 826 D6 — per register (or location): the static immediates / sources at the call sites, and what the runs passed. */
export type ArgsDomain = Record<string, { static: Record<string, number>; observed: Record<string, number> }>;

/** 826 D6 — one argument on a CALLS edge, joined from its sibling PASSES edge; `label` is the printable value or source. */
export interface WalkArg {
  source: string;
  label: string;
  site?: string;
}

/** An edge in a walk: the hit, plus the static call-site arguments when a PASSES sibling exists (826 D6). */
export type WalkEdge = EdgeHit & { args?: Record<string, WalkArg> };

/** Edge types that are presentation-joined onto the card / the CALLS line and not walked as edges of their own. */
const JOINED_TYPES = new Set(["SIGNATURE", "PASSES"]);

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
  /** 826 D7 — null unless a SIGNATURE row exists for the node */
  signature: SignatureCard | null;
  /** 826 D6 — null unless a PASSES or runtime CALLS row lands on the node */
  argsDomain: ArgsDomain | null;
  next: Array<{ tool: string; args: Record<string, unknown> }>;
}

const hex = (a: number) => `$${a.toString(16).toUpperCase().padStart(4, "0")}`;
const hex2 = (v: number) => `$${(v & 0xff).toString(16).toUpperCase().padStart(2, "0")}`;

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : x && typeof x === "object" && typeof (x as { loc?: unknown }).loc === "string" ? (x as { loc: string }).loc : String(x))) : []);

/** 826 D7 — read `evidence` of the routine's SIGNATURE self-edge (producer 826); defensive: the producer may not have run. */
function signatureOf(graph: Graph, node: ResolvedNode): SignatureCard | null {
  if (node.platform || node.dangling) return null;
  const ev = graph.edgesOutOf(node.id, ["SIGNATURE"])[0]?.evidence;
  const humanAbi = humanAbiOf(graph, node);
  if (!ev || typeof ev !== "object") return humanAbi ? { in: [], out: [], clobbers: [], preserves: [], stack: "unknown", partial: null, humanAbi } : null;
  const stackRaw = ev.stack as { delta?: unknown; balanced?: unknown; unbalanced_at?: unknown } | null | undefined;
  const nodeStack = (node.attrs.stack ?? {}) as { unbalanced_at?: unknown };
  let stack = "unknown";
  if (stackRaw && typeof stackRaw === "object") {
    if (stackRaw.balanced === true) stack = "balanced";
    else if (stackRaw.balanced === false) {
      const at = typeof stackRaw.unbalanced_at === "string" ? stackRaw.unbalanced_at : typeof nodeStack.unbalanced_at === "string" ? nodeStack.unbalanced_at : typeof nodeStack.unbalanced_at === "number" ? hex(nodeStack.unbalanced_at) : null;
      stack = at ? `unbalanced @${at}` : "unbalanced";
    }
  }
  const p = ev.partial as { because?: unknown; site?: unknown } | null | undefined;
  const partial = p && typeof p === "object" ? `${typeof p.because === "string" ? p.because : "partial"}${typeof p.site === "string" ? ` @ ${p.site}` : ""}` : null;
  return { in: strList(ev.in), out: strList(ev.out), clobbers: strList(ev.clobbers), preserves: strList(ev.preserves), stack, partial, humanAbi };
}

/** 826 D8 — the human `abi` line: an `abi` annotation on the node, else `attrs.abi` on the human row (the annotations.json door). */
function humanAbiOf(graph: Graph, node: ResolvedNode): string | null {
  try {
    const row = graph.store.db.prepare("SELECT body FROM annotations WHERE node_id = ? AND kind = 'abi' AND status = 'active' ORDER BY updated_at DESC LIMIT 1").get(node.id) as { body: string | null } | undefined;
    if (row?.body) return row.body;
  } catch { /* a graph without the 822 tables has no annotations */ }
  try {
    const row = graph.store.db.prepare("SELECT attrs FROM nodes WHERE id = ? AND layer = 'human'").get(node.id) as { attrs: string } | undefined;
    if (row) {
      const abi = (JSON.parse(row.attrs) as Record<string, unknown>).abi;
      if (typeof abi === "string" && abi.trim()) return abi;
    }
  } catch { /* no human row */ }
  return null;
}

/** The printable form of one PASSES argument (826 D6): `#$01` for an immediate, the cell's address for a load, the location otherwise. */
function argLabel(graph: Graph, a: Record<string, unknown>): WalkArg {
  const source = typeof a.source === "string" ? a.source : "unknown";
  const site = typeof a.site === "string" ? a.site : undefined;
  const from = typeof a.from === "string" ? a.from : undefined;
  let label = "?";
  if (source === "imm" && typeof a.value === "number") label = `#${hex2(a.value)}`;
  else if ((source === "mem" || source === "zp") && from) label = from.includes(":") ? hex(graph.resolve(from).address) : from;
  else if (source === "flag") label = /\bsec$/iu.test(site ?? "") ? "1" : /\bclc$/iu.test(site ?? "") ? "0" : "flag";
  else if (from) label = from;
  return site ? { source, label, site } : { source, label };
}

/** The domain key of one PASSES argument: `$01` for an immediate, the cell id for a load, `?` for unknown. */
function argKey(a: Record<string, unknown>): string {
  const source = typeof a.source === "string" ? a.source : "unknown";
  if (source === "imm" && typeof a.value === "number") return hex2(a.value);
  if (source === "flag") { const site = typeof a.site === "string" ? a.site : ""; return /\bsec$/iu.test(site) ? "1" : /\bclc$/iu.test(site) ? "0" : "flag"; }
  if (source === "unknown") return "?";
  return typeof a.from === "string" ? a.from : "?";
}

/** 826 D6 — static domain from the PASSES rows into the node, observed from the runtime CALLS rows. */
function argsDomainOf(graph: Graph, node: ResolvedNode): ArgsDomain | null {
  if (node.dangling) return null;
  const out: ArgsDomain = {};
  const slot = (reg: string) => (out[reg] ??= { static: {}, observed: {} });
  for (const e of graph.edgesInto(node.id, ["PASSES"])) {
    const args = e.evidence.args;
    if (!args || typeof args !== "object") continue;
    for (const [reg, a] of Object.entries(args as Record<string, unknown>)) {
      if (!a || typeof a !== "object") continue;
      const k = argKey(a as Record<string, unknown>);
      const s = slot(reg).static;
      s[k] = (s[k] ?? 0) + 1;
    }
  }
  for (const [reg, vals] of Object.entries(observedDomain(graph, node.id))) {
    const o = slot(reg).observed;
    for (const [v, c] of Object.entries(vals)) o[v] = (o[v] ?? 0) + c;
  }
  return Object.keys(out).length ? out : null;
}

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
    signature: signatureOf(graph, node),
    argsDomain: argsDomainOf(graph, node),
    next,
  };
}

export interface WalkOptions {
  direction?: Direction;
  kind?: EdgeKind;
  origin?: OriginFilter;
  /** hops; 823 uses 1 | 2, 825's `focus:` scope walks up to 4 */
  depth?: number;
  limit?: number;
}

export interface Walk {
  ref: string;
  roots: string[];
  direction: Direction;
  kind: EdgeKind;
  origin: OriginFilter;
  depth: number;
  edges: WalkEdge[];
  total: number;
  truncated: boolean;
}

export function edgesWalk(graph: Graph, roots: ResolvedNode[], options: WalkOptions = {}): Walk {
  const direction = options.direction ?? "out";
  const kind = options.kind ?? "any";
  const origin = options.origin ?? "any";
  const depth = options.depth ?? 1;
  const limit = Math.min(options.limit ?? 25, 200);
  const all = edgesWalkAll(graph, roots, options);
  return { ref: roots.map((r) => r.id).join(","), roots: roots.map((r) => r.id), direction, kind, origin, depth, edges: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

/**
 * The walk itself, UNLIMITED — 823's `edgesWalk` is this plus a slice, and
 * 825's `focus:` scope is this without one, so the two can never disagree
 * about which nodes a neighbourhood contains (825 §5).
 */
export function edgesWalkAll(graph: Graph, roots: ResolvedNode[], options: WalkOptions = {}): WalkEdge[] {
  const direction = options.direction ?? "out";
  const kind = options.kind ?? "any";
  const origin = options.origin ?? "any";
  const depth = options.depth ?? 1;
  const types = typesForKind(kind);
  const seen = new Set<string>();
  const out: WalkEdge[] = [];
  // 826 D6 — the static arguments of a CALLS edge live on a sibling PASSES edge with the
  // same (from, to, evidence_key); joined here so the formatter stays a formatter.
  const passesFrom = new Map<string, EdgeHit[]>();
  const argsFor = (e: EdgeHit): Record<string, WalkArg> | undefined => {
    if (e.type !== "CALLS") return undefined;
    let list = passesFrom.get(e.from);
    if (!list) { list = graph.edgesOutOf(e.from, ["PASSES"]); passesFrom.set(e.from, list); }
    const sib = list.find((p) => p.to === e.to && p.evidenceKey === e.evidenceKey);
    const raw = sib?.evidence.args;
    if (!raw || typeof raw !== "object") return undefined;
    const args: Record<string, WalkArg> = {};
    for (const [reg, a] of Object.entries(raw as Record<string, unknown>)) if (a && typeof a === "object") args[reg] = argLabel(graph, a as Record<string, unknown>);
    return Object.keys(args).length ? args : undefined;
  };
  let frontier = roots.map((r) => r.id);
  for (let d = 0; d < depth; d += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const hits = [
        ...(direction !== "out" ? graph.edgesInto(id, types) : []),
        ...(direction !== "in" ? graph.edgesOutOf(id, types) : []),
      ].filter((e) => originMatches(e, origin) && !JOINED_TYPES.has(e.type));
      for (const e of hits) {
        const k = `${e.from}|${e.type}|${e.to}|${e.evidenceKey}|${e.layer}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const args = argsFor(e);
        out.push(args ? { ...e, args } : e);
        next.push(direction === "in" ? e.from : e.to);
      }
    }
    frontier = next;
  }
  return out;
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

// ---------------------------------------------------------------- Spec 825 D1
// The BULK projection: the whole scope in one body, so a renderer builds ONE
// in-memory model and every view is a projection of it. Deliberately not a
// sixth MCP tool (825 §7) — an LLM does not want 11 000 nodes; a canvas does.

/** 825 D1 — 50 000 nodes is the "load anyway" threshold; above it the body says so and names the scopes that fit. */
export const SUBGRAPH_NODE_LIMIT = 50_000;

export interface SubgraphNode {
  id: string;
  kind: string;
  /** `$XXXX` */
  address: string;
  /** `$XXXX` when the node has an extent, else null */
  end: string | null;
  bank: number | null;
  owner: string | null;
  /** the GENERATED label */
  label: string | null;
  /** the HUMAN name — two fields, never merged (824 acceptance) */
  name: string | null;
  layers: string[];
  platform: boolean;
  dangling: boolean;
  /** store rows touching this node inside the subgraph */
  degree: number;
}

export interface SubgraphEdge {
  from: string;
  to: string;
  type: string;
  origin: string;
  layer: string;
  confidence: string;
  /** store rows collapsed into this edge */
  n: number;
}

export interface Subgraph {
  scope: string;
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  subsystems: Array<{ id: string; name: string | null; members: number }>;
  truncated: boolean;
  /** the scopes that fit when `truncated`, else empty */
  next: string[];
  counts: { nodes: number; edges: number; rows: number };
}

export interface SubgraphOptions {
  /** `all` · `owner:<stem>` · `bank:<n>` · `subsystem:<id|name>` · `focus:<ref>` */
  scope?: string;
  /** with `focus:` — BFS hops, 1–4, default 2 */
  depth?: number;
  /** node kinds to include; undefined = all */
  kinds?: string[];
  origin?: OriginFilter;
  /** 824's bank selector, forwarded to `resolveRef` */
  bank?: number;
}

/** A scope that names something the graph does not have — the route answers 404, not 400. */
export class SubgraphNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubgraphNotFound";
  }
}

interface StoreNode {
  kind: string;
  address: number;
  end: number | null;
  owner: string | null;
  bank: number | null;
  label: string | null;
  name: string | null;
  layers: string[];
}

interface RawEdge { from: string; type: string; to: string; layer: string; origin: string; confidence: string }

/** byte order, not locale order — the body has to hash the same on every machine */
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function parseScope(scope: string): { kind: "all" | "owner" | "bank" | "subsystem" | "focus"; arg: string } {
  const text = scope.trim() || "all";
  if (text === "all") return { kind: "all", arg: "" };
  const m = /^(owner|bank|subsystem|focus):(.+)$/su.exec(text);
  if (!m) throw new Error(`scope "${scope}" is not all | owner:<stem> | bank:<n> | subsystem:<id> | focus:<ref>`);
  return { kind: m[1] as "owner" | "bank" | "subsystem" | "focus", arg: m[2]!.trim() };
}

function readStoreNodes(graph: Graph): Map<string, StoreNode> {
  const rows = graph.store.db.prepare("SELECT id, layer, kind, address, end_address, name, owner, bank FROM nodes ORDER BY id, layer").all() as Array<{
    id: string; layer: string; kind: string; address: number; end_address: number | null; name: string | null; owner: string | null; bank: number | null;
  }>;
  const out = new Map<string, StoreNode>();
  for (const r of rows) {
    const cur = out.get(r.id);
    if (!cur) {
      out.set(r.id, {
        kind: r.kind, address: r.address, end: r.end_address, owner: r.owner, bank: r.bank,
        label: r.layer === "generated" ? r.name : null, name: r.layer === "human" ? r.name : null, layers: [r.layer],
      });
      continue;
    }
    if (r.layer === "generated") { cur.label = r.name; cur.kind = r.kind; cur.address = r.address; cur.owner = r.owner; cur.bank = r.bank; }
    else cur.name = r.name;
    if (r.end_address !== null) cur.end = r.end_address;
    if (!cur.layers.includes(r.layer)) cur.layers.push(r.layer);
  }
  for (const v of out.values()) v.layers.sort();
  return out;
}

function readEdges(graph: Graph): RawEdge[] {
  return graph.store.db.prepare("SELECT from_id AS \"from\", type, to_id AS \"to\", layer, origin, confidence FROM edges").all() as unknown as RawEdge[];
}

function edgeOriginMatches(e: RawEdge, origin: OriginFilter): boolean {
  if (origin === "any") return true;
  if (origin === "human") return e.layer === "human";
  return e.origin === origin;
}

/**
 * 825 D1 — the scope, whole: nodes with the generated label and the human name
 * apart, edges COLLAPSED per (from, to, type, origin, layer) with `n` = the
 * store rows behind them, every endpoint present (a platform id synthesised
 * from the platform KB, anything else flagged `dangling`), everything sorted
 * by id so the body hashes stably.
 */
export function subgraph(graph: Graph, options: SubgraphOptions = {}): Subgraph {
  const scopeText = (options.scope ?? "all").trim() || "all";
  const scope = parseScope(scopeText);
  const origin: OriginFilter = options.origin ?? "any";
  const kinds = options.kinds && options.kinds.length ? new Set(options.kinds) : undefined;
  const depth = Math.max(1, Math.min(4, Math.trunc(options.depth ?? 2)));

  const store = readStoreNodes(graph);
  const resolvedCache = new Map<string, ResolvedNode>();
  const resolved = (id: string): ResolvedNode => {
    let n = resolvedCache.get(id);
    if (!n) { n = graph.resolve(id); resolvedCache.set(id, n); }
    return n;
  };
  const kindOf = (id: string): string => store.get(id)?.kind ?? resolved(id).kind;
  const keepKind = (id: string): boolean => !kinds || kinds.has(kindOf(id));

  const allEdges = readEdges(graph);

  // ---- the core: what the scope names, before any edge pulls a neighbour in
  const core = new Set<string>();
  let walked: WalkEdge[] | undefined;
  if (scope.kind === "all") {
    for (const id of store.keys()) core.add(id);
  } else if (scope.kind === "owner") {
    if (!scope.arg) throw new Error("owner: needs an analysis stem");
    for (const [id, n] of store) if (n.owner === scope.arg) core.add(id);
  } else if (scope.kind === "bank") {
    const bank = /^(?:\$|0x)/iu.test(scope.arg) ? parseInt(scope.arg.replace(/^(?:\$|0x)/iu, ""), 16) : Number.parseInt(scope.arg, 10);
    if (!Number.isInteger(bank)) throw new Error(`bank "${scope.arg}" is not a number ($07, 0x07 or 7)`);
    for (const [id, n] of store) if (n.bank === bank) core.add(id);
  } else if (scope.kind === "subsystem") {
    const wanted = [...store.entries()].filter(([id, n]) => n.kind === "subsystem" && (id === scope.arg || n.name === scope.arg || id.endsWith(`:sub:${scope.arg}`))).map(([id]) => id);
    if (wanted.length === 0) throw new SubgraphNotFound(`no subsystem "${scope.arg}" — assign-subsystem is the door (822)`);
    for (const id of wanted) {
      core.add(id);
      for (const e of allEdges) {
        if (e.type === "CONTAINS" && e.from === id) core.add(e.to);
        if (e.type === "BELONGS_TO" && e.to === id) core.add(e.from);
      }
    }
  } else {
    const roots = resolveRef(graph, scope.arg, options.bank);
    if (roots.length === 0) throw new SubgraphNotFound(`no node for "${scope.arg}"`);
    walked = edgesWalkAll(graph, roots, { direction: "both", depth, origin });
    for (const r of roots) core.add(r.id);
    for (const e of walked) { core.add(e.from); core.add(e.to); }
  }
  for (const id of [...core]) if (!keepKind(id)) core.delete(id);

  if (core.size > SUBGRAPH_NODE_LIMIT) {
    const owners = new Map<string, number>();
    const banks = new Map<number, number>();
    for (const n of store.values()) {
      if (n.owner) owners.set(n.owner, (owners.get(n.owner) ?? 0) + 1);
      if (n.bank !== null) banks.set(n.bank, (banks.get(n.bank) ?? 0) + 1);
    }
    const next = [
      ...[...owners.entries()].filter(([, c]) => c <= SUBGRAPH_NODE_LIMIT).map(([o]) => `owner:${o}`),
      ...[...banks.entries()].filter(([, c]) => c <= SUBGRAPH_NODE_LIMIT).map(([b]) => `bank:${b}`),
    ].sort(byString);
    return { scope: scopeText, nodes: [], edges: [], subsystems: [], truncated: true, next, counts: { nodes: core.size, edges: 0, rows: 0 } };
  }

  // ---- the edges, collapsed. `all` takes every row; a narrowed scope takes
  //      every row with an END in the core, so what the scope touches is visible.
  const collapsed = new Map<string, SubgraphEdge>();
  const collapse = (e: RawEdge) => {
    const key = `${e.from} ${e.to} ${e.type} ${e.origin} ${e.layer}`;
    const cur = collapsed.get(key);
    if (cur) { cur.n += 1; if (e.confidence < cur.confidence) cur.confidence = e.confidence; return; }
    collapsed.set(key, { from: e.from, to: e.to, type: e.type, origin: e.origin, layer: e.layer, confidence: e.confidence, n: 1 });
  };
  if (walked) {
    for (const e of walked) {
      if (!keepKind(e.from) || !keepKind(e.to)) continue;
      collapse({ from: e.from, type: e.type, to: e.to, layer: e.layer, origin: e.origin, confidence: e.confidence });
    }
  } else {
    const inScope = scope.kind === "all" ? () => true : (e: RawEdge) => core.has(e.from) || core.has(e.to);
    for (const e of allEdges) {
      if (!edgeOriginMatches(e, origin) || !inScope(e) || !keepKind(e.from) || !keepKind(e.to)) continue;
      collapse(e);
    }
  }
  const edges = [...collapsed.values()].sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to) || byString(a.type, b.type) || byString(a.origin, b.origin) || byString(a.layer, b.layer));

  // ---- the nodes: the core plus every endpoint, so no edge dangles off-canvas
  const ids = new Set(core);
  const degree = new Map<string, number>();
  for (const e of edges) {
    ids.add(e.from);
    ids.add(e.to);
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.n);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.n);
  }
  const nodes: SubgraphNode[] = [...ids].sort(byString).map((id) => {
    const s = store.get(id);
    if (s) {
      return {
        id, kind: s.kind, address: hex(s.address), end: s.end !== null && s.end !== s.address ? hex(s.end) : null,
        bank: s.bank, owner: s.owner, label: s.label, name: s.name, layers: s.layers,
        platform: false, dangling: false, degree: degree.get(id) ?? 0,
      };
    }
    // no store row: the platform KB answers, or it is a dangling reference (D1)
    const r = resolved(id);
    return {
      id, kind: r.kind, address: hex(r.address), end: null, bank: r.bank, owner: r.owner,
      label: r.name, name: null, layers: r.dangling ? [] : r.layers,
      platform: r.platform, dangling: r.dangling, degree: degree.get(id) ?? 0,
    };
  });

  const subsystems = [...store.entries()].filter(([, n]) => n.kind === "subsystem").map(([id, n]) => {
    let members = 0;
    for (const e of allEdges) {
      if (e.type === "CONTAINS" && e.from === id && ids.has(e.to)) members += 1;
      else if (e.type === "BELONGS_TO" && e.to === id && ids.has(e.from)) members += 1;
    }
    return { id, name: n.name ?? n.label, members };
  }).sort((a, b) => byString(a.id, b.id));

  return {
    scope: scopeText,
    nodes,
    edges,
    subsystems,
    truncated: false,
    next: [],
    counts: { nodes: nodes.length, edges: edges.length, rows: edges.reduce((a, e) => a + e.n, 0) },
  };
}
