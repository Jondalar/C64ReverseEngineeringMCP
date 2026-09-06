// Spec 822 §5 — the migration: knowledge/*.json + every *_annotations.json
// under the project → knowledge/graph.sqlite, one BEGIN IMMEDIATE transaction,
// idempotent by the migration ledger (every legacy id is logged exactly once;
// a second run performs zero created|merged|folded actions and leaves the
// canonical dump identical), incremental by the same ledger (a record the JSON
// gained after the first run is picked up by the next).
//
// 822.2 — the same core is the GENERATED IMPORT PATH after the cut-over:
// `importRecords` feeds in-memory legacy-shaped records (analysis-import,
// manifest-import, inventory sync) through `applyLegacyRecords`, after purging
// the artifact's previous contribution (D2: re-analysis replaces the generated
// layer of what it touched; evidence per run, D5). `importAnnotationFile` is
// the annotation-file door (D6): re-imported when the file's hash changed,
// door-owned rows (producer 'human') are never touched.
//
// The legacy row → 818 id resolver (§5), as measured on Wasteland_EF:
//   RAM behaviour (ram hypotheses, display states, state_variable segments)
//     → `<slug>:ram:addr:<hex4>`, no owner — zero page is one address space
//       whichever program's analysis noticed it. Shared node, INSERT OR IGNORE.
//   payload-resident analysis rows → `<slug>:ram/<owner>:entry|segment:<hex4>`.
//     NOT routine / label: those ids belong to the 819 producer, which INSERTs
//     them plainly and would collide with a row 822 had put there first (the
//     gate re-seeds 819 after the migration; §"Built"). The legacy segment and
//     the 819 routine at one address are two producers' views at one address,
//     visible side by side in `graph find`.
//   cartridge rows → `<slug>:crt/<bank>:chip|bank:<hex4>`; two cart images
//     with the same bank layout share the node, each image in evidence.
//   payloads → `<slug>:ram/<stem>:payload:<load|0000>`; an area asset with no
//     load address sits at 0000 with attrs.addressless (the grammar has no
//     address-less project form yet — 818 D1 "later slices append").
//   hand-made rows with an address → the mapped kind under the owner when one
//     resolves, else ownerless (`ram:region|data_block|stage|addr:<hex4>`).
//   hand-made rows without any address (traces, a save descriptor) → prose:
//     an `entity:<kind>` annotation, logged `folded`.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { ArtifactRecord, EntityRecord, FindingRecord, FlowRecord, OpenQuestionRecord, RelationRecord, UserLabelOverride } from "../../project-knowledge/types.js";
import type { DatabaseSync, StatementSync } from "../../platform-kb/sqlite-quiet.js";
import { deriveProjectId, IdRuleError, parseId, spaceForParsed, type Ctx } from "../ids.js";
import { canonicalJson } from "../json.js";
import { contextForArtifact } from "../producers/artifact.js";
import type { Confidence, Layer, NodeRow, Origin } from "../schema.js";
import { GraphStore, graphPath, readProjectSlug } from "../store.js";
import { classifyEntity, classifyFinding, classifyQuestion, classifyRelation, confidenceForScore, normStem, type Classification } from "./classify.js";
import {
  annotationId, ensureSchema822, humanLayerHash, MIGRATION_PRODUCER,
  type AnnotationRow, type ClaimRow, type EvidenceRow, type MigrationAction, type QuestionRow, type TextIndex,
} from "./schema-822.js";

// ------------------------------------------------------------------ types

export interface MigrateOptions {
  projectDir: string;
  /** run the whole migration inside the transaction, then ROLLBACK; the summary is real, the file is untouched */
  dryRun?: boolean;
  /** fixed timestamp for file-imported rows and the run record (tests) */
  now?: string;
}

export interface StoreSummary {
  total: number;
  created: number;
  merged: number;
  folded: number;
  skipped: number;
  already: number;
  ctxByStem: number;
}

export interface FileSummary {
  stem: string;
  owner: string;
  path: string;
  routines: number;
  labels: number;
  segments: number;
  dropped: number;
}

export interface MigrateSummary {
  projectDir: string;
  slug: string;
  dryRun: boolean;
  runId: number;
  sourceHash: string;
  ms: number;
  textIndex: TextIndex;
  stores: Record<"entities" | "findings" | "relations" | "open-questions" | "labels" | "flows" | "annotations", StoreSummary>;
  /** row counts in the graph after the run (after ROLLBACK for a dry run: the pre-run counts) */
  graph: Record<string, number>;
  /** generated 822 nodes by kind, this run's view of the JSON (not the table) */
  nodesByKind: Record<string, number>;
  files: FileSummary[];
  humanLayerHash: string;
  cutoverAt: string;
  /** how many legacy records were read from knowledge/_legacy-822/ instead of knowledge/ */
  legacyDirFiles: string[];
}

/** The legacy record shapes an importer hands in (a subset of the JSON stores). */
export interface LegacyInput {
  artifacts: ArtifactRecord[];
  entities: EntityRecord[];
  findings: FindingRecord[];
  relations: RelationRecord[];
  questions: OpenQuestionRecord[];
  flows: FlowRecord[];
  labels: UserLabelOverride[];
}

export type AddressRange = { start: number; end: number; bank?: number; label?: string };

export interface Target {
  id: string;
  kind: string;
  ctx: Ctx;
  address: number;
  endAddress: number | null;
  note?: "ctx-by-stem" | "ownerless" | "addressless";
}

interface NodeDraft {
  id: string;
  layer: Layer;
  kind: string;
  ctx: Ctx;
  address: number;
  endAddress: number | null;
  name: string | null;
  attrs: Record<string, unknown>;
  origin: Origin;
  confidence: Confidence;
  capturedAt: string;
  runOwner: string | null;
}

interface EdgeDraft {
  from: string;
  type: string;
  to: string;
  layer: Layer;
  origin: Origin;
  confidence: Confidence;
  owner: string | null;
  evidence: Record<string, unknown>;
  score: number;
}

type ClaimDraft = Omit<ClaimRow, "producer">;

export const EDGE_TYPE: Record<string, string> = {
  calls: "CALLS", reads: "READS", writes: "WRITES", loads: "LOADS", stores: "STORES", contains: "CONTAINS",
  "maps-to": "MAPS_TO", "depends-on": "DEPENDS_ON", "derived-from": "DERIVED_FROM", precedes: "PRECEDES",
  follows: "FOLLOWS", references: "REFERENCES_DATA", documents: "DOCUMENTS", other: "RELATES_TO",
};

// tags every analyze_prg producer sets; the remaining tag is the value (tags are stored sorted)
export const PRODUCER_TAGS = new Set(["analysis-import", "ram-hypothesis", "segment-classification", "display-state", "display-transfer", "segment", "entry-point", "xref", "entrypoint-map", "derived-question", "user"]);

export const HUMAN_KIND: Record<string, string> = {
  routine: "routine", "irq-handler": "routine", "entry-point": "entry", symbol: "label", "code-segment": "segment",
  "data-table": "data_block", "lookup-table": "data_block", "pointer-table": "data_block",
  "memory-region": "region", "screen-region": "region", "loader-stage": "stage",
  "memory-address": "addr", "state-variable": "addr", "io-register": "addr",
  payload: "payload", "disk-file": "payload", asset: "payload",
  chip: "chip", "cartridge-bank": "bank", "disk-track": "track", other: "other",
};

/** The six legacy stores 822 migrates; after the cut-over they live under knowledge/_legacy-822/. */
export const LEGACY_STORE_FILES = ["entities.json", "findings.json", "relations.json", "open-questions.json", "labels.user.json"] as const;
export const LEGACY_DIR = "_legacy-822";

// ------------------------------------------------------------------ helpers

const hex4 = (n: number) => (n & 0xffff).toString(16).padStart(4, "0");
const hex4U = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const sortedJson = (v: Record<string, unknown>) => canonicalJson(v);
const clip = (s: string | undefined, n = 600) => (s === undefined ? null : s.length > n ? `${s.slice(0, n)}…` : s);
const compact = (o: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
};

function readItems<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as { items?: T[] } | T[];
  return Array.isArray(raw) ? raw : raw.items ?? [];
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function findAnnotationFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || !existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".") || (depth === 0 && entry === "knowledge")) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findAnnotationFiles(p, out, depth + 1);
    else if (entry.endsWith("_annotations.json")) out.push(p);
  }
  return out.sort();
}

function parseHex(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : undefined;
  if (typeof v !== "string") return undefined;
  const n = parseInt(v.replace(/^\$/u, "").replace(/^0x/iu, ""), 16);
  return Number.isFinite(n) && n >= 0 && n <= 0xffff ? n : undefined;
}

function newer(a: string, b: string): boolean {
  return a > b;
}

/** The legacy id normalisation analysis-import / manifest-import use (`stableId`). */
export function legacyIdToken(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
}

// ------------------------------------------------------------------ ledger + writer

export class Ledger {
  /** migrated by an earlier run, or claimed by this run — a legacy id is processed once */
  readonly seen = new Set<string>();
  readonly counts: Record<string, StoreSummary> = {};

  constructor(private readonly db: DatabaseSync, readonly runId: number) {
    for (const row of db.prepare("SELECT legacy_store, legacy_id FROM migration_log").all() as Array<{ legacy_store: string; legacy_id: string }>) {
      this.seen.add(`${row.legacy_store} ${row.legacy_id}`);
    }
    this.insert = db.prepare("INSERT INTO migration_log (legacy_store, legacy_id, action, target_table, target_id, note, run_id) VALUES (?,?,?,?,?,?,?)");
  }

