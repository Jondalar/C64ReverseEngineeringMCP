// Spec 818 §4 — the project graph schema, <project>/knowledge/graph.sqlite.
//
// Two tables and a meta table. `layer` is in the primary key: one id has at most
// one generated and one human row (D5). No foreign keys — a to_id may live in
// the platform file (D7) and a human edge may outlive its generated endpoint;
// dangling is a query result, not a constraint violation. `kind` and `type`
// carry no CHECK because later slices append values; schema_version gates
// readers.
//
// Version 2 (Spec 909): a cartridge bank lives inside a cartridge. `crt/<cart>/<bank>`
// replaces `crt/<bank>`, and `nodes.cart` is the cartridge token read out of the id. A
// version-1 reader cannot parse the new ids, so it must refuse the file, not misread it.

export const GRAPH_SCHEMA_VERSION = 2;

/** `meta.cart_grammar`: this graph speaks `crt/<cart>/<bank>`. A graph created now carries it from birth; an older one gets it from the migration. */
export const CART_GRAMMAR_STAMP = "cartridge-ids";
/** The value earlier releases stamped. Read, never written: such a graph counts as stamped, and the producer-id migration rewrites it. */
export const LEGACY_CART_GRAMMAR_STAMP = "909";

/**
 * The cartridge token out of a node id, as a virtual column: `<slug>:crt/<cart>/<bank>:...` and
 * `<slug>:crt/<cart>:cartridge` both give `<cart>`. Derived from the id and never written, so it
 * cannot drift from it. A pre-909 id (`crt/<bank>`) reads as its bank here; the migration finds
 * those by shape and renames them, after which no id does.
 */
export const CART_COLUMN_EXPR = "CASE WHEN space = 'crt' THEN substr(substr(id, instr(id, ':crt/') + 5), 1, min(instr(substr(id, instr(id, ':crt/') + 5) || '/', '/'), instr(substr(id, instr(id, ':crt/') + 5) || ':', ':')) - 1) END";

export const ORIGINS = ["static", "runtime", "user", "imported"] as const;
export const CONFIDENCES = ["certain", "inferred", "observed", "heuristic", "user_asserted"] as const;
export const LAYERS = ["generated", "human"] as const;

export type Origin = (typeof ORIGINS)[number];
export type Confidence = (typeof CONFIDENCES)[number];
export type Layer = (typeof LAYERS)[number];

export interface NodeRow {
  id: string;
  layer: Layer;
  kind: string;
  space: string;
  owner: string | null;
  bank: number | null;
  /** the producing RUN's artifact stem — the replacement unit (818 D5); NULL for shared `addr` nodes */
  run_owner: string | null;
  address: number;
  end_address: number | null;
  name: string | null;
  attrs: string; // JSON
  origin: Origin;
  confidence: Confidence;
  producer: string;
  evidence: string; // JSON array
  /** Spec 909 — read out of `id` by the table itself (CART_COLUMN_EXPR); never written */
  cart?: string | null;
}

export interface EdgeRow {
  from_id: string;
  type: string;
  to_id: string;
  layer: Layer;
  evidence_key: string;
  origin: Origin;
  confidence: Confidence;
  producer: string;
  owner: string | null;
  evidence: string; // JSON object
}

export const GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE IF NOT EXISTS nodes (
  id           TEXT    NOT NULL,
  layer        TEXT    NOT NULL CHECK (layer IN ('generated','human')),
  kind         TEXT    NOT NULL,
  space        TEXT    NOT NULL,
  owner        TEXT,
  bank         INTEGER,
  run_owner    TEXT,
  address      INTEGER NOT NULL CHECK (address BETWEEN 0 AND 65535),
  end_address  INTEGER CHECK (end_address IS NULL OR end_address >= address),
  name         TEXT,
  attrs        TEXT    NOT NULL DEFAULT '{}',
  origin       TEXT    NOT NULL CHECK (origin IN ('static','runtime','user','imported')),
  confidence   TEXT    NOT NULL CHECK (confidence IN ('certain','inferred','observed','heuristic','user_asserted')),
  producer     TEXT    NOT NULL,
  evidence     TEXT    NOT NULL DEFAULT '[]',
  cart         TEXT GENERATED ALWAYS AS (${CART_COLUMN_EXPR}) VIRTUAL,
  PRIMARY KEY (id, layer)
) STRICT;
CREATE INDEX IF NOT EXISTS nodes_address ON nodes (address, space);
CREATE INDEX IF NOT EXISTS nodes_owner   ON nodes (owner, kind);
CREATE INDEX IF NOT EXISTS nodes_name    ON nodes (name);
CREATE INDEX IF NOT EXISTS nodes_producer ON nodes (producer, run_owner, layer);
CREATE INDEX IF NOT EXISTS nodes_cart    ON nodes (cart, bank, address);

CREATE TABLE IF NOT EXISTS edges (
  from_id      TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  to_id        TEXT    NOT NULL,
  layer        TEXT    NOT NULL CHECK (layer IN ('generated','human')),
  evidence_key TEXT    NOT NULL DEFAULT '',
  origin       TEXT    NOT NULL CHECK (origin IN ('static','runtime','user','imported')),
  confidence   TEXT    NOT NULL CHECK (confidence IN ('certain','inferred','observed','heuristic','user_asserted')),
  producer     TEXT    NOT NULL,
  owner        TEXT,
  evidence     TEXT    NOT NULL DEFAULT '{}',
  PRIMARY KEY (from_id, type, to_id, layer, evidence_key)
) STRICT;
CREATE INDEX IF NOT EXISTS edges_to   ON edges (to_id, type);
CREATE INDEX IF NOT EXISTS edges_from ON edges (from_id, type);
CREATE INDEX IF NOT EXISTS edges_producer ON edges (producer, owner, layer);
`;

export const CONTROL_FLOW_TYPES = ["CALLS", "CALLS_ROM", "JUMPS_TO", "BRANCHES_TO"] as const;
export const EDGE_TYPES = [...CONTROL_FLOW_TYPES, "CONTAINS", "READS", "WRITES", "REFERENCES_DATA"] as const;
