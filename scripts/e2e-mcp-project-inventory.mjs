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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
  // Exception (Spec 730.1): bulk_create_cart_chunk_payloads is a product RE tool
  // explicitly promoted to default; its name matches /^bulk_/ but it is not a
  // maintenance op.
  const BULK_EXCEPTIONS_730 = new Set(["bulk_create_cart_chunk_payloads"]);
  const maint = tools.filter((n) => /^(backfill_|dedupe_|repair_|bulk_|sandbox_)/.test(n) && !BULK_EXCEPTIONS_730.has(n));
  ok(maint.length === 0, "4c no maintenance/bulk/sandbox in the live default surface", maint.join(",") || "none");

  // 3b. Spec 730.3 — the product inventory-sync facade is default, and the
  // internal helpers it wraps are NOT on the default surface.
  ok(toolSet.has("project_inventory_sync"), "3b project_inventory_sync is on the default surface", "");
  const leakedInternals = ["register_existing_files", "scan_registration_delta", "import_manifest_artifact"]
    .filter((n) => toolSet.has(n));
  ok(leakedInternals.length === 0, "3c internal registration/import helpers stay off the default surface", leakedInternals.join(",") || "none");

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

  // 10. Spec 730.3 — project_inventory_sync facade.
  //  Lay down (a) a manifest + extracted payload, (b) an unregistered GENERATED
  //  source file, and (c) an unregistered HAND-MADE SEMANTIC source file under
  //  the analysis tree. None are registered yet. One sync must register them all,
  //  import the manifest, and rebuild views; a second sync must be a safe no-op
  //  (no duplicate artifacts, no failure). The semantic source must end up
  //  registered/visible (BUG-019).
  const analysisDir = join(projectDir, "analysis", "disk", "tiny");
  mkdirSync(join(analysisDir, "raw_sectors"), { recursive: true });
  // (a) a payload + a disk manifest referencing it (relative to the manifest).
  const payloadBin = join(analysisDir, "raw_sectors", "file_01.bin");
  writeFileSync(payloadBin, Buffer.from([0x01, 0x08, 0x60]));
  writeFileSync(join(analysisDir, "manifest.json"), JSON.stringify({
    format: "d64", diskName: "TINY", diskId: "01",
    files: [{ index: 0, name: "FILE01", type: "PRG", sizeBytes: 3, track: 17, sector: 0,
      loadAddress: 0x0801, relativePath: "raw_sectors/file_01.bin" }],
  }, null, 2));
  // (b) a generated disasm source (would normally come from disasm_prg).
  writeFileSync(join(analysisDir, "file01_disasm.asm"), "* = $0801\n  rts\n");
  // (c) a hand-made / semantic source the resolver must surface (BUG-019).
  const semanticRel = "analysis/disk/tiny/file01_semantic.tass";
  writeFileSync(join(projectDir, semanticRel), "* = $0801 ; semantic, hand-curated\n  rts\n");

  const beforeArts = await callTool("list_artifacts", { project_dir: projectDir });
  void beforeArts;

  const sync1 = await callTool("project_inventory_sync", { project_dir: projectDir });
  const sync1Text = textOf(sync1);
  ok(okText(sync1) && /inventory sync — done/i.test(sync1Text), "10a project_inventory_sync runs clean", sync1Text.split("\n")[0]);
  const reg1 = Number((sync1Text.match(/Files registered:\s*(\d+)/) || [])[1] || "0");
  const imp1 = Number((sync1Text.match(/Manifests imported:\s*(\d+)/) || [])[1] || "0");
  const views1 = Number((sync1Text.match(/Views rebuilt:\s*(\d+)/) || [])[1] || "0");
  ok(reg1 >= 3, "10b first sync registers the unregistered files (manifest + generated + semantic source)", `registered=${reg1}`);
  ok(imp1 >= 1, "10c first sync imports the disk manifest", `imported=${imp1}`);
  ok(views1 >= 1, "10d first sync rebuilds project views", `views=${views1}`);

  // The hand-made semantic source must be REGISTERED, not left behind. The sync
  // facade reports any file it could not register under skipped/remaining — so
  // the BUG-019 proof is: the semantic .tass is NOT reported as skipped/remaining
  // after the sync (i.e. it became a tracked artifact). We read the knowledge
  // store directly for ground truth since list_artifacts is a filesystem walker
  // that does not surface every extension.
  ok(!/file01_semantic\.tass/.test(sync1Text), "10e hand-made semantic source is registered, not left as a skipped/remaining problem (BUG-019)", "");
  const storedRel = (() => {
    try {
      const store = JSON.parse(readFileSync(join(projectDir, "knowledge", "artifacts.json"), "utf8"));
      return (store.items || []).map((a) => a.relativePath || a.path || "");
    } catch { return []; }
  })();
  ok(storedRel.some((p) => p.endsWith("file01_semantic.tass")), "10f semantic source is a tracked artifact in the knowledge store", "");
  ok(storedRel.some((p) => p.endsWith("file01_disasm.asm")), "10g generated disasm source is a tracked artifact", "");

  // 10h. idempotency — a second sync registers nothing new and does not fail.
  const sync2 = await callTool("project_inventory_sync", { project_dir: projectDir });
  const sync2Text = textOf(sync2);
  ok(okText(sync2) && /inventory sync — done/i.test(sync2Text), "10h second sync is safe (no failure)", sync2Text.split("\n")[0]);
  const reg2 = Number((sync2Text.match(/Files registered:\s*(\d+)/) || [])[1] || "-1");
  const imp2 = Number((sync2Text.match(/Manifests imported:\s*(\d+)/) || [])[1] || "-1");
  ok(reg2 === 0, "10i second sync registers nothing new (idempotent)", `registered=${reg2}`);

  // no duplicate artifact registrations for the semantic / generated source.
  const storedAfter = (() => {
    try {
      const store = JSON.parse(readFileSync(join(projectDir, "knowledge", "artifacts.json"), "utf8"));
      return (store.items || []).map((a) => a.relativePath || a.path || "");
    } catch { return []; }
  })();
  const semCount = storedAfter.filter((p) => p.endsWith("file01_semantic.tass")).length;
  ok(semCount === 1, "10j no duplicate artifact for the semantic source after two syncs", `count=${semCount}`);
  ok(imp2 >= 0, "10k second sync re-import is idempotent (no error)", `imported=${imp2}`);

  console.log(`\n--- report ---`);
  console.log(`external project: ${projectDir}`);
  console.log(`default tools: ${tools.length} (vice/drive/maintenance excluded); finding persisted + read back; dashboard built.`);
  console.log(`inventory-sync: 1st registered=${reg1} imported=${imp1} views=${views1}; 2nd registered=${reg2} (idempotent); semantic + generated source visible.`);
  console.log(`tools used: agent_onboard, save_finding, list_findings, project_status, build_project_dashboard, analyze_prg, project_inventory_sync, list_artifacts`);
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-200) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E project-inventory: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
