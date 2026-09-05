// Spec 817 — seed resources/platform-kb.sqlite from the c64ref snapshot.
//
//   node dist/platform-kb/seed.js            → writes resources/platform-kb.sqlite
//   node dist/platform-kb/seed.js <out>      → writes elsewhere
//   node dist/platform-kb/seed.js --verify   → seeds to a scratch file, compares
//                                              CONTENT hash with the committed
//                                              store, exit 1 on drift
//
// Deterministic by construction: rows are derived from the snapshot and the
// extension table only, inserted in id order, no timestamps anywhere in the
// file, VACUUM at the end. Seeding twice yields the same rows; the gate proves
// it with a content hash rather than a byte hash so a different SQLite build on
// another machine cannot fake a drift.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultC64RefKnowledgePath,
  loadC64RefRomKnowledge,
  type C64RefKnowledgeAnnotation,
  type C64RefKnowledgeEntry,
} from "../c64ref-rom-knowledge.js";
import { EXTENSION_SOURCE, loadExtensions } from "./extensions.js";
import {
  PLATFORM_KB_DDL,
  PLATFORM_KB_SCHEMA_VERSION,
  platformKindForAddress,
  platformNodeId,
  platformRegionId,
  type PlatformNodeRow,
  type PlatformRegionRow,
  type PlatformTag,
} from "./schema.js";
import { DatabaseSync } from "./sqlite-quiet.js";

const SYMBOL = /^[A-Z][A-Z0-9_]{1,8}$/u;

// Which source names a thing when several do. Prose quality first: the
// register/memory maps, then the KERNAL API references, then the disassembly
// commentaries (whose "heading" is an instruction line, not a name).
const SOURCE_ORDER = [
  "c64io_mapc64", "c64mem_mapc64", "c64io_prg", "c64mem_prg",
  "kernal_prg", "kernal_mapc64", "kernal_pm", "kernal_ld", "kernal_sta", "kernal_fk",
  "kernal_dh", "kernal_ct", "kernal_mlr", "kernal_64intern", "kernal_128intern",
  "c64mem_64intern", "c64mem_sta", "c64mem_64er", "c64mem_jb", "c64mem_64map", "c64mem_src",
  "c64disasm_en", "c64disasm_mn", "c64disasm_cbm", "c64disasm_mm", "c64disasm_de", "c64disasm_ms", "c64disasm_sc",
];
const sourceRank = new Map(SOURCE_ORDER.map((id, index) => [id, index]));
const rank = (a: C64RefKnowledgeAnnotation) => sourceRank.get(a.sourceId) ?? SOURCE_ORDER.length;
const bySource = (a: C64RefKnowledgeAnnotation, b: C64RefKnowledgeAnnotation) => rank(a) - rank(b);

function clip(text: string | undefined, max = 600): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || null;
}

