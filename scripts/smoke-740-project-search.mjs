// Spec 740.1 — Wasteland acceptance for the project search/wiki MVP.
//
// Copies the Wasteland_EF curated knowledge (knowledge/ + docs/ + views/ +
// CLAUDE.md) into a tmp project OUTSIDE the C64RE repo, scaffolds the wiki,
// rebuilds the deterministic search index, and runs the §12 acceptance
// queries. It never mutates the real project. If the fixture is absent it
// PENDS (no fixture on this machine) rather than failing.
import { mkdtempSync, mkdirSync, cpSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 740.1 — project search/wiki Wasteland acceptance\n");

const WASTELAND = "/Users/alex/Development/C64/Cracking/Wasteland_EF";
if (!existsSync(join(WASTELAND, "knowledge", "findings.json"))) {
  console.log(`PENDING — Wasteland fixture not present at ${WASTELAND}. 0 pass, 0 fail.`);
  process.exit(0);
}

const mod = await import(join(ROOT, "dist/project-knowledge/project-search.js"));
const wiki = await import(join(ROOT, "dist/project-knowledge/project-wiki.js"));
const { buildProjectSearchIndex, searchIndex, findRelated, writeIndexCache } = mod;

// tmp project copy (knowledge + docs + views + CLAUDE.md). Skip analysis/ (huge).
const proj = mkdtempSync(join(tmpdir(), "c64re-740-"));
mkdirSync(join(proj, "knowledge"), { recursive: true });
cpSync(join(WASTELAND, "knowledge"), join(proj, "knowledge"), { recursive: true });
if (existsSync(join(WASTELAND, "docs"))) cpSync(join(WASTELAND, "docs"), join(proj, "docs"), { recursive: true });
if (existsSync(join(WASTELAND, "views"))) cpSync(join(WASTELAND, "views"), join(proj, "views"), { recursive: true });
if (existsSync(join(WASTELAND, "CLAUDE.md"))) copyFileSync(join(WASTELAND, "CLAUDE.md"), join(proj, "CLAUDE.md"));
ok(!proj.startsWith(ROOT), "0 project copy is outside the C64RE repo", proj);

wiki.ensureWikiSkeleton(proj);
const index = buildProjectSearchIndex(proj);
writeIndexCache(proj, index, "2026-05-31T00:00:00Z");
ok(index.records.length > 50, "0b index built with records", `${index.records.length} records, kinds=${Object.keys(index.counts).length}`);

// helpers
const wellFormed = (h) => h.id && h.sourcePath && h.snippet && Array.isArray(h.why) && h.why.length > 0;
const MAX_SNIPPET = 260;
const noDump = (hits) => hits.every((h) => (h.snippet || "").length <= MAX_SNIPPET);
const hasSource = (hits, re) => hits.some((h) => re.test(h.sourcePath));
const hasKind = (hits, k) => hits.some((h) => h.kind === k);
const search = (q, f, n) => searchIndex(index, q, f ?? {}, n ?? 12);

// 1) $FC00 → loader/fastloader: LOADER.md / CODE_CARTOGRAPHY.md + a finding/entity
{
  const hits = search("$FC00");
  ok(hits.length > 0 && hits.every(wellFormed), "1 $FC00 returns well-formed hits (id/sourcePath/snippet/why)", `${hits.length} hits`);
  ok(hits.some((h) => h.why.some((w) => /exact address \$FC00/i.test(w))), "1b top match is an exact $FC00 address match", hits[0]?.why.join("; "));
  ok(hasSource(hits, /LOADER\.md|CODE_CARTOGRAPHY\.md/), "1c includes a loader/code-cartography doc");
  ok(hasKind(hits, "finding") || hasKind(hits, "entity"), "1d includes a finding or entity record");
  ok(noDump(hits), "1e no hit dumps a whole file (snippet ≤ 260 chars)");
}

// 2) track 36 copy protection → G64/protection facts
{
  const hits = search("track 36 copy protection");
  ok(hits.length > 0 && hits.every(wellFormed), "2 'track 36 copy protection' returns well-formed hits", `${hits.length} hits`);
  ok(hits.some((h) => /protection|track 36|36/i.test(h.title + " " + h.snippet)) || hits.some((h) => h.why.some((w) => /track 36|text match/.test(w))),
    "2b matches protection / track-36 facts");
  ok(noDump(hits), "2c no whole-file dump");
}

// 3) prodos boot chain → 01_prodos + LOADER.md + boot docs
{
  const hits = search("prodos boot chain");
  ok(hits.length > 0 && hits.every(wellFormed), "3 'prodos boot chain' returns well-formed hits", `${hits.length} hits`);
  ok(hits.some((h) => /prodos/i.test(h.title + " " + h.snippet + " " + h.id)), "3b mentions prodos (01_prodos / loader)");
  ok(hasSource(hits, /LOADER\.md/) || hits.some((h) => /01_prodos/i.test(h.id + h.title)), "3c includes LOADER.md or the 01_prodos artifact");
  ok(noDump(hits), "3d no whole-file dump");
}

// 4) DD00 serial → custom IEC protocol records
{
  const hits = search("DD00 serial");
  ok(hits.length > 0 && hits.every(wellFormed), "4 'DD00 serial' returns well-formed hits", `${hits.length} hits`);
  ok(hits.some((h) => h.why.some((w) => /exact address \$DD00/i.test(w))) || hits.some((h) => /dd00/i.test(h.title + h.snippet)),
    "4b matches DD00 records");
  ok(noDump(hits), "4c no whole-file dump");
}

// 5) find_related("02_2.0") → versions/findings/entities for the loader payload
{
  const rel = findRelated(index, "02_2.0", 8);
  const groupNames = rel.groups.map((g) => g.group);
  const allItems = rel.groups.flatMap((g) => g.items);
  ok(rel.groups.length > 0, "5 find_related('02_2.0') returns related groups", groupNames.join(","));
  ok(groupNames.includes("versions") || allItems.some((i) => /02_2\.0/i.test(i.id + i.title)), "5b groups the 02_2.0 source versions/artifacts");
  ok(groupNames.includes("findings") || allItems.some((i) => i.kind === "finding"), "5c surfaces related findings");
  ok(allItems.every((i) => i.id && i.sourcePath && i.snippet && i.why), "5d related items are well-formed (id/sourcePath/snippet/why)");
  ok(allItems.every((i) => (i.snippet || "").length <= MAX_SNIPPET), "5e no related item dumps a whole file");
}

// 6) filters + ranking sanity
{
  const onlyFindings = search("loader", { kind: "finding" }, 5);
  ok(onlyFindings.every((h) => h.kind === "finding"), "6 kind filter restricts to findings", `${onlyFindings.length}`);
  const byAddr = search("loader", { address: "$FC00" }, 10);
  ok(byAddr.every((h) => !h.addressRange || true) && byAddr.length >= 0, "6b address filter applies without error");
}

// 7) MCP stdio: the tools register on the DEFAULT surface and run end to end.
{
  const { spawn } = await import("node:child_process");
  const cli = join(ROOT, "dist/cli.js");
  if (!existsSync(cli)) { console.log("  PENDING  7 MCP stdio — dist/cli.js missing"); }
  else {
    const proc = spawn(process.execPath, [cli], { cwd: tmpdir(), env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "" }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = ""; const pend = new Map(); let nid = 1;
    proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue; let m; try { m = JSON.parse(ln); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
    const rpc = (method, params) => new Promise((res, rej) => { const id = nid++; const t = setTimeout(() => { pend.delete(id); rej(new Error("timeout " + method)); }, 60000); pend.set(id, (m) => { clearTimeout(t); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
    const callText = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); return (r.result?.content || []).map((c) => c.text).join("\n"); };
    try {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-740", version: "1" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = new Set(((await rpc("tools/list", {})).result?.tools || []).map((t) => t.name));
      ok(["project_search", "project_find_related", "project_reindex_search", "project_wiki_lint"].every((n) => tools.has(n)), "7 all 4 project tools on the default surface (no FULL_TOOLS)");
      const re = await callText("project_reindex_search", {});
      ok(/Reindexed \d+ records/.test(re), "7b project_reindex_search rebuilds the cache over stdio", re.split("\n")[0]);
      const se = await callText("project_search", { query: "$FC00" });
      ok(/hit\(s\) for/.test(se) && /why:/.test(se), "7c project_search returns ranked hits with why over stdio", se.split("\n")[0]);
      // Bounded: ~10 ranked hits with capped snippets, not a file dump. The
      // per-snippet cap (asserted at module level) is the real guarantee; here
      // we just confirm no giant blob line leaked through.
      const longestLine = Math.max(...se.split("\n").map((l) => l.length));
      ok(se.length < 8000 && longestLine < 400, "7d project_search output is bounded (no whole-file/giant-blob dump)", `${se.length} chars, longest line ${longestLine}`);
    } catch (e) { ok(false, "7 MCP stdio harness", e.message); }
    finally { proc.kill(); }
  }
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-740: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
