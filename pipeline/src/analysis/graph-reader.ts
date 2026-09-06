// Spec 820.2 (D7) — pipeline-side reader for <project>/knowledge/graph.sqlite.
//
// The pipeline is CommonJS and cannot import the ESM half (src/knowledge-graph):
// not the producers, not the query API. It CAN read the ESM half's FILE, the
// way pipeline/src/lib/platform-kb.ts reads resources/platform-kb.sqlite. This
// module contains no classification of its own — the 820 producer decided what
// is a READ and what is a WRITE; this only lists its rows for one owner.
//
// Absent graph = a loud, named reason the renderer prints, never a silent
// fall-back (doctrine rule 1). The pipeline half cannot seed on demand — the
// producers are ESM — so "absent" stays absent here and the renderer says so.

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

export type AccessEdgeType = "READS" | "WRITES" | "READS_INDIRECT" | "WRITES_INDIRECT";

export interface AccessEdge {
  type: AccessEdgeType;
  /** the edge's `to_id` — a platform id (`c64:zp:0020`) or a project id (`slug:ram:addr:1234`) */
  toId: string;
  /** the address parsed from `toId` (its last segment) */
  target: number;
  /** the kind segment of `toId`: zp | ram | io | rom (platform) or addr | routine | label (project) */
  toKind: string;
  /** evidence.source_address — the instruction */
  pc: number;
  mnemonic: string;
  addressingMode: string;
  provenance: "confirmed_code" | "probable_code";
  indexed: boolean;
  /** D3 second edge: the pair that resolved an indirect access to a constant target */
  viaZp?: number;
  /** *_INDIRECT: the ZP base the instruction names */
  pointerZp?: number;
}

export type GraphLookup =
  | { status: "ok"; path: string; owner: string; edges: AccessEdge[] }
  | { status: "absent"; owner: string; path?: string; reason: string };

type Sqlite = typeof import("node:sqlite");

let warned = false;
function quietSqlite(): Sqlite {
  if (!warned) {
    warned = true;
    process.removeAllListeners("warning");
    process.on("warning", (warning) => {
      if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
      console.error(`${warning.name}: ${warning.message}`);
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:sqlite") as Sqlite;
}

/** The 819/820 owner of an analysis: the `_analysis.json` stem, lowercased. From a PRG path: its stem. */
export function ownerFromBinaryName(binaryName: string): string {
  return basename(binaryName).replace(/_analysis\.json$/iu, "").replace(/\.[^.]+$/u, "").toLowerCase();
}

/** Where the project graph lives: an explicit project dir, else C64RE_PROJECT_DIR, else the cwd. */
export function resolveGraphPath(projectDir?: string): { projectDir: string; path: string } {
  const dir = resolve(projectDir ?? process.env.C64RE_PROJECT_DIR ?? process.cwd());
  return { projectDir: dir, path: resolve(dir, "knowledge", "graph.sqlite") };
}

function addressOfId(id: string): { address: number; kind: string } | undefined {
  const parts = id.split(":");
  const last = parts[parts.length - 1] ?? "";
  if (!/^[0-9a-f]{4}$/u.test(last)) return undefined;
  return { address: parseInt(last, 16), kind: parts[parts.length - 2] ?? "?" };
}

/**
 * Every 820 access edge of one owner, in the store's canonical order. `absent`
 * names the reason: no file, or a file with no 820 rows for that owner (seed it).
 */
export function loadAccessEdges(options: { projectDir?: string; owner: string }): GraphLookup {
  const owner = options.owner.toLowerCase();
  const { path } = resolveGraphPath(options.projectDir);
  if (!existsSync(path)) return { status: "absent", owner, path, reason: `no ${path} — nothing has been seeded (c64re graph seed)` };
  const { DatabaseSync } = quietSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT type, to_id, evidence FROM edges WHERE layer = 'generated' AND producer = '820' AND owner = ? AND type IN ('READS','WRITES','READS_INDIRECT','WRITES_INDIRECT') ORDER BY from_id, type, to_id, evidence_key",
      )
      .all(owner) as Array<{ type: AccessEdgeType; to_id: string; evidence: string }>;
    if (rows.length === 0) {
      const owners = (db.prepare("SELECT DISTINCT owner FROM edges WHERE producer = '820' ORDER BY owner").all() as Array<{ owner: string }>).map((r) => r.owner);
      return { status: "absent", owner, path, reason: `${path} holds no Spec 820 rows for owner "${owner}" (seeded owners: ${owners.length ? owners.join(", ") : "none"}) — c64re graph seed --owner ${owner}` };
    }
    const edges: AccessEdge[] = [];
    for (const row of rows) {
      const to = addressOfId(row.to_id);
      if (!to) continue;
      const ev = JSON.parse(row.evidence) as Record<string, unknown>;
      if (typeof ev.source_address !== "number") continue;
      edges.push({
        type: row.type,
        toId: row.to_id,
        target: to.address,
        toKind: to.kind,
        pc: ev.source_address,
        mnemonic: String(ev.mnemonic ?? "").toLowerCase(),
        addressingMode: String(ev.addressing_mode ?? ""),
        provenance: ev.provenance === "probable_code" ? "probable_code" : "confirmed_code",
        indexed: ev.indexed === true,
        viaZp: typeof ev.via_zp === "number" ? ev.via_zp : undefined,
        pointerZp: typeof ev.pointer_zp === "number" ? ev.pointer_zp : undefined,
      });
    }
    return { status: "ok", path, owner, edges };
  } finally {
    db.close();
  }
}
