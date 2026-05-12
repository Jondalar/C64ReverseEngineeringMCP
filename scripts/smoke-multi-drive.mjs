#!/usr/bin/env node
// Spec 115 (M3.7) v1 — multi-drive shape smoke.

import { runAllMultiDriveTests } from "../dist/runtime/headless/drive/multi-drive-tests.js";

const r = runAllMultiDriveTests();
console.log(`Multi-drive shape v1 — ${r.total} checks across ${r.details.length} suites`);
for (const s of r.details) {
  const subPass = s.results.filter((x) => x.pass).length;
  const subFail = s.results.length - subPass;
  console.log(`  [${subFail === 0 ? "PASS" : "FAIL"}] ${s.suite} — ${subPass}/${s.results.length}`);
  if (subFail > 0) {
    for (const x of s.results.filter((y) => !y.pass)) {
      console.log(`     × ${x.label}${x.detail ? ` (${x.detail})` : ""}`);
    }
  }
}
console.log(`---`);
console.log(`summary: ${r.passed}/${r.total} pass, ${r.failed} fail`);
process.exit(r.failed > 0 ? 1 : 0);
