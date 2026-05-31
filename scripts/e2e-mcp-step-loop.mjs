// Spec 730.4 / §11 e2e-mcp-step-loop — the step orchestrator, end-to-end through
// the REAL MCP server over stdio JSON-RPC, with the DEFAULT tool surface (no
// C64RE_FULL_TOOLS) and a project dir OUTSIDE the C64RE repo.
//
// Proves agent_next_step is a usable product loop:
//   - a fresh external (uninitialized) dir → primary step is project-init,
//   - after project_init + project_inventory_sync, agent_next_step ADVANCES to a
//     useful next step (not stale inventory),
//   - every recommended tool (primary + branches) is in the default surface,
//   - no internal tool name leaks as a primary/branch action — internal tools
//     may appear ONLY in the doNotCall list.
//
// No emulator / runtime:proof. Pure product-surface workflow gate.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 730.4 — e2e-mcp-step-loop (live MCP stdio, default surface)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

// The internal tools that must NEVER be recommended as a next action. They may
// appear ONLY inside doNotCall.
const FORBIDDEN_INTERNAL = [
  "register_existing_files", "scan_registration_delta", "import_manifest_artifact",
  "build_disk_layout_view", "build_cartridge_layout_view",
];

// temp project OUTSIDE the repo.
const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-steploop-"));
ok(!projectDir.startsWith(ROOT), "0 project dir is outside the C64RE repo", projectDir);

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

