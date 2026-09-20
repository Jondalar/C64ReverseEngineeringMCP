#!/usr/bin/env node
// Spec 862 §7.3 and §7.4 — the gates that need the machine.
//
// LOCAL, not CI: this records a real capture on a real C64 and ranks the
// candidates by it. The hermetic half — the same two questions over rows
// synthesised for 861's own evaluator — is `e2e:862-rank`, and the rule
// fixtures are `e2e:862-rules`.
//
//   §7.3  a small saving in a routine called every frame ranks above a larger
//         one in code that runs once, and BOTH numbers come off the capture
//   §7.4  `page-align`'s gain is the page-crossing cycles 861 measured in the
//         same trace, against the count the index values predict
//   §6    the tool itself, over MCP, against the store this gate recorded
//
// IT NEVER TOUCHES THE SHARED MACHINE. The capture runs on a sandbox of its
// own (its own port, its own budget, gone when the call ends), and the trace
// READ — which goes through a runtime by design — is pointed at a daemon this
// script starts and kills.
//
// Exit 0 = pass, 1 = fail, 2 = the runtime or its ROMs are absent (skipped
// loudly, never passed).   npm run smoke:862

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const hex4 = (a) => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

console.log("Spec 862 §7.3 + §7.4 — frequency ranks and a page crossing is a count, on a real machine\n");

if (!existsSync(join(ROOT, "dist/cli.js"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}
const load = async (p) => import(pathToFileURL(join(ROOT, p)).href);

const { candidateProgram, PAGER_CROSSINGS } = await load("scripts/lib/spec862-programs.mjs");
const { captureRun } = await load("dist/cost/capture.js");
const { evaluateTrace } = await load("dist/cost/trace-cost.js");
const { scanForCandidates } = await load("dist/optimise/candidates.js");
const { opcodeTiming } = await load("dist/cost/cycles.js");
const { resolveDaemonSpawn } = await load("dist/runtime/resolve-daemon-spawn.js");
const { buildD64 } = await load("dist/disk/d64-builder.js");

const work = mkdtempSync(join(tmpdir(), "c64re-862-"));

const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: work, port: "0" });
if (plan.mode === "none") {
  console.log("  SKIP  no runtime binary — this gate runs a real C64, so it cannot run here.");
  console.log("        Build the sibling runtime (../TRX64: cargo build --release) or set C64RE_RUNTIME_BIN.");
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

// ── a runtime of our own, for the trace reads ───────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const readerPort = await freePort();
const readerPlan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: work, port: String(readerPort) });
const reader = spawn(readerPlan.cmd, readerPlan.args, {
  detached: false,
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, C64RE_PROJECT_DIR: work, C64RE_RUNTIME_DAEMON_PORT: String(readerPort) },
});
let readerErr = "";
reader.stderr?.on("data", (b) => { readerErr += b.toString(); });
const endpoint = `ws://127.0.0.1:${readerPort}`;
process.env.C64RE_RUNTIME_ENDPOINT = endpoint;

const waitForReader = async () => {
  const deadline = Date.now() + 40000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`the reader daemon on ${readerPort} did not answer\n${readerErr.split("\n").slice(-5).join("\n")}`);
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(endpoint);
      const done = (v) => { try { ws.close(); } catch { /* going away */ } resolve(v); };
      ws.once("open", () => done(true));
      ws.once("error", () => done(false));
      setTimeout(() => done(false), 1500);
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
};

