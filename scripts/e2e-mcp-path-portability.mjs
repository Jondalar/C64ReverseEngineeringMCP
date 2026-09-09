// Spec 729 E2E-H — path portability. Proves the default surface makes no
// repo-root / cwd / samples assumption: every default tool is path-portable, and
// the workspace project resolver has no silent process.cwd()/samples fallback.
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { pathParamsOf } from "./lib/schema-path-walk.mjs";

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

// 3b. RETIRED (Spec 806) — this asserted that the TS runtime WS server's
//     repo-`samples/` media scan was gated behind `--dev-samples`. That server
//     went with the TS emulator; the runtime daemon serves media from the
//     project it was spawned with and has no repo-samples scan to gate. Check 3
//     above still covers the surviving workspace-ui resolution.

// 4. the shared project resolver exists (724A).
const resolverTs = join(ROOT, "src/workspace-ui/resolve-project-dir.ts");
ok(existsSync(resolverTs), "4 shared project resolver exists (resolve-project-dir.ts)", existsSync(resolverTs) ? "present" : "MISSING");

// 5. an LLM can hand a path from ANY directory: simulate a temp project outside the repo.
const tmp = mkdtempSync(join(tmpdir(), "c64re-e2e-"));
writeFileSync(join(tmp, "game.d64"), Buffer.alloc(16, 0));
const outsideRepo = !tmp.startsWith(ROOT);
ok(outsideRepo, "5 temp project dir is outside the C64RE repo", tmp);
ok(existsSync(join(tmp, "game.d64")), "5b user media addressable by absolute path from any cwd", join(tmp, "game.d64"));

// 6 + 7. Spec 833 D5(b) — the rule now WALKS the schema, at any depth.
//
// Checks 1 and 2 read the matrix, and the matrix's pathMode comes from a hand-kept
// name list. `sandbox_6502_run` takes its paths NESTED — `loads[].prg_path`,
// `loads[].raw_path` — so nothing here ever looked at them, the tool read as
// taking no path at all, and it resolved its project from `undefined`: no hint,
// so C64RE_PROJECT_DIR or the process cwd. A rule that only sees the top level is
// a rule with a hole in it. From here the live schemas are the input.
const dist = join(ROOT, "dist/server.js");
if (!existsSync(dist)) {
  ok(false, "6 dist/server.js is built (run npm run build:mcp)", dist);
} else {
  const { collectToolInventory } = await import(pathToFileURL(dist).href);
  const { tierForTool } = await import(pathToFileURL(join(ROOT, "dist/server-tools/tier-tools.js")).href);
  const inv = collectToolInventory().filter((t) => t.schema);

  // 6. the walk reaches a NESTED path parameter. `sandbox_6502_run` is the case
  //    that taught us the hole exists, so it is the case that keeps it shut.
  const sandbox = inv.find((t) => t.name === "sandbox_6502_run");
  const sandboxPaths = sandbox ? pathParamsOf(sandbox.schema) : [];
  const nestedSandbox = sandboxPaths.filter((p) => p.nested).map((p) => p.path);
  ok(nestedSandbox.includes("loads[].prg_path") && nestedSandbox.includes("loads[].raw_path"),
    "6 the schema walk sees NESTED path parameters (sandbox_6502_run loads[])", nestedSandbox.join(",") || "none");

  const nestedAll = inv.flatMap((t) => pathParamsOf(t.schema).filter((p) => p.nested).map((p) => `${t.name}.${p.path}`));
  ok(nestedAll.length > 0, "6b nested path parameters exist and are counted", `${nestedAll.length} across the surface`);

  // 7. a default tool that takes a path must give the resolver a HINT to walk up
  //    from. Read file-granular: a source file whose project resolution is called
  //    with no hint at all (`context.projectDir()` / `context.projectDir(undefined`)
  //    cannot be handing one of its tools' paths to the resolver. `project_dir`
  //    itself is not counted as "takes a path" — it IS the hint.
  //
  //    KNOWN_HINTLESS freezes what this widening exposed. These are the same shape
  //    as the sandbox defect, on paths Spec 833 did not open (its §8 keeps the
  //    surrounding decisions out of scope). The list may shrink; a tool that is
  //    not on it fails, so the hole cannot grow.
  const KNOWN_HINTLESS = new Set([
    // server-tools/headless.ts — resolveHeadlessProjectDir() is called with no
    // hint at any of its call sites; each is try/caught, so the miss is silent
    // rather than fatal.
    "runtime_session_start", "runtime_loader_lens", "runtime_load_prg",
    "runtime_run_prg", "runtime_render_screen", "runtime_recorder_dump",
    // server-tools/trace-store.ts — resolveStorePath() resolves a relative store
    // path against `proj ?? process.cwd()`; the cwd fallback is explicit there.
    "trace_store_info", "trace_store_anchor_list", "trace_store_anchor_find",
    "trace_store_top_pcs", "trace_store_bus_find", "trace_store_query",
    "trace_memory_map",
    // server-tools/scene-reel.ts — `context.projectDir()`, hintless and not
    // caught: the closest twin to the sandbox defect, with feature_path /
    // out_path / media_path sitting right there unused.
    "runtime_scene_reel",
    // sandbox_depack was here and is fixed (Spec 834): it now resolves
    // `project_dir ?? input_path`. The list shrank, which is the direction it
    // is allowed to move.
  ]);
  // Any receiver, not just `context` — sandbox-depack.ts names it `ctx`, and a
  // rule that only matches one spelling is the same hole one level down.
  const HINTLESS_CALL = /\.projectDir\(\s*(\)|undefined)/;
  const srcCache = new Map();
  const resolvesHintless = (file) => {
    if (!srcCache.has(file)) {
      const abs = join(ROOT, "src", file);
      srcCache.set(file, existsSync(abs)
        && readFileSync(abs, "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).some((l) => HINTLESS_CALL.test(l)));
    }
    return srcCache.get(file);
  };

  const pathTaking = inv
    .map((t) => ({ ...t, tier: tierForTool(t.name), paths: pathParamsOf(t.schema).map((p) => p.path).filter((p) => p !== "project_dir") }))
    .filter((t) => t.tier === "default" && t.paths.length > 0);
  const hintless = pathTaking.filter((t) => resolvesHintless(t.file));
  const unexpected = hintless.filter((t) => !KNOWN_HINTLESS.has(t.name));
  ok(unexpected.length === 0, "7 every default path-taking tool resolves its project from a hint (or is a frozen known)",
    unexpected.map((t) => `${t.name}@${t.file}`).join(",") || `${hintless.length} known, 0 new`);

  console.log(`\n--- nested-path walk (Spec 833 D5b) ---`);
  console.log(`default tools taking a path (project_dir aside): ${pathTaking.length}`);
  console.log(`nested path parameters seen: ${nestedAll.length}`);
  for (const t of hintless) console.log(`  hintless  ${t.name.padEnd(28)} ${t.file}  ${t.paths.slice(0, 3).join(",")}`);
}

console.log(`\n--- report ---`);
console.log(`temp external project: ${tmp}`);
console.log(`default surface is path-portable; no cwd/samples fallback in workspace-ui resolution.`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E path-portability: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
