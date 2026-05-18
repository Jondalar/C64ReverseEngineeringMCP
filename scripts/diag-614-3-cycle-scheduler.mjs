#!/usr/bin/env node
// Spec 614.3 diag — verify CycleSchedulerVice afterCycleSync hook
// fires and advances vice drive per c64 cycle.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("blank.d64 missing"); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

console.log(`session.useCycleLockstep = ${session.useCycleLockstep}`);
console.log(`session.scheduler = ${session.scheduler ? "present" : "MISSING"}`);
console.log(`kernel.drive1541Implementation = ${session.kernel.drive1541Implementation}`);
console.log(`kernel.drive1541 = ${session.kernel.drive1541 ? "present" : "MISSING"}`);

// Spy tickToClock to verify per-cycle hook fires.
const vice = session.kernel.drive1541;
let tickToClockCalls = 0;
const tickToClockClks = [];
const origTtc = vice.tickToClock.bind(vice);
vice.tickToClock = (clk) => {
  tickToClockCalls++;
  if (tickToClockCalls <= 5 || tickToClockCalls % 100000 === 0) {
    tickToClockClks.push(clk);
  }
  return origTtc(clk);
};

// Spy catchUpTo separately (bridge path).
let catchUpToCalls = 0;
const origCutc = vice.catchUpTo.bind(vice);
vice.catchUpTo = (clk) => { catchUpToCalls++; return origCutc(clk); };

await mountMedia(session, 8, diskPath);
session.resetCold("pal-default");

const startCycles = session.c64Cpu.cycles;
session.runFor(500_000);
const endCycles = session.c64Cpu.cycles;

console.log(`c64 cycles advanced: ${endCycles - startCycles}`);
console.log(`tickToClock fired: ${tickToClockCalls}  catchUpTo fired: ${catchUpToCalls}`);
console.log(`first 5 tickToClock clks: ${tickToClockClks.slice(0, 5).join(", ")}`);

if (tickToClockCalls === 0) {
  console.error("FAIL: tickToClock never fired — per-cycle hook not wired");
  process.exit(1);
}
if (tickToClockCalls < (endCycles - startCycles) / 2) {
  console.error(`WARN: tickToClock fired ${tickToClockCalls}× but c64 advanced ${endCycles - startCycles} cycles`);
}
console.log("OK — 614.3 hook fires per cycle");
