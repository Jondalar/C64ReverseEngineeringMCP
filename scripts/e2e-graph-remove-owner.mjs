#!/usr/bin/env node
// graph_remove_owner + the disasm preview — a scratch render can be dropped, and need not land.
//
//   1  without an owner the door lists the owners; an unknown owner is refused with the list
//   2  dry_run deletes nothing (the whole graph dumps identically) and counts exactly what
//      the real run then deletes
//   3  after the removal no row carries the owner: no node, edge, prose, ledger entry or
//      import marker
//   4  rows written through a door survive untouched — a finding, an entity, a question, a
//      human edge, and a door rename of a node the removed file had imported
//   5  another owner's rows survive untouched, and so does the `addr` node both referenced;
//      an `addr` node only the removed owner referenced is gone
//   6  a full `graph seed` does not bring the removed owner back
//   7  a later disasm of the same stem imports fresh, not "unchanged since the last import"
//   8  disasm / disasm_prg with import_graph=false leave the graph byte-for-byte unchanged
//
// One MCP session over stdio against a temp project; synthetic PRGs, no media, no
// runtime. KickAssembler is not needed — the rebuild verdict is not what is tested.
// Exit 0 = pass, 1 = fail.   npm run e2e:graph-remove-owner

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cli = join(ROOT, "dist/cli.js");

let pass = 0;
let fail = 0;
const check = (ok, what, detail) => {
  if (ok) { pass += 1; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); }
};

console.log("graph_remove_owner + disasm preview\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-remove-owner-"));
process.on("exit", () => { try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp */ } });

// ── the session ─────────────────────────────────────────────────────────────
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_SLOT_GATE: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pend = new Map();
let nextId = 1;
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!ln) continue;
    let m; try { m = JSON.parse(ln); } catch { continue; }
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
proc.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((res, rej) => {
  const i = nextId++;
  const t = setTimeout(() => { pend.delete(i); rej(new Error(`timeout ${method}`)); }, 180000);
  pend.set(i, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`);
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return `ERROR ${JSON.stringify(r.error)}`;
  return (r.result?.content ?? []).map((c) => c.text).join("\n");
};
const jsonBlock = (text) => { const m = /```json\n([\s\S]*?)\n```/u.exec(text); return m ? JSON.parse(m[1]) : undefined; };

// ── the graph, read directly ────────────────────────────────────────────────
const graphFile = join(proj, "knowledge", "graph.sqlite");
const q = (sql, ...a) => { const d = new DatabaseSync(graphFile, { readOnly: true }); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const n = (sql, ...a) => Number(q(sql, ...a)[0].n);
/** Every row of every table (FTS internals aside), ordered by all columns — the graph's content, not its file bytes. */
function fullDump() {
  const tables = q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'annotations_fts%' ORDER BY name").map((r) => r.name);
  return tables.map((t) => {
    const cols = q(`PRAGMA table_info(${t})`).map((c) => c.name);
    return `# ${t}\n${q(`SELECT * FROM ${t} ORDER BY ${cols.map((c) => `"${c}"`).join(", ")}`).map((r) => JSON.stringify(r)).join("\n")}`;
  }).join("\n");
}
const doorRows = () => JSON.stringify([
  q("SELECT * FROM nodes WHERE layer = 'human' AND (producer = 'human' OR json_extract(attrs, '$.source_path') IS NULL) ORDER BY id"),
  q("SELECT * FROM edges WHERE layer = 'human' AND producer = 'human' ORDER BY from_id, type, to_id, evidence_key"),
  q("SELECT id, node_id, kind, title, body, name, tags, source_path, layer, producer, attrs, status FROM annotations WHERE producer = 'human' OR source_path IS NULL ORDER BY id"),
  q("SELECT * FROM questions WHERE layer = 'human' ORDER BY id"),
  q("SELECT * FROM claims WHERE layer = 'human' ORDER BY node_id, claim"),
  q("SELECT * FROM evidence WHERE producer = 'human' ORDER BY target_table, target_key, legacy_id"),
]);
const ownerRows = (owner, file) => JSON.stringify([
  q("SELECT * FROM nodes WHERE owner = ? OR run_owner = ? ORDER BY id, layer", owner, owner),
  q("SELECT * FROM edges WHERE owner = ? ORDER BY from_id, type, to_id, layer, evidence_key", owner),
  q("SELECT id, node_id, kind, title, body, name, source_path, layer, producer FROM annotations WHERE source_path LIKE ? ORDER BY id", `%${file}`),
]);

