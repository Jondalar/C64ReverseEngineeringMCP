#!/usr/bin/env node
// Spec 414 — 1541 Phase H snapshot drive smoke.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §11 (snapshot module hierarchy + write
//         order + restore semantics),
//       §13 Phase H step 34 (snapshot per §11),
//       §14 invariant 10 (drive clock + alarm clocks restored as a
//         coherent absolute set),
//       §17 OQ-414-2 (snapshot drive write order pinned).
//
// VICE: src/drive/drive-snapshot.c:162-330 `drive_snapshot_write_module`,
//       src/drive/drivecpu.c:568-640 `drivecpu_snapshot_write_module`,
//       src/core/viacore.c viacore_snapshot_module_read (alarms re-armed
//         via alarm_set with restored absolute clocks).
//
// Acceptance per spec 414:
//   - VSF save mid-game.
//   - Restore.
//   - Advance same number of cycles after restore.
//   - Drive state identical (CPU regs, RAM, VIA registers, head track,
//     drive clock, IEC line state).
//
// Tier (PLAN.md): 414 = core/structural — smokes only + per-spec new
// smoke. NO MM/Scramble game test.

import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let startIntegratedSession;
let saveSessionVsf;
let loadSessionVsf;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
  ({ saveSessionVsf, loadSessionVsf } = await import(
    "../dist/runtime/headless/vsf/session-vsf.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// ---------- Boot session, advance to mid-game state ----------
const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});

// Advance cycles so drive CPU has done real work (got past head-start
// + boot to $EBFF idle loop + a few iterations).
const N1 = 50_000;
session.runFor(N1);

// Snapshot canonical drive state pre-save (= absolute reference).
function captureDriveState(session) {
  const drv = session.drive;
  const bus = drv.bus;
  return {
    cpu: {
      pc: drv.cpu.pc, a: drv.cpu.a, x: drv.cpu.x, y: drv.cpu.y,
      sp: drv.cpu.sp, flags: drv.cpu.flags, cycles: drv.cpu.cycles,
    },
    ram: Buffer.from(bus.ram).toString("hex"),
    via1: {
      ora: bus.via1.ora, orb: bus.via1.orb,
      ddra: bus.via1.ddra, ddrb: bus.via1.ddrb,
      t1Counter: bus.via1.t1Counter, t1Latch: bus.via1.t1Latch,
      t2Counter: bus.via1.t2Counter,
      acr: bus.via1.acr, pcr: bus.via1.pcr,
      ifr: bus.via1.ifr, ier: bus.via1.ier, sr: bus.via1.sr,
    },
    via2: {
      ora: bus.via2.ora, orb: bus.via2.orb,
      ddra: bus.via2.ddra, ddrb: bus.via2.ddrb,
      t1Counter: bus.via2.t1Counter, t1Latch: bus.via2.t1Latch,
      t2Counter: bus.via2.t2Counter,
      acr: bus.via2.acr, pcr: bus.via2.pcr,
      ifr: bus.via2.ifr, ier: bus.via2.ier, sr: bus.via2.sr,
    },
    head: {
      track: session.headPosition.currentTrack,
    },
    iec: session.iecBus.snapshot(),
  };
}

// ---------- Save VSF mid-game ----------
const tmpDir = mkdtempSync(join(tmpdir(), "smoke-414-vsf-"));
const vsfPath = join(tmpDir, "drive-mid-game.vsf");
const preSnapshotClk = session.kernel.c64Clock();
const preSnapshotDriveClk = session.drive.cpu.cycles;
const saveResult = saveSessionVsf(session, vsfPath);

check(
  "VSF save emitted DRIVECPU + DRIVERAM + VIA1d1541 + VIA2d1541 + GCRHEAD modules",
  ["DRIVECPU", "DRIVERAM", "VIA1d1541", "VIA2d1541", "GCRHEAD"]
    .every((m) => saveResult.modules.includes(m)),
  `modules=[${saveResult.modules.join(",")}]`,
);

// Doc §11: drive scalars module → DRIVECPU → VIA1 → VIA2 → GCR-IMAGE
// (= our GCRHEAD chunk). Verify the wire order.
check(
  "drive module wire order: DRIVECPU < VIA1 < VIA2 < GCRHEAD (= §11)",
  (() => {
    const m = saveResult.modules;
    const di = m.indexOf("DRIVECPU");
    const v1 = m.indexOf("VIA1d1541");
    const v2 = m.indexOf("VIA2d1541");
    const gh = m.indexOf("GCRHEAD");
    return di >= 0 && v1 > di && v2 > v1 && gh > v2;
  })(),
  `modules=[${saveResult.modules.join(",")}]`,
);

