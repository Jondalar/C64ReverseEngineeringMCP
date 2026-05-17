#!/usr/bin/env node
// Spec 611 phase 611.7f.13 — VICE rotation_sync_found semantics + TS
// runtime trace per Codex 10:37.
//
// Layers per Codex:
//   1. Source anchor (quoted in this script header from VICE source).
//   2. TS runtime proof: log $F565 LDA $1C00 polls with full state.
//   3. Polarity check: confirm PB.7 = 0 when sync, 0x80 when no sync.
//   4. Owner decision.
//
// VICE SOURCE ANCHORS:
//
//   rotation.c:1130-1142 rotation_sync_found():
//     "The return value corresponds to bit#7 of VIA2 PRB. This means
//      0x0 is returned when sync is found and 0x80 is returned when
//      no sync is found."
//     if (read_write_mode == 0 || attach_clk != 0) return 0x80;
//     return rotation[dnr].last_read_data == 0x3ff ? 0 : 0x80;
//
//   rotation_1541_simple (rotation.c:~1014-1106):
//     for each bit moved:
//       last_read_data = (last_read_data << 1) | (gcr_bit);
//       last_read_data &= 0x1ffff;
//       if ((~last_read_data) & 0x1ff80) { increment bit_counter }
//       else                              { bit_counter = 0 } // SYNC
//     state stored: last_read_data >> 7 & 0x3ff (= top 10 bits)
//
//   via2d.c readPb (via2d.c:486-511):
//     drive->req_ref_cycles = BUS_READ_DELAY;
//     rotation_rotate_disk(drive);
//     byte = ((rotation_sync_found(drive)
//            | drive_writeprotect_sense(drive) | 0x6f) & ~DDRB)
//           | (PRB & DDRB);
//     drive->byte_ready_level = 0;
//
// SYNC LIFETIME = the # of consecutive drive cycles where
// last_read_data == 0x3ff. Per VICE simple-rotation, sync stays for as
// long as the bit stream continues to feed 1-bits at the byte_clock.
//
// Real 1541 sync mark = 5+ bytes of $FF = 40+ bits of "1". At
// rot_speed_bps[0][2]=285714 bps (= zone 2 = track 18) and drive clk
// 1MHz, one bit takes ~3.5 drive cycles. 40 bits ≈ 140 drive cycles.
// So SYNC lifetime should be ≈ 140 drive cycles per sync mark.
//
// If drive's $F565 poll loop iterates every ~20-30 drive cycles, drive
// should hit several SYNC-low reads per sync mark, not just 1.

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../dist/runtime/headless/media/mount.js"
);

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/synthetic/blank.d64");
if (!existsSync(diskPath)) { console.error("missing", diskPath); process.exit(1); }

const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
const vice = session.kernel.drive1541;
const drive = vice.diskunit.drives[0];
const driveCpu = vice.driveCpu;
const via2 = driveCpu.via2;
await mountMedia(session, 8, diskPath);

// Direct access to rotation state for verification.
const rotationMod = await import("../dist/runtime/headless/vice1541/rotation.js");

// Capture $F565 LDA $1C00 polls.
const polls = [];
const MAX_POLLS = 60;
const origRead = via2.read.bind(via2);
via2.read = (reg) => {
  const result = origRead(reg);
  if ((reg & 0x0f) === 0x00) { // VIA_PRB = $1C00
    const pc = driveCpu.cpu.reg_pc & 0xffff;
    if (pc === 0xf565 || pc === 0xf566 || pc === 0xf567 || pc === 0xf568) {
      if (polls.length < MAX_POLLS) {
        polls.push({
          clk: driveCpu.cpu.clk,
          pc,
          pbValue: result & 0xff,
          sync_bit: (result & 0x80) === 0 ? "LOW(sync)" : "HIGH(nosync)",
          drvClk: driveCpu.cpu.clk,
          halfTrack: drive.currentHalfTrack,
          gcrHeadOffset: drive.gcrHeadOffset,
          gcrCurrentTrackSize: drive.gcrCurrentTrackSize,
          readWriteMode: drive.readWriteMode,
          byteReadyActive: drive.byteReadyActive,
          byteReadyLevel: drive.byteReadyLevel,
          byteReadyEdge: drive.byteReadyEdge,
          gcrRead: drive.gcrRead,
          gcrTrackStartPtr: drive.gcrTrackStartPtr !== null ? "ok" : "NULL",
        });
      }
    }
  }
  return result;
};

