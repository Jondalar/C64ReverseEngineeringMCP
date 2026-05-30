// Spec 730 §11 gate — e2e-mcp-artifact-best-version.
//
// Closes BUG-019 Part B end-to-end through the REAL MCP server over stdio
// JSON-RPC, with the DEFAULT tool surface (no C64RE_FULL_TOOLS) and a project
// dir OUTSIDE the C64RE repo.
//
// Proves:
//   1. A project with BOTH `02_2.0_disasm.asm` (generated) and
//      `02_2.0_semantic.tass` (semantic) resolves the current best version to
//      the SEMANTIC source after project_inventory_sync.
//   2. An UNREGISTERED hand-made source becomes visible (registered) after sync.
//   3. The version-op default tools (list/get/set/mark) are on the surface and
//      a MANUAL current decision PERSISTS and survives a SECOND sync.
//
// No emulator / runtime:proof. Pure product-surface workflow gate.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 730 §7 — e2e-mcp-artifact-best-version (live MCP stdio, default surface)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-bestver-"));
ok(!projectDir.startsWith(ROOT), "0 project dir is outside the C64RE repo", projectDir);

// ---- minimal stdio JSON-RPC MCP client ----
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });

let buf = "";
const pending = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

let nextId = 1;
function rpc(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function callTool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return res.result;
}
const textOf = (result) => (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const isErr = (result) => result?.isError === true || /^#?\s*Tool Error/i.test(textOf(result));
const okText = (result) => !isErr(result) && textOf(result).length > 0;
const readArtifacts = () => {
  try { return (JSON.parse(readFileSync(join(projectDir, "knowledge", "artifacts.json"), "utf8")).items || []); }
  catch { return []; }
};
const readVersionGroups = () => {
  try { return (JSON.parse(readFileSync(join(projectDir, "knowledge", "artifact-versions.json"), "utf8")).items || []); }
  catch { return []; }
};

let exitCode = 0;
try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-best-version", version: "1.0.0" },
  });
  ok(!init.error && init.result, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // version-op tools must be on the DEFAULT surface.
  const listed = await rpc("tools/list", {});
  const toolSet = new Set((listed.result?.tools || []).map((t) => t.name));
  const NEED = ["list_artifact_versions", "get_current_artifact", "set_current_artifact_version", "mark_artifact_version_stale"];
  const missing = NEED.filter((n) => !toolSet.has(n));
  ok(missing.length === 0, "2 version-op tools are on the default surface", missing.join(",") || "none");

  // init project.
  const initRes = await callTool("project_init", { project_dir: projectDir, name: "Best Version" });
  ok(okText(initRes) && /initialized/i.test(textOf(initRes)), "3 project_init initializes external project", "");

  // Lay down both a generated disasm source and a hand-made semantic source for
  // the SAME subject ("02_2.0"). Neither registered yet.
  const analysisDir = join(projectDir, "analysis", "disk", "wasteland");
  mkdirSync(analysisDir, { recursive: true });
  const genRel = "analysis/disk/wasteland/02_2.0_disasm.asm";
  const semRel = "analysis/disk/wasteland/02_2.0_semantic.tass";
  writeFileSync(join(projectDir, genRel), "* = $0801 ; GENERATED kickass disasm\n  rts\n");
  writeFileSync(join(projectDir, semRel), "* = $0801 ; hand-curated SEMANTIC 64tass\n  rts\n");

  // Sync: registers both + builds version group with semantic as current.
  const sync1 = await callTool("project_inventory_sync", { project_dir: projectDir });
  const sync1Text = textOf(sync1);
  ok(okText(sync1) && /inventory sync — done/i.test(sync1Text), "4 project_inventory_sync runs clean", sync1Text.split("\n")[0]);

  // BUG-019: the hand-made semantic source became a tracked artifact.
  const arts1 = readArtifacts();
  const semArt = arts1.find((a) => (a.relativePath || a.path || "").endsWith("02_2.0_semantic.tass"));
  const genArt = arts1.find((a) => (a.relativePath || a.path || "").endsWith("02_2.0_disasm.asm"));
  ok(!!semArt, "5 hand-made semantic source is registered (visible) after sync", semArt ? semArt.id : "missing");
  ok(!!genArt, "5b generated disasm source is registered after sync", genArt ? genArt.id : "missing");

  // A version group exists for the subject and current == the SEMANTIC source.
  const groups1 = readVersionGroups();
  const grp = groups1.find((g) => g.subjectId === "02_2.0");
  ok(!!grp, "6 a version group exists for subject 02_2.0", grp ? grp.id : "missing");
  ok(grp && semArt && grp.currentArtifactId === semArt.id,
    "7 current best version is the SEMANTIC source (auto), not the generated dump (BUG-019)",
    grp ? `current=${grp.currentArtifactId} sem=${semArt?.id}` : "");
  ok(grp && grp.currentSource === "auto", "7b current was chosen automatically (auto)", grp ? grp.currentSource : "");

  // get_current_artifact resolves to the semantic source.
  const cur = await callTool("get_current_artifact", { project_dir: projectDir, subject_id: "02_2.0" });
  ok(okText(cur) && /02_2\.0_semantic\.tass/.test(textOf(cur)), "8 get_current_artifact returns the semantic source", "");

  // list_artifact_versions surfaces both versions.
  const versions = await callTool("list_artifact_versions", { project_dir: projectDir, subject_id: "02_2.0" });
  const vText = textOf(versions);
  ok(okText(versions) && /02_2\.0_semantic\.tass/.test(vText) && /02_2\.0_disasm\.asm/.test(vText),
    "9 list_artifact_versions lists both versions", "");

  // Manual override: pin the GENERATED source as current, persists.
  const setRes = await callTool("set_current_artifact_version", { project_dir: projectDir, subject_id: "02_2.0", artifact_id: genArt.id });
  ok(okText(setRes), "10 set_current_artifact_version pins the generated source (manual)", "");
  const grpAfterSet = readVersionGroups().find((g) => g.subjectId === "02_2.0");
  ok(grpAfterSet && grpAfterSet.currentArtifactId === genArt.id && grpAfterSet.currentSource === "manual",
    "11 manual current decision persists in the knowledge store",
    grpAfterSet ? `current=${grpAfterSet.currentArtifactId} src=${grpAfterSet.currentSource}` : "");

  // A SECOND sync must RESPECT the manual decision (not revert to semantic).
  const sync2 = await callTool("project_inventory_sync", { project_dir: projectDir });
  ok(okText(sync2) && /inventory sync — done/i.test(textOf(sync2)), "12 second sync runs clean", "");
  const grpAfterSync2 = readVersionGroups().find((g) => g.subjectId === "02_2.0");
  ok(grpAfterSync2 && grpAfterSync2.currentArtifactId === genArt.id && grpAfterSync2.currentSource === "manual",
    "13 second sync RESPECTS the manual current (does not auto-overwrite)",
    grpAfterSync2 ? `current=${grpAfterSync2.currentArtifactId} src=${grpAfterSync2.currentSource}` : "");

  // mark stale: demote the (manual) current; current falls back to the best
  // remaining version (the semantic one).
  const markRes = await callTool("mark_artifact_version_stale", { project_dir: projectDir, subject_id: "02_2.0", artifact_id: genArt.id });
  ok(okText(markRes), "14 mark_artifact_version_stale demotes a version", "");
  const grpAfterMark = readVersionGroups().find((g) => g.subjectId === "02_2.0");
  const staleMember = grpAfterMark?.versions.find((v) => v.artifactId === genArt.id);
  ok(staleMember && staleMember.status === "stale", "15 the demoted version is recorded stale", staleMember ? staleMember.status : "");
  ok(grpAfterMark && grpAfterMark.currentArtifactId === semArt.id,
    "16 current falls back to the best remaining (semantic) version after marking stale",
    grpAfterMark ? `current=${grpAfterMark.currentArtifactId}` : "");

  console.log(`\n--- report ---`);
  console.log(`external project: ${projectDir}`);
  console.log(`subject 02_2.0: semantic auto-current; manual pin persisted + survived 2nd sync; mark-stale fell back to semantic.`);
  console.log(`tools used: project_init, project_inventory_sync, get_current_artifact, list_artifact_versions, set_current_artifact_version, mark_artifact_version_stale`);
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-200) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E artifact-best-version: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
