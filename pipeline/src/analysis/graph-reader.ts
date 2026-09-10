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

// ---------------------------------------------------------------------------
// Spec 838 D3b — code seeds from the graph.
//
// The defect (issue #16): recursive descent only reaches what is called from
// INSIDE this image, so resident code entered from a different overlay renders
// as a `.byte` wall. The graph has crossed that boundary since Spec 826 — it
// holds the other overlay's `jsr $4315` as a CALLS edge onto the ownerless
// `addr` node for $4315. This reader hands those addresses to the descent.
//
// Three sources, never a byte-shape guess (Spec 750):
//   S1 human_routine     a human-layer `routine` node THIS owner has in range
//   S2 cross_owner_call  CALLS / JUMPS_TO from a DIFFERENT owner onto an
//      cross_owner_jump  ownerless `addr` node inside this image
//   S3 resolved_alias    a Spec 826.0 RESOLVES_TO alias pointing at a
//                        routine/label of THIS owner
//
// And ONE subtraction, which is the graph's own answer rather than a guess: an
// S2 address whose `addr` node RESOLVES_TO a routine/label owned by SOMEBODY
// ELSE belongs to that overlay, not to this one. It is reported, not dropped.

export type CodeSeedOrigin = "human_routine" | "cross_owner_call" | "cross_owner_jump" | "resolved_alias";

export interface CodeSeed {
  address: number;
  origin: CodeSeedOrigin;
  /** human-readable provenance, e.g. `CALLS from owner "chunk_7400" (3 call sites)` */
  detail: string;
}

export type CodeSeedLookup =
  | { status: "ok"; path: string; owner: string; space: string; seeds: CodeSeed[]; skipped: Array<{ address: number; detail: string }> }
  | { status: "absent"; owner: string; path?: string; reason: string };

/** The ctx space (`ram` | `drv` | `crt`) an id names — `wl:ram/eng:routine:1234` → `ram`. */
function ctxSpaceOfId(id: string): string | undefined {
  const parts = id.split(":");
  if (parts.length !== 4) return undefined;
  return (parts[1] ?? "").split("/")[0];
}

/**
 * Addresses the graph already knows are code inside [`lo`,`hi`] for one owner.
 * Read-only; an absent or unseeded graph is a NAMED reason, never a silent zero
 * (doctrine rule 1) — the caller prints it into the listing.
 */
