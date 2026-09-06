// Spec 825 D4 — communities: HUMAN first, computed second, never written back.
//
// A node's community is its subsystem when the human layer says so (818's
// `assign-subsystem`, 822's door: BELONGS_TO, or the subsystem's CONTAINS).
// Everything else falls to Louvain — over the CODE edges ONLY. That exclusion
// is the whole point: USES_ZP is 6 800 rows onto ~230 addresses and the KERNAL
// entries are called by everyone, so with memory edges in, every routine in the
// project lands in one blob and the colour says nothing.
//
// Pure: no DOM, no sigma, no fetch. Seeded, so two runs colour the same graph
// the same way. Nothing here writes to the graph store — naming a community is
// the human's door (`save_entity` / `assign-subsystem`), and the next load then
// shows it as human (D9).

import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type Graph from "graphology";

/** D4 — the edges Louvain may see. Memory edges are hubs; they glue everything into one blob. */
export const CODE_EDGE_TYPES = ["CALLS", "JUMPS_TO", "BRANCHES_TO", "CONTAINS"] as const;

/** The edges that put a node in a human subsystem (822's door writes these). */
export const SUBSYSTEM_EDGE_TYPES = ["BELONGS_TO", "CONTAINS"] as const;

export interface CommunityGroup {
  id: string;
  label: string;
  kind: "human" | "computed";
  size: number;
  /** the highest-degree members, for the legend line */
  top: string[];
  /**
   * The swatch the legend draws. It travels ON the group rather than being
   * looked up in the panel on purpose: `graph-panel.tsx` imports this module
   * TYPE-ONLY, and one value import would pull graphology and Louvain into
   * `index-*.js` — the D2 lazy chunk the gate checks for.
   */
  color: string;
}

export interface CommunityResult {
  /** node id → community id (`human:<subsystem>` or `computed:<n>`) */
  assignment: Record<string, string>;
  groups: CommunityGroup[];
  /** Louvain's modularity over the code graph, or null when there was nothing to partition */
  modularity: number | null;
  /** how many human subsystems actually claimed a node */
  humanCount: number;
  /** nodes with no code edge at all — no community, drawn grey (D4) */
  uncolored: number;
}

export interface CommunityOptions {
  resolution?: number;
  /** the Louvain PRNG seed — fixed so the same graph colours the same way twice (D4) */
  seed?: number;
}

/** A tiny seeded PRNG: Louvain needs randomness, we need determinism. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isSubsystem = (graph: Graph, id: string): boolean => graph.hasNode(id) && String(graph.getNodeAttribute(id, "kind") ?? "") === "subsystem";

const nameOf = (graph: Graph, id: string): string => {
  if (!graph.hasNode(id)) return id;
  const a = graph.getNodeAttributes(id) as { name?: string | null; label?: string | null };
  return a.name ?? a.label ?? id;
};

/**
 * D4 — the community axis. Human subsystems claim their members first; the rest
 * is Louvain over the code graph. Two runs of the same graph give the same ids,
 * because the computed groups are renumbered by (size, first member id) and not
 * by whatever order Louvain happened to visit them in.
 */
