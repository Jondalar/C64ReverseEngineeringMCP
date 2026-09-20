#!/usr/bin/env node
// Spec 740.3 — the search sees the graph.
//
// Builds its own project in a temp directory through the product's doors — project_init,
// analyze_prg + disasm_prg with an annotations file (routines + labels), model_assert,
// doc_register, save_finding, render_docs, all over MCP stdio; the service's
// saveUserLabel for the one record kind that has no MCP door — and then asks
// project_search / project_find_related what they see. It depends on no fixture and no
// asset (no ROM, no assembler, no daemon), so it runs in CI (gates.yml).
//
// It never writes knowledge/graph.sqlite itself. The only files it writes by hand are
// the ones a person writes by hand: the PRG, the annotations file, two Markdown
// documents, a pre-2026-09-06 listing pair, and — once — an old-version cache.
//
// Exit 0 = pass, 1 = fail.   npm run smoke:740-graph
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};

console.log("Spec 740.3 — the search sees the graph\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli) || !existsSync(join(ROOT, "dist/pipeline/cli.cjs"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
const search = await import(join(ROOT, "dist/project-knowledge/project-search.js"));
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));

const proj = mkdtempSync(join(tmpdir(), "c64re-740g-"));
check(!proj.startsWith(ROOT), "the project lives outside the C64RE repo", proj);

// ── MCP stdio ────────────────────────────────────────────────────────────────
// C64RE_SLOT_GATE=0: render_docs is gated on Spec 844's slots once a project holds
// records. The slots are not what this gate is about, and filling six of them to earn
// one render would make the fixture about them.
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pend = new Map();
let nid = 1;
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const ln = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!ln) continue;
    let m;
    try { m = JSON.parse(ln); } catch { continue; }
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
proc.stderr.on("data", () => {});
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nid++;
  const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 120000);
  pend.set(id, (m) => { clearTimeout(t); res(m); });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return (r.result?.content || []).map((c) => c.text).join("\n");
};

