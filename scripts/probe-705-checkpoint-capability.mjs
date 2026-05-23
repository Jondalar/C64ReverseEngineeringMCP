#!/usr/bin/env node
// Spec 705.A preflight - prove that the active runtime exposes enough
// restorable state before attempting a long snapshot/restore continuation
// gate or implementing a rewind ring.

import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  startIntegratedSession,
  stopIntegratedSession,
} from "../dist/runtime/headless/integrated-session-manager.js";
import { mountMedia } from "../dist/runtime/headless/media/mount.js";
import { saveSessionVsf } from "../dist/runtime/headless/vsf/session-vsf.js";
import { readVsf } from "../dist/runtime/headless/vsf/vsf-format.js";
import { SidAudioRecorder } from "../dist/runtime/headless/audio/sid-audio-recorder.js";

const diskPath = resolvePath("samples/POLARBEAR.d64");
if (!existsSync(diskPath)) {
  console.error(`RED 705.A preflight: fixture missing: ${diskPath}`);
  process.exit(2);
}

const failures = [];
let passes = 0;

// Walk a VICE in-memory snapshot module stream: each module is
// [name:16][major:1][minor:1][size:4 LE], size includes the 22-byte header.
// Returns [{name, bodyBytes}] or null if the byte stream is malformed/truncated.
function parseSnapshotModules(bytes) {
  const mods = [];
  let off = 0;
  while (off + 22 <= bytes.length) {
    let name = "";
    for (let i = 0; i < 16; i++) { const c = bytes[off + i]; if (c) name += String.fromCharCode(c); }
    const size = (bytes[off + 18] | (bytes[off + 19] << 8) | (bytes[off + 20] << 16) | (bytes[off + 21] << 24)) >>> 0;
    if (size < 22 || off + size > bytes.length) return null;
    mods.push({ name, bodyBytes: size - 22 });
    off += size;
  }
  return off === bytes.length ? mods : null;
}

function gate(name, ok, detail) {
  if (ok) {
    passes++;
    console.log(`  PASS  ${name}${detail ? ` (${detail})` : ""}`);
    return;
  }
  failures.push({ name, detail });
  console.log(`  RED   ${name}${detail ? ` (${detail})` : ""}`);
}

console.log("Spec 705.A - native checkpoint capability preflight");
console.log(`  medium: ${diskPath}`);
console.log("  path:   active drive1541=vice, literal VIC renderer, PAL reset");

const tempDir = mkdtempSync(join(tmpdir(), "c64re-705-"));
const { session, sessionId } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});

let recorder;
try {
  const mount = await mountMedia(session, 8, diskPath);
  gate("real disk mounts on active VICE1541 path", !mount.errors?.length,
    mount.errors?.join("; "));

  session.resetCold("pal-default");
  session.runFor(50_000, { cycleBudget: 50_000 });

  const machineSnap = session.kernel.snapshot();
  const cp = machineSnap?.payload;
  gate("kernel snapshot API contains native RuntimeCheckpoint payload",
    cp != null && machineSnap.schemaVersion === 1,
    `schema=${machineSnap?.schemaVersion}, payload=${cp ? "RuntimeCheckpoint" : String(cp)}`);
  // Spec 705.A step 3 — the checkpoint must carry the active core domains, the
  // active literal-VIC state, and the maincpu alarm schedule (not a stub).
  gate("checkpoint carries active core + literal-VIC + alarm-schedule state",
    !!cp && cp.ram?.length === 0x10000 && cp.vic?.regs?.length === 0x40 &&
      Array.isArray(cp.alarmsMaincpu) && !!cp.cia1 && !!cp.cia2 && !!cp.sid &&
      cp.drive1541 != null,
    cp ? `ram=${cp.ram?.length}B vic.regs=${cp.vic?.regs?.length} alarms=${cp.alarmsMaincpu?.length} drive=${cp.drive1541?.length ?? 0}B` : "n/a");

  const driveBlob = session.kernel.drive1541.snapshot();
  // Spec 705.A tightened gate: a non-empty blob is NOT enough — a header-only
  // blob (just DRIVE8/DRIVE9 module headers) is plumbing success, not a
  // snapshot PASS. Walk the VICE module stream (independent inline parser, so
  // it checks the BYTES, not the port's own reader) and require real, non-empty
  // active-1541 state: a DRIVECPU module + both VIA modules.
  const mods = parseSnapshotModules(driveBlob);
  gate("VICE1541 snapshot stream is syntactically parseable",
    mods !== null,
    mods === null ? `unparseable, ${driveBlob.length}B` : `${mods.length} modules, ${driveBlob.length}B`);
  const driveCpuMod = (mods ?? []).find((m) => m.name.startsWith("DRIVECPU") && m.bodyBytes > 0);
  const viaMods = (mods ?? []).filter((m) => m.name.includes("VIA") && m.bodyBytes > 0);
  gate("active VICE1541 snapshot contains real DRIVECPU + VIA1/VIA2 state (not header-only)",
    !!driveCpuMod && viaMods.length >= 2,
    mods ? `modules=[${mods.map((m) => `${m.name}:${m.bodyBytes}`).join(", ")}]` : "n/a");

  const vsfPath = join(tempDir, "active-runtime.vsf");
  saveSessionVsf(session, vsfPath);
  const vsf = readVsf(new Uint8Array(readFileSync(vsfPath)));
  const driveModule = vsf.modules.find((m) => m.name === "DRIVECPU");
  gate("current VSF bridge contains active drive state",
    (driveModule?.data.length ?? 0) > 0,
    `DRIVECPU bytes=${driveModule?.data.length ?? -1}`);

  recorder = new SidAudioRecorder(session, { engine: "resid-wasm" });
  await recorder.resid.ready?.();
  const audioCheckpointable =
    typeof recorder.snapshot === "function" && typeof recorder.restore === "function";
  gate("live reSID sidecar exposes checkpoint/restore continuation state",
    audioCheckpointable,
    "SidAudioRecorder is outside current session checkpoint ownership");
} finally {
  recorder?.detach();
  stopIntegratedSession(sessionId);
  rmSync(tempDir, { recursive: true, force: true });
}

console.log("---");
if (failures.length === 0) {
  console.log(`GREEN 705.A preflight: ${passes} prerequisite checks pass.`);
  process.exit(0);
}

console.log(`RED 705.A preflight: ${passes} pass, ${failures.length} blocker(s).`);
for (const failure of failures) {
  console.log(`  - ${failure.name}: ${failure.detail}`);
}
console.log("Do not implement a rewind ring on this state surface. Wire native restore first.");
process.exit(1);
