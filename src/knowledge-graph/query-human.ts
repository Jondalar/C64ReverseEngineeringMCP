// Spec 822 D10 — query extensions over 818's Graph: the human layer, the prose,
// the subsystems. Library functions; 823 exposes them (graph_find origin=human,
// graph_node). Read-only: every statement here is a SELECT on the store's db.
//
//   searchAnnotations(graph, text, { layer })   FTS5 over `annotations`, LIKE when the build lacks FTS5
//   annotations(graph, id)                       stored prose + claims + evidence, then the 740.1 doc sections at the address (D8)
//   subsystem(graph, name)                       members + the registers / zero page they touch, derived at query time (D7)
//   layer filter helpers                         'human' | 'generated' | 'all' — human shadows generated (D1); 'generated' returns the other

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_RELPATH, type ProjectSearchIndex } from "../project-knowledge/project-search.js";
import { deriveSubsystemId, isPlatformId, parseId } from "./ids.js";
import { textIndexOf, type AnnotationRow, type ClaimRow, type EvidenceRow, type TextIndex } from "./migrate/schema-822.js";
import type { Graph, ResolvedNode } from "./query.js";
import type { Layer, NodeRow } from "./schema.js";
import { readProjectSlug } from "./store.js";

export type LayerFilter = Layer | "all";

export interface AnnotationHit extends AnnotationRow {
  node?: ResolvedNode;
  rank?: number;
}

export interface DocSection {
  id: string;
  title: string;
  snippet: string;
  sourcePath: string;
  sourceAnchor?: string;
}

export interface NodeAnnotations {
  node: ResolvedNode;
  annotations: AnnotationRow[];
  claims: ClaimRow[];
  evidence: EvidenceRow[];
  docs: DocSection[];
  docsIndex: "cache" | "absent";
}

export interface SubsystemView {
  node: ResolvedNode;
  members: ResolvedNode[];
  /** derived from the members' READS / WRITES / USES_* edges — the draft's USES without storing it */
  uses: { registers: ResolvedNode[]; zeroPage: ResolvedNode[]; other: ResolvedNode[] };
}

function has822(graph: Graph): boolean {
  const row = graph.store.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('annotations','claims','evidence')").get() as { n: number };
  return Number(row.n) === 3;
}

function projectDirOf(graph: Graph): string {
  return dirname(dirname(graph.store.path));
}

// ------------------------------------------------------------------ layer helpers

/** SQL fragment for a layer filter on a table that has a `layer` column. */
export function layerWhere(layer: LayerFilter, column = "layer"): { sql: string; params: string[] } {
  if (layer === "all") return { sql: "1 = 1", params: [] };
  return { sql: `${column} = ?`, params: [layer] };
}

/** Keep the nodes that have a row in the layer ('all' keeps everything). */
export function filterByLayer(nodes: ResolvedNode[], layer: LayerFilter): ResolvedNode[] {
  if (layer === "all") return nodes;
  return nodes.filter((n) => (n.platform ? layer === "generated" : n.layers.includes(layer)));
}

function rowToNode(row: NodeRow): ResolvedNode {
  return {
    id: row.id, kind: row.kind, name: row.name, address: row.address, endAddress: row.end_address, space: row.space, owner: row.owner, bank: row.bank,
    attrs: JSON.parse(row.attrs) as Record<string, unknown>, origin: row.origin, confidence: row.confidence, layers: [row.layer], orphaned: false, platform: false, dangling: false,
  };
}

/**
 * One layer of one id, unmerged — `generated` answers with the generated name
 * even where a human row shadows it (D1 "returned alongside only when the
 * caller asks"). 'all' is graph.resolve.
 */
