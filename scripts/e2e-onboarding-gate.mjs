#!/usr/bin/env node
// Doctrine rule 8, enforced: a session inside an RE project onboards before it
// works. This gate proves the server refuses until it has, and stops refusing
// once it has.
//
//   node scripts/e2e-onboarding-gate.mjs

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(ROOT, "dist/cli.js");

let pass = 0;
let fail = 0;
const ok = (c, m, d = "") => { c ? pass++ : fail++; console.log(`  ${c ? "PASS" : "FAIL"}  ${m}${d ? "  (" + d + ")" : ""}`); };

console.log("onboarding gate — nothing works in a project until the session onboards\n");

const projectDir = mkdtempSync(join(tmpdir(), "c64re-onboard-gate-"));

const proc = spawn(process.execPath, [cli], {
  cwd: tmpdir(),
  env: { ...process.env, C64RE_PROJECT_DIR: projectDir, C64RE_FULL_TOOLS: "" },
  stdio: ["pipe", "pipe", "pipe"],
});
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
    const r = pending.get(msg.id);
    if (r) { pending.delete(msg.id); r(msg); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`timeout: ${method}`)); }, 120_000);
});
const call = async (name, args) => {
  const res = await rpc("tools/call", { name, arguments: args });
  const blocks = res?.result?.content ?? [];
  return blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
};

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "onboarding-gate", version: "1" } });

// 1. a directory that is not a project yet: nothing to onboard into, so work is allowed.
const beforeInit = await call("c64ref_lookup", { query: "$D018" });
ok(!/has not onboarded/.test(beforeInit) && beforeInit.length > 0, "1 platform reference answers without a project at all", beforeInit.split("\n")[0].slice(0, 60));

await call("project_init", { project_dir: projectDir, name: "onboarding gate" });

// 2. now it IS a project, and a work door refuses.
const refused = await call("save_finding", {
  project_dir: projectDir, kind: "observation", title: "before onboarding", summary: "should not land",
});
ok(/refused/.test(refused) && /has not onboarded/.test(refused), "2 a work door refuses before onboarding", refused.split("\n")[0].slice(0, 70));
ok(/agent_onboard\(project_dir=/.test(refused), "3 the refusal carries the call that clears it", /agent_onboard\([^)]*\)/.exec(refused)?.[0]?.slice(0, 60) ?? "missing");

// 4. orientation stays open.
const status = await call("project_status", { project_dir: projectDir });
ok(!/has not onboarded/.test(status), "4 project_status is orientation and stays open", status.split("\n")[0].slice(0, 60));
const template = await call("doc_template", { kind: "synthesis", title: "t" });
ok(!/has not onboarded/.test(template) && /---/.test(template), "5 doc_template stays open — refusing it teaches nothing", template.split("\n")[0].slice(0, 50));

// 6. the finding really did not land.
const listedBefore = await call("list_findings", { project_dir: projectDir });
ok(/refused/.test(listedBefore) || !/before onboarding/.test(listedBefore), "6 the refused finding was not written", listedBefore.split("\n")[0].slice(0, 60));

// 7. onboard, and the same door works.
const onboarded = await call("agent_onboard", { project_dir: projectDir });
ok(onboarded.length > 0 && !/refused/.test(onboarded), "7 agent_onboard itself is never gated", onboarded.split("\n")[0].slice(0, 60));
const accepted = await call("save_finding", {
  project_dir: projectDir, kind: "observation", title: "after onboarding", summary: "should land",
});
ok(!/has not onboarded/.test(accepted), "8 the same door works once the session onboarded", accepted.split("\n")[0].slice(0, 60));
const listedAfter = await call("list_findings", { project_dir: projectDir });
ok(/after onboarding/.test(listedAfter), "9 and the finding is in the project", listedAfter.split("\n").find((l) => /after onboarding/.test(l))?.slice(0, 60) ?? "not found");

proc.kill();
console.log(`\nproject: ${projectDir}`);
console.log(`\n${fail === 0 ? "GREEN" : "RED"} onboarding gate: ${pass} pass, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