  private readonly insert: StatementSync;

  private bucket(store: string): StoreSummary {
    const key = store.startsWith("annotations:") ? "annotations" : store;
    return (this.counts[key] ??= { total: 0, created: 0, merged: 0, folded: 0, skipped: 0, already: 0, ctxByStem: 0 });
  }

  /** true when the legacy id was migrated by an earlier run — the caller skips it */
  already(store: string, id: string): boolean {
    const b = this.bucket(store);
    b.total += 1;
    if (this.seen.has(`${store} ${id}`)) { b.already += 1; return true; }
    return false;
  }

  log(store: string, id: string, action: MigrationAction, targetTable: string | null, targetId: string | null, note: string | null = null): void {
    const key = `${store} ${id}`;
    if (this.seen.has(key)) throw new Error(`migration_log: ${store}/${id} logged twice`);
    this.seen.add(key);
    this.insert.run(store, id, action, targetTable, targetId, note, this.runId);
    const b = this.bucket(store);
    if (action === "created") b.created += 1;
    else if (action === "merged") b.merged += 1;
    else if (action === "folded") b.folded += 1;
    else b.skipped += 1;
    if (note === "ctx-by-stem") b.ctxByStem += 1;
  }
}

export class Writer {
  private readonly getNode: StatementSync;
  private readonly insNode: StatementSync;
  private readonly insNodeIgnore: StatementSync;
  private readonly updNode: StatementSync;
  private readonly insEdge: StatementSync;
  private readonly getClaim: StatementSync;
  private readonly insClaim: StatementSync;
  private readonly updClaim: StatementSync;
  private readonly updClaimValidation: StatementSync;
  private readonly insEvidence: StatementSync;
  private readonly getAnnotation: StatementSync;
  private readonly insAnnotation: StatementSync;
  private readonly updAnnotation: StatementSync;
  private readonly getQuestion: StatementSync;
  private readonly insQuestion: StatementSync;
  private readonly updQuestion: StatementSync;

  constructor(private readonly db: DatabaseSync) {
    this.getNode = db.prepare("SELECT producer, attrs FROM nodes WHERE id = ? AND layer = ?");
    const cols = "(id, layer, kind, space, owner, bank, run_owner, address, end_address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
    this.insNode = db.prepare(`INSERT INTO nodes ${cols}`);
    this.insNodeIgnore = db.prepare(`INSERT OR IGNORE INTO nodes ${cols}`);
    this.updNode = db.prepare("UPDATE nodes SET kind = ?, end_address = ?, name = ?, attrs = ?, origin = ?, confidence = ?, run_owner = ? WHERE id = ? AND layer = ? AND producer = ?");
    this.insEdge = db.prepare("INSERT OR IGNORE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)");
    this.getClaim = db.prepare("SELECT producer, updated_at, validation, validated_by FROM claims WHERE node_id = ? AND claim = ? AND layer = ?");
    this.insClaim = db.prepare("INSERT INTO claims (node_id, claim, value, layer, origin, confidence, score, status, validation, validated_by, superseded_by, producer, attrs, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    this.updClaim = db.prepare("UPDATE claims SET value = ?, origin = ?, confidence = ?, score = ?, status = ?, superseded_by = ?, attrs = ?, updated_at = ? WHERE node_id = ? AND claim = ? AND layer = ? AND producer = ?");
    this.updClaimValidation = db.prepare("UPDATE claims SET validation = ?, validated_by = COALESCE(?, validated_by) WHERE node_id = ? AND claim = ? AND layer = ? AND validation <> 'answered'");
    this.insEvidence = db.prepare("INSERT OR IGNORE INTO evidence (target_table, target_key, legacy_id, artifact_id, excerpt, captured_at, producer, attrs) VALUES (?,?,?,?,?,?,?,?)");
    this.getAnnotation = db.prepare("SELECT producer FROM annotations WHERE id = ?");
    this.insAnnotation = db.prepare("INSERT INTO annotations (id, node_id, kind, title, body, name, tags, source_path, legacy_id, layer, origin, confidence, score, status, producer, attrs, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    this.updAnnotation = db.prepare("UPDATE annotations SET node_id = ?, title = ?, body = ?, name = ?, tags = ?, source_path = ?, legacy_id = ?, layer = ?, origin = ?, confidence = ?, score = ?, status = ?, attrs = ?, updated_at = ? WHERE id = ? AND producer = ?");
    this.getQuestion = db.prepare("SELECT producer, answer FROM questions WHERE id = ?");
    this.insQuestion = db.prepare("INSERT INTO questions (id, node_id, kind, title, body, status, priority, layer, origin, answer, answered_by, producer, attrs, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    this.updQuestion = db.prepare("UPDATE questions SET node_id = ?, kind = ?, title = ?, body = ?, status = ?, priority = ?, layer = ?, origin = ?, answer = COALESCE(?, answer), answered_by = COALESCE(?, answered_by), attrs = ?, updated_at = ? WHERE id = ? AND producer = ?");
  }

  /** returns what happened: created | merged (an 822 row updated) | kept (another producer's row) | shared (addr, OR IGNORE) */
  node(d: NodeDraft): "created" | "merged" | "kept" | "shared" {
    const parsed = parseId(d.id);
    const owner = parsed.form === "project" ? parsed.ctx.owner ?? null : null;
    const bank = parsed.form === "project" ? parsed.ctx.bank ?? null : null;
    const attrs = sortedJson(d.attrs);
    const row: NodeRow = {
      id: d.id, layer: d.layer, kind: d.kind, space: spaceForParsed(parsed), owner, bank,
      run_owner: d.kind === "addr" ? null : d.runOwner, address: d.address, end_address: d.endAddress, name: d.name,
      attrs, origin: d.origin, confidence: d.confidence, producer: MIGRATION_PRODUCER, evidence: "[]",
    };
    if (d.kind === "addr" && d.layer === "generated") {
      const r = this.insNodeIgnore.run(row.id, row.layer, row.kind, row.space, row.owner, row.bank, row.run_owner, row.address, row.end_address, row.name, row.attrs, row.origin, row.confidence, row.producer, row.evidence);
      return Number(r.changes) > 0 ? "created" : "shared";
    }
    const existing = this.getNode.get(d.id, d.layer) as { producer: string; attrs: string } | undefined;
    if (!existing) {
      this.insNode.run(row.id, row.layer, row.kind, row.space, row.owner, row.bank, row.run_owner, row.address, row.end_address, row.name, row.attrs, row.origin, row.confidence, row.producer, row.evidence);
      return "created";
    }
    if (existing.producer !== MIGRATION_PRODUCER) return "kept";
    const prev = JSON.parse(existing.attrs) as { captured_at?: string };
    if (prev.captured_at !== undefined && d.attrs.captured_at !== undefined && newer(prev.captured_at, String(d.attrs.captured_at))) return "merged";
    this.updNode.run(row.kind, row.end_address, row.name, row.attrs, row.origin, row.confidence, row.run_owner, row.id, row.layer, MIGRATION_PRODUCER);
    return "merged";
  }

  edge(e: EdgeDraft): boolean {
    const r = this.insEdge.run(e.from, e.type, e.to, e.layer, "", e.origin, e.confidence, MIGRATION_PRODUCER, e.owner, sortedJson(e.evidence));
    return Number(r.changes) > 0;
  }

  claim(c: ClaimDraft): "created" | "merged" | "kept" {
    const existing = this.getClaim.get(c.node_id, c.claim, c.layer) as { producer: string; updated_at: string } | undefined;
    if (!existing) {
      this.insClaim.run(c.node_id, c.claim, c.value, c.layer, c.origin, c.confidence, c.score, c.status, c.validation, c.validated_by, c.superseded_by, MIGRATION_PRODUCER, c.attrs, c.updated_at);
      return "created";
    }
    if (existing.producer !== MIGRATION_PRODUCER) return "kept";
    if (newer(existing.updated_at, c.updated_at)) return "merged";
    this.updClaim.run(c.value, c.origin, c.confidence, c.score, c.status, c.superseded_by, c.attrs, c.updated_at, c.node_id, c.claim, c.layer, MIGRATION_PRODUCER);
    return "merged";
  }

  validate(nodeId: string, claim: string, validation: "answered" | "unvalidated" | "invalidated", validatedBy: string | null): void {
    if (validation === "unvalidated") return; // never downgrade
    this.updClaimValidation.run(validation, validatedBy, nodeId, claim, "generated");
  }

  evidence(e: EvidenceRow): void {
    this.insEvidence.run(e.target_table, e.target_key, e.legacy_id, e.artifact_id, e.excerpt, e.captured_at, e.producer, e.attrs);
  }

  annotation(a: AnnotationRow): "created" | "merged" | "kept" {
    const existing = this.getAnnotation.get(a.id) as { producer: string } | undefined;
    if (!existing) {
      this.insAnnotation.run(a.id, a.node_id, a.kind, a.title, a.body, a.name, a.tags, a.source_path, a.legacy_id, a.layer, a.origin, a.confidence, a.score, a.status, MIGRATION_PRODUCER, a.attrs, a.created_at, a.updated_at);
      return "created";
    }
    if (existing.producer !== MIGRATION_PRODUCER) return "kept";
    this.updAnnotation.run(a.node_id, a.title, a.body, a.name, a.tags, a.source_path, a.legacy_id, a.layer, a.origin, a.confidence, a.score, a.status, a.attrs, a.updated_at, a.id, MIGRATION_PRODUCER);
    return "merged";
  }

  question(q: QuestionRow): "created" | "merged" | "kept" {
    const existing = this.getQuestion.get(q.id) as { producer: string } | undefined;
    if (!existing) {
      this.insQuestion.run(q.id, q.node_id, q.kind, q.title, q.body, q.status, q.priority, q.layer, q.origin, q.answer, q.answered_by, MIGRATION_PRODUCER, q.attrs, q.created_at, q.updated_at);
      return "created";
    }
    if (existing.producer !== MIGRATION_PRODUCER) return "kept";
    this.updQuestion.run(q.node_id, q.kind, q.title, q.body, q.status, q.priority, q.layer, q.origin, q.answer, q.answered_by, q.attrs, q.updated_at, q.id, MIGRATION_PRODUCER);
    return "merged";
  }
}

// ------------------------------------------------------------------ resolver

/** A payload the graph already knows — the owner stems an importer's rows resolve to after the cut-over. */
export interface GraphPayload {
  id: string;
  owner: string;
  sourceArtifactId?: string;
}

/** Payload nodes in the graph, by id and by source artifact (both layers, human first). */
export function graphPayloads(db: DatabaseSync): GraphPayload[] {
  const rows = db.prepare("SELECT id, owner, attrs FROM nodes WHERE kind = 'payload' ORDER BY id, CASE layer WHEN 'human' THEN 0 ELSE 1 END").all() as Array<{ id: string; owner: string | null; attrs: string }>;
  const out: GraphPayload[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id) || !r.owner) continue;
    seen.add(r.id);
    let src: string | undefined;
    try { src = (JSON.parse(r.attrs) as { payload?: { source_artifact_id?: string } }).payload?.source_artifact_id; } catch { /* attrs is JSON by CHECK */ }
    out.push({ id: r.id, owner: r.owner, sourceArtifactId: src });
  }
  return out;
}

export class Resolver {
  readonly artById = new Map<string, ArtifactRecord>();
  readonly entById = new Map<string, EntityRecord>();
  readonly payloadBySource = new Map<string, EntityRecord>();
  readonly classOf = new Map<string, Classification>();
  private readonly graphPayloadById = new Map<string, GraphPayload>();
  private readonly graphPayloadBySource = new Map<string, GraphPayload>();
  private readonly targets = new Map<string, Target | null>();

