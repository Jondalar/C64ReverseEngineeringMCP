#!/usr/bin/env node
// Spec 110 (M3.2) — VIA1 IEC contract smoke.

import { runAllVia1IecTests } from "../dist/runtime/headless/drive/via1-iec-tests.js";

const result = runAllVia1IecTests();
console.log(`VIA1 IEC contract — ${result.total} checks across ${result.details.length} suites`);
for (const suite of result.details) {
  const subPass = suite.results.filter((r) => r.pass).length;
  const subFail = suite.results.length - subPass;
  console.log(`  [${subFail === 0 ? "PASS" : "FAIL"}] ${suite.suite} — ${subPass}/${suite.results.length}`);
  if (subFail > 0) {
    for (const r of suite.results.filter((x) => !x.pass)) {
      console.log(`     × ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
    }
  }
}
console.log(`---`);
console.log(`summary: ${result.passed}/${result.total} pass, ${result.failed} fail`);
process.exit(result.failed > 0 ? 1 : 0);
