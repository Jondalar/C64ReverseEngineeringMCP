#!/usr/bin/env node
// scripts/smoke-710-provenance.mjs
//
// Spec 710.4 — same-frame provenance sidecar: correctness + disabled-path
// performance budget.
//
// (A) Per-line override (unit): a synthetic provenance with two lines carrying
//     different $D018 → resolveNodeAt resolves different char bases per display
//     line (raster-split / FLI), and tags node.raster.
// (B) Integration: enable capture on a real session, run frames, assert the
//     last complete frame's per-line provenance was captured.
// (C) Performance budget: capture-OFF (default) must not materially slow
//     playback. Measure OFF vs ON wall time over equal work; assert OFF-path is
//     stable and the opt-in ON overhead stays within budget.
//
// Exit 0 = PASS, 1 = FAIL.

let startIntegratedSession, stopIntegratedSession, ensureRuntimeController,
    buildVicInspectSnapshot, resolveNodeAt, resolveRegion;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js"));
  ({ buildVicInspectSnapshot, resolveNodeAt, resolveRegion } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
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

console.log("Spec 710.4 — provenance sidecar smoke");

// ---- (A) synthetic per-line override ----
{
  const regs = new Array(0x40).fill(0);
  regs[0x18] = 0x14;                 // frame-global: screen $0400, char $1000
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram: new Uint8Array(65536), cia2: { c_cia: [0x03] } };
  // line 51 ($D018=$14 → char $1000), line 60 ($D018=$1c → char $3000)
  const provenance = { lines: [
    { line: 51, d011: 0, d016: 0, d018: 0x14, bank: 0 },
    { line: 60, d011: 0, d016: 0, d018: 0x1c, bank: 0 },
  ] };
  const top = resolveNodeAt(cp, 4, 0, provenance);   // y0 → raster 51
  const lower = resolveNodeAt(cp, 4, 9, provenance);  // y9 → raster 60
  const topChar = top.refs.find((r) => r.kind === "charset");
  const lowChar = lower.refs.find((r) => r.kind === "charset");
  gate("A top line uses $D018=$14 → charset base $1000", topChar?.addr === 0x1000, `addr=$${topChar?.addr.toString(16)}`);
  gate("A lower line uses $D018=$1c → charset base $3000", lowChar?.addr === 0x3000, `addr=$${lowChar?.addr.toString(16)}`);
  gate("A node tagged with raster line", top.raster?.line === 51 && lower.raster?.line === 60, `top=${top.raster?.line} lower=${lower.raster?.line}`);
  const noProv = resolveNodeAt(cp, 4, 9);            // without provenance → frame-global $1000
  gate("A without provenance → frame-global base $1000", noProv.refs.find((r) => r.kind === "charset")?.addr === 0x1000);
}