// ── the project ─────────────────────────────────────────────────────────────
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "remove-owner", version: "1" } });
await call("project_init", { project_dir: proj, name: "remove-owner" });
await call("agent_onboard", { project_dir: proj });

const dir = join(proj, "artifacts", "prg");
mkdirSync(dir, { recursive: true });
const prg = (load, bytes) => Buffer.concat([Buffer.from([load & 0xff, load >> 8]), Buffer.from(bytes)]);
// keep @ $1000: jsr $1020 ; jsr $3000 ; rts … $1020: lda #1 ; sta $D020 ; rts
const keep = new Array(0x30).fill(0xea);
keep.splice(0, 7, 0x20, 0x20, 0x10, 0x20, 0x00, 0x30, 0x60);
keep.splice(0x20, 6, 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60);
// draft1 @ $2000: jsr $2010 ; jsr $3000 ; jsr $4000 ; rts … $2010: lda #2 ; sta $D021 ; rts
const draft = new Array(0x20).fill(0xea);
draft.splice(0, 10, 0x20, 0x10, 0x20, 0x20, 0x00, 0x30, 0x20, 0x00, 0x40, 0x60);
draft.splice(0x10, 6, 0xa9, 0x02, 0x8d, 0x21, 0xd0, 0x60);
writeFileSync(join(dir, "keep.prg"), prg(0x1000, keep));
writeFileSync(join(dir, "draft1.prg"), prg(0x2000, draft));
writeFileSync(join(dir, "keep_annotations.json"), JSON.stringify({
  routines: [{ address: "1000", name: "k_main" }, { address: "1020", name: "k_border", comment: "sets the border" }],
  labels: [{ address: "1003", label: "k_call", comment: "the shared call" }],
  segments: [{ start: "1000", end: "1025", kind: "code", label: "k_code", comment: "keep code" }],
}));
writeFileSync(join(dir, "draft1_annotations.json"), JSON.stringify({
  routines: [{ address: "2000", name: "d_main", comment: "draft entry" }, { address: "2010", name: "d_bg" }],
  labels: [{ address: "2006", label: "d_far", comment: "the far call" }],
  segments: [{ start: "2000", end: "2015", kind: "code", label: "d_code", comment: "draft code" }],
}));

for (const stem of ["keep", "draft1"]) {
  await call("analyze_prg", { project_dir: proj, prg_path: `artifacts/prg/${stem}.prg` });
  const out = await call("disasm_prg", { project_dir: proj, prg_path: `artifacts/prg/${stem}.prg` });
  check(/Graph: imported/u.test(out), `${stem}: disasm imported its annotations`, out.split("\n").find((l) => l.startsWith("Graph:")));
}
check(n("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'generated' AND run_owner = 'draft1'") > 0, "draft1 has generated rows (the analysis seeded it)");
check(n("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human' AND owner = 'draft1' AND producer = '822'") > 0, "draft1 has imported human rows (its annotations file)");
const sharedAddr = q("SELECT id FROM nodes WHERE layer = 'generated' AND kind = 'addr' AND address = 12288")[0]?.id;
const draftOnlyAddr = q("SELECT id FROM nodes WHERE layer = 'generated' AND kind = 'addr' AND address = 16384")[0]?.id;
check(sharedAddr !== undefined && n("SELECT COUNT(*) AS n FROM edges WHERE to_id = ? AND owner = 'keep'", sharedAddr) > 0 && n("SELECT COUNT(*) AS n FROM edges WHERE to_id = ? AND owner = 'draft1'", sharedAddr) > 0,
  "$3000 is one addr node both owners reference", sharedAddr);
check(draftOnlyAddr !== undefined, "$4000 is an addr node only draft1 references", draftOnlyAddr);

