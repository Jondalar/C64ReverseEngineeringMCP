#!/usr/bin/env node
// Spec 217 Spike C — VICE trace-store capture.
//
// Spawns VICE binmon, polls cpuhistory (c64 + drive) and selected
// monitor/bus addresses on a fixed interval, dedups by clock per
// memspace (lesson from earlier trace-worker bug), and writes
// directly into the DuckDB trace store schema.
//
// Output:
//   samples/traces/v2-baseline/<label>-vice-store-<date>/
//     trace.duckdb
//     instructions.parquet
//     bus_events.parquet
//     chip_events.parquet
//     anchors.parquet
//     rollups.parquet
//     summary.json
//
// Usage:
//   node scripts/vice-trace-store-capture.mjs \
//     --disk samples/motm.g64 \
//     [--label motm] \
//     [--interval-ms 50] \
//     [--cpu-history 50000] \
//     [--port 6510] \
//     [--no-parquet]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, basename, join } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const VICE_X64SC = process.env.VICE_X64SC ?? "/opt/homebrew/Cellar/vice/3.10/bin/x64sc";

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
const intervalMs = Number(args["interval-ms"] ?? 50);
const cpuHistoryCount = Number(args["cpu-history"] ?? 50000);
const port = Number(args.port ?? 6510);
const enableParquet = args["no-parquet"] !== true;
const label = args.label ?? basename(diskPath).split(".")[0].split("[")[0];

if (!existsSync(diskPath)) { console.error(`disk not found: ${diskPath}`); process.exit(2); }
if (!existsSync(VICE_X64SC)) { console.error(`x64sc not found: ${VICE_X64SC} (set VICE_X64SC env)`); process.exit(2); }

const date = new Date().toISOString().slice(0, 10);
const outRoot = resolvePath(repoRoot, `samples/traces/v2-baseline/${label}-vice-store-${date}`);
if (!existsSync(outRoot)) mkdirSync(outRoot, { recursive: true });
const dbPath = join(outRoot, "trace.duckdb");
if (existsSync(dbPath)) {
  console.error(`store already exists: ${dbPath}. delete or move first.`);
  process.exit(2);
}

console.log(`vice-trace-store-capture (Spec 217 Spike C)`);
console.log(`  disk         : ${diskPath}`);
console.log(`  port         : ${port}`);
console.log(`  interval-ms  : ${intervalMs}`);
console.log(`  cpu-history  : ${cpuHistoryCount}`);
console.log(`  out          : ${outRoot}`);

const { ViceMonitorClient } = await import(`${repoRoot}/dist/runtime/vice/monitor-client.js`);
const { openStore, closeStore, exportParquet, DuckDbTraceSink } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { TraceStoreProducer } = await import(`${repoRoot}/dist/runtime/trace-store/producer.js`);
const { buildAnchors, DEFAULT_MOTM_ANCHORS } = await import(`${repoRoot}/dist/runtime/trace-store/anchor-builder.js`);
const { buildRollups } = await import(`${repoRoot}/dist/runtime/trace-store/rollup-builder.js`);

const PAL_HZ = 985_248;
const DRIVE_HZ = 1_000_000;

// ---------------------------------------------------------------------
// Spawn VICE
// ---------------------------------------------------------------------
const extraArgs = (process.env.VICE_EXTRA_ARGS ?? "").split(" ").filter(Boolean);
const viceArgs = [
  "-default",
  "-monchislines", "16777215",   // VICE flag for cpuhistory ring size
  "-binarymonitor", "-binarymonitoraddress", `ip4://127.0.0.1:${port}`,
  ...extraArgs,
  "-8", diskPath,
];
console.log(`launching: ${VICE_X64SC} ${viceArgs.join(" ")}`);
const child = spawn(VICE_X64SC, viceArgs, { stdio: ["ignore", "ignore", "ignore"] });
let viceExited = false;
child.on("exit", () => { viceExited = true; });

