#!/usr/bin/env node
// scripts/proof-canary-inspect.mjs
//
// Spec 715 baseline canary — frozen-VIC inspect (Spec 710). Cut to the earliest
// stable PASS: boot → capture-on-freeze (provenance) → resolve ONE display pixel
// to its exact VIC/RAM provenance, without advancing execution. Proves the
// inspect path end-to-end (checkpoint → snapshot → resolver) is alive.

import { resolve as resolvePath } from "node:path";

let startIntegratedSession, stopIntegratedSession, ensureRuntimeController,
    buildVicInspectSnapshot, resolveVisibleNodeAt, DISPLAY_ORIGIN;
try {
  ({ startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js"));
  ({ ensureRuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js"));
  ({ buildVicInspectSnapshot, resolveVisibleNodeAt, DISPLAY_ORIGIN } = await import("../dist/runtime/headless/inspect/vic-inspect.js"));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

function fail(msg, detail) {
  console.error(`=== frozen-inspect canary RED ===\nreason: ${msg}${detail ? `\n${detail}` : ""}`);
  process.exit(1);
}

const { session, sessionId } = startIntegratedSession({ mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port" });
try {
  session.resetCold("pal-default");
  const ctrl = ensureRuntimeController(sessionId, session, () => {});
  ctrl.run({ mode: "warp" });
  await new Promise((r) => setTimeout(r, 120));   // free-run a bit
  ctrl.freezeWithProvenance();                    // capture-on-freeze → full-frame provenance
  if (ctrl.runState !== "paused") fail("not paused after freeze", `runState=${ctrl.runState}`);

  const ref = await ctrl.captureCheckpoint();
  const cp = ctrl.checkpointRing.restoreSnapshot(ref.id)?.payload;
  if (!cp || !cp.vic || !cp.ram) fail("checkpoint payload unreadable");

  const snap = buildVicInspectSnapshot(cp);
  if (!snap.mode) fail("no VIC mode from snapshot");
  if (!cp.vicProvenance || cp.vicProvenance.lines.length < 250) fail("capture-on-freeze did not record full-frame provenance", `lines=${cp.vicProvenance?.lines?.length}`);

  // Resolve a display pixel (centre of cell 4,1 of the READY screen) → exact refs.
  const node = resolveVisibleNodeAt(cp, DISPLAY_ORIGIN.x + 4 * 8 + 1, DISPLAY_ORIGIN.y + 1 * 8 + 1, cp.vicProvenance);
  if (!node || !Array.isArray(node.refs) || node.refs.length === 0) fail("resolveVisibleNodeAt returned no refs", JSON.stringify(node));
  const hasMem = node.refs.some((r) => r.kind === "screen_ram" || r.kind === "bitmap" || r.kind === "sprite_ptr");
  if (!hasMem) fail("resolved node has no VIC/RAM memory ref", `type=${node.type} refs=${node.refs.map((r) => r.kind).join(",")}`);

  console.log(`=== Spec 715 — frozen-inspect canary (Spec 710) ===`);
  console.log(`  PASS  capture-on-freeze → provenance ${cp.vicProvenance.lines.length} lines`);
  console.log(`  PASS  resolved ${node.type} (${snap.mode}) with refs: ${node.refs.map((r) => r.kind).join(", ")}`);
  console.log(`GREEN: frozen-VIC inspect path alive (no execution advance).`);
  process.exit(0);
} finally {
  try { stopIntegratedSession(sessionId); } catch {}
}
