// C64RE #29 — a PRG in runtime_sandbox_run starts, and the report says what happened.
//
// Three PRGs on a machine of its own, through the real MCP tool:
//   1. a $0801 BASIC line `10 SYS2061` → autostart (RUN:) reaches the code, which writes
//      $2A to $C000 and loops;
//   2. machine code at $C100 with no BASIC line, started with run="$C100" → writes $2B;
//   3. a typed step after a plain boot: `I type "POKE49152,7{RETURN}"` lands ($C000 = 7).
// Each checks the byte the program wrote, not the log line — then that the log line
// agrees with it. Needs a TRX64 daemon (the sibling release build, or TRX64_DAEMON_BIN);
// the sandbox is a child of each call and gone when it returns.
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

const proj = mkdtempSync(join(tmpdir(), "c64re-sbx-prg-"));

// 10 SYS2061 — the line, the end-of-program link, then code at $080D.
const basic = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00,
  0xa9, 0x2a, 0x8d, 0x00, 0xc0, 0x4c, 0x12, 0x08]; // LDA #$2A · STA $C000 · JMP *
const mc = [0x00, 0xc1, 0xa9, 0x2b, 0x8d, 0x00, 0xc0, 0x4c, 0x05, 0xc1]; // $C100: LDA #$2B · STA $C000 · JMP *

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
const byteAtC000 = (out) => {
  const m = /^\s*\$C000\s+([0-9a-f]{2})\b/im.exec(out);
  return m ? parseInt(m[1], 16) : null;
};

try {
  console.log("C64RE #29 — a PRG in the sandbox starts, and the report says so\n");
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-sandbox-prg", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { project_dir: proj, name: "sandbox-prg-start" });
  await call("agent_onboard", { project_dir: proj });
  // Written after project_init, which sorts top-level media into input/.
  writeFileSync(join(proj, "basic.prg"), Buffer.from(basic));
  writeFileSync(join(proj, "mc.prg"), Buffer.from(mc));

  const a = await call("runtime_sandbox_run", { project_dir: proj, media_path: "basic.prg", run_frames: 50, read_memory: ["$C000:1"] });
  check(byteAtC000(a) === 0x2a, "1 a $0801 BASIC line autostarts: the code wrote $2A", `$C000=${byteAtC000(a)?.toString(16)}`);
  check(/RUN: typed by the (runtime|sandbox); PC \$/.test(a) && !/did not start/.test(a), "1b the report says it started", (/RUN:[^\n]*/.exec(a) ?? ["no RUN line"])[0]);

  const b = await call("runtime_sandbox_run", { project_dir: proj, media_path: "mc.prg", run: "$C100", run_frames: 10, read_memory: ["$C000:1"] });
  check(byteAtC000(b) === 0x2b, "2 run=$C100 starts machine code with no BASIC line", `$C000=${byteAtC000(b)?.toString(16)}`);
  check(/started at \$C100; PC \$C1/.test(b), "2b the report names the entry and where the CPU is", (/started at[^\n]*/.exec(b) ?? ["no start line"])[0]);

  const c = await call("runtime_sandbox_run", { project_dir: proj, steps: ['I type "POKE49152,7{RETURN}"', "I wait 10 frames"], read_memory: ["$C000:1"] });
  check(byteAtC000(c) === 7, "3 a typed step reaches BASIC: POKE49152,7 landed", `$C000=${byteAtC000(c)?.toString(16)}`);

  const d = await call("runtime_sandbox_run", { project_dir: proj, media_path: "mc.prg", run: "nope" });
  check(/run must be an address/.test(d), "4 a malformed run is refused before a machine starts");
} catch (e) {
  check(false, "harness", e.message);
} finally {
  server.stdin.end();
  server.kill();
  rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} sandbox PRG start: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
