// Spec 730.6 — e2e-mcp-disk-raw-default (acceptance E)
//
// Proves the DEFAULT MCP surface can perform the Disk Raw Inspection scenario
// end-to-end over stdio JSON-RPC with a temp project dir OUTSIDE the C64RE repo.
//
// Scenario (from Spec 730 §10 acceptance E):
//   1. Inspect G64 slots / a track / blocks / headers.
//   2. Extract at least one raw sector or raw track.
//   3. Persist a disk hint or finding from the inspection.
//   4. Run project_inventory_sync so views pick up the result.
//
// Assertions:
//   - Every tool called is in the DEFAULT surface (no C64RE_FULL_TOOLS).
//   - Every call returns structured output, not a Tool Error crash.
//   - No response text recommends a hidden/internal tool as the next action.
//   - Tools that can not return meaningful data on a sparse synthetic disk
//     return a clean structured "nothing found" response rather than crashing.
//
// G64 fixture: generated inline from dist/disk/{d64-builder,g64-builder}.js
// (same approach used by gen-synthetic-disks.mjs). The disk has a sparse
// DOS directory (only one file) and occupied raw tracks — the real GCR data
// is what the G64 raw inspection tools decode.
//
// Path-portable: project lives in $TMPDIR, cwd is $TMPDIR, no repo fallback.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };
const NOTE = (m) => console.log(`  NOTE  ${m}`);

