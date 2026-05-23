#!/usr/bin/env node
// Spec 705.A step 2.3 — targeted drive-snapshot roundtrip against the active
// VICE1541 path with a real unit-8 disk state.
//
// Scope of this step: viacore_snapshot_write/read_module (VIA1d1541 + VIA2) as
// a literal VICE port, plus the iecieee VIA2 dispatch wiring. The gates below
// assert exactly what that port owns:
//
//   * DRIVECPU module restores byte-identical (the CPU+RAM the VIAs drive).
//   * VIA1 + VIA2 restore differ from the original by AT MOST the single
//     CABSTATE byte (viacore.c:1983-1987 write vs :2159-2163 read use
//     deliberately different bit layouts — VICE's own normalization, ported
//     verbatim; a VICE snapshot is not byte-identical there either).
//   * The whole drive checkpoint is a STABLE FIXED POINT: restore -> snapshot
//     -> restore -> snapshot is byte-identical (restore never drifts).
//
// NOT owned by this step (documented, not failed):
//   * The DRIVE8 per-unit head/GCR/rotation/led block belongs to
//     drive-snapshot.c (drive_snapshot_write/read_module), a different ported
//     function. Its first-restore normalization is reported as the next
//     boundary for a focused RFL pass.
//   * The full "run N cycles from restore == run N from original" continuation
//     compares C64+drive trajectories and is gated on the kernel/reSID
//     checkpoint steps (later 705.A).

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";

const diskPath = resolvePath("samples/POLARBEAR.d64");
if (!existsSync(diskPath)) {
  console.error(`RED 705.A roundtrip: fixture missing: ${diskPath}`);
  process.exit(2);
}

// Module-stream parser: [name:16][major:1][minor:1][size:4 LE], size incl. 22B
// header. Returns absolute body span so callers can byte-compare per module.
const HDR = 22;
function parseSnapshotModules(bytes) {
  const mods = [];
  let off = 0;
  while (off + HDR <= bytes.length) {
    let name = "";
    for (let i = 0; i < 16; i++) { const c = bytes[off + i]; if (c) name += String.fromCharCode(c); }
    const size = (bytes[off + 18] | (bytes[off + 19] << 8) | (bytes[off + 20] << 16) | (bytes[off + 21] << 24)) >>> 0;
    if (size < HDR || off + size > bytes.length) return null;
    mods.push({ name, start: off, size, bodyStart: off + HDR, bodyBytes: size - HDR });
    off += size;
  }
  return off === bytes.length ? mods : null;
}
function modByName(mods, pred) { return (mods ?? []).find(pred); }
// Body-relative offsets where two equally-named modules differ.
function bodyDiffOffsets(xa, xb, ma, mb) {
  const out = [];
  if (ma.size !== mb.size) return null;
  for (let j = 0; j < ma.bodyBytes; j++) if (xa[ma.bodyStart + j] !== xb[mb.bodyStart + j]) out.push(j);
  return out;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

// VIA module body field layout (viacore.c:1963-2008). CABSTATE is body byte 22.
const VIA_CABSTATE_OFF = 22;

console.log("Spec 705.A — drive-snapshot roundtrip (active VICE1541)");
console.log(`  medium: ${diskPath}`);

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

try {
  const mount = await mountMedia(session, 8, diskPath);
  gate("real disk mounts on active VICE1541 path", !mount.errors?.length, mount.errors?.join("; "));

  session.resetCold("pal-default");
  session.runFor(60_000, { cycleBudget: 60_000 });
  const drive = session.kernel.drive1541;

  // checkpoint 0
  const b0 = drive.snapshot();
  const m0 = parseSnapshotModules(b0);
  const cpu0 = modByName(m0, (m) => m.name.startsWith("DRIVECPU") && m.bodyBytes > 0);
  const via0 = (m0 ?? []).filter((m) => m.name.includes("VIA") && m.bodyBytes > 0);
  gate("checkpoint contains DRIVECPU + 2 non-empty VIA modules",
    !!cpu0 && via0.length >= 2,
    m0 ? `[${m0.map((m) => `${m.name}:${m.bodyBytes}`).join(", ")}]` : "unparseable");

  // determinism: two captures, no run between
  gate("snapshot() is deterministic (byte-equal back-to-back)", bytesEqual(b0, drive.snapshot()),
    `${b0.length}B`);

  // disturb
  drive.reset("cold");
  session.runFor(20_000, { cycleBudget: 20_000 });
  gate("disturb (cold reset + run) changes the checkpoint", !bytesEqual(b0, drive.snapshot()));

  // restore checkpoint 0 -> capture b1 (no run in between -> rclk identical)
  drive.restore(b0);
  const b1 = drive.snapshot();
  const m1 = parseSnapshotModules(b1);

  // GATE 1 — DRIVECPU restores byte-identical (CPU + drive RAM).
  {
    const c1 = modByName(m1, (m) => m.name === cpu0.name);
    const d = c1 ? bodyDiffOffsets(b0, b1, cpu0, c1) : null;
    gate("DRIVECPU restores byte-identical (CPU + drive RAM)",
      Array.isArray(d) && d.length === 0,
      d === null ? "size mismatch" : `${d.length} diff bytes`);
  }

  // GATE 2 — each VIA restores with diffs ONLY at the CABSTATE byte (VICE
  // write/read normalization), nothing else.
  for (const v0 of via0) {
    const v1 = modByName(m1, (m) => m.name === v0.name);
    const d = v1 ? bodyDiffOffsets(b0, b1, v0, v1) : null;
    const onlyCabstate = Array.isArray(d) && d.every((o) => o === VIA_CABSTATE_OFF);
    gate(`${v0.name} restores with diffs only at CABSTATE (VICE-faithful normalization)`,
      onlyCabstate,
      d === null ? "size mismatch" : `diff offsets=[${d.join(",")}]`);
  }

  // GATE 3 — whole checkpoint is a stable fixed point (restore never drifts).
  drive.restore(b1);
  const b2 = drive.snapshot();
  gate("restore is a stable fixed point (restore->snapshot->restore->snapshot byte-equal)",
    bytesEqual(b1, b2), `${b1.length}B`);

  // DOCUMENTED NEXT BOUNDARY — DRIVE8 per-unit module (drive-snapshot.c), not
  // this step's port. Report its first-restore normalization, do not fail on it.
  {
    const d8a = modByName(m0, (m) => m.name === "DRIVE8");
    const d8b = modByName(m1, (m) => m.name === "DRIVE8");
    const d = d8a && d8b ? bodyDiffOffsets(b0, b1, d8a, d8b) : null;
    console.log("---");
    console.log(`  NEXT  DRIVE8 (drive-snapshot.c) first-restore normalization: ` +
      `${d ? d.length : "?"} body bytes differ at offsets [${d ? d.join(",") : "n/a"}].`);
    console.log("        b1==b2 fixed-point holds for DRIVE8 too, so restore is");
    console.log("        idempotent; classifying these vs VICE drive-snapshot.c");
    console.log("        write/read symmetry is a separate RFL task (next 705.A slice).");
  }
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) {
  console.log(`GREEN 705.A drive roundtrip: ${passes} viacore-scoped checks pass.`);
  console.log("VIA1/VIA2 + DRIVECPU restore is VICE-faithful; restore is a stable fixed point.");
  process.exit(0);
}
console.log(`RED 705.A drive roundtrip: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
