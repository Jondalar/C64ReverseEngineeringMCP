// Spec 826.0 T3 — where a human disagrees with 819's routine detection.
//
// `applyAnnotationFile` (migrate.ts) marks every human node that has no
// generated twin: a routine that starts inside a generated routine carries
// `STARTS_INSIDE` + `attrs.boundary: "human-splits-generated"`, a routine
// outside every generated routine carries `attrs.boundary:
// "unseen-by-discovery"`, a label outside every routine became a `data_block`
// and carries `attrs.boundary: "data-outside-code"`. This module only READS
// those marks back: a quality report on the discovery, and the addresses
// `analyze_prg`'s `entry_points` would take to close the gap.

import { Graph } from "./query.js";
import type { GraphStore } from "./store.js";

export interface BoundaryContainer { id: string; name: string | null; address: number; end: number | null }
export interface BoundarySplit { id: string; name: string | null; address: number; owner: string | null; container: BoundaryContainer }
export interface BoundaryUnseen { id: string; name: string | null; address: number; owner: string | null }
export interface BoundaryData { id: string; name: string | null; address: number; owner: string | null; dataBlock: string | null }
export interface BoundaryUnseededOwner { owner: string; humanNodes: number }

export interface BoundaryReport {
  /** a human routine starts strictly inside a generated routine (`STARTS_INSIDE`) */
  splits: BoundarySplit[];
  /** a human routine outside every generated routine of its owner */
  unseen: BoundaryUnseen[];
  /** a human label outside every routine — data the file named where the discovery saw no code */
  dataOutsideCode: BoundaryData[];
  /** annotation-file owners 819 never seeded: their routine/label/segment rows were not judged at all */
  unseededOwners: BoundaryUnseededOwner[];
}

type Db = GraphStore["db"];
interface NameRow { name: string | null; address: number; end_address: number | null; owner: string | null; layer: string }

function dbOf(g: Graph | GraphStore): Db {
  return g instanceof Graph ? g.store.db : g.db;
}

/** A node's name as the query layer answers it: the human row's name wins, then the generated one. */
function nodeOf(db: Db, id: string): { name: string | null; address: number; end: number | null; owner: string | null } | undefined {
  const rows = db.prepare("SELECT name, address, end_address, owner, layer FROM nodes WHERE id = ? ORDER BY layer").all(id) as unknown as NameRow[];
  if (rows.length === 0) return undefined;
  const human = rows.find((r) => r.layer === "human");
  const generated = rows.find((r) => r.layer === "generated");
  const base = generated ?? human!;
  return { name: human?.name ?? generated?.name ?? null, address: base.address, end: human?.end_address ?? generated?.end_address ?? null, owner: base.owner };
}

export function boundaries(g: Graph | GraphStore): BoundaryReport {
  const db = dbOf(g);
  const byAddress = <T extends { address: number; id: string }>(a: T, b: T) => a.address - b.address || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const splits: BoundarySplit[] = [];
  const splitRows = db.prepare("SELECT from_id, to_id FROM edges WHERE type = 'STARTS_INSIDE' ORDER BY from_id, to_id").all() as unknown as Array<{ from_id: string; to_id: string }>;
  for (const e of splitRows) {
    const routine = nodeOf(db, e.from_id);
    const container = nodeOf(db, e.to_id);
    if (!routine || !container) continue;
    splits.push({ id: e.from_id, name: routine.name, address: routine.address, owner: routine.owner, container: { id: e.to_id, name: container.name, address: container.address, end: container.end } });
  }
  splits.sort(byAddress);

  const marked = (kind: string, boundary: string) => db.prepare(
    "SELECT id, name, address, owner FROM nodes WHERE layer = 'human' AND kind = ? AND json_extract(attrs, '$.boundary') = ? ORDER BY address, id",
  ).all(kind, boundary) as unknown as Array<{ id: string; name: string | null; address: number; owner: string | null }>;
  const unseen: BoundaryUnseen[] = marked("routine", "unseen-by-discovery").map((r) => ({ id: r.id, name: r.name, address: r.address, owner: r.owner }));

  const exists = db.prepare("SELECT 1 FROM nodes WHERE id = ? AND layer = 'human'");
  const dataOutsideCode: BoundaryData[] = marked("label", "data-outside-code").map((r) => {
    const candidate = r.id.replace(/:label:([0-9a-f]{4})$/u, ":data_block:$1");
    return { id: r.id, name: r.name, address: r.address, owner: r.owner, dataBlock: candidate !== r.id && exists.get(candidate) ? candidate : null };
  });

  const unseededOwners = (db.prepare(
    "SELECT n.owner AS owner, COUNT(*) AS n FROM nodes n WHERE n.layer = 'human' AND n.owner IS NOT NULL AND n.kind IN ('routine', 'label', 'segment')" +
    " AND NOT EXISTS (SELECT 1 FROM nodes g WHERE g.layer = 'generated' AND g.kind = 'routine' AND g.owner = n.owner AND g.space = n.space) GROUP BY n.owner ORDER BY n.owner",
  ).all() as unknown as Array<{ owner: string; n: number }>).map((r) => ({ owner: r.owner, humanNodes: Number(r.n) }));

  return { splits, unseen, dataOutsideCode, unseededOwners };
}

const hex4U = (a: number) => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

/** The `unseen` addresses as `analyze_prg`'s `entry_points` takes them — `$XXXX`, sorted, distinct. */
export function boundaryEntries(g: Graph | GraphStore): string[] {
  const addresses = [...new Set(boundaries(g).unseen.map((u) => u.address & 0xffff))].sort((a, b) => a - b);
  return addresses.map(hex4U);
}

const span = (address: number, end: number | null) => (end === null || end === address ? hex4U(address) : `${hex4U(address)}-${hex4U(end)}`);
const owned = (owner: string | null) => (owner ? `  (${owner})` : "");

/** A compact text report: one header per section, one line per item. */
export function formatBoundaries(r: BoundaryReport): string {
  const lines: string[] = [];
  lines.push(`splits (${r.splits.length}) — a human routine starts inside a generated routine`);
  for (const s of r.splits) lines.push(`  ${hex4U(s.address)} ${s.name ?? "(unnamed)"}  inside ${span(s.container.address, s.container.end)} ${s.container.name ?? "(unnamed)"}${owned(s.owner)}`);
  lines.push(`unseen (${r.unseen.length}) — a human routine outside every generated routine`);
  for (const u of r.unseen) lines.push(`  ${hex4U(u.address)} ${u.name ?? "(unnamed)"}${owned(u.owner)}`);
  lines.push(`data outside code (${r.dataOutsideCode.length}) — a human label outside every routine, now a data_block`);
  for (const d of r.dataOutsideCode) lines.push(`  ${hex4U(d.address)} ${d.name ?? "(unnamed)"}${d.dataBlock ? "" : "  (no data_block)"}${owned(d.owner)}`);
  lines.push(`unseeded owners (${r.unseededOwners.length}) — annotation files whose owner 819 never seeded`);
  for (const o of r.unseededOwners) lines.push(`  ${o.owner}  ${o.humanNodes} human nodes`);
  return lines.join("\n");
}
