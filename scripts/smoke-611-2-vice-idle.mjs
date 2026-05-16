// Spec 611 phase 611.2 smoke — assert VICE1541 idle construction.
//
// Replaces scripts/smoke-611-1-vice-throws.mjs (which asserted that
// the Vice1541 constructor throws — that behaviour was specific to
// phase 611.1 and is superseded once 611.2 lands an idle DiskUnitContext).
//
// Checks (all required):
//   (a) startIntegratedSession({ drive1541: "vice" }) does NOT throw.
//   (b) kernel.drive1541 is a Drive1541 instance.
//   (c) kernel.drive1541.iecLineSample() returns the idle-bus shape
//       (drv_data_pull / drv_clk_pull / drv_atna_pull all false).
//   (d) kernel.drive1541.catchUpTo(0) still throws with the
//       phase 611.3 marker.
//
// Exit 0 = PASS, 1 = FAIL.

import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

let session = null;
let ctorThrew = null;
try {
  ({ session } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  }));
} catch (e) {
  ctorThrew = e;
}
check(
  "(a) startIntegratedSession({drive1541:'vice'}) does not throw",
  ctorThrew === null,
  ctorThrew ? `threw: ${ctorThrew.message}` : null,
);

const drive1541 = session && session.kernel ? session.kernel.drive1541 : null;
check(
  "(b) kernel.drive1541 is bound",
  drive1541 !== null && drive1541 !== undefined,
);

let sample = null;
try {
  sample = drive1541 ? drive1541.iecLineSample() : null;
} catch (e) {
  // Capture but don't crash the smoke; treated as fail below.
  sample = { error: String(e) };
}
const idle =
  sample &&
  sample.drv_data_pull === false &&
  sample.drv_clk_pull === false &&
  sample.drv_atna_pull === false;
check(
  "(c) iecLineSample() returns idle bus (all false)",
  idle,
  sample ? JSON.stringify(sample) : "null",
);

let catchUpThrew = null;
try {
  drive1541 && drive1541.catchUpTo(0);
} catch (e) {
  catchUpThrew = e;
}
const cuMessage = catchUpThrew ? String(catchUpThrew.message) : "";
check(
  "(d) catchUpTo(0) throws with 611.3 marker",
  catchUpThrew !== null && /611\.3/.test(cuMessage),
  catchUpThrew ? `message: ${cuMessage}` : "no throw observed",
);

console.log("");
const failed = results.filter((r) => !r.ok).length;
if (failed > 0) {
  console.error(`FAIL: ${failed}/${results.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${results.length}/${results.length} checks passed.`);
process.exit(0);
