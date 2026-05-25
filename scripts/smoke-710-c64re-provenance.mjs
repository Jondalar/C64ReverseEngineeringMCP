#!/usr/bin/env node
// scripts/smoke-710-c64re-provenance.mjs
//
// Spec 710.4/710.5 — durable VIC provenance across .c64re dump/undump.
//
// A checkpoint with a PROVABLE per-line $D018 difference (raster split) must
// keep its same-frame raster/FLI provenance after a `.c64re` dump, a destroyed
// session, and an undump into a fresh session — so inspect resolves the SAME
// per-line char/screen bases as before the dump (durable evidence for 710/711/712).
//
// The split provenance is seeded through the REAL restore mechanism
// (session.restoreVicProvenance — the same path kernel.restore uses), then
// captured into the checkpoint payload; capture-from-render is covered by
// smoke-710-provenance.mjs gate B.
//
// Exit 0 = PASS, 1 = FAIL.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

let startIntegratedSession, stopIntegratedSession, ensureRuntimeController,
    dumpRuntimeSnapshot, undumpRuntimeSnapshot, resolveNodeAt;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js"));
  ({ dumpRuntimeSnapshot, undumpRuntimeSnapshot } = await import("../dist/runtime/headless/kernel/snapshot-persistence.js"));
  ({ resolveNodeAt } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let passes = 0;
const failures = [];
const gate = (name, ok, detail) => {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); }
  else { failures.push(name); console.log(`  FAIL  ${name}${detail ? ` (${detail})` : ""}`); }
};
const charAddr = (node) => node.refs.find((r) => r.kind === "charset")?.addr;
// charset addr = charBase + screenCode*8 → recover the per-line char BASE.
const charBase = (node) => charAddr(node) - (node.value ?? 0) * 8;

// Raster split: line 60 → $D018=$14 (char $1000), line 140 → $D018=$1c (char $3000).
// Display y = raster line - 51 (FIRST_DISPLAY_RASTER): line60→y9, line140→y89.
const SPLIT = { lines: [
  { line: 60, d011: 0, d016: 0, d018: 0x14, bank: 0 },
  { line: 140, d011: 0, d016: 0, d018: 0x1c, bank: 0 },
] };

console.log("Spec 710 — .c64re durable provenance roundtrip");
const dumpPath = join(tmpdir(), `710-prov-${process.pid}-${Date.now()}.c64re`);
let topBefore, botBefore, cpAProv;

// ---- session 1: seed split, capture, dump ----
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  try {
    session.resetCold("pal-default");
    session.runFor(3_000_000, { cycleBudget: 3_000_000 });
    // Seed the frozen split provenance via the real restore path (no live render
    // overwrite, since capture is disabled by default).
    session.restoreVicProvenance(SPLIT);

    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    const refA = await ctrl.captureCheckpoint();
    const cpA = ctrl.checkpointRing.restoreSnapshot(refA.id)?.payload;
    cpAProv = cpA?.vicProvenance;
    gate("A checkpoint payload carries split provenance (2 lines, 2 distinct $D018)",
      cpAProv?.lines?.length === 2 && new Set(cpAProv.lines.map((l) => l.d018)).size === 2,
      `lines=${cpAProv?.lines?.length}`);

    topBefore = resolveNodeAt(cpA, 4, 9, cpAProv);   // raster 60 → char $1000
    botBefore = resolveNodeAt(cpA, 4, 89, cpAProv);  // raster 140 → char $3000
    gate("A per-line split resolves: top char base $1000, bottom $3000 (Δ=$2000)",
      charBase(topBefore) === 0x1000 && charBase(botBefore) === 0x3000,
      `topBase=$${charBase(topBefore)?.toString(16)} botBase=$${charBase(botBefore)?.toString(16)}`);

    await dumpRuntimeSnapshot(ctrl, dumpPath);
    gate("A .c64re dumped", true, dumpPath.split("/").pop());
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

// ---- session 2 (fresh): undump, inspect A ----
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  try {
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    await undumpRuntimeSnapshot(ctrl, dumpPath);
    // Capture immediately (no run) → payload reflects the restored frame.
    const refR = await ctrl.captureCheckpoint();
    const cpR = ctrl.checkpointRing.restoreSnapshot(refR.id)?.payload;

    gate("R restored payload carries provenance after undump", !!cpR?.vicProvenance && cpR.vicProvenance.lines.length === 2, `lines=${cpR?.vicProvenance?.lines?.length}`);
    gate("R provenance deep-equals pre-dump (durable across .c64re)", JSON.stringify(cpR?.vicProvenance) === JSON.stringify(cpAProv));

    const topAfter = resolveNodeAt(cpR, 4, 9, cpR.vicProvenance);
    const botAfter = resolveNodeAt(cpR, 4, 89, cpR.vicProvenance);
    gate("R per-line char bases identical to pre-dump ($1000 / $3000)",
      charBase(topAfter) === 0x1000 && charBase(botAfter) === 0x3000,
      `topBase=$${charBase(topAfter)?.toString(16)} botBase=$${charBase(botAfter)?.toString(16)}`);
    gate("R full resolved nodes identical pre/post dump",
      JSON.stringify(topBefore) === JSON.stringify(topAfter) && JSON.stringify(botBefore) === JSON.stringify(botAfter));

    // Restored provenance applies ONLY to the restored frozen frame: run a new
    // full frame WITHOUT capture, then a fresh checkpoint B must NOT inherit it.
    session.runFor(1_000_000, { cycleBudget: 1_000_000 }); // several full frames, capture off
    const refB = await ctrl.captureCheckpoint();
    const cpB = ctrl.checkpointRing.restoreSnapshot(refB.id)?.payload;
    gate("B new frame without capture → cp.vicProvenance === null (no inheritance)", cpB?.vicProvenance === null, `prov=${JSON.stringify(cpB?.vicProvenance)}`);
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

try { unlinkSync(dumpPath); } catch {}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 710 .c64re provenance: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 710 .c64re provenance: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
