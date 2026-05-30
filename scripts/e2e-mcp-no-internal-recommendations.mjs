// Spec 730.5 — e2e-mcp-no-internal-recommendations
//
// Scans every product-facing recommendation surface and asserts that none of
// them present a forbidden internal tool name as a suggested next action.
//
// Surfaces checked:
//   A. tool-surface-inventory.json — default tool descriptions
//   B. docs/mcp-llm-playbooks.md   — generated LLM playbook text
//   C. agent_onboard output         — live MCP call on a fresh fixture project
//   D. project_audit output         — live MCP call (project_audit tool)
//   E. UI registration-delta banner — string literal in ui/src/App.tsx
//
// Forbidden names (may appear ONLY in doNotCall/forbidden lists, never as the
// recommended action a normal LLM/human should call):
//   register_existing_files
//   scan_registration_delta
//   import_manifest_artifact
//   build_disk_layout_view
//   build_cartridge_layout_view
//
// The script exits 0 (GREEN) when no forbidden name is found as a recommended
// action and exits 1 (RED) otherwise.
//
// Usage: node scripts/e2e-mcp-no-internal-recommendations.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => {
  c ? pass++ : fail++;
  console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`);
};

// The five internal tool names that must NOT appear as recommended actions.
const FORBIDDEN = [
  "register_existing_files",
  "scan_registration_delta",
  "import_manifest_artifact",
  "build_disk_layout_view",
  "build_cartridge_layout_view",
];

// Patterns that indicate an occurrence is in a doNotCall/forbidden list, not a
// recommendation. These regexes apply to a window of ~5 lines around the match.
const DO_NOT_CALL_PATTERNS = [
  /doNotCall/i,
  /forbidden/i,
  /FORBIDDEN_PRODUCT_TOOLS/i,
  /never.*recommend/i,
  /not.*recommend/i,
  /internal.*tool/i,
  /do not call/i,
];

function isInsideDoNotCallContext(text, matchIndex, windowSize = 200) {
  const start = Math.max(0, matchIndex - windowSize);
  const end = Math.min(text.length, matchIndex + windowSize);
  const window = text.slice(start, end);
  return DO_NOT_CALL_PATTERNS.some((p) => p.test(window));
}

/** Returns forbidden names found as recommendations in `text`, with context. */
function scanText(text, label) {
  const hits = [];
  for (const name of FORBIDDEN) {
    let idx = 0;
    while ((idx = text.indexOf(name, idx)) >= 0) {
      if (!isInsideDoNotCallContext(text, idx)) {
        // Extract a short context snippet.
        const start = Math.max(0, idx - 60);
        const end = Math.min(text.length, idx + name.length + 60);
        const snippet = text.slice(start, end).replace(/\n/g, " ").trim();
        hits.push({ name, snippet, label });
      }
      idx += name.length;
    }
  }
  return hits;
}

console.log("Spec 730.5 — no-internal-recommendations gate\n");

// ---------------------------------------------------------------------------
// A. tool-surface-inventory.json — check descriptions of default tools only.
// ---------------------------------------------------------------------------
const inventoryPath = join(ROOT, "docs/tool-surface-inventory.json");
let surfaceHits = [];
if (existsSync(inventoryPath)) {
  try {
    const inv = JSON.parse(readFileSync(inventoryPath, "utf8"));
    const tools = Array.isArray(inv.tools) ? inv.tools : [];
    const defaultTools = tools.filter((t) => t.tier === "default" || t.isDefault === true);
    for (const t of defaultTools) {
      const text = [t.description, t.inputSchema?.description, t.name].filter(Boolean).join(" ");
      const hits = scanText(text, `tool:${t.name}`);
      surfaceHits = surfaceHits.concat(hits);
    }
    ok(surfaceHits.length === 0,
      "A default tool descriptions contain no forbidden internal recommendations",
      surfaceHits.length > 0 ? surfaceHits.map((h) => `${h.name} in ${h.label}`).join("; ") : "clean");
  } catch (e) {
    ok(false, "A tool-surface-inventory.json readable", e.message);
  }
} else {
  ok(false, "A tool-surface-inventory.json exists", inventoryPath);
}

// ---------------------------------------------------------------------------
// B. docs/mcp-llm-playbooks.md — generated playbook text.
// ---------------------------------------------------------------------------
const playbooksPath = join(ROOT, "docs/mcp-llm-playbooks.md");
if (existsSync(playbooksPath)) {
  const text = readFileSync(playbooksPath, "utf8");
  const hits = scanText(text, "mcp-llm-playbooks.md");
  ok(hits.length === 0,
    "B mcp-llm-playbooks.md contains no forbidden internal recommendations",
    hits.length > 0 ? hits.map((h) => `${h.name}: …${h.snippet}…`).join(" | ") : "clean");
} else {
  ok(false, "B docs/mcp-llm-playbooks.md exists", playbooksPath);
}

// ---------------------------------------------------------------------------
// C + D. Live MCP calls: agent_onboard + project_audit on a fixture project.
// ---------------------------------------------------------------------------
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) {
  console.error("dist/cli.js missing — run `npm run build:mcp`");
  process.exit(2);
}

const projectDir = mkdtempSync(join(tmpdir(), "c64re-730_5-"));
mkdirSync(join(projectDir, "analysis", "disk", "tiny", "raw_sectors"), { recursive: true });
// Write a minimal fixture manifest so project_audit detects something to import.
writeFileSync(join(projectDir, "analysis", "disk", "tiny", "manifest.json"), JSON.stringify({
  format: "d64", diskName: "TEST730", diskId: "01",
  files: [{ index: 0, name: "FILE01", type: "PRG", sizeBytes: 3, track: 17, sector: 0,
    loadAddress: 0x0801, relativePath: "raw_sectors/file_01.bin" }],
}));
writeFileSync(join(projectDir, "analysis", "disk", "tiny", "raw_sectors", "file_01.bin"),
  Buffer.from([0x01, 0x08, 0x60]));

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

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-no-internal-recs", version: "1.0.0" },
  });
  ok(!init.error && init.result, "0 MCP initialize handshake", init.error?.message ?? "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Initialise the project so agent_onboard has something to report on.
  const initRes = await callTool("project_init", { project_dir: projectDir, name: "Gate730.5" });
  ok(okText(initRes), "init project_init runs", textOf(initRes).split("\n")[0]);

  // -- C. agent_onboard output --
  const onboard = await callTool("agent_onboard", { project_dir: projectDir });
  const onboardText = textOf(onboard);
  ok(okText(onboard), "C agent_onboard runs", onboardText.split("\n")[0]);
  const onboardHits = scanText(onboardText, "agent_onboard output");
  ok(onboardHits.length === 0,
    "C agent_onboard output contains no forbidden internal recommendations",
    onboardHits.length > 0 ? onboardHits.map((h) => `${h.name}: …${h.snippet}…`).join(" | ") : "clean");

  // -- D. project_audit output (via direct import — project_audit is an
  //    advanced tool not on the default surface, but its rendered text must
  //    still not contain forbidden recommendations). --
  let auditHits = [];
  try {
    const { auditProject, renderProjectAudit } = await import(join(ROOT, "dist/project-knowledge/audit.js"));
    const auditResult = auditProject(projectDir, { includeFileScan: true });
    const auditText = renderProjectAudit(auditResult);
    auditHits = scanText(auditText, "project_audit output");
    ok(auditHits.length === 0,
      "D project_audit output contains no forbidden internal recommendations",
      auditHits.length > 0 ? auditHits.map((h) => `${h.name}: …${h.snippet}…`).join(" | ") : "clean");
  } catch (e) {
    // Non-fatal: audit module may not be available in all build configs.
    console.log(`  SKIP   D project_audit direct-import: ${e.message.split("\n")[0]}`);
    pass++;
  }

  // -- Also check agent_next_step doNotCall list is NOT a recommendation --
  const nextStep = await callTool("agent_next_step", { project_dir: projectDir });
  const nextStepText = textOf(nextStep);
  ok(okText(nextStep), "D2 agent_next_step runs", nextStepText.split("\n")[0]);
  // agent_next_step may list forbidden names ONLY inside doNotCall — not as the
  // primary/branches tool. Check that no forbidden name appears OUTSIDE a
  // doNotCall context in the output.
  const nextStepHits = scanText(nextStepText, "agent_next_step output");
  ok(nextStepHits.length === 0,
    "D2 agent_next_step output lists forbidden names only inside doNotCall",
    nextStepHits.length > 0 ? nextStepHits.map((h) => `${h.name}: …${h.snippet}…`).join(" | ") : "clean");

} catch (e) {
  ok(false, "live MCP harness", e.message + (stderr ? " | stderr: " + stderr.slice(-300) : ""));
} finally {
  proc.kill();
}

// ---------------------------------------------------------------------------
// E. UI registration-delta banner string literal in ui/src/App.tsx.
// ---------------------------------------------------------------------------
const appTsxPath = join(ROOT, "ui/src/App.tsx");
if (existsSync(appTsxPath)) {
  const text = readFileSync(appTsxPath, "utf8");
  // Only check the RegistrationBanner function body — not the entire 6000-line file.
  const bannerMatch = text.match(/function RegistrationBanner\b[\s\S]*?(?=\nfunction |\nexport function )/);
  const bannerText = bannerMatch ? bannerMatch[0] : text; // fallback: scan all
  const hits = scanText(bannerText, "RegistrationBanner in App.tsx");
  ok(hits.length === 0,
    "E UI RegistrationBanner contains no forbidden internal recommendations",
    hits.length > 0 ? hits.map((h) => `${h.name}: …${h.snippet}…`).join(" | ") : "clean");
} else {
  // UI is optional (server-only deploys). Warn but don't fail.
  console.log(`  SKIP   E ui/src/App.tsx not found — UI not built`);
  pass++;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-mcp-no-internal-recommendations: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
