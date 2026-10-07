#!/usr/bin/env node
// Spec 889 §4b — a green emulator run is recorded, and the C64 Ultimate gate reads it.
//
// The recording is done by the two runners on a PRIVATE emulator machine — `c64re scenario
// run` and `runtime_sandbox_run` with a Then — so proving it needs a machine. This script
// runs both for real (every machine a child of its run, on its own port), then hands the
// same bytes to the C64U backend against the fake Ultimate (127.0.0.1 only) and shows the
// gate open for exactly those bytes. SKIPS LOUDLY when there is no runtime binary — a gate
// that quietly checks nothing is worse than one that is missing.
//
//   1  scenario run PASS  → knowledge/emulator-passes.json holds the PRG's sha256
//   2  a run with a failing Then, and a run with no Then → record nothing
//   3  runtime_sandbox_run with a Then that holds → a pass; the answer says so
//   4  the C64U backend: refused before, allowed after, refused again for a changed byte
//
// Exit 0 = pass, 1 = fail, 0 with SKIPPED when there is no daemon.   npm run e2e:889-pass
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeUltimate } from "./lib/fake-ultimate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
if (!existsSync(cli)) { console.error("dist/cli.js missing — run `npm run build:mcp`"); process.exit(2); }
const { resolveDaemonSpawn } = await import(pathToFileURL(join(ROOT, "dist/runtime/resolve-daemon-spawn.js")).href);
const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: tmpdir(), port: "0" });
if (plan.mode === "none") {
  console.log("Spec 889 §4b — pass recording\n\n  SKIPPED — no runtime daemon binary. Build it in the sibling checkout or set C64RE_TRX64_BIN,\n  then re-run. The live half asserts that a green scenario run and a green runtime_sandbox_run\n  record the medium's sha256, and that the C64U gate then opens for those bytes.");
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? `  (${d})` : ""}`); };
const sha = (b) => createHash("sha256").update(b).digest("hex");

const dir = mkdtempSync(join(tmpdir(), "c64re-889p-"));
const { ProjectKnowledgeService } = await import(pathToFileURL(join(ROOT, "dist/project-knowledge/service.js")).href);
new ProjectKnowledgeService(dir).initProject({ name: "889p" });
// 10 SYS2061, then SEI · $C000 := $01 · JMP *
const stub = [0x01, 0x08, 0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00];
const code = [0x78, 0xa9, 0x01, 0x8d, 0x00, 0xc0, 0x4c, 0x13, 0x08];
const PRG = Buffer.from([...stub, ...code]);
const prgPath = join(dir, "input", "one.prg");
const { mkdirSync } = await import("node:fs");
mkdirSync(join(dir, "input"), { recursive: true });
writeFileSync(prgPath, PRG);
const other = Buffer.from([...stub, ...code, 0xea]); // a different build of the same program
const otherPath = join(dir, "input", "two.prg");
writeFileSync(otherPath, other);
const passesFile = join(dir, "knowledge", "emulator-passes.json");
const passes = () => (existsSync(passesFile) ? JSON.parse(readFileSync(passesFile, "utf8")).passes : []);

mkdirSync(join(dir, "scenarios"), { recursive: true });
writeFileSync(join(dir, "scenarios", "green.feature"), [
  "Feature: the byte", "  Scenario: $C000 is set", '    Given the disk "../input/one.prg"', "    When I wait 20 frames", "    Then $C000 is $01",
].join("\n"));
writeFileSync(join(dir, "scenarios", "red.feature"), [
  "Feature: the byte", "  Scenario: $C000 is wrong", '    Given the disk "../input/two.prg"', "    When I wait 20 frames", "    Then $C000 is $09",
].join("\n"));
writeFileSync(join(dir, "scenarios", "prose.feature"), [
  "Feature: the byte", "  Scenario: nothing decidable", '    Given the disk "../input/two.prg"', "    When I wait 20 frames", "    Then it feels right",
].join("\n"));

console.log("Spec 889 §4b — a green run is recorded; the gate reads it\n");
const env = { ...process.env, C64RE_PROJECT_DIR: dir, C64RE_RUNTIME_AUTOSTART: "0" };
const run = (feature) => spawnSync(process.execPath, [cli, "scenario", "run", join(dir, "scenarios", feature), "--project", dir], { cwd: dir, env, encoding: "utf8", timeout: 300_000 });

try {
  const red = run("red.feature");
  check(red.status === 1 && /^FAIL/m.test(red.stdout), "2a a scenario whose Then fails exits 1", `exit ${red.status}`);
  const prose = run("prose.feature");
  check(/^UNCHECKED/m.test(prose.stdout), "2b a scenario with no decidable Then is UNCHECKED");
  check(passes().length === 0, "…and neither recorded anything", `${passes().length} records`);

  const green = run("green.feature");
  check(green.status === 0 && /^PASS/m.test(green.stdout), "1 the green scenario passes", `exit ${green.status}`);
  const rec = passes().find((p) => p.sha256 === sha(PRG));
  check(!!rec && rec.name === "one.prg" && rec.scenario === "$C000 is set" && rec.checks.length === 1 && rec.checks[0].pass === undefined, "1b …and records the PRG's sha256 with its scenario and its check", rec ? `${rec.name} ${rec.sha256.slice(0, 8)}` : "no record");
  check(!!rec && /^\d+\.\d+\.\d+$/.test(rec.runtimeVersion) && !Number.isNaN(Date.parse(rec.at)), "1c …with the time and the runtime version");
  check(!passes().some((p) => p.sha256 === sha(other)), "1d …and not the other build's");

  // runtime_sandbox_run over MCP
  const server = spawn(process.execPath, [cli], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", nid = 1; const pend = new Map();
  server.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!ln) continue; let m; try { m = JSON.parse(ln); } catch { continue; } if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } } });
  server.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => { const id = nid++; const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 300_000); pend.set(id, (m) => { clearTimeout(t); res(m); }); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); const text = (r.result?.content || []).map((c) => c.text).join("\n"); return r.result?.isError ? `# tool error\n${text}` : text; };
  try {
    await call("agent_onboard", { project_dir: dir });
    const bad = await call("runtime_sandbox_run", { project_dir: dir, media_path: otherPath, steps: ["I wait 20 frames", "Then $C000 is $07"] });
    check(/checks: 0 passed, 1 failed/.test(bad) && !passes().some((p) => p.sha256 === sha(other)), "3a runtime_sandbox_run with a failing Then records nothing");
    const none = await call("runtime_sandbox_run", { project_dir: dir, media_path: otherPath, steps: ["I wait 20 frames"] });
    check(!/checks:/.test(none) && !passes().some((p) => p.sha256 === sha(other)), "3b …nor does a run with no Then");
    const good = await call("runtime_sandbox_run", { project_dir: dir, media_path: otherPath, steps: ["I wait 20 frames", "Then $C000 is $01"] });
    check(/checks: 1 passed, 0 failed/.test(good) && /green emulator run recorded for the C64 Ultimate gate: two\.prg/.test(good), "3c runtime_sandbox_run with a Then that holds records a pass and says so", (/green emulator run[^\n]*/.exec(good) ?? [""])[0].slice(0, 90));
    check(passes().some((p) => p.sha256 === sha(other) && p.scenario === undefined && p.steps.includes("I wait 20 frames")), "3d …with the step list in the record");
  } finally { server.stdin.end(); server.kill(); }

  // the gate, end to end, against the fake Ultimate
  const be = await import(pathToFileURL(join(ROOT, "dist/runtime/backend.js")).href);
  const sim = await startFakeUltimate({});
  const third = Buffer.from([...stub, ...code, 0xea, 0xea]);
  const thirdPath = join(dir, "input", "three.prg");
  writeFileSync(thirdPath, third);
  try {
    await be.selectBackend({ kind: "c64u", host: "127.0.0.1", restPort: sim.restPort }, { projectDir: dir });
    const lp = await be.runtimeDaemon.call("session/load_prg", { session_id: "shared", prg_path: prgPath });
    check(lp.bytesLoaded === PRG.length - 2 && sim.requests.some((q) => q.path === "/v1/runners:load_prg" && q.bodySha === sha(PRG)), "4a the PRG a green scenario recorded goes to the device");
    const lp2 = await be.runtimeDaemon.call("session/load_prg", { session_id: "shared", prg_path: otherPath });
    check(lp2.bytesLoaded === other.length - 2, "4b …so does the one the green sandbox run recorded");
    let refused;
    try { await be.runtimeDaemon.call("session/load_prg", { session_id: "shared", prg_path: thirdPath }); } catch (e) { refused = e.message; }
    check(/three\.prg \(sha256 [0-9a-f]{8}…\) has no green emulator run in this project/.test(refused ?? ""), "4c a build that never ran in the emulator is refused", refused?.slice(0, 80));
    check(!sim.requests.some((q) => q.bodySha === sha(third)), "…and its bytes never left");
  } finally {
    await be.selectBackend({ kind: "emulator" });
    await sim.close();
  }
} catch (e) {
  check(false, "harness", e.stack ?? e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "GREEN" : "RED"}  Spec 889 pass recording: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
