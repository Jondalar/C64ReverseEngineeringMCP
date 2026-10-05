// Spec 896 items 4, 5, 9, 10 — a self-extracting file depacks, `until` runs to a PC on the
// runtime, a run says what it actually advanced, and a refusal after a restart says why.
//
// Temp directories only. Every runtime test starts its OWN daemon on a port picked at run
// time and kills it at the end; nothing touches :4312 or any daemon it did not start. The
// parts that need a TRX64 daemon / trx64cli SKIP LOUDLY when none is found (C64RE_TRX64_BIN,
// C64RE_TRX64CLI_BIN, or the sibling checkout); the rest runs anywhere.
//
//   4   sandbox_depack: a self-extracting PRG (source == loader) depacks byte-exact from
//       its own entry; two DIFFERENT overlapping images are still refused
//   5   runtime_session_run {until pc}: stops at the PC; an unreachable PC says so; every
//       other kind is refused by name, with no internal slice number in the message
//   9   the answer carries cycles after - before from the daemon; a zero-cycle run says
//       the machine did not advance and never says "ran up to"
//   10  save_finding in a project onboarded by an earlier server process: the refusal says
//       the server was (re)started since, and that is why; a never-onboarded project does not
//   (item 7 is not here: the loss is inside the runtime's sandbox harvest, see the spec)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const { resolveDaemonSpawn } = await import(join(ROOT, "dist/runtime/resolve-daemon-spawn.js"));
const { ProjectKnowledgeService } = await import(join(ROOT, "dist/project-knowledge/service.js"));
const { describeRunAdvance, planUntil } = await import(join(ROOT, "dist/runtime/session-run.js"));

