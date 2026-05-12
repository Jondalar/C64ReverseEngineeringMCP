#!/usr/bin/env node
// Spec 309 — load motm menu VSF (= VICE running state at title screen),
// render via literal port, dump PNG. Compare to expected screenshot
// (samples/screenshots/motm-vice-expected.png from user).
//
// Goal: prove the D016/D018 mid-frame split bug + capture diagnostic
// state (regs at multiple raster lines, IRQ handler PC, mid-frame
// reg writes observed).

import { mkdirSync, writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);
const { loadSessionVsf } = await import(
  `${REPO}/dist/runtime/headless/vsf/session-vsf.js`);
const LIT_TYPES = await import(
  `${REPO}/dist/runtime/headless/vic/literal/vicii-types.js`);

const VSF = `${REPO}/samples/motm_menu_vice.vsf`;
const OUT_DIR = `${REPO}/samples/screenshots/motm-spec-309`;
mkdirSync(OUT_DIR, { recursive: true });

console.log("Spec 309 — motm menu VSF load + render via literal port");

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/motm.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
});

s.resetCold("pal-default");

// Load VICE snapshot (= captured at title screen with split active)
let loadResult;
try {
  loadResult = loadSessionVsf(s, VSF);
  console.log(`VSF loaded: ${JSON.stringify(loadResult, null, 2)}`);
} catch (e) {
  console.log(`VSF load failed: ${e.message}`);
  stopIntegratedSession(sessionId);
  process.exit(1);
}

// Snapshot register state RIGHT after load
const dumpRegs = (label) => {
  const r = s.vic.regs;
  const lr = LIT_TYPES.vicii.regs;
  console.log(`[${label}]`);
  console.log(`  PC=$${s.c64Cpu.pc.toString(16)} cycles=${s.c64Cpu.cycles}`);
  console.log(`  D011=$${r[0x11].toString(16)} D012=$${r[0x12].toString(16)} D016=$${r[0x16].toString(16)} D018=$${r[0x18].toString(16)} D019=$${r[0x19].toString(16)} D01A=$${r[0x1a].toString(16)}`);
  console.log(`  D020=$${r[0x20].toString(16)} D021=$${r[0x21].toString(16)}`);
  console.log(`  CIA2 PA=$${(s.cia2.pra & s.cia2.ddra & 0xff).toString(16)} VIC bank=${(~(s.cia2.pra & s.cia2.ddra)) & 3}`);
  console.log(`  vic.raster_y=${s.vic.raster_y} lit.raster_line=${LIT_TYPES.vicii.raster_line}`);
  console.log(`  irq_status: vice=$${s.vic.irq_status.toString(16)} lit=$${LIT_TYPES.vicii.irq_status.toString(16)}`);
};

dumpRegs("post-VSF-load");

// Run a few frames so literal port catches up + IRQ handler runs.
console.log("\nRunning 3 frames...");
s.runFor(200_000, { cycleBudget: 200_000 });
dumpRegs("post-3-frames");

// Render
const path = `${OUT_DIR}/motm-menu-literal.png`;
const r = s.renderToPng(path);
console.log(`\nRendered: ${r.width}x${r.height} ${r.bytes} bytes -> ${path}`);

// Sample regs across raster lines to detect mid-frame writes.
// Run cycle-by-cycle for one frame, log every D016/D018 change.
console.log("\nTracking D016/D018 changes over 1 frame...");
const writes = [];
let lastD016 = s.vic.regs[0x16];
let lastD018 = s.vic.regs[0x18];
for (let i = 0; i < 19656; i += 100) {
  s.runFor(2, { cycleBudget: 100 });
  const d16 = s.vic.regs[0x16];
  const d18 = s.vic.regs[0x18];
  if (d16 !== lastD016 || d18 !== lastD018) {
    writes.push({
      cycle: s.c64Cpu.cycles,
      raster: LIT_TYPES.vicii.raster_line,
      d016_old: lastD016, d016_new: d16,
      d018_old: lastD018, d018_new: d18,
    });
    lastD016 = d16;
    lastD018 = d18;
  }
}
console.log(`D016/D018 writes during 1 frame: ${writes.length}`);
for (const w of writes.slice(0, 20)) {
  console.log(`  raster=${w.raster} D016 ${w.d016_old.toString(16)}->${w.d016_new.toString(16)} D018 ${w.d018_old.toString(16)}->${w.d018_new.toString(16)}`);
}

stopIntegratedSession(sessionId);

writeFileSync(`${OUT_DIR}/motm-309-state.json`, JSON.stringify({ writes }, null, 2));
console.log("\nDONE");