/** Majority vote over the KERNAL API references' symbol columns (CHROUT 7 : BSOUT 2). */
function apiSymbol(exact: C64RefKnowledgeAnnotation[]): string | undefined {
  const votes = new Map<string, number>();
  for (const a of exact) {
    if (a.kind !== "api" || !a.section || !SYMBOL.test(a.section)) continue;
    votes.set(a.section, (votes.get(a.section) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [symbol, count] of [...votes.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    if (count > bestCount) { best = symbol; bestCount = count; }
  }
  return best;
}

function chooseName(entry: C64RefKnowledgeEntry, exact: C64RefKnowledgeAnnotation[]): { name: string; source: string } {
  const sorted = [...exact].sort(bySource);
  const api = sorted.find((a) => a.kind === "api" && a.heading && !SYMBOL.test(a.heading));
  if (api) return { name: api.heading, source: api.sourceId };
  const map = sorted.find((a) => (a.kind === "io" || a.kind === "memory") && a.heading);
  if (map) return { name: map.heading, source: map.sourceId };
  // Internal ROM: the commentary's SECTION is the routine's name ("clear the
  // screen"); its heading is the instruction text, which is not a name.
  const disasm = sorted.find((a) => (a.kind === "code" || a.kind === "data") && a.section && !SYMBOL.test(a.section) && a.section.length > 3);
  if (disasm) return { name: disasm.section!, source: disasm.sourceId };
  const any = sorted[0];
  return { name: any?.heading || entry.primaryHeading || entry.addressHex, source: any?.sourceId ?? "c64ref" };
}

export function snapshotPresent(repoRoot: string): boolean {
  return existsSync(defaultC64RefKnowledgePath(repoRoot));
}

function buildRows(repoRoot: string): { nodes: PlatformNodeRow[]; regions: PlatformRegionRow[]; meta: Record<string, string> } {
  const knowledge = loadC64RefRomKnowledge(defaultC64RefKnowledgePath(repoRoot));
  const nodes = new Map<string, PlatformNodeRow>();
  const regions = new Map<string, PlatformRegionRow>();

  for (const entry of knowledge.entries) {
    const platform: PlatformTag = "c64";
    const exact = entry.annotations.filter((a) => a.endAddress === undefined);
    const ranges = entry.annotations.filter((a) => a.endAddress !== undefined && a.endAddress > entry.address);

    for (const r of [...ranges].sort(bySource)) {
      const id = platformRegionId(platform, entry.address, r.endAddress!);
      if (!regions.has(id)) {
        regions.set(id, { id, platform, startAddress: entry.address, endAddress: r.endAddress!, name: r.heading, source: r.sourceId });
      }
    }

    if (exact.length === 0) continue; // a pure range start: a region, not a node
    const kind = platformKindForAddress(platform, entry.address);
    const symbol = entry.symbol ?? apiSymbol(exact) ?? null;
    let { name, source } = chooseName(entry, exact);
    // A range start whose only exact entry is the symbol list ($0003 ADRAY1):
    // the prose belongs to the range, so the node borrows the range's name
    // rather than printing the symbol twice.
    if (symbol && name === symbol && ranges.length > 0) {
      const range = [...ranges].sort(bySource)[0]!;
      name = range.heading;
      source = range.sourceId;
    }
    // No prose in the committed store. The c64ref snapshot is gitignored on
    // purpose — it is typed-in book text (Mapping the C64, 64 intern, …) that
    // this repo does not redistribute. A register's NAME is a fact; its
    // paragraph is not ours to ship. `c64ref_lookup` still serves the prose
    // from the local snapshot for whoever built one.
    const id = platformNodeId(platform, kind, entry.address);
    nodes.set(id, { id, platform, kind, address: entry.address, symbol, name, description: null, source, layer: "generated", origin: "imported", confidence: "certain" });
  }

  for (const ext of loadExtensions(repoRoot)) {
    const kind = platformKindForAddress(ext.platform, ext.address);
    const id = platformNodeId(ext.platform, kind, ext.address);
    nodes.set(id, {
      id, platform: ext.platform, kind, address: ext.address,
      symbol: ext.symbol ?? null, name: ext.name, description: clip(ext.description),
      source: EXTENSION_SOURCE, layer: "generated", origin: "imported", confidence: "certain",
    });
  }

  const meta: Record<string, string> = {
    schema_version: String(PLATFORM_KB_SCHEMA_VERSION),
    seeder: "spec-817",
    source_repo: knowledge.sourceRepo,
    source_revision: knowledge.sourceRevision,
    source_files: String(knowledge.sourceFiles.length),
    c64ref_entries: String(knowledge.entryCount),
  };

  return {
    nodes: [...nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    regions: [...regions.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    meta,
  };
}

function writeStore(path: string, rows: ReturnType<typeof buildRows>): void {
  mkdirSync(dirname(path), { recursive: true });
  const scratch = `${path}.tmp`;
  if (existsSync(scratch)) unlinkSync(scratch);
  const db = new DatabaseSync(scratch);
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec(PLATFORM_KB_DDL);
    db.exec("BEGIN");
    const meta = db.prepare("INSERT INTO platform_meta (key, value) VALUES (?, ?)");
    for (const key of Object.keys(rows.meta).sort()) meta.run(key, rows.meta[key]!);
    const node = db.prepare(
      "INSERT INTO platform_node (id, platform, kind, address, symbol, name, description, source, layer, origin, confidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const n of rows.nodes) node.run(n.id, n.platform, n.kind, n.address, n.symbol, n.name, n.description, n.source, n.layer, n.origin, n.confidence);
    const region = db.prepare("INSERT INTO platform_region (id, platform, start_address, end_address, name, source) VALUES (?,?,?,?,?,?)");
    for (const r of rows.regions) region.run(r.id, r.platform, r.startAddress, r.endAddress, r.name, r.source);
    db.exec("COMMIT");
    db.exec(`PRAGMA user_version = ${PLATFORM_KB_SCHEMA_VERSION};`);
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  if (existsSync(path)) unlinkSync(path);
  renameSync(scratch, path);
}

/** Order-independent hash of every row — what "the same store" means. */
export function platformKbContentHash(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hash = createHash("sha256");
    for (const table of ["platform_meta", "platform_node", "platform_region"]) {
      const orderBy = table === "platform_meta" ? "key" : "id";
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all()) {
        hash.update(JSON.stringify(row, Object.keys(row as object).sort()));
        hash.update("\n");
      }
    }
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

export function defaultPlatformKbPath(repoRoot: string): string {
  return join(repoRoot, "resources", "platform-kb.sqlite");
}

export function seedPlatformKb(repoRoot: string, outPath = defaultPlatformKbPath(repoRoot)): { nodes: number; regions: number; path: string } {
  const rows = buildRows(repoRoot);
  writeStore(outPath, rows);
  return { nodes: rows.nodes.length, regions: rows.regions.length, path: outPath };
}

export function verifyPlatformKb(repoRoot: string, committed = defaultPlatformKbPath(repoRoot)): { ok: boolean; committedHash: string; freshHash: string; skipped?: string } {
  if (!existsSync(committed)) return { ok: false, committedHash: "(missing)", freshHash: "(not built)" };
  if (!snapshotPresent(repoRoot)) {
    return { ok: true, committedHash: platformKbContentHash(committed), freshHash: "(no snapshot)", skipped: "c64ref snapshot absent — run npm run build:c64ref to verify re-seeding" };
  }
  const scratch = `${committed}.verify`;
  try {
    seedPlatformKb(repoRoot, scratch);
    const committedHash = platformKbContentHash(committed);
    const freshHash = platformKbContentHash(scratch);
    return { ok: committedHash === freshHash, committedHash, freshHash };
  } finally {
    if (existsSync(scratch)) unlinkSync(scratch);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  if (process.argv.includes("--verify")) {
    const result = verifyPlatformKb(repoRoot);
    if (result.skipped) console.log(`platform-kb verify: SKIPPED — ${result.skipped}`);
    else console.log(`platform-kb verify: committed=${result.committedHash.slice(0, 16)} fresh=${result.freshHash.slice(0, 16)} → ${result.ok ? "IDENTICAL" : "DRIFT — run npm run build:platform-kb and commit"}`);
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const outArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
    const target = outArg ? resolve(outArg) : defaultPlatformKbPath(repoRoot);
    if (!snapshotPresent(repoRoot)) {
      // A clean checkout has the committed store and no snapshot: keep the
      // store, say so, and do not fail the build. Refreshing needs the network.
      if (existsSync(target)) {
        console.log(`platform-kb: kept committed store (c64ref snapshot absent; run npm run build:c64ref to refresh) → ${target}`);
        process.exitCode = 0;
      } else {
        console.error(`platform-kb: neither the committed store nor the c64ref snapshot exists. Run npm run build:c64ref (network) then npm run build:platform-kb.`);
        process.exitCode = 1;
      }
    } else {
      const result = seedPlatformKb(repoRoot, target);
      console.log(`platform-kb: ${result.nodes} nodes, ${result.regions} regions → ${result.path}`);
    }
  }
}
