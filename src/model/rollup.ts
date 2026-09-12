// Spec 845 D2/D4/D5 — membership, rolled-up edges, orphans. All computed, none stored.
//
// D2's split is the whole economy of this spec: "the engine lives at $0200-$437E" is a
// judgement and costs a model call; WHICH of 1 853 routines fall inside it is arithmetic
// and costs a SQL predicate. A dozen assertions therefore index eleven thousand nodes,
// and the index cannot go stale, because it is recomputed every time it is read.
//
// D4 gets its citations for free by the same trick: a container edge X -> Y exists
// because fine edges cross from a member of X to a member of Y, and those fine edges ARE
// its evidence. Nothing is asserted twice, so nothing can disagree with itself.

import type { ModelEdge, ModelMembership, ModelNode, ModelReport, Orphan } from "./types.js";
import { MEMBER_KINDS } from "./types.js";
import { listBoundaries } from "./store.js";

/** Innermost wins: a component inside a container claims its members. */
function pick(boundaries: ModelNode[], space: string, owner: string | null, address: number): ModelNode | undefined {
  let best: ModelNode | undefined;
  for (const b of boundaries) {
    if (b.space !== space) continue;
    // A boundary that names an owner binds only that owner's nodes; one that does not
    // spans the space. That is how "the loader" (one file) and "low RAM" (whatever is
    // there) can both be expressed without a second mechanism.
    if (b.owner !== null && b.owner !== owner) continue;
    if (address < b.start || address > b.end) continue;
    if (!best || (b.end - b.start) < (best.end - best.start)) best = b;
  }
  return best;
}

export async function modelReport(projectDir: string): Promise<ModelReport> {
  const boundaries = await listBoundaries(projectDir);
  const empty: ModelReport = { nodes: boundaries, edges: [], membership: [], orphans: [], memberTotal: 0 };
  if (boundaries.length === 0) return empty;

  const { GraphStore } = await import("../knowledge-graph/store.js");
  let store;
  try { store = GraphStore.open(projectDir, { readOnly: true }); } catch { return empty; }
  try {
    const placeholders = MEMBER_KINDS.map(() => "?").join(",");
    const fine = store.db.prepare(
      `SELECT id, kind, name, space, owner, address FROM nodes WHERE kind IN (${placeholders}) GROUP BY id`,
    ).all(...MEMBER_KINDS) as Array<{ id: string; kind: string; name: string | null; space: string; owner: string | null; address: number }>;

    const owning = new Map<string, string>(); // fine node id -> container id
    const membership = new Map<string, ModelMembership>();
    for (const b of boundaries) membership.set(b.id, { containerId: b.id, members: 0, byKind: {} });
    const orphans: Orphan[] = [];

    for (const n of fine) {
      const b = pick(boundaries, n.space, n.owner, n.address);
      if (!b) { orphans.push({ id: n.id, kind: n.kind, name: n.name, address: n.address }); continue; }
      owning.set(n.id, b.id);
      const m = membership.get(b.id)!;
      m.members++;
      m.byKind[n.kind] = (m.byKind[n.kind] ?? 0) + 1;
    }

    // D4 — roll the fine edges up. Only edges whose BOTH ends are placed can cross a
    // boundary; an edge into an orphan says nothing about the model yet.
    const edges = new Map<string, ModelEdge>();
    const rows = store.db.prepare("SELECT from_id, type, to_id FROM edges").all() as Array<{ from_id: string; type: string; to_id: string }>;
    for (const e of rows) {
      const a = owning.get(e.from_id);
      const b = owning.get(e.to_id);
      if (!a || !b || a === b) continue;
      const key = `${a} ${e.type} ${b}`;
      const cur = edges.get(key);
      if (cur) {
        cur.count++;
        if (cur.evidence.length < 3) cur.evidence.push({ from: e.from_id, to: e.to_id });
      } else {
        edges.set(key, { from: a, to: b, type: e.type, count: 1, evidence: [{ from: e.from_id, to: e.to_id }] });
      }
    }

    return {
      nodes: boundaries,
      edges: [...edges.values()].sort((x, y) => y.count - x.count),
      membership: [...membership.values()],
      orphans: orphans.sort((x, y) => x.address - y.address),
      memberTotal: fine.length,
    };
  } finally {
    store.close();
  }
}

export function formatModel(r: ModelReport): string {
  if (r.nodes.length === 0) {
    return "No model yet. Assert a boundary with model_assert (or fill a container-shaped slot with slot_record).";
  }
  const byId = new Map(r.nodes.map((n) => [n.id, n]));
  const mem = new Map(r.membership.map((m) => [m.containerId, m]));
  const short = (id: string) => byId.get(id)?.name ?? id;

  const lines: string[] = [];
  lines.push(`Model: ${r.nodes.length} boundaries over ${r.memberTotal - r.orphans.length}/${r.memberTotal} nodes`
    + (r.orphans.length ? `, ${r.orphans.length} orphaned` : ""));
  lines.push("");
  for (const n of [...r.nodes].sort((a, b) => a.start - b.start)) {
    const m = mem.get(n.id);
    const kinds = m && m.members > 0
      ? Object.entries(m.byKind).map(([k, v]) => `${v} ${k}`).join(", ")
      : "empty";
    lines.push(`${n.level.padEnd(10)} ${n.name}  $${hex(n.start)}-$${hex(n.end)}  [${kinds}]`);
    if (n.description) lines.push(`           ${n.description}`);
    lines.push(`           cite: ${n.evidence.join(" | ")}`);
  }
  if (r.edges.length > 0) {
    lines.push("", "Edges between boundaries (rolled up, the fine edges are the citation):");
    for (const e of r.edges.slice(0, 40)) {
      lines.push(`  ${short(e.from)} -${e.type}(${e.count})-> ${short(e.to)}`);
    }
    if (r.edges.length > 40) lines.push(`  ... ${r.edges.length - 40} more`);
  }
  if (r.orphans.length > 0) {
    lines.push("", `Orphans - inside no named boundary (${r.orphans.length}):`);
    for (const o of r.orphans.slice(0, 20)) lines.push(`  $${hex(o.address)}  ${o.kind}  ${o.name ?? o.id}`);
    if (r.orphans.length > 20) lines.push(`  ... ${r.orphans.length - 20} more`);
  }
  return lines.join("\n");
}

function hex(n: number): string { return (n & 0xffff).toString(16).padStart(4, "0"); }
