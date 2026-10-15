#!/usr/bin/env node
// A project written by an earlier release carries names that carried an internal id: the
// parked-stores directory, the record-schema meta key, the table-edge rule id, the
// extraction manifest and its artifact role, the steering tokens. The names were
// replaced with descriptive ones. This gate proves both halves of that:
//
//   1. a project that carries the OLD names still opens and behaves — every reader
//      still finds what the old release left;
//   2. everything this release WRITES uses the NEW names, and none of the old ones.
//
// Hermetic: temp projects, hand-written legacy stores, a synthetic disk manifest.
//
// Exit 0 = pass, 1 = fail.   npm run e2e:legacy-names

import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const { GraphStore } = await load("dist/knowledge-graph/store.js");
const { ensureSchema822, RECORD_SCHEMA_KEY, LEGACY_RECORD_SCHEMA_KEY } = await load("dist/knowledge-graph/migrate/schema-822.js");
const { migrateProject, LEGACY_DIR, LEGACY_DIR_OLD } = await load("dist/knowledge-graph/migrate/migrate.js");
const { ensureCutover } = await load("dist/knowledge-graph/cutover.js");
const { ensureDefaultSteering, EXTRACT_FIRST_TOKEN, RECONCILE_TOKEN, EXTRACT_FIRST_LEGACY_TOKEN, RECONCILE_LEGACY_TOKEN } = await load("dist/server-tools/steering-defaults.js");
const { DEFAULT_PATTERNS } = await load("dist/server-tools/registration.js");
const { toolOwnerOf } = await load("dist/lib/registration-delta.js");
const { readManifestKnowledge } = await load("dist/project-knowledge/manifest-import.js");
const { buildDiskSpec784Manifest, writeDiskSpec784Manifest, EXTRACTION_MANIFEST_NAME } = await load("dist/server-tools/disk-spec784-manifest.js");

