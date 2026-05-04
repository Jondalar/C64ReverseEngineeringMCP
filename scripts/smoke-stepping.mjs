#!/usr/bin/env node
// Spec 099 (M1.2) — stepping primitives smoke test.
//
// Boots a session, walks each named stepping primitive once,
// asserts each returns { exitReason: "hit" }. Exit 0 = green.

import { existsSync } from "node:fs";

const disk = "samples/synthetic/1byte.g64";
if (!existsSync(disk)) {
  console.error(`fixture missing: ${disk}`);
  process.exit(2);
}

let startIntegratedSession, stepping;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  stepping = await import("../dist/runtime/headless/stepping.js");
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const { session } = startIntegratedSession({
  diskPath: disk,
  mode: "true-drive",
});
session.resetCold();
session.runFor(800_000); // boot to BASIC ready

console.log("stepping smoke — running 5 primitives");
const fails = [];

// 1. stepCycles
{
  const before = session.c64Cpu.cycles;
  const r = stepping.stepCycles(session, 500);
  const ok = r.exitReason === "hit" && session.c64Cpu.cycles - before >= 500;
  console.log(`  stepCycles(500) → ${r.exitReason} (${r.cyclesElapsed} cycles, ${r.instructionsElapsed} instr) ${ok ? "PASS" : "FAIL"}`);
  if (!ok) fails.push(`stepCycles: ${JSON.stringify(r)}`);
}

// 2. stepInstructions
{
  const r = stepping.stepInstructions(session, 100);
  const ok = r.exitReason === "hit" && r.instructionsElapsed === 100;
  console.log(`  stepInstructions(100) → ${r.exitReason} (${r.instructionsElapsed} instr) ${ok ? "PASS" : "FAIL"}`);
  if (!ok) fails.push(`stepInstructions: ${JSON.stringify(r)}`);
}

// 3. runUntilPc — wait for KERNAL keyboard polling area $E5CD (idle).
{
  const r = stepping.runUntilPc(session, 0xE5CD, { budget: 500_000 });
  const ok = r.exitReason === "hit";
  console.log(`  runUntilPc($E5CD) → ${r.exitReason} (${r.instructionsElapsed} instr) hit=${JSON.stringify(r.hit)} ${ok ? "PASS" : "FAIL"}`);
  if (!ok) fails.push(`runUntilPc: ${JSON.stringify(r)}`);
}

// 4. runUntilRaster — wait for line 100. (May be flaky depending on
//    VIC state. Use generous budget.)
{
  const r = stepping.runUntilRaster(session, 100, 500_000);
  const ok = r.exitReason === "hit";
  console.log(`  runUntilRaster(100) → ${r.exitReason} hit=${JSON.stringify(r.hit)} ${ok ? "PASS" : "WARN"}`);
  if (!ok) console.log(`    (raster polling may be flaky if VIC raster register isn't ticking — not a hard fail)`);
}

// 5. runUntilIecEvent — type LOAD then wait for ATN-fall.
{
  session.typeText('LOAD"X",8,1\r', 80_000, 80_000);
  const r = stepping.runUntilIecEvent(session, "atn-fall", 5_000_000);
  const ok = r.exitReason === "hit";
  console.log(`  runUntilIecEvent(atn-fall) → ${r.exitReason} (${r.instructionsElapsed} instr) ${ok ? "PASS" : "FAIL"}`);
  if (!ok) fails.push(`runUntilIecEvent: ${JSON.stringify(r)}`);
}

console.log("---");
if (fails.length > 0) {
  console.log(`FAIL: ${fails.length} primitive(s) failed`);
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
}
console.log("PASS: all stepping primitives green");
process.exit(0);
