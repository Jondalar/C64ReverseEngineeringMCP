// Spec 822 §4 — what 822 adds to <project>/knowledge/graph.sqlite.
//
// 818 owns `nodes`, `edges` and `meta`; this module adds the tables that hold
// evidence per source (D5), generated claims (D5), human prose (D3/D6), the
// questions that were not heuristic noise, and the migration ledger. Every
// statement is CREATE … IF NOT EXISTS on the SAME file, executed through the
// store's `db` — store.ts is not edited (818 owns it).
//
// Deviations from the DDL sketch in the spec, all recorded in §"Built":
//   - `annotations` carries `layer` (a manifest-import "finding" with no node
//     is generated prose; the human-layer hash needs the column) and `attrs`.
//   - `claims`, `annotations`, `questions`, `evidence` carry `producer`, so a
//     re-run or a door can tell its own rows from another writer's.
//   - `annotations` has an explicit `seq INTEGER PRIMARY KEY`: FTS5 external
//     content needs a rowid that survives VACUUM; a TEXT primary key's rowid
//     does not.
//   - `migration_log` carries `note` (`ctx-by-stem` is a note on a `created`
//     row, not a second action — one row per legacy id is the invariant).

import { createHash } from "node:crypto";
import type { DatabaseSync } from "../../platform-kb/sqlite-quiet.js";
import type { Confidence, Layer, Origin } from "../schema.js";

export const SCHEMA_822_VERSION = 1;
export const MIGRATION_PRODUCER = "822";
export const DOOR_PRODUCER = "human";

export type ClaimName = "behaves_like" | "segment_kind" | "display_state" | "display_transfer" | string;
export type ClaimStatus = "active" | "archived" | "rejected";
export type ClaimValidation = "unvalidated" | "answered" | "invalidated";
export type MigrationAction = "created" | "merged" | "folded" | "skipped-regenerable" | "skipped";

export interface EvidenceRow {
  target_table: "nodes" | "edges" | "claims" | "annotations" | "questions";
  target_key: string;
  legacy_id: string;
  artifact_id: string | null;
  excerpt: string | null;
  captured_at: string;
  producer: string;
  attrs: string;
}

export interface ClaimRow {
  node_id: string;
  claim: ClaimName;
  value: string;
  layer: Layer;
  origin: Origin;
  confidence: Confidence;
  score: number | null;
  status: ClaimStatus;
  validation: ClaimValidation;
  validated_by: string | null;
  superseded_by: string | null;
  producer: string;
  attrs: string;
  updated_at: string;
}

export interface AnnotationRow {
  seq?: number;
  id: string;
  node_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  name: string | null;
  tags: string;
  source_path: string | null;
  legacy_id: string | null;
  layer: Layer;
  origin: Origin;
  confidence: Confidence;
  score: number | null;
  status: string;
  producer: string;
  attrs: string;
  created_at: string;
  updated_at: string;
}

export interface QuestionRow {
  id: string;
  node_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  status: string;
  priority: string;
  layer: Layer;
  origin: Origin;
  answer: string | null;
  answered_by: string | null;
  producer: string;
  attrs: string;
  created_at: string;
  updated_at: string;
}

export interface MigrationLogRow {
  legacy_store: string;
  legacy_id: string;
  action: MigrationAction;
  target_table: string | null;
  target_id: string | null;
  note: string | null;
  run_id: number;
}

const LAYER_CHECK = "CHECK (layer IN ('generated','human'))";
const ORIGIN_CHECK = "CHECK (origin IN ('static','runtime','user','imported'))";
const CONFIDENCE_CHECK = "CHECK (confidence IN ('certain','inferred','observed','heuristic','user_asserted'))";

