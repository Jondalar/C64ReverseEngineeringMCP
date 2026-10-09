// C64RE #49 — `I wait until the CPU reaches $XXXX` is an execution breakpoint, not a sample.
//
// A PRG at $C100 hooks the KERNAL IRQ vector ($0314) to a 2-instruction handler at $C120
// (INC $C001 / JMP $EA31) and spins in `JMP *`. The handler runs ~10 cycles once a frame, so
// the PC is never there at a frame boundary. Checks, through the real MCP tool:
//   1. reaches $C120 (the handler) within 10 frames          — passes
//   2. reaches $EA31 (KERNAL ROM, reached through the IRQ) within 10   — passes
//   3. reaches $C200 (never executed) within 5 frames        — times out, with the old message shape
//   4. the breakpoint is gone afterwards: a later plain wait runs, a second wait works and
//      $C001 keeps counting
//   2b. reaches $FF48 (the IRQ handler's first instruction, right after the 7-cycle entry) within 10
// Needs a TRX64 daemon (the sibling release build, or C64RE_TRX64_BIN).
//
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };


const proj = mkdtempSync(join(tmpdir(), "c64re-sbx-pc-"));

const server = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
const pending = new Map();
server.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params, timeoutMs = 180000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) throw new Error(`${name}: ${r.error.message}`);
  return (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
const prg = (() => {
  const code = Buffer.alloc(0x20 + 6);
  Buffer.from([0x78, 0xa9, 0x20, 0x8d, 0x14, 0x03, 0xa9, 0xc1, 0x8d, 0x15, 0x03, 0x58, 0x4c, 0x0c, 0xc1]).copy(code, 0);
  Buffer.from([0xee, 0x01, 0xc0, 0x4c, 0x31, 0xea]).copy(code, 0x20);
  return Buffer.concat([Buffer.from([0x00, 0xc1]), code]);
})();
const run = (steps, extra = {}) => call("runtime_sandbox_run", { project_dir: proj, media_path: "irq.prg", run: "$C100", steps, read_memory: ["$C001:1"], ...extra });

try {
  console.log("C64RE #49 — 'the CPU reaches' is an execution breakpoint\n");
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-sandbox-wait-pc", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { project_dir: proj, name: "sandbox-wait-pc" });
  await call("agent_onboard", { project_dir: proj });
  writeFileSync(join(proj, "irq.prg"), prg);

  const a = await run(["I wait until the CPU reaches $C120 within 10 frames"]);
  check(/reaches \$C120 within 10 frames — after \d+ frames/.test(a), "1 the IRQ handler at $C120 is reached within 10 frames", (/reaches[^\n]*/.exec(a) ?? [a.slice(0, 200)])[0]);

  const b = await run(["I wait until the CPU reaches $EA31 within 10 frames"]);
  check(/reaches \$EA31 within 10 frames — after \d+ frames/.test(b), "2 KERNAL ROM $EA31 is reached within 10 frames", (/reaches[^\n]*/.exec(b) ?? [b.slice(0, 200)])[0]);

  const f = await run(["I wait until the CPU reaches $FF48 within 10 frames"]);
  check(/reaches \$FF48 within 10 frames — after \d+ frames/.test(f), "2b the IRQ entry $FF48 itself is reached within 10 frames", (/reaches[^\n]*|did not happen[^\n]*/.exec(f) ?? [f.slice(0, 200)])[0]);

  const c = await run(["I wait until the CPU reaches $C200 within 5 frames"]);
  check(/did not happen within 5 frames \(PC now \$[0-9A-F]{4}\)/.test(c), "3 an address never executed times out with the PC", (/did not happen[^\n]*/.exec(c) ?? [c.slice(0, 200)])[0]);

  const d = await run(["I wait until the CPU reaches $C120 within 10 frames", "I wait 5 frames", "I wait until the CPU reaches $C120 within 10 frames"]);
  check((d.match(/reaches \$C120 within 10 frames — after \d+ frames/g) ?? []).length === 2, "4 the breakpoint is gone after the wait: a later wait runs and a second wait works", d.slice(0, 200).replace(/\n/g, " | "));
  const cnt = /\$C001\s+([0-9a-f]{2})/i.exec(d);
  check(cnt && parseInt(cnt[1], 16) >= 5, "4b the IRQ handler kept running through the later steps", `$C001=${cnt?.[1]}`);
} catch (e) {
  check(false, "harness", e.message);
} finally {
  server.stdin.end();
  server.kill();
  rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} sandbox wait-for-PC: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
