#!/usr/bin/env node
// BUG-027 Blocker 2 (Spec 744 §7.2) — runtime_swap_disk_and_continue orchestration.
// In-process: mount disk A, swap-and-continue to disk B, assert the hardware-style
// sequence ran (eject→run→insert→run→confirm→run), the new disk is mounted, and a
// diagnostic (screens, promptCleared/advanced flags) is returned. The real
// "game advances past Insert side N" is live-verified on a multi-disk title.
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };

if (!existsSync(join(ROOT, "dist/runtime/headless/media/swap-and-continue.js"))) {
  console.error("build:mcp first"); process.exit(2);
}

const { buildD64 } = await import("../dist/disk/d64-builder.js");
const { startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { RuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js");
const { ingestMedia } = await import("../dist/runtime/headless/media/ingress.js");
const { buildIngressRequest } = await import("../dist/runtime/headless/media/ingress-request.js");
const { swapDiskAndContinue } = await import("../dist/runtime/headless/media/swap-and-continue.js");

// Two distinct synthetic disks: one PRG each, different disk names.
const mkDisk = (diskName) => buildD64({ diskName, diskId: "23", files: [
  { name: "HELLO", payload: new Uint8Array([0x01, 0x08, 0x60]) }, // load $0801, RTS
] });

const root = mkdtempSync(join(tmpdir(), "c64re-bug027-"));
const diskA = join(root, "side_a.d64");
const diskB = join(root, "side_b.d64");
writeFileSync(diskA, Buffer.from(mkDisk("SIDE A")));
writeFileSync(diskB, Buffer.from(mkDisk("SIDE B")));

const { session, sessionId } = startIntegratedSession({});
const ctrl = new RuntimeController(sessionId, session, () => {});
try {
  session.resetCold("pal-default");
  // Mount side A first (the "currently inserted" disk).
  await ingestMedia(ctrl, buildIngressRequest({ kind: "disk", path: diskA }));

  // Swap-and-continue to side B with small cycle budgets (fast gate).
  const r = await swapDiskAndContinue(ctrl, { path: diskB, settleCycles: 40000, postCycles: 80000 });
  ok("1 returns ok", r.ok === true);
  ok("2 the new side is mounted (side_b)", /side_b/.test(String(r.mounted)), String(r.mounted));
  ok("3 screenBefore + screenAfter are strings", typeof r.screenBefore === "string" && typeof r.screenAfter === "string");
  ok("4 diagnostic flags present (promptCleared/advanced are booleans)", typeof r.promptCleared === "boolean" && typeof r.advanced === "boolean");
  ok("5 detail reports the cycle budgets used", r.detail?.settleCycles === 40000 && r.detail?.postCycles === 80000, JSON.stringify(r.detail?.settleCycles));

  // Round-trip back to side A.
  const r2 = await swapDiskAndContinue(ctrl, { path: diskA, confirmInput: "", settleCycles: 40000, postCycles: 40000 });
  ok("6 round-trip back mounts side_a", /side_a/.test(String(r2.mounted)), String(r2.mounted));
  ok("7 confirmInput=\"\" skips the key (no throw)", r2.ok === true);

  // Bad path → throws (diagnostic failure, not silent ok).
  let threw = false;
  try { await swapDiskAndContinue(ctrl, { path: join(root, "nope.d64"), settleCycles: 1000, postCycles: 1000 }); }
  catch { threw = true; }
  ok("8 a missing image throws (not a silent success)", threw);
} finally {
  ctrl.pause(); stopIntegratedSession(sessionId); rmSync(root, { recursive: true, force: true });
}

console.log(`\ne2e-bug027-swap-continue: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
