#!/usr/bin/env node
// Spec 769.2 — code-overlay debug loop core (restore → patch → run → observe,
// repeatable). Replicates the runtime/overlay_run route via the controller:
// the KEY proof is that a restore rolls RAM back so the prior patch is undone —
// that's what makes iterating a fix from a fixed point work.

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}

console.log("Spec 769.2 — code-overlay debug loop");

const ADDR = 0xC000; // free RAM the KERNAL/BASIC idle loop doesn't touch
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = new RuntimeController(sessionId, session, () => {});
const ram = session.c64Bus.ram;
const overlay = async (anchorId, byte) => { // restore → patch → return readback
  await ctrl.restoreCheckpoint(anchorId, { then: "pause" });
  const orig = ram[ADDR];
  ram[ADDR] = byte;
  return { orig, after: ram[ADDR] };
};
try {
  session.resetCold("pal-default");
  session.runFor(2_000_000, { cycleBudget: 2_000_000 });
  ram[ADDR] = 0x00; // known baseline at the anchor
  const A = await ctrl.captureCheckpoint();

  // iteration 1: patch 0xAA from the anchor
  const r1 = await overlay(A.id, 0xAA);
  gate("iteration 1: patch applied", r1.orig === 0x00 && r1.after === 0xAA, `orig=${r1.orig} after=${r1.after}`);

  // iteration 2: restore the SAME anchor — the 0xAA must be GONE (RAM rolled back)
  const r2 = await overlay(A.id, 0xBB);
  gate("iteration 2: restore undoes the prior patch (RAM rolled back)", r2.orig === 0x00,
    `pre-patch read=${r2.orig} (want 0x00, NOT 0xaa)`);
  gate("iteration 2: re-patch a different value works", r2.after === 0xBB, `after=${r2.after}`);

  // patch survives a forward run (the routine doesn't clobber $C000)
  await ctrl.restoreCheckpoint(A.id, { then: "pause" });
  ram[ADDR] = 0x42;
  session.runFor(50_000, { cycleBudget: 50_000 });
  gate("patch persists across a forward run", ram[ADDR] === 0x42, `after run=${ram[ADDR]}`);

  // and a fresh restore wipes it again (loop closes)
  await ctrl.restoreCheckpoint(A.id, { then: "pause" });
  gate("fresh restore after run wipes the patch (loop repeatable)", ram[ADDR] === 0x00, `read=${ram[ADDR]}`);
} finally {
  ctrl.dispose();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 769.2 overlay: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 769.2 overlay: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
