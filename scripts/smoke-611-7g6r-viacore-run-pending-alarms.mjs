#!/usr/bin/env node
// Spec 611 phase 611.7g.6r — viacore run_pending_alarms at register access.
//
// VICE source: src/core/viacore.c:660-662 viacore_store head
//              + src/core/viacore.c:1068-1070 viacore_read head
//              + src/core/viacore.c:517-530 run_pending_alarms helper
// TS target:   src/runtime/headless/_quarantine_vice1541_v4/via6522.ts
//              private runPendingAlarmsAt(rclk, offset=0)
//              + needsAlarmCatchUp(reg) gate (PRB + T1CL..IER)
//              + call sites at read() / write() heads.
// Replaces:    no alarm dispatch at register-access head — alarms only
//              fired by Cpu65xxVice end-of-step drainAlarms(). T1 alarm
//              scheduled for cycle N invisible to a mid-instruction
//              register read at cycle N+1.
// write_offset: TS active owner = 0 (NOT interim). VICE write_offset=1
//               compensates VICE "clk++ before store" pattern; TS
//               Cpu65xxVice tick() places clk at register-access cycle
//               before via.write runs, so no compensation needed.
//               Helper signature still accepts `offset` for source
//               parity; 7g6r.6 proves non-zero offset is forwarded
//               to alarmContextDispatch as `clk + offset`.
//
// Contract (7g6r.1 — 7g6r.6):
//   7g6r.1 T1 alarm scheduled at rclk=N. drv.cpu.clk advanced to N+1.
//          read(VIA_IFR) at clk=N+1 → IFR_T1 set in returned byte
//          (dispatch fires BEFORE read body).
//   7g6r.2 T1 alarm pending; read(VIA_PRA) at clk=N+1 → IFR_T1
//          STAYS pending (PRA outside gated set).
//   7g6r.3 T1 alarm pending; write(VIA_T1LH, v) at clk=N+1 → alarm
//          dispatches FIRST (IFR_T1 set), THEN T1LH write proceeds
//          (T1LH write rearms — proves ordering via observable
//          state). Use IFR write to assert ordering more cleanly:
//          alarm sets IFR_T1, then store-body runs.
//   7g6r.4 Boundary: alarm at clk=N. read at clk=N → NO dispatch
//          (strict `>`). Then read at clk=N+1 → DOES dispatch.
//   7g6r.5 No alarm pending → runPendingAlarmsAt is a no-op.
//          (Inverse: ensure helper is safe.)
//   7g6r.6 Helper signature shape (Codex 17:20): runPendingAlarmsAt
//          must call alarmContextDispatch with `clk + offset`, not
//          `clk` only. Proven via custom AlarmContext spy that records
//          the cpuClk argument passed at each dispatch.
//
// Gate: runtime-proof-gate --drive1541=vice --only load-directory
import assert from 'node:assert/strict';
import {
  Via6522, IFR_T1, IFR_CA1,
  VIA_PRA, VIA_PRB, VIA_IFR, VIA_IER, VIA_T1CL, VIA_T1CH, VIA_T1LH,
} from '../dist/runtime/headless/_quarantine_vice1541_v4/via6522.js';
import { alarmContextNew } from '../dist/runtime/headless/alarm/alarm-context.js';

function makeVia({ clkPtr } = {}) {
  const backend = {
    storePa: () => {},
    storePb: () => {},
    readPa: () => 0xff,
    readPb: () => 0xff,
    setCa2: () => {},
    setCb2: () => {},
    setIrq: () => {},
    setIrqAt: () => {},
  };
  const via = new Via6522({
    backend,
    clkPtr: clkPtr ?? { value: 100 },
    clkRef: () => (clkPtr?.value ?? 100),
    alarmContext: alarmContextNew('smoke-7g6r'),
    name: 'via-smoke-7g6r',
  });
  via.reset();
  return { via, backend };
}

