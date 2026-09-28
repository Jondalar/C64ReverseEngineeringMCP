// Dropping one owner from the graph — everything its renders and analyses put there,
// and nothing anybody wrote through a door.
//
// An owner is an artifact stem. Two kinds of rows carry it:
//
//   generated   every producer that seeds from `<stem>_analysis.json` replaces its rows
//               by (producer, run_owner = stem) — store.replaceGenerated — and writes
//               its edges with owner = stem. The analysis import's own rows (producer
//               822, generated layer) carry run_owner = the stem's ctx owner too.
//   human       the annotation-file import (migrate.applyAnnotationFile) writes human
//               rows with producer 822 and the FILE's project-relative path in
//               attrs.source_path (nodes), source_path (annotations) and
//               evidence.source_path (edges). That path is the key: a door row has
//               producer 'human' (store.upsertHuman, migrate/human.ts), or producer 822
//               with no source_path (a migrated / imported save_* record), and neither
//               is ever matched here.
//
// Trace runs (producer 821) are keyed by run id, not by a stem; `remove-run` drops them.
//
// Everything happens in ONE write transaction. A dry run executes the very same
// statements and rolls back, so its counts are the real run's counts by construction.

import { basename } from "node:path";
import type { DatabaseSync } from "../platform-kb/sqlite-quiet.js";
import { normStem } from "./migrate/classify.js";
import { has822Tables } from "./migrate/schema-822.js";
import { resolveAddressesIn, type ResolveResult } from "./producers/resolve.js";
import { GraphStore } from "./store.js";
import { beginWrite, endWrite } from "./write-tx.js";

/** meta key prefix of the marker a removal leaves: a project-wide seed pass skips the owner until something seeds or imports it by name. */
export const OWNER_REMOVED_PREFIX = "owner_removed.";
const RUNTIME_PRODUCER = "821";

export interface OwnerSummary {
  owner: string;
  /** generated nodes, `addr` excluded (those are shared) */
  generatedNodes: number;
  generatedEdges: number;
  /** human rows the owner's annotation file(s) imported */
  importedHumanNodes: number;
  /** the annotation files imported under this owner, project-relative */
  annotationFiles: string[];
  /** true when a removal left its marker and nothing has brought the owner back */
  removed: boolean;
}

export interface RemoveOwnerCounts {
  /** "layer/producer" → rows */
  nodes: Record<string, number>;
  edges: Record<string, number>;
  claims: number;
  annotations: Record<string, number>;
  questions: number;
  evidence: number;
  migrationLog: number;
  /** shared `addr` nodes nothing referenced any more */
  orphanedAddrNodes: number;
  meta: string[];
}

export interface RemoveOwnerResult {
  owner: string;
  dryRun: boolean;
  annotationFiles: string[];
  removed: RemoveOwnerCounts;
  total: number;
  /** door-written rows that pointed at a removed node — kept, now dangling */
  kept: { humanEdges: number; humanAnnotations: number; humanClaims: number };
  /** the project-wide RESOLVES_TO pass, re-run so no alias points at a removed routine */
  resolve?: ResolveResult;
  ms: number;
}

export class UnknownOwnerError extends Error {
  constructor(readonly owner: string, readonly owners: OwnerSummary[]) {
    super(`no owner "${owner}" in the graph. Owners: ${owners.map((o) => o.owner).join(", ") || "(none)"}`);
  }
}

function annotationStems(db: DatabaseSync): Array<{ stem: string; owner: string; path?: string }> {
  const rows = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'annotations_imported.%'").all() as Array<{ key: string; value: string }>;
  return rows.map((r) => {
    const stem = r.key.slice("annotations_imported.".length);
    let path: string | undefined;
    try { path = (JSON.parse(r.value) as { path?: string }).path; } catch { path = undefined; }
    return { stem, owner: normStem(stem), path };
  });
}

