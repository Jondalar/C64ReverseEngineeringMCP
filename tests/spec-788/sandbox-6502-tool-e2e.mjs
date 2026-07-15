// Spec 788 tail (piece B) — sandbox_6502_run TOOL e2e over live MCP stdio.
//
// Drives the REAL `sandbox_6502_run` MCP tool (dist/cli.js) end-to-end and
// asserts the exact TEXT lines it emits — proving the tool's input schema and
// output line format are unchanged after the engine was rerouted onto the TRX64
// real 6502 core. The routines run for real on the authoritative core.
//
// Run (after `npm run build`):
//   node tests/spec-788/sandbox-6502-tool-e2e.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(ROOT, "dist", "cli.js");
const trx64cli = process.env.C64RE_TRX64CLI_BIN?.trim()
  || resolvePath(ROOT, "..", "TRX64", "target", "release", "trx64cli");

let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 788 tail — sandbox_6502_run tool e2e (live MCP stdio, real core)\n");

if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build`"); process.exit(2); }
if (!existsSync(trx64cli)) { console.log(`[skip] trx64cli not found at ${trx64cli} — build it in ../TRX64`); process.exit(0); }

const projectDir = mkdtempSync(join(tmpdir(), "c64re-e2e-sandbox6502-"));

const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_ROOT: ROOT, C64RE_FULL_TOOLS: "" },
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
function rpc(method, params, timeoutMs = 30000) {
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
const isErr = (result) => result?.isError === true || /Tool Error|c64re error/i.test(textOf(result));
// This tool signals failure through cliResultToContent: a "[stderr]" block plus
// a "[exit code N]" trailer (no isError flag).
const toolErrored = (result) => /\[exit code [1-9]/.test(textOf(result)) || /\[stderr\]/.test(textOf(result));

let exitCode = 0;
try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "e2e-sandbox6502", version: "1.0.0" },
  });
  ok(!init.error && init.result, "1 MCP initialize handshake", init.error ? init.error.message : "ok");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // sandbox_6502_run must be on the DEFAULT surface (no C64RE_FULL_TOOLS).
  const listed = await rpc("tools/list", {});
  const toolSet = new Set((listed.result?.tools || []).map((t) => t.name));
  ok(toolSet.has("sandbox_6502_run"), "2 sandbox_6502_run on the default MCP surface");

  await callTool("project_init", { project_dir: projectDir, name: "E2E Sandbox 6502" });

  // ── Case A: RAM routine fills $0400..$0403 with $ab; harvest + write span + PRG.
  // c000: LDX #$00 / LDA #$ab / STA $0400,X / INX / CPX #$04 / BNE / RTS
  const resA = await callTool("sandbox_6502_run", {
    loads: [{ hex_bytes: "a200a9ab9d0004e8e004d0f860", address: "c000" }],
    initial_pc: "c000",
    return_memory_ranges: [{ start: "0400", end: "0403" }],
    output_path: "outA.prg",
  });
  const tA = textOf(resA);
  const lA = tA.split("\n");
  ok(!isErr(resA), "A0 no Tool Error", isErr(resA) ? lA[0] : "ok");
  ok(lA[0] === "sandbox_6502_run finished.", "A1 header line unchanged", lA[0]);
  ok(lA[1] === "Stop reason: sentinel_rts", "A2 stop reason", lA[1]);
  ok(/^Steps: \d+$/.test(lA[2]), "A3 steps line shape", lA[2]);
  ok(/^Final PC: \$FFFE A=\$AB X=\$04 Y=\$00 SP=\$FF FL=\$[0-9A-F]{2}$/.test(lA[3]), "A4 final regs line", lA[3]);
  ok(tA.includes("Stream pos: 0"), "A5 stream pos", "Stream pos: 0");
  ok(tA.includes("Writes returned: 4"), "A6 writes returned (distinct)", "Writes returned: 4");
  ok(tA.includes("Write span: $0400-$0403 (4 bytes)"), "A7 write span", "Write span: $0400-$0403 (4 bytes)");
  ok(tA.includes("Memory $0400-$0403 (4 bytes): AB AB AB AB"), "A8 memory snapshot preview", "AB AB AB AB");
  ok(/Wrote PRG: .*outA\.prg \(\$0400-\$0403\)/.test(tA), "A9 wrote PRG line", tA.split("\n").find((l) => l.startsWith("Wrote PRG")) || "");
  const prgA = readFileSync(join(projectDir, "outA.prg"));
  ok(prgA.length === 6 && prgA[0] === 0x00 && prgA[1] === 0x04 && [...prgA.subarray(2)].every((b) => b === 0xab),
    "A10 PRG = load hdr $0400 + AB*4", [...prgA].map((b) => b.toString(16)).join(" "));

  // ── Case B: seed A/X/Y/SP at entry; routine stores them to $0410..$0413.
  // Reseeding SP off $FD makes the RTS-sentinel unreachable, so end via a
  // stop_pc JMP. c000: STA $0410 / STX $0411 / STY $0412 / TSX / STX $0413 / JMP $c010
  const resB = await callTool("sandbox_6502_run", {
    loads: [{ hex_bytes: "8d10048e11048c1204ba8e13044c10c0", address: "c000" }],
    initial_pc: "c000",
    initial_a: 0x11, initial_x: 0x22, initial_y: 0x33, initial_sp: 0x80,
    stop_pc: "c010",
    return_memory_ranges: [{ start: "0410", end: "0413" }],
  });
  const tB = textOf(resB);
  ok(!isErr(resB), "B0 no Tool Error", isErr(resB) ? tB.split("\n")[0] : "ok");
  ok(tB.includes("Stop reason: stop_pc"), "B1a stop reason", "Stop reason: stop_pc");
  ok(/^Final PC: \$C010 A=\$11 /m.test(tB), "B1 entry A observed", tB.split("\n").find((l) => l.startsWith("Final PC")) || "");
  ok(tB.includes("Memory $0410-$0413 (4 bytes): 11 22 33 80"), "B2 entry A/X/Y/SP stored", "11 22 33 80");

  // ── Case C: stream-hook get_byte at $c100 fed "11223344".
  // c000: LDX #$00 / JSR $c100 / STA $0420,X / INX / CPX #$04 / BNE / RTS
  const resC = await callTool("sandbox_6502_run", {
    loads: [
      { hex_bytes: "a2002000c19d2004e8e004d0f560", address: "c000" },
      { hex_bytes: "60", address: "c100" },
    ],
    initial_pc: "c000",
    stream_hook_pcs: ["c100"],
    input_stream_hex: "11223344",
    return_memory_ranges: [{ start: "0420", end: "0423" }],
  });
  const tC = textOf(resC);
  ok(!isErr(resC), "C0 no Tool Error", isErr(resC) ? tC.split("\n")[0] : "ok");
  ok(tC.includes("Stream pos: 4"), "C1 stream pos advanced", "Stream pos: 4");
  ok(tC.includes("Memory $0420-$0423 (4 bytes): 11 22 33 44"), "C2 fed stream harvested", "11 22 33 44");

  // ── Case D: two independent memory ranges → two Memory lines.
  // c000: LDA #$aa / STA $0430 / LDA #$bb / STA $0440 / RTS
  const resD = await callTool("sandbox_6502_run", {
    loads: [{ hex_bytes: "a9aa8d3004a9bb8d400460", address: "c000" }],
    initial_pc: "c000",
    return_memory_ranges: [{ start: "0430", end: "0430" }, { start: "0440", end: "0440" }],
  });
  const tD = textOf(resD);
  ok(!isErr(resD), "D0 no Tool Error", isErr(resD) ? tD.split("\n")[0] : "ok");
  ok(tD.includes("Memory $0430-$0430 (1 bytes): AA"), "D1 range 1 snapshot", "AA");
  ok(tD.includes("Memory $0440-$0440 (1 bytes): BB"), "D2 range 2 snapshot", "BB");
  ok(tD.includes("Writes returned: 2"), "D3 two distinct writes", "Writes returned: 2");

  // ── Case E: a read-only ROM overlay mapping is rejected (halt-and-report).
  const resE = await callTool("sandbox_6502_run", {
    loads: [{ hex_bytes: "60", address: "8000", mapping: "ef_romh" }],
    initial_pc: "8000",
  });
  ok(toolErrored(resE), "E0 read-only overlay mapping rejected (tool error envelope)", textOf(resE).split("\n").slice(0, 2).join(" | "));
  ok(/read-only ROM overlay/i.test(textOf(resE)), "E1 actionable rejection message", "");
} catch (e) {
  fail++; exitCode = 1;
  console.log(`  FAIL harness: ${e?.message ?? e}`);
  if (stderr) console.log(`  stderr: ${stderr.split("\n").slice(-8).join("\n")}`);
} finally {
  proc.stdin.end();
  proc.kill();
}

console.log(`\nsandbox-6502-tool-e2e: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : (exitCode || 0));