export function loadCodeSeeds(options: { projectDir?: string; owner: string; lo: number; hi: number }): CodeSeedLookup {
  const owner = options.owner.toLowerCase();
  const { lo, hi } = options;
  const { path } = resolveGraphPath(options.projectDir);
  if (!existsSync(path)) return { status: "absent", owner, path, reason: `no ${path} — nothing has been seeded (c64re graph seed)` };
  const { DatabaseSync } = quietSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    // The space this owner lives in comes from the owner's own rows, so drive
    // code at $0700 is never seeded from a C64-RAM $0700 and vice versa.
    const mine = db.prepare("SELECT id FROM nodes WHERE owner = ? ORDER BY id LIMIT 1").all(owner) as Array<{ id: string }>;
    if (mine.length === 0) {
      const owners = (db.prepare("SELECT DISTINCT owner FROM nodes WHERE owner IS NOT NULL ORDER BY owner").all() as Array<{ owner: string }>).map((r) => r.owner);
      return { status: "absent", owner, path, reason: `${path} holds no nodes for owner "${owner}" (seeded owners: ${owners.length ? owners.join(", ") : "none"}) — c64re graph seed --owner ${owner}` };
    }
    const space = ctxSpaceOfId(mine[0]!.id) ?? "ram";
    const inRange = (a: number): boolean => a >= lo && a <= hi;

    const seeds = new Map<number, CodeSeed>();
    const add = (address: number, origin: CodeSeedOrigin, detail: string): void => {
      if (!inRange(address)) return;
      if (!seeds.has(address)) seeds.set(address, { address, origin, detail });
    };

    // What the graph says lives at an address, by owner — used both for S3 and
    // for the one subtraction below.
    const resolvesTo = new Map<string, string>(); // addr id → target id
    for (const row of db.prepare("SELECT from_id, to_id FROM edges WHERE type = 'RESOLVES_TO' ORDER BY from_id").all() as Array<{ from_id: string; to_id: string }>) {
      if (!resolvesTo.has(row.from_id)) resolvesTo.set(row.from_id, row.to_id);
    }
    const ownerOfId = (id: string): string | undefined => {
      const parts = id.split(":");
      if (parts.length !== 4) return undefined;
      const ctx = (parts[1] ?? "").split("/");
      return ctx.length > 1 ? ctx[1] : undefined;
    };

    // S1 — a human said "there is a routine here".
    for (const row of db
      .prepare("SELECT id, name FROM nodes WHERE layer = 'human' AND kind = 'routine' AND owner = ? AND address BETWEEN ? AND ? ORDER BY address")
      .all(owner, lo, hi) as Array<{ id: string; name: string | null }>) {
      const a = addressOfId(row.id);
      if (!a || ctxSpaceOfId(row.id) !== space) continue;
      add(a.address, "human_routine", `human routine node${row.name ? ` "${row.name}"` : ""} (graph human layer)`);
    }

    // S2 — another overlay calls or jumps into this image.
    const callers = new Map<number, Map<string, { type: string; count: number }>>();
    for (const row of db
      .prepare("SELECT type, to_id, owner, COUNT(*) AS sites FROM edges WHERE type IN ('CALLS','JUMPS_TO') AND to_id LIKE '%:addr:%' GROUP BY type, to_id, owner ORDER BY to_id")
      .all() as Array<{ type: string; to_id: string; owner: string | null; sites: number }>) {
      const a = addressOfId(row.to_id);
      if (!a || a.kind !== "addr" || !inRange(a.address)) continue;
      if (ctxSpaceOfId(row.to_id) !== space) continue;
      const from = (row.owner ?? "").toLowerCase();
      if (from === "" || from === owner) continue; // an edge of my own never crosses an overlay boundary
      let byOwner = callers.get(a.address);
      if (!byOwner) { byOwner = new Map(); callers.set(a.address, byOwner); }
      const key = `${row.type}|${from}`;
      const seen = byOwner.get(key);
      if (seen) seen.count += Number(row.sites);
      else byOwner.set(key, { type: row.type, count: Number(row.sites) });
    }
    const skipped: Array<{ address: number; detail: string }> = [];
    for (const [address, byOwner] of [...callers.entries()].sort((l, r) => l[0] - r[0])) {
      // The one subtraction: 826.0 already decided this address belongs to a
      // different overlay. Say so instead of promoting somebody else's code.
      const addrId = `${mine[0]!.id.split(":")[0]}:${space}:addr:${address.toString(16).padStart(4, "0")}`;
      const target = resolvesTo.get(addrId);
      const targetOwner = target ? ownerOfId(target) : undefined;
      const sites = [...byOwner.values()].reduce((sum, v) => sum + v.count, 0);
      const from = [...byOwner.entries()].map(([key, v]) => `${v.type} from "${key.split("|")[1]}"`).sort().join(", ");
      if (targetOwner !== undefined && targetOwner !== owner) {
        skipped.push({ address, detail: `${from}, but Spec 826 RESOLVES_TO ${target} — that address is owner "${targetOwner}"'s code, not this image's` });
        continue;
      }
      const jumpOnly = [...byOwner.values()].every((v) => v.type === "JUMPS_TO");
      add(address, jumpOnly ? "cross_owner_jump" : "cross_owner_call", `${from} (${sites} site${sites === 1 ? "" : "s"})`);
    }

    // S3 — a Spec 826 alias that already points at something of mine.
    for (const [addrId, target] of resolvesTo) {
      if (ctxSpaceOfId(addrId) !== space) continue;
      const a = addressOfId(addrId);
      if (!a || a.kind !== "addr" || !inRange(a.address)) continue;
      if (ownerOfId(target) !== owner) continue;
      const kind = target.split(":")[2] ?? "?";
      if (kind !== "routine" && kind !== "label") continue;
      add(a.address, "resolved_alias", `Spec 826 RESOLVES_TO ${target}`);
    }

    return { status: "ok", path, owner, space, seeds: [...seeds.values()].sort((l, r) => l.address - r.address), skipped };
  } finally {
    db.close();
  }
}
