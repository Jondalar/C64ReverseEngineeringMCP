#!/usr/bin/env node
// Spec 611 phase 611.7f.4 — VIA1 PB polarity contract (per Codex 06:17).
//
// Synthetic check verifying the VICE store_prb + signalCa1 polarity
// contracts independently of the LOAD"$",8 runtime gate. Catches
// future regressions in storePb / signalVia1Ca1 without needing the
// full IEC handshake.
//
// VICE source contracts:
//
// 1. via1d1541.c:212-249 store_prb:
//      *drive_data = ~byte;
//      *drive_bus  = (((drive_data) << 3) & 0x40) | ...
//    → PRB.1 = 0 ⇒ DATA released; PRB.1 = 1 ⇒ DATA pulled
//    → PRB.3 = 0 ⇒ CLK  released; PRB.3 = 1 ⇒ CLK  pulled
//    → PRB.4 = 0 ⇒ ATNA released; PRB.4 = 1 ⇒ ATNA pulled (= acked)
//
// 2. iecbus.c:247-268 write_conf1 ATN tag:
//      viacore_signal(..., iec_old_atn ? 0 : VIA_SIG_RISE)
//    → ATN released (HIGH) ⇒ signal tag 0 = VIA_SIG_FALL
//    → ATN asserted (LOW)  ⇒ signal tag 1 = VIA_SIG_RISE
//
// 3. ROM PCR=$01 ⇒ CA1 latches on tag-1 events ⇒ ATN-ASSERT latches
//    IFR_CA1. signalVia1Ca1(atnReleased=false) must produce that latch.
//
// Exit 0 = PASS, 1 = FAIL.

import { Vice1541 } from "../dist/runtime/headless/vice1541/vice1541.js";

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const vice = new Vice1541();
const drv = vice.driveCpu;
const via1 = drv.via1;
const iec = drv.iecBus;

// --- Contract 1: PB polarity ---
// Force DDRB=$1A (drive ROM init value). Write PRB values and verify
// bus.drv*Released flags match the VICE polarity.

via1.write(0x02, 0x1a); // VIA_DDRB (offset 2) = $1A

// PRB = $00 → all OUT bits = 0 → release all
via1.write(0x00, 0x00); // VIA_PRB
check("PRB=$00 → drvDataReleased=true (release)", iec.drvDataReleased === true,
  `drvDataReleased=${iec.drvDataReleased}`);
check("PRB=$00 → drvClkReleased=true (release)", iec.drvClkReleased === true,
  `drvClkReleased=${iec.drvClkReleased}`);
check("PRB=$00 → drvAtnaReleased=true (release)", iec.drvAtnaReleased === true,
  `drvAtnaReleased=${iec.drvAtnaReleased}`);

// PRB = $02 → PRB.1 = 1 → DATA pull
via1.write(0x00, 0x02);
check("PRB=$02 (bit 1) → drvDataReleased=false (pull)", iec.drvDataReleased === false);
check("PRB=$02       → drvClkReleased  =true  (release)", iec.drvClkReleased === true);
check("PRB=$02       → drvAtnaReleased =true  (release)", iec.drvAtnaReleased === true);

// PRB = $08 → PRB.3 = 1 → CLK pull
via1.write(0x00, 0x08);
check("PRB=$08 (bit 3) → drvClkReleased=false (pull)", iec.drvClkReleased === false);
check("PRB=$08       → drvDataReleased =true  (release)", iec.drvDataReleased === true);

// PRB = $10 → PRB.4 = 1 → ATNA ack/pull
via1.write(0x00, 0x10);
check("PRB=$10 (bit 4) → drvAtnaReleased=false (ack/pull)", iec.drvAtnaReleased === false);

// PRB = $1A → all three OUT bits set → all pull
via1.write(0x00, 0x1a);
check("PRB=$1A → drvDataReleased=false (pull)", iec.drvDataReleased === false);
check("PRB=$1A → drvClkReleased =false (pull)", iec.drvClkReleased === false);
check("PRB=$1A → drvAtnaReleased=false (ack/pull)", iec.drvAtnaReleased === false);

// --- Contract 2: ATN edge TAG → CA1 latch with PCR=$01 ---
// PCR=$01 → CA1 control bit = 1 → wants tag=1 (VIA_SIG_RISE).
// VICE tags: atnReleased=true → tag 0 (FALL); atnReleased=false → tag 1 (RISE).
// So with PCR=$01, ATN-ASSERT (atnReleased=false) MUST latch IFR_CA1.

via1.write(0x0c, 0x01); // VIA_PCR = $01
// Set IER to enable CA1 IRQ (bit 1 + ENABLE bit 7).
via1.write(0x0e, 0x82); // VIA_IER: bit 7=set + bit 1=CA1 enable

// Clear IFR_CA1 by reading PRA (which clears latched bits per VIA).
// Easier: read VIA1 PCR/PRA-clearing equivalent — write PCR same value again.
// We just snapshot IFR before/after.
const ifrBefore = via1.read(0x0d) & 0x02; // IFR_CA1 = bit 1

// Import edge tags
const { signalVia1Ca1 } = await import(
  "../dist/runtime/headless/vice1541/via1d.js"
);

// ATN-RELEASE (atnReleased=true) → tag 0 (FALL) → PCR wants tag 1 → NO latch.
signalVia1Ca1(via1, true);
const ifrAfterRelease = via1.read(0x0d) & 0x02;
check("PCR=$01 + signalVia1Ca1(atnReleased=true) → IFR_CA1 NOT set (tag mismatch)",
  ifrAfterRelease === 0,
  `IFR_CA1=${ifrAfterRelease}`);

// ATN-ASSERT (atnReleased=false) → tag 1 (RISE) → PCR wants tag 1 → LATCH.
signalVia1Ca1(via1, false);
const ifrAfterAssert = via1.read(0x0d) & 0x02;
check("PCR=$01 + signalVia1Ca1(atnReleased=false) → IFR_CA1 SET (tag match)",
  ifrAfterAssert !== 0,
  `IFR_CA1=${ifrAfterAssert}`);

// --- Contract 3: ATN edge TAG with PCR=$00 → opposite polarity ---
// Reset IFR via PRA read + flip PCR to $00 (CA1 wants tag 0 = FALL).
via1.read(0x01); // VIA_PRA read clears CA latched bits
via1.write(0x0c, 0x00); // PCR = $00
// Also clear IFR_CA1 by writing IFR bit (VIA: write 1 to clear)
via1.write(0x0d, 0x02);

signalVia1Ca1(via1, false); // ATN-assert → tag 1 = RISE → mismatch
const ifrPcr0Assert = via1.read(0x0d) & 0x02;
check("PCR=$00 + signalVia1Ca1(atnReleased=false) → IFR_CA1 NOT set (tag mismatch)",
  ifrPcr0Assert === 0,
  `IFR_CA1=${ifrPcr0Assert}`);

signalVia1Ca1(via1, true); // ATN-release → tag 0 = FALL → match
const ifrPcr0Release = via1.read(0x0d) & 0x02;
check("PCR=$00 + signalVia1Ca1(atnReleased=true) → IFR_CA1 SET (tag match)",
  ifrPcr0Release !== 0,
  `IFR_CA1=${ifrPcr0Release}`);

// === Summary ===
const failed = checks.filter((c) => !c.ok).length;
console.log("");
if (failed > 0) {
  console.error(`FAIL: ${failed}/${checks.length} polarity contract checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${checks.length}/${checks.length} VIA1 polarity contract checks passed.`);
process.exit(0);
