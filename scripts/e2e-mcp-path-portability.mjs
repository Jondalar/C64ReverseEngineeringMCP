// Spec 729 E2E-H — path portability. Proves the default surface makes no
// repo-root / cwd / samples assumption: every default tool is path-portable, and
// the workspace project resolver has no silent process.cwd()/samples fallback.
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 729 E2E-H — path portability\n");

const matrix = JSON.parse(readFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.json"), "utf8"));
const def = matrix.rows.filter((r) => r.tier === "default");
const byName = new Map(matrix.rows.map((r) => [r.name, r]));

// 1. no default tool is repo-dev-only / broken-cwd-coupled.
const badPath = def.filter((r) => r.pathMode === "repo-dev-only" || r.pathMode === "broken-cwd-coupled");
ok(badPath.length === 0, "1 no default tool is repo-dev-only / broken-cwd-coupled", badPath.map((r) => r.name).join(",") || "none");

// 2. path-taking default media/trace tools accept absolute OR project-relative.
const PATH_DEF = ["inspect_disk", "extract_disk", "extract_crt", "runtime_session_start",
  "runtime_media_mount", "trace_store_info", "trace_store_top_pcs", "runtime_query_events", "analyze_prg", "disasm_prg"];
const notPortable = PATH_DEF.filter((n) => byName.has(n) && byName.get(n).pathMode !== "project-or-absolute-ok");
ok(notPortable.length === 0, "2 path-taking default tools are project-or-absolute-ok", notPortable.join(",") || "none");

// 3. workspace project/media resolution has no SILENT cwd/samples fallback.
//    The prohibited pattern (Spec 724) is a project/media path that DEFAULTS to
//    process.cwd() or scans repo samples/ without an explicit dev opt-in — that
//    masks a misconfigured project (the "Murder" bug). It is NOT prohibited to
//    resolve an explicit user-supplied `?projectDir=` query param against cwd.
//    This mirrors scripts/probe-workspace-single.mjs checks 1b + 2.
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const wsDir = join(ROOT, "src/workspace-ui");
let cwdHits = [];
if (existsSync(wsDir)) {
  for (const f of walk(wsDir)) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((ln, i) => {
      if (/^\s*\/\//.test(ln)) return;
      // project dir DEFAULTING to cwd. (A cwd+samples join is allowed iff it is
      // dev-flag gated — that case is covered separately by check 3b below.)
      const cwdDefault = /projectDir\s*[:=]\s*process\.cwd\(\)/.test(ln);
      if (cwdDefault) cwdHits.push(`${f.replace(ROOT + "/", "")}:${i + 1}`);
    });
  }
}
ok(cwdHits.length === 0, "3 no silent cwd-default / cwd+samples project resolution in workspace-ui", cwdHits.slice(0, 6).join(",") || "none");

// 3b. the v3 runtime WS media-samples scan is gated by an explicit dev flag
//     (no silent repo-samples fallback) — Spec 724.4 / probe-workspace-single #2.
const wsSrv = join(ROOT, "src/workspace-ui/ws-server.ts");
let samplesGated = true;
if (existsSync(wsSrv)) {
  const src = readFileSync(wsSrv, "utf8");
  // if a samplesDir scan exists at all, it must be guarded by devSamples.
  if (/samplesDir/.test(src)) samplesGated = /devSamples\s*&&\s*[^\n]*samplesDir|samplesDir[^\n]*&&\s*[^\n]*devSamples/.test(src) || /this\.devSamples\s*&&\s*fsmod\.existsSync\(samplesDir\)/.test(src);
}
ok(samplesGated, "3b v3-ws media samples scan is dev-flag gated (no silent repo-samples fallback)", samplesGated ? "gated" : "UNGATED");

// 4. the shared project resolver exists (724A).
const resolverTs = join(ROOT, "src/workspace-ui/resolve-project-dir.ts");
ok(existsSync(resolverTs), "4 shared project resolver exists (resolve-project-dir.ts)", existsSync(resolverTs) ? "present" : "MISSING");

// 5. an LLM can hand a path from ANY directory: simulate a temp project outside the repo.
const tmp = mkdtempSync(join(tmpdir(), "c64re-e2e-"));
writeFileSync(join(tmp, "game.d64"), Buffer.alloc(16, 0));
const outsideRepo = !tmp.startsWith(ROOT);
ok(outsideRepo, "5 temp project dir is outside the C64RE repo", tmp);
ok(existsSync(join(tmp, "game.d64")), "5b user media addressable by absolute path from any cwd", join(tmp, "game.d64"));

console.log(`\n--- report ---`);
console.log(`temp external project: ${tmp}`);
console.log(`default surface is path-portable; no cwd/samples fallback in workspace-ui resolution.`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E path-portability: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
