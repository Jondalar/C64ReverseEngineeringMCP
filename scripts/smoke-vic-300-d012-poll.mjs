#!/usr/bin/env node
// Spec 300 acceptance: $D012 raster reads (product literal path).
//
// Spec 723.5c: literal-port per-cycle VIC is the unconditional product path,
// so $D012 reads are served by the literal vicii_read. This smoke samples
// $D012 + $D011 directly through the bus (= same IO read routing a PRG's
// `lda $d012` hits) between short run slices, and verifies the reconstructed
// raster line sweeps the full PAL frame with small per-sample motion.
//
// (Previously this drove a poll PRG; that approach was fragile — an IRQ /
// budget edge could run the PC off into KERNAL. Direct bus sampling tests the
// same read source deterministically.)

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

console.log("Spec 300 D012 raster reads (product literal path)");

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
});
s.resetCold("pal-default");
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

// Sample $D012 (low 8 bits of raster) + $D011 bit 7 (raster bit 8) through
// the bus, advancing a small, line-sized number of cycles between samples.
const SAMPLES = 400;
const SLICE_CYCLES = 30; // < one PAL line (63 cyc) → at most ~1 line motion
const d012 = [];
const d011 = [];
for (let i = 0; i < SAMPLES; i++) {
  d012.push(s.c64Bus.read(0xd012) & 0xff);
  d011.push(s.c64Bus.read(0xd011) & 0xff);
  s.runFor(50, { cycleBudget: SLICE_CYCLES });
}
stopIntegratedSession(sessionId);

// Reconstruct full raster line: high bit from D011 bit 7.
const rasterLines = d012.map((lo, i) => ((d011[i] & 0x80) << 1) | lo);

const diffs = [];
for (let i = 1; i < rasterLines.length; i++) {
  let d = rasterLines[i] - rasterLines[i - 1];
  if (d < 0) d += 312; // wrap
  diffs.push(d);
}
const maxDiff = Math.max(...diffs);
const minRaster = Math.min(...rasterLines);
const maxRaster = Math.max(...rasterLines);
const uniqueLines = new Set(rasterLines).size;

mkdirSync(`${REPO}/samples/screenshots/literal-port`, { recursive: true });
writeFileSync(
  `${REPO}/samples/screenshots/literal-port/spec-300-d012-poll.json`,
  JSON.stringify({ samples: SAMPLES, minRaster, maxRaster, uniqueLines, maxDiff,
    first10: rasterLines.slice(0, 10), last10: rasterLines.slice(-10) }, null, 2),
);

console.log(`samples=${SAMPLES} range=${minRaster}..${maxRaster} unique=${uniqueLines} maxDiff=${maxDiff}`);
console.log(`first10=[${rasterLines.slice(0, 10).join(",")}]`);

// Acceptance (product literal reads):
// - non-degenerate raster sweep (range > 100 lines across the frame)
// - reads see real motion (>= 60 distinct lines)
// - no frozen reads / huge jumps (max line-to-line step small relative to
//   slice size; allow a couple lines for slice boundary crossing)
const checks = [
  { name: "raster range > 100", ok: (maxRaster - minRaster) > 100 },
  { name: "unique lines >= 60", ok: uniqueLines >= 60 },
  { name: "max line-to-line step <= 3", ok: maxDiff <= 3 },
];
let ok = true;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}: ${c.name}`);
  if (!c.ok) ok = false;
}
process.exit(ok ? 0 : 1);