  constructor(readonly slug: string, artifacts: ArtifactRecord[], entities: EntityRecord[], payloads: GraphPayload[] = []) {
    for (const a of artifacts) this.artById.set(a.id, a);
    for (const e of entities) {
      this.entById.set(e.id, e);
      this.classOf.set(e.id, classifyEntity(e));
      if (e.kind === "payload" && e.payloadSourceArtifactId && !this.payloadBySource.has(e.payloadSourceArtifactId)) this.payloadBySource.set(e.payloadSourceArtifactId, e);
    }
    for (const p of payloads) {
      this.graphPayloadById.set(p.id, p);
      if (p.sourceArtifactId && !this.graphPayloadBySource.has(p.sourceArtifactId)) this.graphPayloadBySource.set(p.sourceArtifactId, p);
    }
  }

  /** the owner stem: payload name via payloadId / the artifact chain's payload, else the source binary's stem (ctx-by-stem) */
  ownerFor(e: EntityRecord): { owner: string; note?: "ctx-by-stem" } | undefined {
    const pl = e.payloadId ? this.entById.get(e.payloadId) : undefined;
    if (pl && pl.kind === "payload") return { owner: normStem(pl.name) };
    if (e.payloadId) {
      // after the cut-over a payloadId is a graph node id (or an alias the ledger resolved to one)
      const gp = this.graphPayloadById.get(e.payloadId);
      if (gp) return { owner: gp.owner };
      try {
        const parsed = parseId(e.payloadId);
        if (parsed.form === "project" && parsed.ctx.owner) return { owner: parsed.ctx.owner };
      } catch { /* not a graph id */ }
    }
    if (e.kind === "payload" || e.kind === "disk-file") return { owner: normStem(e.name) };
    const order: ArtifactRecord[] = [];
    const seen = new Set<string>();
    const queue = (e.artifactIds ?? []).map((id) => this.artById.get(id)).filter((a): a is ArtifactRecord => Boolean(a));
    while (queue.length) {
      const a = queue.shift()!;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      order.push(a);
      const p = this.payloadBySource.get(a.id);
      if (p) return { owner: normStem(p.name) };
      const gp = this.graphPayloadBySource.get(a.id);
      if (gp) return { owner: gp.owner };
      for (const s of a.sourceArtifactIds ?? []) { const b = this.artById.get(s); if (b) queue.push(b); }
    }
    const binary = order.find((a) => a.kind === "prg" || a.kind === "raw" || a.kind === "crt" || /\.(prg|bin)$/iu.test(a.relativePath ?? a.path ?? ""));
    const pick = binary ?? order.find((a) => a.kind !== "manifest" && a.kind !== "g64" && a.kind !== "d64");
    if (pick) return { owner: normStem(basename(pick.relativePath ?? pick.path ?? pick.title)), note: "ctx-by-stem" };
    return undefined;
  }

  private project(ctx: Ctx, kind: string, address: number): string {
    return deriveProjectId({ slug: this.slug, ctx, kind, address });
  }

  private addrTarget(address: number, endAddress: number | null, note?: Target["note"]): Target {
    const ctx: Ctx = { space: "ram" };
    return { id: this.project(ctx, "addr", address), kind: "addr", ctx, address, endAddress, note };
  }

  target(e: EntityRecord): Target | undefined {
    if (this.targets.has(e.id)) return this.targets.get(e.id) ?? undefined;
    let t: Target | undefined;
    try { t = this.derive(e); } catch (err) {
      if (!(err instanceof IdRuleError)) throw err;
      t = undefined;
    }
    this.targets.set(e.id, t ?? null);
    return t;
  }

