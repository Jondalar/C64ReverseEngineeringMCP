#!/usr/bin/env node
// Spec 611 phase 611.7g.7 — viacore T2 alarm + VIA_T2CL/CH source port.
//
// VICE source: src/core/viacore.c
//   - 311-331  viacore_t2 (live counter)
//   - 557-566  schedule_t2_zero_alarm
//   - 785-797  store VIA_T2LL (= addr 0x8 write = latch)
//   - 799-827  store VIA_T2CH (= addr 0x9 write = high counter + arm)
//   - 1170-1179 read VIA_T2CL/VIA_T2CH
//   - 1554-1586 viacore_t2_zero_alarm
//   - 1593-1652 viacore_t2_underflow_alarm (16-bit branch only)
//   - 367-368, 417-418 reset alarm unset
//
// Asymmetry vs T1:
//   - T1 = 16-bit direct alarm at rclk + tal + 2.
//   - T2 = LOW-byte cadence: zero alarm every 256 cycles; zero alarm
//          decrements t2ch; only sets IFR_T2 when t2ch wraps to 0xff
//          AND t2_irq_allowed; t2_irq_allowed cleared after IRQ until
//          next T2CH write.
//
// Contract (7g7.1 — 7g7.7):
//   7g7.1 write(VIA_T2CL=lo) → t2lLatch set; NO alarm scheduled;
//         IFR_T2 unchanged.
//   7g7.2 write(VIA_T2CH=hi) at rclk=R, prior t2lLatch=lo →
//         t2cl=lo, t2ch=hi, t2zero alarm pending at R+1+lo,
//         t2IrqAllowed=true, IFR_T2 cleared.
//   7g7.3 CADENCE: T2LL=5, T2CH=2 at R=100 →
//         - first zero at 106: t2ch:2→1, NO IRQ
//         - underflow at 107: t2cl=0xff, next_alarm=256, t2zero=362
//         - second zero at 362: t2ch:1→0, NO IRQ
//         - underflow at 363: next_alarm=256, t2zero=618
//         - third zero at 618: t2ch:0→0xff, IRQ, t2IrqAllowed=false
//         Advance clk past 619, read(VIA_IFR) → IFR_T2 set.
//   7g7.4 read(VIA_T2CL) at IRQ time → IFR_T2 cleared.
//   7g7.5 read(VIA_T2CH) does NOT clear IFR_T2.
//   7g7.6 reset() → both T2 alarms unset. Per VICE viacore.c:367-368
//         + 417-418 (alarm-unset only). Field defaults (t2cl/t2ch/etc.)
//         owned by slice 7g.11 (viacore_init + viacore_setup_context);
//         NOT cleared by 7g.7 reset. Smoke proves: previously-armed
//         alarm does not fire after reset (no IFR_T2 even when clk
//         advanced past former t2zero).
//   7g7.7 ONE-SHOT after IRQ: t2ch continues wrapping via further
//         zero alarms; t2IrqAllowed=false → NO further IRQ until
//         next T2CH write re-arms.
//   7g7.8 SR-T2 mode active ((ACR & 0x0c) == 0x04) before T2CH write:
//         scheduleT2ZeroAlarm refuses to arm timer-mode T2 alarm;
//         no IFR_T2 after clk advance past where alarm WOULD have
//         fired. SR-T2 branch in underflow remains unreachable.
//   7g7.9 SR free-running mode active ((ACR & 0x1c) == 0x10 =
//         VIA_ACR_SR_OUT_FREE_T2) before T2CH write: same gate;
//         no timer-mode T2 alarm; no IFR_T2 after clk advance.
//
// Gate: runtime-proof-gate --drive1541=vice --only load-directory
import assert from 'node:assert/strict';
import {
  Via6522, IFR_T2,
  VIA_T2CL, VIA_T2CH, VIA_IFR, VIA_IER, VIA_ACR,
} from '../dist/runtime/headless/vice1541/via6522.js';
import { alarmContextNew } from '../dist/runtime/headless/alarm/alarm-context.js';