// Arm T1: write IER (CA1 not used here; enable T1=0x40), T1LL/T1LH.
// T1 alarm fires at rclk = (write_clk + 1) + tal per VICE semantics.
function armT1At(via, clkPtr, armClk, t1l) {
  clkPtr.value = armClk;
  via.write(VIA_IER, 0x80 | 0x40);     // enable T1 IRQ
  via.write(0x06, t1l & 0xff);          // T1LL = low
  via.write(VIA_T1CH, (t1l >> 8) & 0xff); // T1CH triggers reload + alarm
  // VICE one-shot: alarm fires at clk = armClk + t1l + 1.5? Use 7g.1's
  // schedule: t1zero = armClk + t1 (counter underflow), alarm dispatch
  // at t1zero+1. Just compute the expected fire by exposing rawIfr after
  // advancing clkPtr beyond t1zero.
  return armClk + t1l + 2;              // conservative: certainly fired by here
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.log(`[FAIL] ${name}: ${e.message}`); }
}

// ---------------- 7g6r.5 — no-op when no alarm pending --------------------
check('7g6r.5 runPendingAlarmsAt no-op when no alarm pending', () => {
  const clkPtr = { value: 500 };
  const { via } = makeVia({ clkPtr });
  // No alarm scheduled. read(VIA_IFR) (gated) → no throw, no IFR set.
  const ifrBefore = via.rawIfr;
  const v = via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T1, 0, 'no T1 IFR set');
  // v includes 0x80 IFR_ANY bit only if other IRQ pending; should be clean.
});

// ---------------- 7g6r.1 — T1 alarm visible via read(IFR) -----------------
check('7g6r.1 T1 alarm scheduled; read(VIA_IFR) at fire+1 → IFR_T1 set', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  const t1 = 10;
  const firedBy = armT1At(via, clkPtr, 100, t1);
  // Advance clkPtr to firedBy. Without 7g.6r, T1 alarm sits in alarm-
  // context, IFR_T1 still 0 in TS until next drainAlarms. With 7g.6r,
  // read(VIA_IFR) at clk >= firedBy dispatches the alarm.
  clkPtr.value = firedBy;
  const v = via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T1, IFR_T1,
    `IFR_T1 must be set after dispatch (rawIfr=0x${via.rawIfr.toString(16)})`);
  assert.equal((v & IFR_T1), IFR_T1, 'returned IFR byte must include T1');
});

// ---------------- 7g6r.2 — PRA NOT gated ----------------------------------
check('7g6r.2 read(VIA_PRA) does NOT dispatch pending T1 alarm', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  const t1 = 10;
  const firedBy = armT1At(via, clkPtr, 100, t1);
  clkPtr.value = firedBy;
  via.read(VIA_PRA);                    // PRA NOT in gated set
  assert.equal(via.rawIfr & IFR_T1, 0,
    'T1 alarm NOT dispatched via PRA read (gated set excludes PRA)');
  // Subsequent IFR read DOES dispatch.
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T1, IFR_T1,
    'IFR read dispatches the previously-pending alarm');
});

// ---------------- 7g6r.3 — ordering: dispatch BEFORE body -----------------
check('7g6r.3 write(VIA_IFR, clear T1) at fire+1 → alarm sets IFR_T1 first, then clear', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  const t1 = 10;
  const firedBy = armT1At(via, clkPtr, 100, t1);
  clkPtr.value = firedBy;
  // Pre-write: rawIfr should NOT have T1 set yet (dispatch is what sets it).
  // Write IFR with T1 bit (= clear T1). VICE order:
  //   1. run_pending_alarms → dispatch T1 alarm → ifr |= IFR_T1
  //   2. IFR write body: ifr &= ~(v & 0x7f) → clears T1
  // Final ifr should have IFR_T1 cleared.
  via.write(VIA_IFR, IFR_T1);
  assert.equal(via.rawIfr & IFR_T1, 0,
    'IFR_T1 cleared after write (dispatch set it, then write cleared it)');
  // Proof of ordering: if dispatch had NOT happened first, alarm would
  // still be pending and visible on next IFR read.
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T1, 0,
    'T1 alarm consumed (not re-pending after write)');
});

