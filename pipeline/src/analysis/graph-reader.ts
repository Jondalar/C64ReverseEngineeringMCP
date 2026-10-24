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
import { claimantsAt, covers, describeWindow, hex4, innerWindows, loadWindows, windowFor, type PayloadWindow } from "./payload-windows";

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
  // A reader needs a busy timeout of its own. In WAL mode the LAST connection to close
  // checkpoints and unlinks the `-wal` under an EXCLUSIVE lock, and a reader that opens
  // inside that window with nothing to wait with dies of `database is locked` — measured
  // at 4 lost reads in 1920 against 0 with a timeout, under four concurrent writers.
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const rows = db
      .prepare(
        "SELECT type, to_id, evidence FROM edges WHERE layer = 'generated' AND producer IN ('memory-access', '820') AND owner = ? AND type IN ('READS','WRITES','READS_INDIRECT','WRITES_INDIRECT') ORDER BY from_id, type, to_id, evidence_key",
      )
      .all(owner) as Array<{ type: AccessEdgeType; to_id: string; evidence: string }>;
    if (rows.length === 0) {
      const owners = (db.prepare("SELECT DISTINCT owner FROM edges WHERE producer IN ('memory-access', '820') ORDER BY owner").all() as Array<{ owner: string }>).map((r) => r.owner);
      return { status: "absent", owner, path, reason: `${path} holds no access rows for owner "${owner}" (${describeSeededOwners(owners, owner)}) — c64re graph seed --owner ${owner}` };
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
//      cross_owner_jump  `addr` node inside this image (Spec 915: from real code
//                        only, into the payload that is in the window)
//   S3 resolved_alias    a Spec 826.0 RESOLVES_TO alias pointing at a HUMAN
//                        routine/label of THIS owner (a generated one is the
//                        last run's own output and never seeds the next)
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

/**
 * Spec 915 — a cross-owner call or jump the seed reader saw and did not apply: the caller is
 * probable code, the window's resident is another payload, or nothing says which payload is in
 * the window. Said in the listing header; the edge itself stays in the graph.
 */
export interface CodeSeedNotSeeded {
  address: number;
  reason: "heuristic_caller" | "other_resident" | "not_validated";
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
      /** Spec 915 — cross-owner addresses seen and NOT seeded, with the reason. The edges stay in the graph. */
      notSeeded: CodeSeedNotSeeded[];
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
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 }); // busy timeout: see loadAccessEdges
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
      if (ctx[0] === "crt") return undefined; // crt/<cart>/<bank>: ctx[1] is the cartridge, not an owner
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

    // S2 — another overlay calls or jumps into this image (Spec 915).
    //
    // A cross-owner seed applies only when (1) the call site is real code — an edge that a
    // probable-code render wrote (confidence `heuristic`, provenance `probable_code`) is recorded
    // and never seeds — and (2) this payload is the one in the window when that call runs:
    // a runtime run names it (an edge whose target `addr` node is keyed by the resident payload,
    // `ram/<owner>:addr:…`), or the window has exactly one claimant. Several claimants and no
    // validated edge: not seeded, and the header names them.
    interface Site { type: string; from: string; real: boolean; runtime: boolean; toOwner: string | undefined; count: number }
    const byAddress = new Map<number, Site[]>();
    for (const row of db
      .prepare(
        "SELECT type, to_id, from_id, owner, origin, confidence, json_extract(evidence, '$.provenance') AS provenance, COUNT(*) AS sites FROM edges WHERE type IN ('CALLS','JUMPS_TO') AND to_id LIKE '%:addr:%' GROUP BY type, to_id, from_id, owner, origin, confidence, provenance ORDER BY to_id",
      )
      .all() as Array<{ type: string; to_id: string; from_id: string; owner: string | null; origin: string; confidence: string; provenance: string | null; sites: number }>) {
      const a = addressOfId(row.to_id);
      if (!a || a.kind !== "addr" || !inRange(a.address)) continue;
      if (ctxSpaceOfId(row.to_id) !== space) continue;
      const runtime = row.origin === "runtime";
      // A runtime edge's `owner` column is the run; its caller is the owner in the from id (none for an addr node).
      const from = (runtime ? ownerOfId(row.from_id) ?? "" : row.owner ?? "").toLowerCase();
      if (!runtime && from === "") continue;
      if (from === owner) continue; // an edge of my own never crosses an overlay boundary
      const toOwner = ownerOfId(row.to_id)?.toLowerCase();
      const real = row.confidence !== "heuristic" && row.provenance !== "probable_code";
      let sites = byAddress.get(a.address);
      if (!sites) { sites = []; byAddress.set(a.address, sites); }
      const label = from === "" ? "a traced run" : from;
      const seen = sites.find((x) => x.type === row.type && x.from === label && x.real === real && x.runtime === runtime && x.toOwner === toOwner);
      if (seen) seen.count += Number(row.sites);
      else sites.push({ type: row.type, from: label, real, runtime, toOwner, count: Number(row.sites) });
    }
    const skipped: Array<{ address: number; detail: string }> = [];
    const notSeeded: CodeSeedNotSeeded[] = [];
    // The claimants of a window address: every recorded window covering it, plus mine when the project
    // records none for me (the range being analysed stands in).
    const allWindows = windows.some((w) => w.owner === owner && w.space === window.space) ? windows : [...windows, window];
    for (const [address, sites] of [...byAddress.entries()].sort((l, r) => l[0] - r[0])) {
      const addrId = `${mine[0]!.id.split(":")[0]}:${space}:addr:${address.toString(16).padStart(4, "0")}`;
      const target = resolvesTo.get(addrId);
      const targetOwner = target ? ownerOfId(target) : undefined;
      const from = [...new Set(sites.map((v) => `${v.type} from "${v.from}"`))].sort().join(", ");

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

      // Spec 915 D3 — a runtime run that saw which payload was in the window said so on the edge:
      // exactly those owners are seeded. The run decides; the claimants are not consulted.
      const validated = [...new Set(sites.filter((v) => v.runtime && v.toOwner !== undefined).map((v) => v.toOwner!))].sort();
      let using: Site[];
      let how: string;
      if (validated.length > 0) {
        if (!validated.includes(owner)) {
          notSeeded.push({ address, reason: "other_resident", detail: `${from}, but a traced run saw ${validated.join(" / ")} resident at ${hex4(address)}, not this payload` });
          continue;
        }
        using = sites.filter((v) => v.runtime && v.toOwner === owner);
        how = `; a traced run saw this payload resident here${validated.length > 1 ? ` (the set: ${validated.join(" / ")})` : ""}`;
      } else {
        // Spec 915 D1 — only real code seeds across an owner.
        const real = sites.filter((v) => v.real);
        if (real.length === 0) {
          notSeeded.push({ address, reason: "heuristic_caller", detail: `${from} — probable code, never a seed across an owner (confirm the caller to make it one)` });
          continue;
        }
        // Spec 915 D3, static edges only: one claimant of the window is the trivial yes.
        const claimants = claimantsAt(allWindows, { address, space: window.space as PayloadWindow["space"], bank: window.bank }).claimants.map((w) => w.owner);
        if (!claimants.includes(owner)) claimants.push(owner);
        if (claimants.length > 1) {
          notSeeded.push({ address, reason: "not_validated", detail: `${hex4(address)}: target not validated, claimants ${claimants.sort().join(" / ")} (${from}); a traced run that sees one of them resident decides it` });
          continue;
        }
        using = real;
        how = "";
      }

      // The graph's own owner claim still subtracts where no window is recorded for the other owner (Spec 838).
      const theirs = targetOwner !== undefined && targetOwner !== owner ? windowFor(windows, targetOwner) : undefined;
      if (targetOwner !== undefined && targetOwner !== owner && (!theirs || theirs.space !== window.space)) {
        skipped.push({ address, detail: `${from}, but RESOLVES_TO ${target} — that address is owner "${targetOwner}"'s code, and this project records no window for "${targetOwner}", so the graph's owner claim still decides (the seed subtraction, which a window replaces where there is one)` });
        continue;
      }
      const jumpOnly = using.every((v) => v.type === "JUMPS_TO");
      const useTotal = using.reduce((sum, v) => sum + v.count, 0);
      const useFrom = [...new Set(using.map((v) => `${v.type} from "${v.from}"`))].sort().join(", ");
      add(address, jumpOnly ? "cross_owner_jump" : "cross_owner_call", `${useFrom} (${useTotal} site${useTotal === 1 ? "" : "s"})${how}`);
    }

    // S3 — a Spec 826 alias that already points at something of mine a human put there.
    // A generated routine or label of mine is the last analysis's own output (a heuristic decode, a
    // fallback entry): seeding from it feeds the run its own previous guess, and a wrong one then
    // pins itself in place — it decodes across the real entry, which is refused as inside an instruction.
    const humanTarget = db.prepare("SELECT 1 FROM nodes WHERE id = ? AND layer = 'human'");
    for (const [addrId, target] of resolvesTo) {
      if (ctxSpaceOfId(addrId) !== space) continue;
      const a = addressOfId(addrId);
      if (!a || a.kind !== "addr" || !inRange(a.address)) continue;
      if (ownerOfId(target) !== owner) continue;
      const kind = target.split(":")[2] ?? "?";
      if (kind !== "routine" && kind !== "label") continue;
      if (humanTarget.get(target) === undefined) continue;
      add(a.address, "resolved_alias", `RESOLVES_TO ${target}`);
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
      notSeeded: notSeeded.sort((l, r) => l.address - r.address),
    };
  } finally {
    db.close();
  }
}