function makeVia({ clkPtr } = {}) {
  const backend = {
    storePa: () => {}, storePb: () => {},
    readPa: () => 0xff, readPb: () => 0xff,
    setCa2: () => {}, setCb2: () => {},
    setIrq: () => {}, setIrqAt: () => {},
  };
  const via = new Via6522({
    backend,
    clkPtr: clkPtr ?? { value: 100 },
    clkRef: () => (clkPtr?.value ?? 100),
    alarmContext: alarmContextNew('smoke-7g7'),
    name: 'via-smoke-7g7',
  });
  via.reset();
  return { via, backend };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.log(`[FAIL] ${name}: ${e.message}`); }
}

// ---------------- 7g7.1 — T2CL write = latch only -------------------------
check('7g7.1 write(VIA_T2CL=v) sets latch only; no alarm, no IFR change', () => {
  const { via } = makeVia();
  const ifrBefore = via.rawIfr;
  via.write(VIA_T2CL, 0x42);
  assert.equal(via.rawIfr, ifrBefore, 'IFR unchanged');
  // We can't directly inspect t2lLatch (private). Indirect: write T2CH
  // and observe alarm scheduled at R+1+latch value.
});

// ---------------- 7g7.2 — T2CH write arms timer ---------------------------
check('7g7.2 write(VIA_T2CH=hi) arms; IFR_T2 cleared; irq_allowed set', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.ifr = (via.ifr | IFR_T2) & 0xff;
  via.write(VIA_T2CL, 5);              // latch
  via.write(VIA_T2CH, 2);              // arm at rclk=100; alarm at 100+1+5=106
  assert.equal(via.rawIfr & IFR_T2, 0, 'IFR_T2 cleared by T2CH write');
  // Indirect alarm-pending check: advance clk to 106, read(VIA_T2CL)
  // returns viacoreT2(106). viacoreT2 with t2zero=106, t2xx00=true,
  // t2ch=2 → t2 = (106-106) & 0xffff = 0; t2xx00 → t2 = (2<<8) | 0 = 0x200.
  // Low byte = 0x00.
  clkPtr.value = 106;
  // NOTE: 106 == t2zero. Strict-`>` boundary means alarm NOT yet dispatched.
  // viacoreT2 returns expected pre-fire counter.
  const t2cl_at_106 = via.read(VIA_T2CL);
  assert.equal(t2cl_at_106, 0, `T2CL at zero clk = 0 (got 0x${t2cl_at_106.toString(16)})`);
});

// ---------------- 7g7.3 — full cadence to first IRQ -----------------------
check('7g7.3 CADENCE: T2LL=5, T2CH=2 → IRQ at third zero (clk 618+1)', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IFR_T2);   // enable T2 IRQ
  via.write(VIA_T2CL, 5);
  via.write(VIA_T2CH, 2);
  // First zero at 106: t2ch 2→1, no IRQ.
  clkPtr.value = 107;                   // > 106 → dispatch t2_zero
  via.read(VIA_IFR);                    // catch-up dispatches alarms
  assert.equal(via.rawIfr & IFR_T2, 0,
    'after 1st zero (t2ch 2→1) IFR_T2 NOT set');
  // Underflow alarm scheduled at 107. Dispatch it.
  clkPtr.value = 108;
  via.read(VIA_IFR);
  // After underflow: t2cl=0xff, next_alarm=256, t2zero=362.
  // Second zero at 362.
  clkPtr.value = 363;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, 0,
    'after 2nd zero (t2ch 1→0) IFR_T2 NOT set');
  // Underflow at 363: next_alarm=256 (t2ch=0 != 0xff), t2zero=618.
  clkPtr.value = 364;
  via.read(VIA_IFR);
  // Third zero at 618: t2ch 0→0xff + irq_allowed → IRQ.
  clkPtr.value = 619;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, IFR_T2,
    `after 3rd zero (t2ch 0→0xff) IFR_T2 SET (rawIfr=0x${via.rawIfr.toString(16)})`);
});

