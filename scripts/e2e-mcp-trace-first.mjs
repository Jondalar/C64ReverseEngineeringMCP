// Spec 729 E2E-B/C/D — live MCP trace product flow.
//
// Proves a fresh external LLM can, through the DEFAULT MCP façade over stdio
// (no C64RE_FULL_TOOLS, no VICE, no WebSocket, no raw SQL):
//   - create a project in an arbitrary dir OUTSIDE the repo,
//   - use a media file from that dir (not samples/),
//   - start Headless with a durable trace_out,
//   - drive the disk boot sequence (LOAD"*",8,1 + RUN) via runtime_type,
//   - stamp phase marks, finalize the trace,
//   - query it through convenience readers (info / top_pcs / query_events),
//   - persist a finding + an entity, build a dashboard.
//
// No emulator-fidelity assertion: the synthetic disk just has to produce real
// CPU events. The point is the PRODUCT FLOW works end-to-end via the façade.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, copyFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const PENDING = (m, why) => console.log(`  PENDING  ${m}  (${why})`);

console.log("Spec 729 E2E-B/C/D — live MCP trace product flow (default surface, stdio)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

// A tiny bootable disk fixture is the SEED. It is generated into samples/synthetic
// by `node scripts/gen-synthetic-disks.mjs` (a dev fixture). The E2E COPIES it into
// the external project dir and uses the COPY's absolute path — proving media can
// come from any directory, not the repo samples/.
const seed = join(ROOT, "samples/synthetic/1byte.d64");
if (!existsSync(seed)) {
  PENDING("seed disk fixture", `${seed} not generated — run: node scripts/gen-synthetic-disks.mjs`);
  console.log("\nPENDING (no seed fixture). 0 pass, 0 fail.");
  process.exit(0);
}

const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-trace-"));
ok(!projectDir.startsWith(ROOT), "0 project dir is outside the C64RE repo", projectDir);
const diskPath = join(projectDir, "game.d64");
copyFileSync(seed, diskPath);
const tracePath = join(projectDir, "traces", "run.duckdb"); // project-relative target (abs here)

// ---- stdio JSON-RPC MCP client ----
const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(), // NOT the repo — prove no cwd coupling
  env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });
