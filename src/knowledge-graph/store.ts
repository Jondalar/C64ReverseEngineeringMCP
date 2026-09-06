// Spec 818 — the project graph store: open, write by producer, dump, hash.
//
// D5: a producer replaces ITS OWN generated rows — delete by (producer, owner),
// then insert — and no statement in this module can touch layer = 'human'.
// D6: "the same graph" is the canonical dump (generated nodes by id, edges by
// (from, type, to, evidence_key), JSON lines), not the file's bytes.
// D10: additive — this module never reads or writes knowledge/*.json.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "../platform-kb/sqlite-quiet.js";
import { deriveProjectId, IdRuleError, parseId, spaceForParsed, type ProjectIdParts } from "./ids.js";
import { GRAPH_DDL, GRAPH_SCHEMA_VERSION, type Confidence, type EdgeRow, type Layer, type NodeRow, type Origin } from "./schema.js";

export interface NodeInput {
  /** Either a finished id or the parts it is derived from — never both. */
  id?: string;
  parts?: ProjectIdParts;
  kind: string;
  name?: string | null;
  endAddress?: number | null;
  attrs?: Record<string, unknown>;
  origin: Origin;
  confidence: Confidence;
  evidence?: unknown[];
}

export interface EdgeInput {
  from: string;
  type: string;
  to: string;
  evidenceKey?: string;
  origin: Origin;
  confidence: Confidence;
  evidence?: Record<string, unknown>;
}

export interface ReplaceResult {
  producer: string;
  owner: string | null;
  deletedNodes: number;
  deletedEdges: number;
  insertedNodes: number;
  insertedEdges: number;
}

export function graphPath(projectDir: string): string {
  return join(projectDir, "knowledge", "graph.sqlite");
}