// ---------------- 7g7.4 — read T2CL clears IFR_T2 -------------------------
check('7g7.4 read(VIA_T2CL) at IRQ clears IFR_T2', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IFR_T2);
  via.write(VIA_T2CL, 5);
  via.write(VIA_T2CH, 2);
  // Fast-forward to past 3rd zero.
  clkPtr.value = 700;
  via.read(VIA_IFR);                    // dispatch alarms via catch-up
  assert.equal(via.rawIfr & IFR_T2, IFR_T2, 'precondition: IFR_T2 set');
  via.read(VIA_T2CL);
  assert.equal(via.rawIfr & IFR_T2, 0, 'T2CL read cleared IFR_T2');
});

// ---------------- 7g7.5 — read T2CH does NOT clear IFR_T2 ----------------
check('7g7.5 read(VIA_T2CH) does NOT clear IFR_T2', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IFR_T2);
  via.write(VIA_T2CL, 5);
  via.write(VIA_T2CH, 2);
  clkPtr.value = 700;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, IFR_T2, 'precondition: IFR_T2 set');
  via.read(VIA_T2CH);
  assert.equal(via.rawIfr & IFR_T2, IFR_T2, 'T2CH read MUST NOT clear IFR_T2');
});

// ---------------- 7g7.6 — reset() unsets both T2 alarms -------------------
check('7g7.6 reset() unsets both T2 alarms', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_T2CL, 50);
  via.write(VIA_T2CH, 50);
  // Alarms scheduled. Reset.
  via.reset();
  // Advance clk well past where alarm would have fired. read(VIA_IFR)
  // would dispatch if alarm still pending. After reset, no dispatch
  // happens (no exception, no IFR_T2).
  clkPtr.value = 10_000;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, 0, 'no T2 IFR after reset (alarms unset)');
});

// ---------------- 7g7.7 — one-shot: no second IRQ without T2CH rewrite ---
check('7g7.7 ONE-SHOT: after IRQ, no further IRQ until next T2CH write', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IFR_T2);
  via.write(VIA_T2CL, 5);
  via.write(VIA_T2CH, 2);
  clkPtr.value = 700;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, IFR_T2, 'precondition: 1st IRQ fired');
  via.write(VIA_IFR, IFR_T2);          // clear T2 IRQ via IFR write
  assert.equal(via.rawIfr & IFR_T2, 0, 'IFR_T2 cleared via IFR write');
  // Advance further — t2ch will continue wrapping. Without re-arm,
  // t2IrqAllowed=false → no more IRQ.
  clkPtr.value = 200_000;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, 0,
    'one-shot: no further IRQ without T2CH re-write');
});

// ---------------- 7g7.8 — SR-T2 mode gate ---------------------------------
check('7g7.8 SR-T2 active (ACR=0x04) → T2CH does NOT arm timer-mode T2 alarm', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IFR_T2);
  // Enter SR-T2 mode: (ACR & 0x0c) == 0x04. Use 0x04 directly.
  via.write(VIA_ACR, 0x04);
  via.write(VIA_T2CL, 5);
  via.write(VIA_T2CH, 2);
  // Where 16-bit timer-mode alarm WOULD fire at clk 106. With SR-T2
  // gate, scheduleT2ZeroAlarm refuses to arm. Advance well past 106.
  clkPtr.value = 700;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, 0,
    `SR-T2 mode: no timer-mode T2 IRQ (rawIfr=0x${via.rawIfr.toString(16)})`);
});

// ---------------- 7g7.9 — SR free-running mode gate -----------------------
check('7g7.9 SR free-running (ACR=0x10) → T2CH does NOT arm timer-mode T2 alarm', () => {
  const clkPtr = { value: 100 };
  const { via } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IFR_T2);
  // Enter SR-FREE-RUNNING: (ACR & 0x1c) == 0x10 = VIA_ACR_SR_OUT_FREE_T2.
  via.write(VIA_ACR, 0x10);
  via.write(VIA_T2CL, 5);
  via.write(VIA_T2CH, 2);
  clkPtr.value = 700;
  via.read(VIA_IFR);
  assert.equal(via.rawIfr & IFR_T2, 0,
    `SR-FREE-RUNNING: no timer-mode T2 IRQ (rawIfr=0x${via.rawIfr.toString(16)})`);
});

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
