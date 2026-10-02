// C64RE #33 — a .d81 runs on a private machine: drive 8 becomes a 1581.
//
// A generated D81 holds one PRG (`10 SYS2061` · LDA #$42 · STA $C000 · JMP *). Each case
// LOADs it from the drive, RUNs it, and decides `Then $C000 is $42` — the byte only the
// program can have written, so a pass means the 1581 really read the disk.
//   1. runtime_sandbox_run with the .d81 as the medium: the runtime refuses it for the
//      1541, the runner fits a 1581, and says so.
//   2. drive_type "1581" on a bare machine, the D81 inserted by a step.
//   3. runtime_scene_reel from the same .d81: a reel of the program's own screen.
// Needs a TRX64 daemon and dos1581-318045-02.bin beside the C64 ROMs.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { d81WithPrg } from "./lib/d81-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };

const dir = mkdtempSync(join(tmpdir(), "c64re-d81-"));
const prg = Uint8Array.from([0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00,
  0xa9, 0x42, 0x8d, 0x00, 0xc0, 0x4c, 0x12, 0x08]);
const LOAD_AND_RUN = [
  'I type "LOAD{QUOTE}*{QUOTE},8,1{RETURN}"',
  "I wait 600 frames",
  'I type "RUN{RETURN}"',
  "I wait 20 frames",
];

const server = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: dir, C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = ""; const pending = new Map(); let nextId = 1;
server.stdout.on("data", (d) => {
  buf += d.toString(); let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const rpc = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const call = async (name, args) => ((await rpc("tools/call", { name, arguments: args })).result?.content ?? []).map((x) => x.text).join("\n");

try {
  console.log("C64RE #33 — a .d81 on a private machine\n");
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-d81", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { project_dir: dir, name: "d81" });
  await call("agent_onboard", { project_dir: dir });
  writeFileSync(join(dir, "hello.d81"), d81WithPrg("hello", prg)); // after project_init, which sorts media

  const a = await call("runtime_sandbox_run", { project_dir: dir, media_path: "hello.d81", steps: [...LOAD_AND_RUN, "Then $C000 is $42"] });
  check(/drive 8 is now a 1581: the medium goes into one/.test(a), "1 a .d81 medium fits drive 8 with a 1581, and the log says so", (/drive 8[^\n]*/.exec(a) ?? [a.slice(0, 200)])[0]);
  check(/checks: 1 passed, 0 failed/.test(a), "1b the program LOADed from the 1581 and ran: $C000 = $42", (/checks:[^\n]*|FAIL[^\n]*/.exec(a) ?? ["no checks"])[0]);

  const b = await call("runtime_sandbox_run", { project_dir: dir, drive_type: "1581", steps: ['I insert the disk "hello.d81"', ...LOAD_AND_RUN, "Then $C000 is $42"] });
  check(/drive 8 is a 1581, as asked/.test(b) && !/drive 8 is now a 1581/.test(b), "2 drive_type 1581 fits it from the start — the insert needs no refit");
  check(/checks: 1 passed, 0 failed/.test(b), "2b a D81 inserted by a step LOADs and runs", (/checks:[^\n]*|FAIL[^\n]*/.exec(b) ?? ["no checks"])[0]);

  const feature = ["Feature: d81 reel", "  Scenario: hello from a 1581", '    Given the disk "hello.d81"',
    ...LOAD_AND_RUN.map((s) => `    And ${s}`), '    And I capture "ran"', "    Then the reel has at least 1 screens"].join("\n").replace("    And I type", "    When I type");
  const c = await call("runtime_scene_reel", { project_dir: dir, feature, out_path: join(dir, "reel.gif") });
  check(existsSync(join(dir, "reel.gif")) && !/error|refused|does not fit/i.test(c.split("\n")[0]), "3 runtime_scene_reel runs a .d81 scenario to a reel", c.split("\n").slice(0, 2).join(" | "));
} catch (e) {
  check(false, "harness", e.message);
} finally {
  server.stdin.end(); server.kill();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-d81: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