let buf = "";
const pendingMap = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pendingMap.has(msg.id)) { pendingMap.get(msg.id)(msg); pendingMap.delete(msg.id); }
  }
});
let nextId = 1;
function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingMap.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pendingMap.set(id, (m) => { clearTimeout(timer); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function callTool(name, args, timeoutMs) {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return res.result;
}
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const isErr = (r) => r?.isError === true || /^#?\s*Tool Error/i.test(textOf(r));
const okText = (r) => !isErr(r) && textOf(r).length > 0;

let exitCode = 0;
try {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-trace-first", version: "1.0.0" } });
  ok(!init.error, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // every trace tool used must be in the default surface (no FULL_TOOLS).
  const listed = await rpc("tools/list", {});
  const tools = new Set((listed.result?.tools || []).map((t) => t.name));
  const NEED = ["project_init", "runtime_session_start", "runtime_session_run", "runtime_type",
    "runtime_mark", "runtime_trace_finalize", "trace_store_info", "trace_store_top_pcs",
    "runtime_query_events", "save_finding", "save_entity", "build_project_dashboard"];
  const missing = NEED.filter((n) => !tools.has(n));
  ok(missing.length === 0, "2 all trace-flow tools are in the default surface", missing.join(",") || "none");
  ok(![...tools].some((n) => n.startsWith("vice_")), "2b no vice_* in the surface (product flow)", "");

  // init the project + select workflow.
  ok(okText(await callTool("project_init", { project_dir: projectDir, name: "E2E Trace Flow" })), "3 project_init (external dir)", "");
  await callTool("start_re_workflow", { project_dir: projectDir, workflow: "cracker-only" });

  // start Headless with a durable trace, media from the project dir (abs path).
  const startRes = await callTool("runtime_session_start", {
    disk_path: diskPath, trace_out: tracePath, trace_domains: ["c64-cpu", "memory"],
  }, 60000);
  ok(okText(startRes), "4 runtime_session_start(disk_path, trace_out) on project media", "");
  const startText = textOf(startRes);
  const sidMatch = startText.match(/^Session:\s*(\S+)/m) || startText.match(/\b(integrated-\d+)\b/);
  const sessionId = sidMatch ? sidMatch[1] : undefined;
  ok(!!sessionId, "4b session id returned", sessionId || startText.split("\n")[0]);
  ok(/Trace:\s*streaming/.test(startText), "4c trace streaming confirmed in start output", "");
  if (!sessionId) throw new Error("no session id parsed from runtime_session_start");

  // disk boot sequence: run to BASIC, mark, type LOAD"*",8,1 + RUN, run, mark.
  ok(okText(await callTool("runtime_session_run", { session_id: sessionId, max_instructions: 1_500_000 }, 180000)),
    "5 runtime_session_run → toward BASIC READY", "");
  ok(okText(await callTool("runtime_mark", { session_id: sessionId, label: "basic-ready" })), "6 runtime_mark(basic-ready)", "");
  ok(okText(await callTool("runtime_type", { session_id: sessionId, text: 'LOAD"*",8,1\rRUN\r' })), "7 runtime_type(LOAD\"*\",8,1 + RUN)", "");
  ok(okText(await callTool("runtime_session_run", { session_id: sessionId, max_instructions: 2_000_000 }, 180000)),
    "8 runtime_session_run → through the LOAD attempt", "");
  ok(okText(await callTool("runtime_mark", { session_id: sessionId, label: "loaded-or-title" })), "9 runtime_mark(loaded-or-title)", "");

  const fin = await callTool("runtime_trace_finalize", { session_id: sessionId }, 60000);
  ok(okText(fin), "10 runtime_trace_finalize", "");
  const runIdMatch = textOf(fin).match(/run\s+(\S+)/i);
  const runId = runIdMatch ? runIdMatch[1] : undefined;
  ok(existsSync(tracePath), "10b trace.duckdb exists in the project dir", tracePath);
  ok(!!runId, "10c run id returned by finalize", runId || "");

  // query via convenience readers — no raw SQL.
  const info = await callTool("trace_store_info", { path: tracePath });
  ok(okText(info) && /event|cpu|total/i.test(textOf(info)), "11 trace_store_info reports counts", textOf(info).split("\n").slice(2, 4).join(" "));
  const topPcs = await callTool("trace_store_top_pcs", { path: tracePath, cpu: "c64", limit: 5 });
  ok(okText(topPcs) && /\$?[0-9a-fA-F]{2,4}/.test(textOf(topPcs)), "12 trace_store_top_pcs(c64) returns PCs", textOf(topPcs).split("\n")[1] || "");
  if (runId) {
    const ev = await callTool("runtime_query_events", { run_id: runId, family: "cpu_step", duckdb_path: tracePath, limit: 10 });
    ok(okText(ev) && /rows/i.test(textOf(ev)), "13 runtime_query_events(cpu_step) returns rows", textOf(ev).split("\n")[0]);
  } else {
    PENDING("13 runtime_query_events", "no run id");
  }

  // persist knowledge.
  ok(okText(await callTool("save_finding", {
    project_dir: projectDir, kind: "observation", title: "Boot trace captured",
    summary: `Headless trace ${runId ?? ""} captured boot + LOAD attempt; top PCs queried.`, tags: ["runtime", "trace"],
  })), "14 save_finding (runtime evidence)", "");
  ok(okText(await callTool("save_entity", {
    project_dir: projectDir, kind: "memory-region", name: "boot-pc-window",
    summary: "Most-executed PC region during boot per the trace.",
  })), "15 save_entity (boot PC region)", "");
  ok(okText(await callTool("build_project_dashboard", { project_dir: projectDir })), "16 build_project_dashboard", "");

  // what landed in the project dir.
  const traceDirFiles = existsSync(join(projectDir, "traces")) ? readdirSync(join(projectDir, "traces")) : [];
  console.log(`\n--- report ---`);
  console.log(`external project: ${projectDir}`);
  console.log(`media (project-local abs path): ${diskPath}`);
  console.log(`trace: ${tracePath}  (run ${runId ?? "?"})`);
  console.log(`traces/ dir: ${traceDirFiles.join(", ") || "(none)"}`);
  console.log(`tools used: project_init, start_re_workflow, runtime_session_start, runtime_session_run, runtime_type, runtime_mark, runtime_trace_finalize, trace_store_info, trace_store_top_pcs, runtime_query_events, save_finding, save_entity, build_project_dashboard`);
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-300) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E trace-first: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
