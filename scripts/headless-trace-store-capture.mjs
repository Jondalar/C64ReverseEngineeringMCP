#!/usr/bin/env node
// Spec 217 Spike B — headless trace-store capture.
//
// Boots integrated session, attaches TraceStoreProducer to kernel
// trace registry, captures a bounded run, post-builds anchors and
// rollups, exports parquet.
//
// Usage:
//   node scripts/headless-trace-store-capture.mjs \
//     --disk samples/motm.g64 \
//     --run-sec 30 \
//     --type 'LOAD"*",8,1\r' \
//     [--no-parquet]
//
// Output:
//   samples/traces/v2-baseline/<label>-headless-store-<date>/
//     trace.duckdb
//     instructions.parquet
//     bus_events.parquet
//     chip_events.parquet
//     anchors.parquet
//     rollups.parquet
//     summary.json

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, basename, join } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const diskPath = args.disk
  ? resolvePath(repoRoot, args.disk)
  : resolvePath(repoRoot, "samples/motm.g64");
const runSec = Number(args["run-sec"] ?? 5);
// Shell-quoted "\r" arrives as literal backslash+r; convert to CR.
// Same for "\n", "\t" as a convenience.
const typeText = (args.type ?? "")
  .replace(/\\r/g, "\r")
  .replace(/\\n/g, "\n")
  .replace(/\\t/g, "\t");
const label = args.label ?? basename(diskPath).split(".")[0].split("[")[0];
const enableParquet = args["no-parquet"] !== true;
const traceMode = args.mode ?? "true-drive";

if (!existsSync(diskPath)) {
  console.error(`disk not found: ${diskPath}`);
  process.exit(2);
}

const date = new Date().toISOString().slice(0, 10);
const outRoot = resolvePath(repoRoot, `samples/traces/v2-baseline/${label}-headless-store-${date}`);
if (!existsSync(outRoot)) mkdirSync(outRoot, { recursive: true });
const dbPath = join(outRoot, "trace.duckdb");
if (existsSync(dbPath)) {
  console.error(`store already exists: ${dbPath}. delete or move first.`);
  process.exit(2);
}

console.log(`headless-trace-store-capture (Spec 217 Spike B)`);
console.log(`  disk     : ${diskPath}`);
console.log(`  mode     : ${traceMode}`);
console.log(`  run sec  : ${runSec}`);
console.log(`  type     : ${typeText.slice(0, 40)}${typeText.length > 40 ? "…" : ""}`);
console.log(`  out      : ${outRoot}`);

const { startIntegratedSession } = await import(`${repoRoot}/dist/runtime/headless/integrated-session-manager.js`);
const { openStore, closeStore, exportParquet, DuckDbTraceSink } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { TraceStoreProducer } = await import(`${repoRoot}/dist/runtime/trace-store/producer.js`);
const { buildAnchors, DEFAULT_MOTM_ANCHORS } = await import(`${repoRoot}/dist/runtime/trace-store/anchor-builder.js`);
const { buildRollups } = await import(`${repoRoot}/dist/runtime/trace-store/rollup-builder.js`);

// ---------- session + store ----------

const PAL_HZ = 985_248;
const DRIVE_HZ = 1_000_000;
const RUN_CYC = runSec * PAL_HZ;