  private derive(e: EntityRecord): Target | undefined {
    const cls = this.classOf.get(e.id) ?? classifyEntity(e);
    const range = e.addressRange as AddressRange | undefined;
    const start = range?.start ?? e.payloadLoadAddress;
    const end = range && range.end > range.start ? range.end & 0xffff : null;

    if (cls.bucket === "analysis-import") {
      if (start === undefined) return undefined;
      const tags = e.tags ?? [];
      const ramBehaviour = tags.includes("ram-hypothesis") || tags.includes("display-state") || (tags.includes("segment") && e.kind === "state-variable");
      if (ramBehaviour) return this.addrTarget(start, end);
      const kind = e.kind === "entry-point" ? "entry" : "segment";
      const res = this.ownerFor(e);
      if (!res) return this.addrTarget(start, end, "ownerless");
      const ctx: Ctx = range?.bank !== undefined ? { space: "crt", bank: range.bank } : { space: "ram", owner: res.owner };
      return { id: this.project(ctx, kind, start), kind, ctx, address: start, endAddress: end, note: res.note };
    }

    if (e.kind === "chip") {
      if (start === undefined || range?.bank === undefined) return undefined;
      const ctx: Ctx = { space: "crt", bank: range.bank };
      return { id: this.project(ctx, "chip", start), kind: "chip", ctx, address: start, endAddress: end };
    }
    if (e.kind === "cartridge-bank") {
      const m = e.name.match(/(\d+)\s*$/u);
      const bank = range?.bank ?? (m ? parseInt(m[1]!, 10) : undefined);
      if (bank === undefined) return undefined;
      const ctx: Ctx = { space: "crt", bank };
      return { id: this.project(ctx, "bank", 0x8000), kind: "bank", ctx, address: 0x8000, endAddress: null };
    }
    if (e.kind === "payload" || e.kind === "disk-file" || e.kind === "asset") {
      const ctx: Ctx = { space: "ram", owner: normStem(e.name) };
      const address = e.payloadLoadAddress ?? start;
      if (address === undefined) return { id: this.project(ctx, "payload", 0), kind: "payload", ctx, address: 0, endAddress: null, note: "addressless" };
      return { id: this.project(ctx, "payload", address), kind: "payload", ctx, address, endAddress: end };
    }
    if (start === undefined) return undefined;
    const kind = HUMAN_KIND[e.kind] ?? "other";
    if (kind === "addr") return this.addrTarget(start, end);
    const res = this.ownerFor(e);
    if (!res) {
      if (kind === "routine" || kind === "label") return this.addrTarget(start, end, "ownerless");
      const ctx: Ctx = { space: "ram" };
      return { id: this.project(ctx, kind, start), kind, ctx, address: start, endAddress: end, note: "ownerless" };
    }
    const ctx: Ctx = range?.bank !== undefined ? { space: "crt", bank: range.bank } : { space: "ram", owner: res.owner };
    return { id: this.project(ctx, kind, start), kind, ctx, address: start, endAddress: end, note: res.note };
  }
}

// ------------------------------------------------------------------ the core: legacy-shaped records → graph rows

export interface MigrationContext {
  db: DatabaseSync;
  slug: string;
  now: string;
  ledger: Ledger;
  writer: Writer;
  resolver: Resolver;
  summary: Pick<MigrateSummary, "nodesByKind" | "files">;
}

export function payloadAttrs(e: EntityRecord): Record<string, unknown> | undefined {
  const p = compact({
    load_address: e.payloadLoadAddress, format: e.payloadFormat, packer: e.payloadPacker, source_artifact_id: e.payloadSourceArtifactId,
    depacked_artifact_id: e.payloadDepackedArtifactId, asm_artifact_ids: e.payloadAsmArtifactIds, content_hash: e.payloadContentHash,
    loader_model_id: e.payloadLoaderModelId, claimed_by_lut_id: e.payloadClaimedByLutId, claimed_by_row: e.payloadClaimedByRow, disk_hint: e.payloadDiskHint,
  });
  return Object.keys(p).length ? p : undefined;
}

/** Runs the §5 mapping over legacy-shaped records inside the caller's transaction. */
export function applyLegacyRecords(ctx: MigrationContext, input: Omit<LegacyInput, "artifacts">): void {
  const { db, slug, now, ledger, writer, resolver, summary } = ctx;
  const { entities, findings, relations, questions, flows, labels } = input;
  const migrated = MIGRATION_PRODUCER;

  // ---------------------------------------------------------- entities → nodes + evidence
  const nodeDrafts = new Map<string, NodeDraft>();
  const foldEntity: EntityRecord[] = [];
  const entityAction = new Map<string, { action: MigrationAction; note: string | null; target: Target | undefined }>();

  for (const e of entities) {
    if (ledger.already("entities", e.id)) continue;
    const cls = resolver.classOf.get(e.id)!;
    const t = resolver.target(e);
    if (!t) { foldEntity.push(e); continue; }
    const capturedAt = e.evidence?.[0]?.capturedAt ?? e.updatedAt ?? e.createdAt ?? now;
    const tags = e.tags ?? [];
    const valueTag = tags.find((x) => !PRODUCER_TAGS.has(x));
    // 822.2: the fields a projection back into the EntityRecord shape needs
    // (payload_id, related ids, aliases, internal) ride along in attrs.
    const roundTrip = compact({
      payload_id: e.payloadId, related_entity_ids: e.relatedEntityIds?.length ? e.relatedEntityIds : undefined,
      internal: e.internal === true ? true : undefined, aliases: e.aliases?.length ? e.aliases : undefined,
      artifact_ids: e.artifactIds?.length ? e.artifactIds : undefined, legacy_id: e.id,
    });
    const attrs: Record<string, unknown> = cls.layer === "generated"
      ? compact({
          ...roundTrip,
          legacy_kind: e.kind, tags, score: e.confidence, status: e.status, captured_at: capturedAt,
          segment_kind: tags.includes("segment") ? valueTag : undefined,
          entry_source: e.kind === "entry-point" ? tags.find((x) => x !== "analysis-import" && x !== "entry-point") : undefined,
          addressless: t.note === "addressless" ? true : undefined,
          ctx_by_stem: t.note === "ctx-by-stem" ? true : undefined,
          payload: e.kind === "payload" || e.kind === "disk-file" ? payloadAttrs(e) : undefined,
          medium_spans: e.mediumSpans?.length ? e.mediumSpans : undefined,
          medium_role: e.mediumRole,
        })
      : compact({
          ...roundTrip,
          legacy_kind: e.kind, legacy_origin: "user", tags, score: e.confidence, status: e.status, captured_at: capturedAt,
          payload: e.kind === "payload" ? payloadAttrs(e) : undefined,
          medium_spans: e.mediumSpans?.length ? e.mediumSpans : undefined,
          medium_role: e.mediumRole, ownerless: t.note === "ownerless" ? true : undefined,
          addressless: t.note === "addressless" ? true : undefined,
          evidence_refs: e.evidence?.length ? e.evidence : undefined,
        });
    const draft: NodeDraft = {
      id: t.id, layer: cls.layer, kind: t.kind, ctx: t.ctx, address: t.address, endAddress: t.endAddress,
      name: t.kind === "addr" && cls.layer === "generated" ? null : e.name,
      attrs, origin: cls.origin, confidence: cls.layer === "human" ? "user_asserted" : confidenceForScore(e.confidence, cls.origin),
      capturedAt, runOwner: t.ctx.owner ?? null,
    };
    const key = `${t.id} ${cls.layer}`;
    const prev = nodeDrafts.get(key);
    if (!prev) { nodeDrafts.set(key, draft); entityAction.set(e.id, { action: "created", note: t.note ?? null, target: t }); }
    else {
      if (newer(capturedAt, prev.capturedAt)) nodeDrafts.set(key, draft); // newest wins (D5)
      entityAction.set(e.id, { action: "merged", note: t.note ?? null, target: t });
    }
    writer.evidence({
      target_table: "nodes", target_key: t.id, legacy_id: e.id, artifact_id: e.artifactIds?.[0] ?? null, excerpt: clip(e.summary),
      captured_at: capturedAt, producer: migrated, attrs: sortedJson(compact({ layer: cls.layer, kind: e.kind, name: e.name, score: e.confidence })),
    });
  }
  const nodeOutcome = new Map<string, string>();
  for (const [key, d] of nodeDrafts) {
    nodeOutcome.set(key, writer.node(d));
    if (d.layer === "generated") summary.nodesByKind[d.kind] = (summary.nodesByKind[d.kind] ?? 0) + 1;
  }
  for (const [legacyId, a] of entityAction) {
    const key = `${a.target!.id} ${resolver.classOf.get(legacyId)!.layer}`;
    const outcome = nodeOutcome.get(key);
    const action: MigrationAction = a.action === "created" && (outcome === "created" || outcome === "shared") ? "created" : "merged";
    const note = a.note ?? (outcome === "kept" ? "kept-door-row" : null);
    ledger.log("entities", legacyId, action, "nodes", a.target!.id, note);
  }
  for (const e of foldEntity) {
    // no address at all (traces, a save descriptor): prose on the project, not a node
    const cls = resolver.classOf.get(e.id)!;
    const id = annotationId(null, `entity:${e.kind}`, e.name);
    writer.annotation({
      id, node_id: null, kind: `entity:${e.kind}`, title: e.name, body: e.summary ?? null, name: e.name, tags: JSON.stringify(e.tags ?? []),
      source_path: null, legacy_id: e.id, layer: cls.layer, origin: cls.origin, confidence: cls.layer === "human" ? "user_asserted" : confidenceForScore(e.confidence, cls.origin),
      score: e.confidence ?? null, status: e.status ?? "active", producer: migrated,
      attrs: sortedJson(compact({ legacy_kind: e.kind, legacy_origin: cls.layer === "human" ? "user" : undefined, artifact_ids: e.artifactIds, related_entity_ids: e.relatedEntityIds, evidence_refs: e.evidence?.length ? e.evidence : undefined, payload: payloadAttrs(e), medium_spans: e.mediumSpans?.length ? e.mediumSpans : undefined, medium_role: e.mediumRole, aliases: e.aliases?.length ? e.aliases : undefined, internal: e.internal === true ? true : undefined })),
      created_at: e.createdAt ?? now, updated_at: e.updatedAt ?? now,
    });
    writer.evidence({ target_table: "annotations", target_key: id, legacy_id: e.id, artifact_id: e.artifactIds?.[0] ?? null, excerpt: clip(e.summary), captured_at: e.evidence?.[0]?.capturedAt ?? e.createdAt ?? now, producer: migrated, attrs: sortedJson(compact({ kind: e.kind, name: e.name, score: e.confidence })) });
    ledger.log("entities", e.id, "folded", "annotations", id, "no-address");
  }
  // the summary → an `entity` annotation on the node, for hand-made rows (§5)
  for (const e of entities) {
    const a = entityAction.get(e.id);
    const cls = resolver.classOf.get(e.id)!;
    if (!a || cls.layer !== "human" || !e.summary) continue;
    const id = annotationId(a.target!.id, "entity", e.name);
    writer.annotation({
      id, node_id: a.target!.id, kind: "entity", title: e.name, body: e.summary, name: e.name, tags: JSON.stringify(e.tags ?? []), source_path: null, legacy_id: e.id,
      layer: "human", origin: cls.origin, confidence: "user_asserted", score: e.confidence ?? null, status: e.status ?? "active", producer: migrated,
      attrs: sortedJson(compact({ legacy_kind: e.kind, legacy_origin: "user" })), created_at: e.createdAt ?? now, updated_at: e.updatedAt ?? now,
    });
  }

  // ---------------------------------------------------------- findings → claims / annotations
  const claimDrafts = new Map<string, ClaimDraft>();
  const claimOfFinding = new Map<string, { node: string; claim: string }>();
  const findingLog: Array<[string, MigrationAction, string | null, string | null, string | null]> = [];

  const claimFor = (f: FindingRecord): { node: string; claim: string; value: string; labelHint?: string } | undefined => {
    const tags = f.tags ?? [];
    const ent = (f.entityIds ?? []).map((id) => resolver.entById.get(id)).find((x): x is EntityRecord => Boolean(x));
    const range = f.addressRange as AddressRange | undefined;
    const valueTag = tags.find((x) => !PRODUCER_TAGS.has(x));
    if (tags.includes("ram-hypothesis")) {
      const start = range?.start ?? (ent?.addressRange as AddressRange | undefined)?.start;
      if (start === undefined) return undefined;
      const kind = (ent?.tags ?? []).find((x) => !PRODUCER_TAGS.has(x)) ?? f.title.match(/behaves like (\S+)/u)?.[1] ?? "unknown";
      return { node: deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: start }), claim: "behaves_like", value: kind, labelHint: ent?.name };
    }
    if (tags.includes("segment-classification")) {
      const t = ent ? resolver.target(ent) : undefined;
      if (!t) return undefined;
      return { node: t.id, claim: "segment_kind", value: valueTag ?? f.title.match(/classified as (\S+)/u)?.[1] ?? "unknown" };
    }
    if (tags.includes("display-state")) {
      const t = ent ? resolver.target(ent) : undefined;
      if (!t) return undefined;
      return { node: t.id, claim: "display_state", value: "inferred" };
    }
    if (tags.includes("display-transfer")) {
      const start = range?.start ?? f.evidence?.[0]?.addressRange?.start;
      if (start === undefined) return undefined;
      return { node: deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: start }), claim: "display_transfer", value: valueTag ?? "unknown" };
    }
    const t = ent ? resolver.target(ent) : undefined;
    const start = range?.start;
    const node = t?.id ?? (start !== undefined ? deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: start }) : undefined);
    if (!node) return undefined;
    return { node, claim: valueTag ?? f.kind, value: f.kind };
  };

  const nodeForHumanFinding = (f: FindingRecord): string | null => {
    const range = f.addressRange as AddressRange | undefined;
    if (range) return deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: range.start & 0xffff });
    for (const id of f.entityIds ?? []) {
      const e = resolver.entById.get(id);
      const t = e ? resolver.target(e) : undefined;
      if (t) return t.id;
      // a graph node id (post-cut-over record)
      try { parseId(id); return id; } catch { /* not a graph id */ }
    }
    return null;
  };

  for (const f of findings) {
    const cls = classifyFinding(f);
    const capturedAt = f.evidence?.[0]?.capturedAt ?? f.createdAt ?? now;
    if (cls.bucket === "analysis-import") {
      const c = claimFor(f);
      if (c) claimOfFinding.set(f.id, { node: c.node, claim: c.claim });
      if (ledger.already("findings", f.id)) continue;
      if (!c) { findingLog.push([f.id, "skipped", null, null, "no-node"]); continue; }
      const key = `${c.node} ${c.claim}`;
      const draft: ClaimDraft = {
        node_id: c.node, claim: c.claim, value: c.value, layer: "generated", origin: "static", confidence: confidenceForScore(f.confidence, "static"),
        score: f.confidence ?? null, status: f.status === "archived" ? "archived" : "active", validation: "unvalidated", validated_by: null,
        superseded_by: f.archivedBy ?? null, attrs: sortedJson(compact({ label_hint: c.labelHint, legacy_kind: f.kind, title: f.title, legacy_status: f.status, tags: f.tags })), updated_at: capturedAt,
      };
      const prev = claimDrafts.get(key);
      if (!prev) { claimDrafts.set(key, draft); findingLog.push([f.id, "created", "claims", `${c.node}|${c.claim}`, null]); }
      else {
        if (newer(capturedAt, prev.updated_at)) claimDrafts.set(key, draft);
        findingLog.push([f.id, "merged", "claims", `${c.node}|${c.claim}`, null]);
      }
      writer.evidence({
        target_table: "claims", target_key: `${c.node}|${c.claim}`, legacy_id: f.id, artifact_id: f.artifactIds?.[0] ?? null, excerpt: clip(f.summary),
        captured_at: capturedAt, producer: migrated, attrs: sortedJson(compact({ value: c.value, score: f.confidence, status: f.status, title: f.title, address_range: f.addressRange ?? f.evidence?.[0]?.addressRange })),
      });
      continue;
    }
    if (ledger.already("findings", f.id)) continue;
    if (cls.bucket === "annotation-mirror") {
      // Spec 055's mirror of the annotation file: the file is imported below, the row is not migrated (D6)
      ledger.log("findings", f.id, "folded", null, null, "annotation-file-is-source");
      continue;
    }
    const nodeId = nodeForHumanFinding(f);
    const kind = `finding:${f.kind}`;
    const id = annotationId(nodeId, kind, f.title);
    const outcome = writer.annotation({
      id, node_id: nodeId, kind, title: f.title, body: f.summary ?? null, name: null, tags: JSON.stringify(f.tags ?? []), source_path: null, legacy_id: f.id,
      layer: cls.layer, origin: cls.origin, confidence: cls.layer === "human" ? "user_asserted" : confidenceForScore(f.confidence, cls.origin),
      score: f.confidence ?? null, status: f.status ?? "proposed", producer: migrated,
      attrs: sortedJson(compact({ legacy_origin: cls.layer === "human" ? "user" : undefined, entity_ids: f.entityIds, artifact_ids: f.artifactIds, relation_ids: f.relationIds, flow_ids: f.flowIds, payload_id: f.payloadId, address_range: f.addressRange, archived_by: f.archivedBy })),
      created_at: f.createdAt ?? now, updated_at: f.updatedAt ?? now,
    });
    writer.evidence({ target_table: "annotations", target_key: id, legacy_id: f.id, artifact_id: f.artifactIds?.[0] ?? null, excerpt: clip(f.summary), captured_at: capturedAt, producer: migrated, attrs: sortedJson(compact({ kind: f.kind, title: f.title, score: f.confidence, status: f.status })) });
    (f.evidence ?? []).forEach((ev, i) => writer.evidence({
      target_table: "annotations", target_key: id, legacy_id: `${f.id}#${i}`, artifact_id: ev.artifactId ?? null,
      excerpt: clip(ev.excerpt ?? ev.note ?? ev.title), captured_at: ev.capturedAt ?? capturedAt, producer: migrated,
      attrs: sortedJson(compact({ kind: ev.kind, title: ev.title, note: ev.note, address_range: ev.addressRange, entity_id: ev.entityId, finding_id: ev.findingId, file: ev.fileLocation })),
    }));
    ledger.log("findings", f.id, outcome === "created" ? "created" : "merged", "annotations", id, outcome === "kept" ? "kept-door-row" : null);
  }
  const claimOutcome = new Map<string, string>();
  for (const [key, c] of claimDrafts) claimOutcome.set(key, writer.claim(c));
  for (const [id, action, table, target, note] of findingLog) {
    if (action === "created" && target) {
      const outcome = claimOutcome.get(target.replace("|", " "));
      ledger.log("findings", id, outcome === "created" ? "created" : "merged", table, target, outcome === "kept" ? "kept-door-row" : note);
    } else ledger.log("findings", id, action, table, target, note);
  }

  // ---------------------------------------------------------- relations → edges
  const edgeDrafts = new Map<string, EdgeDraft>();
  const relationLog: Array<[string, MigrationAction, string, string]> = [];
  const graphEndpoint = (id: string): Target | undefined => {
    try {
      const p = parseId(id);
      if (p.form === "project") return { id, kind: p.kind, ctx: p.ctx, address: p.address, endAddress: null };
      if (p.form === "subsystem") return { id, kind: "subsystem", ctx: { space: "ram" }, address: 0, endAddress: null };
      return { id, kind: p.kind, ctx: { space: "ram" }, address: p.address, endAddress: null };
    } catch { return undefined; }
  };
  for (const r of relations) {
    if (ledger.already("relations", r.id)) continue;
    const src = resolver.entById.get(r.sourceEntityId);
    const tgt = resolver.entById.get(r.targetEntityId);
    const cls = classifyRelation(r, src && resolver.classOf.get(src.id), tgt && resolver.classOf.get(tgt.id));
    const from = src ? resolver.target(src) : graphEndpoint(r.sourceEntityId);
    const to = tgt ? resolver.target(tgt) : graphEndpoint(r.targetEntityId);
    const capturedAt = r.evidence?.[0]?.capturedAt ?? r.createdAt ?? now;
    if (!from || !to) {
      const nodeId = from?.id ?? to?.id ?? null;
      const kind = `relation:${r.kind}`;
      const id = annotationId(nodeId, kind, r.title);
      writer.annotation({
        id, node_id: nodeId, kind, title: r.title, body: r.summary ?? null, name: null, tags: "[]", source_path: null, legacy_id: r.id,
        layer: cls.layer, origin: cls.origin, confidence: cls.layer === "human" ? "user_asserted" : confidenceForScore(r.confidence, cls.origin),
        score: r.confidence ?? null, status: r.status ?? "active", producer: migrated,
        attrs: sortedJson(compact({ legacy_origin: cls.layer === "human" ? "user" : undefined, source_entity_id: r.sourceEntityId, target_entity_id: r.targetEntityId, source_name: src?.name, target_name: tgt?.name, artifact_ids: r.artifactIds })),
        created_at: r.createdAt ?? now, updated_at: r.updatedAt ?? now,
      });
      writer.evidence({ target_table: "annotations", target_key: id, legacy_id: r.id, artifact_id: r.artifactIds?.[0] ?? null, excerpt: clip(r.summary), captured_at: capturedAt, producer: migrated, attrs: sortedJson(compact({ kind: r.kind, title: r.title, score: r.confidence })) });
      ledger.log("relations", r.id, "folded", "annotations", id, "endpoint-not-a-node");
      continue;
    }
    const type = EDGE_TYPE[r.kind] ?? r.kind.toUpperCase().replace(/-/gu, "_");
    const key = `${from.id} ${type} ${to.id} ${cls.layer}`;
    const draft: EdgeDraft = {
      from: from.id, type, to: to.id, layer: cls.layer, origin: cls.origin, owner: from.ctx.owner ?? null, score: r.confidence ?? 0.5,
      confidence: cls.layer === "human" ? "user_asserted" : confidenceForScore(r.confidence, cls.origin),
      evidence: cls.layer === "human"
        ? compact({ legacy_id: r.id, title: r.title, summary: r.summary, score: r.confidence, status: r.status, legacy_origin: "user", artifact_ids: r.artifactIds, kind: r.kind, created_at: r.createdAt, updated_at: r.updatedAt })
        : compact({ title: r.title, kind: r.kind, score: r.confidence, status: r.status }),
    };
    const prev = edgeDrafts.get(key);
    if (!prev) { edgeDrafts.set(key, draft); relationLog.push([r.id, "created", `${from.id}|${type}|${to.id}`, key]); }
    else { if (draft.score > prev.score) edgeDrafts.set(key, draft); relationLog.push([r.id, "merged", `${from.id}|${type}|${to.id}`, key]); }
    writer.evidence({
      target_table: "edges", target_key: `${from.id}|${type}|${to.id}`, legacy_id: r.id, artifact_id: r.artifactIds?.[0] ?? null, excerpt: clip(r.summary),
      captured_at: capturedAt, producer: migrated, attrs: sortedJson(compact({ layer: cls.layer, kind: r.kind, title: r.title, score: r.confidence })),
    });
  }
  const edgeOutcome = new Map<string, boolean>();
  for (const [key, e] of edgeDrafts) edgeOutcome.set(key, writer.edge(e));
  for (const [id, action, target, key] of relationLog) {
    ledger.log("relations", id, action === "created" && edgeOutcome.get(key) === false ? "merged" : action, "edges", target, null);
  }

  // ---------------------------------------------------------- questions → claims.validation / questions
  for (const q of questions) {
    if (ledger.already("open-questions", q.id)) continue;
    const cls = classifyQuestion(q);
    if (cls.bucket === "heuristic") {
      const findingId = q.findingIds?.[0] ?? q.answeredByFindingId;
      const c = findingId ? claimOfFinding.get(findingId) : undefined;
      const answered = q.status === "answered" || q.answeredByFindingId !== undefined;
      if (c) {
        writer.validate(c.node, c.claim, answered ? "answered" : "unvalidated", q.answeredByFindingId ?? null);
        ledger.log("open-questions", q.id, "folded", "claims", `${c.node}|${c.claim}`, answered ? "answered" : null);
      } else ledger.log("open-questions", q.id, "folded", null, null, "finding-not-a-claim");
      continue;
    }
    const range = q.addressRange as AddressRange | undefined;
    let nodeId: string | null = range ? deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: range.start & 0xffff }) : null;
    if (!nodeId) for (const id of q.entityIds ?? []) { const e = resolver.entById.get(id); const t = e ? resolver.target(e) : graphEndpoint(id); if (t) { nodeId = t.id; break; } }
    const outcome = writer.question({
      id: q.id, node_id: nodeId, kind: q.kind, title: q.title, body: q.description ?? null, status: q.status ?? "open", priority: q.priority ?? "medium",
      layer: cls.layer, origin: cls.origin, answer: q.answerSummary ?? null, answered_by: q.answeredByFindingId ?? null, producer: migrated,
      attrs: sortedJson(compact({ legacy_origin: cls.layer === "human" ? "user" : undefined, source: q.source, score: q.confidence, entity_ids: q.entityIds, finding_ids: q.findingIds, artifact_ids: q.artifactIds, auto_resolvable: q.autoResolvable, auto_resolve_hint: q.autoResolveHint, address_range: q.addressRange, tags: (q as { tags?: string[] }).tags })),
      created_at: q.createdAt ?? now, updated_at: q.updatedAt ?? now,
    });
    (q.evidence ?? []).forEach((ev, i) => writer.evidence({
      target_table: "questions", target_key: q.id, legacy_id: `${q.id}#${i}`, artifact_id: ev.artifactId ?? null, excerpt: clip(ev.excerpt ?? ev.note ?? ev.title),
      captured_at: ev.capturedAt ?? q.createdAt ?? now, producer: migrated, attrs: sortedJson(compact({ kind: ev.kind, title: ev.title, note: ev.note, address_range: ev.addressRange })),
    }));
    ledger.log("open-questions", q.id, outcome === "created" ? "created" : "merged", "questions", q.id, outcome === "kept" ? "kept-door-row" : null);
  }

  // ---------------------------------------------------------- user labels → human nodes (Spec 754 §3.3f)
  for (const l of labels) {
    if (ledger.already("labels", l.id)) continue;
    const range = l.addressRange as AddressRange | undefined;
    let target: Target | undefined;
    if (l.targetKind === "address" && range) target = { id: deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: range.start & 0xffff }), kind: "addr", ctx: { space: "ram" }, address: range.start & 0xffff, endAddress: range.end > range.start ? range.end & 0xffff : null };
    else if (l.targetKind === "entity" && l.targetId) { const e = resolver.entById.get(l.targetId); target = e ? resolver.target(e) : graphEndpoint(l.targetId); }
    if (!target) {
      const id = annotationId(null, "label-override", `${l.targetKind}:${l.targetId ?? ""}`);
      writer.annotation({ id, node_id: null, kind: "label-override", title: l.label, body: l.note ?? null, name: l.label, tags: "[]", source_path: null, legacy_id: l.id, layer: "human", origin: "imported", confidence: "user_asserted", score: null, status: "active", producer: migrated, attrs: sortedJson(compact({ target_kind: l.targetKind, target_id: l.targetId, legacy_origin: "user" })), created_at: l.createdAt ?? now, updated_at: l.updatedAt ?? now });
      ledger.log("labels", l.id, "folded", "annotations", id, "target-not-a-node");
      continue;
    }
    const outcome = writer.node({ id: target.id, layer: "human", kind: target.kind, ctx: target.ctx, address: target.address, endAddress: target.endAddress, name: l.label, attrs: compact({ legacy_id: l.id, legacy_kind: "label-override", legacy_origin: "user", note: l.note, target_kind: l.targetKind, target_id: l.targetId, captured_at: l.updatedAt ?? now, created_at: l.createdAt ?? now }), origin: "imported", confidence: "user_asserted", capturedAt: l.updatedAt ?? now, runOwner: null });
    ledger.log("labels", l.id, outcome === "created" ? "created" : "merged", "nodes", target.id, outcome === "kept" ? "kept-door-row" : null);
  }

  // ---------------------------------------------------------- flows: regenerable from the analysis artifacts (819)
  for (const fl of flows) {
    if (ledger.already("flows", fl.id)) continue;
    ledger.log("flows", fl.id, "skipped-regenerable", null, null, fl.kind);
  }
  void db;
}

