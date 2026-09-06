// Spec 822.2 — the record layer: the graph IS the store for findings, entities,
// relations, open questions and user labels; this module projects the graph's
// rows back into the record shapes the service, the views, the MCP tools and
// the 740.1 index have always consumed, and routes every writer through the
// 822 doors (human layer) or the 822 importer (generated layer).
//
//   entities        nodes (producer 822 | human, both layers, human first) + folded `entity:*` prose
//   findings        `finding:*` annotations (human + generated) + generated claims
//   relations       edges (producer 822 | human), human first
//   open questions  the `questions` table (heuristic importer questions folded into claims.validation never come back as rows)
//   user labels     human nodes carrying attrs.legacy_kind = 'label-override'
//
// Ids: an entity id IS its graph node id (`<slug>:ram/<owner>:payload:0801`); a
// finding is `ann:<sha1>` (prose) or `claim:<node>|<claim>` (generated); a
// relation is `edge:<from>|<type>|<to>`; a question keeps its id. A caller may
// still hand in a legacy id (`entity-…`, `finding-…`, an `aj:` alias): the
// migration ledger (`migration_log`) is the alias table, and a door write with
// an unknown alias records it there, so the next lookup by that alias lands.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "../platform-kb/sqlite-quiet.js";
import type { ArtifactRecord, EntityRecord, EvidenceRef, FindingRecord, OpenQuestionRecord, RelationRecord, UserLabelOverride } from "../project-knowledge/types.js";
import { classifyTags } from "./migrate/classify.js";
import { annotate, forgetName, nameNode, openStore, recordFinding, upsertLink, upsertQuestion, withStore } from "./migrate/human.js";
import { EDGE_TYPE, graphPayloads, importRecords, Resolver, type ImportRecordsResult, type LegacyInput } from "./migrate/migrate.js";
import { annotationId, ensureSchema822, type AnnotationRow, type ClaimRow, type EvidenceRow, type QuestionRow } from "./migrate/schema-822.js";
import { deriveProjectId, parseId } from "./ids.js";
import { canonicalJson } from "./json.js";
import type { NodeRow } from "./schema.js";
import { GraphStore, readProjectSlug } from "./store.js";

// ------------------------------------------------------------------ shapes

const ENTITY_KINDS = new Set(["routine", "memory-region", "memory-address", "code-segment", "data-table", "lookup-table", "pointer-table", "state-variable", "disk-file", "disk-track", "cartridge-bank", "chip", "loader-stage", "irq-handler", "asset", "symbol", "io-register", "entry-point", "screen-region", "payload", "other"]);
const FINDING_KINDS = new Set(["observation", "classification", "hypothesis", "confirmation", "refutation", "memory-map", "disk-layout", "cartridge-layout", "flow", "other"]);
const RELATION_KINDS = new Set(["calls", "reads", "writes", "loads", "stores", "contains", "maps-to", "depends-on", "derived-from", "precedes", "follows", "references", "documents", "other"]);
const ENTITY_STATUS = new Set(["proposed", "active", "confirmed", "rejected", "archived"]);
const QUESTION_STATUS = new Set(["open", "researching", "answered", "invalidated", "deferred", "resolution-pending"]);
const PRIORITIES = new Set(["low", "medium", "high", "critical"]);
const EVIDENCE_KINDS = new Set(["artifact", "finding", "entity", "relation", "flow", "task", "question", "note", "external"]);
const CLAIM_TAG: Record<string, string> = { behaves_like: "ram-hypothesis", segment_kind: "segment-classification", display_state: "display-state", display_transfer: "display-transfer" };
const EDGE_KIND: Record<string, string> = Object.fromEntries(Object.entries(EDGE_TYPE).map(([k, v]) => [v, k]));
Object.assign(EDGE_KIND, { CALLS_ROM: "calls", JUMPS_TO: "precedes", BRANCHES_TO: "precedes", READS_INDIRECT: "reads", WRITES_INDIRECT: "writes", USES_ZP: "references", USES_HARDWARE: "references", EXECUTES: "other", HANDLES_IRQ: "other", HANDLES_NMI: "other" });

export type AddressRange = { start: number; end: number; bank?: number; label?: string };

const hex4U = (n: number) => (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
const uniq = (xs: Array<string | undefined | null>): string[] => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.length > 0))].sort();
const attrsOf = (json: string): Record<string, unknown> => { try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; } };
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const range = (v: unknown): AddressRange | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Partial<AddressRange>;
  if (typeof r.start !== "number") return undefined;
  return { start: r.start, end: typeof r.end === "number" ? r.end : r.start, ...(typeof r.bank === "number" ? { bank: r.bank } : {}), ...(typeof r.label === "string" ? { label: r.label } : {}) };
};
const scoreOf = (confidence: string): number => ({ certain: 1, user_asserted: 1, observed: 0.9, inferred: 0.8, heuristic: 0.5 } as Record<string, number>)[confidence] ?? 0.5;

function segmentEntityKind(segmentKind: string | undefined): string {
  switch (segmentKind) {
    case "code": case "basic_stub": return "code-segment";
    case "pointer_table": return "pointer-table";
    case "lookup_table": return "lookup-table";
    case "state_variable": return "state-variable";
    default: return "memory-region";
  }
}

function entityKindOf(nodeKind: string, attrs: Record<string, unknown>): EntityRecord["kind"] {
  const legacy = str(attrs.legacy_kind);
  if (legacy && ENTITY_KINDS.has(legacy)) return legacy as EntityRecord["kind"];
  switch (nodeKind) {
    case "routine": return "routine";
    case "label": return "symbol";
    case "entry": return "entry-point";
    case "segment": return segmentEntityKind(str(attrs.segment_kind)) as EntityRecord["kind"];
    case "addr": return "memory-address";
    case "payload": return "payload";
    case "chip": return "chip";
    case "bank": return "cartridge-bank";
    case "region": return "memory-region";
    case "data_block": return "data-table";
    case "stage": return "loader-stage";
    case "track": return "disk-track";
    default: return "other";
  }
}

function evidenceRef(row: EvidenceRow): EvidenceRef {
  const a = attrsOf(row.attrs);
  const kind = str(a.kind);
  const title = str(a.title) ?? (row.excerpt ? row.excerpt.slice(0, 80) : undefined) ?? (row.artifact_id ? `artifact ${row.artifact_id}` : "evidence");
  const out: EvidenceRef = {
    kind: (kind && EVIDENCE_KINDS.has(kind) ? kind : row.artifact_id ? "artifact" : "note") as EvidenceRef["kind"],
    title,
    capturedAt: row.captured_at,
  };
  if (row.artifact_id) out.artifactId = row.artifact_id;
  if (row.excerpt) out.excerpt = row.excerpt;
  const note = str(a.note); if (note) out.note = note;
  const r = range(a.address_range); if (r) out.addressRange = r;
  for (const [k, key] of [["entity_id", "entityId"], ["finding_id", "findingId"], ["relation_id", "relationId"], ["flow_id", "flowId"], ["task_id", "taskId"], ["question_id", "questionId"]] as const) {
    const v = str(a[k]); if (v) (out as unknown as Record<string, string>)[key] = v;
  }
  return out;
}

function evidenceRefsOf(v: unknown): EvidenceRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: EvidenceRef[] = [];
  for (const e of v) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const kind = str(o.kind);
    out.push({ ...(o as unknown as EvidenceRef), kind: (kind && EVIDENCE_KINDS.has(kind) ? kind : "note") as EvidenceRef["kind"], title: str(o.title) ?? "evidence", capturedAt: str(o.capturedAt) ?? new Date(0).toISOString() });
  }
  return out;
}

// ------------------------------------------------------------------ inputs (what the service's save* methods hand in)

export type EntityInput = Partial<Omit<EntityRecord, "kind" | "name">> & { kind: EntityRecord["kind"]; name: string };
export type FindingInput = Partial<Omit<FindingRecord, "kind" | "title">> & { kind: FindingRecord["kind"]; title: string };
export type RelationInput = Partial<Omit<RelationRecord, "kind" | "title" | "sourceEntityId" | "targetEntityId">> & { kind: RelationRecord["kind"]; title: string; sourceEntityId: string; targetEntityId: string; tags?: string[] };
export type QuestionInput = Partial<Omit<OpenQuestionRecord, "kind" | "title">> & { kind: string; title: string; tags?: string[] };

export interface EntityFilters { kind?: string; status?: string; artifactId?: string }
export interface FindingFilters { kind?: string; status?: string; entityId?: string }
export interface RelationFilters { kind?: string; entityId?: string; artifactId?: string }
export interface QuestionFilters { status?: string; priority?: string; entityId?: string; findingId?: string }

/** A human routine the annotation files or the door named — the closed-loop sweep's coverage (Spec 053 on the graph). */
export interface RoutineNode { id: string; owner: string | null; address: number; endAddress: number | null; name: string | null; sourcePath?: string }

interface EdgeRowLite { from_id: string; type: string; to_id: string; layer: string; origin: string; confidence: string; producer: string; evidence: string }

interface Snapshot {
  db: DatabaseSync;
  cutover: string;
  /** migration ledger: `<store> <legacy id>` → { table, id } */
  alias: Map<string, { table: string; id: string }>;
}

// ------------------------------------------------------------------ the layer

export class KnowledgeRecords {
  constructor(readonly projectDir: string) {}

  private hasProject(): boolean {
    return existsSync(join(this.projectDir, "knowledge", "project.json"));
  }

  private artifacts(): ArtifactRecord[] {
    const p = join(this.projectDir, "knowledge", "artifacts.json");
    if (!existsSync(p)) return [];
    try { const raw = JSON.parse(readFileSync(p, "utf8")) as { items?: ArtifactRecord[] }; return raw.items ?? []; } catch { return []; }
  }