/** The annotation files an owner's human rows came from: the import ledger's paths, and any path still on a row. */
function annotationFilesOf(db: DatabaseSync, owner: string): { files: string[]; stems: string[] } {
  const files = new Set<string>();
  const stems: string[] = [];
  for (const s of annotationStems(db)) {
    if (s.owner !== owner) continue;
    stems.push(s.stem);
    if (s.path) files.add(s.path);
  }
  const fromRows = db.prepare(
    "SELECT DISTINCT json_extract(attrs, '$.source_path') AS p FROM nodes WHERE layer = 'human' AND producer = '822' AND json_extract(attrs, '$.source_path') IS NOT NULL",
  ).all() as Array<{ p: string }>;
  for (const r of fromRows) if (ownerOfAnnotationFile(r.p) === owner) files.add(r.p);
  if (has822Tables(db)) {
    const fromProse = db.prepare("SELECT DISTINCT source_path AS p FROM annotations WHERE producer = '822' AND source_path IS NOT NULL").all() as Array<{ p: string }>;
    for (const r of fromProse) if (ownerOfAnnotationFile(r.p) === owner) files.add(r.p);
  }
  return { files: [...files].sort(), stems: stems.sort() };
}

/** The owner applyAnnotationFile gives a `<stem>_annotations.json`; undefined for any other path. */
function ownerOfAnnotationFile(path: string): string | undefined {
  const name = basename(path.replace(/\\/gu, "/"));
  if (!/_annotations\.json$/u.test(name)) return undefined;
  return normStem(name.replace(/_annotations\.json$/u, ""));
}

function removedMarkers(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT key FROM meta WHERE key LIKE ?").all(`${OWNER_REMOVED_PREFIX}%`) as Array<{ key: string }>;
  return new Set(rows.map((r) => r.key.slice(OWNER_REMOVED_PREFIX.length)));
}

/** Owners a removal marked and nothing has brought back — a project-wide seed pass leaves them out. */
export function removedOwners(store: GraphStore): Set<string> {
  return removedMarkers(store.db);
}

/** Every owner the graph holds rows for, with what it holds. */
export function listOwnersIn(store: GraphStore): OwnerSummary[] {
  const db = store.db;
  const byOwner = new Map<string, OwnerSummary>();
  const get = (owner: string): OwnerSummary => {
    let s = byOwner.get(owner);
    if (!s) { s = { owner, generatedNodes: 0, generatedEdges: 0, importedHumanNodes: 0, annotationFiles: [], removed: false }; byOwner.set(owner, s); }
    return s;
  };
  for (const r of db.prepare("SELECT run_owner AS o, COUNT(*) AS n FROM nodes WHERE layer = 'generated' AND kind <> 'addr' AND producer <> ? AND run_owner IS NOT NULL GROUP BY run_owner").all(RUNTIME_PRODUCER) as Array<{ o: string; n: number }>) {
    get(r.o).generatedNodes += Number(r.n);
  }
  for (const r of db.prepare("SELECT owner AS o, COUNT(*) AS n FROM edges WHERE layer = 'generated' AND producer <> ? AND owner IS NOT NULL GROUP BY owner").all(RUNTIME_PRODUCER) as Array<{ o: string; n: number }>) {
    get(r.o).generatedEdges += Number(r.n);
  }
  const files = new Map<string, Set<string>>();
  const addFile = (owner: string, path: string) => { const set = files.get(owner) ?? new Set<string>(); set.add(path); files.set(owner, set); };
  for (const r of db.prepare(
    "SELECT json_extract(attrs, '$.source_path') AS p, COUNT(*) AS n FROM nodes WHERE layer = 'human' AND producer = '822' AND json_extract(attrs, '$.source_path') IS NOT NULL GROUP BY p",
  ).all() as Array<{ p: string; n: number }>) {
    const owner = ownerOfAnnotationFile(r.p);
    if (owner === undefined) continue;
    get(owner).importedHumanNodes += Number(r.n);
    addFile(owner, r.p);
  }
  for (const s of annotationStems(db)) {
    get(s.owner);
    if (s.path) addFile(s.owner, s.path);
  }
  const markers = removedMarkers(db);
  for (const s of byOwner.values()) {
    s.annotationFiles = [...(files.get(s.owner) ?? [])].sort();
  }
  for (const m of markers) {
    const s = byOwner.get(m);
    if (s) s.removed = true;
  }
  return [...byOwner.values()]
    .filter((s) => s.generatedNodes + s.generatedEdges + s.importedHumanNodes > 0 || s.annotationFiles.length > 0)
    .sort((a, b) => a.owner.localeCompare(b.owner));
}

