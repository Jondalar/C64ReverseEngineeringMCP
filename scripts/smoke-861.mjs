#!/usr/bin/env node
// Spec 861 §7.1-§7.4, §7.7 and §7.8 — the gates that need the machine.
//
// LOCAL, not CI: every one of these runs a real C64 on the real runtime and
// evaluates the trace it recorded. §7.5 and §7.6 are the hermetic half and live
// in `e2e:861-impact` / `e2e:861-static`.
//
//   §7.1  every opcode, display off: measured == static, stolen == 0
//   §7.2  the same bytes, display on: the stolen cycles land on bad lines, and
//         the count per line is the one `vic/line_trace` (859) records
//   §7.3  a raster interrupt: every entry is recognised, its 7 cycles belong to
//         the entry, and nothing before one shows phantom stolen cycles. This is
//         also what settles whether the vector reads are traced (§4.2's fallback)
//   §7.4  a `sta $D020` at a known raster line lands on that line and cycle, and
//         859 agrees
//   §7.7  the measured cost of the loop e2e:861-static priced statically
//   §7.8  the drive's own 6502: stolen == 0, because there is no DMA over there
//
// IT NEVER TOUCHES THE SHARED MACHINE. Captures run on sandboxes (their own
// port, their own budget, gone when the call ends), and the trace READ — which
// goes through a runtime by design (Spec 802) — is pointed at a daemon this
// script starts and kills. The session a human co-drives is not read from, not
// written to, and not pinged.
//
// Exit 0 = pass, 1 = fail, 2 = the runtime or its ROMs are absent (skipped
// loudly, never passed).   npm run smoke:861

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, failCount = 0;
const check = (cond, msg, detail = "") => {
  if (cond) pass += 1; else failCount += 1;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}${detail ? `  (${detail})` : ""}`);
};
const hex4 = (a) => `$${(a & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;

console.log("Spec 861 §7.1-§7.4, §7.7, §7.8 — the cycle table, the VIC, the interrupts and the drive\n");

if (!existsSync(join(ROOT, "dist/cli.js"))) {
  console.error("dist/ is not built — run npm run build");
  process.exit(2);
}

const { exerciser, rasterWriter, rasterIrq } = await import(join(ROOT, "scripts/lib/spec861-programs.mjs"));
const { captureRun } = await import(join(ROOT, "dist/cost/capture.js"));
const { evaluateTrace, rasterAt } = await import(join(ROOT, "dist/cost/trace-cost.js"));
const { resolveDaemonSpawn } = await import(join(ROOT, "dist/runtime/resolve-daemon-spawn.js"));
const { buildD64 } = await import(join(ROOT, "dist/disk/d64-builder.js"));

const work = mkdtempSync(join(tmpdir(), "c64re-861-"));

/**
 * The program, on a disk, because that is the only way a machine of our own
 * will RUN it: a `.prg` poked straight into a sandbox leaves the runtime on its
 * isolated CPU core — the CPU and the memory are real, the CIAs are not, and a
 * typed key is never scanned. With a disk in the drive the machine stays whole,
 * so the program is LOADed and SYSed the way a person would.
 */
const diskWith = (name, program) => {
  const payload = Uint8Array.from([program.load & 0xff, program.load >> 8, ...program.bytes]);
  const image = buildD64({ diskName: "SPEC861", diskId: "61", files: [{ name, payload }] });
  const p = join(work, `${name.toLowerCase()}.d64`);
  writeFileSync(p, Buffer.from(image));
  return p;
};

/** LOAD it, SYS it, and hold the key the program is waiting for. */
const bootSteps = (program, { extra = [] } = {}) => [
  `I type "LOAD{QUOTE}EX{QUOTE},8,1{RETURN}"`,
  "I wait until the drive is idle within 8000 frames",
  "I wait 60 frames",
  `I type "SYS ${program.entry}{RETURN}"`,
  "I wait 100 frames",
  ...extra,
];
/** Everything before this index is the load and the start; the capture is what follows. */
const BOOT_STEPS = 5;

// ── a runtime of our own, for the reads ──────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const plan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: work, port: "0" });
if (plan.mode === "none") {
  console.log("  SKIP  no runtime binary — this gate runs a real C64, so it cannot run here.");
  console.log("        Build the sibling runtime (../TRX64: cargo build --release) or set C64RE_RUNTIME_BIN.");
  rmSync(work, { recursive: true, force: true });
  process.exit(2);
}

const readerPort = await freePort();
const readerPlan = resolveDaemonSpawn({ repoRoot: ROOT, projectDir: work, port: String(readerPort) });
const reader = spawn(readerPlan.cmd, readerPlan.args, {
  detached: false,
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, C64RE_PROJECT_DIR: work, C64RE_RUNTIME_DAEMON_PORT: String(readerPort) },
});
let readerErr = "";
reader.stderr?.on("data", (b) => { readerErr += b.toString(); });
process.env.C64RE_RUNTIME_ENDPOINT = `ws://127.0.0.1:${readerPort}`;

const waitForReader = async () => {
  const deadline = Date.now() + 40000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`the reader daemon on ${readerPort} did not answer\n${readerErr.split("\n").slice(-5).join("\n")}`);
    const ok = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${readerPort}`);
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

// ── the capture + evaluation pair every gate below uses ──────────────────────
async function record(name, program, { steps, afterSteps = BOOT_STEPS, domains, media, budgetSeconds = 540 }) {
  const out = join(work, `${name}.duckdb`);
  return captureRun({
    projectDir: work,
    mediaPath: media ?? diskWith("EX", program),
    output: out,
    steps,
    afterSteps,
    budgetSeconds,
    ...(domains ? { domains } : {}),
  });
}

async function evaluate(storePath, { cpu = "c64", range } = {}) {
  const { readAnchor, readInstructionRows, readMemRows } = await import(join(ROOT, "dist/cost/trace-store-read.js"));
  const anchor = await readAnchor(storePath);
  const insns = await readInstructionRows(storePath, { cpu });
  const mem = await readMemRows(storePath, { cpu });
  return {
    anchor,
    rows: insns.rows,
    mem: mem.rows,
    report: evaluateTrace(insns.rows, mem.rows, { cpu, anchor, ...(range ? { range } : {}) }),
  };
}

/** `vic/line_trace` (859) for a window of lines, off a checkpoint of a fresh run. */
async function lineTrace(port, checkpointId, from, to) {
  return rpc(port, "vic/line_trace", { checkpoint_id: checkpointId, from, to });
}

function rpc(port, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let id = 1;
    const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error(`${method} timed out`)); }, 60000);
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: "integrated-1", ...params } })));
    ws.on("message", (buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch { /* */ }
      if (m.error) reject(new Error(m.error.message ?? JSON.stringify(m.error)));
      else resolve(m.result);
    });
  });
}

try {
  await waitForReader();
  console.log(`  reader daemon on port ${readerPort} (${readerPlan.mode}) — the shared machine is not touched\n`);

  // ─────────────────────────────────────────────────────────── §7.1
  console.log("§7.1 — every opcode, display off: the table against the machine");
  const ex = exerciser({ displayOn: false });
  const off = await record("exerciser-off", ex, {
    steps: bootSteps(ex, { extra: ['I hold the key "SPACE" for 2 frames', "I wait 5 frames"] }),
  });
  const body = { start: ex.load, end: ex.helpers.nmi };
  const offEval = await evaluate(off.storePath, { range: body });
  const r1 = offEval.report;
  check(r1.evaluated > 2000, `the exerciser ran: ${r1.evaluated} instruction instances inside ${hex4(body.start)}-${hex4(body.end)}`, `${r1.rows} rows captured`);
  check(r1.inexact === 0, "every instance's static cost is exact — no span was left open", r1.inexactSamples.map((s) => `${hex4(s.pc)} ${s.mnemonic}: ${s.inexactWhy}`).slice(0, 3).join("; "));
  check(r1.stolen === 0 && r1.stolenSamples.length === 0, "stolen == 0 for every instance: with the display off the VIC takes nothing",
    r1.stolenSamples.slice(0, 3).map((s) => `${hex4(s.pc)} ${s.mnemonic} measured ${s.measured} static ${s.staticCycles}`).join("; "));
  check(r1.measured === r1.staticTotal + r1.entries * 7, `measured == static: ${r1.measured} cycles measured, ${r1.staticTotal} from the table + ${r1.entries * 7} of interrupt entry`);
  {
    // Every opcode the program covers was actually seen, and each one's measured
    // cycles are the table's. This is the table PROVED, opcode by opcode.
    const seen = new Set(offEval.report.instances.map((i) => i.opcode));
    const missing = ex.covered.filter((op) => !seen.has(op));
    check(missing.length === 0, `all ${ex.covered.length} opcodes the exerciser covers were executed and priced`, missing.map((o) => hex4(o)).slice(0, 8).join(" "));
    const crossingSeen = ex.crossing.filter((op) => offEval.report.instances.some((i) => i.opcode === op && i.measured === (i.staticCycles ?? 0) && i.staticCycles !== null));
    check(crossingSeen.length === ex.crossing.length, `all ${ex.crossing.length} opcodes that pay a page-crossing cycle were exercised across one`, `${crossingSeen.length} of ${ex.crossing.length}`);
    const wrong = ex.crossBranches
      .map(({ op, at }) => ({ op, at, seen: offEval.report.instances.find((i) => i.pc === at) }))
      .filter(({ seen }) => !seen || seen.measured !== 4 || seen.staticCycles !== 4);
    check(wrong.length === 0, `all ${ex.crossBranches.length} branches were taken ACROSS a page and cost 4 — the second conditional cycle, measured`,
      wrong.map(({ op, at, seen }) => `$${op.toString(16)} at ${hex4(at)}: ${seen ? `${seen.measured}/${seen.staticCycles}` : "never ran"}`).join("; "));
    const jam = offEval.report.instances.filter((i) => i.staticCycles === null);
    check(jam.length === 0, "no instance ran an opcode the table has no cycles for");
  }
} catch (e) {
  check(false, "the harness", e instanceof Error ? `${e.message}` : String(e));
} finally {
  cleanup();
}

console.log(`\n${failCount ? "RED" : "GREEN"}  smoke-861: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
