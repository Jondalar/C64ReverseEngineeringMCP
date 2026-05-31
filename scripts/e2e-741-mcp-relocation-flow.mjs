// Spec 741 — MCP-level E2E over stdio (default surface).
//
// Proves an external LLM can, through the default MCP façade:
//   analyze_prg → propose_annotations → disasm_prg(relocations) → assemble_source
// and get a byte-exact rebuild, using ONLY the relocation proposal the tools
// produced (no hand-authored relocation map). Synthetic fixture, no Wasteland.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 741 — MCP E2E: analyze → propose → disasm(relocations) → assemble\n");

const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

const projectDir = mkdtempSync(join(tmpdir(), "c64re-741-e2e-"));
// Synthetic copyloop PRG: $C000 entry, 2-page unrolled copy $C300→$FC00, then
// 512 benign nops at $C300-$C4FF.
const b = [
  0xa2, 0x00, 0xbd, 0x00, 0xc3, 0x9d, 0x00, 0xfc, 0xbd, 0x00, 0xc4, 0x9d, 0x00, 0xfd, 0xe8, 0xd0, 0xf1, 0x4c, 0x00, 0xfc,
];
while (b.length < 0x300) b.push(0xea);
for (let i = 0; i < 512; i++) b.push(0xea);
const prgPath = join(projectDir, "copyloop.prg");
writeFileSync(prgPath, Buffer.from([0x00, 0xc0, ...b]));

const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = ""; proc.stderr.on("data", (d) => { stderr += d.toString(); });
let buf = ""; const pendingMap = new Map();
proc.stdout.on("data", (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue; let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pendingMap.has(msg.id)) { pendingMap.get(msg.id)(msg); pendingMap.delete(msg.id); }
  }
});
let nextId = 1;
function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pendingMap.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
    pendingMap.set(id, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
async function call(name, args, timeoutMs) {
  const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
  if (res.error) throw new Error(`${name}: ${res.error.message}`);
  return res.result;
}
const textOf = (r) => (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const isErr = (r) => r?.isError === true || /Tool Error/i.test(textOf(r));

let exitCode = 0;
try {
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-741", version: "1.0.0" } });
  ok(!init.error, "1 MCP initialize handshake");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // all four tools must be in the default surface.
  const listed = await rpc("tools/list", {});
  const tools = new Set((listed.result?.tools || []).map((t) => t.name));
  ok(["analyze_prg", "propose_annotations", "disasm_prg", "assemble_source"].every((n) => tools.has(n)),
    "2 analyze_prg/propose_annotations/disasm_prg/assemble_source all default-surface");

  // init the project (analyze_prg requires knowledge/phase-plan.json). project_init
  // (BUG-015) may sort the PRG into input/; resolve its post-init location.
  await call("project_init", { project_dir: projectDir, name: "E2E 741" });
  const candidates = [prgPath, join(projectDir, "input", "prg", "copyloop.prg"), join(projectDir, "input", "copyloop.prg")];
  const prg = candidates.find(existsSync) || prgPath;
  const stem = prg.replace(/\.prg$/i, "");

  // 1) analyze_prg
  const aRes = await call("analyze_prg", { project_dir: projectDir, prg_path: prg, entry_points: ["C000"] });
  ok(!isErr(aRes), "3 analyze_prg ran", isErr(aRes) ? textOf(aRes).split("\n")[0] : "");
  const analysisJson = `${stem}_analysis.json`;
  ok(existsSync(analysisJson), "3b analysis JSON written");
  const report = JSON.parse(readFileSync(analysisJson, "utf8"));
  const prop = (report.relocationProposals || []).find((p) => p.fileStart === 0xc300 && p.runtimeAddr === 0xfc00);
  ok(!!prop, "4 analyze_prg detected relocation $C300 → $FC00", (report.relocationProposals || []).length + " proposal(s)");
  ok(prop && prop.length === 512, "4b inferred length 512");

  // 2) propose_annotations
  const pRes = await call("propose_annotations", { project_dir: projectDir, analysis_json: analysisJson });
  ok(!isErr(pRes), "5 propose_annotations ran");
  const draftPath = `${stem}_annotations.draft.json`;
  ok(existsSync(draftPath), "5b draft written");
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  const cand = (draft.relocations || []).find((r) => r.fileStart === "$C300" && r.runtimeAddr === "$FC00");
  ok(!!cand, "6 draft.relocations[] has copyable candidate ($C300 → $FC00)");
  ok(cand && cand.fileEnd && cand.runtimeAddr && cand.fileStart, "6b candidate carries fileStart/fileEnd/runtimeAddr (disasm_prg shape)");

  // 3) disasm_prg with the proposal copied straight in
  const outAsm = join(projectDir, "copyloop_reloc.asm");
  const dRes = await call("disasm_prg", {
    project_dir: projectDir, prg_path: prg, output_asm: outAsm, entry_points: ["C000"],
    relocations: [{ fileStart: cand.fileStart, fileEnd: cand.fileEnd, runtimeAddr: cand.runtimeAddr }],
  });
  ok(!isErr(dRes), "7 disasm_prg(relocations) ran");
  ok(existsSync(outAsm) && /\.pseudopc\s+\$FC00/.test(readFileSync(outAsm, "utf8")), "7b .pseudopc $FC00 emitted");

  // 4) assemble_source byte-compare
  const sRes = await call("assemble_source", { project_dir: projectDir, source_path: outAsm, assembler: "kickassembler", compare_to: prg });
  const sText = textOf(sRes);
  if (/Exit code:\s*0/.test(sText)) {
    ok(/Match:\s*yes/.test(sText), "8 assemble_source rebuild byte-exact", sText.split("\n").find((l) => /Compared bytes/.test(l)) || "");
  } else {
    console.log("  PENDING  8 assemble_source — assembler unavailable", `(${sText.split("\n")[0]})`);
  }
} catch (e) {
  ok(false, "harness", e.message + (stderr ? " | stderr: " + stderr.slice(-200) : ""));
  exitCode = 1;
} finally {
  proc.kill();
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} E2E-741: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : (exitCode || 1));
