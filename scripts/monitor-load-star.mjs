#!/usr/bin/env node
// Monitor a LOAD"*",8,1 boot for >100s. Polls drive head/motor/density,
// renders periodic PNGs, and dumps a summary of head movement.
//
// Usage:
//   DISK=samples/maniac_mansion_s1[...].g64 LABEL=mm node scripts/monitor-load-star.mjs
//   DISK=samples/motm.g64 LABEL=motm node scripts/monitor-load-star.mjs
//
// Env:
//   DISK             path to .g64 disk
//   LABEL            short label for output dir (mm | motm | etc.)
//   RUN_SEC          run length in PAL seconds (default 120)
//   POLL_EVERY_CYC   sample drive head every N c64 cycles (default 200_000 ~ 0.2s)
//   RENDER_EVERY_SEC render PNG every N seconds (default 5)

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { startIntegratedSession } from "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/dist/runtime/headless/integrated-session-manager.js";

const DISK = process.env.DISK ? resolvePath(process.env.DISK) : null;
const LABEL = process.env.LABEL ?? "run";
const RUN_SEC = Number(process.env.RUN_SEC ?? 120);
const POLL_EVERY_CYC = Number(process.env.POLL_EVERY_CYC ?? 200_000);
const RENDER_EVERY_SEC = Number(process.env.RENDER_EVERY_SEC ?? 5);
const PAL_CYCLES_PER_SEC = 985_248;
const TARGET_CYCLES = RUN_SEC * PAL_CYCLES_PER_SEC;
const RENDER_EVERY_CYC = RENDER_EVERY_SEC * PAL_CYCLES_PER_SEC;

if (!DISK) {
  console.error("DISK= must be set");
  process.exit(2);
}
if (!existsSync(DISK)) {
  console.error(`disk not found: ${DISK}`);
  process.exit(2);
}

const OUT_DIR = resolvePath(`samples/screenshots/${LABEL}-monitor`);
const LOG_PATH = join(OUT_DIR, "monitor.log");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const log = [];
function logLine(line) {
  console.log(line);
  log.push(line);
}

logLine(`monitor-load-star`);
logLine(`  disk        : ${DISK}`);
logLine(`  label       : ${LABEL}`);
logLine(`  RUN_SEC     : ${RUN_SEC}`);
logLine(`  poll cyc    : ${POLL_EVERY_CYC} (${(POLL_EVERY_CYC / PAL_CYCLES_PER_SEC).toFixed(3)}s)`);
logLine(`  render sec  : ${RENDER_EVERY_SEC}`);
logLine(`  out dir     : ${OUT_DIR}`);

const t0 = Date.now();
const { session } = startIntegratedSession({ diskPath: DISK, mode: "true-drive" });
session.resetCold("pal-default");

// Enable gcr channel ring buffer for motor/density/byte-ready/sync edges.
session.traceRegistry.configure("gcr", { mode: "ring", capacity: 4096 });

// frame 0
session.renderToPng(join(OUT_DIR, "frame-000-cold.png"));
logLine(`  frame 000 cold (track=${session.headPosition.currentTrack})`);

// boot KERNAL
session.runFor(800_000);
session.renderToPng(join(OUT_DIR, "frame-001-ready.png"));
logLine(`  frame 001 ready PC=$${session.c64Cpu.pc.toString(16)} drvPC=$${session.drive.cpu.pc.toString(16)}`);

session.typeText('LOAD"*",8,1\r', 80_000, 80_000);
session.renderToPng(join(OUT_DIR, "frame-002-load-typed.png"));
logLine(`  frame 002 LOAD typed PC=$${session.c64Cpu.pc.toString(16)} drvPC=$${session.drive.cpu.pc.toString(16)}`);