export const SCHEMA_822_DDL = `
CREATE TABLE IF NOT EXISTS evidence (
  target_table TEXT NOT NULL CHECK (target_table IN ('nodes','edges','claims','annotations','questions')),
  target_key   TEXT NOT NULL,
  legacy_id    TEXT NOT NULL,
  artifact_id  TEXT,
  excerpt      TEXT,
  captured_at  TEXT NOT NULL,
  producer     TEXT NOT NULL,
  attrs        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (target_table, target_key, legacy_id)
) STRICT;
CREATE INDEX IF NOT EXISTS evidence_target ON evidence (target_table, target_key);
CREATE INDEX IF NOT EXISTS evidence_artifact ON evidence (artifact_id);

CREATE TABLE IF NOT EXISTS claims (
  node_id       TEXT NOT NULL,
  claim         TEXT NOT NULL,
  value         TEXT NOT NULL,
  layer         TEXT NOT NULL ${LAYER_CHECK},
  origin        TEXT NOT NULL ${ORIGIN_CHECK},
  confidence    TEXT NOT NULL ${CONFIDENCE_CHECK},
  score         REAL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','rejected')),
  validation    TEXT NOT NULL DEFAULT 'unvalidated' CHECK (validation IN ('unvalidated','answered','invalidated')),
  validated_by  TEXT,
  superseded_by TEXT,
  producer      TEXT NOT NULL,
  attrs         TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (node_id, claim, layer)
) STRICT;
CREATE INDEX IF NOT EXISTS claims_node ON claims (node_id);
CREATE INDEX IF NOT EXISTS claims_claim ON claims (claim, value);

CREATE TABLE IF NOT EXISTS annotations (
  seq          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  node_id      TEXT,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  name         TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  source_path  TEXT,
  legacy_id    TEXT,
  layer        TEXT NOT NULL DEFAULT 'human' ${LAYER_CHECK},
  origin       TEXT NOT NULL ${ORIGIN_CHECK},
  confidence   TEXT NOT NULL ${CONFIDENCE_CHECK},
  score        REAL,
  status       TEXT NOT NULL DEFAULT 'active',
  producer     TEXT NOT NULL,
  attrs        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS annotations_node ON annotations (node_id, kind);
CREATE INDEX IF NOT EXISTS annotations_kind ON annotations (kind);
CREATE INDEX IF NOT EXISTS annotations_name ON annotations (name);

CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  node_id      TEXT,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  status       TEXT NOT NULL,
  priority     TEXT NOT NULL,
  layer        TEXT NOT NULL ${LAYER_CHECK},
  origin       TEXT NOT NULL ${ORIGIN_CHECK},
  answer       TEXT,
  answered_by  TEXT,
  producer     TEXT NOT NULL,
  attrs        TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS questions_node ON questions (node_id);
CREATE INDEX IF NOT EXISTS questions_status ON questions (status, layer);

CREATE TABLE IF NOT EXISTS migration_log (
  legacy_store TEXT NOT NULL,
  legacy_id    TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('created','merged','folded','skipped-regenerable','skipped')),
  target_table TEXT,
  target_id    TEXT,
  note         TEXT,
  run_id       INTEGER NOT NULL,
  PRIMARY KEY (legacy_store, legacy_id)
) STRICT;
CREATE INDEX IF NOT EXISTS migration_log_target ON migration_log (target_table, target_id);

CREATE TABLE IF NOT EXISTS migration_runs (
  run_id      INTEGER PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  source_hash TEXT NOT NULL,
  dry_run     INTEGER NOT NULL DEFAULT 0,
  created     INTEGER NOT NULL DEFAULT 0,
  merged      INTEGER NOT NULL DEFAULT 0,
  folded      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  already     INTEGER NOT NULL DEFAULT 0
) STRICT;
`;

// FTS5 over the prose, kept in step by triggers on the content table. The
// `delete` command form is what external-content FTS5 requires; a plain DELETE
// on the virtual table would not remove the index entry.
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS annotations_fts USING fts5(title, body, name, content='annotations', content_rowid='seq');
CREATE TRIGGER IF NOT EXISTS annotations_ai AFTER INSERT ON annotations BEGIN
  INSERT INTO annotations_fts(rowid, title, body, name) VALUES (new.seq, new.title, new.body, new.name);
END;
CREATE TRIGGER IF NOT EXISTS annotations_ad AFTER DELETE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, title, body, name) VALUES ('delete', old.seq, old.title, old.body, old.name);
END;
CREATE TRIGGER IF NOT EXISTS annotations_au AFTER UPDATE ON annotations BEGIN
  INSERT INTO annotations_fts(annotations_fts, rowid, title, body, name) VALUES ('delete', old.seq, old.title, old.body, old.name);
  INSERT INTO annotations_fts(rowid, title, body, name) VALUES (new.seq, new.title, new.body, new.name);
