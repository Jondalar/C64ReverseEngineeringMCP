#!/usr/bin/env node
// Spec 611 phase 611.7g.1 — VICE-canonical alarm-based T1 timer.
//
// Source ownership (Codex 12:19 + 12:25 ack):
//   VICE source: src/core/viacore.c
//                  :265-284   viacore_t1
//                  :340-362   update_via_t1_latch
//                  :741-745   store T1CL/T1LL
//                  :747-768   store T1CH
//                  :770-783   store T1LH
//                  :1306-1342 viacore_t1_zero_alarm
//                  :203-209   update_myviairq_rclk
//   TS target:   src/runtime/headless/vice1541/via6522.ts +
//                drive cpu AlarmContext wiring (via1d/via2d/drivecpu).
//
// Smokes A-F per source-ownership note (with Codex 12:25 correction
// for T1CH=$01 latch semantics: T1CH sets HIGH byte, so with low=0
// latch = $0100. For tal=1 write T1LL=$01 first, then T1CH=$00).
//
// Exit 0 = PASS, 1 = FAIL.

import { Vice1541 } from "../dist/runtime/headless/vice1541/vice1541.js";
import { alarmContextDispatch, alarmContextNextPendingClk } from
  "../dist/runtime/headless/alarm/alarm-context.js";

const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

const vice = new Vice1541();
const drv = vice.driveCpu;
const via1 = drv.via1;
const clkPtr = vice.diskunit.clkPtr;
const alarms = drv.alarms;

// Helper: advance clkPtr + dispatch any due alarms (mimic cpu loop).
function advanceTo(target) {
  while (clkPtr.value < target) {
    clkPtr.value = clkPtr.value + 1;
    // Dispatch any alarms whose deadline is now reached.
    while (clkPtr.value >= alarmContextNextPendingClk(alarms)) {
      alarmContextDispatch(alarms, clkPtr.value);
    }
  }
}

// === Smoke A — alarm fires at exact t1zero clk ===
via1.reset();
clkPtr.value = 100;
via1.write(0x06, 0x01); // T1LL = $01 → low latch
via1.write(0x05, 0x00); // T1CH = $00 → high latch = 0, tal = $0001
// Per VICE: t1zero = rclk+1+tal = 100+1+1 = 102. Alarm scheduled there.
// Callback at clk 102 sets IFR_T1 + update_myviairq_rclk(rclk+1=103).
check("(A.1) Pre-fire: IFR_T1 clear at clk=101",
  (via1.rawIfr & 0x40) === 0);
advanceTo(102);
// Alarm dispatched at clk=102. IFR_T1 should now be set.
check("(A.2) Alarm fires at clk=102 (= rclk+1+tal): IFR_T1 set",
  (via1.rawIfr & 0x40) !== 0,
  `IFR=$${via1.rawIfr.toString(16)}`);

// === Smoke B — IRQ raised at canonical clk via backend ===
via1.reset();
clkPtr.value = 200;
let lastIrqAt = null;
via1.backend.setIrq = (asserted) => { lastIrqAt = { asserted, clk: clkPtr.value }; };
const origSetIrqAt = via1.backend.setIrqAt;
via1.backend.setIrqAt = (asserted, clk) => {
  lastIrqAt = { asserted, clk: clk ?? clkPtr.value };
  if (origSetIrqAt) origSetIrqAt(asserted, clk);
};
via1.write(0x0e, 0xc0); // IER = $C0 = enable bit 6 (T1) + ENABLE bit 7
via1.write(0x06, 0x05); // T1LL = 5
via1.write(0x05, 0x00); // T1CH → tal=5, t1zero = 200+1+5 = 206
// Per VICE viacore.c:1341 update_myviairq_rclk(rclk+1) = clk 207.
advanceTo(206);
check("(B) After alarm fire: setIrqAt called with asserted=true, clk=207 (= rclk+1)",
  lastIrqAt !== null && lastIrqAt.asserted === true && lastIrqAt.clk === 207,
  `lastIrqAt=${JSON.stringify(lastIrqAt)}`);

// === Smoke C — one-shot does not re-fire ===
// Drive past t1zero. ifr stays set (until cleared). No new IRQ fires.
lastIrqAt = null;
advanceTo(500);
check("(C) One-shot: IFR_T1 stays set after t1zero (no re-fire)",
  (via1.rawIfr & 0x40) !== 0);
check("(C.1) One-shot: no NEW setIrqAt assertion after first fire",
  lastIrqAt === null,
  `lastIrqAt=${JSON.stringify(lastIrqAt)}`);

// === Smoke D — free-run re-fires at (tal+2) cadence ===
via1.reset();
clkPtr.value = 1000;
via1.write(0x0b, 0x40); // ACR = $40 = VIA_ACR_T1_FREE_RUN
via1.write(0x0e, 0xc0); // IER T1 enable
via1.write(0x06, 0x09); // T1LL = 9 → tal=9
via1.write(0x05, 0x00); // T1CH → t1zero = 1001+9 = 1010
let fires = 0;
let priorIfrT1 = (via1.rawIfr & 0x40) !== 0;
let prevAsserted = false;
via1.backend.setIrqAt = (asserted) => {
  if (asserted && !prevAsserted) fires++;
  prevAsserted = asserted;
};
advanceTo(1011); // first underflow
const firesAfterFirst = fires;
check("(D.1) Free-run first fire at clk≈1010", firesAfterFirst >= 1,
  `fires=${firesAfterFirst}`);
// Re-arm after fire by clearing IFR (T1CL read) — drive ROM does this.
via1.read(0x04); // T1CL read clears IFR_T1
prevAsserted = false;
// Next fire at t1zero+(tal+2) = 1010 + 11 = 1021. update_myviairq_rclk(rclk+1)=1022.
advanceTo(1022);
check("(D.2) Free-run re-fires at +full_cycle (tal+2=11 later)",
  fires >= 2,
  `fires=${fires} (expected ≥ 2)`);

// === Smoke E — T1LH write clears IFR_T1 (Synertek per VICE :778) ===
via1.reset();
clkPtr.value = 2000;
via1.write(0x06, 0x05); via1.write(0x05, 0x00); // arm
advanceTo(2006);
check("(E.1) IFR_T1 set after fire", (via1.rawIfr & 0x40) !== 0);
via1.write(0x07, 0xff); // T1LH — clears IFR_T1 per Synertek
check("(E.2) T1LH write clears IFR_T1", (via1.rawIfr & 0x40) === 0,
  `IFR=$${via1.rawIfr.toString(16)}`);

// === Smoke F — T1CL read clears IFR_T1 + doesn't reschedule ===
via1.reset();
clkPtr.value = 3000;
via1.write(0x06, 0x05); via1.write(0x05, 0x00); // arm
advanceTo(3006);
check("(F.1) IFR_T1 set after fire", (via1.rawIfr & 0x40) !== 0);
via1.read(0x04); // T1CL read clears IFR_T1
check("(F.2) T1CL read clears IFR_T1", (via1.rawIfr & 0x40) === 0);
// Verify no auto-re-arm (one-shot stays cleared after IFR clear).
advanceTo(3100);
check("(F.3) One-shot stays cleared after T1CL clear (no reschedule)",
  (via1.rawIfr & 0x40) === 0);

const failed = checks.filter((c) => !c.ok).length;
console.log("");
if (failed > 0) {
  console.error(`FAIL: ${failed}/${checks.length} VICE-T1-alarm contract checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${checks.length}/${checks.length} VICE-T1-alarm contract checks passed.`);
process.exit(0);