// ── rows written through doors, several of them ON draft1 ───────────────────
await call("save_finding", { project_dir: proj, kind: "observation", title: "draft1 entry clears the background", summary: "read from the listing", confidence: 0.9, address_range: { start: 0x2010, end: 0x2015 } });
await call("save_entity", { project_dir: proj, kind: "routine", name: "door_named_thing", summary: "an entity saved by hand", address_start: 0x2000, address_end: 0x2009 });
await call("save_open_question", { project_dir: proj, kind: "other", title: "why does draft1 call $4000?", description: "open" });
const dMain = q("SELECT id FROM nodes WHERE layer = 'human' AND owner = 'draft1' AND kind = 'routine' AND address = 8192")[0]?.id;
const dBg = q("SELECT id FROM nodes WHERE layer = 'human' AND owner = 'draft1' AND kind = 'routine' AND address = 8208")[0]?.id;
const kMain = q("SELECT id FROM nodes WHERE layer = 'human' AND owner = 'keep' AND kind = 'routine' AND address = 4096")[0]?.id;
execFileSync(process.execPath, [cli, "graph", "name", dMain, "draft_entry_by_hand", "--project", proj], { stdio: "ignore" });
// a human edge onto a node the removal takes away entirely — it must stay, dangling
execFileSync(process.execPath, [cli, "graph", "link", kMain, "CALLS", dBg, "--project", proj], { stdio: "ignore" });
check(q("SELECT producer FROM nodes WHERE id = ? AND layer = 'human'", dMain)[0]?.producer === "human", "the door rename took over draft1's imported routine (producer human)", dMain);
check(n("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human' AND producer = 'human'") >= 2 && n("SELECT COUNT(*) AS n FROM questions WHERE layer = 'human'") >= 1, "door rows exist: human nodes, a question");

const doorBefore = doorRows();
const keepBefore = ownerRows("keep", "keep_annotations.json");

// ── 1 the list, and a refusal ───────────────────────────────────────────────
const listed = await call("graph_remove_owner", { project_dir: proj });
const owners = jsonBlock(listed)?.owners ?? [];
check(owners.some((o) => o.owner === "draft1" && o.generatedNodes > 0 && o.importedHumanNodes > 0) && owners.some((o) => o.owner === "keep"),
  "no owner → the owners, with their counts", owners.map((o) => o.owner).join(","));
const before0 = fullDump();
const refused = await call("graph_remove_owner", { project_dir: proj, owner: "nope" });
check(/Refused: no owner "nope"/u.test(refused) && /draft1/u.test(refused) && /keep/u.test(refused), "an unknown owner is refused and the owners are listed");
check(fullDump() === before0, "…and the refusal changed nothing");

// ── 2 dry run == real run ───────────────────────────────────────────────────
const dry = jsonBlock(await call("graph_remove_owner", { project_dir: proj, owner: "draft1", dry_run: true }));
check(fullDump() === before0, "dry_run deleted nothing (whole graph dumps identically)");
check(dry?.dryRun === true && dry.total > 0 && (dry.removed.nodes["generated/819"] ?? 0) > 0 && (dry.removed.nodes["human/822"] ?? 0) > 0,
  "dry_run counts generated and imported human rows", JSON.stringify(dry?.removed.nodes));
const realText = await call("graph_remove_owner", { project_dir: proj, owner: "draft1" });
const real = jsonBlock(realText);
const strip = (r) => JSON.stringify({ ...r, dryRun: undefined, ms: undefined, resolve: r?.resolve ? { ...r.resolve, ms: undefined } : undefined });
check(real?.dryRun === false && strip(real) === strip(dry), "the real run removed exactly what dry_run counted", `${real?.total} rows`);
check(real?.kept.humanEdges >= 1, "the door's edge onto a removed node is kept and reported", `kept ${JSON.stringify(real?.kept)}`);

// ── 3 nothing carries the owner ─────────────────────────────────────────────
check(n("SELECT COUNT(*) AS n FROM nodes WHERE (owner = 'draft1' OR run_owner = 'draft1') AND producer <> 'human'") === 0, "no node the owner's runs or file wrote remains");
check(n("SELECT COUNT(*) AS n FROM edges WHERE owner = 'draft1'") === 0, "no edge carries the owner");
check(n("SELECT COUNT(*) AS n FROM annotations WHERE source_path LIKE '%draft1_annotations.json'") === 0, "no prose from the owner's annotations file");
check(n("SELECT COUNT(*) AS n FROM nodes WHERE json_extract(attrs, '$.source_path') LIKE '%draft1_annotations.json'") === 0, "no node from the owner's annotations file");
check(n("SELECT COUNT(*) AS n FROM migration_log WHERE legacy_store = 'annotations:draft1'") === 0, "the owner's import ledger is gone");
check(n("SELECT COUNT(*) AS n FROM meta WHERE key = 'annotations_imported.draft1'") === 0, "the owner's import marker is gone");
check(n("SELECT COUNT(*) AS n FROM migration_runs WHERE source_hash = 'remove-owner:draft1'") === 1, "the removal is recorded in the graph's write ledger");

