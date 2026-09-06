// Spec 822 D3 / D7 / D9 — the human door, widened.
//
// "Human" means "came through a door", not "typed by a person": every function
// here writes layer=human, origin=user, confidence=user_asserted, producer
// "human" — whether a person or an agent held the door. Each call is one
// BEGIN IMMEDIATE … COMMIT on the project graph (D9): a second writer waits on
// the store's busy_timeout instead of losing, which is what the JSON store
// could not do (822 §1). Nothing here can touch layer=generated.
//
// Every door takes a project directory (opens and closes the store around the
// call) or an open GraphStore (one connection per process for its lifetime).

import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { deriveProjectId, deriveSubsystemId, parseId, type ProjectIdParts } from "../ids.js";
import type { NodeRow } from "../schema.js";
import { GraphStore, readProjectSlug } from "../store.js";
import { annotationId, DOOR_PRODUCER, ensureSchema822, type AnnotationRow, type QuestionRow } from "./schema-822.js";

export type StoreTarget = string | GraphStore;

const sortedJson = (v: Record<string, unknown>) => JSON.stringify(v, Object.keys(v).sort());
const compact = (o: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
};

export function projectDirOf(store: GraphStore): string {
  return dirname(dirname(store.path));
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Open the project graph for writing, waiting out another process's write
 * transaction. The store's constructor runs `PRAGMA journal_mode = WAL` before
 * it sets `busy_timeout`, so an open that lands inside another writer's
 * BEGIN IMMEDIATE fails with SQLITE_BUSY instead of waiting (the 2 × 200 gate
 * found it); this retries with a linear back-off up to `timeoutMs`. The
 * one-line fix belongs in store.ts (`new DatabaseSync(path, { timeout })`,
 * 822 D9) — reported, not edited here.
 */
export function openStore(projectDir: string, options: { timeoutMs?: number } = {}): GraphStore {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  let wait = 5;
  for (;;) {
    try {
      return GraphStore.open(projectDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/database is locked|SQLITE_BUSY/iu.test(message) || Date.now() + wait > deadline) throw error;
      sleepMs(wait);
      wait = Math.min(wait * 2, 100);
    }
  }
}

/** Run `fn` on an open, writable store inside one BEGIN IMMEDIATE transaction. */
export function withStore<T>(target: StoreTarget, fn: (store: GraphStore) => T): T {
  const owned = typeof target === "string";
  const store = owned ? openStore(target) : target;
  if (store.readOnly) throw new Error("the human door needs a writable store");
  try {
    ensureSchema822(store.db);
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn(store);
      store.db.exec("COMMIT");
      return out;
    } catch (error) {
      try { store.db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
      throw error;
    }
  } finally {
    if (owned) store.close();
  }
}

// ------------------------------------------------------------------ nodes

export interface NameNodeInput {
  /** a finished id, or the parts it derives from */
  id?: string;
  parts?: ProjectIdParts;
  /** routine | label | addr | segment | subsystem | … — must agree with the id */
  kind: string;
  name: string;
  /** prose about the node; becomes a `routine` / `label` annotation */
  comment?: string;
  endAddress?: number | null;
  attrs?: Record<string, unknown>;
  /** who held the door — an agent role or a person; recorded in attrs.author */
  author?: string;
}

/**
 * Name or rename a node in the human layer (INSERT … ON CONFLICT(id, layer) DO
 * UPDATE — 818's door). The generated row beneath keeps its name; every query
 * answers with this one (D1). Re-analysis never issues a statement against it.
 */
export function nameNode(target: StoreTarget, input: NameNodeInput): NodeRow {
  return withStore(target, (store) => {
    const id = input.id ?? deriveProjectId(input.parts!);
    const now = new Date().toISOString();
    const row = store.upsertHuman({
      id, kind: input.kind, name: input.name, endAddress: input.endAddress ?? null,
      attrs: compact({ ...(input.attrs ?? {}), comment: input.comment, author: input.author, updated_at: now }),
      origin: "user", confidence: "user_asserted",
    }, DOOR_PRODUCER);
    if (input.comment !== undefined) {
      const kind = input.kind === "routine" ? "routine" : input.kind === "segment" ? "segment" : "label";
      upsertAnnotation(store, { nodeId: id, kind, title: input.name, body: input.comment, name: input.name, author: input.author, now });
    }
    return row;
  });
}

// ------------------------------------------------------------------ annotations

export interface AnnotateInput {
  /** the node the prose is about; null / undefined = project-level */
  nodeId?: string | null;
  /** routine | label | segment | entity | finding:<kind> | note | … */
  kind: string;
  title: string;
  body?: string | null;
  /** the routine / label name when the annotation names something */
  name?: string | null;
  tags?: string[];
  sourcePath?: string | null;
  /** the legacy record id this mirrors (823 shows finding ids on the card) */
  legacyId?: string | null;
  status?: string;
  score?: number | null;
  attrs?: Record<string, unknown>;
  author?: string;
  /** what the annotation rests on — one `evidence` row each */
  evidence?: Array<{ artifactId?: string; excerpt?: string; key?: string; capturedAt?: string }>;
  now?: string;
}

function upsertAnnotation(store: GraphStore, input: AnnotateInput): AnnotationRow {
  const db = store.db;
  const now = input.now ?? new Date().toISOString();
  const nodeId = input.nodeId ?? null;
  if (nodeId !== null) parseId(nodeId);
  const id = annotationId(nodeId, input.kind, input.title);
  const existing = db.prepare("SELECT created_at FROM annotations WHERE id = ?").get(id) as { created_at: string } | undefined;
  const row: AnnotationRow = {
    id, node_id: nodeId, kind: input.kind, title: input.title, body: input.body ?? null, name: input.name ?? null,
    tags: JSON.stringify([...new Set(input.tags ?? [])].sort()), source_path: input.sourcePath ?? null, legacy_id: input.legacyId ?? null,
    layer: "human", origin: "user", confidence: "user_asserted", score: input.score ?? null, status: input.status ?? "active", producer: DOOR_PRODUCER,
    attrs: sortedJson(compact({ ...(input.attrs ?? {}), author: input.author })), created_at: existing?.created_at ?? now, updated_at: now,
  };
  db.prepare(
    `INSERT INTO annotations (id, node_id, kind, title, body, name, tags, source_path, legacy_id, layer, origin, confidence, score, status, producer, attrs, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, body = excluded.body, name = excluded.name, tags = excluded.tags, source_path = excluded.source_path,
       legacy_id = excluded.legacy_id, layer = excluded.layer, origin = excluded.origin, confidence = excluded.confidence, score = excluded.score,
       status = excluded.status, producer = excluded.producer, attrs = excluded.attrs, updated_at = excluded.updated_at`,
  ).run(row.id, row.node_id, row.kind, row.title, row.body, row.name, row.tags, row.source_path, row.legacy_id, row.layer, row.origin, row.confidence, row.score, row.status, row.producer, row.attrs, row.created_at, row.updated_at);
  const insEvidence = db.prepare("INSERT OR IGNORE INTO evidence (target_table, target_key, legacy_id, artifact_id, excerpt, captured_at, producer, attrs) VALUES (?,?,?,?,?,?,?,?)");
  for (const ev of input.evidence ?? []) {
    insEvidence.run("annotations", id, ev.key ?? `door:${now}:${randomBytes(4).toString("hex")}`, ev.artifactId ?? null, ev.excerpt ?? null, ev.capturedAt ?? now, DOOR_PRODUCER, "{}");
  }
  return row;
}

/** Prose on a node (or the project), idempotent by derived annotation id (D6). */
export function annotate(target: StoreTarget, input: AnnotateInput): AnnotationRow {
  return withStore(target, (store) => upsertAnnotation(store, input));
}

export interface FindingLike {
  id?: string;
  kind: string;
  title: string;
  summary?: string;
  status?: string;
  confidence?: number;
  tags?: string[];
  addressRange?: { start: number; end: number; bank?: number };
  /** graph node ids (not legacy entity ids) the finding is about; the first is the annotation's node */
  nodeIds?: string[];
  artifactIds?: string[];
  evidence?: Array<{ artifactId?: string; excerpt?: string; note?: string; title?: string; capturedAt?: string }>;
  author?: string;
}

/**
 * `save_finding` through the graph: a `finding:<kind>` annotation on the node
 * of the address range (an `addr` node, created in the human layer when
 * absent so `graph find $addr` shows it), else on the first node id given,
 * else on the project. This is the door the 822.1 dual-write calls from
 * `saveFinding` before it mirrors to JSON.
 */
export function recordFinding(target: StoreTarget, finding: FindingLike): AnnotationRow {
  return withStore(target, (store) => {
    let nodeId: string | null = finding.nodeIds?.[0] ?? null;
    if (finding.addressRange) {
      const slug = readProjectSlug(projectDirOf(store));
      const start = finding.addressRange.start & 0xffff;
      nodeId = deriveProjectId({ slug, ctx: { space: "ram" }, kind: "addr", address: start });
      const present = store.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(nodeId);
      if (!present) {
        store.upsertHuman({ id: nodeId, kind: "addr", name: null, endAddress: finding.addressRange.end > start ? finding.addressRange.end & 0xffff : null, attrs: { from: "finding" }, origin: "user", confidence: "user_asserted" }, DOOR_PRODUCER);
      }
    }
    return upsertAnnotation(store, {
      nodeId, kind: `finding:${finding.kind}`, title: finding.title, body: finding.summary ?? null, tags: finding.tags, legacyId: finding.id ?? null,
      status: finding.status ?? "proposed", score: finding.confidence ?? null, author: finding.author,
      attrs: compact({ address_range: finding.addressRange, node_ids: finding.nodeIds, artifact_ids: finding.artifactIds }),
      evidence: (finding.evidence ?? []).map((ev, i) => ({ artifactId: ev.artifactId, excerpt: ev.excerpt ?? ev.note ?? ev.title, key: finding.id ? `${finding.id}#${i}` : undefined, capturedAt: ev.capturedAt })),
    });
  });
}

// ------------------------------------------------------------------ edges — `link_entities` through the graph

export interface LinkNodesInput {
  from: string;
  /** CALLS | READS | WRITES | CONTAINS | DEPENDS_ON | DOCUMENTS | … — upper-case, the migration's vocabulary */
  type: string;
  to: string;
  title?: string;
  comment?: string;
  author?: string;
}

/** A human edge (origin user, evidence_key ''); INSERT OR IGNORE — the same assertion twice is one row. Returns whether a row was added. */
export function linkNodes(target: StoreTarget, input: LinkNodesInput): boolean {
  return withStore(target, (store) => {
    parseId(input.from);
    parseId(input.to);
    const type = input.type.toUpperCase().replace(/-/gu, "_");
    const now = new Date().toISOString();
    const r = store.db.prepare(
      "INSERT OR IGNORE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, ?, ?, 'human', '', 'user', 'user_asserted', ?, NULL, ?)",
    ).run(input.from, type, input.to, DOOR_PRODUCER, sortedJson(compact({ title: input.title, comment: input.comment, author: input.author, asserted_at: now })));
    return Number(r.changes) > 0;
  });
}

// ------------------------------------------------------------------ subsystems (D7)

export interface AssignSubsystemInput {
  /** lowercase [a-z0-9_.-]; the id is `<slug>:sub:<name>` */
  name: string;
  /** node ids that belong to the subsystem; CONTAINS edges are added, never removed here */
  members: string[];
  title?: string;
  comment?: string;
  author?: string;
}

export interface AssignSubsystemResult {
  id: string;
  added: number;
  members: number;
}

/**
 * A subsystem is a human node with no address plus CONTAINS edges to its
 * members (D7). Membership through this door is origin=user; an importer's
 * clustering would write origin=static — not built here.
 */
export function assignSubsystem(target: StoreTarget, input: AssignSubsystemInput): AssignSubsystemResult {
  return withStore(target, (store) => {
    const slug = readProjectSlug(projectDirOf(store));
    const id = deriveSubsystemId(slug, input.name);
    const now = new Date().toISOString();
    store.upsertHuman({ id, kind: "subsystem", name: input.title ?? input.name, attrs: compact({ comment: input.comment, author: input.author, updated_at: now }), origin: "user", confidence: "user_asserted" }, DOOR_PRODUCER);
    if (input.comment !== undefined) upsertAnnotation(store, { nodeId: id, kind: "entity", title: input.title ?? input.name, body: input.comment, name: input.name, author: input.author, now });
    const ins = store.db.prepare(
      "INSERT OR IGNORE INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?, 'CONTAINS', ?, 'human', '', 'user', 'user_asserted', ?, NULL, ?)",
    );
    let added = 0;
    for (const member of input.members) {
      parseId(member);
      added += Number(ins.run(id, member, DOOR_PRODUCER, sortedJson(compact({ author: input.author, assigned_at: now }))).changes);
    }
    const members = Number((store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE from_id = ? AND type = 'CONTAINS'").get(id) as { n: number }).n);
    return { id, added, members };
  });
}

// ------------------------------------------------------------------ questions

export interface AskQuestionInput {
  id?: string;
  nodeId?: string | null;
  kind: string;
  title: string;
  body?: string | null;
  priority?: string;
  attrs?: Record<string, unknown>;
  author?: string;
}

export function askQuestion(target: StoreTarget, input: AskQuestionInput): QuestionRow {
  return withStore(target, (store) => {
    const now = new Date().toISOString();
    const id = input.id ?? `q:${now.replace(/[^0-9]/gu, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
    if (input.nodeId) parseId(input.nodeId);
    const row: QuestionRow = {
      id, node_id: input.nodeId ?? null, kind: input.kind, title: input.title, body: input.body ?? null, status: "open", priority: input.priority ?? "medium",
      layer: "human", origin: "user", answer: null, answered_by: null, producer: DOOR_PRODUCER, attrs: sortedJson(compact({ ...(input.attrs ?? {}), author: input.author })),
      created_at: now, updated_at: now,
    };
    store.db.prepare(
      `INSERT INTO questions (id, node_id, kind, title, body, status, priority, layer, origin, answer, answered_by, producer, attrs, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET node_id = excluded.node_id, kind = excluded.kind, title = excluded.title, body = excluded.body, priority = excluded.priority, attrs = excluded.attrs, updated_at = excluded.updated_at`,
    ).run(row.id, row.node_id, row.kind, row.title, row.body, row.status, row.priority, row.layer, row.origin, row.answer, row.answered_by, row.producer, row.attrs, row.created_at, row.updated_at);
    return store.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as unknown as QuestionRow;
  });
}

export interface AnswerQuestionInput {
  id: string;
  answer: string;
  /** a finding / annotation id, an agent role, a person */
  answeredBy?: string;
  /** default answered; `invalidated` rejects the question's premise */
  status?: "answered" | "invalidated";
}

/**
 * Answer a question. The answer is protected like a human row whatever the
 * question's layer (§4): a generated question keeps its layer, the answer
 * columns are in the human-layer hash.
 */
export function answerQuestion(target: StoreTarget, input: AnswerQuestionInput): QuestionRow {
  return withStore(target, (store) => {
    const now = new Date().toISOString();
    const r = store.db.prepare("UPDATE questions SET answer = ?, answered_by = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(input.answer, input.answeredBy ?? null, input.status ?? "answered", now, input.id);
    if (Number(r.changes) === 0) throw new Error(`no question ${input.id} in the graph (questions come from the migration or askQuestion)`);
    return store.db.prepare("SELECT * FROM questions WHERE id = ?").get(input.id) as unknown as QuestionRow;
  });
}

// ------------------------------------------------------------------ deletion — the human row goes, the generated answer is visible again (D1)

export function forgetName(target: StoreTarget, id: string): boolean {
  return withStore(target, (store) => {
    parseId(id);
    const r = store.db.prepare("DELETE FROM nodes WHERE id = ? AND layer = 'human'").run(id);
    return Number(r.changes) > 0;
  });
}
