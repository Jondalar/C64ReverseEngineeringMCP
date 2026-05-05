#!/usr/bin/env node
// Spec 142 — bus-access trace smoke for motm receive window.
//
// Loads samples/test-manifest.json, picks an entry by --id (default
// "motm"), runs integrated session with bus_access channel in jsonl
// mode, PC window filter on drive [$042F-$044C, $0700-$07FF], stops
// after cycle budget or N events captured.
//
// Output:
//   - JSONL trace: traces/<id>_busaccess_<timestamp>.jsonl
//   - stdout summary: total events, c64 events, drive events,
//     first/last cycle, first 5 drive $1800 events with bytes
//
// Usage:
//   npm run test:bus-trace -- [--id motm] [--cycle-budget 35000000]
//                              [--max-events 2000] [--out path.jsonl]

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));
const id = args.id ?? "motm";
const cycleBudget = args["cycle-budget"] ? Number(args["cycle-budget"]) : 35_000_000;
const maxEvents = args["max-events"] ? Number(args["max-events"]) : 2000;
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;
// Spec 138 probe variant (A/B/C). Undefined = production mode.
const probeMode = args["probe-mode"];

// Load manifest
const manifestPath = join(repoRoot, "samples/test-manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const entry = manifest.entries.find((e) => e.id === id);
if (!entry) {
  console.error(`Manifest entry not found: id=${id}`);
  console.error(`Available ids: ${manifest.entries.map((e) => e.id).join(", ")}`);
  process.exit(2);
}

const diskPath = join(repoRoot, "samples", entry.file);
if (!existsSync(diskPath)) {
  console.error(`Disk image missing (gitignored — local only): ${diskPath}`);
  process.exit(2);
}

const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = args.out
  ? resolve(projectDir, args.out)
  : join(projectDir, "traces", `${id}_busaccess_${tsTag}.jsonl`);
mkdirSync(dirname(outPath), { recursive: true });

console.error(`Spec 142 bus-access smoke`);
console.error(`Manifest entry: ${entry.id} (${entry.family}, mode=${entry.mode}, status=${entry.status})`);
console.error(`Disk: ${diskPath} (${statSync(diskPath).size} bytes)`);
console.error(`Output: ${outPath}`);
console.error(`Cycle budget: ${cycleBudget.toLocaleString()}  Max events: ${maxEvents}`);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");

// Drive PC ranges per Spec 142: motm receive window + stage-2 entry
const drivePcRanges = id === "motm"
  ? [[0x042F, 0x044C], [0x0700, 0x07FF]]
  : [];

const { session } = startIntegratedSession({
  diskPath,
  useCycleLockstep: true,
  useMicrocodedCpu: true,
  enableBusAccessTrace: true,
  busAccessPcRangesDrive: drivePcRanges,
  // C64 side: empty = always emit (we want full c64 $DD00 traffic)
  busAccessPcRangesC64: [],
  // Spec 138 probe variant.
  probeMode: probeMode === "A" || probeMode === "B" || probeMode === "C" ? probeMode : undefined,
});
if (probeMode) console.error(`Probe variant: ${probeMode}`);
session.traceRegistry.configure("bus_access", { mode: "jsonl", path: outPath });

session.resetCold();

// Phase A: producer DISABLED until drive PC enters motm receive window.
// Avoids burning budget on KERNAL ACPTR loop reads of $DD00.
session.busAccessProducer?.disable();

// Autoboot.
if (session.scheduler) session.scheduler.runCycles(2_500_000);
session.typeText('LOAD"*",8,1\n');
if (session.scheduler) session.scheduler.runCycles(2_000_000);
session.typeText("RUN\n");

console.error(`Phase A complete (autoboot typed): c64 cyc=${session.c64Cpu.cycles}`);

// Phase B: poll for drive PC in motm range, enable producer when seen.
const t0 = Date.now();
const startCycles = session.scheduler ? session.scheduler.c64Cycle() : session.c64Cpu.cycles;
// Larger chunks before trigger (fast-forward), small chunks after to
// honour max-events precisely.
const chunkPre = 50_000;
const chunkPost = 500;
let stepped = 0;
let producerSeq = 0;
let triggered = false;

const drivePc = () => session.drive.cpu.pc & 0xffff;
const inMotmRange = (pc) => (pc >= 0x042F && pc <= 0x044C) || (pc >= 0x0700 && pc <= 0x07FF);

while (stepped < cycleBudget) {
  const chunk = Math.min(triggered ? chunkPost : chunkPre, cycleBudget - stepped);
  if (session.scheduler) {
    session.scheduler.runCycles(chunk);
  } else {
    for (let i = 0; i < chunk; i++) session.c64Cpu.step();
  }
  stepped += chunk;

  if (!triggered) {
    if (inMotmRange(drivePc())) {
      triggered = true;
      session.busAccessProducer?.resetSeq();
      session.busAccessProducer?.enable();
      console.error(`Phase B: drive PC reached motm range at c64 cyc ~${session.scheduler?.c64Cycle() ?? "?"} pc=$${drivePc().toString(16)}`);
    }
  } else {
    producerSeq = session.busAccessProducer ? session.busAccessProducer.getSeqCount() : 0;
    if (producerSeq >= maxEvents) {
      console.error(`Reached max events (${producerSeq}), stopping at cycle ${session.scheduler?.c64Cycle() ?? "?"}`);
      break;
    }
  }
}

if (!triggered) {
  console.error(`(drive PC never entered motm range within budget)`);
}

const elapsed = Date.now() - t0;
const endCycles = session.scheduler ? session.scheduler.c64Cycle() : session.c64Cpu.cycles;

session.traceRegistry.closeAll();

console.error(``);
console.error(`Run complete in ${elapsed} ms`);
console.error(`Cycles: ${startCycles.toLocaleString()} → ${endCycles.toLocaleString()} (${(endCycles - startCycles).toLocaleString()})`);
console.error(`Events captured: ${producerSeq}`);

// Summary: read back JSONL
if (!existsSync(outPath)) {
  console.error(`(no JSONL written — channel may have been off)`);
  process.exit(0);
}
const lines = readFileSync(outPath, "utf-8").split("\n").filter(Boolean);
const events = lines.map((l) => JSON.parse(l));
const c64Events = events.filter((e) => e.data.side === "c64");
const driveEvents = events.filter((e) => e.data.side === "drive");
console.error(`JSONL: ${lines.length} lines  c64: ${c64Events.length}  drive: ${driveEvents.length}`);

if (events.length > 0) {
  const first = events[0].data;
  const last = events[events.length - 1].data;
  console.error(`First: cyc=${first.cycle_c64} ${first.side} ${first.op} $${first.addr.toString(16)}=$${first.value.toString(16).padStart(2, "0")} pc=$${first.pc.toString(16)}`);
  console.error(`Last:  cyc=${last.cycle_c64} ${last.side} ${last.op} $${last.addr.toString(16)}=$${last.value.toString(16).padStart(2, "0")} pc=$${last.pc.toString(16)}`);
}

if (driveEvents.length > 0) {
  console.error(``);
  console.error(`First 10 drive $1800 events (motm receive bytes):`);
  for (const ev of driveEvents.slice(0, 10)) {
    const d = ev.data;
    const flag = d.at_boundary ? "B" : "-";
    console.error(`  cyc_d=${d.cycle_drive.toString().padStart(8)} ${d.op} $${d.addr.toString(16)}=$${d.value.toString(16).padStart(2, "0")}  pc=$${d.pc.toString(16).padStart(4, "0")} ${flag} iec={atn:${d.iec.atn} clk:${d.iec.clk} data:${d.iec.data}}`);
  }
}

console.error(``);
console.error(`Trace artifact: ${outPath}`);
