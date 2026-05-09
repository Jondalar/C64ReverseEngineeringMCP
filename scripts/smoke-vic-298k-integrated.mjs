#!/usr/bin/env node
// Spec 298k smoke — integrated literal-port renderer via session opt-in.
//
// Uses IntegratedSession's useLiteralPortRenderer flag (= 298k integration).
// renderToPng({ renderer: "literal-port" }) reads the literalPortFb
// accumulator filled per cycle by 297a onCycle hook driving vicii_cycle().

import { resolve as resolvePath } from "node:path";
import { writeFileSync } from "node:fs";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession } = await import(`${REPO}/dist/runtime/headless/integrated-session-manager.js`);

const args = process.argv.slice(2);
const scenario = args[0] || "ready";
const diskArg = args[1];

const sessionOpts = {
  diskPath: diskArg ? resolvePath(diskArg) : `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
  useLiteralPortRenderer: true,  // ← Spec 298k opt-in
};

console.log(`smoke-vic-298k-integrated scenario=${scenario}`);

const t0 = Date.now();
const { session: s } = startIntegratedSession(sessionOpts);
s.resetCold("pal-default");

// KERNAL boot
console.log("KERNAL boot (5M cycles)...");
s.runFor(5_000_000, { cycleBudget: 5_000_000 });
const kernalMs = Date.now() - t0;
console.log(`  done in ${kernalMs}ms (${(5_000_000 / kernalMs * 1000 / 1e6).toFixed(2)}M cycles/sec)`);

if (scenario === "motm" || scenario === "mm") {
  console.log("Loading game...");
  s.typeText('LOAD"*",8,1\r', 80_000, 80_000);
  let total = 0;
  const targetCycles = 200_000_000; // ~200s simulated
  while (total < targetCycles) {
    s.runFor(3_000_000, { cycleBudget: 5_000_000 });
    total += 5_000_000;
  }
  const totalMs = Date.now() - t0;
  console.log(`  game boot ran ${total} cycles in ${totalMs}ms`);
}

// Save PNG via literal-port renderer
const pngPath = `${REPO}/samples/screenshots/literal-port/${scenario}-integrated.png`;
const r = s.renderToPng(pngPath, { renderer: "literal-port", frameAligned: false });
console.log(`Wrote ${pngPath} (${r.bytes} bytes, ${r.width}×${r.height})`);

// Sanity: count non-zero
const fb = s.literalPortFb;
let lit = 0;
for (let i = 0; i < fb.length; i++) if (fb[i] !== 0) lit++;
console.log(`Non-zero pixels: ${lit}/${fb.length}`);

// Screen RAM peek
console.log(`Screen RAM row 1 (banner): ${[...s.c64Bus.ram.slice(0x0428, 0x0450)].map(b => b.toString(16).padStart(2,"0")).join(" ")}`);
console.log(`Screen RAM row 5 (READY): ${[...s.c64Bus.ram.slice(0x04c8, 0x04f0)].map(b => b.toString(16).padStart(2,"0")).join(" ")}`);

console.log(`Total time: ${Date.now() - t0}ms`);
process.exit(lit > 1000 ? 0 : 1);
