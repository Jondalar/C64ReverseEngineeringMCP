// Spec 104 (M2.2) — CIA1/CIA2 fidelity tests.
//
// v1 covers what's implementable today:
//   M2.2a — TA + TB timer modes (Φ2 cont, one-shot, TA-underflow cascade)
//   M2.2b — TOD R/W round-trip + HR-triggered latch + alarm-vs-clock target
//   M2.2c — ICR mask write semantics + read-clears
//   M2.2e — CIA2 IEC PA bit assignments (already tested in Spec 110;
//           this file just locks the CIA-side bit layout)
//
// Deferred (gaps in docs/cia-fidelity-notes.md):
//   M2.2c 1-cycle ICR latch delay — not yet modeled
//   M2.2d Serial shift register (CNT-clocked) — stub only
//   M2.2e Multi-key keyboard matrix — covered by Sprint 79; no new fixture here
//   M2.2f CIA2 NMI integration — covered by integrated-session smoke
//   TOD ticking — needs scheduler 50/60 Hz pin source
//
// Sprint 113 Phase 2 (Spec 146): the suite now drives Cia6526Vice,
// the alarm-driven 1:1 VICE port. A small wrapper (`makeFidelityCia`)
// owns the CPU clock variable and dispatches alarms when `tick(n)` is
// called — preserving the old call-site shape (`cia.tick(N)`,
// `cia.icrFlags`, `cia.cra`) while running through the VICE-faithful
// core. The legacy field aliases on Cia6526Vice (Spec 146 compat
// surface) keep the assertions byte-identical.

import {
  Cia6526Vice,
  ICR_TA, ICR_TB, ICR_IRQ_SUMMARY, CIA_TAL, CIA_TALO, CIA_TAHI,
  CIA_TBLO, CIA_TBHI, CIA_CRA, CIA_CRB, CIA_ICR,
  CIA_TOD_10TH, CIA_TOD_SEC, CIA_TOD_MIN, CIA_TOD_HR,
  type CiaBackend,
} from "../cia/cia6526-vice.js";
import { alarmContextNew } from "../alarm/alarm-context.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }
function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

/**
 * Fidelity test wrapper: returns a Cia6526Vice with `tick(N)` patched
 * so it advances the CPU clock + dispatches alarms — preserving the
 * legacy call shape from the pre-Spec-146 suite. Each `cia.tick(N)`
 * mirrors what the real VICE CPU loop does: increment clk by N then
 * drain any alarms whose deadline ≤ clk.
 */
function makeCia(): Cia6526Vice {
  // Start clk at a non-zero baseline so CIA writes (which compute
  // rclk = clk - write_offset) don't underflow into uint32 wrap. The
  // 1:1 VICE port assumes time is monotonic and bounded; the real CPU
  // would never replay the very first cycle into a CIA write.
  const clk = { v: 1000 };
  const stub: CiaBackend = {
    storePa: () => {},
    storePb: () => {},
    readPa: () => 0xff,
    readPb: () => 0xff,
    pulsePc: () => {},
    setIntClk: () => {},
  };
  const ctx = alarmContextNew("fidelity_maincpu");
  const cia = new Cia6526Vice({
    backend: stub, alarmContext: ctx, clkPtr: () => clk.v,
    name: "FIDELITY_CIA",
  });
  cia.reset();
  // Legacy `cia.tick(n)` shape: bump clk first, then dispatch alarms.
  const realTick = cia.tick.bind(cia);
  (cia as unknown as { tick: (n: number) => void }).tick = (n: number) => {
    clk.v += Math.max(0, n | 0);
    realTick(n);
  };
  return cia;
}

// --- M2.2a — Timer A continuous mode ---
//
// Sprint 113 Phase 2 (Spec 146): the VICE-faithful core has a small
// state-machine pipeline delay (CIAT_COUNT2 → CIAT_COUNT3 → CIAT_COUNT)
// before the counter starts decrementing — the legacy `Cia6526` skipped
// this. We tick enough extra cycles to ride past the pipeline and let
// the underflow land. These adjusted budgets are still well below the
// next reload, so only ONE underflow happens.

