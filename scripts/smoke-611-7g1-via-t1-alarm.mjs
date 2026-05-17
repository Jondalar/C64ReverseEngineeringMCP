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
//   TS target:   src/runtime/headless/_quarantine_vice1541_v4/via6522.ts +
//                drive cpu AlarmContext wiring (via1d/via2d/drivecpu).
//
// Smokes A-F per source-ownership note (with Codex 12:25 correction
// for T1CH=$01 latch semantics: T1CH sets HIGH byte, so with low=0
// latch = $0100. For tal=1 write T1LL=$01 first, then T1CH=$00).
//
// Exit 0 = PASS, 1 = FAIL.

import { Vice1541 } from "../dist/runtime/headless/_quarantine_vice1541_v4/vice1541.js";
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

// Helper: advance both clkPtr AND drv.cpu.clk + dispatch alarms (mimic
// cpu loop). cpu.clk must advance because the via6522 clkRef returns
// drv.cpu.clk for VICE-canonical live-clock semantics (Codex 12:37).
function advanceTo(target) {
  while (clkPtr.value < target) {
    const next = clkPtr.value + 1;
    clkPtr.value = next;
    drv.cpu.clk = next;
    while (clkPtr.value >= alarmContextNextPendingClk(alarms)) {
      alarmContextDispatch(alarms, clkPtr.value);
    }
  }
}

// === Smoke A — alarm fires at exact t1zero clk ===
via1.reset();
clkPtr.value = drv.cpu.clk =100;
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
clkPtr.value = drv.cpu.clk =200;
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
clkPtr.value = drv.cpu.clk =1000;
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
clkPtr.value = drv.cpu.clk =2000;
via1.write(0x06, 0x05); via1.write(0x05, 0x00); // arm
advanceTo(2006);
check("(E.1) IFR_T1 set after fire", (via1.rawIfr & 0x40) !== 0);
via1.write(0x07, 0xff); // T1LH — clears IFR_T1 per Synertek
check("(E.2) T1LH write clears IFR_T1", (via1.rawIfr & 0x40) === 0,
  `IFR=$${via1.rawIfr.toString(16)}`);

// === Smoke F — T1CL read clears IFR_T1 + doesn't reschedule ===
via1.reset();
clkPtr.value = drv.cpu.clk =3000;
via1.write(0x06, 0x05); via1.write(0x05, 0x00); // arm
advanceTo(3006);
check("(F.1) IFR_T1 set after fire", (via1.rawIfr & 0x40) !== 0);
via1.read(0x04); // T1CL read clears IFR_T1
check("(F.2) T1CL read clears IFR_T1", (via1.rawIfr & 0x40) === 0);
// Verify no auto-re-arm (one-shot stays cleared after IFR clear).
advanceTo(3100);
check("(F.3) One-shot stays cleared after T1CL clear (no reschedule)",
  (via1.rawIfr & 0x40) === 0);

// === Smoke G — REAL Cpu65xxVice alarm dispatch path (Codex 12:37 fix) ===
// Codex blocking issue #4: previous smokes manually advance clkPtr.value,
// bypassing Cpu65xxVice's per-cycle alarm dispatch. This smoke runs actual
// drive cpu instructions and asserts T1 IRQ fires at canonical clk via the
// real alarm-context dispatcher path.

const viceG = new Vice1541();
const drvG = viceG.driveCpu;
const via1G = drvG.via1;

// Set up a tiny RAM program: SEI (start with interrupts disabled to avoid
// drive ROM IRQ noise), loop NOP forever. Run from $0500 in drive RAM.
const ram = viceG.diskunit.drvRam;
ram[0x0500 - 0x0000] = 0x78; // SEI
ram[0x0501 - 0x0000] = 0xea; // NOP
ram[0x0502 - 0x0000] = 0xea; // NOP
ram[0x0503 - 0x0000] = 0x4c; // JMP $0501
ram[0x0504 - 0x0000] = 0x01;
ram[0x0505 - 0x0000] = 0x05;
// Point drive cpu PC to $0500.
drvG.cpu.reg_pc = 0x0500;

// Arm T1 via real VIA1 write (bypassing cpu — this is the SETUP).
// At drive clk = baseline, write T1LL=5, T1CH=0. t1zero = clk+1+5.
const armClk = drvG.cpu.clk;
via1G.write(0x06, 0x05); // T1LL = 5
via1G.write(0x05, 0x00); // T1CH = 0
const expectedT1Zero = armClk + 1 + 5;

