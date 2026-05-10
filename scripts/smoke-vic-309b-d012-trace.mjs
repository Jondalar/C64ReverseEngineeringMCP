#!/usr/bin/env node
// Spec 309b — trace LDA $D012 reads + returned values during motm
// title menu IRQ handler busy-wait. Confirms whether literal port's
// D012 read returns expected mid-frame raster value.
//
// Goal: catch busy-wait pattern (LDA $D012 / CMP / BCC) in motm IRQ
// handler. Log every $D012 read (= bus.read(0xD012) call) with PC,
// returned value, literal raster_line, c64 cycle.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const OUT_DIR = `${REPO}/samples/screenshots/motm-spec-309`;
mkdirSync(OUT_DIR, { recursive: true });

const { sessionId, session: s } = startIntegratedSession({
  diskPath: resolve(`${REPO}/samples/motm.g64`),
  mode: "true-drive",
  useMicrocodedCpu: true,
});
s.resetCold("pal-default");
s.runFor(5_000_000, { cycleBudget: 5_000_000 });
s.typeText('LOAD"*",8,1\r');
s.runFor(60_000_000, { cycleBudget: 60_000_000 });
s.typeText("RUN\r");

console.log("Booting motm + waiting for menu state (D01A=$01 + D012=$08)...");
const r = s.vic.regs;
let totalC = 0;
const maxC = 400_000_000;
while (totalC < maxC) {
  s.runFor(500_000, { cycleBudget: 5_000_000 });
  totalC += 5_000_000;
  if (r[0x1a] === 0x01 && r[0x12] === 0x08) {
    console.log(`menu reached at ${(totalC/1e6).toFixed(0)}M cyc.`);
    break;
  }
}
if (r[0x1a] !== 0x01) { console.log("FAIL: menu not reached"); stopIntegratedSession(sessionId); process.exit(1); }

// Hijack literal vicii_read for $D012 specifically. Wrap LIT_MEM via
// patching the bus IO handler? Easier: patch LIT_TYPES.vicii directly?
// Actually simplest: install a bus IO read interceptor for $D012.
const bus = s.c64Bus;
const reads = [];
const MAX_READS = 5000;

// Re-register $D012 with interceptor wrapping current handler.
const orig = bus.handlers ? bus.handlers.get(0xd012) : null;
console.log(`bus.handlers exists: ${!!bus.handlers}, orig handler @ $D012:`, !!orig);

// Wrap bus IO handler at $D012 with logging interceptor.
const LIT_MEM = await import(`${REPO}/dist/runtime/headless/vic/literal/vicii-mem.js`);
let intercepting = false;
const wrapHandler = (origRead, origWrite) => ({
  read: () => {
    const v = origRead();
    if (intercepting && reads.length < MAX_READS) {
      reads.push({
        cyc: s.c64Cpu.cycles,
        raster_lit: LIT_TYPES.vicii.raster_line,
        raster_cyc_lit: LIT_TYPES.vicii.raster_cycle,
        raster_vice: s.vic.raster_y,
        pc: s.c64Cpu.pc,
        val: v,
      });
    }
    return v;
  },
  write: (addr, val) => origWrite ? origWrite(addr, val) : undefined,
});
// Capture current $D012 handler via reading it via bus (gives literal val) + write goes to LIT_MEM.vicii_store + s.vic.write.
// Build our own based on knowledge of integrated-session install pattern.
const origRead = () => LIT_MEM.vicii_read(0x12);
const origWrite = (_addr, value) => {
  LIT_MEM.vicii_store(0x12, value);
  s.vic.write(0x12, value);
};
bus.registerIoHandler(0xd012, wrapHandler(origRead, origWrite));

intercepting = true;
console.log("\nIntercepting $D012 reads for ~50K cycles...");
const startCyc = s.c64Cpu.cycles;
s.runFor(20_000, { cycleBudget: 50_000 });
const elapsed = s.c64Cpu.cycles - startCyc;
intercepting = false;

console.log(`elapsed=${elapsed} cyc  reads captured=${reads.length}`);
if (reads.length === 0) {
  console.log("WARN: zero $D012 reads — handler not running?");
} else {
  // Group consecutive reads at same PC = busy-wait detection
  let runStart = 0;
  let runs = [];
  for (let i = 1; i <= reads.length; i++) {
    if (i === reads.length || reads[i].pc !== reads[runStart].pc) {
      const len = i - runStart;
      if (len >= 5) runs.push({ pc: reads[runStart].pc, len, firstVal: reads[runStart].val, lastVal: reads[i-1].val, firstCyc: reads[runStart].cyc, lastCyc: reads[i-1].cyc, firstRaster: reads[runStart].raster_lit, lastRaster: reads[i-1].raster_lit });
      runStart = i;
    }
  }
  console.log(`busy-wait runs (≥5 reads at same PC): ${runs.length}`);
  for (const w of runs.slice(0, 20)) {
    const dCyc = w.lastCyc - w.firstCyc;
    const dRaster = w.lastRaster - w.firstRaster;
    console.log(`  pc=$${w.pc.toString(16)} reads=${w.len} cyc=${w.firstCyc}..${w.lastCyc} (Δ=${dCyc}) raster=${w.firstRaster}->${w.lastRaster} (Δ=${dRaster}) val=${w.firstVal.toString(16)}..${w.lastVal.toString(16)}`);
  }
  // Show first 10 reads for context
  console.log("\nFirst 10 reads:");
  for (const r of reads.slice(0, 10)) {
    console.log(`  cyc=${r.cyc} pc=$${r.pc.toString(16)} val=$${r.val.toString(16)} raster_lit=${r.raster_lit} raster_vice=${r.raster_vice}`);
  }
}

writeFileSync(`${OUT_DIR}/spec-309b-d012-reads.json`, JSON.stringify({ totalReads: reads.length, reads: reads.slice(0, 100) }, null, 2));
stopIntegratedSession(sessionId);
