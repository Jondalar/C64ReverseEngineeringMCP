// Spec 110 (M3.2) — VIA1 IEC contract tests.
//
// Asserts polarity, ATN edge IRQ, device-ID jumper layout, and PB
// write propagation between drive VIA1 and the IEC bus model. These
// are pure unit fixtures — no ROM, no full session.

import { Via6522, VIA_DDRB, VIA_ORB, VIA_PCR, VIA_IER, IFR_CA1 } from "./via6522.js";
import { makeBusVia1Pb, PB_DATA_OUT, PB_CLK_OUT, PB_ATN_ACK, PB_DEV_ID0, PB_DEV_ID1 } from "./via1-iec.js";
import { IecBus, CIA2_PA_ATN_OUT, CIA2_PA_CLK_OUT, CIA2_PA_DATA_OUT } from "../iec/iec-bus.js";

export interface CheckResult { label: string; pass: boolean; detail?: string }

function check(label: string, cond: boolean, detail?: string): CheckResult {
  return { label, pass: cond, ...(detail ? { detail } : {}) };
}

// --- M3.2a — polarity ---

export function runPolarityTest(): CheckResult[] {
  const bus = new IecBus();
  const via = new Via6522({ readPins: () => 0xff, onOutputChanged: () => {} }, makeBusVia1Pb(bus, 8));
  // DDRB: drive PB1 (DATA), PB3 (CLK), PB4 (ATN_ACK) as outputs.
  via.write(VIA_DDRB, PB_DATA_OUT | PB_CLK_OUT | PB_ATN_ACK);

  const out: CheckResult[] = [];

  // Pull DATA + CLK low (PB bit=1 → 7406 inverter → line low).
  via.write(VIA_ORB, PB_DATA_OUT | PB_CLK_OUT);
  out.push(check("PB1=1 pulls DATA low", bus.dataLine === false, `dataLine=${bus.dataLine}`));
  out.push(check("PB3=1 pulls CLK low",  bus.clkLine  === false, `clkLine=${bus.clkLine}`));

  // Release DATA, keep CLK pulled.
  via.write(VIA_ORB, PB_CLK_OUT);
  out.push(check("PB1=0 releases DATA",  bus.dataLine === true,  `dataLine=${bus.dataLine}`));
  out.push(check("PB3=1 keeps CLK low",  bus.clkLine  === false, `clkLine=${bus.clkLine}`));

  // Release everything.
  via.write(VIA_ORB, 0);
  out.push(check("PB=0 releases CLK",    bus.clkLine  === true,  `clkLine=${bus.clkLine}`));

  return out;
}

// --- M3.2b — ATN edge IRQ ---

export function runAtnEdgeIrqTest(): CheckResult[] {
  const bus = new IecBus();
  const via = new Via6522({ readPins: () => 0xff, onOutputChanged: () => {} }, makeBusVia1Pb(bus, 8));
  bus.attachDriveVia1(via);

  // Configure CA1 negative-edge (PCR bit 0 = 0). Default 0 already, set
  // explicitly for clarity.
  via.write(VIA_PCR, 0x00);
  // Enable CA1 IRQ: IER bit 7 = 1 enables, low bits select source.
  via.write(VIA_IER, 0x82); // enable + CA1

  const out: CheckResult[] = [];

  // Initially ATN high (released).
  out.push(check("initial ATN released", bus.atnLine === true));
  out.push(check("initial IRQ not asserted", via.irqAsserted() === false));

  // C64 pulls ATN low: write CIA2 PA with ATN bit set + DDR output.
  bus.setC64Output(CIA2_PA_ATN_OUT, CIA2_PA_ATN_OUT);
  out.push(check("ATN now pulled", bus.atnLine === false));
  out.push(check("CA1 IFR set on falling edge", (via.ifr & IFR_CA1) !== 0, `ifr=$${via.ifr.toString(16)}`));
  out.push(check("IRQ asserted", via.irqAsserted() === true));

  // Clear IRQ (read $1801 / IRA-with-handshake clears CA1 IFR per VIA spec).
  via.read(0x1); // IRA
  // After clear, IRQ should drop (since we only had CA1).
  out.push(check("IRQ drops after IFR clear", via.irqAsserted() === false, `ifr=$${via.ifr.toString(16)}`));

  // Release ATN: positive edge with negative-edge polarity should NOT
  // fire CA1 — but our model fires on either edge (Sprint 66 deviation
  // documented in via6522.ts pulseCa1). Pin this current behavior.
  bus.setC64Output(0, CIA2_PA_ATN_OUT);
  out.push(check("ATN now released", bus.atnLine === true));
  // Either-edge fire is the documented deviation; assert it.
  out.push(check("CA1 IFR re-set on rising edge (Sprint 66 either-edge deviation)", (via.ifr & IFR_CA1) !== 0));

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
  const via = new Via6522({ readPins: () => 0xff, onOutputChanged: () => {} }, makeBusVia1Pb(bus, 8));
  via.write(VIA_DDRB, PB_DATA_OUT | PB_CLK_OUT);

  const out: CheckResult[] = [];

  // Snapshot before write.
  const before = { data: bus.dataLine, clk: bus.clkLine };

  // Single PB write: pull DATA, leave CLK released.
  via.write(VIA_ORB, PB_DATA_OUT);
  // No ticks/cycles between write and observation — propagation must
  // be synchronous within the model.
  out.push(check("DATA propagated immediately after PB write", bus.dataLine === false, `before=${before.data} after=${bus.dataLine}`));
  out.push(check("CLK still released",                          bus.clkLine  === true,  `clkLine=${bus.clkLine}`));

  // Now release DATA — should also propagate immediately.
  via.write(VIA_ORB, 0);
  out.push(check("DATA released immediately after PB clear",   bus.dataLine === true,  `dataLine=${bus.dataLine}`));

  // DDR-only flip: clear DDR while OR=PB_DATA_OUT — line should release
  // (DDR=input means transistor not driven).
  via.write(VIA_ORB, PB_DATA_OUT);
  out.push(check("DDR=output + OR=1 pulls", bus.dataLine === false));
  via.write(VIA_DDRB, 0);
  out.push(check("DDR=input releases line regardless of OR", bus.dataLine === true, `dataLine=${bus.dataLine}`));

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