const cleanup = () => {
  try { reader.kill("SIGTERM"); } catch { /* already gone */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
};
process.on("exit", cleanup);

const program = candidateProgram();
const diskWith = (name, prog) => {
  const payload = Uint8Array.from([prog.load & 0xff, prog.load >> 8, ...prog.bytes]);
  const image = buildD64({ diskName: "SPEC862", diskId: "62", files: [{ name, payload }] });
  const p = join(work, `${name.toLowerCase()}.d64`);
  writeFileSync(p, Buffer.from(image));
  return p;
};

try {
  await waitForReader();
  console.log(`  reader daemon on port ${readerPort} (${readerPlan.mode}) — the shared machine is not touched\n`);

  // ── the capture ───────────────────────────────────────────────────────────
  //
  // The program waits for a key, so the window starts where the program's own
  // work starts: `cold` runs on the first pass and never again, and the main
  // loop runs for the rest of it.
  const storePath = join(work, "candidates.duckdb");
  const run = await captureRun({
    projectDir: work,
    mediaPath: diskWith("CAND", program),
    output: storePath,
    steps: [
      `I type "LOAD{QUOTE}CAND{QUOTE},8,1{RETURN}"`,
      "I wait until the drive is idle within 8000 frames",
      "I wait 60 frames",
      `I type "SYS ${program.entry}{RETURN}"`,
      "I wait 60 frames",
      'I hold the key "SPACE" for 2 frames',
      "I wait 20 frames",
    ],
    afterSteps: 5,
    budgetSeconds: 540,
  });
  check(run.events > 1000, `the capture recorded the program running: ${run.events} events`, storePath);

  const { readAnchor, readInstructionRows, readMemRows } = await load("dist/cost/trace-store-read.js");
  const anchor = await readAnchor(storePath);
  const insns = await readInstructionRows(storePath, { cpu: "c64" });
  const mem = await readMemRows(storePath, { cpu: "c64" });
  const trace = evaluateTrace(insns.rows, mem.rows, {
    cpu: "c64", anchor, keepInstances: insns.rows.length + 1,
    routines: program.routines.map((r) => ({ id: r.label, ...r })),
  });
  check(!!anchor, "the store carries the capture's frame boundary", trace.anchorWhy);
  check(trace.frames >= 2, `the window is ${trace.frames} frame(s) long`, `${trace.evaluated} instances`);

  // ── the scan, ranked by that capture ──────────────────────────────────────
  const report = scanForCandidates({
    image: { load: program.load, bytes: program.bytes },
    units: program.routines,
    trace,
    freeZp: null,
    limit: 50,
  });
  const find = (rule, unit) => report.candidates.find((c) => c.rule.id === rule && c.unit === unit);

  // ── §7.4 ──────────────────────────────────────────────────────────────────
  console.log("\n§7.4 — page-align is exact");
  {
    const measured = trace.instances
      .filter((i) => i.pc === program.indexedReadAt && i.exact)
      .reduce((n, i) => n + (i.staticCycles - opcodeTiming(i.opcode).base), 0);
    const runs = trace.instances.filter((i) => i.pc === program.indexedReadAt).length;
    const loops = Math.round(runs / 40);
    check(runs > 0, `the indexed read at ${hex4(program.indexedReadAt)} ran ${runs} time(s) — ${loops} pass(es) through the loop`);
    check(
      measured === loops * PAGER_CROSSINGS,
      `861 charged a crossing on exactly ${PAGER_CROSSINGS} of every 40 iterations, which is what the index values predict`,
      `861 says ${measured}, ${loops} × ${PAGER_CROSSINGS} = ${loops * PAGER_CROSSINGS}`,
    );
    const c = find("page-align", "pager");
    check(!!c, "the scan proposes page-align there");
    if (c) {
      check(
        c.gainInCapture === measured,
        "§7.4 its gain IS the page-crossing cycles 861 measured in the same trace",
        `gain ${c.gainInCapture}, 861 ${measured}`,
      );
      check(c.verdict === "MEASURED" && c.deltaCycles === -1, "…one cycle per crossing, reported as a measurement", `${c.verdict} ${c.deltaCycles}`);
    }
  }

  // ── §7.3 ──────────────────────────────────────────────────────────────────
  console.log("\n§7.3 — frequency ranks");
  {
    const hot = find("known-carry", "hot");
    const cold = find("tail-call", "cold");
    check(!!hot, "the `clc` in the hot routine is a candidate worth 2 cycles", hot ? `Δ ${hot.deltaCycles}` : "not found");
    check(!!cold, "the `jsr`+`rts` in the cold one is a candidate worth 9", cold ? `Δ ${cold.deltaCycles}` : "not found");
    if (hot && cold) {
      check(cold.executionsInCapture === 1, "…and the capture confirms the cold one ran exactly once", `${cold.executionsInCapture} execution(s)`);
      check(hot.executionsInCapture > 50, "…while the hot one ran many times", `${hot.executionsInCapture} execution(s)`);
      check(
        hot.gainPerFrame > cold.gainPerFrame,
        "§7.3 the small saving in the routine called every frame has the larger gain per frame",
        `${hot.gainPerFrame.toFixed(2)} against ${cold.gainPerFrame.toFixed(2)}`,
      );
      const order = report.candidates.map((c) => `${c.rule.id}@${c.unit}`);
      check(
        order.indexOf("known-carry@hot") < order.indexOf("tail-call@cold"),
        "…and the list is in that order",
        order.join(" > "),
      );
    }
    check(report.ranking === "measured", "the report says it ranked on the measurement, not on a static guess");
  }

  // ── §6 — the tool, over MCP, against the store this gate recorded ─────────
  console.log("\n§6 — the tool itself, against a real store");
  {
    const proj = mkdtempSync(join(tmpdir(), "c64re-862m-"));
    mkdirSync(join(proj, "artifacts", "prg"), { recursive: true });
    const prg = join(proj, "artifacts", "prg", "cand.prg");
    writeFileSync(prg, Buffer.from([program.load & 0xff, program.load >> 8, ...program.bytes]));

    const proc = spawn(process.execPath, [join(ROOT, "dist/cli.js")], {
      cwd: tmpdir(),
      env: { ...process.env, C64RE_PROJECT_DIR: proj, C64RE_FULL_TOOLS: "", C64RE_SLOT_GATE: "0", C64RE_RUNTIME_ENDPOINT: endpoint },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    const pend = new Map();
    let nid = 1;
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const ln = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!ln) continue;
        let m;
        try { m = JSON.parse(ln); } catch { continue; }
        if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      }
    });
    proc.stderr.on("data", () => {});
    const rpc = (method, params) => new Promise((res, rej) => {
      const id = nid++;
      const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 300000);
      pend.set(id, (m) => { clearTimeout(t); res(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const callTool = async (name, args) => {
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
      return (r.result?.content || []).map((c) => c.text).join("\n");
    };
    try {
      await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-862", version: "1" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await callTool("project_init", { name: "opt862smoke" });
      await callTool("agent_onboard", {});
      const text = await callTool("optimisation_candidates", {
        prg_path: "artifacts/prg/cand.prg",
        trace_path: storePath,
        limit: 20,
      });
      check(/ranked by gain per frame, from the capture/.test(text), "the tool ranked against the store", text.split("\n")[1]?.trim());
      check(/known-carry/.test(text) && /tail-call/.test(text), "…and found the same two candidates");
      check(/the capture ran it \d+ time\(s\)/.test(text), "…with how often the capture ran each of them");
      check(/nothing here is applied/.test(text), "…and said that nothing was applied");
    } finally {
      proc.kill();
      try { rmSync(proj, { recursive: true, force: true }); } catch { /* temp */ }
    }
  }
} catch (e) {
  check(false, "the gate", e instanceof Error ? e.stack ?? e.message : String(e));
}

console.log(`\n${failCount ? "RED" : "GREEN"}  smoke-862: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