// ------------------------------------------------------------------ *_annotations.json → human nodes + annotations (D6)

export interface AnnotationFileResult extends FileSummary {
  /** false when the file's hash equals the last import's (nothing re-read) */
  changed: boolean;
}

function annotationMeta(db: DatabaseSync, stem: string): { hash: string } | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`annotations_imported.${stem}`) as { value: string } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value) as { hash: string }; } catch { return undefined; }
}

/**
 * One annotation file into the human layer. Idempotent by the ledger while the
 * file is unchanged; when its hash differs from the last import, the rows the
 * FILE produced (producer '822', source_path = this file) are replaced — a row
 * the door has since renamed (producer 'human') is kept (D3: "kept-door-row").
 */
export function applyAnnotationFile(ctx: MigrationContext, projectDir: string, path: string, artifacts: ArtifactRecord[], options: { force?: boolean } = {}): AnnotationFileResult {
  const { db, slug, now, ledger, writer } = ctx;
  const migrated = MIGRATION_PRODUCER;
  const stem = basename(path).replace(/_annotations\.json$/u, "");
  const owner = normStem(stem);
  const ledgerStore = `annotations:${stem}`;
  const rel = relative(projectDir, path);
  const hash = sha256File(path);
  const previous = annotationMeta(db, stem);
  const changed = options.force === true || previous === undefined || previous.hash !== hash;
  if (previous !== undefined && changed) {
    // the file changed since its last import: retire what the FILE put there, keep what the door wrote
    db.prepare("DELETE FROM annotations WHERE producer = ? AND source_path = ?").run(migrated, rel);
    db.prepare("DELETE FROM nodes WHERE layer = 'human' AND producer = ? AND json_extract(attrs, '$.source_path') = ?").run(migrated, rel);
    db.prepare("DELETE FROM migration_log WHERE legacy_store = ?").run(ledgerStore);
    const l = ledger as unknown as { seen: Set<string> };
    for (const k of [...l.seen]) if (k.startsWith(`${ledgerStore} `)) l.seen.delete(k);
  }
  const analysisArtifact = artifacts.find((a) => (a.relativePath ?? a.path ?? "").endsWith(`${stem.replace(/_disasm$/u, "")}_analysis.json`));
  const actx: Ctx = analysisArtifact ? contextForArtifact(analysisArtifact, owner) : { space: "ram", owner };
  let parsed: { routines?: unknown[]; labels?: unknown[]; segments?: unknown[] };
  try { parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed; } catch {
    const fs: AnnotationFileResult = { stem, owner, path: rel, routines: 0, labels: 0, segments: 0, dropped: -1, changed };
    ctx.summary.files.push(fs);
    return fs;
  }
  const fs: AnnotationFileResult = { stem, owner, path: rel, routines: 0, labels: 0, segments: 0, dropped: 0, changed };
  const fileNodeDrafts = new Map<string, NodeDraft>();
  const fileAnnotations = new Map<string, AnnotationRow>();
  const fileLog: Array<[string, string, string]> = []; // store, id, node id
  const put = (kind: string, address: number, endAddress: number | null, name: string | null, attrs: Record<string, unknown>, legacyId: string, annotation?: { kind: string; title: string; body: string | null; name: string | null }) => {
    let id: string;
    try { id = deriveProjectId({ slug, ctx: actx, kind, address }); } catch { fs.dropped += 1; return; }
    if (ledger.already(ledgerStore, legacyId)) return;
    fileLog.push([ledgerStore, legacyId, id]);
    fileNodeDrafts.set(`${id} human`, {
      id, layer: "human", kind, ctx: actx, address, endAddress, name, attrs: { ...attrs, source_path: rel, captured_at: now },
      origin: "imported", confidence: "user_asserted", capturedAt: now, runOwner: null,
    });
    if (annotation) {
      const aid = annotationId(id, annotation.kind, annotation.title);
      fileAnnotations.set(aid, { id: aid, node_id: id, kind: annotation.kind, title: annotation.title, body: annotation.body, name: annotation.name, tags: "[]", source_path: rel, legacy_id: `${ledgerStore}/${legacyId}`, layer: "human", origin: "imported", confidence: "user_asserted", score: null, status: "active", producer: migrated, attrs: "{}", created_at: now, updated_at: now });
    }
  };
  for (const r of (parsed.routines ?? []) as Array<Record<string, unknown>>) {
    const address = parseHex(r.address);
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (address === undefined || !name) { fs.dropped += 1; continue; }
    fs.routines += 1;
    const comment = typeof r.comment === "string" && r.comment.trim() ? r.comment.trim() : null;
    put("routine", address, null, name, compact({ legacy_kind: "annotation-routine", abi: r.abi }), `routine:${hex4(address)}`, { kind: "routine", title: name, body: comment, name });
  }
  for (const l of (parsed.labels ?? []) as Array<Record<string, unknown>>) {
    const address = parseHex(l.address);
    const label = typeof l.label === "string" ? l.label.trim() : "";
    if (address === undefined || !label) { fs.dropped += 1; continue; }
    fs.labels += 1;
    const comment = typeof l.comment === "string" && l.comment.trim() ? l.comment.trim() : null;
    put("label", address, null, label, compact({ legacy_kind: "annotation-label", comment }), `label:${hex4(address)}`, comment ? { kind: "label", title: label, body: comment, name: label } : undefined);
  }
  for (const s of (parsed.segments ?? []) as Array<Record<string, unknown>>) {
    const start = parseHex(s.start);
    const end = parseHex(s.end);
    if (start === undefined || end === undefined || end < start) { fs.dropped += 1; continue; }
    fs.segments += 1;
    const label = typeof s.label === "string" && s.label.trim() ? s.label.trim() : null;
    const comment = typeof s.comment === "string" && s.comment.trim() ? s.comment.trim() : null;
    const kind = typeof s.kind === "string" ? s.kind : "unknown";
    put("segment", start, end > start ? end : null, label, compact({ legacy_kind: "annotation-segment", segment_kind: kind, comment }), `segment:${hex4(start)}`,
      comment || label ? { kind: "segment", title: `${kind} $${hex4U(start)}-$${hex4U(end)}`, body: comment, name: label } : undefined);
  }
  ctx.summary.files.push(fs);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`annotations_imported.${stem}`, JSON.stringify({ hash, mtimeMs: statSync(path).mtimeMs, importedAt: now, path: rel }));
  const fileOutcome = new Map<string, string>();
  for (const [key, d] of fileNodeDrafts) fileOutcome.set(key, writer.node(d));
  for (const a of fileAnnotations.values()) writer.annotation(a);
  const fileSeen = new Set<string>();
  for (const [store, legacyId, id] of fileLog) {
    const key = `${id} human`;
    const outcome = fileOutcome.get(key);
    const first = !fileSeen.has(key);
    fileSeen.add(key);
    ledger.log(store, legacyId, first && outcome === "created" ? "created" : "merged", "nodes", id, outcome === "kept" ? "kept-door-row" : null);
  }
  return fs;
}

