// SCHRITT 1: reproduce multi-session reinit bug.
import { resolve as resolvePath } from "node:path";

const { startIntegratedSession, stopIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const DISKS = [
  "samples/POLARBEAR.d64",
  "samples/motm.g64",
  "samples/scramble_infinity.d64",
];

for (const disk of DISKS) {
  const { session, sessionId } = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });
  await mountMedia(session, 8, resolvePath(import.meta.dirname, "..", "..", disk));
  const drv = (session.kernel.drive1541 as { unit: any }).unit;
  const d0 = drv.drives[0];
  console.log(`--- ${disk} ---`);
  console.log(`  image !== null:               ${d0.image !== null}`);
  console.log(`  drive.gcr !== null:           ${d0.gcr !== null}`);
  console.log(`  image.gcr !== null:           ${d0.image?.gcr !== null && d0.image?.gcr !== undefined}`);
  console.log(`  GCR_image_loaded === 1:       ${d0.GCR_image_loaded === 1}`);
  console.log(`  current_half_track === 36:    ${d0.current_half_track === 36}`);
  console.log(`  GCR_track_start_ptr !== null: ${d0.GCR_track_start_ptr !== null}`);
  console.log(`  GCR_current_track_size > 0:   ${d0.GCR_current_track_size > 0}`);
  stopIntegratedSession(sessionId);
}
