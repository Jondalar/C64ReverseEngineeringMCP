// Spec 110 (M3.2) — VIA1 IEC contract tests.
//
// Asserts polarity, ATN edge IRQ, device-ID jumper layout, and PB
// write propagation between drive VIA1 and the IEC bus model. These
// are pure unit fixtures — no ROM, no full session.
//
// Sprint 113 Phase 2: migrated from legacy Via6522 + makeBusVia1Pb to
// Via1d1541 (alarm-driven VICE-faithful core). Register-offset names
// updated to VICE-style (VIA_PRB / VIA_DDRB / VIA_IER / VIA_IFR).

import { alarmContextNew } from "../alarm/alarm-context.js";
import { Via1d1541 } from "../via/via1d1541.js";
import { VIA_DDRB, VIA_PRB, VIA_PCR, VIA_IER, VIA_IFR, VIA_IM_CA1 } from "../via/via6522-vice.js";
import { IecBus, CIA2_PA_ATN_OUT, CIA2_PA_CLK_OUT, CIA2_PA_DATA_OUT } from "../iec/iec-bus.js";

// PB pin bit positions (from via1d1541.ts spec):
const PB_DATA_IN  = 1 << 0;
const PB_DATA_OUT = 1 << 1;
const PB_CLK_IN   = 1 << 2;
const PB_CLK_OUT  = 1 << 3;
const PB_ATN_ACK  = 1 << 4;
const PB_DEV_ID0  = 1 << 5;
const PB_DEV_ID1  = 1 << 6;

export interface CheckResult { label: string; pass: boolean; detail?: string }

function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

/** Build a test Via1d1541 attached to the given IecBus. */
function makeTestVia(bus: IecBus, deviceId = 8): Via1d1541 {
  const ctx = alarmContextNew("test-via1");
  let cpuClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx,
    iec: bus.core,
    deviceId,
    clkRef: () => cpuClk,
    setIrq: () => { /* sampled via irqAsserted() */ },
  });
  bus.attachDriveVia1(via);
  return via;
}

// --- M3.2a — polarity ---

export function runPolarityTest(): CheckResult[] {
  const bus = new IecBus();
  const via = makeTestVia(bus, 8);
  // DDRB: drive PB1 (DATA), PB3 (CLK), PB4 (ATN_ACK) as outputs.
  via.write(VIA_DDRB, PB_DATA_OUT | PB_CLK_OUT | PB_ATN_ACK);

  const out: CheckResult[] = [];

  // Pull DATA + CLK low (PB bit=1 → 7406 inverter → line low).
  via.write(VIA_PRB, PB_DATA_OUT | PB_CLK_OUT);
  out.push(check("PB1=1 pulls DATA low", bus.dataLine === false, `dataLine=${bus.dataLine}`));
  out.push(check("PB3=1 pulls CLK low",  bus.clkLine  === false, `clkLine=${bus.clkLine}`));

  // Release DATA, keep CLK pulled.
  via.write(VIA_PRB, PB_CLK_OUT);
  out.push(check("PB1=0 releases DATA",  bus.dataLine === true,  `dataLine=${bus.dataLine}`));
  out.push(check("PB3=1 keeps CLK low",  bus.clkLine  === false, `clkLine=${bus.clkLine}`));

  // Release everything.
  via.write(VIA_PRB, 0);
  out.push(check("PB=0 releases CLK",    bus.clkLine  === true,  `clkLine=${bus.clkLine}`));

  return out;
}

// --- M3.2b — ATN edge IRQ ---

export function runAtnEdgeIrqTest(): CheckResult[] {
  const bus = new IecBus();
  const via = makeTestVia(bus, 8);

  // Configure CA1 negative-edge (PCR bit 0 = 0). Default 0 already, set
  // explicitly for clarity. VICE: PCR CA1 = 0x01 = positive edge.
  // Drive ROM writes PCR=$01; CA1 fires on ATN going LOW → CA1 pin HIGH
  // (inverter) → rising edge. So we configure PCR=0x01 (positive edge).
  via.write(VIA_PCR, 0x01); // positive-edge CA1 = ATN assertion (line goes LOW)
  // Enable CA1 IRQ: IER bit 7 = 1 enables, bit 1 = CA1.
  via.write(VIA_IER, 0x82); // enable + CA1
  // Clear any stale IFR from the pulseCa1(false) call that attachDriveVia1
  // fires at init time (ATN released → CA1 LOW → falling edge fires IFR_CA1
  // under default PCR=0x00 negative-edge config, before ROM sets PCR=0x01).
  // Write 1 to IFR bit 1 clears it (per VIA spec).
  via.write(VIA_IFR, VIA_IM_CA1);

  const out: CheckResult[] = [];

  // Initially ATN high (released).
  out.push(check("initial ATN released", bus.atnLine === true));
  out.push(check("initial IRQ not asserted", via.irqAsserted() === false));

  // C64 pulls ATN low: write CIA2 PA with ATN bit set + DDR output.
  bus.setC64Output(CIA2_PA_ATN_OUT, CIA2_PA_ATN_OUT);
  out.push(check("ATN now pulled", bus.atnLine === false));
  // ATN goes LOW → CA1 pin (inverted) goes HIGH → rising edge → IFR_CA1
  // set (PCR=0x01 positive-edge match).
  out.push(check("CA1 IFR set on ATN assertion (rising CA1 edge)", (via.ifr & VIA_IM_CA1) !== 0, `ifr=$${via.ifr.toString(16)}`));
  out.push(check("IRQ asserted", via.irqAsserted() === true));

  // Clear IRQ (read $1801 / IRA-with-handshake clears CA1 IFR per VIA spec).
  via.read(0x1); // IRA (VIA_PRA = 1)
  // After clear, IRQ should drop (since we only had CA1).
  out.push(check("IRQ drops after IFR clear", via.irqAsserted() === false, `ifr=$${via.ifr.toString(16)}`));

  // Release ATN: ATN line goes HIGH → CA1 pin (inverted) goes LOW →
  // falling edge. PCR=0x01 (positive-edge) → does NOT fire CA1.
  bus.setC64Output(0, CIA2_PA_ATN_OUT);
  out.push(check("ATN now released", bus.atnLine === true));
  // VICE-faithful: falling CA1 edge with positive-edge PCR = NO IRQ.
  out.push(check("CA1 IFR NOT set on ATN release (positive-edge PCR = falling edge ignored)", (via.ifr & VIA_IM_CA1) === 0));

  return out;
}