// ------------------------------------------------------------------ reading the legacy stores

/** knowledge/<file> if present, else knowledge/_legacy-822/<file> (after the cut-over). */
function legacyPath(knowledge: string, file: string, legacyDirFiles: string[]): string {
  const live = join(knowledge, file);
  if (existsSync(live)) return live;
  const moved = join(knowledge, LEGACY_DIR, file);
  if (existsSync(moved)) legacyDirFiles.push(file);
  return moved;
}

export function readLegacyInput(projectDir: string, legacyDirFiles: string[] = []): LegacyInput & { annotationFiles: string[]; sourceHash: string } {
  const knowledge = join(projectDir, "knowledge");
  const artifacts = readItems<ArtifactRecord>(join(knowledge, "artifacts.json"));
  const entities = readItems<EntityRecord>(legacyPath(knowledge, "entities.json", legacyDirFiles));
  const findings = readItems<FindingRecord>(legacyPath(knowledge, "findings.json", legacyDirFiles));
  const relations = readItems<RelationRecord>(legacyPath(knowledge, "relations.json", legacyDirFiles));
  const questions = readItems<OpenQuestionRecord>(legacyPath(knowledge, "open-questions.json", legacyDirFiles));
  const flows = readItems<FlowRecord>(legacyPath(knowledge, "flows.json", legacyDirFiles));
  const labels = readItems<UserLabelOverride>(legacyPath(knowledge, "labels.user.json", legacyDirFiles));
  const annotationFiles = findAnnotationFiles(projectDir);
  const sourceHash = createHash("sha256");
  for (const f of ["artifacts", "entities", "findings", "relations", "open-questions", "flows", "labels.user"]) {
    const p = f === "artifacts" ? join(knowledge, "artifacts.json") : legacyPath(knowledge, `${f}.json`, []);
    sourceHash.update(`${f}:${existsSync(p) ? sha256File(p) : "-"}\n`);
  }
  for (const p of annotationFiles) sourceHash.update(`${relative(projectDir, p)}:${sha256File(p)}\n`);
  return { artifacts, entities, findings, relations, questions, flows, labels, annotationFiles, sourceHash: sourceHash.digest("hex") };
}