export function listOwners(projectDir: string): OwnerSummary[] {
  const store = GraphStore.open(projectDir);
  try { return listOwnersIn(store); } finally { store.close(); }
}

/** The owner as the graph spells it: exact, then lower-cased, then as a file name's stem. */
function resolveOwner(owners: OwnerSummary[], wanted: string): string | undefined {
  const names = new Set(owners.map((o) => o.owner));
  for (const candidate of [wanted, wanted.toLowerCase(), normStem(wanted)]) if (names.has(candidate)) return candidate;
  return undefined;
}

export function removeOwnerIn(store: GraphStore, wanted: string, options: { dryRun?: boolean; now?: string } = {}): RemoveOwnerResult {
  const t0 = process.hrtime.bigint();
  const db = store.db;
  const dryRun = options.dryRun === true;
  const owners = listOwnersIn(store);
  const owner = resolveOwner(owners, wanted.trim());
  if (owner === undefined) throw new UnknownOwnerError(wanted, owners);
  const has822 = has822Tables(db);

  const removed: RemoveOwnerCounts = { nodes: {}, edges: {}, claims: 0, annotations: {}, questions: 0, evidence: 0, migrationLog: 0, orphanedAddrNodes: 0, meta: [] };
  const bump = (map: Record<string, number>, key: string, n: number) => { if (n > 0) map[key] = (map[key] ?? 0) + n; };
  const kept = { humanEdges: 0, humanAnnotations: 0, humanClaims: 0 };
  let resolve: ResolveResult | undefined;
  let annotationFiles: string[] = [];

  const owned = beginWrite(db);
  try {
    const { files, stems } = annotationFilesOf(db, owner);
    annotationFiles = files;
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS rm_files (path TEXT PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS rm_nodes (id TEXT PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS rm_edges (from_id TEXT NOT NULL, type TEXT NOT NULL, to_id TEXT NOT NULL, PRIMARY KEY (from_id, type, to_id));
      CREATE TEMP TABLE IF NOT EXISTS rm_addr (id TEXT PRIMARY KEY);
      CREATE TEMP TABLE IF NOT EXISTS rm_keys (target_table TEXT NOT NULL, target_key TEXT NOT NULL, PRIMARY KEY (target_table, target_key));
      DELETE FROM rm_files; DELETE FROM rm_nodes; DELETE FROM rm_edges; DELETE FROM rm_addr; DELETE FROM rm_keys;
    `);
    const insFile = db.prepare("INSERT OR IGNORE INTO rm_files (path) VALUES (?)");
    for (const f of files) insFile.run(f);

    // ── which nodes ─────────────────────────────────────────────────────────
    // generated: the owner's runs (every producer but the trace runs); `addr` is shared and handled below
    const ownedGenerated = "layer = 'generated' AND kind <> 'addr' AND producer <> ? AND (run_owner = ? OR (run_owner IS NULL AND owner = ?))";
    // human: only what the owner's annotation FILE imported — producer 822 with that file's path
    const importedHuman = "layer = 'human' AND producer = '822' AND json_extract(attrs, '$.source_path') IN (SELECT path FROM rm_files)";
    db.prepare(`INSERT OR IGNORE INTO rm_nodes (id) SELECT id FROM nodes WHERE ${ownedGenerated}`).run(RUNTIME_PRODUCER, owner, owner);
    db.prepare(`INSERT OR IGNORE INTO rm_nodes (id) SELECT id FROM nodes WHERE ${importedHuman}`).run();

    // ── edges: the owner's own, the file's own, then whatever that leaves dangling ──
    const edgeSets: Array<{ where: string; args: unknown[] }> = [
      { where: "layer = 'generated' AND producer <> ? AND owner = ?", args: [RUNTIME_PRODUCER, owner] },
      { where: "layer = 'human' AND producer = '822' AND json_extract(evidence, '$.source_path') IN (SELECT path FROM rm_files)", args: [] },
    ];
    const recordEdges = (where: string, args: unknown[]) => {
      db.prepare(`INSERT OR IGNORE INTO rm_edges (from_id, type, to_id) SELECT from_id, type, to_id FROM edges WHERE ${where}`).run(...(args as never[]));
      db.prepare(`INSERT OR IGNORE INTO rm_addr (id) SELECT from_id FROM edges WHERE ${where} UNION SELECT to_id FROM edges WHERE ${where}`).run(...(args as never[]), ...(args as never[]));
      for (const r of db.prepare(`SELECT layer || '/' || producer AS k, COUNT(*) AS n FROM edges WHERE ${where} GROUP BY k`).all(...(args as never[])) as Array<{ k: string; n: number }>) bump(removed.edges, r.k, Number(r.n));
      db.prepare(`DELETE FROM edges WHERE ${where}`).run(...(args as never[]));
    };
    for (const s of edgeSets) recordEdges(s.where, s.args);

    for (const r of db.prepare("SELECT layer || '/' || producer AS k, COUNT(*) AS n FROM nodes WHERE id IN (SELECT id FROM rm_nodes) AND (" + ownedGenerated + " OR " + importedHuman + ") GROUP BY k").all(RUNTIME_PRODUCER, owner, owner) as Array<{ k: string; n: number }>) bump(removed.nodes, r.k, Number(r.n));
    db.prepare(`DELETE FROM nodes WHERE ${ownedGenerated}`).run(RUNTIME_PRODUCER, owner, owner);
    db.prepare(`DELETE FROM nodes WHERE ${importedHuman}`).run();
    // a removed id that still has a row (a door row at the same id) is not gone
    db.exec("DELETE FROM rm_nodes WHERE id IN (SELECT id FROM nodes)");

    // generated edges of other producers that touched a node now gone (a caller in another
    // owner, a RESOLVES_TO alias, a trace run's observation) — human edges are kept, dangling
    recordEdges("layer = 'generated' AND (from_id IN (SELECT id FROM rm_nodes) OR to_id IN (SELECT id FROM rm_nodes))", []);
    kept.humanEdges = Number((db.prepare("SELECT COUNT(*) AS n FROM edges WHERE layer = 'human' AND (from_id IN (SELECT id FROM rm_nodes) OR to_id IN (SELECT id FROM rm_nodes))").get() as { n: number }).n);
    // an edge key is gone when no layer carries that (from, type, to) any more
    db.exec("DELETE FROM rm_edges WHERE EXISTS (SELECT 1 FROM edges e WHERE e.from_id = rm_edges.from_id AND e.type = rm_edges.type AND e.to_id = rm_edges.to_id)");
    db.exec("INSERT OR IGNORE INTO rm_keys (target_table, target_key) SELECT 'edges', from_id || '|' || type || '|' || to_id FROM rm_edges");
    db.exec("INSERT OR IGNORE INTO rm_keys (target_table, target_key) SELECT 'nodes', id FROM rm_nodes");

    if (has822) {
      // claims, prose and questions: the generated ones on a node now gone, and the file's own prose
      const claimWhere = "layer = 'generated' AND node_id IN (SELECT id FROM rm_nodes)";
      db.prepare(`INSERT OR IGNORE INTO rm_keys (target_table, target_key) SELECT 'claims', node_id || '|' || claim FROM claims WHERE ${claimWhere}`).run();
      db.prepare(`INSERT OR IGNORE INTO rm_addr (id) SELECT node_id FROM claims WHERE ${claimWhere}`).run();
      removed.claims = Number(db.prepare(`DELETE FROM claims WHERE ${claimWhere}`).run().changes);
      kept.humanClaims = Number((db.prepare("SELECT COUNT(*) AS n FROM claims WHERE layer = 'human' AND node_id IN (SELECT id FROM rm_nodes)").get() as { n: number }).n);

      const annWhere = "(producer = '822' AND source_path IN (SELECT path FROM rm_files)) OR (layer = 'generated' AND node_id IN (SELECT id FROM rm_nodes))";
      db.prepare(`INSERT OR IGNORE INTO rm_keys (target_table, target_key) SELECT 'annotations', id FROM annotations WHERE ${annWhere}`).run();
      for (const r of db.prepare(`SELECT layer || '/' || producer AS k, COUNT(*) AS n FROM annotations WHERE ${annWhere} GROUP BY k`).all() as Array<{ k: string; n: number }>) bump(removed.annotations, r.k, Number(r.n));
      db.prepare(`DELETE FROM annotations WHERE ${annWhere}`).run();
      kept.humanAnnotations = Number((db.prepare("SELECT COUNT(*) AS n FROM annotations WHERE layer = 'human' AND node_id IN (SELECT id FROM rm_nodes)").get() as { n: number }).n);

      const qWhere = "layer = 'generated' AND node_id IN (SELECT id FROM rm_nodes)";
      db.prepare(`INSERT OR IGNORE INTO rm_keys (target_table, target_key) SELECT 'questions', id FROM questions WHERE ${qWhere}`).run();
      removed.questions = Number(db.prepare(`DELETE FROM questions WHERE ${qWhere}`).run().changes);

      // evidence for what is gone — never a door's own evidence row
      removed.evidence = Number(db.prepare(
        "DELETE FROM evidence WHERE producer <> 'human' AND EXISTS (SELECT 1 FROM rm_keys k WHERE k.target_table = evidence.target_table AND k.target_key = evidence.target_key)",
      ).run().changes);

      // the ledger: the owner's annotation stores, and any entry whose target is gone, so the
      // next import of the same stem is a first import, not "unchanged since the last import"
      const delStore = db.prepare("DELETE FROM migration_log WHERE legacy_store = ?");
      for (const stem of stems) removed.migrationLog += Number(delStore.run(`annotations:${stem}`).changes);
      removed.migrationLog += Number(db.prepare(
        "DELETE FROM migration_log WHERE EXISTS (SELECT 1 FROM rm_keys k WHERE k.target_table = migration_log.target_table AND k.target_key = migration_log.target_id)",
      ).run().changes);
    }

    // shared `addr` nodes: dropped only when the removal took their last reference
    db.exec("DELETE FROM rm_addr WHERE id NOT IN (SELECT id FROM nodes WHERE layer = 'generated' AND kind = 'addr')");
    const referenced = [
      "EXISTS (SELECT 1 FROM edges e WHERE e.from_id = rm_addr.id OR e.to_id = rm_addr.id)",
      "EXISTS (SELECT 1 FROM nodes h WHERE h.id = rm_addr.id AND h.layer = 'human')",
      ...(has822 ? [
        "EXISTS (SELECT 1 FROM claims c WHERE c.node_id = rm_addr.id)",
        "EXISTS (SELECT 1 FROM annotations a WHERE a.node_id = rm_addr.id)",
        "EXISTS (SELECT 1 FROM questions q WHERE q.node_id = rm_addr.id)",
        "EXISTS (SELECT 1 FROM evidence v WHERE v.target_table = 'nodes' AND v.target_key = rm_addr.id)",
      ] : []),
    ];
    db.exec(`DELETE FROM rm_addr WHERE ${referenced.join(" OR ")}`);
    removed.orphanedAddrNodes = Number(db.prepare("DELETE FROM nodes WHERE layer = 'generated' AND kind = 'addr' AND id IN (SELECT id FROM rm_addr)").run().changes);

    // meta: the per-stem import markers, and the removal's own marker
    const delMeta = db.prepare("DELETE FROM meta WHERE key = ?");
    for (const stem of stems) if (Number(delMeta.run(`annotations_imported.${stem}`).changes) > 0) removed.meta.push(`annotations_imported.${stem}`);

    const total = sumCounts(removed);
    const now = options.now ?? new Date().toISOString();
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(`${OWNER_REMOVED_PREFIX}${owner}`, JSON.stringify({ removed_at: now, rows: total, annotation_files: files }));
    if (has822) {
      // the graph's write ledger: every import run is a row here, and so is a removal
      db.prepare("INSERT INTO migration_runs (started_at, finished_at, source_hash, dry_run) VALUES (?, ?, ?, 0)").run(now, now, `remove-owner:${owner}`);
    }
    // aliases re-derived without the removed routines, labels and data blocks
    if (Object.keys(removed.nodes).length > 0 || removed.orphanedAddrNodes > 0) resolve = resolveAddressesIn(store, { inTransaction: true });

    db.exec("DROP TABLE IF EXISTS temp.rm_files; DROP TABLE IF EXISTS temp.rm_nodes; DROP TABLE IF EXISTS temp.rm_edges; DROP TABLE IF EXISTS temp.rm_addr; DROP TABLE IF EXISTS temp.rm_keys;");
    endWrite(db, owned, !dryRun);
    return { owner, dryRun, annotationFiles, removed, total, kept, resolve, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (error) {
    try { endWrite(db, owned, false); } catch { /* already rolled back */ }
    throw error;
  }
}

function sumCounts(c: RemoveOwnerCounts): number {
  const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  return sum(c.nodes) + sum(c.edges) + c.claims + sum(c.annotations) + c.questions + c.evidence + c.migrationLog + c.orphanedAddrNodes + c.meta.length;
}

export function removeOwner(projectDir: string, owner: string, options: { dryRun?: boolean } = {}): RemoveOwnerResult {
  const store = GraphStore.open(projectDir);
  try { return removeOwnerIn(store, owner, options); } finally { store.close(); }
}

export function formatOwners(owners: OwnerSummary[]): string {
  if (owners.length === 0) return "(no owners — nothing has been seeded or imported)";
  const lines = owners.map((o) => `${o.owner.padEnd(40)} generated nodes=${o.generatedNodes} edges=${o.generatedEdges}  imported human nodes=${o.importedHumanNodes}${o.annotationFiles.length ? `  files=${o.annotationFiles.join(", ")}` : ""}${o.removed ? "  [removed]" : ""}`);
  return [`${owners.length} owners:`, ...lines].join("\n");
}

export function formatRemoveOwner(r: RemoveOwnerResult): string {
  const kv = (m: Record<string, number>) => Object.entries(m).sort().map(([k, v]) => `${k}=${v}`).join(" ") || "0";
  const lines = [
    `${r.dryRun ? "DRY RUN — nothing deleted. Would remove" : "Removed"} owner ${r.owner}: ${r.total} rows`,
    `  nodes:       ${kv(r.removed.nodes)}`,
    `  edges:       ${kv(r.removed.edges)}`,
    `  annotations: ${kv(r.removed.annotations)}`,
    `  claims=${r.removed.claims} questions=${r.removed.questions} evidence=${r.removed.evidence} migration_log=${r.removed.migrationLog} orphaned addr nodes=${r.removed.orphanedAddrNodes}`,
    `  meta:        ${r.removed.meta.join(", ") || "(none)"}`,
    `  annotation files (left on disk): ${r.annotationFiles.join(", ") || "(none)"}`,
  ];
  if (r.kept.humanEdges + r.kept.humanAnnotations + r.kept.humanClaims > 0) {
    lines.push(`  kept, written through a door, now pointing at a removed node: ${r.kept.humanEdges} human edges, ${r.kept.humanAnnotations} human annotations, ${r.kept.humanClaims} human claims`);
  }
  if (r.resolve) lines.push(`  RESOLVES_TO ${r.dryRun ? "would be " : ""}re-derived: ${r.resolve.resolved} aliases, ${r.resolve.ambiguous} ambiguous`);
  lines.push(r.dryRun
    ? "Run again without dry_run to delete exactly these rows."
    : `A full \`graph seed\` now skips ${r.owner}; rendering or analysing it by name brings it back.`);
  return lines.join("\n");
}