export function resolveLayer(graph: Graph, id: string, layer: LayerFilter): ResolvedNode | undefined {
  if (layer === "all") { const n = graph.resolve(id); return n.dangling ? undefined : n; }
  if (isPlatformId(id)) return layer === "generated" ? graph.resolve(id) : undefined;
  const row = graph.store.db.prepare("SELECT * FROM nodes WHERE id = ? AND layer = ?").get(id, layer) as unknown as NodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

/** graph.find with a layer: 'human' → only nodes with a human row; 'generated' → the generated rows as they are. */
export function findWithLayer(graph: Graph, q: string, layer: LayerFilter): ResolvedNode[] {
  const merged = graph.find(q);
  if (layer === "all") return merged;
  if (layer === "human") return merged.filter((n) => n.layers.includes("human"));
  return merged.map((n) => (n.platform ? n : resolveLayer(graph, n.id, "generated"))).filter((n): n is ResolvedNode => Boolean(n));
}

// ------------------------------------------------------------------ prose

function ftsQuery(text: string): string {
  const tokens = text.match(/[\p{L}\p{N}_$.\-]+/gu) ?? [];
  return tokens.map((t) => `"${t.replace(/"/gu, "")}"`).join(" ");
}

export interface SearchOptions {
  layer?: LayerFilter;
  limit?: number;
  /** annotation kind prefix, e.g. `finding:` or `routine` */
  kind?: string;
}

/** Full-text search over annotations (title, body, name). Human shadows nothing here: prose is prose. */
export function searchAnnotations(graph: Graph, text: string, options: SearchOptions = {}): { hits: AnnotationHit[]; textIndex: TextIndex } {
  if (!has822(graph)) return { hits: [], textIndex: "like" };
  const db = graph.store.db;
  const layer = layerWhere(options.layer ?? "all", "a.layer");
  const limit = options.limit ?? 25;
  const kind = options.kind;
  const kindSql = kind ? "AND a.kind LIKE ?" : "";
  const kindParams = kind ? [`${kind}%`] : [];
  const textIndex = textIndexOf(db);
  let rows: Array<AnnotationRow & { rank?: number }> = [];
  const q = text.trim();
  if (!q) return { hits: [], textIndex };
  if (textIndex === "fts5") {
    const match = ftsQuery(q);
    if (match) {
      try {
        rows = db.prepare(
          `SELECT a.*, f.rank AS rank FROM annotations_fts f JOIN annotations a ON a.seq = f.rowid WHERE annotations_fts MATCH ? AND ${layer.sql} ${kindSql} ORDER BY f.rank, a.id LIMIT ?`,
        ).all(match, ...layer.params, ...kindParams, limit) as unknown as typeof rows;
      } catch {
        rows = [];
      }
    }
  }
  if (textIndex === "like" || rows.length === 0) {
    const like = `%${q}%`;
    rows = db.prepare(
      `SELECT a.* FROM annotations a WHERE (a.title LIKE ? OR a.body LIKE ? OR a.name LIKE ?) AND ${layer.sql} ${kindSql} ORDER BY a.id LIMIT ?`,
    ).all(like, like, like, ...layer.params, ...kindParams, limit) as unknown as typeof rows;
  }
  const hits: AnnotationHit[] = rows.map((r) => ({ ...r, node: r.node_id ? graph.resolve(r.node_id) : undefined }));
  return { hits, textIndex };
}

function docSectionsAt(projectDir: string, address: number): { docs: DocSection[]; docsIndex: "cache" | "absent" } {
  const cache = join(projectDir, CACHE_RELPATH);
  if (!existsSync(cache)) return { docs: [], docsIndex: "absent" };
  let index: ProjectSearchIndex;
  try { index = JSON.parse(readFileSync(cache, "utf8")) as ProjectSearchIndex; } catch { return { docs: [], docsIndex: "absent" }; }
  if (!Array.isArray(index.records)) return { docs: [], docsIndex: "absent" };
  const token = address.toString(16).toLowerCase().padStart(4, "0");
  const short = token.replace(/^00/u, "");
  const docs = index.records
    .filter((r) => (r.kind === "doc_section" || r.kind === "wiki_page") && Array.isArray(r.addrTokens) && (r.addrTokens.includes(token) || (short.length < 4 && r.addrTokens.includes(short))))
    .map((r) => ({ id: r.id, title: r.title, snippet: r.snippet, sourcePath: r.sourcePath, sourceAnchor: r.sourceAnchor }));
  return { docs, docsIndex: "cache" };
}

/**
 * Everything said about one node: the stored annotations (human first), the
 * claims, the evidence rows under the node and its claims, and — computed, not
 * stored (D8) — the 740.1 doc sections whose addrTokens carry its address.
 */
export function annotations(graph: Graph, id: string): NodeAnnotations {
  const node = graph.resolve(id);
  if (!has822(graph)) return { node, annotations: [], claims: [], evidence: [], docs: [], docsIndex: "absent" };
  const db = graph.store.db;
  const rows = db.prepare("SELECT * FROM annotations WHERE node_id = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END, kind, title").all(id) as unknown as AnnotationRow[];
  const claims = db.prepare("SELECT * FROM claims WHERE node_id = ? ORDER BY claim, layer").all(id) as unknown as ClaimRow[];
  const evidence = db.prepare(
    "SELECT * FROM evidence WHERE (target_table = 'nodes' AND target_key = ?) OR (target_table = 'claims' AND target_key LIKE ?) ORDER BY captured_at DESC, legacy_id",
  ).all(id, `${id}|%`) as unknown as EvidenceRow[];
  const { docs, docsIndex } = node.dangling || node.kind === "subsystem" ? { docs: [], docsIndex: "absent" as const } : docSectionsAt(projectDirOf(graph), node.address);
  return { node, annotations: rows, claims, evidence, docs, docsIndex };
}

/** The claims on a node, human first. */
export function claims(graph: Graph, id: string): ClaimRow[] {
  if (!has822(graph)) return [];
  return graph.store.db.prepare("SELECT * FROM claims WHERE node_id = ? ORDER BY claim, CASE layer WHEN 'human' THEN 0 ELSE 1 END").all(id) as unknown as ClaimRow[];
}

// ------------------------------------------------------------------ subsystems

const USES_TYPES = ["READS", "WRITES", "USES_ZP", "USES_HARDWARE", "REFERENCES_DATA"];

export function subsystems(graph: Graph): ResolvedNode[] {
  const rows = graph.store.db.prepare("SELECT * FROM nodes WHERE kind = 'subsystem' ORDER BY id, layer").all() as unknown as NodeRow[];
  const out = new Map<string, ResolvedNode>();
  for (const r of rows) if (!out.has(r.id)) out.set(r.id, graph.resolve(r.id));
  return [...out.values()];
}

/** `name` is the subsystem's slug part or its full id. Members via CONTAINS; uses derived from their edges. */
export function subsystem(graph: Graph, name: string): SubsystemView | undefined {
  let id = name;
  if (!name.includes(":")) id = deriveSubsystemId(readProjectSlug(projectDirOf(graph)), name);
  const parsed = parseId(id);
  if (parsed.form !== "subsystem") throw new Error(`${id} is not a subsystem id (<slug>:sub:<name>)`);
  const node = graph.resolve(id);
  if (node.dangling) return undefined;
  const members = graph.edgesOutOf(id, ["CONTAINS"]).map((e) => e.toNode);
  const registers = new Map<string, ResolvedNode>();
  const zeroPage = new Map<string, ResolvedNode>();
  const other = new Map<string, ResolvedNode>();
  for (const m of members) {
    for (const e of graph.edgesOutOf(m.id, USES_TYPES)) {
      const t = e.toNode;
      const bucket = t.space === "io" ? registers : t.address < 0x100 && (t.kind === "addr" || t.platform) ? zeroPage : other;
      if (!bucket.has(t.id)) bucket.set(t.id, t);
    }
  }
  const byAddr = (a: ResolvedNode, b: ResolvedNode) => a.address - b.address || a.id.localeCompare(b.id);
  return { node, members, uses: { registers: [...registers.values()].sort(byAddr), zeroPage: [...zeroPage.values()].sort(byAddr), other: [...other.values()].sort(byAddr) } };
}
