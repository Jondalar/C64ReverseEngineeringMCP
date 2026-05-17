#!/usr/bin/env node
// Spec 611 phase 611.7g.6 — viacore_store/read VIA_PRB CB2 handshake port.
//
// VICE source: src/core/viacore.c:698-715 viacore_store case VIA_PRB
//              + src/core/viacore.c:1124-1136 viacore_read case VIA_PRB
//              + macros viacore.c:111-115
//                IS_CB2_HANDSHAKE()  = (PCR & 0xc0) == 0x80
//                IS_CB2_PULSE_MODE() = (PCR & 0xe0) == 0xa0
// TS target:   src/runtime/headless/vice1541/via6522.ts
//              write(VIA_PRB) → applyPrbWriteSideEffects → latch → storePb
//              read(VIA_PRB)  → applyPrbReadSideEffects  → sample
// Replaces:    PRB write/read had NO IFR_CB1/CB2 clear, NO CB2 handshake,
//              NO IRQ re-eval at PRB access.
// Deferred:    T1_PB7 PRB-output overlay (7g.8a); viacore_set_cb1
//              shift register (7g.10); viacore_set_cb2 input edge (7g.9).
//
// Asymmetry vs PRA (must hold):
//   - PRA read fires CA2 handshake. PRB read MUST NOT fire CB2 handshake.
//
// Contract (PRB.1 — PRB.7 + read-no-handshake guard):
//   PRB.1  PRB write: IFR_CB1 always cleared.
//   PRB.2a PCR=0x00 (NOT CB2-input-indep-IRQ) + IFR_CB2 set →
//          PRB write clears IFR_CB2.
//   PRB.2b PCR=0x20 ((PCR & 0xa0) == 0x20 = CB2-input-indep-IRQ) +
//          IFR_CB2 set → PRB write KEEPS IFR_CB2.
//   PRB.2c PCR=0x20 + IFR_CB2 set → PRB READ also KEEPS IFR_CB2.
//   PRB.3  IS_CB2_HANDSHAKE (PCR=0x80): PRB write drives CB2 LOW
//          (one setCb2(0) call, cb2_out_state=0).
//   PRB.4  IS_CB2_PULSE_MODE (PCR=0xa0): PRB write drives CB2 LOW then
//          HIGH back-to-back (setCb2(0), setCb2(1); ends at 1).
//   PRB.5  PRB read: clears IFR_CB1; conditional IFR_CB2 clear; NO CB2
//          handshake (no setCb2 call).
//   PRB.6  ier & (IM_CB1|IM_CB2) set + IFR_CB1 pre-set + clk advance →
//          PRB write fires backend.setIrqAt(false, polled clk).
//   PRB.7  Order: setCb2(0) observed BEFORE storePb() in same PRB
//          write (mirrors PRA.7).
//
// Gate: runtime-proof-gate --drive1541=vice --only load-directory
import assert from 'node:assert/strict';
import {
  Via6522, IFR_CB1, IFR_CB2,
  VIA_PRB, VIA_PCR, VIA_DDRB, VIA_IER,
} from '../dist/runtime/headless/vice1541/via6522.js';
import { alarmContextNew } from '../dist/runtime/headless/alarm/alarm-context.js';

const IER_CB1 = IFR_CB1;

function makeVia({ clkPtr } = {}) {
  const backend = {
    storePa: () => {},
    storePb: () => {},
    readPa: () => 0xff,
    readPb: () => 0xff,
    setCa2: () => {},
    setCb2: (s) => { backend.lastCb2 = s; backend.cb2Calls.push(s); },
    setIrq: (s) => { backend.lastIrq = s; backend.irqCalls.push({ s }); },
    setIrqAt: (s, clk) => { backend.lastIrqAt = { s, clk }; backend.irqAtCalls.push({ s, clk }); },
    cb2Calls: [],
    irqCalls: [],
    irqAtCalls: [],
  };
  const via = new Via6522({
    backend,
    clkPtr: clkPtr ?? { value: 100 },
    clkRef: () => (clkPtr?.value ?? 100),
    alarmContext: alarmContextNew('smoke-7g6'),
    name: 'via-smoke-7g6',
  });
  via.reset();
  return { via, backend };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.log(`[FAIL] ${name}: ${e.message}`); }
}

// ---------------- PRB.1 — IFR_CB1 cleared unconditionally on PRB write ----
check('PRB.1 PRB write clears IFR_CB1 unconditionally', () => {
  const { via } = makeVia();
  via.ifr = (via.ifr | IFR_CB1) & 0xff;
  via.write(VIA_DDRB, 0xff);
  via.write(VIA_PRB, 0x55);
  assert.equal(via.rawIfr & IFR_CB1, 0);
});

// ---------------- PRB.2 — conditional IFR_CB2 clear -----------------------
check('PRB.2a PCR=0x00 + IFR_CB2 set → PRB write clears IFR_CB2', () => {
  const { via } = makeVia();
  via.write(VIA_PCR, 0x00);
  via.ifr = (via.ifr | IFR_CB1 | IFR_CB2) & 0xff;
  via.write(VIA_DDRB, 0xff);
  via.write(VIA_PRB, 0x55);
  assert.equal(via.rawIfr & IFR_CB1, 0, 'IFR_CB1 cleared');
  assert.equal(via.rawIfr & IFR_CB2, 0, 'IFR_CB2 cleared (NOT indinput)');
});