// ------------------------------------------------------------------ the migration

function empty(): StoreSummary {
  return { total: 0, created: 0, merged: 0, folded: 0, skipped: 0, already: 0, ctxByStem: 0 };
}

function emptySummary(projectDir: string, slug: string, dryRun: boolean, sourceHash: string, textIndex: TextIndex): MigrateSummary {
  return {
    projectDir, slug, dryRun, runId: 0, sourceHash, ms: 0, textIndex,
    stores: { entities: empty(), findings: empty(), relations: empty(), "open-questions": empty(), labels: empty(), flows: empty(), annotations: empty() },
    graph: {}, nodesByKind: {}, files: [], humanLayerHash: "", cutoverAt: "", legacyDirFiles: [],
  };
}

function finishRun(db: DatabaseSync, store: GraphStore, ledger: Ledger, summary: MigrateSummary, now: string): void {
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const cutover = (db.prepare("SELECT value FROM meta WHERE key = 'cutover_at'").get() as { value: string } | undefined)?.value ?? now;
  setMeta.run("cutover_at", cutover);
  summary.cutoverAt = cutover;
  store.recordProducer(MIGRATION_PRODUCER);
  summary.humanLayerHash = humanLayerHash(db);
  setMeta.run("human_layer_hash", summary.humanLayerHash);
  for (const k of Object.keys(summary.stores) as Array<keyof MigrateSummary["stores"]>) summary.stores[k] = ledger.counts[k] ?? empty();
  const totals = Object.values(summary.stores).reduce((acc, s) => ({ created: acc.created + s.created, merged: acc.merged + s.merged, folded: acc.folded + s.folded, skipped: acc.skipped + s.skipped, already: acc.already + s.already }), { created: 0, merged: 0, folded: 0, skipped: 0, already: 0 });
  db.prepare("UPDATE migration_runs SET finished_at = ?, created = ?, merged = ?, folded = ?, skipped = ?, already = ? WHERE run_id = ?")
    .run(new Date().toISOString(), totals.created, totals.merged, totals.folded, totals.skipped, totals.already, ledger.runId);
  summary.graph = graphCounts(db);
}

export function migrateProject(options: MigrateOptions): MigrateSummary {
  const t0 = process.hrtime.bigint();
  const projectDir = options.projectDir;
  const now = options.now ?? new Date().toISOString();
  const slug = readProjectSlug(projectDir);
  const dryRun = options.dryRun === true;
  const graphExisted = existsSync(graphPath(projectDir));

  // ---- legacy stores (one at a time; the 70 MB project parses in well under a second)
  const legacyDirFiles: string[] = [];
  const input = readLegacyInput(projectDir, legacyDirFiles);

  const store = GraphStore.open(projectDir);
  const db = store.db;
  const { textIndex } = ensureSchema822(db);
  const resolver = new Resolver(slug, input.artifacts, input.entities, graphPayloads(db));
  const summary = emptySummary(projectDir, slug, dryRun, input.sourceHash, textIndex);
  summary.legacyDirFiles = legacyDirFiles;

  db.exec("BEGIN IMMEDIATE");
  try {
    const runId = Number((db.prepare("INSERT INTO migration_runs (started_at, source_hash, dry_run) VALUES (?, ?, ?)").run(now, summary.sourceHash, dryRun ? 1 : 0)).lastInsertRowid);
    summary.runId = runId;
    const ledger = new Ledger(db, runId);
    const writer = new Writer(db);
    const ctx: MigrationContext = { db, slug, now, ledger, writer, resolver, summary };
    applyLegacyRecords(ctx, input);
    for (const path of input.annotationFiles) applyAnnotationFile(ctx, projectDir, path, input.artifacts);
    finishRun(db, store, ledger, summary, now);
    if (dryRun) db.exec("ROLLBACK");
    else db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    store.close();
    throw error;
  }
  if (dryRun) summary.graph = graphCounts(db);
  store.close();
  if (dryRun && !graphExisted) {
    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(`${graphPath(projectDir)}${suffix}`, { force: true }); } catch { /* best effort */ } }
  }
  summary.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return summary;
}