let pass = 0, fail = 0, skipped = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${String(d).replace(/\s+/g, " ").slice(0, 220)})` : ""}`); };
const skip = (m) => { skipped++; console.log(`  SKIP  ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "c64re-896-")));
const scratch = (n) => { const d = join(base, n); mkdirSync(d, { recursive: true }); return d; };

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("C64RE_") || /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|PREFIX|NAMESPACE)$/.test(k)) delete env[k];
  for (const k of ["C64RE_TRX64_BIN", "C64RE_TRX64CLI_BIN", "C64RE_RUNTIME_BIN", "C64RE_ROOT"]) if (process.env[k]) env[k] = process.env[k];
  return {
    ...env,
    GIT_AUTHOR_NAME: "c64re smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "c64re smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid",
    C64RE_RUNTIME_AUTOSTART: "0", C64RE_FULL_TOOLS: "",
    ...extra,
  };
}

function startMcp(projectDir, extraEnv = {}) {
  const proc = spawn(process.execPath, [cli], { cwd: tmpdir(), env: cleanEnv({ C64RE_PROJECT_DIR: projectDir, ...extraEnv }), stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pend = new Map(); let n = 1;
  proc.stdout.on("data", (b) => { buf += b; let nl; while ((nl = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); let m; try { m = JSON.parse(l); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  const call = (method, params) => new Promise((res, rej) => { const id = n++; pend.set(id, res); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => { if (pend.delete(id)) rej(new Error(`timeout ${method}`)); }, 180_000); });
  const ready = call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-896", version: "1" } })
    .then(() => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"));
  const tool = async (name, args) => { await ready; return ((await call("tools/call", { name, arguments: args })).result?.content ?? []).map((c) => c.text).join("\n"); };
  return { tool, stop: () => { try { proc.stdin.end(); proc.kill(); } catch { /* gone */ } } };
}

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); s.on("error", rej); });

// ── hermetic parts ───────────────────────────────────────────────────────────────────
console.log("Spec 896 — runtime items (4, 5, 9, 10)\n");

// 9 — the wording, from numbers (the daemon half is below)
{
  const none = describeRunAdvance({ requestedCycles: 4_000_000, before: 39314, after: 39314, pc: 0xfd77, via: "Runtime Daemon" });
  check(/did not advance/i.test(none) && !/ran up to/i.test(none) && /39314/.test(none) && /\$FD77/.test(none),
    "9a zero advance says the machine did not advance, and never 'ran up to'", none);
  const some = describeRunAdvance({ requestedCycles: 4_000_000, before: 1000, after: 5001000, pc: 0xea31, via: "Runtime Daemon" });
  check(/Advanced 5000000 cycles/.test(some) && /cycles=5001000/.test(some), "9b the figure is after - before, not the request", some);
  const miss = describeRunAdvance({ before: 0, after: 10_000_000, pc: 0x1234, via: "x", until: { addr: 2, halted: false } });
  check(/Did NOT reach \$0002/.test(miss), "5a an until that was not reached says so", miss);
}

// 5 — refusals by name, before the machine is touched
for (const [u, name] of [[{ kind: "raster", line: 100 }, "raster"], [{ kind: "iec", edge: "atn-fall" }, "iec"], [{ kind: "stable_screen" }, "stable_screen"]]) {
  let msg = "";
  try { planUntil(u); } catch (e) { msg = e.message; }
  check(msg.includes(`"${name}"`) && !/slice|744|Spec/i.test(msg), `5b until.kind=${name} is refused by name, no internal numbers`, msg);
}
{
  let m1 = "", m2 = "";
  try { planUntil({ kind: "pc", pc: "085E", side: "drive" }); } catch (e) { m1 = e.message; }
  try { planUntil({ kind: "pc", pc: "085E", count: 3 }); } catch (e) { m2 = e.message; }
  check(/drive/.test(m1) && /count=3/.test(m2) && planUntil({ kind: "pc", pc: "$085e" }).addr === 0x085e, "5c drive side and count>1 are refused by name; pc parses as hex");
}

// 10 — through the server, no daemon
{
  const proj = scratch("proj10");
  const boot = startMcp(proj);
  await boot.tool("project_init", { project_dir: proj, name: "896-10" });
  const fresh = await boot.tool("save_finding", { project_dir: proj, kind: "observation", title: "t", summary: "s" });
  check(/has not onboarded/.test(fresh) && !/\(re\)started/.test(fresh), "10a a project nobody onboarded: plain refusal, no restart claim", fresh.split("\n").slice(0, 3).join(" | "));
  const onb = await boot.tool("agent_onboard", { project_dir: proj });
  check(!/refused/.test(onb), "10b agent_onboard clears the first server");
  const ok = await boot.tool("save_finding", { project_dir: proj, kind: "observation", title: "t", summary: "s" });
  check(!/has not onboarded/.test(ok), "10c the onboarded server works");
  boot.stop();
  await sleep(300);
  const second = startMcp(proj);
  const refused = await second.tool("save_finding", { project_dir: proj, kind: "observation", title: "t2", summary: "s" });
  check(/has not onboarded/.test(refused) && /\(re\)started since/.test(refused) && /per server process/.test(refused) && /That is why/.test(refused),
    "10d a restarted server says it was (re)started since the last onboarding, and that is why", refused.split("\n").slice(0, 4).join(" | "));
  const after = await second.tool("agent_onboard", { project_dir: proj });
  const again = await second.tool("save_finding", { project_dir: proj, kind: "observation", title: "t2", summary: "s" });
  check(!/refused/.test(after) && !/has not onboarded/.test(again), "10e and onboarding again clears it");
  second.stop();
}

// ── the daemon / trx64cli parts ──────────────────────────────────────────────────────
const sibling = join(ROOT, "..", "TRX64", "target", "release");
const cliBin = process.env.C64RE_TRX64CLI_BIN || join(sibling, "trx64cli");

// 4 — self-extracting depack (needs trx64cli)
if (!existsSync(cliBin)) {
  skip(`4 sandbox_depack self-extracting — no trx64cli at ${cliBin} (set C64RE_TRX64CLI_BIN)`);
} else {
  const proj = scratch("proj4");
  new ProjectKnowledgeService(proj).initProject({ name: "896-4" });
  // $0801: LDX #0 / LDA $0820,X / STA $4000,X / INX / CPX #16 / BNE loop / RTS, data at $0820.
  const code = [0xa2, 0x00, 0xbd, 0x20, 0x08, 0x9d, 0x00, 0x40, 0xe8, 0xe0, 0x10, 0xd0, 0xf5, 0x60];
  const data = Buffer.from("SELF-EXTRACTED!!", "latin1");
  const body = Buffer.concat([Buffer.from(code), Buffer.alloc(0x20 - 0x01 - code.length), data]);
  const prg = Buffer.concat([Buffer.from([0x01, 0x08]), body]);
  mkdirSync(join(proj, "in"), { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(proj, "in", "self.prg"), prg);
  // another image over the same addresses, different bytes
  writeFileSync(join(proj, "in", "other.bin"), Buffer.alloc(8, 0x55));
  const m = startMcp(proj, { C64RE_TRX64CLI_BIN: cliBin });
  await m.tool("agent_onboard", { project_dir: proj });
  const r = await m.tool("sandbox_depack", {
    project_dir: proj, input_path: "in/self.prg", offset: "2", resident_loader_path: "in/self.prg",
    entry_pc: "0801", source_load_address: "0801", output_path: "out/self.prg",
  });
  const outFile = join(proj, "out", "self.prg");
  const out = existsSync(outFile) ? readFileSync(outFile) : Buffer.alloc(0);
  check(!/FAILED/.test(r) && out.length === 18 && out[0] === 0x00 && out[1] === 0x40 && out.subarray(2).equals(data),
    "4a source == loader: the self-extracting PRG depacks to $4000, byte-exact", r.split("\n").slice(-2).join(" | "));
  const r2 = await m.tool("sandbox_depack", {
    project_dir: proj, input_path: "in/other.bin", resident_loader_path: "in/self.prg",
    entry_pc: "0801", source_load_address: "0810", output_path: "out/other.prg",
  });
  check(/FAILED/.test(r2) && /overlaps the resident loader window/.test(r2) && !existsSync(join(proj, "out", "other.prg")),
    "4b a DIFFERENT image over the loader's addresses is still refused", r2.split("\n").slice(-2).join(" | "));
  m.stop();
}

// 5 + 9 — a daemon of our own
const probeProj = scratch("probe");
new ProjectKnowledgeService(probeProj).initProject({ name: "896-daemon" });
const port = await freePort();
const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: probeProj, port: String(port) });
if (plan.mode === "none") {
  skip("5/9 runtime_session_run against a daemon — no TRX64 daemon found (set C64RE_TRX64_BIN)");
} else {
  const ENDPOINT = `ws://127.0.0.1:${port}`;
  const daemon = spawn(plan.cmd, [...plan.args, "--headless", "--idle-exit", "300"], { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv({ C64RE_ROOT: ROOT }) });
  let dlog = ""; daemon.stdout.on("data", (b) => { dlog += b; }); daemon.stderr.on("data", (b) => { dlog += b; });
  let m;
  try {
    const ws = await (async () => {
      for (let i = 0; i < 200; i++) {
        try { return await new Promise((res, rej) => { const w = new WebSocket(ENDPOINT); w.once("open", () => res(w)); w.once("error", rej); }); } catch { await sleep(150); }
      }
      throw new Error(`daemon never answered on ${port}: ${dlog.slice(-300)}`);
    })();
    let rid = 1;
    const rpc = (method, params = {}) => new Promise((res, rej) => {
      const id = rid++;
      const on = (data, bin) => { if (bin) return; const j = JSON.parse(data.toString()); if (j.id === id) { ws.off("message", on); j.error ? rej(new Error(j.error.message)) : res(j.result); } };
      ws.on("message", on);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    const cycles = async () => (await rpc("session/state", { session_id: "shared" })).c64Cycles;

    m = startMcp(probeProj, { C64RE_RUNTIME_ENDPOINT: ENDPOINT });
    await m.tool("agent_onboard", { project_dir: probeProj });
    await m.tool("runtime_session_start", { session_id: "shared" }).catch(() => "");
    // boot the machine so the KERNAL IRQ is ticking
    const c0 = await cycles();
    const run1 = await m.tool("runtime_session_run", { session_id: "shared", max_instructions: 600_000 });
    const c1 = await cycles();
    const adv1 = /Advanced (\d+) cycles/.exec(run1);
    check(!!adv1 && Number(adv1[1]) === c1 - c0 && c1 > c0 && !/ran up to/i.test(run1), "9c a normal run reports after - before, as the daemon counts it", `${run1} | daemon ${c0}->${c1}`);

    const run2 = await m.tool("runtime_session_run", { session_id: "shared", max_instructions: 1, cycle_budget: 0 });
    const c2 = await cycles();
    check(c2 === c1 && /did not advance/i.test(run2) && !/ran up to|Advanced/i.test(run2), "9d a run that moved nothing says the machine did not advance", `${run2} | daemon ${c1}->${c2}`);

    const run3 = await m.tool("runtime_session_run", { session_id: "shared", max_instructions: 3_000_000, until: { kind: "pc", pc: "EA31" } });
    const st = await rpc("session/state", { session_id: "shared" });
    check(/Stopped at \$EA31/.test(run3) && st.cpu.pc === 0xea31 && /Advanced \d+ cycles/.test(run3), "5d until pc runs to the PC on the daemon (the KERNAL IRQ entry)", `${run3} | pc=${st.cpu.pc.toString(16)}`);

    const c3 = await cycles();
    const run4 = await m.tool("runtime_session_run", { session_id: "shared", max_instructions: 100, until: { kind: "pc", pc: "0002" } });
    const c4 = await cycles();
    check(/Did NOT reach \$0002/.test(run4) && c4 > c3, "5e a PC the machine never reaches is reported as not reached", run4);

    const run5 = await m.tool("runtime_session_run", { session_id: "shared", max_instructions: 100, until: { kind: "raster", line: 100 } });
    check(/"raster"/.test(run5) && !/slice|744/i.test(run5) && (await cycles()) === c4, "5f an unsupported kind is refused by name and the machine is not touched", run5);
    try { ws.terminate(); } catch { /* closed */ }
  } catch (e) {
    check(false, "daemon part", e.message);
  } finally {
    m?.stop();
    try { daemon.kill("SIGKILL"); } catch { /* gone */ }
  }
}

rmSync(base, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "GREEN" : "RED"} smoke-896-runtime: ${pass} pass, ${fail} fail, ${skipped} skipped.`);
process.exit(fail === 0 ? 0 : 1);
