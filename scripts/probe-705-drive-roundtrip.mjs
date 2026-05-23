#!/usr/bin/env node
// Spec 705.A step 2.4 — drive-snapshot roundtrip + DRIVE8 normalization
// classification against the active VICE1541 path with a real unit-8 disk state.
//
// FINDING (RFL, classified CASE A = VICE-canonical):
// The DRIVE8 per-unit module's first-restore "normalization" is VICE's own
// lazy→eager rotation re-sync, NOT a TS-port serializer bug:
//   * An idle 1541 (BASIC READY, job loop) never runs the GCR-read BVC poll,
//     so VICE advances rotation only in LOCAL_SET_OVERFLOW(0) (6510core.c:158)
//     and 3 byte-ready opcodes (2527/2815/2934). Idle => rotation DEFERS:
//     `rotation_last_clk` lags far behind the drive clock (here 6 vs 60904),
//     accum/GCR_read/etc. stay at their last-synced values.
//   * On restore, viacore_snapshot_read_module's undump_pcr tail (viacore.c:2179,
//     ported verbatim) -> via2d update_pcr -> rotation_rotate_disk catches up the
//     (drive_clk - rotation_last_clk) delta with motor on, re-deriving the
//     rotation/GCR/head fields. VICE performs the SAME catch-up.
//   * drive_set_half_track (drive.c) touches only GCR_track_start_ptr /
//     GCR_head_offset(scaled) / GCR_current_track_size — verified faithful.
//     rotation_table_get/set are 1:1. The serializer chain is byte-faithful.
//
// Therefore the gate is NOT A==B serialized bytes. It asserts:
//   1. DRIVECPU restores byte-identical (live CPU + drive RAM).
//   2. Each VIA differs only at the CABSTATE byte (VICE write/read normalization).
//   3. Restore is a STABLE FIXED POINT (b1==b2): the eager rotation state is
//      canonical and never drifts on re-restore.
//   4. EVERY DRIVE8 byte that changes b0->b1 lies inside the rotation-resync
//      field set; ANY change outside it (e.g. attach_clk, type, idling_method)
//      would be real corruption and fails the gate.
//   5. After restore, rotation_last_clk has caught up to ~the drive clock
//      (proves the re-sync semantics, not an arbitrary value).
//
// NOT covered here (deferred): the full "restore(checkpoint) -> run N ==
// original -> run N" continuation equivalence needs the C64-side checkpoint
// (kernel payload) to drive the drive deterministically; that is the next
// 705.A step.

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
const modByName = (mods, pred) => (mods ?? []).find(pred);
function bodyDiffOffsets(xa, xb, ma, mb) {
  if (ma.size !== mb.size) return null;
  const out = [];
  for (let j = 0; j < ma.bodyBytes; j++) if (xa[ma.bodyStart + j] !== xb[mb.bodyStart + j]) out.push(j);
  return out;
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const U32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

// DRIVE8 body field map (drive-snapshot.c:197-265; SMW_CLOCK=8, DW=4, W=2, B=1).
const VIA_CABSTATE_OFF = 22;
// Body offsets the rotation engine legitimately re-derives on the lazy->eager
// catch-up: GCR_head_offset(27-30), GCR_read(31), rotation_table_ptr/
// speed_zone(36-39), the whole snap_* rotation block snap_accum..snap_req_ref_cycles
// (44-134), and byte_ready_active(144). Everything else must be byte-stable.
const ROT_RESYNC_OFFSETS = new Set();
for (const o of [27, 28, 29, 30, 31, 36, 37, 38, 39, 144]) ROT_RESYNC_OFFSETS.add(o);
for (let o = 44; o <= 134; o++) ROT_RESYNC_OFFSETS.add(o);

const failures = [];
let passes = 0;
function gate(name, ok, detail) {
  if (ok) { passes++; console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`); return; }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

console.log("Spec 705.A — drive-snapshot roundtrip + DRIVE8 classification (VICE1541)");
console.log(`  medium: ${diskPath}`);

const { session, sessionId } = startIntegratedSession({
  mode: "true-drive", useMicrocodedCpu: true, vicRenderer: "literal-port", drive1541: "vice",
});

try {
  const mount = await mountMedia(session, 8, diskPath);
  gate("real disk mounts on active VICE1541 path", !mount.errors?.length, mount.errors?.join("; "));

  session.resetCold("pal-default");
  session.runFor(60_000, { cycleBudget: 60_000 });
  const drive = session.kernel.drive1541;
  const driveClk = drive.debugProbe().drive_clk;

  const b0 = drive.snapshot();
  const m0 = parseSnapshotModules(b0);
  gate("snapshot() is deterministic (byte-equal back-to-back)", bytesEqual(b0, drive.snapshot()), `${b0.length}B`);

  // restore (no disturb needed: restore itself triggers the rotation re-sync)
  drive.restore(b0);
  const b1 = drive.snapshot();
  const m1 = parseSnapshotModules(b1);

  // 1 — DRIVECPU byte-identical
  {
    const c0 = modByName(m0, (m) => m.name.startsWith("DRIVECPU"));
    const c1 = modByName(m1, (m) => m.name === c0.name);
    const d = c1 ? bodyDiffOffsets(b0, b1, c0, c1) : null;
    gate("DRIVECPU restores byte-identical (CPU + drive RAM)",
      Array.isArray(d) && d.length === 0, d === null ? "size mismatch" : `${d.length} diff bytes`);
  }

  // 2 — each VIA differs only at CABSTATE
  for (const v0 of (m0 ?? []).filter((m) => m.name.includes("VIA") && m.bodyBytes > 0)) {
    const v1 = modByName(m1, (m) => m.name === v0.name);
    const d = v1 ? bodyDiffOffsets(b0, b1, v0, v1) : null;
    gate(`${v0.name} restores with diffs only at CABSTATE (VICE-faithful normalization)`,
      Array.isArray(d) && d.every((o) => o === VIA_CABSTATE_OFF),
      d === null ? "size mismatch" : `diff offsets=[${d.join(",")}]`);
  }

  // 3 — global fixed point
  drive.restore(b1);
  const b2 = drive.snapshot();
  gate("restore is a stable fixed point (b1==b2 byte-equal)", bytesEqual(b1, b2), `${b1.length}B`);

  // 4 — every DRIVE8 diff is confined to the rotation-resync field set
  {
    const d8a = modByName(m0, (m) => m.name === "DRIVE8");
    const d8b = modByName(m1, (m) => m.name === "DRIVE8");
    const d = d8a && d8b ? bodyDiffOffsets(b0, b1, d8a, d8b) : null;
    const outside = (d ?? []).filter((o) => !ROT_RESYNC_OFFSETS.has(o));
    gate("DRIVE8 b0->b1 diffs are confined to the rotation re-sync field set (no foreign corruption)",
      Array.isArray(d) && outside.length === 0,
      d === null ? "size mismatch" : `${d.length} diff bytes, ${outside.length} outside resync set${outside.length ? ` @[${outside.join(",")}]` : ""}`);

    // 5 — rotation_last_clk caught up to ~drive clock (proves re-sync semantics)
    const rlc0 = U32(b0.slice(d8a.bodyStart), 48);
    const rlc1 = U32(b1.slice(d8b.bodyStart), 48);
    gate("rotation re-sync advances rotation_last_clk to ~the drive clock on restore",
      rlc0 < driveClk && Math.abs(rlc1 - driveClk) <= 64,
      `rotation_last_clk b0=${rlc0} -> b1=${rlc1}, drive_clk=${driveClk}`);
  }
} finally {
  stopIntegratedSession(sessionId);
}

console.log("---");
if (failures.length === 0) {
  console.log(`GREEN 705.A drive roundtrip: ${passes} checks pass.`);
  console.log("DRIVE8 b0->b1 = VICE-canonical lazy->eager rotation re-sync (proven via");
  console.log("6510core.c:158/2527/2815/2934). Restore is a stable fixed point; CPU + VIA");
  console.log("identity hold. Full restore->runN==original->runN continuation needs the");
  console.log("C64-side checkpoint (next 705.A step).");
  process.exit(0);
}
console.log(`RED 705.A drive roundtrip: ${passes} pass, ${failures.length} blocker(s).`);
for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
process.exit(1);
