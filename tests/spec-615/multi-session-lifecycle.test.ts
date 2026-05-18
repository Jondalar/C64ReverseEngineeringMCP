// SCHRITT 4.5 (Spec 615 P0 multi-session lifecycle).
// 3 sequential startIntegratedSession() in same node process.
// Per-session: assert drive state after mount + assert LOAD"$",8 screen
// does not contain "FILE NOT FOUND".
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

function decodeScreen(ram: Uint8Array): string {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i]! & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}

const failures: string[] = [];
for (const disk of DISKS) {
  const diskPath = resolvePath(import.meta.dirname, "..", "..", disk);
  const r = startIntegratedSession({
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "literal-port",
    drive1541: "vice",
  });
  const session = r.session;
  await mountMedia(session, 8, diskPath);

  const drv = (session.kernel.drive1541 as { unit: any }).unit;
  const d0 = drv.drives[0];

  const checks: [string, boolean][] = [
    ["image !== null", d0.image !== null],
    ["image.gcr !== null", d0.image?.gcr !== null && d0.image?.gcr !== undefined],
    ["drive.gcr !== null", d0.gcr !== null],
    ["GCR_image_loaded === 1", d0.GCR_image_loaded === 1],
    ["current_half_track === 36", d0.current_half_track === 36],
    ["GCR_track_start_ptr !== null", d0.GCR_track_start_ptr !== null],
    ["GCR_current_track_size > 0", d0.GCR_current_track_size > 0],
  ];
  for (const [name, ok] of checks) {
    if (!ok) failures.push(`${disk} state: ${name} failed`);
  }

  session.resetCold("pal-default");
  session.runFor(2_000_000);
  session.typeText('LOAD"$",8\r', 80_000, 80_000);
  const PAL_HZ = 985_248;
  const target = session.c64Cpu.cycles + 60 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(500_000);

  const screen = decodeScreen((session.c64Bus as { ram: Uint8Array }).ram);
  if (/FILE NOT FOUND/.test(screen)) {
    failures.push(`${disk} screen: FILE NOT FOUND found`);
  }
  if (!/LOADING|READY/.test(screen)) {
    failures.push(`${disk} screen: missing LOADING/READY marker`);
  }

  stopIntegratedSession(r.sessionId);
  console.log(`OK  ${disk}`);
}

if (failures.length > 0) {
  console.error(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nALL 3 SESSIONS GREEN");