export function communities(graph: Graph, options: CommunityOptions = {}): CommunityResult {
  const assignment: Record<string, string> = {};
  const groups: CommunityGroup[] = [];

  // ---- human first (D4): BELONGS_TO into a subsystem, or the subsystem's CONTAINS
  const humanMembers = new Map<string, string[]>();
  graph.forEachEdge((_e, attrs, source, target) => {
    const type = String((attrs as { edgeType?: unknown }).edgeType ?? "");
    if (type === "BELONGS_TO" && isSubsystem(graph, target)) {
      humanMembers.set(target, [...(humanMembers.get(target) ?? []), source]);
    } else if (type === "CONTAINS" && isSubsystem(graph, source)) {
      humanMembers.set(source, [...(humanMembers.get(source) ?? []), target]);
    }
  });
  const degree = (id: string) => (graph.hasNode(id) ? graph.degree(id) : 0);
  for (const sub of [...humanMembers.keys()].sort()) {
    const members = [...new Set(humanMembers.get(sub)!)].filter((m) => graph.hasNode(m)).sort();
    if (members.length === 0) continue;
    const cid = `human:${sub}`;
    for (const m of members) assignment[m] ??= cid;
    assignment[sub] = cid;
    groups.push({ id: cid, label: nameOf(graph, sub), kind: "human", size: members.length, color: communityColor(cid), top: [...members].sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1)).slice(0, 2).map((m) => nameOf(graph, m)) });
  }
  const humanCount = groups.length;

  // ---- the rest: Louvain over CODE edges only, on the nodes the human left.
  //      A node with NO code edge is not in the code graph at all: it gets no
  //      community and is drawn grey. Giving every I/O register and every
  //      listing address a singleton "community" of its own would put 8 000
  //      meaningless entries in the legend and say nothing.
  const code = new UndirectedGraph();
  const rest = new Set<string>();
  graph.forEachNode((id) => { if (assignment[id] === undefined) rest.add(id); });
  const codeTypes = new Set<string>(CODE_EDGE_TYPES);
  graph.forEachEdge((_e, attrs, source, target) => {
    const type = String((attrs as { edgeType?: unknown }).edgeType ?? "");
    if (!codeTypes.has(type) || source === target) return;
    if (!rest.has(source) || !rest.has(target)) return;
    code.mergeNode(source);
    code.mergeNode(target);
    if (code.hasEdge(source, target)) code.setEdgeAttribute(source, target, "weight", Number(code.getEdgeAttribute(source, target, "weight") ?? 1) + 1);
    else code.addEdge(source, target, { weight: 1 });
  });

  let modularity: number | null = null;
  const raw: Record<string, number> = {};
  if (code.order > 0) {
    if (code.size === 0) {
      // nothing to partition: every node is its own community, and Louvain is not asked
      let i = 0;
      code.forEachNode((id) => { raw[id] = i; i += 1; });
    } else {
      const detailed = louvain.detailed(code, { resolution: options.resolution ?? 1, rng: mulberry32(options.seed ?? 0x5c64), getEdgeWeight: "weight" });
      modularity = detailed.modularity;
      Object.assign(raw, detailed.communities);
    }
  }

  // renumber canonically: biggest first, ties by the smallest member id
  const buckets = new Map<number, string[]>();
  for (const id of Object.keys(raw).sort()) buckets.set(raw[id]!, [...(buckets.get(raw[id]!) ?? []), id]);
  const ordered = [...buckets.values()].sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
  ordered.forEach((members, index) => {
    const cid = `computed:${index}`;
    for (const m of members) assignment[m] = cid;
    groups.push({
      id: cid,
      label: `computed · ${members.length} nodes`,
      kind: "computed",
      size: members.length,
      color: communityColor(cid),
      top: [...members].sort((a, b) => degree(b) - degree(a) || (a < b ? -1 : 1)).slice(0, 2).map((m) => nameOf(graph, m)),
    });
  });

  let uncolored = 0;
  graph.forEachNode((id) => { if (assignment[id] === undefined) uncolored += 1; });
  return { assignment, groups, modularity, humanCount, uncolored };
}

/**
 * D4 — the palette. HEX, and that is not a style choice.
 *
 * sigma 3's `parseColor` understands `#rgb`, `#rrggbb`, `rgb()`, `rgba()` and
 * the named colours. An `hsl()` string matches none of those and falls through
 * to `{r:0,g:0,b:0}` — so the first build drew all 13 060 nodes BLACK on a
 * near-black panel, which read on screen as "the palette is wrong" (§10) when
 * it was a parse failure. `smoke:825` now runs every colour this module can
 * return through sigma's own parser, so it cannot come back.
 *
 * Two fixed ramps rather than a hash over the hue wheel: a hashed hue lands on
 * navy and on brown as readily as on cyan, and both vanish at 3 px against
 * `rgba(7,14,24,…)`. These are picked for that ground — human subsystems warm,
 * computed cool, so the legend reads "named" vs "guessed" before anyone reads a
 * word.
 */
export const HUMAN_COLORS = [
  "#ffb457", "#ff8f6b", "#ffd166", "#f97f9e",
  "#ffab5e", "#e9a0ff", "#ff7a6d", "#f7c948",
] as const;

export const COMPUTED_COLORS = [
  "#5ec8f5", "#6ee7b7", "#8ea6ff", "#4dd8d0",
  "#b39dff", "#7ee081", "#5aa9ff", "#63d2a4",
  "#9fbdff", "#7fe3ff",
] as const;

/**
 * The nodes with no code edge at all — 7 868 of 13 060 on Wasteland_EF. They
 * are scaffolding (I/O registers, listing addresses, labels), not a community,
 * and §10 asked for a treatment that is visibly *different* rather than one
 * more dark grey. A cool slate at a third of the size says "structure, not
 * subject" without competing with the coloured half.
 */
export const UNCOLORED_COLOR = "#4a5470";

/** Stable per id: same graph, same colours, twice. */
export function communityColor(id: string): string {
  if (id === "") return UNCOLORED_COLOR;
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const ramp = id.startsWith("human:") ? HUMAN_COLORS : COMPUTED_COLORS;
  return ramp[(h >>> 0) % ramp.length]!;
}

/**
 * D4 — size carries degree, and membership carries weight. A node outside every
 * community is drawn small on purpose: it is there so an edge has somewhere to
 * land, not because anyone is looking at it.
 */
export function nodeSize(degree: number, inCommunity: boolean): number {
  const base = 2.6 + Math.min(13, Math.log2(1 + Math.max(0, degree)) * 2.1);
  return inCommunity ? base : Math.max(1.5, base * 0.5);
}