END;
`;

export type TextIndex = "fts5" | "like";

/**
 * Create the 822 tables on an open graph (idempotent). Returns which text
 * index the prose search has: FTS5 when this Node's SQLite ships it (22.21.1 /
 * 3.50.4 does — checked), a LIKE fallback otherwise, recorded in
 * `meta.annotations_text_index` so a reader on a different build can see it.
 */
export function ensureSchema822(db: DatabaseSync): { textIndex: TextIndex } {
  db.exec(SCHEMA_822_DDL);
  let textIndex: TextIndex = "like";
  try {
    db.exec(FTS_DDL);
    textIndex = "fts5";
  } catch {
    textIndex = "like";
  }
  const set = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  set.run("schema_822", String(SCHEMA_822_VERSION));
  set.run("annotations_text_index", textIndex);
  return { textIndex };
}

export function textIndexOf(db: DatabaseSync): TextIndex {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'annotations_text_index'").get() as { value: string } | undefined;
  if (row?.value === "fts5") {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'annotations_fts'").get();
    if (t) return "fts5";
  }
  return "like";
}

export function has822Tables(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('evidence','claims','annotations','questions','migration_log')").get() as { n: number };
  return Number(row.n) === 5;
}

/**
 * The derived annotation id (D6). One routine / label / segment / entity
 * annotation per node — the title is not part of the key for those kinds, so a
 * re-import with an edited comment lands on the same row. Findings and
 * relations keep the title in the key: a node may carry several.
 */
export function annotationId(nodeId: string | null | undefined, kind: string, title: string): string {
  const singleton = kind === "routine" || kind === "label" || kind === "segment" || kind === "entity";
  const key = `${nodeId ?? ""}|${kind}|${singleton ? "" : title}`;
  return `ann:${createHash("sha1").update(key).digest("hex")}`;
}

function jsonLine(row: Record<string, unknown>): string {
  return JSON.stringify(row, Object.keys(row).sort());
}

/** 822 §7 — 818 D6's dump extended to every 822 table except migration_runs, rows by primary key. */
export function canonicalDump822(db: DatabaseSync): string {
  const lines: string[] = [];
  const push = (sql: string) => {
    for (const row of db.prepare(sql).all() as unknown as Record<string, unknown>[]) lines.push(jsonLine(row));
  };
  push("SELECT * FROM evidence ORDER BY target_table, target_key, legacy_id");
  push("SELECT * FROM claims ORDER BY node_id, claim, layer");
  push("SELECT id, node_id, kind, title, body, name, tags, source_path, legacy_id, layer, origin, confidence, score, status, producer, attrs, created_at, updated_at FROM annotations ORDER BY id");
  push("SELECT * FROM questions ORDER BY id");
  push("SELECT * FROM migration_log ORDER BY legacy_store, legacy_id");
  return `${lines.join("\n")}\n`;
}

/**
 * §7 "Human invariant": sha256 over the ordered layer=human rows of nodes,
 * edges and annotations plus every answered question's (id, answer,
 * answered_by). Re-analysis must leave this unchanged.
 */
export function humanLayerDump(db: DatabaseSync): string {
  const lines: string[] = [];
  const push = (sql: string) => {
    for (const row of db.prepare(sql).all() as unknown as Record<string, unknown>[]) lines.push(jsonLine(row));
  };
  push("SELECT * FROM nodes WHERE layer = 'human' ORDER BY id");
  push("SELECT * FROM edges WHERE layer = 'human' ORDER BY from_id, type, to_id, evidence_key");
  if (has822Tables(db)) {
    push("SELECT id, node_id, kind, title, body, name, tags, source_path, legacy_id, layer, origin, confidence, score, status, producer, attrs, created_at, updated_at FROM annotations WHERE layer = 'human' ORDER BY id");
    push("SELECT id, answer, answered_by FROM questions WHERE answer IS NOT NULL ORDER BY id");
  }
  return `${lines.join("\n")}\n`;
}

export function humanLayerHash(db: DatabaseSync): string {
  return createHash("sha256").update(humanLayerDump(db)).digest("hex");
}

export function counts822(db: DatabaseSync): Record<string, number> {
  const q = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    evidence: q("SELECT COUNT(*) AS n FROM evidence"),
    claims: q("SELECT COUNT(*) AS n FROM claims"),
    annotations: q("SELECT COUNT(*) AS n FROM annotations"),
    annotationsHuman: q("SELECT COUNT(*) AS n FROM annotations WHERE layer = 'human'"),
    questions: q("SELECT COUNT(*) AS n FROM questions"),
    migrationLog: q("SELECT COUNT(*) AS n FROM migration_log"),
    migrationRuns: q("SELECT COUNT(*) AS n FROM migration_runs"),
  };
}
