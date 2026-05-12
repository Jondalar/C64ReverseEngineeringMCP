// Step headless from $4000 onward. Capture first N PCs + regs.
// Print to stdout for diff against VICE cpuhistory.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { resolve } from "node:path";

const { session } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port",
  driveDispatchMode: "vice-whole-instruction",
});
session.resetCold("pal-default");
session.runFor(5_000_000);
await mountMedia(session, 8, resolve("samples/last_ninja_remix_s1[system3_1991].g64"));
session.typeText('LOAD"*",8,1\r');
session.runFor(60_000_000);
session.typeText("RUN\r");

// Reach $4000.
const BK4000 = new Set([0x4000]);
const BUDGET = 300_000_000;
const STEP = 1_000_000;
let total = 0;
let hit = false;
while (total < BUDGET) {
  const r = session.runFor(STEP, { breakpoints: BK4000 });
  total += r.instructionsExecuted;
  if (r.aborted === "breakpoint") { hit = true; break; }
}
if (!hit) { console.log("MISS \$4000"); process.exit(1); }

const cpu = session.c64Cpu;
const startCyc = cpu.cycles;
console.log(`*** \$4000 reached cyc=${startCyc} pc=$${cpu.pc.toString(16)}`);

// Now single-step N instructions. Each "instruction" = runFor(1).
const N = parseInt(process.env.LNR_N ?? "5000");
for (let i = 0; i < N; i++) {
  const pcBefore = cpu.pc;
  const aB = cpu.a, xB = cpu.x, yB = cpu.y, spB = cpu.sp;
  session.runFor(1);
  const dt = cpu.cycles - startCyc;
  console.log(`${dt} ${pcBefore} ${aB} ${xB} ${yB} ${spB}`);
  // Detect READY-loop (game gave up)
  if (pcBefore === 0xE5CF || pcBefore === 0xE5D4) {
    console.log(`\n*** READY reached at step ${i} dt=${dt}`);
    break;
  }
}
process.exit(0);