// Spy IRQ fires (Codex 12:59 fix #1: setIrqAt not setIrq + assert
// timestamp at expectedT1Zero + 1).
let irqAssertions = []; // {asserted, clk}
const origSetAtG = via1G.backend.setIrqAt;
via1G.backend.setIrqAt = (asserted, clk) => {
  irqAssertions.push({ asserted, clk: clk ?? drvG.cpu.clk });
  return origSetAtG?.(asserted, clk);
};
// Need IER bit 6 + 7 enabled so updateIrq treats T1 IFR as
// IRQ-pending → backend.setIrqAt fires asserted=true.
via1G.write(0x0e, 0xc0);

// Drive cpu runs cycles. Cpu65xxVice's drainAlarms (line 636) fires
// any pending alarm whose deadline is reached.
const stepGoal = expectedT1Zero + 50;
let safety = 0;
while (drvG.cpu.clk < stepGoal && safety < 10000) {
  drvG.cpu.executeCycle();
  safety++;
}

check("(G.1) Real Cpu65xxVice alarm dispatch fires IFR_T1",
  (via1G.rawIfr & 0x40) !== 0,
  `IFR=$${via1G.rawIfr.toString(16)} after ${safety} cycles, cpu.clk=${drvG.cpu.clk}`);

const firstAssert = irqAssertions.find((e) => e.asserted === true);
check(`(G.2) setIrqAt(asserted=true) fired at clk=${expectedT1Zero + 1} (= t1zero+1)`,
  firstAssert !== undefined && firstAssert.clk === expectedT1Zero + 1,
  `firstAssert=${JSON.stringify(firstAssert)} expected clk=${expectedT1Zero + 1}`);

// === Smoke H — reset() unsets pending alarm (Codex 12:37 fix #3) ===
const viceH = new Vice1541();
const drvH = viceH.driveCpu;
const via1H = drvH.via1;
const clkH = viceH.diskunit.clkPtr;

clkH.value = drvH.cpu.clk; // sync
// Spy setIrqAt to catch any post-reset alarm fires.
let hAssertions = [];
const origSetAtH = via1H.backend.setIrqAt;
via1H.backend.setIrqAt = (a, c) => {
  hAssertions.push({ a, c: c ?? drvH.cpu.clk });
  return origSetAtH?.(a, c);
};
via1H.write(0x06, 0x10);
via1H.write(0x05, 0x00); // arm short T1 (tal = $0010 = 16 cycles)
const armedT1Zero = drvH.cpu.clk + 1 + 0x10;
// Reset should unset the alarm.
via1H.reset();
const hAssertionsAfterReset = hAssertions.slice();
check("(H.1) After reset, IFR_T1 clear",
  (via1H.rawIfr & 0x40) === 0);
check("(H.2) After reset, t1Latch is 0 (= reset state)",
  via1H.read(0x06) === 0 && via1H.read(0x07) === 0,
  `T1LL=$${via1H.read(0x06).toString(16)} T1LH=$${via1H.read(0x07).toString(16)}`);

// Codex 12:59 fix #2: run/dispatch past armedT1Zero + 1 and assert
// IFR_T1 stays clear AND no IRQ callback fires (= alarm was actually
// removed from queue, not just state cleared).
let safetyH = 0;
const hStepGoal = armedT1Zero + 50;
hAssertions = []; // clear; we want POST-reset assertions only
while (drvH.cpu.clk < hStepGoal && safetyH < 10000) {
  drvH.cpu.executeCycle();
  safetyH++;
}
check(`(H.3) Reset removed pending alarm: IFR_T1 stays clear after running past armedT1Zero+1 (=${armedT1Zero + 1})`,
  (via1H.rawIfr & 0x40) === 0,
  `IFR=$${via1H.rawIfr.toString(16)} cpu.clk=${drvH.cpu.clk}`);
const anyAssertedPostReset = hAssertions.some((e) => e.a === true);
check("(H.4) No setIrqAt(asserted=true) call after reset (alarm did not fire post-reset)",
  !anyAssertedPostReset,
  `hAssertions=${JSON.stringify(hAssertions)}`);

const failed = checks.filter((c) => !c.ok).length;
console.log("");
if (failed > 0) {
  console.error(`FAIL: ${failed}/${checks.length} VICE-T1-alarm contract checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${checks.length}/${checks.length} VICE-T1-alarm contract checks passed.`);
process.exit(0);
