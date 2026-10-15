// C64RE #91 — a private machine never changes the project's medium.
//
// The sandbox tools say the medium is mounted as a copy, but the runtime writes a
// mounted disk back to the file it was opened from when the machine ends. A program
// that writes to its disk (here: BASIC `SAVE"T",8`) must leave the project's D64
// byte-identical, however the machine was started and however it ended:
//   1. runtime_sandbox_run;
//   2. runtime_scene_reel (`Given the disk`) and a mid-run `I insert the disk`;
//   3. runtime_sandbox_start ended by runtime_sandbox_end;
//   4. runtime_sandbox_start ended by its budget.
// A positive control checks that the SAVE really reached the machine's disk
// (the drive was busy writing). Needs a TRX64 daemon (the sibling release build,
// or TRX64_DAEMON_BIN).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const FIXTURE = join(ROOT, "samples/fixtures/load-fidelity/lf-001-1block.d64");

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const md5 = (p) => createHash("md5").update(readFileSync(p)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proj = mkdtempSync(join(tmpdir(), "c64re-issue91-"));

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
const rpc = (method, params, timeoutMs = 240000) => new Promise((resolve, reject) => {
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

// A fresh copy of the fixture in the project for each case, so one case cannot hide another.
const disk = (name) => { const p = join(proj, name); copyFileSync(FIXTURE, p); return p; };
const SAVE_STEPS = [
  "I wait 30 frames",
  'I type "SAVE{QUOTE}T{QUOTE},8{RETURN}"',
  "I wait until the drive is idle within 3000 frames",
  "I wait 20 frames",
];

try {
  console.log("C64RE #91 — a private machine never changes the project's medium\n");
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e-issue91", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await call("project_init", { project_dir: proj, name: "issue91" });
  await call("agent_onboard", { project_dir: proj });

  // 1. runtime_sandbox_run
  {
    const p = disk("run.d64"); const before = md5(p);
    const out = await call("runtime_sandbox_run", { project_dir: proj, media_path: "run.d64", steps: SAVE_STEPS, screen: true });
    check(/SAVING T/i.test(out), "1a control: the SAVE ran on the machine", (/SAVING[^\n]*/i.exec(out) ?? ["no SAVING line"])[0]);
    check(md5(p) === before, "1 runtime_sandbox_run leaves the project's D64 byte-identical");
  }

  // 2. runtime_scene_reel: the origin disk, and a disk inserted mid-run
  {
    const p = disk("reel.d64"); const q = disk("reel2.d64"); const before = md5(p), before2 = md5(q);
    const feature = [
      "Scenario: save to the disk",
      '  Given the disk "reel.d64"',
      "  When I wait 30 frames",
      '  And I type "SAVE{QUOTE}T{QUOTE},8{RETURN}"',
      "  And I wait until the drive is idle within 3000 frames",
      "  And I capture \"saved\"",
      '  And I insert the disk "reel2.d64"',
      "  And I wait 30 frames",
      '  And I type "SAVE{QUOTE}U{QUOTE},8{RETURN}"',
      "  And I wait until the drive is idle within 3000 frames",
      "  And I capture \"saved2\"",
      "  Then the reel has at least 1 screens",
    ].join("\n");
    await call("runtime_scene_reel", { project_dir: proj, feature, out_path: join(proj, "reel.gif") });
    check(md5(p) === before, "2 runtime_scene_reel leaves the origin D64 byte-identical");
    check(md5(q) === before2, "2b ... and a disk inserted mid-run");
  }

  // 3. runtime_sandbox_start + runtime_sandbox_end
  {
    const p = disk("session.d64"); const before = md5(p);
    const s = await call("runtime_sandbox_start", { project_dir: proj, purpose: "issue 91 session end", budget_minutes: 5, media_path: "session.d64" });
    const id = (/session_id:\s*(\S+)/.exec(s) ?? [])[1];
    check(!!id, "3a the session started", id ?? s.slice(0, 120));
    if (id) {
      await call("runtime_type", { session_id: id, text: 'SAVE"T",8\n', settle: true, extra_frames: 300 });
      await call("runtime_sandbox_end", { session_id: id, outcome: "reached", summary: "issue 91 test" });
    }
    check(md5(p) === before, "3 a session ended by runtime_sandbox_end leaves the D64 byte-identical");
  }

  // 4. runtime_sandbox_start ended by its own budget
  {
    const p = disk("budget.d64"); const before = md5(p);
    const s = await call("runtime_sandbox_start", { project_dir: proj, purpose: "issue 91 budget end", budget_minutes: 0.5, media_path: "budget.d64" });
    const id = (/session_id:\s*(\S+)/.exec(s) ?? [])[1];
    if (id) await call("runtime_type", { session_id: id, text: 'SAVE"T",8\n', settle: true, extra_frames: 300 });
    await sleep(45_000);
    const list = await call("runtime_sandbox_list", {});
    check(new RegExp(`${id}\\s+ended`).test(list), "4a the session ended by itself", id ?? "no id");
    check(md5(p) === before, "4 a session ended by its budget leaves the D64 byte-identical");
  }
} catch (e) {
  check(false, "harness", e.message);
} finally {
  server.stdin.end();
  server.kill();
  rmSync(proj, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"} issue 91 media copy: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