// Wait for VICE to be ready.
await new Promise((r) => setTimeout(r, 2500));

const client = new ViceMonitorClient({ host: "127.0.0.1", port });
let connected = false;
for (let i = 0; i < 12 && !connected; i++) {
  try { await client.connect(2000); connected = true; }
  catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!connected) { console.error("could not connect to VICE binmon"); child.kill(); process.exit(2); }
console.log(`binmon connected.`);

// ---------------------------------------------------------------------
// Probe initial clocks for clock-zero + drive-to-c64-offset
// ---------------------------------------------------------------------
async function readClk(memspace) {
  const regs = await client.getRegisters(memspace);
  // Some VICE builds expose CLK as a register (id 53/54/etc per
  // earlier observation). For master-clock mapping we try id 53 first.
  // Fallback: derive from CPU history's last clock.
  const clkReg = regs.find((r) => r.id === 53);
  return clkReg ? BigInt(clkReg.value) : null;
}

const c64ClockZeroMaybe = await readClk(0x00);
const drvClockZeroMaybe = await readClk(0x01);
let c64ClockZero = c64ClockZeroMaybe ?? 0n;
let drvClockZero = drvClockZeroMaybe ?? 0n;
let driveToC64Offset = 0n;
if (c64ClockZeroMaybe !== null && drvClockZeroMaybe !== null) {
  // master_clock(c64) = 0 at zero; master_clock(drive) = round((drv - drv_zero) * 985248 / 1e6) + offset.
  // At t=zero we want both to map to 0 → offset = 0.
  driveToC64Offset = 0n;
}
console.log(`clock-zero: c64=${c64ClockZero}, drv=${drvClockZero}, offset=${driveToC64Offset}`);

// ---------------------------------------------------------------------
// Open store + producer
// ---------------------------------------------------------------------
const runId = `vice-${label}-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}`;
const meta = {
  runId,
  source: "vice",
  capturedAt: new Date().toISOString(),
  writerVersion: process.env.C64RE_GIT_SHA ?? "spike-c",
  c64ClockHz: PAL_HZ,
  driveClockHz: DRIVE_HZ,
  c64ClockZero,
  driveClockZero: drvClockZero,
  driveToC64Offset,
};
const store = await openStore({ path: dbPath, meta });
const sink = new DuckDbTraceSink({ store });

const masterClockMapper = (cpu, sourceClock) => {
  // Spec 218: preserve full clock width. `sourceClock` is either a JS
  // number (safe integer) or a bigint; never coerce through u32.
  const sc = typeof sourceClock === "bigint" ? sourceClock : BigInt(sourceClock);
  if (cpu === "drive8") {
    const rel = sc - drvClockZero;
    return (rel * 985248n) / 1000000n + driveToC64Offset;
  }
  return sc - c64ClockZero;
};

const producer = new TraceStoreProducer({
  source: "vice",
  sink,
  masterClockMapper,
  capacity: 65536,
});

// Bus events are derived post-hoc from cpuhistory + post-instruction
// register state (see scripts/derive-bus-events.mjs). Skipping live
// readMemory polls keeps the capture loop at trace-worker speed.

// Dedup state
let lastClkC64 = null;
let lastClkDrv = null;

// ---------------------------------------------------------------------
// Resume + start poll loop
// ---------------------------------------------------------------------
console.error(``);
console.error(`════════════════════════════════════════════════════════════════════════`);
console.error(`  USER ACTION REQUIRED:`);
console.error(`    1. VICE window is open with disk attached.`);
console.error(`    2. At BASIC READY, type:  LOAD"*",8,1   then RETURN`);
console.error(`    3. Watch boot.`);
console.error(`    4. Close VICE window when in-game (or fail point).`);
console.error(`════════════════════════════════════════════════════════════════════════`);
console.error(``);

// Per-side reg-id constants (verified via earlier exploration:
//   id 0=A, 1=X, 2=Y, 3=PC, 4=SP, 5=SR/FL).
const REG_A = 0, REG_X = 1, REG_Y = 2, REG_PC = 3, REG_SP = 4, REG_SR = 5;