  /** One read-only pass over the graph; the store is opened for writing only to create the schema on a fresh project. */
  private read<T>(fn: (s: Snapshot) => T, empty: T): T {
    if (!this.hasProject() && !existsSync(join(this.projectDir, "knowledge", "graph.sqlite"))) return empty;
    const store = openStore(this.projectDir);
    try {
      ensureSchema822(store.db);
      const cutover = (store.db.prepare("SELECT value FROM meta WHERE key = 'cutover_at'").get() as { value: string } | undefined)?.value ?? new Date().toISOString();
      const alias = new Map<string, { table: string; id: string }>();
      let loaded = false;
      const snap: Snapshot = {
        db: store.db, cutover,
        get alias() {
          if (!loaded) {
            loaded = true;
            for (const r of store.db.prepare("SELECT legacy_store, legacy_id, target_table, target_id FROM migration_log WHERE target_id IS NOT NULL").all() as Array<{ legacy_store: string; legacy_id: string; target_table: string; target_id: string }>) {
              alias.set(`${r.legacy_store} ${r.legacy_id}`, { table: r.target_table, id: r.target_id });
            }
          }
          return alias;
        },
      };
      return fn(snap);
    } finally {
      store.close();
    }
  }

  private slug(): string {
    return readProjectSlug(this.projectDir);
  }

  // ---------------------------------------------------------------- id resolution

  private aliasLookup(db: DatabaseSync, store: string, id: string): { table: string; id: string } | undefined {
    const row = db.prepare("SELECT target_table, target_id FROM migration_log WHERE legacy_store = ? AND legacy_id = ? AND target_id IS NOT NULL").get(store, id) as { target_table: string; target_id: string } | undefined;
    return row ? { table: row.target_table, id: row.target_id } : undefined;
  }

  private recordAlias(db: DatabaseSync, store: string, alias: string, table: string, id: string): void {
    db.prepare("INSERT OR IGNORE INTO migration_log (legacy_store, legacy_id, action, target_table, target_id, note, run_id) VALUES (?, ?, 'created', ?, ?, 'alias', 0)").run(store, alias, table, id);
  }

  /** A graph node id, a folded-prose `ann:` id, or a legacy / caller alias → the graph id it names. */
  resolveEntityId(ref: string | undefined): string | undefined {
    if (!ref) return undefined;
    return this.read((s) => this.resolveEntityIn(s.db, ref), undefined);
  }