// ---------- Reference run: advance N2 cycles, capture drive state ----------
const N2 = 30_000;
session.runFor(N2);
const referenceDriveState = captureDriveState(session);
const referenceClk = session.kernel.c64Clock();
const referenceDriveClk = session.drive.cpu.cycles;

check(
  "reference run advanced drive clock",
  referenceDriveClk > preSnapshotDriveClk,
  `pre=${preSnapshotDriveClk} post=${referenceDriveClk}`,
);

// ---------- Restore + advance same N2 cycles ----------
const loadResult = loadSessionVsf(session, vsfPath);

check(
  "VSF load reported zero errors",
  loadResult.errors.length === 0,
  `errors=${JSON.stringify(loadResult.errors)}`,
);

check(
  "VSF load restored DRIVECPU + DRIVERAM + VIA1d1541 + VIA2d1541 + GCRHEAD",
  ["DRIVECPU", "DRIVERAM", "VIA1d1541", "VIA2d1541", "GCRHEAD"]
    .every((m) => loadResult.loadedModules.includes(m)),
  `loaded=[${loadResult.loadedModules.join(",")}]`,
);

// §14 invariant 10: drive clock restored as part of the coherent
// absolute set. drive.cpu.cycles is part of DRIVECPU (drivecpu.c:568-640).
check(
  "post-load drive clock == pre-snapshot drive clock (§14 invariant 10, absolute)",
  session.drive.cpu.cycles === preSnapshotDriveClk,
  `postLoad=${session.drive.cpu.cycles} preSnapshot=${preSnapshotDriveClk}`,
);

check(
  "post-load c64 clock == pre-snapshot c64 clock (= MAINCPU cycles)",
  session.kernel.c64Clock() === preSnapshotClk,
  `postLoad=${session.kernel.c64Clock()} preSnapshot=${preSnapshotClk}`,
);

session.runFor(N2);
const replayDriveState = captureDriveState(session);
const replayClk = session.kernel.c64Clock();
const replayDriveClk = session.drive.cpu.cycles;

check(
  "post-replay c64 clock matches reference",
  replayClk === referenceClk,
  `replay=${replayClk} reference=${referenceClk}`,
);

check(
  "post-replay drive clock matches reference",
  replayDriveClk === referenceDriveClk,
  `replay=${replayDriveClk} reference=${referenceDriveClk}`,
);

// ---------- Compare drive state byte-for-byte ----------
function compareSection(label, ref, replay) {
  const refKeys = Object.keys(ref).sort();
  const replayKeys = Object.keys(replay).sort();
  if (refKeys.join(",") !== replayKeys.join(",")) {
    check(`${label}: shape match`, false,
      `ref=[${refKeys.join(",")}] replay=[${replayKeys.join(",")}]`);
    return;
  }
  for (const k of refKeys) {
    const rv = ref[k], pv = replay[k];
    if (typeof rv === "object" && typeof pv === "object") {
      compareSection(`${label}.${k}`, rv, pv);
    } else {
      check(`${label}.${k} identical`, rv === pv, `ref=${rv} replay=${pv}`);
    }
  }
}

compareSection("drive.cpu", referenceDriveState.cpu, replayDriveState.cpu);
check(
  "drive.ram identical (2 KB)",
  referenceDriveState.ram === replayDriveState.ram,
  referenceDriveState.ram === replayDriveState.ram
    ? ""
    : `ref_len=${referenceDriveState.ram.length} replay_len=${replayDriveState.ram.length}`,
);
compareSection("drive.via1", referenceDriveState.via1, replayDriveState.via1);
compareSection("drive.via2", referenceDriveState.via2, replayDriveState.via2);
compareSection("drive.head", referenceDriveState.head, replayDriveState.head);
compareSection("drive.iec", referenceDriveState.iec, replayDriveState.iec);

// ---------- Cleanup ----------
try { unlinkSync(vsfPath); } catch { /* ignore */ }

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 414 snapshot-drive smoke — ${results.length} checks`);
const FAIL_LIMIT = 20;
let failPrinted = 0;
for (const r of results) {
  if (r.pass) continue;
  if (failPrinted >= FAIL_LIMIT) {
    console.log(`  ... (${failed - failPrinted} more failures truncated)`);
    break;
  }
  console.log(`  [FAIL] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
  failPrinted++;
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