let pollCount = 0;
let totalC64Instr = 0;
let totalDrvInstr = 0;

await client.resume();

while (!viceExited) {
  await new Promise((r) => setTimeout(r, intervalMs));
  if (viceExited) break;
  try {
    // Each binmon command pauses VICE; resume after.
    const c64Hist = await client.getCpuHistory(cpuHistoryCount, 0x00).catch(() => []);
    const drvHist = await client.getCpuHistory(cpuHistoryCount, 0x01).catch(() => []);

    for (const item of c64Hist) {
      const clk = BigInt(item.clock);
      if (lastClkC64 !== null && clk <= lastClkC64) continue;
      lastClkC64 = clk;
      const regs = item.registers;
      const get = (id) => regs.find((r) => r.id === id)?.value ?? 0;
      const pc = get(REG_PC);
      const ib = item.instructionBytes;
      const opcode = ib?.[0] ?? 0;
      const b1 = ib?.[1];
      const b2 = ib?.[2];
      producer.publishInstruction("c64", pc, opcode,
        get(REG_A), get(REG_X), get(REG_Y), get(REG_SP), get(REG_SR), clk, b1, b2);
      totalC64Instr++;
    }
    for (const item of drvHist) {
      const clk = BigInt(item.clock);
      if (lastClkDrv !== null && clk <= lastClkDrv) continue;
      lastClkDrv = clk;
      const regs = item.registers;
      const get = (id) => regs.find((r) => r.id === id)?.value ?? 0;
      const pc = get(REG_PC);
      const ib = item.instructionBytes;
      const opcode = ib?.[0] ?? 0;
      const b1 = ib?.[1];
      const b2 = ib?.[2];
      producer.publishInstruction("drive8", pc, opcode,
        get(REG_A), get(REG_X), get(REG_Y), get(REG_SP), get(REG_SR), clk, b1, b2);
      totalDrvInstr++;
    }

    await client.resume();
    pollCount++;
    if (pollCount % 200 === 0) {
      console.log(`  poll #${pollCount}  c64=${totalC64Instr}  drv=${totalDrvInstr}`);
    }
  } catch (e) {
    if (viceExited) break;
    // Probably VICE just died.
    console.log(`  poll err: ${e.message}`);
    break;
  }
}

console.log(`\nVICE exited (or disconnected). Wrapping up...`);
client.close();

const summary = await producer.close();

console.log(`capture done: c64=${summary.instructionsWritten} drv-instr included; bus_events=${summary.busEventsWritten}; chip=${summary.chipEventsWritten}; dropped=${summary.droppedEvents}`);

console.log(`building anchors...`);
const anchorRes = await buildAnchors(store, DEFAULT_MOTM_ANCHORS);
console.log(`  anchors written: ${anchorRes.anchorsWritten}`);

console.log(`building rollups...`);
const rollupRes = await buildRollups(store);
console.log(`  rollups written: ${rollupRes.rollupsWritten}`);

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

const summaryJson = {
  runId,
  label,
  disk: diskPath,
  source: "vice",
  intervalMs,
  cpuHistoryCount,
  capturedAt: meta.capturedAt,
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
    "Spec 217 Spike C: VICE binmon poll-loop into trace store.",
    "cpuhistory dedup-by-clock per memspace (separate lastClkC64 + lastClkDrv).",
    "Bus watches sampled per poll on value-change only.",
    "chip_events not yet emitted from VICE side (Spec 217 §provenance:",
    "VICE chip_events would be derived via PC-at-IRQ-vector inspection",
    "of cpuhistory; deferred to later spec).",
  ],
};
writeFileSync(join(outRoot, "summary.json"), JSON.stringify(summaryJson, null, 2));

await closeStore(store);

if (!viceExited) {
  try { child.kill(); } catch {}
}
console.log(`\ndone. summary -> ${join(outRoot, "summary.json")}`);