/** project_search, parsed: the rebuild line (if any) and one entry per hit. */
const find = async (query, extra = {}) => {
  const text = await call("project_search", { query, limit: 20, ...extra });
  const rebuilt = /^index (?:rebuilt|built):[^\n]*/.exec(text)?.[0];
  const hits = [];
  for (const block of text.split(/\n(?=• \[)/)) {
    const m = /^• \[([a-z_]+)\]\s*(\$[0-9A-F]{4}(?:-\$[0-9A-F]{4})?)?\s*(.*)\n\s+(.*)\n\s+(.*?)\s+\| id=(\S+)[^\n]*\n\s+why: (.*)$/m.exec(block.trim());
    if (m) hits.push({ kind: m[1], range: m[2] ?? "", title: m[3].trim(), snippet: m[4], sourcePath: m[5].replace(/#.*$/, ""), id: m[6], why: m[7] });
  }
  return { text, rebuilt, hits };
};
const related = async (seed) => {
  const text = await call("project_find_related", { id_or_query: seed, limit: 12 });
  const groups = {};
  let current;
  for (const line of text.split("\n")) {
    const g = /^## (\S+) \(\d+\)$/.exec(line);
    if (g) { current = g[1]; groups[current] = []; continue; }
    const it = /^• \[([a-z_]+)\] (.*)$/.exec(line);
    if (it && current) groups[current].push({ kind: it[1], title: it[2] });
  }
  return { text, groups };
};

try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-740-graph", version: "1" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = new Set(((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name));
  check(["project_search", "project_find_related", "project_init", "disasm_prg", "model_assert", "doc_register", "render_docs", "save_finding"].every((t) => tools.has(t)),
    "every door this gate uses is on the default surface");

  // ── the project, through the doors ────────────────────────────────────────
  await call("project_init", { name: "smoke740graph" });
  // A session onboards before it works in a project; the server refuses otherwise.
  await call("agent_onboard", {});
  mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
  //   C000  20 10 C0   jsr tick_irq        init_engine
  //   C003  4C 03 C0   jmp *
  //   C006  EA × 10
  //   C010  A9 01      lda #$01            tick_irq
  //   C012  8D 20 D0   sta $D020
  //   C015  60         rts
  //   C016  01..08                         colour_table
  const LOAD = 0xc000;
  const bytes = [0x20, 0x10, 0xc0, 0x4c, 0x03, 0xc0, ...Array(10).fill(0xea), 0xa9, 0x01, 0x8d, 0x20, 0xd0, 0x60, 1, 2, 3, 4, 5, 6, 7, 8];
  writeFileSync(join(proj, "artifacts", "prg", "engine.prg"), Buffer.from([LOAD & 0xff, LOAD >> 8, ...bytes]));
  writeFileSync(join(proj, "artifacts", "prg", "engine_annotations.json"), JSON.stringify({
    routines: [
      { address: "C000", name: "init_engine", comment: "installs the resident engine" },
      { address: "C010", name: "tick_irq", comment: "raster tick, flashes the border" },
    ],
    labels: [{ address: "C016", label: "colour_table", comment: "border colours, one per tick" }],
    // The code segment is what gives tick_irq an extent: a routine ends where its segment
    // or the next routine does (listRoutineNodes).
    segments: [{ start: "C000", end: "C015", kind: "code" }, { start: "C016", end: "C01D", kind: "data", label: "colour_table" }],
  }, null, 2));
  await call("analyze_prg", { prg_path: "artifacts/prg/engine.prg", entry_points: ["C000"] });
  const disasm = await call("disasm_prg", { prg_path: "artifacts/prg/engine.prg", analysis_json: "artifacts/prg/engine_analysis.json" });
  check(/Graph: imported 2 routines, 1 labels/.test(disasm), "disasm_prg imports the annotation file's routines and labels into the graph",
    disasm.split("\n").find((l) => l.startsWith("Graph:")));
  const asserted = await call("model_assert", {
    name: "resident engine", level: "container", address_start: 0xc000, address_end: 0xc0ff,
    description: "the engine that stays resident while the overlays swap", evidence: ["engine.prg loads at $C000 and never moves"],
  });
  check(/container "resident engine"/.test(asserted), "model_assert states the boundary", asserted.split("\n")[0]);

  mkdirSync(join(proj, "docs", "model"), { recursive: true });
  writeFileSync(join(proj, "docs", "model", "engine.md"), [
    "---", "title: Engine overlay model", "kind: synthesis", "covers:", "  - $C000-$C0FF", "sources: [engine_disasm.asm]",
    "method: >", "  The listing decides; the binary wins where they disagree.", "status: current", "---", "",
    "# Engine overlay model", "", "The resident part never moves; the overlays are paged in above it.", "",
    "## The tick", "", "One raster tick per frame drives the border flash.", "",
  ].join("\n"));
  // Undeclared, nested: before 740.3 nothing under docs/model/ reached the index.
  writeFileSync(join(proj, "docs", "model", "overlay_notes.md"), "# Overlay notes\n\nThe zeropage swap trampoline saves $02-$0F before an overlay loads.\n");
  const registered = await call("doc_register", { path: "docs/model/engine.md" });
  check(/Registered synthesis "Engine overlay model"/.test(registered), "doc_register declares the document", registered);

  const saved = await call("save_finding", {
    kind: "observation", title: "tick handler flashes the border every frame", summary: "writes $D020 once per raster tick",
    address_range: { start: 0xc010, end: 0xc015 }, evidence: [{ kind: "note", title: "engine_disasm.asm $C010" }],
  });
  check(/Finding saved/.test(saved), "save_finding records the finding");
  // User labels: no MCP door; the service's library door, as the workspace UI uses. Saved
  // BEFORE the render: a user label is an entity too, and a render made before it would
  // already be stale on `entities` — true, and not the drift this gate sets up.
  new ProjectKnowledgeService(proj).saveUserLabel({ label: "frame_counter", address: 0xc0f0, note: "counts ticks since the last overlay swap" });
  const rendered = await call("render_docs", { scope: "findings" });
  check(/Rendered 1 doc/.test(rendered), "render_docs writes the findings render", rendered.split("\n")[0]);
  const renderText = readFileSync(join(proj, "docs", "FINDINGS.md"), "utf8");
  check(/^kind: generated$/m.test(renderText) && /^\s+findings: \d+$/m.test(renderText), "the render carries its provenance frontmatter (847 D4)");

  // ── D1: each human-layer kind is found as itself ──────────────────────────
  {
    const r = await find("init_engine");
    check(r.rebuilt?.startsWith("index built: there was no cache yet") === true, "the first search builds the index and says so", r.rebuilt);
    const routine = r.hits.find((h) => h.kind === "routine" && h.title === "init_engine");
    check(!!routine, "D1 a routine name is found as a routine", r.hits.map((h) => `${h.kind}:${h.title}`).slice(0, 4).join(", "));
    check(routine?.range === "$C000-$C00F", "…with the extent the graph derives for it", routine?.range);
    check(r.hits[0]?.kind === "routine", "…and it is the top hit", r.hits[0] && `${r.hits[0].kind}:${r.hits[0].title}`);
    check(!r.hits.some((h) => h.kind === "entity" && h.id === routine?.id), "…and not a second time as a generic entity (the entity projection withholds it)");
  }
  {
    const r = await find("colour_table");
    check(r.hits.some((h) => h.kind === "label" && h.title === "colour_table" && h.range === "$C016"), "D1 an annotation label is found as a label", r.hits.map((h) => `${h.kind}:${h.title}`).slice(0, 4).join(", "));
    const u = await find("frame_counter");
    check(u.hits.some((h) => h.kind === "label" && h.title === "frame_counter" && h.range === "$C0F0"), "D1 a user label folds into label", u.hits.map((h) => `${h.kind}:${h.title}`).slice(0, 3).join(", "));
  }
  {
    const r = await find("resident engine");
    const model = r.hits.find((h) => h.kind === "model");
    check(model?.title === "resident engine", "D1 a container name is found as a model record", r.hits.map((h) => `${h.kind}:${h.title}`).slice(0, 3).join(", "));
    check(model?.range === "$C000-$C0FF", "…at its declared range, not at $0000 (a boundary's range lives in attrs)", model?.range);
    check(r.hits[0]?.kind === "model", "…and it outranks everything else for its own name", r.hits[0]?.kind);
  }
  {
    const r = await find("Engine overlay model");
    const doc = r.hits.find((h) => h.kind === "document");
    check(doc?.title === "Engine overlay model" && doc?.sourcePath === join("docs", "model", "engine.md"), "D1 a document title is found as a document, pointing at its file", doc && `${doc.title} → ${doc.sourcePath}`);
    check(doc?.range === "$C000-$C0FF", "…with its covers as its range", doc?.range);
    // D2 — a document under docs/model/ is found, section by section, under its declared title
    const section = r.hits.find((h) => h.kind === "doc_section" && h.sourcePath === join("docs", "model", "engine.md"));
    check(!!section, "D2 a document under docs/model/ is found (its sections are indexed)", section?.title);
    check(r.hits.some((h) => h.kind === "doc_section" && h.title === "Engine overlay model — The tick"), "D2 its sections carry the declared title, not the file name");
    const nested = await find("zeropage swap trampoline");
    check(nested.hits.some((h) => h.kind === "doc_section" && h.sourcePath === join("docs", "model", "overlay_notes.md")), "D2 an undeclared document under docs/model/ is found too");
    check(!nested.rebuilt, "a search with nothing changed uses the cache and says nothing", nested.rebuilt);
  }

  // ── D6: an address reaches the container, the routine and the document ─────
  {
    const r = await find("$C000");
    const kinds = new Set(r.hits.slice(0, 6).map((h) => h.kind));
    check(kinds.has("model") && kinds.has("routine") && kinds.has("document"), "D6 an address query returns the container, the routine and the document (top 6)",
      r.hits.slice(0, 6).map((h) => `${h.kind}:${h.title}`).join(", "));
    const inside = await find("$C012");
    const got = (k) => inside.hits.find((h) => h.kind === k);
    check(!!got("model") && !!got("routine") && !!got("document"), "D6 an address INSIDE the ranges finds them too ($C012: container, routine tick_irq, document)",
      inside.hits.slice(0, 5).map((h) => `${h.kind}:${h.title}`).join(", "));
    check(got("routine")?.title === "tick_irq" && /\$C012 inside \$C010-\$C015/.test(got("routine")?.why ?? ""), "…and the why says which range holds it", got("routine")?.why);

    const rel = await related("$C000");
    check(rel.groups.model?.some((i) => i.title === "resident engine"), "D6 find_related($C000) groups the container around it", Object.keys(rel.groups).join(","));
    check(rel.groups.routines?.some((i) => i.title === "init_engine"), "D6 …the routine at it");
    check(rel.groups.documents?.some((i) => i.title === "Engine overlay model"), "D6 …and the document that declares it");
    const fromModel = await related("resident engine");
    check(["init_engine", "tick_irq"].every((n) => fromModel.groups.routines?.some((i) => i.title === n)) && fromModel.groups.labels?.some((i) => i.title === "colour_table"),
      "D6 find_related from the container lists the routines and labels inside it", JSON.stringify(fromModel.groups.routines?.map((i) => i.title)));
  }

  // ── D3: a render is a copy ──────────────────────────────────────────────────
  const findingTitle = "tick handler flashes the border every frame";
  {
    const r = await find(findingTitle);
    const live = r.hits.findIndex((h) => h.kind === "finding" && h.title === findingTitle);
    const copy = r.hits.findIndex((h) => h.sourcePath === join("docs", "FINDINGS.md"));
    check(live >= 0 && copy >= 0 && live < copy, "D3 a fresh render ranks below the live finding it copies", `finding #${live + 1}, render #${copy + 1}`);
    check(/generated render/.test(r.hits[copy]?.why ?? ""), "D3 …and its why says it is a generated render, not curated", r.hits[copy]?.why);
  }

  // ── D4: a finding saved after the last search is found by the next one ──────
  {
    await call("save_finding", {
      kind: "observation", title: "raster split at $D012 reprograms the tick", summary: "the split line moves with the overlay",
      address_range: { start: 0xc010, end: 0xc012 }, evidence: [{ kind: "note", title: "engine_disasm.asm $C010" }],
    });
    const r = await find("raster split reprograms");
    check(/^index rebuilt: the graph changed since \d{4}-\d{2}-\d{2}T/.test(r.rebuilt ?? ""), "D4 the next search says the index was rebuilt because the graph changed", r.rebuilt);
    check(r.hits.some((h) => h.kind === "finding" && h.title === "raster split at $D012 reprograms the tick"), "D4 …and finds the finding saved a moment ago");
    const again = await find("raster split reprograms");
    check(!again.rebuilt, "D4 the search after that uses the rewritten cache", again.rebuilt);
  }

  // ── D3: after another finding the render is stale, ranks below, and says why ─
  {
    await call("save_finding", {
      kind: "hypothesis", title: "overlays page in above $C100", summary: "the engine ends at $C0FF",
      address_range: { start: 0xc100, end: 0xc1ff }, evidence: [{ kind: "note", title: "docs/model/engine.md" }],
    });
    const r = await find(findingTitle);
    const live = r.hits.findIndex((h) => h.kind === "finding" && h.title === findingTitle);
    const copy = r.hits.findIndex((h) => h.sourcePath === join("docs", "FINDINGS.md"));
    check(live >= 0 && copy >= 0 && live < copy, "D3 after another finding the render still ranks below the live record", `finding #${live + 1}, render #${copy + 1}`);
    const drift = /stale render: findings: rendered (\d+), now (\d+)/.exec(r.hits[copy]?.why ?? "");
    check(!!drift && Number(drift[2]) === Number(drift[1]) + 2, "D3 its why names the drift with both numbers", r.hits[copy]?.why);
    // One comparison, two readers: the critic's proof is the same text.
    const critique = await call("project_critique", {});
    const proof = /proof:\s+(findings: rendered \d+, now \d+[^\n]*)/.exec(critique)?.[1];
    check(!!proof && (r.hits[copy]?.why ?? "").includes(proof), "D3 the critic's stale-render proof and the search's why are the same comparison", proof);
  }

  // ── D5: one listing per disassembly ─────────────────────────────────────────
  {
    const cur = join(proj, "artifacts", "prg", "engine_disasm");
    check(existsSync(`${cur}.asm`) && existsSync(`${cur}.tas`), "the renderer wrote the current pair (.asm + .tas)");
    // A project rendered before 2026-09-06: the same disassembly as .asm + .tass.
    mkdirSync(join(proj, "artifacts", "legacy"), { recursive: true });
    copyFileSync(`${cur}.asm`, join(proj, "artifacts", "legacy", "old_disasm.asm"));
    copyFileSync(`${cur}.tas`, join(proj, "artifacts", "legacy", "old_disasm.tass"));
    // A 64tass-only listing still counts.
    copyFileSync(`${cur}.tas`, join(proj, "artifacts", "legacy", "only_disasm.tas"));
    const r = await find("old_disasm", { kind: "asm_section" });
    // Two, not three: the .tass twin is not a listing the index reads, so it is not one
    // the fingerprint watches either.
    check(/^index rebuilt: 2 listings changed since/.test(r.rebuilt ?? ""), "D4 new listings are noticed and named", r.rebuilt);
    const idx = search.buildProjectSearchIndex(proj);
    const paths = new Set(idx.records.filter((x) => x.kind === "asm_section").map((x) => x.sourcePath));
    const legacy = [...paths].filter((p) => p.includes("old_disasm"));
    check(legacy.length === 1 && legacy[0].endsWith(".asm"), "D5 a legacy .asm + .tass pair is indexed once, as the .asm", legacy.join(", "));
    check(![...paths].some((p) => p.endsWith("engine_disasm.tas")) && [...paths].some((p) => p.endsWith("engine_disasm.asm")), "D5 a current .asm + .tas pair is indexed once, as the .asm");
    check([...paths].some((p) => p.endsWith("only_disasm.tas")), "D5 a .tas without an .asm is still indexed");
    check(r.hits.length > 0 && r.hits.every((h) => !h.sourcePath.endsWith(".tass")), "D5 no search hit points at the .tass twin", `${r.hits.length} hits`);
  }

  // ── D4: a document edited in place is noticed ───────────────────────────────
  {
    appendFileSync(join(proj, "docs", "model", "engine.md"), "\n## Overlay handoff\n\nThe handoff vector sits at $C0FA.\n");
    const r = await find("handoff vector");
    check(/^index rebuilt: 1 document changed since/.test(r.rebuilt ?? ""), "D4 an edited document is noticed and named", r.rebuilt);
    check(r.hits.some((h) => h.title === "Engine overlay model — Overlay handoff"), "D4 …and its new section is found");
  }

  // ── reindex, and the version bump ────────────────────────────────────────────
  {
    const re = await call("project_reindex_search", {});
    check(/Reindexed \d+ records/.test(re) && /routine: \d+/.test(re) && /model: \d+/.test(re) && /document: \d+/.test(re), "project_reindex_search counts the new kinds", re.split("\n").slice(3, 12).join(" "));
    const r = await find("init_engine");
    check(!r.rebuilt, "a search right after project_reindex_search does not rebuild (its own activity-log line is stamped)", r.rebuilt);

    check(search.PROJECT_SEARCH_INDEX_VERSION === 2, "PROJECT_SEARCH_INDEX_VERSION is 2", String(search.PROJECT_SEARCH_INDEX_VERSION));
    const cachePath = join(proj, search.CACHE_RELPATH);
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    writeFileSync(cachePath, JSON.stringify({ ...cache, version: 1 }));
    const old = await find("init_engine");
    check(/^index rebuilt: the cache was written by index version 1, this is version 2/.test(old.rebuilt ?? ""), "an old cache rebuilds on first use and says why", old.rebuilt);
    check(old.hits[0]?.kind === "routine", "…and answers from the rebuilt index");
  }
} catch (e) {
  check(false, "the MCP harness", e instanceof Error ? e.message : String(e));
} finally {
  proc.kill();
  try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log(`\n${failCount ? "RED" : "GREEN"}  smoke-740-graph: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