// ---- (B) integration capture on a real session ----
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  try {
    session.setVicProvenanceCapture(true);
    session.resetCold("pal-default");
    session.runFor(3_000_000, { cycleBudget: 3_000_000 }); // several frames
    const prov = session.captureVicProvenance();
    gate("B provenance captured for last complete frame", !!prov && Array.isArray(prov.lines), `lines=${prov?.lines.length}`);
    if (prov) {
      gate("B captured a full frame's display lines (>=250)", prov.lines.length >= 250, `lines=${prov.lines.length}`);
      const everyHasD018 = prov.lines.every((l) => typeof l.d018 === "number");
      gate("B every line carries $D018", everyHasD018);
      const l100 = prov.lines.find((l) => l.line === 100);
      gate("B display line 100 present", !!l100, l100 ? `d018=$${l100.d018.toString(16)}` : "missing");
    }
    session.setVicProvenanceCapture(false);
    gate("B disabling clears provenance", session.captureVicProvenance() === null);
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

// ---- (C) disabled-path performance budget ----
{
  const measure = (capture) => {
    const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
    try {
      session.setVicProvenanceCapture(capture);
      session.resetCold("pal-default");
      session.runFor(2_000_000, { cycleBudget: 2_000_000 }); // warm
      const t0 = process.hrtime.bigint();
      session.runFor(10_000_000, { cycleBudget: 10_000_000 }); // ~10 frames
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return ms;
    } finally { try { stopIntegratedSession(sessionId); } catch {} }
  };
  const off1 = measure(false);
  const off2 = measure(false);
  const on = measure(true);
  const offAvg = (off1 + off2) / 2;
  const ratio = on / offAvg;
  console.log(`  perf: OFF=${off1.toFixed(0)}/${off2.toFixed(0)}ms (avg ${offAvg.toFixed(0)}) · ON=${on.toFixed(0)}ms · ON/OFF=${ratio.toFixed(3)}`);
  // OFF-path stability: two OFF runs within 35% of each other (noisy CI tolerance).
  gate("C OFF-path runs are stable", Math.abs(off1 - off2) / offAvg < 0.35, `|Δ|=${(Math.abs(off1 - off2) / offAvg * 100).toFixed(0)}%`);
  // Opt-in ON overhead bounded (per-line object capture). Budget generous: <60%.
  gate("C opt-in ON overhead within budget (ON/OFF < 1.6)", ratio < 1.6, `ratio=${ratio.toFixed(3)}`);
}

// ---- (D) checkpoint-bound provenance (NOT session-live) ----
{
  const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
  try {
    session.setVicProvenanceCapture(true);
    session.resetCold("pal-default");
    session.runFor(3_000_000, { cycleBudget: 3_000_000 });
    const ctrl = ensureRuntimeController(sessionId, session, () => {});
    const refA = await ctrl.captureCheckpoint();
    ctrl.checkpointRing.pin(refA.id);                       // keep A inspectable across B
    const cpA = ctrl.checkpointRing.restoreSnapshot(refA.id)?.payload;
    const provA = cpA?.vicProvenance;                        // provenance rides the payload
    gate("D checkpoint A payload carries its provenance", !!provA && provA.lines.length >= 250, `lines=${provA?.lines?.length}`);
    const nodeBefore = resolveNodeAt(cpA, 36, 12, provA);

    // advance to a later frame B + capture it
    session.runFor(5_000_000, { cycleBudget: 5_000_000 });
    const refB = await ctrl.captureCheckpoint();
    const cpB = ctrl.checkpointRing.restoreSnapshot(refB.id)?.payload;

    const cpA2 = ctrl.checkpointRing.restoreSnapshot(refA.id)?.payload;
    const nodeAfter = resolveNodeAt(cpA2, 36, 12, cpA2?.vicProvenance);
    gate("D re-inspect A after running to B → identical node", JSON.stringify(nodeBefore) === JSON.stringify(nodeAfter));
    gate("D A payload provenance unchanged after B", JSON.stringify(cpA2?.vicProvenance) === JSON.stringify(provA));
    gate("D A and B are distinct checkpoints", refA.id !== refB.id && !!cpB);
  } finally { try { stopIntegratedSession(sessionId); } catch {} }
}

// ---- (E) region threads the same provenance as point-resolve ----
{
  const regs = new Array(0x40).fill(0); regs[0x18] = 0x14;
  const cp = { vic: { regs, color_ram: new Array(0x400).fill(0) }, ram: new Uint8Array(65536), cia2: { c_cia: [0x03] } };
  // cy steps by 8: y0 → raster 51 ($14→char $1000), y8 → raster 59 ($1c→char $3000)
  const provenance = { lines: [
    { line: 51, d011: 0, d016: 0, d018: 0x14, bank: 0 },
    { line: 59, d011: 0, d016: 0, d018: 0x1c, bank: 0 },
  ] };
  const nodes = resolveRegion(cp, { x: 0, y: 0, width: 8, height: 16 }, provenance);
  const bases = nodes.map((n) => n.refs.find((r) => r.kind === "charset")?.addr).sort((a, b) => a - b);
  gate("E region uses provenance: two raster lines → two char bases", nodes.length === 2 && bases[0] === 0x1000 && bases[1] === 0x3000, `bases=${bases.map((b) => "$" + b.toString(16)).join(",")}`);
}

console.log("---");
if (failures.length === 0) { console.log(`GREEN 710.4 provenance: ${passes} checks pass.`); process.exit(0); }
console.log(`RED 710.4 provenance: ${passes} pass, ${failures.length} fail.`);
process.exit(1);
