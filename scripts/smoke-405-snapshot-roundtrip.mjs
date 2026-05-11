#!/usr/bin/env node
// Spec 405 — C64 Phase E (Sound + the rest) — VSF snapshot round-trip.
//
// Doctrine: 1:1 VICE x64sc port. Doc anchor:
//   docs/vice-c64-arch.md §10.1 (snapshot module write/read order),
//   docs/vice-c64-arch.md §10.2 (alarm rescheduling on restore),
//   docs/vice-c64-arch.md §12 Phase E step 24.
//
// VICE cite: src/c64/c64-snapshot.c:76-91 — `c64_snapshot_write`
//   issues modules in the exact order:
//     MAINCPU → C64 → CIA1 → CIA2 → SID → DRIVE → FSDRIVE → VICII →
//     C64GLUE → EVENT → MEMHACKS → TAPEPORT → KEYBOARD → JOYPORT_1 →
//     JOYPORT_2 → USERPORT.
//
// Acceptance per spec 405 acceptance bullet #3:
//   "New smoke `scripts/smoke-405-snapshot-roundtrip.mjs`: save VSF,
//    restore, advance same number of cycles, assert framebuffer
//    identical."
//
// Per spec 405 tier policy (PLAN.md row "Core / structural"):
//   smokes only + per-spec new smoke; NO MM/Scramble game test.
//
// Test pattern:
//   1. Boot synthetic session (1block.g64 fixture, no full ROMs needed).
//   2. Advance N1 cycles so all subsystems have non-zero state.
//   3. Save VSF (snapshot-A).
//   4. Advance N2 cycles → capture framebuffer-A (= reference).
//   5. Re-load snapshot-A → advance N2 cycles again.
//   6. Capture framebuffer-B.
//   7. Assert framebuffer-A == framebuffer-B byte-for-byte.
//   8. Assert VSF wire-order matches §10.1 (= module sequence on save
//      must start MAINCPU, C64MEM, CIA1, CIA2, SID, DRIVE..., VICII,
//      ... KEYBOARD, per c64-snapshot.c:76-91).

import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let startIntegratedSession;
let saveSessionVsf;
let loadSessionVsf;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  ({ saveSessionVsf, loadSessionVsf } = await import(
    "../dist/runtime/headless/vsf/session-vsf.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// ---------- Boot synthetic session ----------
const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});

// Advance until subsystem state is non-trivial.
const N1 = 5000;
session.runFor(N1);

// ---------- Save VSF + capture VICE-order audit ----------
const tmpDir = mkdtempSync(join(tmpdir(), "smoke-405-vsf-"));
const vsfPath = join(tmpDir, "snapshot-a.vsf");
const preSnapshotClk = session.kernel.c64Clock();
const saveResult = saveSessionVsf(session, vsfPath);

// VICE c64-snapshot.c:76-91 canonical order. Our save emits this exact
// prefix (FSDRIVE, C64GLUE, EVENT, MEMHACKS, TAPEPORT, JOYPORT_*, USERPORT
// are not modeled and skipped — = strict subset of VICE).
const EXPECTED_PREFIX = [
  "MAINCPU",  // c64-snapshot.c:76
  "C64MEM",   // c64-snapshot.c:77  (named "C64" in VICE)
  "CIA1",     // c64-snapshot.c:78
  "CIA2",     // c64-snapshot.c:79
  "SID",      // c64-snapshot.c:80  (BEFORE VICII per §10.1)
  // DRIVE (c64-snapshot.c:81) — broken out into sub-chunks here.
  "DRIVECPU",
  "DRIVERAM",
  "VIA1d1541",
  "VIA2d1541",
  "GCRHEAD",
  "IECBUS",   // OQ-405-3: IEC embedded in DRIVE chunk in VICE.
  // FSDRIVE skipped (c64-snapshot.c:82).
  "VIC-II",   // c64-snapshot.c:83
  // C64GLUE, EVENT, MEMHACKS, TAPEPORT skipped (84..87).
  "KEYBOARD", // c64-snapshot.c:88
];

check(
  "VSF save returned module list with VICE §10.1 order",
  saveResult.modules.length === EXPECTED_PREFIX.length &&
    EXPECTED_PREFIX.every((m, i) => saveResult.modules[i] === m),
  `got=[${saveResult.modules.join(",")}] expected=[${EXPECTED_PREFIX.join(",")}]`,
);

