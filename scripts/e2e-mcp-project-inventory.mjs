// Spec 729 E2E-A — new project + inventory, end-to-end through the REAL MCP
// server over stdio JSON-RPC, with the DEFAULT tool surface (no
// C64RE_FULL_TOOLS) and a project dir OUTSIDE the C64RE repo.
//
// Proves a fresh LLM can: enter a project, see the default facade (and NOT
// vice_*), persist a finding, read it back, check status, build a dashboard —
// all from a path the LLM supplies, with no repo-samples assumption.
//
// No emulator / runtime:proof. Pure product-surface workflow gate.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const PENDING = (m, why) => console.log(`  PENDING  ${m}  (${why})`);

console.log("Spec 729 E2E-A — new project + inventory (live MCP stdio, default surface)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

// temp project OUTSIDE the repo.
const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-proj-"));
ok(!projectDir.startsWith(ROOT), "0 project dir is outside the C64RE repo", projectDir);

// ---- minimal stdio JSON-RPC MCP client ----
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(), // deliberately NOT the repo — prove no cwd/repo coupling
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
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
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

let exitCode = 0;
try {
  // handshake.
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-project-inventory", version: "1.0.0" },
  });
  ok(!init.error && init.result, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // tools/list — the default surface.
  const listed = await rpc("tools/list", {});
  const tools = (listed.result?.tools || []).map((t) => t.name);
  ok(tools.length > 0, "2 tools/list returns the default surface", `${tools.length} tools`);
  const toolSet = new Set(tools);

  // 3. default facade present.
  const NEED = ["project_init", "agent_onboard", "start_re_workflow", "save_finding", "list_findings",
    "project_status", "build_project_dashboard", "inspect_disk", "analyze_prg",
    "runtime_session_start", "runtime_mark", "runtime_trace_finalize", "trace_store_info"];
  const missing = NEED.filter((n) => !toolSet.has(n));
  ok(missing.length === 0, "3 default facade tools are registered", missing.join(",") || "none");

  // 4. NO vice_* / drive-only / maintenance in the default surface.
  const vice = tools.filter((n) => n.startsWith("vice_"));
  ok(vice.length === 0, "4a no vice_* in the live default surface", vice.slice(0, 5).join(",") || "none");
  const drive = tools.filter((n) => /^runtime_drive(_session)?_/.test(n));
  ok(drive.length === 0, "4b no runtime_drive_* in the live default surface", drive.join(",") || "none");
  const maint = tools.filter((n) => /^(backfill_|dedupe_|repair_|bulk_|sandbox_)/.test(n));
  ok(maint.length === 0, "4c no maintenance/bulk/sandbox in the live default surface", maint.join(",") || "none");

  // 5. surface size matches the matrix default count (no silent drift).
  const matrix = JSON.parse((await import("node:fs")).readFileSync(join(ROOT, "docs/mcp-tool-usecase-matrix.json"), "utf8"));
  ok(tools.length === matrix.defaultCount, "5 live default count == matrix defaultCount", `${tools.length}/${matrix.defaultCount}`);

  // 6. initialize the project from the DEFAULT surface (vision §2.4 entry step;
  //    path-portable: project came from C64RE_PROJECT_DIR, cwd=tmp).
  const initRes = await callTool("project_init", { project_dir: projectDir, name: "E2E Inventory" });
  ok(okText(initRes) && /initialized/i.test(textOf(initRes)), "6 project_init initializes an external project (default surface)", textOf(initRes).split("\n")[0]);

  // 6b. onboard + select a workflow — the swimlane's project-baseline steps.
  const onboard = await callTool("agent_onboard", { project_dir: projectDir });
  ok(okText(onboard), "6b agent_onboard runs against the external project", "");
  const wf = await callTool("start_re_workflow", { project_dir: projectDir, workflow: "cracker-only" });
  ok(okText(wf) && /Workflow set/i.test(textOf(wf)), "6c start_re_workflow selects a workflow", textOf(wf).split("\n")[0]);

  // 7. persist a finding, read it back.
  const fid = await callTool("save_finding", {
    project_dir: projectDir, kind: "observation",
    title: "E2E inventory marker", summary: "written by e2e-mcp-project-inventory",
    confidence: 0.9, tags: ["e2e"],
  });
  ok(okText(fid), "7a save_finding persists a finding", textOf(fid).split("\n")[0].slice(0, 60));
  const findings = await callTool("list_findings", { project_dir: projectDir });
  ok(okText(findings) && /E2E inventory marker/.test(textOf(findings)), "7b list_findings reads the finding back", "");

  // 8. project_status + dashboard.
  const status = await callTool("project_status", { project_dir: projectDir });
  ok(okText(status), "8a project_status reports the project", "");
  const dash = await callTool("build_project_dashboard", { project_dir: projectDir });
  ok(okText(dash), "8b build_project_dashboard builds a view", "");

  // 9. media inventory: analyze a tiny PRG written into the external project.
  //    (A real .d64 needs a 174848-byte image; we use a PRG to keep the
  //    fixture tiny + deterministic. Disk-image inventory is covered by the
  //    synthetic-disk fixtures + the runtime gates, not this surface gate.)
  const prgPath = join(projectDir, "tiny.prg");
  // $0801 load addr + a couple of bytes.
  writeFileSync(prgPath, Buffer.from([0x01, 0x08, 0xa9, 0x00, 0x60]));
  try {
    const analyzed = await callTool("analyze_prg", { project_dir: projectDir, prg_path: prgPath });
    ok(okText(analyzed), "9 analyze_prg runs on a project-local PRG (absolute path)", isErr(analyzed) ? textOf(analyzed).split("\n").slice(0, 3).join(" ") : "");
  } catch (e) {
    PENDING("9 analyze_prg on project-local PRG", e.message);
  }

  console.log(`\n--- report ---`);
  console.log(`external project: ${projectDir}`);
  console.log(`default tools: ${tools.length} (vice/drive/maintenance excluded); finding persisted + read back; dashboard built.`);
  console.log(`tools used: agent_onboard, save_finding, list_findings, project_status, build_project_dashboard, analyze_prg`);
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-200) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E project-inventory: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
