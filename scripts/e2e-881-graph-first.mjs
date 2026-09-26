#!/usr/bin/env node
// Spec 881 — the graph before the listing.
//
// Two mechanisms of different kinds, so two halves here. D1 is a door and is tested by
// being refused and then not refused. D2 is a measure and is tested by moving and then
// not moving.
//
// One MCP session over stdio against a temp project, so the ledger and its re-arming are
// exercised the way a real session meets them.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const cli = join(ROOT, "dist/cli.js");

let pass = 0, fail = 0;
const check = (ok, what, detail) => {
  if (ok) { pass++; console.log(`  PASS  ${what}${detail ? `  (${detail})` : ""}`); }
  else { fail++; console.log(`  FAIL  ${what}${detail ? `  (${detail})` : ""}`); }
};

console.log("Spec 881 — the graph before the listing\n");

const proj = mkdtempSync(join(tmpdir(), "c64re-881-"));
process.on("exit", () => { try { rmSync(proj, { recursive: true, force: true }); } catch {} });

function session() {
  const proc = spawn(process.execPath, [cli], {
    cwd: tmpdir(),
    env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_SLOT_GATE: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pend = new Map();
  let id = 1;
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const ln = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!ln) continue;
      let m; try { m = JSON.parse(ln); } catch { continue; }
      if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => new Promise((res, rej) => {
    const i = id++;
    const t = setTimeout(() => { pend.delete(i); rej(new Error(`timeout ${method}`)); }, 120000);
    pend.set(i, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
  const call = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    if (r.error) return `ERROR ${JSON.stringify(r.error)}`;
    return (r.result?.content || []).map((c) => c.text).join("\n");
  };
  return { proc, rpc, call };
}

const s1 = session();
await s1.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "881", version: "1" } });
await s1.call("project_init", { project_dir: proj, name: "spec-881" });
await s1.call("agent_onboard", { project_dir: proj });

// A listing over the threshold, and one comfortably under it.
const big = join(proj, "analysis", "big_disasm.asm");
const small = join(proj, "analysis", "small_disasm.asm");
mkdirSync(join(proj, "analysis"), { recursive: true });
writeFileSync(big, Array.from({ length: 1800 }, (_, i) => `    lda #$${(i & 0xff).toString(16).padStart(2, "0")}   // line ${i}`).join("\n"));
writeFileSync(small, Array.from({ length: 40 }, (_, i) => `    nop   // ${i}`).join("\n"));

console.log("D1 — the door");

const refused = await s1.call("read_artifact", { path: "analysis/big_disasm.asm" });
check(/refused/i.test(refused) && /1800 lines/.test(refused),
  "a large listing is refused while the graph has not been asked", refused.split("\n")[0]?.slice(0, 64));
check(/graph_overview/.test(refused) && /graph_find/.test(refused),
  "and the refusal names the calls that open it");
check(!refused.includes("lda #$"), "and it does not leak the listing it just refused");

const shortRead = await s1.call("read_artifact", { path: "analysis/small_disasm.asm" });
check(!/refused/i.test(shortRead) && shortRead.includes("nop"),
  "a short artifact is never refused", `${shortRead.split("\n").length} lines returned`);

await s1.call("graph_overview", { project_dir: proj });
const afterGraph = await s1.call("read_artifact", { path: "analysis/big_disasm.asm" });
check(!/refused/i.test(afterGraph) && afterGraph.includes("lda #$"),
  "after ANY graph call the same read goes through", `${afterGraph.split("\n").length} lines returned`);

s1.proc.kill();
await new Promise((r) => setTimeout(r, 300));

// A SECOND server process over the same project: "session" has to mean the session, and
// the only thing that re-arms it is agent_onboard.
console.log("\nD1 — and it is armed per SESSION, not per process");

const s2 = session();
await s2.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "881b", version: "1" } });
const beforeOnboard = await s2.call("read_artifact", { path: "analysis/big_disasm.asm" });
// Not just "was it refused" — an un-onboarded session is refused for a DIFFERENT reason,
// and the first version of this check read that as ours. Ask whether OUR door spoke.
check(!/the graph has not been asked/.test(beforeOnboard),
  "a new process alone does not re-arm the graph door — the ledger is the session's",
  beforeOnboard.split("\n")[0]?.slice(0, 60));

await s2.call("agent_onboard", { project_dir: proj });
const afterOnboard = await s2.call("read_artifact", { path: "analysis/big_disasm.asm" });
check(/refused/i.test(afterOnboard),
  "agent_onboard re-arms it, and the next session is asked again", afterOnboard.split("\n")[0]?.slice(0, 64));

await s2.call("graph_find", { project_dir: proj, query: "$D018" });
const served = await s2.call("read_artifact", { path: "analysis/big_disasm.asm" });
check(!/refused/i.test(served), "and a graph call opens it again");
const twice = await s2.call("read_artifact", { path: "analysis/big_disasm.asm" });
check(!/refused/i.test(twice), "a second read of the same listing is not rationed");

console.log("\nD2 — the measure");

const w1 = await s2.call("save_open_question", { project_dir: proj, kind: "hypothesis", title: "does the footer speak?" });
check(/Graph: \d+ quer/.test(w1), "the write path carries the ratio",
  w1.split("\n").find((l) => /^Graph:/.test(l))?.slice(0, 80));
check(/through tools/.test(w1), "and it says it counts TOOL reads, not every read");

const w2 = await s2.call("save_open_question", { project_dir: proj, kind: "hypothesis", title: "and again?" });
check(!/^Graph:/m.test(w2), "it stays quiet when nothing moved — a banner is skipped");

await s2.call("graph_overview", { project_dir: proj });
const w3 = await s2.call("save_open_question", { project_dir: proj, kind: "hypothesis", title: "after a graph call?" });
check(/Graph: \d+ quer/.test(w3), "and speaks again once the number moves",
  w3.split("\n").find((l) => /^Graph:/.test(l))?.slice(0, 80));
check(!/ERROR/.test(w1) && !/ERROR/.test(w2) && !/ERROR/.test(w3),
  "and it never turns a write into a failure");

s2.proc.kill();

console.log(`\n${fail ? "RED " : "GREEN"}  spec 881 graph-first: ${pass} pass, ${fail} fail.`);
process.exit(fail ? 1 : 0);