// ------------------------------------------------------------------ 822.2 — the generated import path after the cut-over

export interface ImportRecordsOptions {
  projectDir: string;
  /** an open, writable store to use (the caller owns the connection); opened and closed here otherwise */
  store?: GraphStore;
  /** the caller already holds BEGIN IMMEDIATE on `store`; no transaction is opened or committed here */
  inTransaction?: boolean;
  /** the analysis / manifest artifact whose previous contribution is retired first (D2) */
  purgeArtifactId?: string;
  /** legacy ids to retire before applying (a door re-save of a generated record) */
  purgeLegacyIds?: Array<{ store: "entities" | "findings" | "relations" | "open-questions" | "labels"; id: string }>;
  now?: string;
}

export interface ImportRecordsResult {
  runId: number;
  stores: MigrateSummary["stores"];
  nodesByKind: Record<string, number>;
  purged: { evidence: number; ledger: number; nodes: number; claims: number; edges: number; annotations: number };
  ms: number;
}

/** Retire the generated 822 rows that no evidence row backs any more (after a purge). */
function sweepOrphans(db: DatabaseSync): { nodes: number; claims: number; edges: number; annotations: number } {
  const claims = Number(db.prepare("DELETE FROM claims WHERE producer = '822' AND layer = 'generated' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.target_table = 'claims' AND e.target_key = claims.node_id || '|' || claims.claim)").run().changes);
  const nodes = Number(db.prepare("DELETE FROM nodes WHERE producer = '822' AND layer = 'generated' AND kind <> 'addr' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.target_table = 'nodes' AND e.target_key = nodes.id)").run().changes);
  const edges = Number(db.prepare("DELETE FROM edges WHERE producer = '822' AND layer = 'generated' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.target_table = 'edges' AND e.target_key = edges.from_id || '|' || edges.type || '|' || edges.to_id)").run().changes);
  const annotations = Number(db.prepare("DELETE FROM annotations WHERE producer = '822' AND layer = 'generated' AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.target_table = 'annotations' AND e.target_key = annotations.id)").run().changes);
  return { nodes, claims, edges, annotations };
}

/**
 * Legacy-shaped records from a deterministic importer (analysis-import,
 * manifest-import, inventory sync) into the generated layer, through the same
 * §5 mapping as the migration. One transaction: purge the artifact's previous
 * contribution (its evidence rows + ledger entries, then the rows nothing
 * backs), apply, log. Human rows are not addressed by any statement here.
 */
export function importRecords(input: Partial<Omit<LegacyInput, "artifacts">>, options: ImportRecordsOptions): ImportRecordsResult {
  const t0 = process.hrtime.bigint();
  const projectDir = options.projectDir;
  const now = options.now ?? new Date().toISOString();
  const slug = readProjectSlug(projectDir);
  const owned = options.store === undefined;
  const store = options.store ?? GraphStore.open(projectDir);
  const db = store.db;
  const { textIndex } = ensureSchema822(db);
  const artifacts = readItems<ArtifactRecord>(join(projectDir, "knowledge", "artifacts.json"));
  const full: Omit<LegacyInput, "artifacts"> = {
    entities: input.entities ?? [], findings: input.findings ?? [], relations: input.relations ?? [], questions: input.questions ?? [], flows: input.flows ?? [], labels: input.labels ?? [],
  };
  const summary = emptySummary(projectDir, slug, false, "", textIndex);
  const purged = { evidence: 0, ledger: 0, nodes: 0, claims: 0, edges: 0, annotations: 0 };
  const inTx = options.inTransaction !== true;
  if (inTx) db.exec("BEGIN IMMEDIATE");
  try {
    if (options.purgeArtifactId) {
      const token = legacyIdToken(options.purgeArtifactId);
      purged.evidence += Number(db.prepare("DELETE FROM evidence WHERE producer = '822' AND artifact_id = ? AND (legacy_id LIKE ? OR legacy_id LIKE ? OR legacy_id LIKE ? OR legacy_id LIKE ?)").run(options.purgeArtifactId, `entity-${token}-%`, `finding-${token}-%`, `relation-${token}-%`, `question-${token}-%`).changes);
      purged.ledger += Number(db.prepare("DELETE FROM migration_log WHERE legacy_store IN ('entities','findings','relations','open-questions') AND (legacy_id LIKE ? OR legacy_id LIKE ? OR legacy_id LIKE ? OR legacy_id LIKE ?)").run(`entity-${token}-%`, `finding-${token}-%`, `relation-${token}-%`, `question-${token}-%`).changes);
    }
    for (const p of options.purgeLegacyIds ?? []) {
      purged.evidence += Number(db.prepare("DELETE FROM evidence WHERE producer = '822' AND (legacy_id = ? OR legacy_id LIKE ?)").run(p.id, `${p.id}#%`).changes);
      purged.ledger += Number(db.prepare("DELETE FROM migration_log WHERE legacy_store = ? AND legacy_id = ?").run(p.store, p.id).changes);
    }
    if (purged.evidence > 0 || purged.ledger > 0) {
      const s = sweepOrphans(db);
      purged.nodes += s.nodes; purged.claims += s.claims; purged.edges += s.edges; purged.annotations += s.annotations;
    }
    const runId = Number((db.prepare("INSERT INTO migration_runs (started_at, source_hash, dry_run) VALUES (?, ?, 0)").run(now, `import:${options.purgeArtifactId ?? "door"}`)).lastInsertRowid);
    summary.runId = runId;
    const ledger = new Ledger(db, runId);
    const writer = new Writer(db);
    const resolver = new Resolver(slug, artifacts, full.entities, graphPayloads(db));
    applyLegacyRecords({ db, slug, now, ledger, writer, resolver, summary }, full);
    finishRun(db, store, ledger, summary, now);
    if (inTx) db.exec("COMMIT");
  } catch (error) {
    if (inTx) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
    if (owned) store.close();
    throw error;
  }
  if (owned) store.close();
  return { runId: summary.runId, stores: summary.stores, nodesByKind: summary.nodesByKind, purged, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

export interface ImportAnnotationFileOptions {
  projectDir: string;
  store?: GraphStore;
  /** the caller already holds BEGIN IMMEDIATE on `store` */
  inTransaction?: boolean;
  /** re-import even when the hash is unchanged */
  force?: boolean;
  now?: string;
}

/** The annotation-file door (D6): `disasm_prg` and `c64re graph annotations-import` call this. */
export function importAnnotationFile(path: string, options: ImportAnnotationFileOptions): AnnotationFileResult & { runId: number; ms: number } {
  const t0 = process.hrtime.bigint();
  const projectDir = options.projectDir;
  const now = options.now ?? new Date().toISOString();
  const slug = readProjectSlug(projectDir);
  const owned = options.store === undefined;
  const store = options.store ?? GraphStore.open(projectDir);
  const db = store.db;
  const { textIndex } = ensureSchema822(db);
  const artifacts = readItems<ArtifactRecord>(join(projectDir, "knowledge", "artifacts.json"));
  const summary = emptySummary(projectDir, slug, false, "", textIndex);
  const inTx = options.inTransaction !== true;
  if (inTx) db.exec("BEGIN IMMEDIATE");
  let result: AnnotationFileResult;
  try {
    const runId = Number((db.prepare("INSERT INTO migration_runs (started_at, source_hash, dry_run) VALUES (?, ?, 0)").run(now, `annotations:${sha256File(path)}`)).lastInsertRowid);
    summary.runId = runId;
    const ledger = new Ledger(db, runId);
    const writer = new Writer(db);
    const resolver = new Resolver(slug, artifacts, [], graphPayloads(db));
    result = applyAnnotationFile({ db, slug, now, ledger, writer, resolver, summary }, projectDir, path, artifacts, { force: options.force });
    finishRun(db, store, ledger, summary, now);
    if (inTx) db.exec("COMMIT");
  } catch (error) {
    if (inTx) { try { db.exec("ROLLBACK"); } catch { /* already rolled back */ } }
    if (owned) store.close();
    throw error;
  }
  if (owned) store.close();
  return { ...result, runId: summary.runId, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

export function graphCounts(db: DatabaseSync): Record<string, number> {
  const q = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  const has822 = q("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'claims'") === 1;
  return {
    generatedNodes: q("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'generated'"),
    generatedNodes822: q("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'generated' AND producer = '822'"),
    humanNodes: q("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human'"),
    generatedEdges: q("SELECT COUNT(*) AS n FROM edges WHERE layer = 'generated'"),
    generatedEdges822: q("SELECT COUNT(*) AS n FROM edges WHERE layer = 'generated' AND producer = '822'"),
    humanEdges: q("SELECT COUNT(*) AS n FROM edges WHERE layer = 'human'"),
    claims: has822 ? q("SELECT COUNT(*) AS n FROM claims") : 0,
    evidence: has822 ? q("SELECT COUNT(*) AS n FROM evidence") : 0,
    annotations: has822 ? q("SELECT COUNT(*) AS n FROM annotations") : 0,
    annotationsHuman: has822 ? q("SELECT COUNT(*) AS n FROM annotations WHERE layer = 'human'") : 0,
    questions: has822 ? q("SELECT COUNT(*) AS n FROM questions") : 0,
    migrationLog: has822 ? q("SELECT COUNT(*) AS n FROM migration_log") : 0,
  };
}
