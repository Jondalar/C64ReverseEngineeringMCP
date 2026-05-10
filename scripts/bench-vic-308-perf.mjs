#!/usr/bin/env node
// Spec 308 perf bench — measure literal port cycles/sec emulating
// PAL C64 BASIC. Baseline = pre-strip; reruns after each strip
// for delta.
//
// Realtime PAL = 985,248 cycles/sec. Target = >= 1.0× (= realtime
// in Node M4). Anything ≥ 0.5× is acceptable for live UI use; below
// triggers more aggressive Phase 7 work or eventual Rust port.

import { performance } from "node:perf_hooks";

const REPO = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP";
const { startIntegratedSession, stopIntegratedSession } = await import(
  `${REPO}/dist/runtime/headless/integrated-session-manager.js`);

const FRAMES = parseInt(process.env.FRAMES ?? "60", 10);
const PAL_CYCLES_PER_FRAME = 19656;
const PAL_REALTIME_CYCLES_SEC = 985248;

console.log(`Spec 308 perf bench — ${FRAMES} PAL frames`);

const { sessionId, session: s } = startIntegratedSession({
  diskPath: `${REPO}/samples/synthetic/1block.g64`,
  mode: "true-drive",
  useMicrocodedCpu: true,
});

s.resetCold("pal-default");
// Warmup boot.
s.runFor(2_000_000, { cycleBudget: 3_000_000 });

const targetCycles = FRAMES * PAL_CYCLES_PER_FRAME;
const startCycles = s.c64Cpu.cycles;
const startWall = performance.now();
s.runFor(10_000_000, { cycleBudget: targetCycles });
const wallMs = performance.now() - startWall;
const cyclesRun = s.c64Cpu.cycles - startCycles;

stopIntegratedSession(sessionId);

const cyclesPerSec = (cyclesRun / wallMs) * 1000;
const realtimeMultiplier = cyclesPerSec / PAL_REALTIME_CYCLES_SEC;
const fps = realtimeMultiplier * 50; // PAL = 50 fps

console.log(`cycles run: ${cyclesRun.toLocaleString()}`);
console.log(`wall time:  ${wallMs.toFixed(1)} ms`);
console.log(`speed:      ${cyclesPerSec.toLocaleString(undefined, { maximumFractionDigits: 0 })} cyc/sec`);
console.log(`realtime:   ${realtimeMultiplier.toFixed(2)}× (${fps.toFixed(1)} fps PAL equivalent)`);

// Informational gate.
if (realtimeMultiplier >= 1.0) {
  console.log("PASS: realtime PAL achieved");
  process.exit(0);
} else if (realtimeMultiplier >= 0.5) {
  console.log("OK: above 0.5× realtime (UI-usable)");
  process.exit(0);
} else {
  console.log(`SUB-REALTIME: ${realtimeMultiplier.toFixed(2)}× — Phase 7 work needed`);
  process.exit(0); // informational, not gating
}
