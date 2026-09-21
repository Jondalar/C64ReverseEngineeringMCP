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
import { covers, describeWindow, hex4, innerWindows, loadWindows, windowFor, type PayloadWindow } from "./payload-windows";

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

/**
 * "seeded owners: …", cut to what a caller can act on.
 *
 * This string is stored in the analysis JSON as `codeSeedReport.reason`, and from
 * there it is printed into every analyze_prg answer, every disasm_prg answer and
 * every listing header. On a project with ~500 owners that is thousands of
 * characters per artifact, repeated across hundreds of payloads — by a wide margin
 * the largest single context cost of an autonomous run, and not one of the names was
 * actionable. What IS actionable: how many there are, and the ones whose names are
 * closest to the one that was asked for, because the usual cause is a near miss.
 *
 * `C64RE_GRAPH_SEED_OWNERS=full` prints the whole list.
 */
function describeSeededOwners(owners: string[], wanted: string): string {
  if (owners.length === 0) return "seeded owners: none";
  if (process.env.C64RE_GRAPH_SEED_OWNERS === "full" || owners.length <= 6) {
    return `seeded owners: ${owners.join(", ")}`;
  }
  const stem = wanted.replace(/[^a-z0-9]+/giu, "");
  const score = (candidate: string): number => {
    const other = candidate.toLowerCase().replace(/[^a-z0-9]+/giu, "");
    let shared = 0;
    while (shared < stem.length && shared < other.length && stem[shared] === other[shared]) shared += 1;
    return shared;
  };
  const near = [...owners].sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, 3);
  return `${owners.length} owners are seeded, closest by name: ${near.join(", ")} (C64RE_GRAPH_SEED_OWNERS=full lists them all)`;
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
      return { status: "absent", owner, path, reason: `${path} holds no Spec 820 rows for owner "${owner}" (${describeSeededOwners(owners, owner)}) — c64re graph seed --owner ${owner}` };
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

/**
 * Spec 867 D1 — a cross-owner address the payload's WINDOW puts outside its
 * business. It is not a refusal: nobody asked for it, and nothing was taken
 * away. It is counted and named so the reader can see what the window did.
 */
export interface CodeSeedOutOfScope {
  address: number;
  detail: string;
}

export type CodeSeedLookup =
  | {
      status: "ok";
      path: string;
      owner: string;
      space: string;
      /** Spec 867 D1 — the window this image occupies, and where that window came from. */
      window: PayloadWindow;
      seeds: CodeSeed[];
      skipped: Array<{ address: number; detail: string }>;
      outOfScope: CodeSeedOutOfScope[];
    }
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
      return { status: "absent", owner, path, reason: `${path} holds no nodes for owner "${owner}" (${describeSeededOwners(owners, owner)}) — c64re graph seed --owner ${owner}` };
    }
    const space = ctxSpaceOfId(mine[0]!.id) ?? "ram";
    const inRange = (a: number): boolean => a >= lo && a <= hi;

    // Spec 867 D1 — the load-time context. My own window is the payload record's,
    // when the project has one; without it, the range being analysed, which IS the
    // load address plus the byte length of the bytes in front of me. The extent the
    // GRAPH holds for an owner is never used for the image's own window: it is a
    // lower bound (it knows the routines it found, not the file's length) and a
    // window that is too small would silently drop an address that is in the image.
    // For every OTHER owner that lower bound is exactly right, because it is used
    // only to say "something else loads in here".
    //
    // Windows that load INSIDE mine are holes in it: what lives there is that
    // payload's business, not this one's. That is what stops a 50 KB file from
    // inheriting every routine of the engine that loads into the middle of it.
    const windows = loadWindows(db);
    const recorded = windowFor(windows, owner);
    const window: PayloadWindow = recorded && recorded.source === "payload" && recorded.space === space
      ? recorded
      : { owner, name: owner, space: space as PayloadWindow["space"], bank: null, start: lo, end: hi, source: "analysed-range" };
    const holes = innerWindows(windows, window).filter((w) => w.owner !== owner);
    const outOfScope: CodeSeedOutOfScope[] = [];

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
      const addrId = `${mine[0]!.id.split(":")[0]}:${space}:addr:${address.toString(16).padStart(4, "0")}`;
      const target = resolvesTo.get(addrId);
      const targetOwner = target ? ownerOfId(target) : undefined;
      const sites = [...byOwner.values()].reduce((sum, v) => sum + v.count, 0);
      const from = [...byOwner.entries()].map(([key, v]) => `${v.type} from "${key.split("|")[1]}"`).sort().join(", ");

      // Spec 867 D1 — the window decides first, and overlap stops meaning
      // relevance. An address outside my window is somebody else's; an address
      // inside a window that loads inside mine belongs to that payload. Neither is
      // a refusal — nothing was asked for and nothing is taken away.
      if (!covers(window, address)) {
        outOfScope.push({ address, detail: `${from}, but ${hex4(address)} is outside this payload's window ${hex4(window.start)}-${hex4(window.end)}` });
        continue;
      }
      const hole = holes.find((h) => covers(h, address));
      if (hole) {
        outOfScope.push({ address, detail: `${from}, but ${hex4(address)} is inside ${describeWindow(hole)}, which loads inside this payload's window — that stretch is its business, not this image's` });
        continue;
      }

      // The address IS in my own window. Whoever wrote the node down, the code
      // there is this payload's while this payload is loaded — a graph claim by
      // another occupant of the SAME window is a second overlay of it, not a
      // reason to refuse my own entry point (Spec 867 §2). The subtraction
      // survives only where no window is recorded for the other owner: there the
      // graph's owner claim is still the best answer anyone has.
      const theirs = targetOwner !== undefined && targetOwner !== owner ? windowFor(windows, targetOwner) : undefined;
      if (targetOwner !== undefined && targetOwner !== owner && (!theirs || theirs.space !== window.space)) {
        skipped.push({ address, detail: `${from}, but Spec 826 RESOLVES_TO ${target} — that address is owner "${targetOwner}"'s code, and this project records no window for "${targetOwner}", so the graph's owner claim still decides (Spec 838's subtraction, which a window replaces where there is one)` });
        continue;
      }
      const jumpOnly = [...byOwner.values()].every((v) => v.type === "JUMPS_TO");
      const shared = theirs
        ? `; the graph records owner "${targetOwner}"'s code at this address too — ${describeWindow(theirs)} shares this window, and inside this payload's own window the code is this payload's`
        : "";
      add(address, jumpOnly ? "cross_owner_jump" : "cross_owner_call", `${from} (${sites} site${sites === 1 ? "" : "s"})${shared}`);
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

    return {
      status: "ok",
      path,
      owner,
      space,
      window,
      seeds: [...seeds.values()].sort((l, r) => l.address - r.address),
      skipped,
      outOfScope: outOfScope.sort((l, r) => l.address - r.address),
    };
  } finally {
    db.close();
  }
}