console.log("Spec 730.6 — e2e-mcp-disk-raw-default (live MCP stdio, default surface)\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

// Internal tools that must NEVER appear as recommended next actions.
const FORBIDDEN_INTERNAL = [
  "register_existing_files", "scan_registration_delta", "import_manifest_artifact",
  "build_disk_layout_view", "build_cartridge_layout_view",
];

function noHiddenRecommendation(text, label) {
  for (const name of FORBIDDEN_INTERNAL) {
    // Only fail if the tool name appears outside a doNotCall / forbidden context.
    const idx = text.indexOf(name);
    if (idx < 0) continue;
    const start = Math.max(0, idx - 150);
    const end = Math.min(text.length, idx + name.length + 150);
    const window = text.slice(start, end);
    if (/doNotCall|forbidden|do not call|internal.tool|not.*recommend/i.test(window)) continue;
    return `${label}: response recommends internal tool "${name}"`;
  }
  return null;
}

// ---- G64 fixture generation ---------------------------------------------------
// Import builders from dist (identical approach to gen-synthetic-disks.mjs).
let buildD64, buildG64;
try {
  ({ buildD64 } = await import("../dist/disk/d64-builder.js"));
  ({ buildG64 } = await import("../dist/disk/g64-builder.js"));
} catch (e) {
  console.error("dist/disk builders missing — run `npm run build:mcp`");
  console.error(e?.message ?? e);
  process.exit(2);
}

// Tiny PRG payload: load addr $0801 + 3 bytes of code.
const payload = new Uint8Array([0x01, 0x08, 0xa9, 0x01, 0x60]);
const d64 = buildD64({ diskName: "RAWTEST", files: [{ name: "SPARSE", payload }] });
const g64Bytes = buildG64({ d64 });
// -------------------------------------------------------------------------------

// temp project OUTSIDE the repo.
const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-diskraw-"));
ok(!projectDir.startsWith(ROOT), "0 project dir is outside the C64RE repo", projectDir);

// Write the G64 into a media subfolder of the project (never repo samples/).
const mediaDir = join(projectDir, "media");
mkdirSync(mediaDir, { recursive: true });
const g64Path = join(mediaDir, "rawtest.g64");
writeFileSync(g64Path, g64Bytes);
ok(existsSync(g64Path), "0b G64 fixture written outside the repo", `${g64Bytes.length} bytes`);

// ---- stdio MCP client -------------------------------------------------------
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
const isErr = (result) => result?.isError === true || /^#?\s*Tool Error/i.test(textOf(result)) || /^#\s*c64re error/i.test(textOf(result));
const okText = (result) => !isErr(result) && textOf(result).length > 0;
// -----------------------------------------------------------------------------

const toolsUsed = [];

let exitCode = 0;
try {
  // 1. MCP handshake.
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "e2e-disk-raw-default", version: "1.0.0" },
  });
  ok(!init.error && init.result, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 2. Default surface check — disk/G64 tools must be present.
  const listed = await rpc("tools/list", {});
  const toolSet = new Set((listed.result?.tools || []).map((t) => t.name));
  const G64_TOOLS = [
    "list_g64_slots", "inspect_g64_track", "inspect_g64_blocks", "inspect_g64_syncs",
    "scan_g64_headers", "read_g64_sector_candidate", "extract_g64_sectors",
    "extract_g64_raw_track", "analyze_g64_anomalies",
    "suggest_disk_lut_sector", "extract_disk_custom_lut", "set_payload_disk_hint",
  ];
  const missingG64 = G64_TOOLS.filter((n) => !toolSet.has(n));
  ok(missingG64.length === 0, "2a all G64 raw-inspection tools are on the DEFAULT surface", missingG64.join(",") || "none");
  // No vice_* on the surface (regression guard).
  const vice = [...toolSet].filter((n) => n.startsWith("vice_"));
  ok(vice.length === 0, "2b no vice_* on the default surface", vice.join(",") || "none");

  // 3. Initialize the external project.
  const initRes = await callTool("project_init", { project_dir: projectDir, name: "E2E Disk Raw" });
  toolsUsed.push("project_init");
  ok(okText(initRes) && /initialized/i.test(textOf(initRes)), "3 project_init initializes external project", "");

  // 4. Scenario step 1a — list_g64_slots: enumerate every half-track slot.
  const slotsRes = await callTool("list_g64_slots", { image_path: g64Path });
  toolsUsed.push("list_g64_slots");
  const slotsText = textOf(slotsRes);
  ok(!isErr(slotsRes), "4a list_g64_slots: no Tool Error on synthetic G64", isErr(slotsRes) ? slotsText.split("\n")[0] : "ok");
  ok(okText(slotsRes) && /Listed slots/i.test(slotsText), "4b list_g64_slots: returns slot table", slotsText.split("\n").find((l) => /slot/i.test(l)) || "");
  const lintCheck4 = noHiddenRecommendation(slotsText, "list_g64_slots");
  ok(!lintCheck4, "4c list_g64_slots: no hidden-tool recommendation", lintCheck4 ?? "clean");

  // 4d. inspect_g64_track: decode track 17 (the BAM/dir track — always present in 1541 disks).
  const trackRes = await callTool("inspect_g64_track", { image_path: g64Path, track: 17 });
  toolsUsed.push("inspect_g64_track");
  const trackText = textOf(trackRes);
  ok(!isErr(trackRes), "4d inspect_g64_track: no Tool Error on track 17", isErr(trackRes) ? trackText.split("\n")[0] : "ok");
  ok(okText(trackRes) && /Decoded sectors/i.test(trackText), "4e inspect_g64_track: returns sector summary", "");
  const lintCheck4d = noHiddenRecommendation(trackText, "inspect_g64_track");
  ok(!lintCheck4d, "4f inspect_g64_track: no hidden-tool recommendation", lintCheck4d ?? "clean");

  // 4g. inspect_g64_blocks: raw GCR block-level detail for track 17.
  const blocksRes = await callTool("inspect_g64_blocks", { image_path: g64Path, track: 17 });
  toolsUsed.push("inspect_g64_blocks");
  const blocksText = textOf(blocksRes);
  ok(!isErr(blocksRes), "4g inspect_g64_blocks: no Tool Error on track 17", isErr(blocksRes) ? blocksText.split("\n")[0] : "ok");
  ok(okText(blocksRes), "4h inspect_g64_blocks: returns non-empty structured output", "");
  const lintCheck4g = noHiddenRecommendation(blocksText, "inspect_g64_blocks");
  ok(!lintCheck4g, "4i inspect_g64_blocks: no hidden-tool recommendation", lintCheck4g ?? "clean");

  // 4j. scan_g64_headers: header candidates on track 17.
  const headersRes = await callTool("scan_g64_headers", { image_path: g64Path, track: 17 });
  toolsUsed.push("scan_g64_headers");
  const headersText = textOf(headersRes);
  ok(!isErr(headersRes), "4j scan_g64_headers: no Tool Error on track 17", isErr(headersRes) ? headersText.split("\n")[0] : "ok");
  ok(okText(headersRes) && /Header candidates/i.test(headersText), "4k scan_g64_headers: returns header candidate list", "");
  const lintCheck4j = noHiddenRecommendation(headersText, "scan_g64_headers");
  ok(!lintCheck4j, "4l scan_g64_headers: no hidden-tool recommendation", lintCheck4j ?? "clean");

  // 4m. inspect_g64_syncs: sync mark positions on track 17.
  const syncsRes = await callTool("inspect_g64_syncs", { image_path: g64Path, track: 17 });
  toolsUsed.push("inspect_g64_syncs");
  const syncsText = textOf(syncsRes);
  ok(!isErr(syncsRes), "4m inspect_g64_syncs: no Tool Error on track 17", isErr(syncsRes) ? syncsText.split("\n")[0] : "ok");
  ok(okText(syncsRes) && /Sync marks/i.test(syncsText), "4n inspect_g64_syncs: returns sync mark info", "");

  // 5. Scenario step 1 — analyze_g64_anomalies: whole-image anomaly sweep.
  const anomalyRes = await callTool("analyze_g64_anomalies", { image_path: g64Path });
  toolsUsed.push("analyze_g64_anomalies");
  const anomalyText = textOf(anomalyRes);
  ok(!isErr(anomalyRes), "5a analyze_g64_anomalies: no Tool Error on synthetic G64", isErr(anomalyRes) ? anomalyText.split("\n")[0] : "ok");
  ok(okText(anomalyRes) && /Anomalies/i.test(anomalyText), "5b analyze_g64_anomalies: returns structured anomaly report", "");
  // A clean synthetic disk should have 0 anomalies — assert "nothing found" is
  // a structured response, not a crash.
  const anomalyCount = Number((anomalyText.match(/Anomalies:\s*(\d+)/) || [])[1] ?? -1);
  ok(anomalyCount >= 0, "5c analyze_g64_anomalies: anomaly count is a non-negative integer (structured 'nothing found' ok)", `anomalies=${anomalyCount}`);
  if (anomalyCount === 0) {
    NOTE("5c: synthetic G64 has 0 anomalies — clean structured response confirmed (expected for a freshly-built disk)");
  }

  // 6. Scenario step 2 — extract_g64_sectors: write sector .bin files for track 17.
  const sectorsOutDir = join(projectDir, "analysis", "g64-sectors");
  const sectorsRes = await callTool("extract_g64_sectors", {
    project_dir: projectDir,
    image_path: g64Path,
    track: 17,
    output_dir: sectorsOutDir,
  });
  toolsUsed.push("extract_g64_sectors");
  const sectorsText = textOf(sectorsRes);
  ok(!isErr(sectorsRes), "6a extract_g64_sectors: no Tool Error on track 17", isErr(sectorsRes) ? sectorsText.split("\n")[0] : "ok");
  ok(okText(sectorsRes), "6b extract_g64_sectors: returns non-empty structured output", "");
  // Accept either "Extracted N sectors" or "No sectors decoded" — both are
  // valid structured responses. A crash would be isErr=true (caught above).
  const extractedCount = Number((sectorsText.match(/Extracted\s+(\d+)\s+sector/i) || sectorsText.match(/(\d+)\s+sector/i) || [])[1] ?? 0);
  NOTE(`6b: extract_g64_sectors on track 17 → "${sectorsText.split("\n")[0]}"`);
  const lintCheck6 = noHiddenRecommendation(sectorsText, "extract_g64_sectors");
  ok(!lintCheck6, "6c extract_g64_sectors: no hidden-tool recommendation", lintCheck6 ?? "clean");

  // 6d. extract_g64_raw_track: export raw bitstream for track 17.
  const rawTrackOut = join(projectDir, "analysis", "g64-raw", "rawtest-track-17.bin");
  const rawRes = await callTool("extract_g64_raw_track", {
    image_path: g64Path,
    track: 17,
    output_path: rawTrackOut,
  });
  toolsUsed.push("extract_g64_raw_track");
  const rawText = textOf(rawRes);
  ok(!isErr(rawRes), "6d extract_g64_raw_track: no Tool Error on track 17", isErr(rawRes) ? rawText.split("\n")[0] : "ok");
  ok(okText(rawRes), "6e extract_g64_raw_track: returns non-empty structured output", "");
  ok(existsSync(rawTrackOut), "6f extract_g64_raw_track: wrote the .bin file to the project dir", rawTrackOut);

  // 7. Scenario step 3 — persist a finding from the disk inspection.
  //    We also create a payload entity so we can exercise set_payload_disk_hint.
  const findingRes = await callTool("save_finding", {
    project_dir: projectDir,
    kind: "observation",
    title: "Disk raw inspection result: track 17 decoded",
    summary: `G64 inspection of ${g64Path}: track 17 found, anomalies=${anomalyCount}`,
    confidence: 0.9,
    tags: ["disk-raw", "e2e-730-E"],
  });
  toolsUsed.push("save_finding");
  ok(okText(findingRes), "7a save_finding: persists disk inspection finding", textOf(findingRes).split("\n")[0].slice(0, 60));
  const lintCheck7 = noHiddenRecommendation(textOf(findingRes), "save_finding");
  ok(!lintCheck7, "7b save_finding: no hidden-tool recommendation", lintCheck7 ?? "clean");

  // 7c. Create a payload entity, then set a disk hint on it.
  const entityRes = await callTool("save_entity", {
    project_dir: projectDir,
    kind: "payload",
    name: "track-17-raw",
    summary: "Raw track 17 bitstream extracted from synthetic G64 for e2e gate",
    tags: ["disk-raw", "track-17", "e2e-730-E"],
  });
  toolsUsed.push("save_entity");
  ok(okText(entityRes), "7c save_entity: creates a payload entity for the raw track", textOf(entityRes).split("\n")[0].slice(0, 60));

  // Extract the entity ID from the response (format: "Entity saved.\nID: <id>").
  const entityText = textOf(entityRes);
  const entityId = (entityText.match(/\bID:\s*([a-zA-Z0-9_-]+)/i) || [])[1];
  NOTE(`7c entity ID extracted: "${entityId ?? "(none)"}"`);
  if (entityId) {
    const hintRes = await callTool("set_payload_disk_hint", {
      project_dir: projectDir,
      payload_entity_id: entityId,
      hint: "raw-unanalyzed",
    });
    toolsUsed.push("set_payload_disk_hint");
    const hintText = textOf(hintRes);
    ok(!isErr(hintRes) && okText(hintRes), "7d set_payload_disk_hint: sets hint on payload entity", hintText.split("\n")[0]);
    const lintCheck7d = noHiddenRecommendation(hintText, "set_payload_disk_hint");
    ok(!lintCheck7d, "7e set_payload_disk_hint: no hidden-tool recommendation", lintCheck7d ?? "clean");
  } else {
    ok(false, "7d entity ID extracted from save_entity response (needed for set_payload_disk_hint)", entityText.slice(0, 80));
  }

  // 8. Scenario step 4 — project_inventory_sync so views pick up the result.
  const syncRes = await callTool("project_inventory_sync", { project_dir: projectDir });
  toolsUsed.push("project_inventory_sync");
  const syncText = textOf(syncRes);
  ok(!isErr(syncRes) && /inventory sync — done/i.test(syncText), "8a project_inventory_sync: completes after disk inspection", syncText.split("\n")[0]);
  const lintCheck8 = noHiddenRecommendation(syncText, "project_inventory_sync");
  ok(!lintCheck8, "8b project_inventory_sync: no hidden-tool recommendation", lintCheck8 ?? "clean");

  // 9. Cross-check: every tool called in this gate is on the DEFAULT surface.
  //    (We did not pass C64RE_FULL_TOOLS, so this is always true if the tools
  //    resolved and returned results — but let's make it explicit.)
  const notDefault = toolsUsed.filter((n) => !toolSet.has(n));
  ok(notDefault.length === 0, "9 every tool used in this gate is on the DEFAULT surface", notDefault.join(",") || "none");

  console.log(`\n--- report ---`);
  console.log(`external project: ${projectDir}`);
  console.log(`G64 fixture: ${g64Path} (${g64Bytes.length} bytes, built inline, 1 file, sparse directory)`);
  console.log(`tools used: ${[...new Set(toolsUsed)].join(", ")}`);
  console.log(`anomalies on synthetic disk: ${anomalyCount} (0=clean, structured response confirmed)`);
  console.log(`raw track extracted: ${existsSync(rawTrackOut) ? rawTrackOut : "not written"}`);
  console.log(`sectors extracted count (track 17): ${extractedCount} (0=clean synthetic, structured response confirmed)`);
  console.log(`inventory sync after inspection: ${syncText.split("\n")[0]}`);
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-200) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} e2e-disk-raw-default: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