check(
  "SID written BEFORE VIC-II per c64-snapshot.c:80,83",
  saveResult.modules.indexOf("SID") < saveResult.modules.indexOf("VIC-II"),
  `sid_idx=${saveResult.modules.indexOf("SID")} vic_idx=${saveResult.modules.indexOf("VIC-II")}`,
);

check(
  "DRIVE group (DRIVECPU...IECBUS) sits between SID and VIC-II",
  (() => {
    const sidIdx = saveResult.modules.indexOf("SID");
    const vicIdx = saveResult.modules.indexOf("VIC-II");
    const driveIdx = saveResult.modules.indexOf("DRIVECPU");
    return sidIdx >= 0 && vicIdx >= 0 && driveIdx > sidIdx && driveIdx < vicIdx;
  })(),
  `modules=[${saveResult.modules.join(",")}]`,
);

check(
  "KEYBOARD written AFTER VIC-II (= post-drive group per c64-snapshot.c:88)",
  saveResult.modules.indexOf("KEYBOARD") > saveResult.modules.indexOf("VIC-II"),
);

// ---------- Reference run: advance N2 cycles, capture framebuffer ----------
const N2 = 5000;
session.runFor(N2);
const referenceFb = capturePixels(session);
const referenceClk = session.kernel.c64Clock();

check(
  "reference framebuffer is non-empty",
  referenceFb.length > 0,
  `len=${referenceFb.length}`,
);

// ---------- Restore + advance same N2 cycles ----------
const loadResult = loadSessionVsf(session, vsfPath);

check(
  "VSF load reported zero errors",
  loadResult.errors.length === 0,
  `errors=${JSON.stringify(loadResult.errors)}`,
);

check(
  "VSF load picked up MAINCPU + C64MEM + CIA1 + CIA2 + SID + VIC-II + KEYBOARD",
  ["MAINCPU", "C64MEM", "CIA1", "CIA2", "SID", "VIC-II", "KEYBOARD"]
    .every((m) => loadResult.loadedModules.includes(m)),
  `loaded=[${loadResult.loadedModules.join(",")}]`,
);

// Post-load clock must equal the clock captured at save time (= the CPU
// "cycles" field is part of MAINCPU module, c64-snapshot.c:76;
// alarm rescheduling per §10.2 is relative to this value).
const postLoadClk = session.kernel.c64Clock();
check(
  "post-load c64Clock == pre-snapshot c64Clock (= alarm rescheduling per §10.2)",
  postLoadClk === preSnapshotClk,
  `postLoadClk=${postLoadClk} preSnapshotClk=${preSnapshotClk}`,
);

session.runFor(N2);
const replayFb = capturePixels(session);
const replayClk = session.kernel.c64Clock();

check(
  "post-replay c64Clock matches reference c64Clock",
  replayClk === referenceClk,
  `replayClk=${replayClk} referenceClk=${referenceClk}`,
);

// ---------- Compare framebuffers ----------
check(
  "framebuffer length identical after replay",
  replayFb.length === referenceFb.length,
  `referenceLen=${referenceFb.length} replayLen=${replayFb.length}`,
);

let diffCount = 0;
let firstDiffIdx = -1;
const len = Math.min(referenceFb.length, replayFb.length);
for (let i = 0; i < len; i++) {
  if (referenceFb[i] !== replayFb[i]) {
    if (firstDiffIdx < 0) firstDiffIdx = i;
    diffCount++;
  }
}

check(
  "framebuffer byte-identical after VSF save → restore → advance same N2 cycles",
  diffCount === 0,
  `diffCount=${diffCount}/${len}, firstDiffIdx=${firstDiffIdx}`,
);

// ---------- Cleanup ----------
try { unlinkSync(vsfPath); } catch { /* ignore */ }

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 405 snapshot-roundtrip smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);

// ---------- Helpers ----------
function capturePixels(session) {
  // Prefer the literal-port accumulator (= what renderToPng writes); fall
  // back to the VicFramebuffer pixels (= legacy snapshot renderer).
  if (session.literalPortFb && session.literalPortFb.length > 0) {
    return new Uint8Array(session.literalPortFb);
  }
  return new Uint8Array(session.framebuffer.pixels);
}
