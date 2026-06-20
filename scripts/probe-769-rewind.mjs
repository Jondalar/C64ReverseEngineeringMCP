#!/usr/bin/env node
// Spec 769.1 — runtime_rewind core: seek a past checkpoint by cycle + restore.
// Exercises the tool's in-proc path (checkpointRing.list → nearest-at/before →
// restoreCheckpoint then=pause|run). Capture A, run forward, capture B; rewind to
// A's cycle → machine is back at A (CPU/RAM); rewind to most-recent → B.

import { startIntegratedSession, stopIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";
import { RuntimeController } from "../dist/runtime/headless/debug/runtime-controller.js";

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push({ name, detail }); console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`); }
}
function fnv1a(b) { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
function sig(s) { const c = s.c64Cpu; return { pc: c.pc & 0xffff, cyc: c.cycles >>> 0, ram: fnv1a(s.c64Bus.ram) }; }
// the tool's pick(): nearest at/before `cycle`, else nearest overall; undefined cycle → most recent
function pick(cps, cycle) {
  if (!cps.length) return undefined;
  if (cycle === undefined) return cps[cps.length - 1].id;
  let atBefore, best = cps[0], bestD = Infinity;
  for (const c of cps) {
    if (c.cycles <= cycle && (!atBefore || c.cycles > atBefore.cycles)) atBefore = c;
    const d = Math.abs(c.cycles - cycle); if (d < bestD) { bestD = d; best = c; }
  }
  return (atBefore ?? best).id;
}

console.log("Spec 769.1 — runtime_rewind (seek + restore a past checkpoint)");

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});
const ctrl = new RuntimeController(sessionId, session, () => {});
try {
  session.resetCold("pal-default");
  session.runFor(2_000_000, { cycleBudget: 2_000_000 });

  const refA = await ctrl.captureCheckpoint();
  const sigA = sig(session);
  session.runFor(1_500_000, { cycleBudget: 1_500_000 });
  const refB = await ctrl.captureCheckpoint();
  const sigB = sig(session);
  session.runFor(1_000_000, { cycleBudget: 1_000_000 }); // move away from both
  gate("setup: A before B, machine moved past both", refA.cycles < refB.cycles && session.c64Cpu.cycles > sigB.cyc,
    `A=${refA.cycles} B=${refB.cycles} now=${session.c64Cpu.cycles}`);

  // rewind to ~A's cycle (then=pause) → back at A
  const idA = pick(ctrl.checkpointRing.list(), sigA.cyc);
  await ctrl.restoreCheckpoint(idA, { then: "pause" });
  const e1 = sig(session);
  gate("rewind-by-cycle to A lands at A (cyc + ram + pc)",
    e1.cyc === sigA.cyc && e1.ram === sigA.ram && e1.pc === sigA.pc,
    `got cyc=${e1.cyc} (want ${sigA.cyc}), ram ${e1.ram === sigA.ram ? "ok" : "DIFF"}`);

  // rewind to most recent (undefined cycle) → B
  const idLatest = pick(ctrl.checkpointRing.list(), undefined);
  await ctrl.restoreCheckpoint(idLatest, { then: "pause" });
  const e2 = sig(session);
  gate("rewind to most-recent lands at B", e2.cyc === sigB.cyc && e2.ram === sigB.ram, `cyc=${e2.cyc} want=${sigB.cyc}`);

  // then=run continues forward from A
  await ctrl.restoreCheckpoint(idA, { then: "run" });
  await new Promise((r) => setTimeout(r, 60)); // let the loop tick
  gate("rewind then=run continues forward from A", ctrl.runState === "running" && session.c64Cpu.cycles >= sigA.cyc,
    `runState=${ctrl.runState} cyc=${session.c64Cpu.cycles}`);
  ctrl.pause();
} finally {
  ctrl.dispose();
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 769.1 rewind: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 769.1 rewind: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