export function runTimerAContinuousTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  // Timer A latch = 99. With VICE pipeline delay, underflow at ~clk+102.
  cia.write(CIA_TALO, 99);
  cia.write(CIA_TAHI, 0);
  // CRA bit 0 = START, bit 3 = one-shot (clear for continuous).
  cia.write(CIA_CRA, 0x01);
  // Tick a generous window; the VICE core schedules alarms only when
  // a downstream consumer (IRQ, SP, cascade) cares — with mask=0 the
  // TA alarm doesn't auto-rearm. Reading any timer/ICR register pulls
  // the IFR forward via ciaUpdateTa, which is when the flag latches.
  cia.tick(110);
  out.push(check("TA still running (continuous mode)",
    (cia.cra & 0x01) !== 0));
  // Read ICR — also forces the IFR catchup, then returns + clears flags.
  const r = cia.read(CIA_ICR);
  out.push(check("ICR read returns TA flag (mask=0 → no summary)",
    (r & ICR_TA) !== 0 && (r & ICR_IRQ_SUMMARY) === 0,
    `icr=$${r.toString(16)} mask=$${cia.icrMask.toString(16)}`));
  // After read, flags cleared.
  out.push(check("ICR read clears flags", cia.icrFlags === 0));
  return out;
}

// --- M2.2a — Timer A one-shot ---

export function runTimerAOneShotTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  cia.write(CIA_TALO, 9);
  cia.write(CIA_TAHI, 0);
  // Bit 3 set = one-shot.
  cia.write(CIA_CRA, 0x09);
  cia.tick(30); // ≫ latch+1 + pipeline delay
  // VICE-faithful: tick alone doesn't auto-rearm a non-IRQ timer alarm.
  // Force the IFR + control-register catchup via a read.
  cia.read(CIA_TAL);
  out.push(check("TA one-shot: underflowed",
    (cia.icrFlags & ICR_TA) !== 0));
  // VICE-faithful: c_cia[CIA_CRA] keeps bit 0 set; reading CRA masks it
  // off when the timer has stopped. Use the public read path.
  const craRead = cia.read(CIA_CRA);
  out.push(check("TA one-shot: START bit clear in CRA read post-underflow",
    (craRead & 0x01) === 0, `cra(read)=$${craRead.toString(16)}`));
  return out;
}

// --- M2.2a — Timer B counts TA underflows ---

export function runTimerBCascadeTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  // TA latch = 9 → underflows every 10 cycles + pipeline delay.
  cia.write(CIA_TALO, 9);
  cia.write(CIA_TAHI, 0);
  cia.write(CIA_CRA, 0x01);
  // TB latch = 4 → underflow after 5 TA-underflows ≈ 50 cycles.
  cia.write(CIA_TBLO, 4);
  cia.write(CIA_TBHI, 0);
  // CRB: START=1, bits 5-6 = 10 → count TA underflows.
  cia.write(CIA_CRB, 0x41);
  cia.tick(80);
  out.push(check("TB cascade: TA underflowed",
    (cia.icrFlags & ICR_TA) !== 0));
  out.push(check("TB cascade: TB underflowed (≥5 TA × 10 cyc)",
    (cia.icrFlags & ICR_TB) !== 0,
    `icr=$${cia.icrFlags.toString(16)}`));
  return out;
}

// --- M2.2c — ICR mask + read-clear ---

export function runIcrMaskTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  // Enable TA mask: $80 | $01.
  cia.write(CIA_ICR, 0x81);
  out.push(check("ICR write $81: TA bit set in mask",
    (cia.icrMask & 0x01) !== 0));

  // Trigger TA underflow. Pipeline delay → tick well past latch+1.
  cia.write(CIA_TALO, 1);
  cia.write(CIA_TAHI, 0);
  cia.write(CIA_CRA, 0x01);
  cia.tick(20);
  out.push(check("TA underflowed", (cia.icrFlags & ICR_TA) !== 0));
  out.push(check("IRQ asserted (mask bit set + flag set)", cia.irqAsserted() === true));

  // Read ICR → flags + summary; clears flags.
  const v = cia.read(CIA_ICR);
  out.push(check("ICR read: TA flag + summary visible",
    (v & ICR_TA) !== 0 && (v & ICR_IRQ_SUMMARY) !== 0,
    `read=$${v.toString(16)}`));
  out.push(check("after read: IRQ released", cia.irqAsserted() === false));

  // Disable mask: write $01 (no bit 7) clears bit 0.
  cia.write(CIA_ICR, 0x01);
  out.push(check("ICR write $01: TA bit cleared from mask",
    (cia.icrMask & 0x01) === 0));

  return out;
}

// --- M2.2b — TOD round-trip + HR-triggered latch ---

