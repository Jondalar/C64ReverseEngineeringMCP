#!/usr/bin/env node
// Spec 109 (M3.1) — drive CPU equivalence smoke.
//
// Walks 1541 ROM 50K instructions on legacy + microcoded, compares
// per-instruction state, also runs SO pin test, prints opcode coverage.

import {
  runDriveRomEquivWalk, runSoPinTest, summarizeOpcodeCoverage,
  runIndyCrossPageBusTrace, runPhaBusTrace, runJsrBusTrace, runRtsBusTrace,
} from "../dist/runtime/headless/drive/drive-cpu-equiv-tests.js";

let result;
try {
  result = runDriveRomEquivWalk({ maxInstructions: 50_000, maxDivergences: 8 });
} catch (e) {
  console.error("equiv walk threw:", e?.stack ?? e);
  process.exit(1);
}

console.log(`drive equiv walk: ${result.steps} instructions stepped`);
console.log(`  legacy total cycles : ${result.finalCyclesLegacy}`);
console.log(`  micro  total cycles : ${result.finalCyclesMicro}`);

if (result.cycleDeltaByOpcode.size > 0) {
  const top = [...result.cycleDeltaByOpcode.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`cycle-delta opcodes (instructions where legacy cycles != micro cycles):`);
  for (const [opcode, count] of top) {
    console.log(`  $${opcode.toString(16).padStart(2, "0")}: ${count} occurrences`);
  }
}

const cov = summarizeOpcodeCoverage(result.opcodesVisited);
console.log(`opcode coverage: ${cov.visited} unique (${cov.documented} doc + ${cov.undocumented} undoc)`);
if (cov.unimplementedVisited.length > 0) {
  console.log(`  UNIMPLEMENTED visited: ${cov.unimplementedVisited.map((n) => "$" + n.toString(16).padStart(2, "0")).join(", ")}`);
}

if (result.divergences.length > 0) {
  console.log(`\nDIVERGENCES (${result.divergences.length}):`);
  for (const d of result.divergences) {
    console.log(`  step=${d.step} pc=$${d.pc.toString(16)} opcode=$${d.opcode.toString(16).padStart(2, "0")}`);
    console.log(`    legacy: A=${d.legacy.a.toString(16)} X=${d.legacy.x.toString(16)} Y=${d.legacy.y.toString(16)} SP=${d.legacy.sp.toString(16)} F=${d.legacy.flags.toString(16)} cyc=${d.legacy.cycles}`);
    console.log(`    micro : A=${d.micro.a.toString(16)} X=${d.micro.x.toString(16)} Y=${d.micro.y.toString(16)} SP=${d.micro.sp.toString(16)} F=${d.micro.flags.toString(16)} cyc=${d.micro.cycles}`);
    console.log(`    diff  : ${d.diffs.join(" | ")}`);
  }
}

console.log("\nSO pin test:");
const so = runSoPinTest();
console.log(`  V before BVS    : ${so.vBefore}`);
console.log(`  V after BVS     : ${so.vAfter}`);
console.log(`  branch taken    : ${so.branchTaken}`);
const soOk = so.vBefore === true && so.branchTaken === true;
console.log(`  result          : ${soOk ? "PASS" : "FAIL"}`);

console.log("\nbus access traces:");
const traces = [runIndyCrossPageBusTrace(), runPhaBusTrace(), runJsrBusTrace(), runRtsBusTrace()];
let tracesOk = true;
for (const t of traces) {
  console.log(`  [${t.pass ? "PASS" : "FAIL"}] ${t.label}`);
  if (!t.pass) {
    tracesOk = false;
    console.log(`    expected: ${t.expected.join(" | ")}`);
    console.log(`    actual  : ${t.actual.join(" | ")}`);
  }
}

const equivOk = result.divergences.length === 0;
const covOk   = cov.unimplementedVisited.length === 0;
const ok = equivOk && covOk && soOk && tracesOk;
console.log(`\nsummary: equiv=${equivOk ? "PASS" : "FAIL"}  coverage=${covOk ? "PASS" : "FAIL"}  so=${soOk ? "PASS" : "FAIL"}  bus-traces=${tracesOk ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
