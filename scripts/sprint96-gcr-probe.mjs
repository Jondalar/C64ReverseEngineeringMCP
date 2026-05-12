#!/usr/bin/env node
// Sprint 96 part 7 — verify GCR shifter feeds drive correct bytes.
// Reads track 18 from G64 directly; observes what drive sees on $1C01.

import { existsSync } from "node:fs";
const disk = "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64";
if (!existsSync(disk)) process.exit(2);

const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { session } = startIntegratedSession({
  diskPath: disk, useCycleLockstep: true, useMicrocodedCpu: true,
});
session.resetCold();

// Sanity 1: does G64 have track 18 data?
const tb = session.trackBuffer;
const raw = tb.source.getRawTrackBytes(18);
console.log(`Track 18 raw GCR bytes: ${raw ? raw.length : "null"}`);
if (raw) {
  console.log(`  first 64: ${[...raw.slice(0, 64)].map(b => b.toString(16).padStart(2,"0")).join(" ")}`);
  let ffRuns = 0, longestFf = 0, currentRun = 0;
  for (const b of raw) {
    if (b === 0xff) { currentRun++; longestFf = Math.max(longestFf, currentRun); if (currentRun === 1) ffRuns++; }
    else currentRun = 0;
  }
  console.log(`  $FF runs: count=${ffRuns} longest=${longestFf}`);
}

session.runFor(800_000);
session.typeText("LOAD\"*\",8,1\r", 80_000, 80_000);

// Sanity 2: what does drive observe via $1C01 reads (latched byte)?
const observed = [];
const origRead = session.drive.bus.read.bind(session.drive.bus);
session.drive.bus.read = (a) => {
  const v = origRead(a);
  if ((a & 0xfff0) === 0x1c00 && ((a & 0xf) === 0x01 || (a & 0xf) === 0x00)) {
    if (observed.length < 4000) {
      observed.push({
        c64Cyc: session.c64Cpu.cycles,
        drvPc: session.drive.cpu.pc,
        track: session.headPosition.currentTrack,
        port: (a & 0xf) === 0x01 ? "PA" : "PB",
        v,
      });
    }
  }
  return v;
};
// Also probe how often syncDetected() returns true.
let syncTrueCount = 0, syncFalseCount = 0;
const tbAny = session.trackBuffer;
const origSyncDetected = tbAny.syncDetected.bind(tbAny);
tbAny.syncDetected = () => { const r = origSyncDetected(); r ? syncTrueCount++ : syncFalseCount++; return r; };

session.runFor(15_000_000);

const paReads = observed.filter(o => o.port === "PA");
const pbReads = observed.filter(o => o.port === "PB");
console.log(`\n$1C00 PB reads: ${pbReads.length}, $1C01 PA reads: ${paReads.length}`);
console.log(`syncDetected() calls: true=${syncTrueCount} false=${syncFalseCount}`);
console.log(`\nLast 20 PB reads (PB7=0 means SYNC asserted):`);
for (const o of pbReads.slice(-20)) {
  console.log(`  drvPc=$${o.drvPc.toString(16)} byte=$${o.v.toString(16).padStart(2,"0")} (PB7=${(o.v >> 7) & 1}) c64Cyc=${o.c64Cyc}`);
}
console.log(`\nFirst 20 PA reads:`);
for (const o of paReads.slice(0, 20)) {
  console.log(`  drvPc=$${o.drvPc.toString(16)} byte=$${o.v.toString(16).padStart(2,"0")} c64Cyc=${o.c64Cyc}`);
}
const headTrack = observed.length > 0 ? observed[observed.length - 1].track : -1;
console.log(`final head track: ${headTrack}`);