export function runTodRoundTripTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  // Write clock: 12:34:56.7 (BCD). VICE-faithful note: writing 0x12
  // to HR (= 12:00 PM) flips AM/PM bit 7 → stored as 0x92. Pin the
  // VICE-correct round-trip rather than the legacy zeroed-PM result.
  cia.write(CIA_TOD_HR, 0x12);
  cia.write(CIA_TOD_MIN, 0x34);
  cia.write(CIA_TOD_SEC, 0x56);
  cia.write(CIA_TOD_10TH, 0x07);
  // Read HR triggers latch.
  out.push(check("TOD HR read = 0x92 (12 PM, VICE AM/PM flip)", cia.read(CIA_TOD_HR) === 0x92));
  out.push(check("TOD MIN read (latched) = 0x34", cia.read(CIA_TOD_MIN) === 0x34));
  out.push(check("TOD SEC read (latched) = 0x56", cia.read(CIA_TOD_SEC) === 0x56));
  out.push(check("TOD 10TH read (latched) = 0x07", cia.read(CIA_TOD_10TH) === 0x07));

  // After 10ths read, latch released. Mutate clock + read MIN; should
  // see new value (no latch).
  cia.write(CIA_TOD_MIN, 0x55);
  out.push(check("after 10ths read: latch released, MIN sees new",
    cia.read(CIA_TOD_MIN) === 0x55,
    `got=$${cia.read(CIA_TOD_MIN).toString(16)}`));
  return out;
}

// --- M2.2b — TOD alarm vs clock target via CRB bit 7 ---

export function runTodAlarmTargetTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  // Clock writes (CRB bit 7 = 0).
  cia.write(CIA_CRB, 0x00);
  cia.write(CIA_TOD_HR, 0x10);
  // Switch to alarm writes. HR field = bits 0-4 + bit 7 (12h BCD + AM/PM).
  cia.write(CIA_CRB, 0x80);
  cia.write(CIA_TOD_HR, 0x05);
  // Switch back to clock. Read clock HR.
  cia.write(CIA_CRB, 0x00);
  out.push(check("clock HR = 0x10 (not 0x05 alarm)",
    cia.read(CIA_TOD_HR) === 0x10,
    `got=$${cia.read(CIA_TOD_HR).toString(16)}`));
  out.push(check("alarm HR field stored separately",
    cia.todAlarmHr === 0x05));
  return out;
}

// --- M2.2c — ICR write does not retro-trigger past flags ---

export function runIcrLatchSemanticsTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cia = makeCia();
  // Trigger TA flag without mask. Pipeline delay → tick generously,
  // then force IFR catchup via a register read (VICE pattern).
  cia.write(CIA_TALO, 1);
  cia.write(CIA_TAHI, 0);
  cia.write(CIA_CRA, 0x01);
  cia.tick(20);
  cia.read(CIA_TAL);
  out.push(check("TA flag set, mask off: IRQ not asserted",
    (cia.icrFlags & ICR_TA) !== 0 && cia.irqAsserted() === false));
  // Now enable TA mask.
  cia.write(CIA_ICR, 0x81);
  out.push(check("after mask enable: pre-existing TA flag + new mask asserts IRQ",
    cia.irqAsserted() === true));
  // v1 deviation: real CIA delays the IRQ by 1 cycle after mask
  // write (M2.2c gap). Pinned here so any change to add the latch
  // shows up as a deliberate behavior shift.
  return out;
}

// --- aggregate ---

export interface SuiteSummary {
  total: number; passed: number; failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllCiaFidelityTests(): SuiteSummary {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M2.2a Timer A continuous",   runner: runTimerAContinuousTest },
    { name: "M2.2a Timer A one-shot",     runner: runTimerAOneShotTest },
    { name: "M2.2a Timer B cascade (TA)", runner: runTimerBCascadeTest },
    { name: "M2.2c ICR mask + read-clear",runner: runIcrMaskTest },
    { name: "M2.2b TOD round-trip + latch",runner: runTodRoundTripTest },
    { name: "M2.2b TOD alarm vs clock",   runner: runTodAlarmTargetTest },
    { name: "M2.2c ICR latch semantics (v1 deviation pinned)", runner: runIcrLatchSemanticsTest },
  ];
  const details: { suite: string; results: CheckResult[] }[] = [];
  let total = 0, passed = 0, failed = 0;
  for (const s of suites) {
    const results = s.runner();
    details.push({ suite: s.name, results });
    for (const r of results) {
      total++;
      if (r.pass) passed++; else failed++;
    }
  }
  return { total, passed, failed, details };
}