// ---------------- 7g6r.4 — strict-`>` boundary ----------------------------
check('7g6r.4 strict > boundary: equal clk no dispatch; N+1 dispatches', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  const t1 = 10;
  const firedBy = armT1At(via, clkPtr, 100, t1);
  // Step 1: set clk exactly to firedBy-1 → strict > boundary not met yet.
  clkPtr.value = firedBy - 1;
  via.read(VIA_IFR);
  // T1 may already be dispatched if firedBy-1 > pending_clk;
  // we test boundary, not exact firedBy. Use a clean re-arm with
  // explicit clk control.
  // Re-arm cleanly:
  const clk2Ptr = { value: 200 };
  const { via: v2 } = makeVia({ clkPtr: clk2Ptr });
  // Schedule alarm at known clk using armT1At; the T1 alarm pending_clk
  // = armClk + tal + 1 (per VICE T1 alarm semantics in 7g.1).
  v2.write(VIA_IER, 0x80 | 0x40);
  clk2Ptr.value = 200;
  v2.write(0x06, 10);                   // T1LL
  v2.write(VIA_T1CH, 0);                 // T1CH → reload + arm
  // Alarm pending at ~211. At clk=211, strict-`>` means: 211 > 211 = false →
  // no dispatch. At clk=212, 212 > 211 = true → dispatch.
  clk2Ptr.value = 211;
  v2.read(VIA_IFR);
  const ifr211 = v2.rawIfr & IFR_T1;
  clk2Ptr.value = 212;
  v2.read(VIA_IFR);
  const ifr212 = v2.rawIfr & IFR_T1;
  assert.equal(ifr211, 0,
    `at clk=alarm_clk: NO dispatch (rawIfr T1=${ifr211.toString(2)})`);
  assert.equal(ifr212, IFR_T1,
    `at clk=alarm_clk+1: dispatch (rawIfr T1=${ifr212.toString(2)})`);
});

// ---------------- 7g6r.6 — dispatch arg = (rclk + offset) ---------------
// Helper-level proof: invoke runPendingAlarmsAt directly with non-zero
// offset; assert alarm callback receives matching cpuClk-derived offset.
// TS `private` is compile-time only — accessible from JS smoke.
//
// Mechanism: alarmContextDispatch computes
//   callbackOffset = cpuClk - alarm.pending_clk
// Where cpuClk = (rclk + offset) per helper source-shape.
// Schedule alarm at known clk, call helper with non-zero offset,
// observe callback's offset arg.
import { alarmContextNew as ctxNew, alarmNew, alarmSet, alarmUnset }
  from '../dist/runtime/headless/alarm/alarm-context.js';

check('7g6r.6 runPendingAlarmsAt forwards (rclk + offset) to dispatch', () => {
  const ctx = ctxNew('smoke-7g6r6');
  const observed = [];
  // VICE alarm callbacks either reschedule or unset themselves to
  // avoid infinite re-dispatch. Spy unsets on first call.
  let cbAlarm;
  cbAlarm = alarmNew(ctx, 'spy-alarm', (cbOffset) => {
    observed.push(cbOffset);
    alarmUnset(cbAlarm);
  });
  // Schedule alarm at pending_clk=100.
  alarmSet(cbAlarm, 100);
  // Build a minimal Via6522 backed by this alarm-context.
  const backend = {
    storePa: () => {}, storePb: () => {},
    readPa: () => 0xff, readPb: () => 0xff,
    setCa2: () => {}, setCb2: () => {},
    setIrq: () => {}, setIrqAt: () => {},
  };
  const v = new Via6522({
    backend,
    clkPtr: { value: 0 },
    clkRef: () => 0,
    alarmContext: ctx,
    name: 'via-7g6r6',
  });
  // Invoke helper with rclk=105, offset=3 → dispatch(ctx, 108) →
  // callback offset = 108 - 100 = 8.
  v.runPendingAlarmsAt(105, 3);
  assert.equal(observed.length, 1, 'alarm dispatched exactly once');
  assert.equal(observed[0], 8,
    `callback offset must be (rclk+offset)-pending_clk = 8 (got ${observed[0]})`);

  // Schedule another alarm + dispatch with offset=0 → identity case.
  observed.length = 0;
  alarmSet(cbAlarm, 200);
  v.runPendingAlarmsAt(205, 0);
  assert.equal(observed[0], 5,
    `offset=0 → callback offset = rclk-pending = 5 (got ${observed[0]})`);
});

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