// ── 4 door rows untouched ───────────────────────────────────────────────────
check(doorRows() === doorBefore, "every door-written row is byte-identical (finding, entity, question, human edge, the rename)");
check(q("SELECT name FROM nodes WHERE id = ? AND layer = 'human'", dMain)[0]?.name === "draft_entry_by_hand", "the door rename on draft1's address survived");

// ── 5 the other owner, and the shared address ───────────────────────────────
check(ownerRows("keep", "keep_annotations.json") === keepBefore, "keep's rows are byte-identical");
check(n("SELECT COUNT(*) AS n FROM nodes WHERE id = ? AND layer = 'generated'", sharedAddr) === 1, "the addr node keep still references survived", sharedAddr);
check(n("SELECT COUNT(*) AS n FROM nodes WHERE id = ? AND layer = 'generated'", draftOnlyAddr) === 0, "the addr node only draft1 referenced is gone", draftOnlyAddr);
check(!(jsonBlock(await call("graph_remove_owner", { project_dir: proj }))?.owners ?? []).some((o) => o.owner === "draft1"), "the list no longer names draft1");

// ── 6 a full seed does not bring it back ────────────────────────────────────
const seedOut = execFileSync(process.execPath, [cli, "graph", "seed", "--project", proj], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
check(/removed with graph remove-owner[^\n]*draft1/u.test(seedOut), "a full graph seed skips the removed owner and says so");
check(n("SELECT COUNT(*) AS n FROM nodes WHERE run_owner = 'draft1'") === 0 && n("SELECT COUNT(*) AS n FROM edges WHERE owner = 'draft1'") === 0, "…and seeds nothing for it");

// ── 7 a later disasm imports fresh ──────────────────────────────────────────
const again = await call("disasm_prg", { project_dir: proj, prg_path: "artifacts/prg/draft1.prg" });
check(/Graph: imported 2 routines, 1 labels, 1 segments/u.test(again), "a later disasm of the same stem imports fresh", again.split("\n").find((l) => l.startsWith("Graph:")));
check(n("SELECT COUNT(*) AS n FROM nodes WHERE layer = 'human' AND producer = '822' AND owner = 'draft1'") > 0, "draft1's imported rows are back");
check(n("SELECT COUNT(*) AS n FROM meta WHERE key = 'owner_removed.draft1'") === 0, "importing it by name cleared the removal marker");

// ── 8 the preview leaves the graph alone ────────────────────────────────────
writeFileSync(join(dir, "keep_annotations.json"), JSON.stringify({
  routines: [{ address: "1000", name: "k_main_v2" }, { address: "1020", name: "k_border" }],
  labels: [], segments: [{ start: "1000", end: "1025", kind: "code", label: "k_code" }],
}));
const beforePreview = fullDump();
const preview = await call("disasm_prg", { project_dir: proj, prg_path: "artifacts/prg/keep.prg", platform: "c64", import_graph: false });
check(/Graph: NOT imported — import_graph=false/u.test(preview), "disasm_prg import_graph=false says it did not import");
check(/k_main_v2/u.test(preview) || /Output: /u.test(preview), "…and still rendered the listing");
check(fullDump() === beforePreview, "disasm_prg preview: the graph is byte-for-byte unchanged");
const preview2 = await call("disasm", { project_dir: proj, path: "artifacts/prg/keep.prg", import_graph: false });
check(/Graph: NOT imported/u.test(preview2) && fullDump() === beforePreview, "disasm preview: the graph is byte-for-byte unchanged");
const imported = await call("disasm_prg", { project_dir: proj, prg_path: "artifacts/prg/keep.prg" });
check(/Graph: imported/u.test(imported) && fullDump() !== beforePreview, "control: the same render without the preview flag does import");

proc.kill();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