// poll loop
const trackHistory = []; // { t, c64pc, drvpc, track, halfTrack }
let lastTrack = session.headPosition.currentTrack;
let stepCount = 0;
let nextRenderCyc = session.c64Cpu.cycles + RENDER_EVERY_CYC;
let nextPollCyc = session.c64Cpu.cycles + POLL_EVERY_CYC;
let frameIdx = 3;

while (session.c64Cpu.cycles < TARGET_CYCLES) {
  session.runFor(50_000);

  if (session.c64Cpu.cycles >= nextPollCyc) {
    const t = (session.c64Cpu.cycles / PAL_CYCLES_PER_SEC).toFixed(2);
    const track = session.headPosition.currentTrack;
    const halfTrack = session.headPosition.currentHalfTrack;
    const c64pc = session.c64Cpu.pc;
    const drvpc = session.drive.cpu.pc;
    if (track !== lastTrack) {
      stepCount++;
      logLine(`  t=${t}s STEP track ${lastTrack} -> ${track} (half=${halfTrack}) c64PC=$${c64pc.toString(16)} drvPC=$${drvpc.toString(16)}`);
      lastTrack = track;
    }
    trackHistory.push({ t: Number(t), c64pc, drvpc, track, halfTrack });
    nextPollCyc += POLL_EVERY_CYC;
  }

  if (session.c64Cpu.cycles >= nextRenderCyc) {
    const sec = (session.c64Cpu.cycles / PAL_CYCLES_PER_SEC).toFixed(1);
    const idx = frameIdx.toString().padStart(3, "0");
    const path = join(OUT_DIR, `frame-${idx}-t${sec}s.png`);
    session.renderToPng(path);
    logLine(`  frame ${idx} t=${sec}s track=${session.headPosition.currentTrack} c64PC=$${session.c64Cpu.pc.toString(16)} drvPC=$${session.drive.cpu.pc.toString(16)}`);
    frameIdx++;
    nextRenderCyc += RENDER_EVERY_CYC;
  }
}

// dump gcr channel
const gcrEvents = session.traceRegistry.getRing("gcr");
const motorEdges = gcrEvents.filter((e) => e.data.kind === "motor");
const densityEdges = gcrEvents.filter((e) => e.data.kind === "density");
const stepEdges = gcrEvents.filter((e) => e.data.kind === "step");

logLine("");
logLine(`---- summary ----`);
logLine(`  c64 cycles run      : ${session.c64Cpu.cycles}`);
logLine(`  steps observed      : ${stepCount}`);
logLine(`  final track         : ${session.headPosition.currentTrack} (half=${session.headPosition.currentHalfTrack})`);
logLine(`  gcr events captured : ${gcrEvents.length} (ring cap 4096)`);
logLine(`    motor edges       : ${motorEdges.length}`);
logLine(`    density edges     : ${densityEdges.length}`);
logLine(`    step edges        : ${stepEdges.length}`);
logLine(`  final c64 PC        : $${session.c64Cpu.pc.toString(16)}`);
logLine(`  final drive PC      : $${session.drive.cpu.pc.toString(16)}`);

if (motorEdges.length > 0) {
  logLine(`  motor edge sample (first 8):`);
  for (const e of motorEdges.slice(0, 8)) {
    logLine(`    ts=${e.ts} on=${e.data.on}`);
  }
}
if (stepEdges.length > 0) {
  logLine(`  step edge sample (first 8):`);
  for (const e of stepEdges.slice(0, 8)) {
    logLine(`    ts=${e.ts} dir=${e.data.direction} half=${e.data.halfTrack}`);
  }
}

writeFileSync(LOG_PATH, log.join("\n") + "\n");
writeFileSync(join(OUT_DIR, "track-history.json"), JSON.stringify(trackHistory, null, 2));
writeFileSync(join(OUT_DIR, "gcr-events.json"), JSON.stringify(gcrEvents, null, 2));

const ms = Date.now() - t0;
console.log(`done in ${ms}ms (${(ms / 1000).toFixed(1)}s wall)`);
console.log(`log: ${LOG_PATH}`);
