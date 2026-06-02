// Spec 748 (BUG-032) — persistent PROJECT STEERING (the Kiro steering-file
// analogue): project_steering_set writes <project>/knowledge/steering.md, and
// agent_onboard injects it VERBATIM at the top of its output every session so the
// always-apply rules can't be missed after context loss.
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");
let pass = 0, fail = 0;
const ok = (c, m, d = "") => { (c ? pass++ : fail++); console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("Spec 748 — project steering file + agent_onboard injection\n");
if (!existsSync(cli)) { console.error("build:mcp first"); process.exit(2); }

const projectDir = mkdtempSync(join(tmpdir(), "c64re-748-"));
const { ProjectKnowledgeService } = await import(`${ROOT}/dist/project-knowledge/service.js`);
new ProjectKnowledgeService(projectDir).initProject({ name: "Steering Test" });

function spawnMcp() {
  const proc = spawn(process.execPath, [cli], { cwd: ROOT, env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = ""; const pending = new Map(); let id = 1;
  proc.stdout.on("data", (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const rpc = (method, params, t = 30000) => new Promise((res, rej) => { const i = id++; const timer = setTimeout(() => { pending.delete(i); rej(new Error("timeout " + method)); }, t); pending.set(i, (m) => { clearTimeout(timer); res(m); }); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  const call = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(`${name}: ${r.error.message}`); return (r.result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n"); };
  return { proc, rpc, call, kill: () => { try { proc.stdin.end(); proc.kill(); } catch {} } };
}

let exit = 0;
const m = spawnMcp();
try {
  await m.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e748", version: "1" } });
  m.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // 1 fresh project: onboard reports NO steering + points at project_steering_set.
  const onboard0 = await m.call("agent_onboard", {});
  ok(/Project Steering: none set/i.test(onboard0) && /project_steering_set/.test(onboard0), "1 fresh project: onboard flags missing steering + names the tool");

  // 2 set steering rules.
  const MARK = "STEER-MARKER-after-a-load-trace-derive-disk-cartography";
  const rules = `# Wasteland steering\n\n- ${MARK}: after a load trace, derive the disk-T/S↔load mapping and register_payload the spans.\n- after each action, record a finding + reconcile the related open question.`;
  const setOut = await m.call("project_steering_set", { rules });
  ok(/steering set/i.test(setOut) && /steering\.md/.test(setOut), "2 project_steering_set wrote the file", setOut.split("\n")[0]);
  const file = join(projectDir, "knowledge", "steering.md");
  ok(existsSync(file) && readFileSync(file, "utf8").includes(MARK), "2b knowledge/steering.md on disk with the rules");

  // 3 onboard now injects the steering VERBATIM, at the TOP (before Counts/Audit).
  const onboard1 = await m.call("agent_onboard", {});
  ok(/⚙ PROJECT STEERING \(always apply/.test(onboard1) && onboard1.includes(MARK), "3 agent_onboard injects the steering verbatim", "");
  const steerIdx = onboard1.indexOf("PROJECT STEERING");
  const countsIdx = onboard1.indexOf("## Counts");
  ok(steerIdx >= 0 && countsIdx >= 0 && steerIdx < countsIdx, "3b steering is at the TOP (before Counts/Audit/etc)", `steer@${steerIdx} counts@${countsIdx}`);

  // 4 append adds without clobbering.
  await m.call("project_steering_set", { rules: "- third rule appended", append: true });
  const after = readFileSync(file, "utf8");
  ok(after.includes(MARK) && after.includes("third rule appended"), "4 append keeps prior rules + adds new", "");
} catch (e) { console.error("FATAL", e.message); exit = 2; }
finally { m.kill(); }

console.log(`\nSpec 748 project-steering: ${pass} pass, ${fail} fail`);
process.exit(exit || (fail > 0 ? 1 : 0));
