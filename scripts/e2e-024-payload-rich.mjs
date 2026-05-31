// BUG-024 — a carved code-derived load (custom-loader / DD00 block, no CBM dir,
// no on-disk LUT) must be registerable as a FIRST-CLASS payload, exactly like a
// CBM/LUT-extracted one: shown in list_payloads with load/fmt/src/asm, placed in
// the memory map at its load address, carrying its disk track/sector spans for
// the disk view, and with its disassembly auto-linked.
//
// Proves the four-part fix against the REAL default-surface MCP server over stdio:
//   1. register_payload is on the DEFAULT surface (was advanced → unreachable).
//   2. source_prg_path registers the carved .prg + links it (no manual id lookup).
//   3. ASM stem-match: block_4000.prg ↔ block_4000_disasm.asm auto-linked.
//   4. The payload is rich: load addr + format + source + medium_spans + asm,
//      so list_payloads, the memory map and the disk view all have what they need.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("BUG-024 — carved code-derived load registers as a first-class payload\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }

const projectDir = mkdtempSync(join(tmpdir(), "c64re-024-"));
ok(!projectDir.startsWith(ROOT), "0 project dir is outside the repo", projectDir);

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
    let msg; try { msg = JSON.parse(line); } catch { continue; }
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
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const isErr = (r) => r?.isError === true || /Tool Error/i.test(textOf(r));

let exitCode = 0;
try {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-024", version: "1.0.0" } });
  ok(!init.error && init.result, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // PART 1 — register_payload on the DEFAULT surface (no C64RE_FULL_TOOLS).
  const listed = await rpc("tools/list", {});
  const tools = new Set((listed.result?.tools || []).map((t) => t.name));
  ok(tools.has("register_payload"), "2 register_payload IS on the default surface (BUG-024 part 1)",
    tools.has("register_payload") ? "present" : "MISSING");

  // Bring up a project.
  ok(!isErr(await callTool("project_init", { project_dir: projectDir, name: "BUG-024" })), "3 project_init", "");

  // A carved DD00-loader block + its disassembly, placed under analysis/ like a
  // real crack workflow (a scan root inventory_sync registers).
  const prgRel = "analysis/disk/wasteland/block_4000.prg";
  const asmRel = "analysis/disk/wasteland/block_4000_disasm.asm";
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(projectDir, "analysis/disk/wasteland"), { recursive: true });
  // $4000 load: 2-byte little-endian load addr header + a few bytes.
  writeFileSync(join(projectDir, prgRel), Buffer.from([0x00, 0x40, 0xa9, 0x00, 0x8d, 0x20, 0xd0, 0x60]));
  writeFileSync(join(projectDir, asmRel), "* = $4000\n  lda #$00\n  sta $d020\n  rts\n");

  // Register present files so the .asm becomes a tracked artifact (stem-match input).
  ok(!isErr(await callTool("project_inventory_sync", { project_dir: projectDir })), "4 inventory_sync registers placed files", "");

  // PART 2+3+4 — register the carved block by PATH; source + asm auto-resolve.
  const reg = await callTool("register_payload", {
    project_dir: projectDir,
    name: "engine_4000",
    source_prg_path: prgRel,
    load_address: 0x4000,
    address_start: 0x4000,
    address_end: 0x40ff,
    format: "raw",
    medium_spans: [{ kind: "sector", track: 20, sector: 5, length: 256 }],
  });
  const regText = textOf(reg);
  ok(!isErr(reg), "5 register_payload(source_prg_path,…) succeeds (BUG-024 part 2)", regText.split("\n")[0]);
  ok(/Source artifact: (?!\(none\)).+/.test(regText), "6 source .prg auto-registered + linked (part 2)",
    (regText.match(/Source artifact: .*/) || [""])[0]);
  ok(/ASM artifacts: [1-9]/.test(regText), "7 disassembly stem-matched + linked (part 3)",
    (regText.match(/ASM artifacts: .*/) || [""])[0]);
  ok(/Load: \$4000/.test(regText), "8 load address recorded (part 4)", (regText.match(/Load: .*/) || [""])[0]);

  // list_payloads shows the rich row.
  const lp = textOf(await callTool("list_payloads", { project_dir: projectDir }));
  ok(/engine_4000/.test(lp), "9 list_payloads lists the payload", "");
  ok(/load=\$4000 fmt=raw asm=[1-9]/.test(lp), "10 list_payloads row is rich (load/fmt/asm)",
    (lp.match(/engine_4000.*/) || [""])[0]);

  // Memory map places it at its load address (runtime view).
  ok(!isErr(await callTool("build_memory_map", { project_dir: projectDir })), "11 build_memory_map", "");
  const mmPath = join(projectDir, "views", "memory-map.json");
  const mm = existsSync(mmPath) ? JSON.parse(readFileSync(mmPath, "utf8")) : null;
  const region = mm && (mm.regions || mm.view?.regions || []).find((r) => r.start === 0x4000 && /engine_4000/.test(r.title || ""));
  ok(Boolean(region), "12 memory map has the payload region at $4000", region ? `${region.title} $${region.start.toString(16)}-$${region.end.toString(16)}` : "not found");

  // Knowledge store carries the disk spans the disk view needs.
  const entPath = join(projectDir, "knowledge", "entities.json");
  const ents = existsSync(entPath) ? JSON.parse(readFileSync(entPath, "utf8")) : {};
  const list = Array.isArray(ents) ? ents : (ents.items || ents.entities || ents.records || []);
  const payload = list.find((e) => e.name === "engine_4000" && e.kind === "payload");
  const span = payload?.mediumSpans?.find((s) => s.kind === "sector" && s.track === 20 && s.sector === 5);
  ok(Boolean(span), "13 payload carries disk medium span T20/S5 (disk view input, part 4)",
    span ? `T${span.track}/S${span.sector} len=${span.length}` : "no span");
  ok(payload?.payloadFormat === "raw" && payload?.payloadLoadAddress === 0x4000,
    "14 payload rich fields persisted (format+load)", `fmt=${payload?.payloadFormat} load=${payload?.payloadLoadAddress}`);
} catch (e) {
  console.error("FATAL", e.message); console.error(stderr.slice(-800)); exitCode = 2;
} finally {
  proc.stdin.end(); proc.kill();
}

console.log(`\nBUG-024: ${pass} pass, ${fail} fail`);
process.exit(exitCode || (fail > 0 ? 1 : 0));