export function readProjectSlug(projectDir: string): string {
  const path = join(projectDir, "knowledge", "project.json");
  if (!existsSync(path)) throw new Error(`no knowledge/project.json in ${projectDir} — is this a C64RE project? (project_init)`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as { slug?: string; name?: string };
  const slug = raw.slug ?? (raw.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`knowledge/project.json in ${projectDir} has neither slug nor name`);
  return slug;
}

export class GraphStore {
  readonly db: DatabaseSync;

  private constructor(readonly path: string, readonly readOnly: boolean) {
    // Spec 822 D9: a second process opening during another's BEGIN IMMEDIATE
    // must wait, not fail — `timeout` applies before the first PRAGMA runs.
    this.db = new DatabaseSync(path, { readOnly, timeout: 5000 });
    if (!readOnly) {
      // Spec 822 D9 write discipline, adopted at the first writer: WAL so a
      // reader never blocks a writer, a busy timeout so two producers queue
      // instead of failing.
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec(GRAPH_DDL);
      const version = this.getMeta("schema_version");
      if (version === undefined) this.setMeta("schema_version", String(GRAPH_SCHEMA_VERSION));
      else if (Number(version) > GRAPH_SCHEMA_VERSION) {
        throw new Error(`graph.sqlite schema_version ${version} is newer than this reader (${GRAPH_SCHEMA_VERSION})`);
      }
    }
  }

  static open(projectDir: string, options: { readOnly?: boolean } = {}): GraphStore {
    const path = graphPath(projectDir);
    if (options.readOnly) {
      if (!existsSync(path)) throw new Error(`no graph at ${path} — nothing has been seeded yet (c64re graph seed)`);
      return new GraphStore(path, true);
    }
    mkdirSync(join(projectDir, "knowledge"), { recursive: true });
    return new GraphStore(path, false);
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Record a producer in meta.producers (a JSON object producer → schema version). */
  recordProducer(producer: string): void {
    const raw = this.getMeta("producers");
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[producer] = GRAPH_SCHEMA_VERSION;
    this.setMeta("producers", JSON.stringify(Object.fromEntries(Object.entries(map).sort())));
  }

  private toNodeRow(input: NodeInput, layer: Layer, producer: string, runOwner: string | null = null): NodeRow {
    if ((input.id === undefined) === (input.parts === undefined)) {
      throw new IdRuleError("node-id", "give either id or parts, not both, not neither");
    }
    const id = input.id ?? deriveProjectId(input.parts!);
    const parsed = parseId(id);
    if (parsed.form === "project" && input.parts) {
      const rederived = deriveProjectId(input.parts);
      if (rederived !== id) throw new IdRuleError("derive", `deriveId(parts) = ${rederived} ≠ ${id}`);
    }
    const address = parsed.form === "subsystem" ? 0 : parsed.address;
    const owner = parsed.form === "project" ? parsed.ctx.owner ?? null : null;
    const bank = parsed.form === "project" ? parsed.ctx.bank ?? null : null;
    if (parsed.form === "project" && parsed.kind !== input.kind) {
      throw new IdRuleError("kind", `id says ${parsed.kind}, row says ${input.kind}`);
    }
    return {
      id,
      layer,
      kind: input.kind,
      space: spaceForParsed(parsed),
      owner,
      bank,
      // An `addr` node is "an address, whoever is there": shared by every run
      // that references it, owned by none, never deleted by a run.
      run_owner: input.kind === "addr" ? null : runOwner,
      address,
      end_address: input.endAddress ?? null,
      name: input.name ?? null,
      attrs: JSON.stringify(input.attrs ?? {}, Object.keys(input.attrs ?? {}).sort()),
      origin: input.origin,
      confidence: input.confidence,
      producer,
      evidence: JSON.stringify(input.evidence ?? []),
    };
  }

  private toEdgeRow(input: EdgeInput, layer: Layer, producer: string, owner: string | null): EdgeRow {
    parseId(input.from);
    parseId(input.to);
    const ev = input.evidence ?? {};
    return {
      from_id: input.from,
      type: input.type,
      to_id: input.to,
      layer,
      evidence_key: input.evidenceKey ?? "",
      origin: input.origin,
      confidence: input.confidence,
      producer,
      owner,
      evidence: JSON.stringify(ev, Object.keys(ev).sort()),
    };
  }

  /**
   * D5. Replace every generated row this producer wrote in this RUN — keyed by
   * (producer, run_owner), the run's artifact stem — in one transaction. The
   * grammatical owner in the id is not the replacement unit: `crt/<bank>`
   * nodes carry no owner, and `addr` nodes belong to nobody and are inserted
   * OR IGNORE. Human rows are not addressed by any statement here.
   */
  replaceGenerated(producer: string, owner: string | null, nodes: NodeInput[], edges: EdgeInput[]): ReplaceResult {
    if (this.readOnly) throw new Error("store is read-only");
    const nodeRows = nodes.map((n) => this.toNodeRow(n, "generated", producer, owner));
    const edgeRows = edges.map((e) => this.toEdgeRow(e, "generated", producer, owner));
    const delNodes = this.db.prepare("DELETE FROM nodes WHERE layer = 'generated' AND producer = ? AND run_owner IS ? AND kind <> 'addr'");
    const delEdges = this.db.prepare("DELETE FROM edges WHERE layer = 'generated' AND producer = ? AND owner IS ?");
    const insNode = this.db.prepare(
      "INSERT INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const insShared = this.db.prepare(
      "INSERT OR IGNORE INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const insEdge = this.db.prepare(
      "INSERT INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    this.db.exec("BEGIN");
    try {
      const dn = delNodes.run(producer, owner).changes;
      const de = delEdges.run(producer, owner).changes;
      for (const n of nodeRows) {
        (n.kind === "addr" ? insShared : insNode).run(n.id, n.layer, n.kind, n.space, n.owner, n.bank, n.run_owner, n.address, n.end_address, n.name, n.attrs, n.origin, n.confidence, n.producer, n.evidence);
      }
      for (const e of edgeRows) insEdge.run(e.from_id, e.type, e.to_id, e.layer, e.evidence_key, e.origin, e.confidence, e.producer, e.owner, e.evidence);
      this.recordProducer(producer);
      this.db.exec("COMMIT");
      return { producer, owner, deletedNodes: Number(dn), deletedEdges: Number(de), insertedNodes: nodeRows.length, insertedEdges: edgeRows.length };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** The one door for human rows (Spec 822 widens it). Upserts a human node. */
  upsertHuman(node: NodeInput, producer = "human"): NodeRow {
    if (this.readOnly) throw new Error("store is read-only");
    const row = this.toNodeRow({ ...node, origin: node.origin ?? "user", confidence: node.confidence ?? "user_asserted" }, "human", producer);
    this.db.prepare(
      `INSERT INTO nodes (id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id, layer) DO UPDATE SET name = excluded.name, attrs = excluded.attrs, end_address = excluded.end_address, evidence = excluded.evidence`,
    ).run(row.id, row.layer, row.kind, row.space, row.owner, row.bank, null, row.address, row.end_address, row.name, row.attrs, row.origin, row.confidence, row.producer, row.evidence);
    return row;
  }

  /** D6 — canonical dump of the generated layer, JSON lines, deterministic order. */
  canonicalDump(layer: Layer = "generated"): string {
    const lines: string[] = [];
    const nodes = this.db.prepare("SELECT * FROM nodes WHERE layer = ? ORDER BY id").all(layer) as unknown as NodeRow[];
    for (const n of nodes) lines.push(JSON.stringify(n, Object.keys(n).sort()));
    const edges = this.db.prepare("SELECT * FROM edges WHERE layer = ? ORDER BY from_id, type, to_id, evidence_key").all(layer) as unknown as EdgeRow[];
    for (const e of edges) lines.push(JSON.stringify(e, Object.keys(e).sort()));
    return `${lines.join("\n")}\n`;
  }

  contentHash(layer: Layer = "generated"): string {
    return createHash("sha256").update(this.canonicalDump(layer)).digest("hex");
  }

  counts(): { nodes: number; edges: number; humanNodes: number; humanEdges: number } {
    const q = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      nodes: q("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'generated'"),
      edges: q("SELECT COUNT(*) AS n FROM edges WHERE layer = 'generated'"),
      humanNodes: q("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human'"),
      humanEdges: q("SELECT COUNT(*) AS n FROM edges WHERE layer = 'human'"),
    };
  }
}
