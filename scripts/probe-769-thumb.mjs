#!/usr/bin/env node
// Spec 769.5a — checkpoint thumbnails (scrub filmstrip data).
//   A) capturing a checkpoint stores a small thumbnail; filmstrip() lists it.
//   B) the thumbnail is a valid downscaled indexed frame (96x68, 48B palette,
//      w*h indices), non-trivial (not all one colour), and rendering it works.
//   C) capturing the thumbnail does NOT advance the machine (read-only).

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

console.log("Spec 769.5a — checkpoint thumbnails");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = new RuntimeController(sessionId, session, () => {});
try {
  session.resetCold("pal-default");
  session.runFor(2_500_000, { cycleBudget: 2_500_000 }); // render frames (literalPortFbStable populated)

  const cyBefore = session.c64Cpu.cycles;
  await ctrl.captureCheckpoint();
  const cyAfter = session.c64Cpu.cycles;
  gate("C capture is read-only (machine did not advance)", cyAfter === cyBefore, `${cyBefore} → ${cyAfter}`);

  const strip = ctrl.filmstrip();
  gate("A filmstrip lists the captured checkpoint + thumbnail", strip.length === 1, `entries=${strip.length}`);

  const t = strip[0];
  gate("B thumbnail is a downscaled indexed frame (96x68, 48B palette)",
    t && t.width === 96 && t.height === 68 && t.palette.length === 48 && t.indices.length === 96 * 68,
    t ? `${t.width}x${t.height} pal=${t.palette.length} idx=${t.indices.length}` : "none");

  // non-trivial: more than one distinct palette index used (a real screen, not a flat fill)
  const distinct = new Set(t ? t.indices : []);
  gate("B thumbnail is non-trivial (>1 colour)", distinct.size > 1, `distinct indices=${distinct.size}`);

  // render check: every index maps into the 16-colour palette
  let inRange = true;
  if (t) for (const idx of t.indices) if (idx > 15) { inRange = false; break; }
  gate("B indices are all valid palette entries (0..15)", inRange);

  // a second capture grows the strip
  session.runFor(500_000, { cycleBudget: 500_000 });
  await ctrl.captureCheckpoint();
  gate("A second capture adds a second thumbnail", ctrl.filmstrip().length === 2, `entries=${ctrl.filmstrip().length}`);
} finally {
  ctrl.dispose();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 769.5a thumb: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 769.5a thumb: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