// --- M3.2c — device ID jumper ---

export function runDeviceIdJumperTest(): CheckResult[] {
  const out: CheckResult[] = [];
  const cases: Array<{ id: number; expected: number }> = [
    { id: 8,  expected: 0 },
    { id: 9,  expected: PB_DEV_ID0 },
    { id: 10, expected: PB_DEV_ID1 },
    { id: 11, expected: PB_DEV_ID0 | PB_DEV_ID1 },
  ];
  for (const c of cases) {
    const bus = new IecBus();
    const bits = bus.buildDrivePbInputBits(c.id);
    const jumperBits = bits & (PB_DEV_ID0 | PB_DEV_ID1);
    out.push(check(
      `id=${c.id} → jumper bits=$${jumperBits.toString(16).padStart(2, "0")}`,
      jumperBits === c.expected,
      `expected $${c.expected.toString(16)} got $${jumperBits.toString(16)}`,
    ));
  }
  return out;
}

// --- M3.2d — PB write propagation ---

export function runPbWritePropagationTest(): CheckResult[] {
  const bus = new IecBus();
  const via = makeTestVia(bus, 8);
  // VICE-faithful: real 1541 ROM configures DDRB = 0x1a (DATA_OUT, CLK_OUT,
  // ATN_ACK as outputs — PB1, PB3, PB4). The ATN-AND-gate formula in
  // recompute_drv_bus requires ATN_ACK bit (PB4) to be in output mode for
  // DATA released state to propagate through drv_bus correctly.
  via.write(VIA_DDRB, PB_DATA_OUT | PB_CLK_OUT | PB_ATN_ACK);

  const out: CheckResult[] = [];

  // Snapshot before write.
  const before = { data: bus.dataLine, clk: bus.clkLine };

  // Single PB write: pull DATA only (leave CLK and ATN_ACK not asserted).
  via.write(VIA_PRB, PB_DATA_OUT);
  // No ticks/cycles between write and observation — propagation must
  // be synchronous within the model.
  out.push(check("DATA propagated immediately after PB write", bus.dataLine === false, `before=${before.data} after=${bus.dataLine}`));
  out.push(check("CLK still released",                          bus.clkLine  === true,  `clkLine=${bus.clkLine}`));

  // Now release DATA — should also propagate immediately.
  via.write(VIA_PRB, 0);
  out.push(check("DATA released immediately after PB clear",   bus.dataLine === true,  `dataLine=${bus.dataLine}`));

  // DDR-only flip: set DATA_OUT as output + OR=1 pulls line.
  via.write(VIA_PRB, PB_DATA_OUT);
  out.push(check("DDR=output + OR=1 pulls", bus.dataLine === false));
  // Flip ATN_ACK to input (clear from DDRB) — VICE ATN-AND-gate formula:
  // with ATN_ACK bit (PB4) now in input mode, drv_data bit 4 = 0.
  // recompute_drv_bus term2 requires both data-out (bit1) AND atn-ack (bit4)
  // in drv_data to be set for DATA to be "released" in drv_bus. So clearing
  // ATN_ACK from DDRB causes DATA to appear pulled regardless of ORB value.
  // This is the VICE ATN-AND-gate model: ATN_ACK output must be configured
  // for the DATA-released path to work correctly.
  via.write(VIA_DDRB, PB_DATA_OUT | PB_CLK_OUT); // ATN_ACK back to input
  out.push(check("ATN_ACK→input: DATA appears pulled (VICE ATN-AND-gate model)",
    bus.dataLine === false, `dataLine=${bus.dataLine}`));

  // Restore DDRB with ATN_ACK to reset for C64 cross-check.
  via.write(VIA_DDRB, PB_DATA_OUT | PB_CLK_OUT | PB_ATN_ACK);
  via.write(VIA_PRB, 0); // release all drive outputs

  // C64-side cross-check: even with drive line released, C64 alone
  // can pull (wired-AND).
  bus.setC64Output(CIA2_PA_DATA_OUT, CIA2_PA_DATA_OUT);
  out.push(check("C64 pull alone takes DATA low", bus.dataLine === false));
  // CLK only driven by C64 here.
  bus.setC64Output(CIA2_PA_DATA_OUT | CIA2_PA_CLK_OUT, CIA2_PA_DATA_OUT | CIA2_PA_CLK_OUT);
  out.push(check("C64 pull alone takes CLK low",  bus.clkLine  === false));

  return out;
}

// --- aggregate ---

export interface SummaryResult {
  total: number;
  passed: number;
  failed: number;
  details: { suite: string; results: CheckResult[] }[];
}

export function runAllVia1IecTests(): SummaryResult {
  const suites: { name: string; runner: () => CheckResult[] }[] = [
    { name: "M3.2a polarity",            runner: runPolarityTest },
    { name: "M3.2b ATN edge IRQ",        runner: runAtnEdgeIrqTest },
    { name: "M3.2c device ID jumper",    runner: runDeviceIdJumperTest },
    { name: "M3.2d PB write propagation", runner: runPbWritePropagationTest },
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
