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

const { exerciser, loopProgram, rasterWriter, rasterIrq, STATIC_LOOP_CYCLES } = await import(join(ROOT, "scripts/lib/spec861-programs.mjs"));
const { captureRun } = await import(join(ROOT, "dist/cost/capture.js"));
const { evaluateTrace, rasterAt } = await import(join(ROOT, "dist/cost/trace-cost.js"));
const { resolveDaemonSpawn } = await import(join(ROOT, "dist/runtime/resolve-daemon-spawn.js"));
const { buildD64 } = await import(join(ROOT, "dist/disk/d64-builder.js"));
const { Session, lineTraceFrame } = await import(join(ROOT, "scripts/lib/spec861-session.mjs"));
const startSession = () => Session.start(work, { resolveDaemonSpawn, repoRoot: ROOT });

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
  // ─────────────────────────────────────────────────────────── §7.2
  console.log("\n§7.2 — the same bytes with the display on: where the VIC's cycles went");
  {
    const on = exerciser({ displayOn: true });
    const disk = diskWith("EX", on);
    const session = await startSession();
    try {
      await session.boot(disk, on.entry);
      await session.pressSpace();

      const boundary = await session.call("session/advance_to_frame");
      const anchor = {
        clock: boundary.c64Cycles, line: boundary.rasterLine ?? 0, cycle: boundary.rasterCycle ?? 0,
        cyclesPerLine: 63, linesPerFrame: 312,
      };
      const out = join(work, "exerciser-on.duckdb");
      await session.call("trace/start_domains", { domains: ["c64-cpu", "memory"], output: out });
      const { anchorLabel } = await import(join(ROOT, "dist/cost/trace-cost.js"));
      await session.call("trace/run/mark", { label: anchorLabel(anchor) });
      await session.runFrames(3);
      await session.call("trace/run/stop", { wait_index: true });

      // The checkpoint's picture is the frame that just ended — which is inside
      // the window that was being recorded a moment ago. Same machine, same frame.
      const cp = await session.call("checkpoint/capture", { source: "smoke" });
      const cpId = cp?.ref?.id ?? cp?.id ?? cp?.checkpointId;
      check(!!cpId, "a checkpoint of the running machine, for 859 to replay", cpId ?? JSON.stringify(cp).slice(0, 120));
      const head = await session.call("vic/line_trace", { checkpoint_id: cpId, from: 0, to: 0 });
      const frame = head.frame ?? {};
      const lines = await lineTraceFrame(session, cpId, frame.linesPerFrame ?? 312);
      const cpl = frame.cyclesPerLine ?? 63;
      const startClk = Number(frame.startClk);

      const evalOn = await evaluate(out);
      const frameCycles = cpl * (frame.linesPerFrame ?? 312);
      const window = evalOn.report.instances.filter((i) => i.clock >= startClk && i.clock < startClk + frameCycles);
      check(window.length > 1000, `${window.length} instances inside the very frame 859 replayed (${frame.which}, from clock ${startClk})`);

      // What 859 says the VIC took: every cycle of that frame where the CPU did
      // not have the bus.
      // "The CPU did not have this cycle" is exactly: no CPU bus access happened
      // in it. Read that way rather than off a BA or AEC flag, whose polarity is
      // a convention — this is the thing itself.
      let blocked = 0;
      const badLines = new Set();
      for (const [line, rec] of lines) {
        blocked += (rec.cycles ?? []).filter((c) => (c.cpu ?? []).length === 0).length;
        if (rec.badLine) badLines.add(line);
      }
      check(badLines.size > 20, `859 records ${badLines.size} bad lines in that frame — the display really is on`);
      const stolen = window.reduce((a, i) => a + i.stolen, 0);
      check(stolen === blocked, `the cycles the arithmetic calls stolen are the cycles 859 says the CPU did not have: ${stolen} against ${blocked}`);

      const stolenLines = new Set(window.filter((i) => i.stolen !== 0).map((i) => i.line));
      const notBad = [...stolenLines].filter((l) => !badLines.has(l));
      check(notBad.length === 0, "every line with stolen cycles is a line 859 calls a bad line", notBad.slice(0, 8).join(", "));
      const perLine = [...stolenLines].map((l) => window.filter((i) => i.line === l).reduce((a, i) => a + i.stolen, 0));
      check(perLine.every((n) => n >= 38 && n <= 46), `each bad line costs about forty cycles: ${Math.min(...perLine)}..${Math.max(...perLine)}`);
    } finally {
      session.close();
    }
  }

  // ─────────────────────────────────────────────────────────── §7.4
  console.log("\n§7.4 — the raster anchor: a store placed on the line it happened on");
  {
    const rw = rasterWriter({ line: 0x64 });
    const disk = diskWith("EX", rw);
    const session = await startSession();
    try {
      await session.boot(disk, rw.entry);
      const boundary = await session.call("session/advance_to_frame");
      const anchor = {
        clock: boundary.c64Cycles, line: boundary.rasterLine ?? 0, cycle: boundary.rasterCycle ?? 0,
        cyclesPerLine: 63, linesPerFrame: 312,
      };
      const out = join(work, "raster.duckdb");
      await session.call("trace/start_domains", { domains: ["c64-cpu", "memory"], output: out });
      const { anchorLabel } = await import(join(ROOT, "dist/cost/trace-cost.js"));
      await session.call("trace/run/mark", { label: anchorLabel(anchor) });
      await session.runFrames(3);
      await session.call("trace/run/stop", { wait_index: true });
      const cp = await session.call("checkpoint/capture", { source: "smoke" });
      const cpId = cp?.ref?.id ?? cp?.id ?? cp?.checkpointId;
      const head = await session.call("vic/line_trace", { checkpoint_id: cpId, from: 0, to: 0 });
      const frame = head.frame ?? {};
      const startClk = Number(frame.startClk);
      const cpl = frame.cyclesPerLine ?? 63;

      const ev = await evaluate(out);
      const frameCycles = cpl * (frame.linesPerFrame ?? 312);
      const stores = ev.report.instances.filter(
        (i) => i.opcode === 0x8d && i.clock >= startClk && i.clock < startClk + frameCycles
          && ev.rows.some((r) => r.seq === i.seq && (r.b1 | (r.b2 << 8)) === 0xd020),
      );
      check(stores.length === 1, `exactly one store to $D020 in the frame 859 replayed (${stores.length})`);

      const mine = stores[0];
      check(!!mine && mine.line === rw.line, `the anchor puts it on raster line ${rw.line}`, mine ? `line ${mine.line} cycle ${mine.cycleInLine}` : "not evaluated");

      const window = await session.call("vic/line_trace", { checkpoint_id: cpId, from: Math.max(0, rw.line - 2), to: rw.line + 2 });
      let seen = null;
      for (const line of window.lines ?? []) {
        for (const c of line.cycles ?? []) {
          // 859 names a CPU write "w" (f = fetch, dr = dummy read, r = read).
          if ((c.cpu ?? []).some((a) => a.a === 0xd020 && String(a.k) === "w")) seen = { line: line.line, cycle: c.c, clk: Number(c.clk) };
        }
      }
      check(!!seen, "859 records the same store", seen ? `line ${seen.line} cycle ${seen.cycle}` : "859 saw no write to $D020 on those lines");
      check(!!seen && !!mine && seen.line === mine.line && seen.cycle === mine.cycleInLine,
        "…on the same line AND the same cycle of that line — the anchor and 859 agree",
        seen && mine ? `861: line ${mine.line} cycle ${mine.cycleInLine} · 859: line ${seen.line} cycle ${seen.cycle}` : "");
    } finally {
      session.close();
    }
  }
  // ─────────────────────────────────────────────────────────── §7.7
  console.log("\n§7.7 — the loop the static gate priced, measured");
  {
    const lp = loopProgram({ displayOn: false });
    const run = await record("static-loop", lp, {
      steps: bootSteps(lp, { extra: ['I hold the key "SPACE" for 2 frames', "I wait 3 frames"] }),
    });
    const ev = await evaluate(run.storePath, { range: { start: lp.loopAt, end: lp.loopEnd } });
    const measured = ev.report.measured;
    check(ev.report.evaluated === 162, `the loop ran once: ${ev.report.evaluated} instances — ldx, 40 × (lda, sta, dex, bpl), rts`, `${ev.report.evaluated}`);
    check(measured === STATIC_LOOP_CYCLES, `the machine agrees with e2e:861-static to the cycle: ${measured} against ${STATIC_LOOP_CYCLES}`);
    check(ev.report.stolen === 0 && ev.report.inexact === 0, "…with nothing stolen and nothing left as a span");
  }

  // ─────────────────────────────────────────────────────────── §7.3
  console.log("\n§7.3 — a raster interrupt: the seven cycles belong to the entry");
  {
    const irq = rasterIrq({ line: 0x64 });
    const run = await record("raster-irq", irq, { steps: bootSteps(irq, { extra: ["I wait 6 frames"] }) });
    const ev = await evaluate(run.storePath);
    const rep = ev.report;
    check(rep.entries >= 4, `${rep.entries} interrupt entries in six frames — one per frame`, `${rep.entries}`);
    check(rep.entriesVia.vectorReads === rep.entries && rep.entriesVia.noSuccessor === 0,
      "every one was recognised from the traced reads of the vector and the three stack writes — §4.2's fallback was never needed, so the vector reads ARE traced",
      `${rep.entriesVia.vectorReads} by vector, ${rep.entriesVia.noSuccessor} by the fallback`);
    const entryRows = rep.instances.filter((i) => i.entryCycles > 0);
    check(entryRows.every((i) => i.pc === irq.handler), `every entry lands on the handler's first instruction ${hex4(irq.handler)}`,
      [...new Set(entryRows.map((i) => hex4(i.pc)))].join(" "));
    check(entryRows.every((i) => i.measured === 7 + (i.staticCycles ?? 0) + i.stolen), "the 7 cycles of the dispatch are the entry's, on top of the instruction's own");
    check(entryRows.every((i) => i.stolen === 0), "…and nothing is left over as stolen: line 100 is not a bad line",
      entryRows.filter((i) => i.stolen !== 0).map((i) => `${hex4(i.pc)} stolen ${i.stolen} line ${i.line}`).slice(0, 3).join("; "));

    // The instruction BEFORE an entry must not be charged for it.
    const before = entryRows.map((i) => rep.instances[rep.instances.indexOf(i) - 1]).filter(Boolean);
    check(before.length > 0 && before.every((i) => i.stolen === 0 && i.measured === i.staticCycles),
      "no instruction before an entry shows phantom stolen cycles",
      before.filter((i) => i.stolen !== 0).map((i) => `${hex4(i.pc)} ${i.mnemonic} measured ${i.measured} static ${i.staticCycles}`).slice(0, 3).join("; "));

    // Everything else on that machine is a `jmp *` on a display that is ON, so
    // the bad lines are still there — and they are the only stolen cycles.
    const stolenNotOnEntry = rep.instances.filter((i) => i.stolen !== 0);
    check(stolenNotOnEntry.every((i) => i.line !== null && (i.line - 3) % 8 === 0 && i.line >= 48 && i.line <= 247),
      "every other stolen cycle is on a bad line (raster & 7 == the scroll, inside the display)",
      [...new Set(stolenNotOnEntry.map((i) => i.line))].slice(0, 10).join(", "));
  }

  // ─────────────────────────────────────────────────────────── §7.8
  //
  // §7.8 asked for: a drive-code window, stolen == 0 for every instance, because
  // the drive has no DMA. IT CANNOT BE DERIVED, and this gate is what says so.
  //
  // What the runtime records on the drive lane is not an instruction stream: the
  // drive's 6502 runs with a null sink and its PC is sampled at each C64
  // instruction boundary and deduplicated, with the opcode written as a zero
  // ("not observable in sampled mode"). Several drive instructions pass between
  // two rows, so Δclock is not an instruction's cycles, and with no opcode there
  // is nothing to price against.
  //
  // So the tool REFUSES the lane and names what would change it, and this gate
  // asserts the refusal. Priced anyway it came back as a stream of BRKs and
  // minus 1 227 148 stolen cycles — a number that looks like an answer, which is
  // the one outcome §5 exists to prevent.
  console.log("\n§7.8 — the drive's own 6502: the one derivation that cannot be made");
  {
    const lp = loopProgram({ displayOn: false });
    const run = await record("drive", lp, {
      steps: bootSteps(lp),
      afterSteps: 1,                                   // record the LOAD itself
      domains: ["c64-cpu", "drive8-cpu", "memory"],
    });
    const ev = await evaluate(run.storePath, { cpu: "drive8" });
    const rep = ev.report;
    check(rep.rows > 1000, `the drive lane recorded ${rep.rows} rows while the file was read`);
    check(!!rep.laneProblem, "the evaluation REFUSES the drive lane instead of pricing a PC sample", rep.laneProblem?.why?.slice(0, 80));
    check(rep.evaluated === 0 && rep.stolen === 0 && rep.measured === 0, "…and gives no totals at all, so nothing reads as an answer");
    check(/one row per RETIRED drive instruction carrying its opcode/.test(rep.laneProblem?.whatWouldFixIt ?? ""),
      "…and names the smallest change that would make §7.8 answerable");
    console.log(`        the change, for the record: ${rep.laneProblem?.whatWouldFixIt}`);

    // The C64 side of the very same capture IS an instruction stream, which is
    // what makes the refusal a fact about the lane and not about the capture.
    const c64 = await evaluate(run.storePath, { cpu: "c64" });
    check(!c64.report.laneProblem && c64.report.evaluated > 1000,
      `the C64 lane of the same capture evaluates normally: ${c64.report.evaluated} instances`);
  }
  // ─────────────────────────────────────────────── the doors themselves
  //
  // Everything above drives the libraries. §8's three tools are what a caller
  // actually reaches, so they are exercised here too — over MCP stdio, against
  // the stores the gates above recorded, with the reader endpoint pointed at
  // this script's own daemon.
  console.log("\n§8 — the three tools, over MCP, against what was just recorded");
  {
    const { spawn: spawnMcp } = await import("node:child_process");
    const proc = spawnMcp(process.execPath, [join(ROOT, "dist/cli.js")], {
      cwd: tmpdir(),
      env: { ...process.env, C64RE_PROJECT_DIR: work, C64RE_FULL_TOOLS: "", C64RE_RUNTIME_ENDPOINT: `ws://127.0.0.1:${readerPort}` },
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
        let m; try { m = JSON.parse(ln); } catch { continue; }
        if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
      }
    });
    proc.stderr.on("data", () => {});
    const rpcMcp = (method, params) => new Promise((res, rej) => {
      const id = nid++;
      const t = setTimeout(() => { pend.delete(id); rej(new Error(`timeout ${method}`)); }, 300000);
      pend.set(id, (m) => { clearTimeout(t); res(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
    const callTool = async (name, args) => {
      const r = await rpcMcp("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
      return (r.result?.content || []).map((c) => c.text).join("\n");
    };
    try {
      await rpcMcp("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke-861", version: "1" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      await callTool("project_init", { name: "cost861smoke" });
      // A session onboards before it works in a project; the server refuses
      // otherwise, and this gate is local, so nothing in CI caught that it did not.
      await callTool("agent_onboard", {});

      const irqStore = join(work, "raster-irq.duckdb");
      const t = await callTool("trace_cost", { trace_path: irqStore, project_dir: work });
      check(/interrupt entries [1-9]/.test(t), "trace_cost evaluates a store it is handed", t.split("\n").find((l) => l.includes("interrupt entries")));
      check(/anchor: the capture's frame boundary/.test(t), "…reading the anchor back out of the store's own mark");
      check(/per raster line/.test(t), "…and reports where the cycles went, line by line");

      const drive = await callTool("trace_cost", { trace_path: join(work, "drive.duckdb"), cpu: "drive8", project_dir: work });
      check(/NONE of them can be priced/.test(drive), "trace_cost refuses the drive lane through the tool too", drive.split("\n")[1]);

      // The capture half of the same tool: a medium in, a store out, evaluated.
      const lp = loopProgram({ displayOn: false });
      const captured = await callTool("trace_cost", {
        media_path: diskWith("EX", lp),
        steps: bootSteps(lp, { extra: ['I hold the key "SPACE" for 2 frames', "I wait 3 frames"] }),
        record_after_steps: BOOT_STEPS,
        address_start: `$${lp.loopAt.toString(16)}`,
        address_end: `$${lp.loopEnd.toString(16)}`,
        out: join(work, "tool-capture.duckdb"),
        budget_seconds: 540,
        project_dir: work,
      });
      check(/measured 567 cycles · static 567/.test(captured), "trace_cost records its own capture and evaluates it: 567 measured, 567 static",
        captured.split("\n").find((l) => l.includes("measured")));

      const impact = await callTool("change_impact", {
        address_start: `$${lp.loopAt.toString(16)}`, address_end: `$${lp.loopEnd.toString(16)}`,
        trace_path: join(work, "tool-capture.duckdb"), candidate_cycles: 40, project_dir: work,
      });
      check(/timing is a direction of impact too/.test(impact), "change_impact reads a measurement and names the raster lines the code ran in",
        impact.split("\n").find((l) => l.includes("raster line")));
      check(/WARNING: the replacement adds 40 cycles/.test(impact), "…and flags a candidate that will not fit on the busiest line",
        impact.split("\n").find((l) => l.includes("WARNING")));
    } finally {
      proc.kill();
    }
  }
} catch (e) {
  check(false, "the harness", e instanceof Error ? `${e.message}` : String(e));
} finally {
  cleanup();
}

console.log(`\n${failCount ? "RED" : "GREEN"}  smoke-861: ${pass} pass, ${failCount} fail.`);
process.exit(failCount ? 1 : 0);
