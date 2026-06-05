#!/usr/bin/env node
// Leak fix (705.B ring) — media-ingress pinned checkpoints must stay BOUNDED.
// Each media op (eject/mount/PRG/CRT) pins before+after so the recent media
// history is replayable; without a window they pin forever → the ring fills with
// un-evictable entries (unbounded; `runtime_swap_disk_and_continue` = 2 ops/swap).
// Fix keeps only the last PINNED_MEDIA_EVENTS (16) pinned.
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0; const fail = [];
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}${d ? `  (${d})` : ""}`); } else { fail.push(n); console.log(`  FAIL  ${n}${d ? `  (${d})` : ""}`); } };
if (!existsSync(join(ROOT, "dist/runtime/headless/media/ingress.js"))) { console.error("build:mcp first"); process.exit(2); }

const { buildD64 } = await import("../dist/disk/d64-builder.js");
const { startIntegratedSession, stopIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
const { RuntimeController } = await import("../dist/runtime/headless/debug/runtime-controller.js");
const { ingestMedia } = await import("../dist/runtime/headless/media/ingress.js");
const { buildIngressRequest } = await import("../dist/runtime/headless/media/ingress-request.js");

const mk = (name) => buildD64({ diskName: name, diskId: "23", files: [{ name: "X", payload: new Uint8Array([0x01, 0x08, 0x60]) }] });
const root = mkdtempSync(join(tmpdir(), "c64re-pinleak-"));
const a = join(root, "a.d64"); const b = join(root, "b.d64");
writeFileSync(a, Buffer.from(mk("A"))); writeFileSync(b, Buffer.from(mk("B")));

const { session, sessionId } = startIntegratedSession({});
const ctrl = new RuntimeController(sessionId, session, () => {});
try {
  session.resetCold("pal-default");
  await ingestMedia(ctrl, buildIngressRequest({ kind: "disk", path: a }));
  const swapN = async (n) => { for (let i = 0; i < n; i++) {
    await ingestMedia(ctrl, buildIngressRequest({ kind: "eject", role: "drive8" }));
    await ingestMedia(ctrl, buildIngressRequest({ kind: "disk", path: i % 2 ? a : b }));
  } };
  const pinnedCount = () => ctrl.checkpointRing.list().filter((r) => r.pinned).length;

  await swapN(40);                 // 80 media ops
  const pinned1 = pinnedCount();
  // Window = 16 events × ≤2 checkpoints = ≤32; allow slack. Without the fix: ~160.
  ok("1 pinned checkpoints bounded after 80 ops (≤ 40, not ~160)", pinned1 <= 40, `pinned=${pinned1}`);

  await swapN(40);                 // 80 MORE media ops (160 total)
  const pinned2 = pinnedCount();
  // The leak fingerprint = pinned grows with op count. Windowed → it must NOT.
  ok("2 pinned does NOT grow with more ops (windowed, not leaking)", pinned2 <= 40 && pinned2 <= pinned1 + 2, `pinned ${pinned1}→${pinned2} over 80→160 ops`);
  // Recent media events ARE still pinned (replay anchors preserved, not zeroed).
  ok("3 the recent window stays pinned (anchors kept)", pinned2 >= 2, `pinned=${pinned2}`);
} finally {
  ctrl.pause(); stopIntegratedSession(sessionId); rmSync(root, { recursive: true, force: true });
}

console.log(`\ne2e-checkpoint-pin-leak: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error("FAILED:\n  " + fail.join("\n  ")); process.exit(1); }
console.log("ALL GREEN");