check('PRB.2b PCR=0x20 (CB2 input-indep-IRQ) + IFR_CB2 set → PRB write KEEPS IFR_CB2', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x20);
  via.ifr = (via.ifr | IFR_CB1 | IFR_CB2) & 0xff;
  via.write(VIA_DDRB, 0xff);
  backend.cb2Calls.length = 0;
  via.write(VIA_PRB, 0x55);
  assert.equal(via.rawIfr & IFR_CB1, 0, 'IFR_CB1 cleared unconditionally');
  assert.equal(via.rawIfr & IFR_CB2, IFR_CB2,
    'IFR_CB2 preserved when (PCR & 0xa0) == 0x20');
  assert.equal(backend.cb2Calls.length, 0, 'no CB2 handshake (input mode)');
});

check('PRB.2c PCR=0x20 + IFR_CB2 set → PRB READ also KEEPS IFR_CB2', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x20);
  via.ifr = (via.ifr | IFR_CB1 | IFR_CB2) & 0xff;
  backend.cb2Calls.length = 0;
  via.read(VIA_PRB);
  assert.equal(via.rawIfr & IFR_CB1, 0, 'IFR_CB1 cleared on PRB read');
  assert.equal(via.rawIfr & IFR_CB2, IFR_CB2,
    'IFR_CB2 preserved on PRB read (indinput)');
  assert.equal(backend.cb2Calls.length, 0,
    'PRB read NEVER drives CB2 (asymmetric vs PRA)');
});

// ---------------- PRB.3 — IS_CB2_HANDSHAKE: CB2 → LOW on write ------------
check('PRB.3 PCR=0x80 (handshake) → PRB write drives CB2 low', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x80);
  backend.cb2Calls.length = 0;
  via.write(VIA_DDRB, 0xff);
  via.write(VIA_PRB, 0x55);
  assert.deepEqual(backend.cb2Calls, [0], 'exactly one setCb2(0) call');
});

// ---------------- PRB.4 — IS_CB2_PULSE_MODE: LOW then HIGH ----------------
check('PRB.4 PCR=0xa0 (pulse) → PRB write drives CB2 low then high', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0xa0);
  backend.cb2Calls.length = 0;
  via.write(VIA_DDRB, 0xff);
  via.write(VIA_PRB, 0x55);
  assert.deepEqual(backend.cb2Calls, [0, 1],
    'pulse mode: setCb2(0) then setCb2(1)');
});

// ---------------- PRB.5 — PRB read: no CB2 handshake ----------------------
check('PRB.5 PCR=0x80 + PRB read → clears IFR_CB1, NO setCb2 call', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x80);             // handshake
  via.ifr = (via.ifr | IFR_CB1) & 0xff;
  backend.cb2Calls.length = 0;
  via.read(VIA_PRB);
  assert.equal(via.rawIfr & IFR_CB1, 0, 'PRB read clears IFR_CB1');
  assert.equal(backend.cb2Calls.length, 0,
    'PRB read MUST NOT call setCb2 (asymmetric vs PRA per VICE 1138-39)');
});

// ---------------- PRB.6 — IRQ re-eval via polled clkPtr -------------------
check('PRB.6 ier & CB1 + IFR_CB1 set → PRB write stamps setIrqAt(polled clk)', () => {
  const clkPtr = { value: 100 };
  const { via, backend } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IER_CB1);
  via.ifr = (via.ifr | IFR_CB1) & 0xff;
  // Manually push IRQ-out to lastIrqOut=true so PRB-write clear → edge.
  via.write(VIA_PCR, 0x00);
  // Bump lastIrqOut by re-evaluating with bit set (read of any reg uses
  // updateIrq path). Use IFR write to trigger updateIrq.
  via.write(0x0d, 0x00);   // VIA_IFR write 0 → no clear, but updateIrq
  // Simpler: trigger updateIrq by writing IER with CB1 set so any
  // currently-pending bit re-evaluates lastIrqOut.
  const preCount = backend.irqAtCalls.length;
  clkPtr.value = 250;
  via.write(VIA_DDRB, 0xff);
  via.write(VIA_PRB, 0x55);
  // Expectation: PRB write clears IFR_CB1; lastIrqOut transitions
  // true→false → setIrqAt(false, 250).
  assert.ok(backend.irqAtCalls.length > preCount,
    'setIrqAt must fire on IRQ edge');
  const last = backend.irqAtCalls.at(-1);
  assert.equal(last.s, false, 'IRQ must transition to deasserted');
  assert.equal(last.clk, 250,
    `polled clk stamp must be 250 (got ${last.clk})`);
});

// ---------------- PRB.7 — handshake observed BEFORE PB store --------------
check('PRB.7 setCb2(0) ordered before storePb() in same PRB write', () => {
  const trace = [];
  const backend = {
    storePa: () => {},
    storePb: () => { trace.push('storePb'); },
    readPa: () => 0xff,
    readPb: () => 0xff,
    setCa2: () => {},
    setCb2: (s) => { trace.push(`setCb2(${s})`); },
    setIrq: () => {},
    setIrqAt: () => {},
  };
  const via = new Via6522({
    backend,
    clkPtr: { value: 100 },
    clkRef: () => 100,
    alarmContext: alarmContextNew('smoke-7g6-prb7'),
    name: 'via-smoke-7g6-prb7',
  });
  via.reset();
  via.write(VIA_PCR, 0x80);             // handshake
  via.write(VIA_DDRB, 0xff);
  trace.length = 0;
  via.write(VIA_PRB, 0x55);
  const cb2Idx = trace.indexOf('setCb2(0)');
  const storeIdx = trace.indexOf('storePb');
  assert.ok(cb2Idx >= 0, 'setCb2(0) must occur');
  assert.ok(storeIdx >= 0, 'storePb must occur');
  assert.ok(cb2Idx < storeIdx,
    `setCb2(0) must come before storePb (got: ${trace.join(', ')})`);
});

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