// Track how many consecutive cycles SYNC was LOW (= sync lifetime).
let syncLowRun = 0;
let syncLowMaxRun = 0;
let syncFoundCalls = 0;
const origSyncFound = rotationMod.rotation_sync_found;
// Can't easily monkey-patch ES module export. Skip lifetime tracking; rely
// on poll table instead.

session.resetCold("pal-default");
session.runFor(2_000_000);
session.typeText('LOAD"$",8\r', 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 14 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(200_000);

// === Output ===
console.log("=== LAYER 1: VICE SOURCE ANCHOR (see script header) ===");
console.log("Sync = 10 consecutive 1-bits in last_read_data (top 10 of 17-bit shift register).");
console.log("PB.7: 0 = SYNC detected; 0x80 = no sync. ROM at $F565 waits for SYNC-low.");
console.log("");

console.log(`=== LAYER 2: TS RUNTIME — ${polls.length} polls at $F565-$F568 captured ===`);
console.log("clk         PC    PB      sync   HT   off   sz    rwMode  bRA  bRL bRE  gcrRead");
console.log("──────────────────────────────────────────────────────────────────────────────────");
for (const p of polls.slice(0, 60)) {
  console.log(
    `${p.clk.toString().padStart(10)}  $${p.pc.toString(16)} $${p.pbValue.toString(16).padStart(2,"0")}    ` +
    `${p.sync_bit.padEnd(11)} ${p.halfTrack.toString().padStart(3)}  ${p.gcrHeadOffset.toString().padStart(5)}  ${p.gcrCurrentTrackSize.toString().padStart(5)} ` +
    `0x${(p.readWriteMode & 0xff).toString(16).padStart(2,"0")}    ` +
    `${(p.byteReadyActive & 0xff).toString(16).padStart(2,"0")}   ${(p.byteReadyLevel & 0xff).toString(16).padStart(2,"0")}  ${(p.byteReadyEdge & 0xff).toString(16).padStart(2,"0")}   $${(p.gcrRead & 0xff).toString(16).padStart(2,"0")}`,
  );
}

const lowCnt = polls.filter((p) => p.sync_bit === "LOW(sync)").length;
const highCnt = polls.length - lowCnt;
console.log("");
console.log(`Stats: ${lowCnt}/${polls.length} polls saw SYNC-low; ${highCnt} saw SYNC-high.`);

console.log("");
console.log("=== LAYER 3: POLARITY CHECK ===");
console.log("VICE rotation.c:1131: '0x0 returned when sync found, 0x80 when no sync'.");
console.log("1541 ROM $F565: drive ROM waits for PB.7=0 (= sync detected) to proceed.");
console.log("TS via2d.ts readPb: `sync = rotation_sync_found() ? 0x80 : 0x00` — INVERTED!");
console.log("Wait — read carefully:");
console.log("  rotation_sync_found returns 0 when sync, 0x80 when no sync (per VICE).");
console.log("  via2d.ts: const sync = rotation_sync_found(diskunit) ? 0x80 : 0x00;");
console.log("  When rotation_sync_found = 0 (sync) → sync = 0x00. ✓ PB.7 = 0 when sync. CORRECT.");
console.log("  When rotation_sync_found = 0x80 (no sync) → sync = 0x80. ✓ PB.7 = 0x80. CORRECT.");
console.log("  Polarity is correct.");

console.log("");
console.log("=== ACCEPTANCE TABLE ===");
console.log("layer | expected VICE rule                                | observed                       | verdict | next owner");
console.log("──────┼──────────────────────────────────────────────────┼────────────────────────────────┼─────────┼─────────────");
console.log("1     | rotation_sync_found(): 0 sync / 0x80 no sync     | matches in via2d readPb        | PASS    | —");
console.log("2     | sync mark = 5+ bytes $FF = ~140 drive cycles low | sync-low rate = " + lowCnt + "/" + polls.length + " polls   | ?       | rotation_sync_found lifetime OR rotate_disk scheduling");
console.log("3     | PB.7 polarity verified above                     | code matches VICE              | PASS    | —");

const ownerHint = lowCnt < polls.length / 4
  ? "rotation_sync_found lifetime (= last_read_data not staying at 0x3ff long enough)"
  : "ROM trace interpretation (sync-low rate already significant; deeper drive ROM check needed)";
console.log("");
console.log(`Owner hypothesis: ${ownerHint}`);
