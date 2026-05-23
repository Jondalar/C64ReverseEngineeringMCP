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
  gate("kernel snapshot API contains runtime payload",
    machineSnap?.payload !== null && machineSnap?.payload !== undefined,
    `payload=${String(machineSnap?.payload)}`);

  const driveBlob = session.kernel.drive1541.snapshot();
  gate("active VICE1541 exposes a non-empty restorable checkpoint blob",
    driveBlob.length > 0, `bytes=${driveBlob.length}`);

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
