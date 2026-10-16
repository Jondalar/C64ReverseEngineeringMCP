#!/usr/bin/env node
// A project written by an earlier release carries names that carried an internal id: the
// parked-stores directory, the record-schema meta key, the table-edge rule id, the
// extraction manifest and its artifact role, the steering tokens, the numeric producer
// ids in the graph's producer column, and the slot ids S1..S15. The names were
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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

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
const { canonicalProducer, LEGACY_PRODUCER_IDS } = await load("dist/knowledge-graph/producer-ids.js");
const { SLOTS, LEGACY_SLOT_IDS, canonicalSlotId, slotOfTag } = await load("dist/slots/schema.js");
const { slotReport } = await load("dist/slots/state.js");
const { KnowledgeRecords } = await load("dist/knowledge-graph/records.js");
const { registerSlotTools } = await load("dist/server-tools/slots.js");
const { loadContract, saveContract } = await load("dist/contract/contract.js");
const { waivePromises } = await load("dist/contract/waive.js");

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
    check(!!written && basename(written.path) === "extraction-manifest.json", `extract_disk's manifest is written as extraction-manifest.json (${written ? basename(written.path) : "nothing written"})`);
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

  head(5, "the numeric producer ids: old ids read and renamed once, new ids written");
  {
    const NEW = new Set(LEGACY_PRODUCER_IDS.values());
    check(LEGACY_PRODUCER_IDS.size === 9 && [...NEW].every((id) => /^[a-z][a-z-]+$/.test(id)), "nine producers, every new id a descriptive word");
    check(canonicalProducer("819") === "control-flow" && canonicalProducer("826r") === "signature-resolve" && canonicalProducer("909") === "cartridge" && canonicalProducer("human") === "human",
      "an old id is understood, a new or foreign one passes through");

    const dir = project("producers");
    const rowsOf = (s) => ({
      nodes: s.db.prepare("SELECT id, layer, producer FROM nodes ORDER BY id, layer").all().map((r) => `${r.id}|${r.layer}|${r.producer}`),
      edges: s.db.prepare("SELECT from_id, type, to_id, producer FROM edges ORDER BY from_id, type, to_id").all().map((r) => `${r.from_id}|${r.type}|${r.to_id}|${r.producer}`),
    });
    let s = GraphStore.open(dir);
    const slug = "lnames";
    const nid = (a) => `${slug}:ram/fix:${a === 0x1000 ? "routine" : "label"}:${a.toString(16).padStart(4, "0")}`;
    // this release writes with an old id: it is stored as the new one
    s.replaceGenerated("819", "fix", [{ id: nid(0x1000), kind: "routine", name: "a", origin: "static", confidence: "inferred" }], []);
    check(s.db.prepare("SELECT producer FROM nodes WHERE id = ?").get(nid(0x1000)).producer === "control-flow", "replaceGenerated('819') stores 'control-flow'");
    // ...now turn the file into one an earlier release left: numeric ids everywhere, no stamp
    const OLD = { "control-flow": "819", "memory-access": "820", "runtime-trace": "821", "knowledge-import": "822", signatures: "826", "signature-resolve": "826r", cartridge: "909", document: "847", "boundary-model": "845" };
    const ins = s.db.prepare("INSERT INTO nodes (id, layer, kind, space, owner, address, name, attrs, origin, confidence, producer, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const insE = s.db.prepare("INSERT INTO edges (from_id, type, to_id, layer, evidence_key, origin, confidence, producer, owner, evidence) VALUES (?,?,?,?,?,?,?,?,?,?)");
    let a = 0x2000;
    for (const [now, old] of Object.entries(OLD)) {
      if (now === "control-flow") continue;
      ins.run(nid(a), now === "document" || now === "boundary-model" ? "human" : "generated", "label", "ram", "fix", a, `n_${old}`, "{}", "static", "inferred", old, "[]");
      insE.run(nid(a), "READS", nid(0x1000), now === "document" || now === "boundary-model" ? "human" : "generated", `k${a}`, "static", "inferred", old, "fix", "{}");
      a += 0x10;
    }
    s.db.prepare("UPDATE nodes SET producer = '819' WHERE producer = 'control-flow'").run();
    s.db.prepare("UPDATE meta SET value = ? WHERE key = 'producers'").run(JSON.stringify(Object.fromEntries(Object.values(OLD).map((o) => [o, 2]))));
    s.db.prepare("DELETE FROM meta WHERE key IN ('producer_ids', 'slot_ids')").run();
    s.db.prepare("UPDATE meta SET value = '909' WHERE key = 'cart_grammar'").run();
    ensureSchema822(s.db);
    s.db.prepare("INSERT INTO claims (node_id, claim, value, layer, origin, confidence, status, validation, producer, attrs, updated_at) VALUES (?, 'role', 'x', 'generated', 'imported', 'inferred', 'active', 'unvalidated', '822', '{}', ?)").run(nid(0x1000), stamp);
    check(rowsOf(s).nodes.some((r) => r.endsWith("|819")), "fixture: the graph carries numeric producer ids and no stamp");
    s.close();

    // opened READ-ONLY (graph dump, the graph tools): renamed through the upgrade, not misread
    const ro = GraphStore.open(dir, { readOnly: true });
    const roProducers = ro.db.prepare("SELECT DISTINCT producer FROM (SELECT producer FROM nodes UNION SELECT producer FROM edges) ORDER BY producer").all().map((r) => r.producer);
    check(roProducers.every((p) => NEW.has(p)), `a read-only open sees only the new ids (${roProducers.join(",")})`);
    ro.close();

    s = GraphStore.open(dir);
    const after = rowsOf(s);
    const prod = s.db.prepare("SELECT DISTINCT producer FROM (SELECT producer FROM nodes UNION SELECT producer FROM edges) ORDER BY producer").all().map((r) => r.producer);
    check(prod.length === 9 && prod.every((p) => NEW.has(p)) , `after the open every producer column holds a new id (${prod.join(",")})`);
    check(s.db.prepare("SELECT producer FROM claims").get().producer === "knowledge-import", "…the 822 tables too");
    check(Object.keys(JSON.parse(s.getMeta("producers"))).every((k) => NEW.has(k)), "…and meta.producers names them");
    check(s.getMeta("producer_ids") === "descriptive" && s.getMeta("cart_grammar") === "cartridge-ids", "…the graph is stamped, and the old cartridge stamp is replaced");
    const dumpHash = (st, layer) => createHash("sha256").update(st.canonicalDump(layer)).digest("hex");
    const h1 = { g: dumpHash(s, "generated"), h: dumpHash(s, "human") };
    const tables1 = JSON.stringify([rowsOf(s), s.db.prepare("SELECT * FROM meta ORDER BY key").all(), s.db.prepare("SELECT * FROM claims").all()]);
    s.close();
    // a second open changes nothing
    s = GraphStore.open(dir);
    const h2 = { g: dumpHash(s, "generated"), h: dumpHash(s, "human") };
    const tables2 = JSON.stringify([rowsOf(s), s.db.prepare("SELECT * FROM meta ORDER BY key").all(), s.db.prepare("SELECT * FROM claims").all()]);
    check(h1.g === h2.g && h1.h === h2.h, "a second open leaves both layer hashes equal");
    check(tables1 === tables2, "…and every row, the meta table and the claims table byte-equal");
    s.close();
    // c64re graph dump prints only the new ids
    const dump = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "graph", "dump", "--project", dir], { encoding: "utf8" });
    check(!/"producer":"(819|820|821|822|826r?|909|847|845)"/.test(dump) && /"producer":"signature-resolve"/.test(dump), "c64re graph dump prints the descriptive ids and no number");
    const stats = execFileSync(process.execPath, [join(ROOT, "dist/cli.js"), "graph", "stats", "--project", dir], { encoding: "utf8" });
    check(!/\b(819|820|821|822|826r?|909|847|845)\b/.test(stats), "c64re graph stats shows no numeric producer id");
  }

  head(6, "the slot ids: S1..S15 accepted on every input, the descriptive id written everywhere");
  {
    const order = SLOTS.map((x) => x.id);
    check(order.length === 15 && order.every((id, i) => LEGACY_SLOT_IDS.get(`S${i + 1}`) === id), "S1..S15 map to the fifteen slots in their order");
    check(order.every((id) => /^[a-z][a-z-]+$/.test(id) && canonicalSlotId(id) === id && canonicalSlotId(id.toUpperCase()) === id), "every new id is a lowercase word and reads back as itself");
    check(canonicalSlotId("s11") === "free-ram" && canonicalSlotId("S15") === "writable-space" && canonicalSlotId("S16") === undefined && slotOfTag("slot:S3") === "boot-chain" && slotOfTag("method:run") === undefined,
      "an old id is understood in either case; S16 and a foreign tag are not slots");

    const dir = project("slots");
    // a project an earlier release left: findings tagged slot:S11, a boundary with attrs.slot, a contract and a ledger naming S-ids
    const rec = new KnowledgeRecords(dir);
    rec.saveFinding({ kind: "memory-map", title: "$C000-$CFFF free by a run", tags: ["slot:free-ram", "method:run"] });
    const g0 = GraphStore.open(dir);
    g0.db.prepare("UPDATE annotations SET tags = replace(tags, 'slot:free-ram', 'slot:S11')").run();
    g0.upsertHuman({ id: "lnames:ram:container:c000", kind: "container", space: "ram", address: 0xc000, name: "old boundary", attrs: { level: "container", slot: "S3", description: "d", tags: ["slot:S5"] } });
    g0.db.prepare("DELETE FROM meta WHERE key = 'slot_ids'").run();
    g0.close();
    writeFileSync(join(dir, "knowledge", "contract.json"), JSON.stringify({ goal: "port it to a cartridge", deliver: { slots: ["S1", "S3", "S11"] }, limits: {} }, null, 2));
    writeFileSync(join(dir, "knowledge", "contract-standing.json"), JSON.stringify({ blockers: ["slot S3 Boot chain: x"], at: stamp, promises: ["S1", "S3", "S11"], owed: ["S3"], waivers: [{ promise: "S11", by: "a", reason: "no run possible here", at: stamp, askedValue: "answered" }] }, null, 2));

    const s2 = GraphStore.open(dir);
    check(s2.db.prepare("SELECT tags FROM annotations").all().every((r) => !/slot:S\d/i.test(r.tags)) && /slot:free-ram/.test(s2.db.prepare("SELECT tags FROM annotations").get().tags), "the stored finding tag was renamed on open");
    const node = s2.db.prepare("SELECT attrs FROM nodes WHERE id = 'lnames:ram:container:c000'").get().attrs;
    check(/"slot":"boot-chain"/.test(node) && /slot:runtime-count/.test(node) && !/"S\d/.test(node), "…and a boundary's attrs.slot and tags");
    check(s2.getMeta("slot_ids") === "descriptive", "…the graph is stamped");
    const snap = JSON.stringify([s2.db.prepare("SELECT * FROM annotations ORDER BY id").all(), s2.db.prepare("SELECT id, attrs FROM nodes ORDER BY id").all()]);
    s2.close();
    const s3 = GraphStore.open(dir);
    check(snap === JSON.stringify([s3.db.prepare("SELECT * FROM annotations ORDER BY id").all(), s3.db.prepare("SELECT id, attrs FROM nodes ORDER BY id").all()]), "a second open changes nothing (annotations and nodes byte-equal)");
    s3.close();

    // the readers: an old-tag finding fills the slot; the contract and the ledger are renamed in their files
    const r1 = await slotReport(dir);
    check(r1.states.find((x) => x.slot.id === "free-ram")?.status === "filled", "a finding tagged with the old id still fills the slot");
    const c = loadContract(dir);
    check(JSON.stringify(c.contract.deliver.slots) === JSON.stringify(["context", "boot-chain", "free-ram"]), "contract.json: the owed slots are read by their new ids");
    check(JSON.parse(readFileSync(join(dir, "knowledge", "contract.json"), "utf8")).deliver.slots.join() === "context,boot-chain,free-ram", "…and the file was rewritten once");
    const standing = await load("dist/contract/standing.js");
    const wv = standing.activeWaivers(dir, [{ id: "free-ram", asks: "", askedValue: "answered", now: "", clearBy: "", blocker: "" }]);
    check(wv.length === 1 && wv[0].promise === "free-ram", "the ledger's waiver of S11 is the waiver of free-ram");
    check(!/"S\d/.test(readFileSync(join(dir, "knowledge", "contract-standing.json"), "utf8")), "…and the ledger file carries no old id");

    // the tool: slot_record takes the old id, writes the new one
    const handlers = new Map();
    registerSlotTools({ tool: (name, _d, schema, handler) => handlers.set(name, { schema: z.object(schema), handler }) }, { projectDir: () => dir });
    const rec2 = handlers.get("slot_record");
    const call = async (args) => (await rec2.handler(rec2.schema.parse(args))).content[0].text;
    const out = await call({ slot: "S10", answer: "it saves a high score table to the disk", evidence: "read from the listing at $4000-$4040" });
    check(/Recorded save-model/.test(out) && !/\bS10\b/.test(out), "slot_record slot=\"S10\" answers with save-model");
    const out2 = await call({ slot: "writable-space", method: "chains", answer: "78 spare blocks after walking every chain", evidence: "walked every chain on the medium" });
    check(/Recorded writable-space/.test(out2), "slot_record slot=\"writable-space\" works the same");
    const g1 = GraphStore.open(dir, { readOnly: true });
    const tagRows = g1.db.prepare("SELECT tags FROM annotations").all().map((r) => r.tags).join(" ");
    check(/slot:save-model/.test(tagRows) && /slot:writable-space/.test(tagRows) && !/slot:S\d/i.test(tagRows), "the stored tags carry the new ids only");
    g1.close();
    check(!/\bS(?:1[0-5]|[1-9])\b/.test(out + out2 + (await (await import(pathToFileURL(join(ROOT, "dist/slots/state.js")).href)).formatSlotReport(await slotReport(dir)))), "tool answers and the slot report never print an old id");
    // waive by the old id, in a project whose contract owes it
    saveContract(dir, { goal: "port it to a cartridge", deliver: { slots: ["S2"] }, limits: {} });
    const w = await waivePromises(dir, { promises: ["S2"], reason: "no medium registered in this fixture", by: "tester" });
    check(w.ok && w.waivers[0].promise === "medium", "waive accepts the old id and records the new one");
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n${failCount ? "RED" : "GREEN"}  legacy names: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