let pass = 0;
let failCount = 0;
const ok = (msg) => { pass += 1; console.log(`  PASS  ${msg}`); };
const fail = (msg) => { failCount += 1; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const head = (n, title) => console.log(`\n── ${n}. ${title}`);
const dirs = [];
const tmp = (label) => { const d = mkdtempSync(join(tmpdir(), `c64re-legacynames-${label}-`)); dirs.push(d); return d; };

const stamp = "2026-01-01T00:00:00.000Z";
const store = (items) => JSON.stringify({ schemaVersion: 1, items }, null, 2);
function project(label) {
  const dir = tmp(label);
  mkdirSync(join(dir, "knowledge"), { recursive: true });
  mkdirSync(join(dir, "session"), { recursive: true });
  writeFileSync(join(dir, "knowledge", "project.json"), JSON.stringify({ schemaVersion: 1, id: "project-ln", name: "legacy names", slug: "lnames", rootPath: dir, status: "active" }, null, 2));
  return dir;
}
const legacyStores = (where) => {
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, "entities.json"), store([{ id: "entity-hand-1", kind: "routine", name: "hand_named_entry", summary: "named by hand", addressRange: { start: 0x1000, end: 0x1010 }, artifactIds: [], tags: [], createdAt: stamp, updatedAt: stamp }]));
  writeFileSync(join(where, "findings.json"), store([]));
  writeFileSync(join(where, "relations.json"), store([]));
  writeFileSync(join(where, "open-questions.json"), store([]));
  writeFileSync(join(where, "labels.user.json"), store([]));
};
const handEntityCount = (dir) => {
  const s = GraphStore.open(dir, { readOnly: true });
  try { return s.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE name = 'hand_named_entry'").get().n; } finally { s.close(); }
};

try {
  head(1, "the parked-stores directory: old name read, new name written");
  check(LEGACY_DIR !== LEGACY_DIR_OLD && !/\d/.test(LEGACY_DIR), `the writer's directory name carries no number (${LEGACY_DIR})`);
  {
    // an earlier release parked the stores under the old name; migrating must still find them
    const dir = project("old-dir");
    legacyStores(join(dir, "knowledge", LEGACY_DIR_OLD));
    const summary = migrateProject({ projectDir: dir });
    check(summary.legacyDirFiles.length === 5, `migrate read all five stores from the old directory (${summary.legacyDirFiles.length})`);
    check(handEntityCount(dir) > 0, "…and the hand-named entity is in the graph");
  }
  {
    // a project still holding live stores is cut over: files go to the NEW name only
    const dir = project("live");
    legacyStores(join(dir, "knowledge"));
    const cut = ensureCutover(dir);
    check(cut.migrated.length === 5, "cut-over folded the five live stores");
    check(existsSync(join(dir, "knowledge", LEGACY_DIR, "entities.json")), `…parked them under knowledge/${LEGACY_DIR}/`);
    check(!existsSync(join(dir, "knowledge", LEGACY_DIR_OLD)), "…and created nothing under the old directory name");
    const readme = readFileSync(join(dir, "knowledge", LEGACY_DIR, "README.md"), "utf8");
    check(!/Spec|OQ\d|§\d|822/.test(readme), "…the README written there carries no internal id");
    const timeline = readFileSync(join(dir, "session", "timeline.jsonl"), "utf8");
    check(!/timeline-822|Spec 822/.test(timeline), "…and the timeline event carries none either");
    check(handEntityCount(dir) > 0, "…and the entity is in the graph");
  }

  head(2, "the record-schema meta key: old key accepted and replaced, new key written");
  {
    const dir = project("meta");
    let s = GraphStore.open(dir);
    ensureSchema822(s.db);
    check(s.getMeta(RECORD_SCHEMA_KEY) === "1", `a fresh graph is stamped with the new key (${RECORD_SCHEMA_KEY})`);
    check(s.getMeta(LEGACY_RECORD_SCHEMA_KEY) === undefined, "…and not with the old one");
    const ddl = s.db.prepare("SELECT group_concat(sql, char(10)) AS t FROM sqlite_schema").get().t;
    check(!/BUG-\d+|Spec \d+/.test(ddl), "…and the stored DDL carries no bug or spec id");
    // turn it into a graph an earlier release made: old key, no new key
    s.db.prepare("DELETE FROM meta WHERE key = ?").run(RECORD_SCHEMA_KEY);
    s.db.prepare("INSERT INTO meta (key, value) VALUES (?, '1')").run(LEGACY_RECORD_SCHEMA_KEY);
    s.close();
    s = GraphStore.open(dir);
    const r = ensureSchema822(s.db);
    check(r.textIndex === "fts5" || r.textIndex === "like", "an old-key graph opens and is usable");
    check(s.getMeta(RECORD_SCHEMA_KEY) === "1" && s.getMeta(LEGACY_RECORD_SCHEMA_KEY) === undefined, "…the stamp moved to the new key once, the old key is gone");
    s.close();
  }

  head(3, "the extraction manifest: old name and old role read, new name written");
  {
    const globs = DEFAULT_PATTERNS.map((p) => p.glob ?? "");
    check(globs.some((g) => g.endsWith("/extraction-manifest.json")), "the registration patterns cover the new manifest name");
    check(globs.some((g) => g.endsWith("/manifest.spec784.json")), "…and still the name older projects hold");
    check(toolOwnerOf("analysis/disk/x/extraction-manifest.json") === undefined && toolOwnerOf("analysis/disk/x/manifest.spec784.json") === undefined,
      "both names stay ordinary registrable files inside a tool-owned directory");
    check(EXTRACTION_MANIFEST_NAME === "extraction-manifest.json", "the writer's name is the descriptive one");

    const synthetic = {
      sourceImage: "/proj/inputs/g.d64", format: "d64", diskName: "G", diskId: "01",
      outputDir: "/proj/analysis/disk/g", manifestPath: "/proj/analysis/disk/g/manifest.json",
      files: [{ index: 0, origin: "kernal", name: "BOOT", type: "PRG", sizeSectors: 1, sizeBytes: 100, track: 18, sector: 1, loadAddress: 0x0801, relativePath: "01_boot.prg", md5: "a".repeat(32),
        sectorChain: [{ index: 0, track: 18, sector: 1, nextTrack: 0, nextSector: 0, bytesUsed: 100, isLast: true }] }],
    };
    const built = buildDiskSpec784Manifest(synthetic, "/proj");
    const dir = tmp("manifest");
    // an old project: the file carries the old name and the artifact the old role
    const oldPath = join(dir, "manifest.spec784.json");
    writeFileSync(oldPath, JSON.stringify(built, null, 2));
    const read = readManifestKnowledge({ id: "art-1", path: oldPath, role: "spec784-manifest", kind: "report" });
    check(read.knowledge !== undefined, "an artifact with the OLD role and OLD file name is read by the manifest importer");
    check(!/Spec|spec\d/i.test(read.schema ?? read.knowledge?.schema ?? ""), "…and the schema it reports carries no spec number");
    const newRole = readManifestKnowledge({ id: "art-2", path: oldPath, role: "extraction-manifest", kind: "report" });
    check(newRole.knowledge !== undefined, "the new role reads it too");

    // the writer: extract_disk's manifest lands under the new name, and only that
    const out = join(dir, "analysis", "disk", "g");
    mkdirSync(out, { recursive: true });
    const written = writeDiskSpec784Manifest({ ...synthetic, sourceImage: join(dir, "g.d64"), outputDir: out, manifestPath: join(out, "manifest.json") }, dir);
    check(!!written && written.path.endsWith("/extraction-manifest.json"), `extract_disk's manifest is written as extraction-manifest.json (${written?.path?.split("/").pop()})`);
    check(!readdirSync(out).some((f) => /spec784/.test(f)), "…and nothing carrying the old name is written");
  }

  head(4, "the steering tokens: old tokens recognised, new tokens written");
  {
    check(!/\d{3}/.test(EXTRACT_FIRST_TOKEN + RECONCILE_TOKEN), "the writer's tokens carry no number");
    const fresh = tmp("steer-new");
    ensureDefaultSteering(fresh);
    const steer = readFileSync(join(fresh, "knowledge", "steering.md"), "utf8");
    check(steer.includes(EXTRACT_FIRST_TOKEN) && steer.includes(RECONCILE_TOKEN), "a new project's steering carries the new tokens");
    check(!steer.includes(EXTRACT_FIRST_LEGACY_TOKEN) && !steer.includes(RECONCILE_LEGACY_TOKEN), "…and neither old token");
    check(!/Spec \d+|spec\d{3}/.test(steer), "…and its text carries no spec number");

    // an old steering file: old tokens, headings hand-removed, so only the token says it is applied
    const old = tmp("steer-old");
    mkdirSync(join(old, "knowledge"), { recursive: true });
    writeFileSync(join(old, "knowledge", "steering.md"), `# Project steering\n\n${EXTRACT_FIRST_LEGACY_TOKEN}\nmy own words about extracting\n\n${RECONCILE_LEGACY_TOKEN}\nmy own words about reconciling\n`);
    ensureDefaultSteering(old);
    const after = readFileSync(join(old, "knowledge", "steering.md"), "utf8");
    check(after.includes("my own words about extracting") && after.split(EXTRACT_FIRST_LEGACY_TOKEN).length === 2, "an old steering file keeps its block exactly once");
    check(!after.includes(EXTRACT_FIRST_TOKEN) && !after.includes(RECONCILE_TOKEN), "…and the new tokens are not appended on top of the old ones");
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${failCount ? "RED" : "GREEN"}  legacy names: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
