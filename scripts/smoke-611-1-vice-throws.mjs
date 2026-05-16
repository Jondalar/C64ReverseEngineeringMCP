// Spec 611 phase 611.1 smoke — assert that drive1541: "vice" selects
// VICE1541 and throws with the Spec-611.1 stub message.
//
// Phase 611.1 gate (§5 + §6): default legacy path stays 5/7 GREEN
// (full runtime:proof), AND --drive1541=vice explicitly throws on
// instantiation. This script covers the second assertion.
//
// Exit 0 = PASS. Exit 1 = FAIL.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

let threw = false;
let error = null;

try {
  startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });
} catch (e) {
  threw = true;
  error = e;
}

if (!threw) {
  console.error("FAIL: expected throw from drive1541=\"vice\" instantiation; none observed.");
  process.exit(1);
}

const msg = String(error && error.message ? error.message : error);

const checks = [
  { label: "mentions VICE1541",     ok: /VICE1541/.test(msg) },
  { label: "says not implemented",  ok: /not implemented/i.test(msg) },
  { label: "cites Spec 611.1",      ok: /611\.1|611 phase 611\.1/.test(msg) },
];

let failed = 0;
for (const c of checks) {
  console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}`);
  if (!c.ok) failed++;
}

console.log("");
if (failed > 0) {
  console.error(`FAIL: ${failed}/${checks.length} message-content checks failed.`);
  console.error(`Observed message: ${msg}`);
  process.exit(1);
}

console.log(`PASS: drive1541="vice" throws with Spec-611.1 stub error.`);
console.log(`Message: ${msg}`);
process.exit(0);