// Parse the rendered agent_next_step output into the fields we assert on.
// The renderer prints:
//   ## Primary
//   Step: <id>  (phase: <phase>)
//   Run: <tool>          (or "(human action — no tool)")
//   ## Branches ...
//     - <id> (<phase>) — <label>: run <tool>   (or "human action")
//   ## Do NOT call ...
//     <comma list>
function parseNextStep(text) {
  const primaryStep = (text.match(/Step:\s*([a-z0-9-]+)/) || [])[1] || "";
  const runLine = (text.match(/Run:\s*(.+)/) || [])[1] || "";
  const primaryTool = /human action/i.test(runLine) ? null : runLine.trim();
  // branch tools
  const branchTools = [];
  const branchSection = (text.split(/## Branches[^\n]*\n/)[1] || "").split(/## /)[0];
  for (const m of branchSection.matchAll(/run ([a-z0-9_]+)/g)) branchTools.push(m[1]);
  // doNotCall
  const dnc = (text.split(/## Do NOT call[^\n]*\n/)[1] || "").split("\n")[0] || "";
  const doNotCall = dnc.split(",").map((s) => s.trim()).filter(Boolean);
  return { primaryStep, primaryTool, branchTools, doNotCall };
}

// Parse the machine-readable JSON block (BUG-005 / §5.3 shape). An LLM parses
// THIS instead of scraping the prose.
function parseMachineShape(text) {
  const m = text.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}
const REQUIRED_SHAPE_KEYS = ["phase", "step", "reason", "primary_action", "secondary_actions", "blocked_by", "do_not_call"];

let exitCode = 0;
try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "e2e-step-loop", version: "1.0.0" },
  });
  ok(!init.error && init.result, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // default surface set (for "every recommended tool is default" assertions).
  const listed = await rpc("tools/list", {});
  const toolNames = (listed.result?.tools || []).map((t) => t.name);
  const toolSet = new Set(toolNames);
  ok(toolSet.has("agent_next_step"), "2a agent_next_step is on the default surface", "");
  ok(toolSet.has("agent_run_step"), "2b agent_run_step is on the default surface", "");
  // internal tools must NOT be callable on the default surface.
  const leaked = FORBIDDEN_INTERNAL.filter((n) => toolSet.has(n));
  ok(leaked.length === 0, "2c internal tools are not on the default surface", leaked.join(",") || "none");

  // 3. fresh UNINITIALIZED dir → primary step is project-init.
  const ns0 = await callTool("agent_next_step", { project_dir: projectDir });
  ok(okText(ns0), "3a agent_next_step runs against an uninitialized dir", "");
  const p0 = parseNextStep(textOf(ns0));
  ok(p0.primaryStep === "project-init", "3b primary step is project-init for a fresh dir", p0.primaryStep || "(none)");
  ok(p0.primaryTool === "project_init", "3c primary tool is the project_init product tool", p0.primaryTool || "(none)");

  // 4. initialize + select workflow + lay down media so inventory becomes dirty.
  const initRes = await callTool("project_init", { project_dir: projectDir, name: "E2E Step Loop" });
  ok(okText(initRes) && /initialized/i.test(textOf(initRes)), "4a project_init initializes the external project", "");

  // lay down an analysis tree with an UNREGISTERED manifest + payload + generated
  // source so the inventory is dirty (drives step 2 of the ladder).
  const analysisDir = join(projectDir, "analysis", "disk", "tiny");
  mkdirSync(join(analysisDir, "raw_sectors"), { recursive: true });
  writeFileSync(join(analysisDir, "raw_sectors", "file_01.bin"), Buffer.from([0x01, 0x08, 0x60]));
  writeFileSync(join(analysisDir, "manifest.json"), JSON.stringify({
    format: "d64", diskName: "TINY", diskId: "01",
    files: [{ index: 0, name: "FILE01", type: "PRG", sizeBytes: 3, track: 17, sector: 0,
      loadAddress: 0x0801, relativePath: "raw_sectors/file_01.bin" }],
  }, null, 2));
  writeFileSync(join(analysisDir, "file01_disasm.asm"), "* = $0801\n  rts\n");

  // 5. now agent_next_step must point at inventory-sync (inventory dirty
  //    outranks almost everything).
  const ns1 = await callTool("agent_next_step", { project_dir: projectDir });
  const p1 = parseNextStep(textOf(ns1));
  ok(p1.primaryStep === "inventory-sync", "5a after init with untracked files, primary is inventory-sync", p1.primaryStep || "(none)");
  ok(p1.primaryTool === "project_inventory_sync", "5b inventory-sync names the product facade tool", p1.primaryTool || "(none)");

  // 5m. machine-readable shape (BUG-005 / §5.3): the LLM must get a parseable
  //     next-action object, not just prose. Every action tool is callable default.
  const m1 = parseMachineShape(textOf(ns1));
  ok(m1 !== null, "5m1 agent_next_step emits a parseable machine-readable JSON block", m1 ? "ok" : "missing/invalid");
  if (m1) {
    const missingKeys = REQUIRED_SHAPE_KEYS.filter((k) => !(k in m1));
    ok(missingKeys.length === 0, "5m2 machine shape has the required fields", missingKeys.length ? `missing: ${missingKeys.join(",")}` : "phase,step,reason,primary_action,secondary_actions,blocked_by,do_not_call");
    ok(m1.step === "inventory-sync" && m1.phase === "media-inventory", "5m3 machine shape step/phase match the dirty-inventory state", `${m1.phase}/${m1.step}`);
    ok(m1.primary_action?.tool === "project_inventory_sync", "5m4 primary_action.tool is the callable facade", m1.primary_action?.tool ?? "(none)");
    ok(typeof m1.primary_action?.label === "string" && m1.primary_action.label.length > 0
       && typeof m1.primary_action?.args === "object", "5m5 primary_action carries {tool,args,label}", "");
    ok(toolSet.has(m1.primary_action.tool), "5m6 primary_action.tool is on the default surface (callable)", m1.primary_action.tool);
    const internalInShape = [m1.primary_action.tool, ...(m1.secondary_actions || []).map((a) => a.tool)]
      .filter(Boolean).filter((t) => FORBIDDEN_INTERNAL.includes(t));
    ok(internalInShape.length === 0, "5m7 no internal tool in primary/secondary actions", internalInShape.join(",") || "none");
    const secondaryNonDefault = (m1.secondary_actions || []).map((a) => a.tool).filter(Boolean).filter((t) => !toolSet.has(t));
    ok(secondaryNonDefault.length === 0, "5m8 every secondary_action tool is callable default (or null human step)", secondaryNonDefault.join(",") || "none");
    ok(FORBIDDEN_INTERNAL.every((n) => (m1.do_not_call || []).includes(n)), "5m9 do_not_call lists the internal tools", (m1.do_not_call || []).join(","));
    ok(typeof m1.ui_hint === "string" && m1.ui_hint.length > 0, "5m10 inventory-sync carries a ui_hint for human UI verification", m1.ui_hint ? "present" : "(none)");
  }

  // 6. run the inventory/media-sync step in-process via agent_run_step.
  const runSync = await callTool("agent_run_step", { project_dir: projectDir, step_id: "inventory-sync" });
  const runSyncText = textOf(runSync);
  ok(okText(runSync) && /inventory-sync — done/i.test(runSyncText), "6a agent_run_step runs inventory-sync in-process", runSyncText.split("\n")[0]);
  ok(/newly tracked/i.test(runSyncText), "6b run-step reports newly tracked files (product concept, not tool names)", "");
  // product-concept summary must NOT leak internal helper names.
  const leakInRun = FORBIDDEN_INTERNAL.filter((n) => new RegExp(`\\b${n}\\b`).test(runSyncText));
  ok(leakInRun.length === 0, "6c run-step summary uses product concepts (no internal tool names)", leakInRun.join(",") || "none");

  // 7. after sync, agent_next_step ADVANCES — it must NOT repeat stale inventory.
  const ns2 = await callTool("agent_next_step", { project_dir: projectDir });
  const p2 = parseNextStep(textOf(ns2));
  ok(p2.primaryStep !== "inventory-sync", "7a after sync, primary step advances past inventory-sync", p2.primaryStep || "(none)");
  ok(p2.primaryStep.length > 0, "7b advanced step has a concrete id", p2.primaryStep || "(none)");
  // 7m. the advanced step's machine shape must also offer a callable next action
  //     (a default tool) or a real human_question — never a dead end.
  const m2 = parseMachineShape(textOf(ns2));
  ok(m2 !== null && m2.step === p2.primaryStep, "7m1 advanced step has a machine-readable shape", m2 ? m2.step : "missing");
  if (m2) {
    const callableOrHuman = (m2.primary_action?.tool && toolSet.has(m2.primary_action.tool))
      || (!m2.primary_action?.tool && typeof m2.human_question === "string" && m2.human_question.length > 0);
    ok(callableOrHuman, "7m2 advanced step offers a callable default tool OR a concrete human_question (no dead end)",
       m2.primary_action?.tool ?? `human_question: ${(m2.human_question || "").slice(0, 40)}`);
  }

  // 8. every recommended tool (primary + branches) across all three calls is in
  //    the default surface; never an internal tool.
  const allRecommended = [
    p0.primaryTool, ...p0.branchTools,
    p1.primaryTool, ...p1.branchTools,
    p2.primaryTool, ...p2.branchTools,
  ].filter(Boolean);
  const notDefault = allRecommended.filter((t) => !toolSet.has(t));
  ok(notDefault.length === 0, "8a every recommended tool is on the default surface", notDefault.join(",") || "none");
  const internalRecommended = allRecommended.filter((t) => FORBIDDEN_INTERNAL.includes(t));
  ok(internalRecommended.length === 0, "8b no internal tool appears as a primary/branch action", internalRecommended.join(",") || "none");

  // 9. internal tools ARE present in doNotCall (forbidden-leakage list), proving
  //    the orchestrator surfaces them only as forbidden.
  const dncCoversInternal = FORBIDDEN_INTERNAL.every((n) => p2.doNotCall.includes(n));
  ok(dncCoversInternal, "9 doNotCall lists the internal tools as forbidden leakage", p2.doNotCall.join(",") || "(empty)");

  console.log(`\n--- report ---`);
  console.log(`external project: ${projectDir}`);
  console.log(`step loop: fresh→${p0.primaryStep}; dirty→${p1.primaryStep}; after-sync→${p2.primaryStep}`);
  console.log(`recommended tools (all default): ${[...new Set(allRecommended)].join(", ")}`);
  console.log(`doNotCall: ${p2.doNotCall.join(", ")}`);
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-200) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e step-loop: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