  private resolveEntityIn(db: DatabaseSync, ref: string): string | undefined {
    if (/^ann:[0-9a-f]{40}$/u.test(ref)) return (db.prepare("SELECT 1 FROM annotations WHERE id = ?").get(ref) ? ref : undefined);
    try { parseId(ref); if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(ref)) return ref; return ref; } catch { /* not a graph id */ }
    const hit = this.aliasLookup(db, "entities", ref);
    if (hit) return hit.id;
    return undefined;
  }

  private resolveFindingIn(db: DatabaseSync, ref: string): { table: "annotations" | "claims"; id: string } | undefined {
    if (/^ann:[0-9a-f]{40}$/u.test(ref)) return db.prepare("SELECT 1 FROM annotations WHERE id = ?").get(ref) ? { table: "annotations", id: ref } : undefined;
    if (ref.startsWith("claim:")) return { table: "claims", id: ref.slice(6) };
    const hit = this.aliasLookup(db, "findings", ref);
    if (hit && (hit.table === "annotations" || hit.table === "claims")) return { table: hit.table, id: hit.id };
    return undefined;
  }

  private mapFindingId(alias: Snapshot["alias"], id: string): string {
    if (/^ann:/u.test(id) || id.startsWith("claim:")) return id;
    const hit = alias.get(`findings ${id}`);
    if (!hit) return id;
    return hit.table === "claims" ? `claim:${hit.id}` : hit.id;
  }

  private mapEntityId(alias: Snapshot["alias"], id: string): string {
    if (/^ann:/u.test(id)) return id;
    try { parseId(id); return id; } catch { /* alias */ }
    return alias.get(`entities ${id}`)?.id ?? id;
  }

  // ---------------------------------------------------------------- entities

  listEntities(filters?: EntityFilters): EntityRecord[] {
    return this.read((s) => {
      const rows = s.db.prepare("SELECT * FROM nodes WHERE (producer IN ('822','human') OR layer = 'human') AND kind NOT IN ('subsystem','run') ORDER BY id, CASE layer WHEN 'human' THEN 0 ELSE 1 END").all() as unknown as NodeRow[];
      const evidence = new Map<string, EvidenceRow[]>();
      for (const e of s.db.prepare("SELECT * FROM evidence WHERE target_table = 'nodes' ORDER BY captured_at DESC, legacy_id").all() as unknown as EvidenceRow[]) {
        evidence.set(e.target_key, [...(evidence.get(e.target_key) ?? []), e]);
      }
      const summaries = new Map<string, string>();
      for (const a of s.db.prepare("SELECT node_id, body FROM annotations WHERE kind = 'entity' AND node_id IS NOT NULL AND body IS NOT NULL ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END, updated_at DESC").all() as Array<{ node_id: string; body: string }>) {
        if (!summaries.has(a.node_id)) summaries.set(a.node_id, a.body);
      }
      const out: EntityRecord[] = [];
      let i = 0;
      while (i < rows.length) {
        const id = rows[i]!.id;
        const group: NodeRow[] = [];
        while (i < rows.length && rows[i]!.id === id) group.push(rows[i++]!);
        out.push(this.entityFromRows(s, group, evidence.get(id) ?? [], summaries.get(id)));
      }
      for (const a of s.db.prepare("SELECT * FROM annotations WHERE kind LIKE 'entity:%' AND node_id IS NULL ORDER BY id").all() as unknown as AnnotationRow[]) {
        out.push(this.entityFromProse(s, a, (s.db.prepare("SELECT * FROM evidence WHERE target_table = 'annotations' AND target_key = ? ORDER BY captured_at DESC").all(a.id) as unknown as EvidenceRow[])));
      }
      return out
        .filter((e) => !filters?.kind || e.kind === filters.kind)
        .filter((e) => !filters?.status || e.status === filters.status)
        .filter((e) => !filters?.artifactId || e.artifactIds.includes(filters.artifactId));
    }, []);
  }

  private entityFromRows(s: Snapshot, group: NodeRow[], evidence: EvidenceRow[], summary: string | undefined): EntityRecord {
    const human = group.find((r) => r.layer === "human");
    const generated = group.find((r) => r.layer === "generated");
    const base = human ?? generated!;
    const attrs = { ...(generated ? attrsOf(generated.attrs) : {}), ...(human ? attrsOf(human.attrs) : {}) };
    const payload = (attrs.payload && typeof attrs.payload === "object" ? attrs.payload : {}) as Record<string, unknown>;
    const newest = evidence[0];
    const oldest = evidence[evidence.length - 1];
    const kind = entityKindOf(base.kind, attrs);
    const addressless = attrs.addressless === true;
    const evidenceRefs = evidenceRefsOf(attrs.evidence_refs) ?? evidence.map(evidenceRef);
    const record: EntityRecord = {
      id: base.id,
      kind,
      name: human?.name ?? generated?.name ?? str(attrs.label_hint) ?? `${base.kind}_${hex4U(base.address)}`,
      status: (ENTITY_STATUS.has(String(attrs.status)) ? String(attrs.status) : "active") as EntityRecord["status"],
      confidence: num(attrs.score) ?? scoreOf(base.confidence),
      evidence: evidenceRefs,
      artifactIds: uniq([...arr(attrs.artifact_ids), ...evidence.map((e) => e.artifact_id), str(payload.source_artifact_id)]),
      relatedEntityIds: uniq(arr(attrs.related_entity_ids).map((x) => this.mapEntityId(s.alias, x))),
      payloadAsmArtifactIds: uniq(arr(payload.asm_artifact_ids)),
      mediumSpans: (Array.isArray(attrs.medium_spans) ? attrs.medium_spans : []) as EntityRecord["mediumSpans"],
      tags: uniq(arr(attrs.tags)),
      aliases: uniq(arr(attrs.aliases)),
      createdAt: str(attrs.created_at) ?? oldest?.captured_at ?? str(attrs.captured_at) ?? s.cutover,
      updatedAt: str(attrs.updated_at) ?? str(attrs.captured_at) ?? newest?.captured_at ?? s.cutover,
    };
    const text = summary ?? str(attrs.summary) ?? str(attrs.comment) ?? (generated && !human ? newest?.excerpt ?? undefined : undefined);
    if (text) record.summary = text;
    const payloadId = str(attrs.payload_id); if (payloadId) record.payloadId = this.mapEntityId(s.alias, payloadId);
    const explicitRange = range(attrs.address_range);
    if (explicitRange) record.addressRange = explicitRange;
    else if (attrs.door !== true && !addressless && (base.kind !== "payload" || base.address !== 0 || base.end_address !== null)) {
      record.addressRange = { start: base.address, end: base.end_address ?? base.address, ...(base.bank !== null && base.space === "crt" ? { bank: base.bank } : {}) };
    }
    const load = num(payload.load_address); if (load !== undefined) record.payloadLoadAddress = load;
    const fmt = str(payload.format); if (fmt) record.payloadFormat = fmt as EntityRecord["payloadFormat"];
    const packer = str(payload.packer); if (packer) record.payloadPacker = packer;
    const src = str(payload.source_artifact_id); if (src) record.payloadSourceArtifactId = src;
    const dep = str(payload.depacked_artifact_id); if (dep) record.payloadDepackedArtifactId = dep;
    const hash = str(payload.content_hash); if (hash) record.payloadContentHash = hash;
    const lm = str(payload.loader_model_id); if (lm) record.payloadLoaderModelId = lm;
    const lut = str(payload.claimed_by_lut_id); if (lut) record.payloadClaimedByLutId = lut;
    const row = num(payload.claimed_by_row); if (row !== undefined) record.payloadClaimedByRow = row;
    const hint = str(payload.disk_hint); if (hint) record.payloadDiskHint = hint as EntityRecord["payloadDiskHint"];
    const role = str(attrs.medium_role); if (role) record.mediumRole = role as EntityRecord["mediumRole"];
    if (attrs.internal === true) record.internal = true;
    return record;
  }

  private entityFromProse(s: Snapshot, a: AnnotationRow, evidence: EvidenceRow[]): EntityRecord {
    const attrs = attrsOf(a.attrs);
    const payload = (attrs.payload && typeof attrs.payload === "object" ? attrs.payload : {}) as Record<string, unknown>;
    const legacy = str(attrs.legacy_kind) ?? a.kind.slice(7);
    const record: EntityRecord = {
      id: a.id,
      kind: (ENTITY_KINDS.has(legacy) ? legacy : "other") as EntityRecord["kind"],
      name: a.name ?? a.title,
      status: (ENTITY_STATUS.has(a.status) ? a.status : "active") as EntityRecord["status"],
      confidence: a.score ?? scoreOf(a.confidence),
      evidence: evidenceRefsOf(attrs.evidence_refs) ?? evidence.filter((e) => e.legacy_id.includes("#")).map(evidenceRef),
      artifactIds: uniq([...arr(attrs.artifact_ids), ...evidence.map((e) => e.artifact_id)]),
      relatedEntityIds: uniq(arr(attrs.related_entity_ids).map((x) => this.mapEntityId(s.alias, x))),
      payloadAsmArtifactIds: uniq(arr(payload.asm_artifact_ids)),
      mediumSpans: (Array.isArray(attrs.medium_spans) ? attrs.medium_spans : []) as EntityRecord["mediumSpans"],
      tags: uniq(JSON.parse(a.tags) as string[]),
      aliases: uniq(arr(attrs.aliases)),
      createdAt: a.created_at,
      updatedAt: a.updated_at,
    };
    if (a.body) record.summary = a.body;
    const fmt = str(payload.format); if (fmt) record.payloadFormat = fmt as EntityRecord["payloadFormat"];
    const packer = str(payload.packer); if (packer) record.payloadPacker = packer;
    const src = str(payload.source_artifact_id); if (src) record.payloadSourceArtifactId = src;
    const hash = str(payload.content_hash); if (hash) record.payloadContentHash = hash;
    const hint = str(payload.disk_hint); if (hint) record.payloadDiskHint = hint as EntityRecord["payloadDiskHint"];
    const role = str(attrs.medium_role); if (role) record.mediumRole = role as EntityRecord["mediumRole"];
    if (attrs.internal === true) record.internal = true;
    return record;
  }

  /** One entity, projected alone (a save must not project the store to answer with one record). */
  private entityById(s: Snapshot, id: string): EntityRecord | undefined {
    if (/^ann:/u.test(id)) {
      const a = s.db.prepare("SELECT * FROM annotations WHERE id = ? AND kind LIKE 'entity:%' AND node_id IS NULL").get(id) as unknown as AnnotationRow | undefined;
      if (!a) return undefined;
      return this.entityFromProse(s, a, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'annotations' AND target_key = ? ORDER BY captured_at DESC").all(a.id) as unknown as EvidenceRow[]);
    }
    const rows = s.db.prepare("SELECT * FROM nodes WHERE id = ? AND kind NOT IN ('subsystem','run') ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END").all(id) as unknown as NodeRow[];
    if (rows.length === 0) return undefined;
    const evidence = s.db.prepare("SELECT * FROM evidence WHERE target_table = 'nodes' AND target_key = ? ORDER BY captured_at DESC, legacy_id").all(id) as unknown as EvidenceRow[];
    const summary = (s.db.prepare("SELECT body FROM annotations WHERE kind = 'entity' AND node_id = ? AND body IS NOT NULL ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1").get(id) as { body: string } | undefined)?.body;
    return this.entityFromRows(s, rows, evidence, summary);
  }

  getEntity(ref: string | undefined): EntityRecord | undefined {
    if (!ref) return undefined;
    return this.read((s) => {
      const id = this.resolveEntityIn(s.db, ref);
      return id ? this.entityById(s, id) : undefined;
    }, undefined);
  }

  /** Bug 31 payload identity, by content hash or (source artifact, load address) — an indexed lookup, not a scan. */
  private findPayloadIn(s: Snapshot, by: { hash?: string; sourceArtifactId?: string; loadAddress?: number }): EntityRecord | undefined {
    let row: { id: string } | undefined;
    if (by.hash) {
      row = s.db.prepare("SELECT id FROM nodes WHERE json_extract(attrs, '$.payload.content_hash') = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END, id LIMIT 1").get(by.hash) as { id: string } | undefined;
      if (!row) row = s.db.prepare("SELECT id FROM annotations WHERE kind LIKE 'entity:%' AND node_id IS NULL AND json_extract(attrs, '$.payload.content_hash') = ? ORDER BY id LIMIT 1").get(by.hash) as { id: string } | undefined;
    } else if (by.sourceArtifactId !== undefined && by.loadAddress !== undefined) {
      row = s.db.prepare("SELECT id FROM nodes WHERE json_extract(attrs, '$.payload.source_artifact_id') = ? AND json_extract(attrs, '$.payload.load_address') = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END, id LIMIT 1").get(by.sourceArtifactId, by.loadAddress) as { id: string } | undefined;
    }
    return row ? this.entityById(s, row.id) : undefined;
  }

  /**
   * `save_entity`: a record tagged by a deterministic importer goes to the
   * generated layer through the 822 importer; everything else is a door write
   * into the human layer. Payload identity (Bug 31): an existing payload with
   * the same content hash, or the same (source artifact, load address) when the
   * source is not an aggregator, is the same entity — its id is reused and the
   * new name folds into aliases.
   */
  saveEntity(input: EntityInput): EntityRecord {
    const cls = classifyTags(input.tags ?? []);
    const now = new Date().toISOString();
    if (cls.layer === "generated") {
      const record = this.entityRecordFromInput(input, undefined, now);
      this.importGenerated({ entities: [record] }, { purgeLegacyIds: [{ store: "entities", id: record.id }] });
      return this.getEntity(record.id) ?? record;
    }
    const slug = this.slug();
    const artifacts = this.artifacts();
    const store = openStore(this.projectDir);
    let savedId = "";
    try {
      ensureSchema822(store.db);
      const db = store.db;
      const existingId = input.id ? this.resolveEntityIn(db, input.id) : undefined;
      let existing = existingId ? this.getEntity(existingId) : undefined;
      if (!existing && (input.kind === "payload" || input.payloadLoadAddress !== undefined)) {
        if (input.payloadContentHash) existing = this.read((s) => this.findPayloadIn(s, { hash: input.payloadContentHash }), undefined);
        if (!existing && input.payloadSourceArtifactId !== undefined && input.payloadLoadAddress !== undefined) {
          const srcArt = artifacts.find((a) => a.id === input.payloadSourceArtifactId);
          if (srcArt?.kind !== "manifest") existing = this.read((s) => this.findPayloadIn(s, { sourceArtifactId: input.payloadSourceArtifactId, loadAddress: input.payloadLoadAddress }), undefined);
        }
      }
      const record = this.entityRecordFromInput(input, existing, now);
      // the graph id: the existing node, else derived from the record's kind / address / owner
      let id = existing?.id;
      let folded = existing !== undefined && /^ann:/u.test(existing.id);
      if (!id) {
        const resolver = new Resolver(slug, artifacts, [], graphPayloads(db));
        const target = resolver.target({ ...record, payloadId: record.payloadId ? this.resolveEntityIn(db, record.payloadId) ?? record.payloadId : undefined });
        if (target) id = target.id;
        else { id = annotationId(null, `entity:${record.kind}`, record.name); folded = true; }
      }
      const attrs = this.entityAttrs(record, now);
      savedId = id!;
      withStore(store, (st) => {
        if (folded) {
          annotate(st, { id, kind: `entity:${record.kind}`, title: record.name, body: record.summary ?? null, name: record.name, tags: record.tags, status: record.status, score: record.confidence, attrs: { ...attrs, legacy_origin: "user" } });
        } else {
          const parsed = parseId(id!);
          const kind = parsed.form === "project" ? parsed.kind : parsed.form === "subsystem" ? "subsystem" : parsed.kind;
          st.upsertHuman({ id: id!, kind, name: record.name, endAddress: record.addressRange && record.addressRange.end > record.addressRange.start ? record.addressRange.end & 0xffff : null, attrs, origin: "user", confidence: "user_asserted" });
          if (record.summary) annotate(st, { nodeId: id, kind: "entity", title: record.name, body: record.summary, name: record.name, tags: record.tags, status: record.status });
        }
        if (input.id && input.id !== id) this.recordAlias(st.db, "entities", input.id, folded ? "annotations" : "nodes", id!);
      });
    } finally {
      store.close();
    }
    return this.getEntity(savedId)!;
  }

  private entityRecordFromInput(input: EntityInput, existing: EntityRecord | undefined, now: string): EntityRecord {
    const aliasUnion = new Set<string>([...(existing?.aliases ?? []), ...(input.aliases ?? [])]);
    if (existing && input.name && input.name !== existing.name) aliasUnion.add(input.name);
    aliasUnion.delete(existing?.name ?? "");
    let internal: boolean | undefined;
    if (input.internal !== undefined) internal = input.internal;
    else if (existing?.internal !== undefined) internal = existing.internal;
    else {
      const primary = input.payloadSourceArtifactId ?? existing?.payloadSourceArtifactId ?? input.artifactIds?.[0] ?? existing?.artifactIds?.[0];
      if (primary && this.artifacts().find((a) => a.id === primary)?.internal === true) internal = true;
    }
    const record: EntityRecord = {
      id: input.id ?? existing?.id ?? `entity-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"}-${Date.now().toString(36)}`,
      kind: existing?.kind ?? input.kind,
      name: existing?.name ?? input.name,
      status: input.status ?? existing?.status ?? "active",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      artifactIds: uniq([...(input.artifactIds ?? []), ...(existing?.artifactIds ?? [])]),
      relatedEntityIds: uniq([...(input.relatedEntityIds ?? []), ...(existing?.relatedEntityIds ?? [])]),
      payloadAsmArtifactIds: uniq([...(input.payloadAsmArtifactIds ?? []), ...(existing?.payloadAsmArtifactIds ?? [])]),
      mediumSpans: input.mediumSpans ?? existing?.mediumSpans ?? [],
      tags: uniq([...(input.tags ?? []), ...(existing?.tags ?? [])]),
      aliases: [...aliasUnion].sort(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const set = <K extends keyof EntityRecord>(k: K, v: EntityRecord[K] | undefined) => { if (v !== undefined) (record as Record<string, unknown>)[k] = v; };
    set("summary", input.summary ?? existing?.summary);
    set("addressRange", input.addressRange ?? existing?.addressRange);
    set("mediumRole", input.mediumRole ?? existing?.mediumRole);
    set("payloadId", input.payloadId ?? existing?.payloadId);
    set("payloadLoadAddress", input.payloadLoadAddress ?? existing?.payloadLoadAddress);
    set("payloadFormat", input.payloadFormat ?? existing?.payloadFormat);
    set("payloadPacker", input.payloadPacker ?? existing?.payloadPacker);
    set("payloadSourceArtifactId", input.payloadSourceArtifactId ?? existing?.payloadSourceArtifactId);
    set("payloadDepackedArtifactId", input.payloadDepackedArtifactId ?? existing?.payloadDepackedArtifactId);
    set("payloadContentHash", input.payloadContentHash ?? existing?.payloadContentHash);
    set("payloadLoaderModelId", input.payloadLoaderModelId ?? existing?.payloadLoaderModelId);
    set("payloadClaimedByLutId", input.payloadClaimedByLutId ?? existing?.payloadClaimedByLutId);
    set("payloadClaimedByRow", input.payloadClaimedByRow ?? existing?.payloadClaimedByRow);
    set("payloadDiskHint", "payloadDiskHint" in input ? input.payloadDiskHint : existing?.payloadDiskHint);
    if (internal === true) record.internal = true;
    return record;
  }

  private entityAttrs(record: EntityRecord, now: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    const p = (k: string, v: unknown) => { if (v !== undefined && !(Array.isArray(v) && v.length === 0)) payload[k] = v; };
    p("load_address", record.payloadLoadAddress); p("format", record.payloadFormat); p("packer", record.payloadPacker); p("source_artifact_id", record.payloadSourceArtifactId);
    p("depacked_artifact_id", record.payloadDepackedArtifactId); p("asm_artifact_ids", record.payloadAsmArtifactIds); p("content_hash", record.payloadContentHash);
    p("loader_model_id", record.payloadLoaderModelId); p("claimed_by_lut_id", record.payloadClaimedByLutId); p("claimed_by_row", record.payloadClaimedByRow); p("disk_hint", record.payloadDiskHint);
    const attrs: Record<string, unknown> = { door: true, legacy_kind: record.kind, tags: record.tags, score: record.confidence, status: record.status, created_at: record.createdAt, updated_at: now };
    const a = (k: string, v: unknown) => { if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) attrs[k] = v; };
    a("summary", record.summary); a("address_range", record.addressRange); a("artifact_ids", record.artifactIds); a("related_entity_ids", record.relatedEntityIds); a("payload_id", record.payloadId);
    a("medium_spans", record.mediumSpans); a("medium_role", record.mediumRole); a("aliases", record.aliases); a("internal", record.internal === true ? true : undefined);
    a("evidence_refs", record.evidence); a("addressless", record.addressRange === undefined && record.payloadLoadAddress === undefined && (record.kind === "payload" || record.kind === "disk-file" || record.kind === "asset") ? true : undefined);
    if (Object.keys(payload).length) attrs.payload = payload;
    return attrs;
  }

  /** Patch fields of one entity in the human layer (the door for setPayloadDiskHint, backfills). */
  patchEntity(ref: string, patch: Partial<EntityRecord>): EntityRecord | undefined {
    const existing = this.getEntity(ref);
    if (!existing) return undefined;
    return this.saveEntity({ ...existing, ...patch, id: existing.id, tags: existing.tags.filter((t) => t !== "analysis-import" && t !== "manifest-import" && t !== "inventory-import") });
  }

  // ---------------------------------------------------------------- findings

  listFindings(filters?: FindingFilters): FindingRecord[] {
    return this.read((s) => {
      const out: FindingRecord[] = [];
      const evidence = new Map<string, EvidenceRow[]>();
      for (const e of s.db.prepare("SELECT * FROM evidence WHERE target_table IN ('annotations','claims') ORDER BY captured_at DESC, legacy_id").all() as unknown as EvidenceRow[]) {
        const k = `${e.target_table} ${e.target_key}`;
        evidence.set(k, [...(evidence.get(k) ?? []), e]);
      }
      for (const a of s.db.prepare("SELECT * FROM annotations WHERE kind LIKE 'finding:%' ORDER BY updated_at DESC, id").all() as unknown as AnnotationRow[]) {
        out.push(this.findingFromAnnotation(s, a, evidence.get(`annotations ${a.id}`) ?? []));
      }
      const nodes = new Map<string, { address: number; end_address: number | null; bank: number | null; space: string }>();
      for (const n of s.db.prepare("SELECT id, address, end_address, bank, space FROM nodes ORDER BY id, CASE layer WHEN 'human' THEN 0 ELSE 1 END").all() as Array<{ id: string; address: number; end_address: number | null; bank: number | null; space: string }>) {
        if (!nodes.has(n.id)) nodes.set(n.id, n);
      }
      for (const c of s.db.prepare("SELECT * FROM claims ORDER BY updated_at DESC, node_id, claim").all() as unknown as ClaimRow[]) {
        out.push(this.findingFromClaim(s, c, evidence.get(`claims ${c.node_id}|${c.claim}`) ?? [], nodes.get(c.node_id)));
      }
      const entityId = filters?.entityId ? this.mapEntityId(s.alias, filters.entityId) : undefined;
      return out
        .filter((f) => !filters?.kind || f.kind === filters.kind)
        .filter((f) => !filters?.status || f.status === filters.status)
        .filter((f) => !entityId || f.entityIds.includes(entityId) || f.entityIds.includes(filters!.entityId!));
    }, []);
  }

  private findingFromAnnotation(s: Snapshot, a: AnnotationRow, evidence: EvidenceRow[]): FindingRecord {
    const attrs = attrsOf(a.attrs);
    const kind = a.kind.slice("finding:".length);
    const refs = evidence.filter((e) => e.legacy_id.includes("#"));
    const record: FindingRecord = {
      id: a.id,
      kind: (FINDING_KINDS.has(kind) ? kind : "other") as FindingRecord["kind"],
      title: a.title,
      status: (ENTITY_STATUS.has(a.status) ? a.status : "proposed") as FindingRecord["status"],
      confidence: a.score ?? scoreOf(a.confidence),
      evidence: refs.map(evidenceRef),
      entityIds: uniq(arr(attrs.entity_ids).map((x) => this.mapEntityId(s.alias, x))),
      artifactIds: uniq([...arr(attrs.artifact_ids), ...evidence.map((e) => e.artifact_id)]),
      relationIds: uniq(arr(attrs.relation_ids)),
      flowIds: uniq(arr(attrs.flow_ids)),
      tags: uniq(JSON.parse(a.tags) as string[]),
      createdAt: str(attrs.created_at) ?? a.created_at,
      updatedAt: a.updated_at,
    };
    if (a.body) record.summary = a.body;
    const payloadId = str(attrs.payload_id); if (payloadId) record.payloadId = this.mapEntityId(s.alias, payloadId);
    const r = range(attrs.address_range); if (r) record.addressRange = r;
    const by = str(attrs.archived_by); if (by) record.archivedBy = this.mapFindingId(s.alias, by);
    return record;
  }

  private findingFromClaim(s: Snapshot, c: ClaimRow, evidence: EvidenceRow[], node: { address: number; end_address: number | null; bank: number | null; space: string } | undefined): FindingRecord {
    const attrs = attrsOf(c.attrs);
    const newest = evidence[0];
    const newestAttrs = newest ? attrsOf(newest.attrs) : {};
    const legacyKind = str(attrs.legacy_kind);
    const legacyStatus = str(attrs.legacy_status);
    const address = node ? node.address : undefined;
    const record: FindingRecord = {
      id: `claim:${c.node_id}|${c.claim}`,
      kind: (legacyKind && FINDING_KINDS.has(legacyKind) ? legacyKind : "hypothesis") as FindingRecord["kind"],
      title: str(attrs.title) ?? (address !== undefined ? `${c.claim} ${c.value} at $${hex4U(address)}` : `${c.claim} ${c.value} (${c.node_id})`),
      status: (c.status === "archived" ? "archived" : legacyStatus && ENTITY_STATUS.has(legacyStatus) ? legacyStatus : "active") as FindingRecord["status"],
      confidence: c.score ?? scoreOf(c.confidence),
      evidence: evidence.map((e) => ({ ...evidenceRef(e), kind: "artifact" as const, title: str(attrsOf(e.attrs).title) ?? `${c.claim} evidence` })),
      entityIds: [c.node_id],
      artifactIds: uniq(evidence.map((e) => e.artifact_id)),
      relationIds: [],
      flowIds: [],
      tags: uniq([...arr(attrs.tags), "analysis-import", CLAIM_TAG[c.claim] ?? c.claim]),
      createdAt: evidence[evidence.length - 1]?.captured_at ?? c.updated_at,
      updatedAt: c.updated_at,
    };
    if (newest?.excerpt) record.summary = newest.excerpt;
    const r = range(newestAttrs.address_range) ?? (node ? { start: node.address, end: node.end_address ?? node.address, ...(node.bank !== null && node.space === "crt" ? { bank: node.bank } : {}) } : undefined);
    if (r) record.addressRange = r;
    if (c.superseded_by) record.archivedBy = this.mapFindingId(s.alias, c.superseded_by);
    if (c.validation === "answered" && c.validated_by) record.tags = uniq([...record.tags, "validated"]);
    return record;
  }

  private findingByHit(s: Snapshot, hit: { table: "annotations" | "claims"; id: string }): FindingRecord | undefined {
    if (hit.table === "annotations") {
      const a = s.db.prepare("SELECT * FROM annotations WHERE id = ? AND kind LIKE 'finding:%'").get(hit.id) as unknown as AnnotationRow | undefined;
      if (!a) return undefined;
      return this.findingFromAnnotation(s, a, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'annotations' AND target_key = ? ORDER BY captured_at DESC, legacy_id").all(a.id) as unknown as EvidenceRow[]);
    }
    const nodeId = hit.id.slice(0, hit.id.lastIndexOf("|"));
    const claim = hit.id.slice(hit.id.lastIndexOf("|") + 1);
    const c = s.db.prepare("SELECT * FROM claims WHERE node_id = ? AND claim = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END LIMIT 1").get(nodeId, claim) as unknown as ClaimRow | undefined;
    if (!c) return undefined;
    const node = s.db.prepare("SELECT address, end_address, bank, space FROM nodes WHERE id = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END LIMIT 1").get(nodeId) as { address: number; end_address: number | null; bank: number | null; space: string } | undefined;
    return this.findingFromClaim(s, c, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'claims' AND target_key = ? ORDER BY captured_at DESC, legacy_id").all(hit.id) as unknown as EvidenceRow[], node);
  }

  getFinding(ref: string | undefined): FindingRecord | undefined {
    if (!ref) return undefined;
    return this.read((s) => {
      const hit = this.resolveFindingIn(s.db, ref);
      return hit ? this.findingByHit(s, hit) : undefined;
    }, undefined);
  }

  /** `save_finding`: importer-tagged → generated (claims / generated prose); a `claim:` id → the claim's status; anything else → the human door. */
  saveFinding(input: FindingInput): FindingRecord {
    const cls = classifyTags(input.tags ?? []);
    const now = new Date().toISOString();
    if (cls.layer === "generated" && cls.bucket !== "annotation-mirror") {
      const record = this.findingRecordFromInput(input, undefined, now);
      this.importGenerated({ findings: [record] }, { purgeLegacyIds: [{ store: "findings", id: record.id }] });
      return this.getFinding(record.id) ?? record;
    }
    const store = openStore(this.projectDir);
    let outId: string;
    try {
      ensureSchema822(store.db);
      const db = store.db;
      const hit = input.id ? this.resolveFindingIn(db, input.id) : undefined;
      if (hit?.table === "claims") {
        // a generated claim: the door may archive / re-activate it and point at what superseded it (Spec 053)
        const [nodeId, claim] = [hit.id.slice(0, hit.id.lastIndexOf("|")), hit.id.slice(hit.id.lastIndexOf("|") + 1)];
        withStore(store, (st) => {
          const status = input.status === "archived" ? "archived" : input.status === "rejected" ? "rejected" : input.status ? "active" : undefined;
          const supersededBy = input.archivedBy ? this.resolveFindingKey(st.db, input.archivedBy) : undefined;
          st.db.prepare("UPDATE claims SET status = COALESCE(?, status), superseded_by = COALESCE(?, superseded_by), score = COALESCE(?, score), updated_at = ? WHERE node_id = ? AND claim = ?")
            .run(status ?? null, supersededBy ?? null, input.confidence ?? null, now, nodeId, claim);
          if (input.status && input.status !== "archived") {
            st.db.prepare("UPDATE claims SET attrs = json_set(attrs, '$.legacy_status', ?) WHERE node_id = ? AND claim = ?").run(input.status, nodeId, claim);
          }
        });
        outId = `claim:${hit.id}`;
      } else {
        const existing = hit ? this.getFinding(hit.id) : undefined;
        const record = this.findingRecordFromInput(input, existing, now);
        const nodeIds = record.entityIds.map((e) => this.resolveEntityIn(db, e) ?? e);
        const row = withStore(store, (st) => {
          const r = recordFinding(st, {
            id: existing?.id ?? (hit?.id ?? undefined), kind: record.kind, title: record.title, summary: record.summary, status: record.status, confidence: record.confidence, tags: record.tags,
            addressRange: record.addressRange, nodeIds, artifactIds: record.artifactIds, relationIds: record.relationIds, flowIds: record.flowIds,
            payloadId: record.payloadId ? this.resolveEntityIn(st.db, record.payloadId) ?? record.payloadId : undefined,
            archivedBy: record.archivedBy ? this.resolveFindingKey(st.db, record.archivedBy) ?? record.archivedBy : undefined,
            evidence: record.evidence, createdAt: record.createdAt,
          });
          if (input.id && input.id !== r.id && !/^ann:/u.test(input.id)) this.recordAlias(st.db, "findings", input.id, "annotations", r.id);
          return r;
        });
        outId = row.id;
      }
    } finally {
      store.close();
    }
    return this.getFinding(outId)!;
  }

  /** a finding ref → the key a claim's superseded_by / an annotation's archived_by stores (a finding id in either form) */
  private resolveFindingKey(db: DatabaseSync, ref: string): string | undefined {
    const hit = this.resolveFindingIn(db, ref);
    if (hit) return hit.table === "claims" ? `claim:${hit.id}` : hit.id;
    // a routine node id (the coverage of archivePhase1Noise) is a valid superseder too
    try { parseId(ref); return ref; } catch { return undefined; }
  }

  private findingRecordFromInput(input: FindingInput, existing: FindingRecord | undefined, now: string): FindingRecord {
    const record: FindingRecord = {
      id: input.id ?? existing?.id ?? `finding-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"}-${Date.now().toString(36)}`,
      kind: input.kind,
      title: input.title,
      status: input.status ?? existing?.status ?? "proposed",
      confidence: input.confidence ?? existing?.confidence ?? 0.5,
      evidence: input.evidence ?? existing?.evidence ?? [],
      entityIds: uniq(input.entityIds ?? existing?.entityIds ?? []),
      artifactIds: uniq(input.artifactIds ?? existing?.artifactIds ?? []),
      relationIds: uniq(input.relationIds ?? existing?.relationIds ?? []),
      flowIds: uniq(input.flowIds ?? existing?.flowIds ?? []),
      tags: uniq(input.tags ?? existing?.tags ?? []),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const summary = input.summary ?? existing?.summary; if (summary !== undefined) record.summary = summary;
    const payloadId = input.payloadId ?? existing?.payloadId; if (payloadId !== undefined) record.payloadId = payloadId;
    const ar = input.addressRange ?? existing?.addressRange; if (ar !== undefined) record.addressRange = ar;
    const by = input.archivedBy ?? existing?.archivedBy; if (by !== undefined) record.archivedBy = by;
    return record;
  }

  removeFindings(ids: string[]): number {
    if (ids.length === 0) return 0;
    const store = openStore(this.projectDir);
    try {
      ensureSchema822(store.db);
      return withStore(store, (st) => {
        let removed = 0;
        for (const ref of ids) {
          const hit = this.resolveFindingIn(st.db, ref);
          if (!hit) continue;
          if (hit.table === "claims") {
            const nodeId = hit.id.slice(0, hit.id.lastIndexOf("|")); const claim = hit.id.slice(hit.id.lastIndexOf("|") + 1);
            removed += Number(st.db.prepare("DELETE FROM claims WHERE node_id = ? AND claim = ?").run(nodeId, claim).changes);
            st.db.prepare("DELETE FROM evidence WHERE target_table = 'claims' AND target_key = ?").run(hit.id);
          } else {
            removed += Number(st.db.prepare("DELETE FROM annotations WHERE id = ?").run(hit.id).changes);
            st.db.prepare("DELETE FROM evidence WHERE target_table = 'annotations' AND target_key = ?").run(hit.id);
          }
        }
        return removed;
      });
    } finally {
      store.close();
    }
  }

  // ---------------------------------------------------------------- relations

  listRelations(filters?: RelationFilters): RelationRecord[] {
    return this.read((s) => {
      const rows = s.db.prepare("SELECT * FROM edges WHERE (producer IN ('822','human') OR layer = 'human') AND evidence_key = '' ORDER BY from_id, type, to_id, CASE layer WHEN 'human' THEN 0 ELSE 1 END").all() as unknown as EdgeRowLite[];
      const evidence = new Map<string, EvidenceRow[]>();
      for (const e of s.db.prepare("SELECT * FROM evidence WHERE target_table = 'edges' ORDER BY captured_at DESC, legacy_id").all() as unknown as EvidenceRow[]) {
        evidence.set(e.target_key, [...(evidence.get(e.target_key) ?? []), e]);
      }
      const out: RelationRecord[] = [];
      let i = 0;
      while (i < rows.length) {
        const first = rows[i]!;
        const key = `${first.from_id}|${first.type}|${first.to_id}`;
        const group: EdgeRowLite[] = [];
        while (i < rows.length && `${rows[i]!.from_id}|${rows[i]!.type}|${rows[i]!.to_id}` === key) group.push(rows[i++]!);
        out.push(this.relationFromRows(s, group, evidence.get(key) ?? []));
      }
      // a relation whose endpoint is prose (no address) or unresolved is a `relation:<kind>` annotation (822 §5)
      for (const a of s.db.prepare("SELECT * FROM annotations WHERE kind LIKE 'relation:%' ORDER BY updated_at DESC, id").all() as unknown as AnnotationRow[]) {
        out.push(this.relationFromProse(s, a, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'annotations' AND target_key = ? ORDER BY captured_at DESC").all(a.id) as unknown as EvidenceRow[]));
      }
      const entityId = filters?.entityId ? this.mapEntityId(s.alias, filters.entityId) : undefined;
      return out
        .filter((r) => !filters?.kind || r.kind === filters.kind)
        .filter((r) => !entityId || r.sourceEntityId === entityId || r.targetEntityId === entityId)
        .filter((r) => !filters?.artifactId || r.artifactIds.includes(filters.artifactId));
    }, []);
  }

  private relationFromRows(s: Snapshot, group: EdgeRowLite[], rowsFor: EvidenceRow[]): RelationRecord {
    const first = group[0]!;
    const key = `${first.from_id}|${first.type}|${first.to_id}`;
    const human = group.find((r) => r.layer === "human");
    const base = human ?? first;
    const ev = { ...attrsOf(group.find((r) => r.layer === "generated")?.evidence ?? "{}"), ...(human ? attrsOf(human.evidence) : {}) };
    const kind = str(ev.kind) ?? EDGE_KIND[base.type] ?? "other";
    const record: RelationRecord = {
      id: `edge:${key}`,
      kind: (RELATION_KINDS.has(kind) ? kind : "other") as RelationRecord["kind"],
      title: str(ev.title) ?? `${kind}: ${first.from_id} → ${first.to_id}`,
      sourceEntityId: first.from_id,
      targetEntityId: first.to_id,
      status: (ENTITY_STATUS.has(String(ev.status)) ? String(ev.status) : "active") as RelationRecord["status"],
      confidence: num(ev.score) ?? scoreOf(base.confidence),
      evidence: rowsFor.map(evidenceRef),
      artifactIds: uniq([...arr(ev.artifact_ids), ...rowsFor.map((e) => e.artifact_id)]),
      createdAt: str(ev.created_at) ?? rowsFor[rowsFor.length - 1]?.captured_at ?? str(ev.asserted_at) ?? s.cutover,
      updatedAt: str(ev.updated_at) ?? rowsFor[0]?.captured_at ?? str(ev.asserted_at) ?? s.cutover,
    };
    const summary = str(ev.summary) ?? str(ev.comment); if (summary) record.summary = summary;
    return record;
  }

  private relationFromProse(s: Snapshot, a: AnnotationRow, evidence: EvidenceRow[]): RelationRecord {
    const attrs = attrsOf(a.attrs);
    const kind = a.kind.slice("relation:".length);
    const rowsFor = evidence.filter((e) => e.legacy_id.includes("#"));
    const record: RelationRecord = {
      id: a.id,
      kind: (RELATION_KINDS.has(kind) ? kind : "other") as RelationRecord["kind"],
      title: a.title,
      sourceEntityId: this.mapEntityId(s.alias, str(attrs.source_entity_id) ?? a.node_id ?? ""),
      targetEntityId: this.mapEntityId(s.alias, str(attrs.target_entity_id) ?? a.node_id ?? ""),
      status: (ENTITY_STATUS.has(a.status) ? a.status : "active") as RelationRecord["status"],
      confidence: a.score ?? scoreOf(a.confidence),
      evidence: rowsFor.map(evidenceRef),
      artifactIds: uniq([...arr(attrs.artifact_ids), ...rowsFor.map((e) => e.artifact_id)]),
      createdAt: str(attrs.created_at) ?? a.created_at,
      updatedAt: a.updated_at,
    };
    if (a.body) record.summary = a.body;
    return record;
  }

  /** One relation by `edge:<from>|<type>|<to>`, an `ann:` prose id, or a legacy alias. */
  getRelation(ref: string | undefined): RelationRecord | undefined {
    if (!ref) return undefined;
    return this.read((s) => {
      let id = ref;
      if (!id.startsWith("edge:") && !/^ann:/u.test(id)) {
        const hit = this.aliasLookup(s.db, "relations", id);
        if (!hit) return undefined;
        id = hit.table === "edges" ? `edge:${hit.id}` : hit.id;
      }
      if (/^ann:/u.test(id)) {
        const a = s.db.prepare("SELECT * FROM annotations WHERE id = ? AND kind LIKE 'relation:%'").get(id) as unknown as AnnotationRow | undefined;
        return a ? this.relationFromProse(s, a, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'annotations' AND target_key = ? ORDER BY captured_at DESC").all(a.id) as unknown as EvidenceRow[]) : undefined;
      }
      const key = id.slice(5);
      const [from, type, to] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
      const group = s.db.prepare("SELECT * FROM edges WHERE from_id = ? AND type = ? AND to_id = ? AND evidence_key = '' ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END").all(from, type, to) as unknown as EdgeRowLite[];
      if (group.length === 0) return undefined;
      return this.relationFromRows(s, group, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'edges' AND target_key = ? ORDER BY captured_at DESC, legacy_id").all(key) as unknown as EvidenceRow[]);
    }, undefined);
  }

  saveRelation(input: RelationInput): RelationRecord {
    const cls = classifyTags(input.tags ?? []);
    const now = new Date().toISOString();
    const record: RelationRecord = {
      id: input.id ?? `relation-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item"}-${Date.now().toString(36)}`,
      kind: input.kind, title: input.title, sourceEntityId: input.sourceEntityId, targetEntityId: input.targetEntityId,
      status: input.status ?? "active", confidence: input.confidence ?? 0.5, evidence: input.evidence ?? [], artifactIds: uniq(input.artifactIds ?? []),
      createdAt: now, updatedAt: now,
    };
    if (input.summary !== undefined) record.summary = input.summary;
    if (cls.layer === "generated") {
      this.importGenerated({ relations: [record] }, { purgeLegacyIds: [{ store: "relations", id: record.id }] });
      return this.getRelation(record.id) ?? record;
    }
    const store = openStore(this.projectDir);
    let key = "";
    let proseId: string | undefined;
    try {
      ensureSchema822(store.db);
      const isGraphId = (id: string | undefined): id is string => { if (!id) return false; try { parseId(id); return true; } catch { return false; } };
      const from = this.resolveEntityIn(store.db, input.sourceEntityId);
      const to = this.resolveEntityIn(store.db, input.targetEntityId);
      if (!isGraphId(from) || !isGraphId(to)) {
        // an endpoint that is prose (no address) or unknown: the relation is prose on the
        // node it does have (822 §5 "endpoint-not-a-node"), keyed like the migration keys it
        const nodeId = isGraphId(from) ? from : isGraphId(to) ? to : null;
        const kind = `relation:${input.kind}`;
        const prevId = input.id ? this.aliasLookup(store.db, "relations", input.id)?.id : undefined;
        const row = withStore(store, (st) => annotate(st, {
          id: prevId && /^ann:/u.test(prevId) ? prevId : undefined, nodeId, kind, title: input.title, body: input.summary ?? null, tags: input.tags, status: record.status, score: record.confidence,
          attrs: { source_entity_id: from ?? input.sourceEntityId, target_entity_id: to ?? input.targetEntityId, artifact_ids: record.artifactIds, legacy_id: input.id, created_at: record.createdAt },
          evidence: record.evidence.map((ev, i) => ({ artifactId: ev.artifactId, excerpt: ev.excerpt ?? ev.note ?? ev.title, key: `#${i}`, capturedAt: ev.capturedAt, attrs: { kind: ev.kind, title: ev.title, note: ev.note, address_range: ev.addressRange } })),
        }));
        if (input.id && input.id !== row.id) withStore(store, (st) => this.recordAlias(st.db, "relations", input.id!, "annotations", row.id));
        proseId = row.id;
      } else {
      const prevKey = input.id ? this.aliasLookup(store.db, "relations", input.id)?.id : undefined;
      const existing = prevKey ? this.getRelation(`edge:${prevKey}`) : undefined;
      const r = withStore(store, (st) => upsertLink(st, {
        from, to, type: EDGE_TYPE[input.kind] ?? input.kind, title: input.title, summary: input.summary ?? existing?.summary, score: input.confidence ?? existing?.confidence,
        status: input.status ?? existing?.status, artifactIds: uniq([...(input.artifactIds ?? []), ...(existing?.artifactIds ?? [])]), legacyId: input.id, createdAt: existing?.createdAt,
      }));
      key = `${r.from}|${r.type}|${r.to}`;
      if (input.id && input.id !== `edge:${key}`) withStore(store, (st) => this.recordAlias(st.db, "relations", input.id!, "edges", key));
      }
    } finally {
      store.close();
    }
    return this.getRelation(proseId ?? `edge:${key}`)!;
  }

  // ---------------------------------------------------------------- open questions

  listOpenQuestions(filters?: QuestionFilters): OpenQuestionRecord[] {
    return this.read((s) => {
      const evidence = new Map<string, EvidenceRow[]>();
      for (const e of s.db.prepare("SELECT * FROM evidence WHERE target_table = 'questions' ORDER BY captured_at DESC, legacy_id").all() as unknown as EvidenceRow[]) {
        evidence.set(e.target_key, [...(evidence.get(e.target_key) ?? []), e]);
      }
      const out: OpenQuestionRecord[] = [];
      for (const q of s.db.prepare("SELECT * FROM questions ORDER BY updated_at DESC, id").all() as unknown as QuestionRow[]) {
        out.push(this.questionFromRow(s, q, evidence.get(q.id) ?? []));
      }
      const entityId = filters?.entityId ? this.mapEntityId(s.alias, filters.entityId) : undefined;
      const findingId = filters?.findingId ? this.mapFindingId(s.alias, filters.findingId) : undefined;
      return out
        .filter((q) => !filters?.status || q.status === filters.status)
        .filter((q) => !filters?.priority || q.priority === filters.priority)
        .filter((q) => !entityId || q.entityIds.includes(entityId) || q.entityIds.includes(filters!.entityId!))
        .filter((q) => !findingId || q.findingIds.includes(findingId) || q.findingIds.includes(filters!.findingId!));
    }, []);
  }

  private questionFromRow(s: Snapshot, q: QuestionRow, evidence: EvidenceRow[]): OpenQuestionRecord {
    const attrs = attrsOf(q.attrs);
    const node = q.node_id
      ? (s.db.prepare("SELECT address, end_address FROM nodes WHERE id = ? ORDER BY CASE layer WHEN 'human' THEN 0 ELSE 1 END LIMIT 1").get(q.node_id) as { address: number; end_address: number | null } | undefined)
      : undefined;
    const record: OpenQuestionRecord = {
      id: q.id,
      kind: q.kind,
      title: q.title,
      status: (QUESTION_STATUS.has(q.status) ? q.status : "open") as OpenQuestionRecord["status"],
      priority: (PRIORITIES.has(q.priority) ? q.priority : "medium") as OpenQuestionRecord["priority"],
      confidence: num(attrs.score) ?? 0.5,
      evidence: evidence.map(evidenceRef),
      entityIds: uniq(arr(attrs.entity_ids).map((x) => this.mapEntityId(s.alias, x))),
      artifactIds: uniq(arr(attrs.artifact_ids)),
      findingIds: uniq(arr(attrs.finding_ids).map((x) => this.mapFindingId(s.alias, x))),
      source: (str(attrs.source) ?? (q.layer === "human" ? "human-review" : "static-analysis")) as OpenQuestionRecord["source"],
      createdAt: q.created_at,
      updatedAt: q.updated_at,
    };
    if (q.body) record.description = q.body;
    if (typeof attrs.auto_resolvable === "boolean") record.autoResolvable = attrs.auto_resolvable;
    if (attrs.auto_resolve_hint !== undefined) record.autoResolveHint = attrs.auto_resolve_hint as OpenQuestionRecord["autoResolveHint"];
    const r = range(attrs.address_range) ?? (node ? { start: node.address, end: node.end_address ?? node.address } : undefined);
    if (r) record.addressRange = r;
    if (q.answered_by) record.answeredByFindingId = this.mapFindingId(s.alias, q.answered_by);
    if (q.answer) record.answerSummary = q.answer;
    return record;
  }

  getOpenQuestion(id: string | undefined): OpenQuestionRecord | undefined {
    if (!id) return undefined;
    return this.read((s) => {
      const q = s.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as unknown as QuestionRow | undefined;
      return q ? this.questionFromRow(s, q, s.db.prepare("SELECT * FROM evidence WHERE target_table = 'questions' AND target_key = ? ORDER BY captured_at DESC, legacy_id").all(id) as unknown as EvidenceRow[]) : undefined;
    }, undefined);
  }

  saveOpenQuestion(input: QuestionInput): OpenQuestionRecord {
    const now = new Date().toISOString();
    const existing = input.id ? this.getOpenQuestion(input.id) : undefined;
    const store = openStore(this.projectDir);
    let id = "";
    try {
      ensureSchema822(store.db);
      const entityIds = uniq(input.entityIds ?? existing?.entityIds ?? []).map((e) => this.resolveEntityIn(store.db, e) ?? e);
      const findingIds = uniq(input.findingIds ?? existing?.findingIds ?? []).map((f) => this.resolveFindingKey(store.db, f) ?? f);
      const addressRange = input.addressRange ?? existing?.addressRange;
      const slug = this.hasProject() ? this.slug() : undefined;
      let nodeId: string | null = null;
      if (addressRange && slug) nodeId = deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: addressRange.start & 0xffff });
      else nodeId = entityIds.find((e) => { try { parseId(e); return true; } catch { return false; } }) ?? null;
      const answeredBy = input.answeredByFindingId !== undefined ? this.resolveFindingKey(store.db, input.answeredByFindingId) ?? input.answeredByFindingId : undefined;
      const row = withStore(store, (st) => upsertQuestion(st, {
        id: input.id, nodeId, kind: input.kind, title: input.title, body: input.description ?? existing?.description ?? null,
        status: input.status ?? existing?.status, priority: input.priority ?? existing?.priority,
        answer: input.answerSummary !== undefined ? input.answerSummary : undefined, answeredBy,
        attrs: {
          source: input.source ?? existing?.source ?? "untagged", score: input.confidence ?? existing?.confidence ?? 0.5,
          entity_ids: entityIds.length ? entityIds : undefined, artifact_ids: uniq(input.artifactIds ?? existing?.artifactIds ?? []),
          finding_ids: findingIds.length ? findingIds : undefined, auto_resolvable: input.autoResolvable ?? existing?.autoResolvable,
          auto_resolve_hint: input.autoResolveHint ?? existing?.autoResolveHint, address_range: addressRange, tags: input.tags?.length ? input.tags : undefined,
        },
        createdAt: existing?.createdAt ?? now,
      }));
      id = row.id;
      // evidence rows: replaced on a re-save
      if (input.evidence) withStore(store, (st) => {
        st.db.prepare("DELETE FROM evidence WHERE target_table = 'questions' AND target_key = ? AND producer = 'human'").run(id);
        const ins = st.db.prepare("INSERT OR IGNORE INTO evidence (target_table, target_key, legacy_id, artifact_id, excerpt, captured_at, producer, attrs) VALUES (?,?,?,?,?,?,?,?)");
        input.evidence!.forEach((ev, i) => ins.run("questions", id, `${id}#${i}`, ev.artifactId ?? null, ev.excerpt ?? ev.note ?? ev.title ?? null, ev.capturedAt ?? now, "human",
          JSON.stringify({ kind: ev.kind, title: ev.title, note: ev.note, address_range: ev.addressRange, entity_id: ev.entityId, finding_id: ev.findingId })));
      });
    } finally {
      store.close();
    }
    return this.getOpenQuestion(id)!;
  }

  // ---------------------------------------------------------------- user labels (Spec 754 §3.3f on the graph)

  listUserLabels(): UserLabelOverride[] {
    return this.read((s) => {
      const out: UserLabelOverride[] = [];
      for (const n of s.db.prepare("SELECT * FROM nodes WHERE layer = 'human' AND json_extract(attrs, '$.legacy_kind') = 'label-override' ORDER BY address, id").all() as unknown as NodeRow[]) {
        const attrs = attrsOf(n.attrs);
        const record: UserLabelOverride = {
          id: n.id, kind: "label-override", label: n.name ?? `L${hex4U(n.address)}`,
          targetKind: (str(attrs.target_kind) ?? "address") as UserLabelOverride["targetKind"],
          addressRange: { start: n.address, end: n.end_address ?? n.address },
          createdAt: str(attrs.created_at) ?? str(attrs.captured_at) ?? s.cutover, updatedAt: str(attrs.updated_at) ?? str(attrs.captured_at) ?? s.cutover,
        };
        const tid = str(attrs.target_id); if (tid) record.targetId = tid;
        const note = str(attrs.note); if (note) record.note = note;
        out.push(record);
      }
      for (const a of s.db.prepare("SELECT * FROM annotations WHERE kind = 'label-override' ORDER BY id").all() as unknown as AnnotationRow[]) {
        const attrs = attrsOf(a.attrs);
        const record: UserLabelOverride = { id: a.id, kind: "label-override", label: a.name ?? a.title, targetKind: (str(attrs.target_kind) ?? "view-item") as UserLabelOverride["targetKind"], createdAt: a.created_at, updatedAt: a.updated_at };
        const tid = str(attrs.target_id); if (tid) record.targetId = tid;
        if (a.body) record.note = a.body;
        out.push(record);
      }
      return out;
    }, []);
  }

  saveUserLabel(input: { id?: string; label: string; address?: number; addressRange?: AddressRange; note?: string; targetKind?: UserLabelOverride["targetKind"]; targetId?: string }): UserLabelOverride {
    const now = new Date().toISOString();
    const slug = this.slug();
    const rangeIn = input.addressRange ?? (input.address !== undefined ? { start: input.address & 0xffff, end: input.address & 0xffff } : undefined);
    const targetKind = input.targetKind ?? "address";
    let id: string;
    const store = openStore(this.projectDir);
    try {
      ensureSchema822(store.db);
      let nodeId: string | undefined;
      if (targetKind === "address" && rangeIn) nodeId = deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: rangeIn.start & 0xffff });
      else if (targetKind === "entity" && input.targetId) nodeId = this.resolveEntityIn(store.db, input.targetId);
      else if (input.id) { try { parseId(input.id); nodeId = input.id; } catch { /* a prose label */ } }
      const existing = this.listUserLabels().find((l) => l.id === (nodeId ?? input.id));
      if (nodeId && !/^ann:/u.test(nodeId)) {
        const kind = parseId(nodeId);
        const attrs = { legacy_kind: "label-override", note: input.note ?? existing?.note, target_kind: targetKind, target_id: input.targetId ?? existing?.targetId, created_at: existing?.createdAt ?? now, updated_at: now };
        withStore(store, (st) => st.upsertHuman({ id: nodeId!, kind: kind.form === "project" ? kind.kind : kind.form === "subsystem" ? "subsystem" : kind.kind, name: input.label, endAddress: rangeIn && rangeIn.end > rangeIn.start ? rangeIn.end & 0xffff : null, attrs: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined)), origin: "user", confidence: "user_asserted" }));
        id = nodeId;
      } else {
        const aid = annotationId(null, "label-override", `${targetKind}:${input.targetId ?? ""}`);
        withStore(store, (st) => annotate(st, { id: aid, kind: "label-override", title: input.label, body: input.note ?? null, name: input.label, attrs: { target_kind: targetKind, target_id: input.targetId } }));
        id = aid;
      }
    } finally {
      store.close();
    }
    return this.listUserLabels().find((l) => l.id === id)!;
  }

  removeUserLabel(key: string): UserLabelOverride | undefined {
    const addr = /^\$?[0-9a-fA-F]{1,4}$/.test(key) ? parseInt(key.replace(/^\$/, ""), 16) & 0xffff : undefined;
    const labels = this.listUserLabels();
    const hit = labels.find((l) => l.id === key || l.label === key || (addr !== undefined && l.targetKind === "address" && l.addressRange?.start === addr));
    if (!hit) return undefined;
    const store = openStore(this.projectDir);
    try {
      ensureSchema822(store.db);
      if (/^ann:/u.test(hit.id)) withStore(store, (st) => st.db.prepare("DELETE FROM annotations WHERE id = ?").run(hit.id));
      else forgetName(store, hit.id);
    } finally {
      store.close();
    }
    return hit;
  }

  /** Human routine nodes (annotation files + the door) with a derived extent — the closed-loop sweep's coverage. */
  listRoutineNodes(): RoutineNode[] {
    return this.read((s) => {
      const rows = s.db.prepare("SELECT * FROM nodes WHERE layer = 'human' AND kind IN ('routine','segment') ORDER BY owner, address").all() as unknown as NodeRow[];
      const out: RoutineNode[] = [];
      const routines = rows.filter((r) => r.kind === "routine");
      const segments = rows.filter((r) => r.kind === "segment");
      for (let i = 0; i < routines.length; i += 1) {
        const r = routines[i]!;
        const next = routines[i + 1];
        let end = r.end_address;
        if (end === null) {
          const seg = segments.find((sg) => sg.owner === r.owner && sg.address <= r.address && (sg.end_address ?? sg.address) >= r.address);
          const segEnd = seg ? (seg.end_address ?? seg.address) : undefined;
          const nextStart = next && next.owner === r.owner ? next.address - 1 : undefined;
          end = segEnd !== undefined && nextStart !== undefined ? Math.min(segEnd, nextStart) : segEnd ?? nextStart ?? r.address;
          if (end < r.address) end = r.address;
        }
        const attrs = attrsOf(r.attrs);
        out.push({ id: r.id, owner: r.owner, address: r.address, endAddress: end, name: r.name, sourcePath: str(attrs.source_path) });
      }
      return out;
    }, []);
  }

  // ---------------------------------------------------------------- the generated layer

  /** Legacy-shaped records from a deterministic importer → the generated layer (D2 purge by artifact, D5 evidence per run). */
  importGenerated(records: Partial<Omit<LegacyInput, "artifacts">>, options: { artifactId?: string; purgeLegacyIds?: Array<{ store: "entities" | "findings" | "relations" | "open-questions" | "labels"; id: string }> } = {}): ImportRecordsResult {
    return importRecords(records, { projectDir: this.projectDir, purgeArtifactId: options.artifactId, purgeLegacyIds: options.purgeLegacyIds });
  }

  /**
   * Spec 053 on claims (822 D4): a claim whose node's address a routine covers
   * is validated by that routine — the "paired heuristic question answered" of
   * the JSON era. Returns how many claims flipped to `answered`.
   */
  validateCoveredClaims(coverers: Array<{ id: string; range: { start: number; end: number } }>, options: { scopeArtifactId?: string } = {}): number {
    if (coverers.length === 0) return 0;
    const store = openStore(this.projectDir);
    try {
      ensureSchema822(store.db);
      return withStore(store, (st) => {
        const rows = st.db.prepare(
          "SELECT c.node_id, c.claim, n.address, n.end_address FROM claims c JOIN nodes n ON n.id = c.node_id WHERE c.validation = 'unvalidated' AND c.layer = 'generated' GROUP BY c.node_id, c.claim",
        ).all() as Array<{ node_id: string; claim: string; address: number; end_address: number | null }>;
        const upd = st.db.prepare("UPDATE claims SET validation = 'answered', validated_by = ?, updated_at = ? WHERE node_id = ? AND claim = ? AND validation = 'unvalidated'");
        const inScope = options.scopeArtifactId
          ? st.db.prepare("SELECT 1 FROM evidence WHERE target_table = 'claims' AND target_key = ? AND artifact_id = ? LIMIT 1")
          : undefined;
        const now = new Date().toISOString();
        let n = 0;
        for (const r of rows) {
          const end = r.end_address ?? r.address;
          const c = coverers.find((x) => x.range.start <= r.address && x.range.end >= end);
          if (!c) continue;
          if (inScope && !inScope.get(`${r.node_id}|${r.claim}`, options.scopeArtifactId!)) continue;
          n += Number(upd.run(c.id, now, r.node_id, r.claim).changes);
        }
        return n;
      });
    } finally {
      store.close();
    }
  }

  counts(): { entities: number; findings: number; relations: number; openQuestions: number } {
    return this.read((s) => {
      const q = (sql: string) => Number((s.db.prepare(sql).get() as { n: number }).n);
      return {
        entities: q("SELECT COUNT(DISTINCT id) AS n FROM nodes WHERE (producer IN ('822','human') OR layer = 'human') AND kind NOT IN ('subsystem','run')") + q("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'entity:%' AND node_id IS NULL"),
        findings: q("SELECT COUNT(*) AS n FROM annotations WHERE kind LIKE 'finding:%'") + q("SELECT COUNT(*) AS n FROM claims"),
        relations: q("SELECT COUNT(*) AS n FROM (SELECT DISTINCT from_id, type, to_id FROM edges WHERE (producer IN ('822','human') OR layer = 'human') AND evidence_key = '')"),
        openQuestions: q("SELECT COUNT(*) AS n FROM questions"),
      };
    }, { entities: 0, findings: 0, relations: 0, openQuestions: 0 });
  }

  /** Artifact ids renamed by dedupeArtifactRegistry: evidence rows and the attrs / evidence JSON that name them. */
  remapArtifactIds(idRemap: Map<string, string>): { entities: number; findings: number; relations: number; openQuestions: number } {
    const counts = { entities: 0, findings: 0, relations: 0, openQuestions: 0 };
    if (idRemap.size === 0) return counts;
    const store = openStore(this.projectDir);
    try {
      ensureSchema822(store.db);
      withStore(store, (st) => {
        const db = st.db;
        for (const [from, to] of idRemap) db.prepare("UPDATE evidence SET artifact_id = ? WHERE artifact_id = ?").run(to, from);
        const rewrite = (json: string): string | undefined => {
          let changed = false;
          const walk = (v: unknown): unknown => {
            if (typeof v === "string") { const t = idRemap.get(v); if (t !== undefined) { changed = true; return t; } return v; }
            if (Array.isArray(v)) return v.map(walk);
            if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
            return v;
          };
          const out = walk(attrsOf(json));
          return changed ? canonicalJson(out) : undefined;
        };
        for (const n of db.prepare("SELECT id, layer, attrs FROM nodes WHERE producer IN ('822','human') OR layer = 'human'").all() as Array<{ id: string; layer: string; attrs: string }>) {
          const next = rewrite(n.attrs); if (next) { db.prepare("UPDATE nodes SET attrs = ? WHERE id = ? AND layer = ?").run(next, n.id, n.layer); counts.entities += 1; }
        }
        for (const a of db.prepare("SELECT id, kind, attrs FROM annotations").all() as Array<{ id: string; kind: string; attrs: string }>) {
          const next = rewrite(a.attrs); if (next) { db.prepare("UPDATE annotations SET attrs = ? WHERE id = ?").run(next, a.id); if (a.kind.startsWith("finding:")) counts.findings += 1; else counts.entities += 1; }
        }
        for (const e of db.prepare("SELECT from_id, type, to_id, layer, evidence_key, evidence FROM edges WHERE producer IN ('822','human') OR layer = 'human'").all() as Array<{ from_id: string; type: string; to_id: string; layer: string; evidence_key: string; evidence: string }>) {
          const next = rewrite(e.evidence); if (next) { db.prepare("UPDATE edges SET evidence = ? WHERE from_id = ? AND type = ? AND to_id = ? AND layer = ? AND evidence_key = ?").run(next, e.from_id, e.type, e.to_id, e.layer, e.evidence_key); counts.relations += 1; }
        }
        for (const q of db.prepare("SELECT id, attrs FROM questions").all() as Array<{ id: string; attrs: string }>) {
          const next = rewrite(q.attrs); if (next) { db.prepare("UPDATE questions SET attrs = ? WHERE id = ?").run(next, q.id); counts.openQuestions += 1; }
        }
      });
    } finally {
      store.close();
    }
    return counts;
  }
}

export { GraphStore };