const runId = `headless-${label}-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
const meta = {
  runId,
  source: "headless",
  capturedAt: new Date().toISOString(),
  writerVersion: process.env.C64RE_GIT_SHA ?? "dev",
  c64ClockHz: PAL_HZ,
  driveClockHz: DRIVE_HZ,
  c64ClockZero: 0n,
  driveClockZero: 0n,
  driveToC64Offset: 0n,
};
const store = await openStore({ path: dbPath, meta });
const sink = new DuckDbTraceSink({ store });

const masterClockMapper = (cpu, sourceClock) => {
  // Spec 218: preserve full clock width. `sourceClock` is either a JS
  // number (safe integer) or a bigint; never coerce through u32.
  const sc = typeof sourceClock === "bigint" ? sourceClock : BigInt(sourceClock);
  if (cpu === "drive8") {
    // master_clock = round((drive_clock - 0) × 985248 / 1000000) + 0
    return (sc * 985248n) / 1000000n;
  }
  return sc;
};

const producer = new TraceStoreProducer({
  source: "headless",
  sink,
  masterClockMapper,
  capacity: 65536,
});

// Spec 142: bus-access tracing wired via integrated-session option.
// Without enableBusAccessTrace=true the producer never installs hooks
// on $DD00/$1800, so the bus_access channel stays empty.
// Spec 218: --microcoded flag swaps c64 + drive cpu to Cpu65xxVice
// (cycle-precise port of VICE's microcoded core) instead of the
// legacy Cpu6510 interpreter. Cpu6510 has small per-instruction
// cycle-accounting drift vs VICE that accumulates over thousands of
// KERNAL-serial-output instructions and flips the $EEA9 debounce-loop
// iteration count, snowballing into the motm fastloader stall.
const useMicrocodedCpu = args.microcoded === true;
console.log(`  microcoded: ${useMicrocodedCpu}`);

const { session } = startIntegratedSession({
  diskPath,
  mode: traceMode,
  useMicrocodedCpu,
  enableBusAccessTrace: true,
  // Empty PC ranges = no filter = capture all $DD00 and $1800 events.
  busAccessPcRangesC64: [],
  busAccessPcRangesDrive: [],
});
session.resetCold("pal-default");

// Enable channels in ring mode (cheap, observer fires regardless via
// Spec 217 option B). bus_access producer also requires the channel
// to be enabled to actually publish.
const reg = session.traceRegistry;
for (const name of ["cpu", "iec", "irq", "cia", "vic", "gcr", "bus_access"]) {
  reg.configure(name, { mode: "ring", capacity: 16 });
}

const dispose = producer.attach((handler) => reg.registerObserver(handler));

// Type input + run.
session.runFor(800_000); // boot to BASIC ready
if (typeText) session.typeText(typeText, 80_000, 80_000);

const t0 = Date.now();
let runCycles = session.c64Cpu.cycles;
const target = runCycles + RUN_CYC;
let lastReport = Date.now();
while (session.c64Cpu.cycles < target) {
  session.runFor(50_000);
  if (Date.now() - lastReport > 5000) {
    const sec = ((session.c64Cpu.cycles - runCycles) / PAL_HZ).toFixed(1);
    console.log(`  ... t=${sec}s c64PC=$${session.c64Cpu.pc.toString(16)} drvPC=$${session.drive.cpu.pc.toString(16)}`);
    lastReport = Date.now();
  }
}
const runMs = Date.now() - t0;

// Detach + flush.
dispose();
const summary = await producer.close();

console.log(``);
console.log(`capture done in ${runMs}ms wall (${(runMs / 1000).toFixed(1)}s)`);
console.log(`  instructions: ${summary.instructionsWritten}`);
console.log(`  bus_events  : ${summary.busEventsWritten}`);
console.log(`  chip_events : ${summary.chipEventsWritten}`);
console.log(`  dropped     : ${summary.droppedEvents}`);
console.log(``);

// ---------- post-build ----------
console.log(`building anchors (default motm set)...`);
const anchorRes = await buildAnchors(store, DEFAULT_MOTM_ANCHORS);
console.log(`  anchors written: ${anchorRes.anchorsWritten}`);

console.log(`building rollups (4 levels)...`);
const rollupRes = await buildRollups(store);
console.log(`  rollups written: ${rollupRes.rollupsWritten}`);

// ---------- parquet export ----------
let parquetSummary = null;
if (enableParquet) {
  console.log(`exporting parquet (ZSTD)...`);
  const written = await exportParquet(store, { outDir: outRoot, compression: "ZSTD" });
  parquetSummary = {};
  for (const f of written) {
    if (existsSync(f)) parquetSummary[basename(f)] = statSync(f).size;
  }
  console.log(`  parquet:`, parquetSummary);
}

// ---------- summary.json ----------
const summaryJson = {
  runId,
  label,
  disk: diskPath,
  mode: traceMode,
  runSec,
  capturedAt: meta.capturedAt,
  writerVersion: meta.writerVersion,
  c64ClockHz: PAL_HZ,
  driveClockHz: DRIVE_HZ,
  capturedCounts: {
    instructions: summary.instructionsWritten,
    busEvents: summary.busEventsWritten,
    chipEvents: summary.chipEventsWritten,
    dropped: summary.droppedEvents,
  },
  anchorsWritten: anchorRes.anchorsWritten,
  rollupsWritten: rollupRes.rollupsWritten,
  parquetSizes: parquetSummary,
  notes: [
    "Spec 218 Step 3: instructions table includes full register state",
    "(pc, opcode, b1, b2, a, x, y, sp, p, clock, master_clock). b1/b2",
    "for the c64-side cpu6510 are peeked from memory at startPc+1/+2",
    "without bumping the cycle counter, so they don't perturb timing.",
  ],
};
writeFileSync(join(outRoot, "summary.json"), JSON.stringify(summaryJson, null, 2));
console.log(`summary -> ${join(outRoot, "summary.json")}`);

await closeStore(store);

console.log(``);
console.log(`done.`);
