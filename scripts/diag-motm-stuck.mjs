#!/usr/bin/env node
// Deep diagnostic for motm LOAD"*",8,1 DATA-release stall.
// Boots, types LOAD"*",8,1, runs to ~40s, then samples drive
// + IEC + GCR + $DD00 every 50_000 c64 cycles for ~10s real-time
// of "stuck" execution. Dumps a JSONL trace + summary.

import { existsSync, mkdirSync, writeFileSync, openSync, appendFileSync, closeSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { startIntegratedSession } from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

const DISK = resolvePath("samples/motm.g64");
const OUT_DIR = resolvePath("samples/screenshots/motm-stuck-diag");
const PAL_CYCLES_PER_SEC = 985_248;
const WARMUP_SEC = 35;        // run to known-stuck point
const STUCK_OBSERVE_SEC = 5;  // record state for this many seconds
const SAMPLE_EVERY_CYC = 50_000; // ~50ms

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const TRACE_PATH = join(OUT_DIR, "stuck-trace.jsonl");
const LOG_PATH = join(OUT_DIR, "diag.log");
const log = [];
function logLine(line) { console.log(line); log.push(line); }

logLine(`diag-motm-stuck`);
logLine(`  disk        : ${DISK}`);
logLine(`  warmup      : ${WARMUP_SEC}s`);
logLine(`  observe     : ${STUCK_OBSERVE_SEC}s`);
logLine(`  sample cyc  : ${SAMPLE_EVERY_CYC}`);

const { session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive" });
session.resetCold("pal-default");

session.runFor(800_000); // KERNAL boot
session.typeText('LOAD"*",8,1\r', 80_000, 80_000);

// Run to stuck-window start.
const stuckStart = WARMUP_SEC * PAL_CYCLES_PER_SEC;
while (session.c64Cpu.cycles < stuckStart) {
  session.runFor(100_000);
}
logLine(`  warmup done at c64cyc=${session.c64Cpu.cycles}`);
logLine(`    c64PC=$${session.c64Cpu.pc.toString(16)} drvPC=$${session.drive.cpu.pc.toString(16)} track=${session.headPosition.currentTrack}`);

// Render stuck-state PNG.
session.renderToPng(join(OUT_DIR, "stuck-state.png"));

// Sample loop.
const fd = openSync(TRACE_PATH, "w");
const stuckEnd = stuckStart + STUCK_OBSERVE_SEC * PAL_CYCLES_PER_SEC;
let nextSample = session.c64Cpu.cycles;
const samples = [];
const drvPcCounts = new Map();
const c64PcCounts = new Map();

while (session.c64Cpu.cycles < stuckEnd) {
  session.runFor(SAMPLE_EVERY_CYC);
  const ts = session.c64Cpu.cycles;
  const c64pc = session.c64Cpu.pc;
  const drvpc = session.drive.cpu.pc;
  const shifter = session.gcrShifter.snapshot();
  const iec = session.iecBus.core.snapshot();
  const dd00 = session.c64Bus.read(0xdd00);
  const drvVia1Pb = session.drive.bus.via1.read(0x0); // ORB/IRB
  const sample = {
    ts,
    c64pc,
    drvpc,
    track: session.headPosition.currentTrack,
    halfTrack: session.headPosition.currentHalfTrack,
    motorOn: shifter.motorOn,
    bitOffset: shifter.bitOffset,
    syncActive: shifter.syncActive,
    dataByte: shifter.dataByte,
    densityOverride: shifter.densityOverride,
    iec: {
      cpu_bus: iec.cpu_bus,
      cpu_port: iec.cpu_port,
      drv_port: iec.drv_port,
      drv_data_8: iec.drv_data_8,
      old_atn: iec.iec_old_atn,
    },
    dd00_read: dd00,
    drv_via1_pb: drvVia1Pb,
  };
  samples.push(sample);
  appendFileSync(fd, JSON.stringify(sample) + "\n");
  drvPcCounts.set(drvpc, (drvPcCounts.get(drvpc) ?? 0) + 1);
  c64PcCounts.set(c64pc, (c64PcCounts.get(c64pc) ?? 0) + 1);
}

closeSync(fd);

// Summary.
const first = samples[0];
const last = samples[samples.length - 1];

logLine("");
logLine(`---- stuck observation summary ----`);
logLine(`  samples              : ${samples.length}`);
logLine(`  cycles spanned       : ${last.ts - first.ts}`);
logLine(`  motor              t0: ${first.motorOn} | tN: ${last.motorOn}`);
logLine(`  track              t0: ${first.track} | tN: ${last.track}`);
logLine(`  bitOffset          t0: ${first.bitOffset} | tN: ${last.bitOffset}  Δ=${last.bitOffset - first.bitOffset}`);
logLine(`  syncActive         t0: ${first.syncActive} | tN: ${last.syncActive}`);
logLine(`  dataByte           t0: $${first.dataByte.toString(16)} | tN: $${last.dataByte.toString(16)}`);
logLine(`  density            t0: ${first.densityOverride} | tN: ${last.densityOverride}`);
logLine(`  $DD00              t0: $${first.dd00_read.toString(16)} | tN: $${last.dd00_read.toString(16)}`);
logLine(`  drv VIA1 PB        t0: $${first.drv_via1_pb.toString(16)} | tN: $${last.drv_via1_pb.toString(16)}`);
logLine(`  IEC cpu_bus        t0: $${first.iec.cpu_bus.toString(16)} | tN: $${last.iec.cpu_bus.toString(16)}`);
logLine(`  IEC cpu_port       t0: $${first.iec.cpu_port.toString(16)} | tN: $${last.iec.cpu_port.toString(16)}`);
logLine(`  IEC drv_port       t0: $${first.iec.drv_port.toString(16)} | tN: $${last.iec.drv_port.toString(16)}`);
logLine(`  IEC drv_data_8     t0: $${first.iec.drv_data_8.toString(16)} | tN: $${last.iec.drv_data_8.toString(16)}`);

logLine("");
logLine(`  drive PC histogram (top 10):`);
const drvSorted = [...drvPcCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [pc, n] of drvSorted) {
  logLine(`    $${pc.toString(16).padStart(4, "0")}  ${n}`);
}
logLine("");
logLine(`  c64 PC histogram (top 10):`);
const c64Sorted = [...c64PcCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [pc, n] of c64Sorted) {
  logLine(`    $${pc.toString(16).padStart(4, "0")}  ${n}`);
}

writeFileSync(LOG_PATH, log.join("\n") + "\n");
logLine("");
logLine(`trace: ${TRACE_PATH}`);
logLine(`log  : ${LOG_PATH}`);
