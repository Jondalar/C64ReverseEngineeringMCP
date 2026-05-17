#!/usr/bin/env node
// Spec 611 phase 611.7g.5 — viacore_store/read VIA_PRA CA2 handshake port.
//
// VICE source: src/core/viacore.c:666-683 viacore_store case VIA_PRA
//              + src/core/viacore.c:1073-1095 viacore_read case VIA_PRA
//              + macros viacore.c:106-109
//                IS_CA2_INDINPUT()   = (PCR & 0x0a) == 0x02
//                IS_CA2_HANDSHAKE()  = (PCR & 0x0c) == 0x08
//                IS_CA2_PULSE_MODE() = (PCR & 0x0e) == 0x0a
// TS target:   src/runtime/headless/vice1541/via6522.ts
//              write(VIA_PRA, v) + read(VIA_PRA) → applyPraSideEffects()
// Replaces:    hand-rolled `ifr &= ~(IFR_CA1 | IFR_CA2)` (unconditional
//              CA2 clear) + missing CA2 handshake side effects.
// Deferred:    CB2/PRB mirror; serial-iec-bus port; bridge cleanup;
//              pulse-mode "one-clock-later" timing fix.
//
// Clock-owner constraint (Codex 13:34): no Via6522.read/write API
// churn. updateIrqAtClk(undefined) falls back to polled clkPtr / getClk()
// per 7g.4 — this IS the live drive cpu.clk at register-access time
// because drivecpu.ts dispatch lifts from cpu.mem.read/write where
// cpu.clk has just been advanced.
//
// Source-order constraint (Codex 13:40 #1):
//   In viacore_store(VIA_PRA), the handshake/IFR/IRQ block runs FIRST,
//   then fall-through to PRA_NHS path writes the latch and calls
//   store_pra(byte) to drive PA output. TS write(VIA_PRA) mirrors this:
//   applyPraSideEffects() → this.pra = v → backend.storePa(driven).
//   Same order in read: side effects first, then sample PA voltage via
//   backend.readPa(). PRA.7 covers ordering observably.
//
// Contract (PRA.1 — PRA.7 + PRA_NHS guard):
//   PRA.1  PRA write: IFR_CA1 always cleared.
//   PRA.2a PCR=0x00 (NOT indinput) + IFR_CA2 set → IFR_CA2 cleared.
//   PRA.2b PCR=0x02 (IS_CA2_INDINPUT) + IFR_CA2 set → IFR_CA2 preserved.
//   PRA.2c PCR=0x02 (IS_CA2_INDINPUT) + IFR_CA2 set → PRA read also keeps it.
//   PRA.3  IS_CA2_HANDSHAKE (PCR=0x08): PRA write drives CA2 LOW
//          (one setCa2(0) call, ca2_out_state=0).
//   PRA.4  IS_CA2_PULSE_MODE (PCR=0x0a): PRA write drives CA2 LOW then
//          HIGH back-to-back (two setCa2 calls (0, 1) in order;
//          ca2_out_state ends at 1).
//   PRA.5  PRA read: same IFR + handshake semantics as write (mirror).
//   PRA.6  ier & (IM_CA1|IM_CA2) set + IFR_CA1 pre-set →
//          updateIrqAtClk fires backend.setIrqAt with polled clk
//          stamp (no clk arg path: live drive clkPtr).
//   PRA.7  Order: setCa2(0) observed BEFORE storePa(driven) for the
//          same PRA write call (CA2 edge precedes PA latch update).
//   PRAN.1 PRA_NHS write: does NOT clear IFR_CA1/CA2, does NOT
//          touch CA2 state.
//   PRAN.2 PRA_NHS read:  does NOT clear IFR_CA1/CA2, does NOT
//          touch CA2 state.
//
// Gate: runtime-proof-gate --drive1541=vice --only load-directory
import assert from 'node:assert/strict';
import {
  Via6522, IFR_CA1, IFR_CA2,
  VIA_PRA, VIA_PRA_NHS, VIA_PCR, VIA_DDRA, VIA_IER,
} from '../dist/runtime/headless/vice1541/via6522.js';
import { alarmContextNew } from '../dist/runtime/headless/alarm/alarm-context.js';

const IER_CA1 = IFR_CA1;
const IER_CA2 = IFR_CA2;

function makeVia({ clkPtr } = {}) {
  const backend = {
    storePa: () => {},
    storePb: () => {},
    readPa: () => 0xff,
    readPb: () => 0xff,
    setCa2: (s) => { backend.lastCa2 = s; backend.ca2Calls.push(s); },
    setIrq: (s) => { backend.lastIrq = s; backend.irqCalls.push({ s }); },
    setIrqAt: (s, clk) => { backend.lastIrqAt = { s, clk }; backend.irqAtCalls.push({ s, clk }); },
    ca2Calls: [],
    irqCalls: [],
    irqAtCalls: [],
  };
  const via = new Via6522({
    backend,
    clkPtr: clkPtr ?? { value: 100 },
    clkRef: () => (clkPtr?.value ?? 100),
    alarmContext: alarmContextNew('smoke-7g5'),
    name: 'via-smoke-7g5',
  });
  via.reset();
  return { via, backend };
}

// Helper: force IFR_CA1 + IFR_CA2 set independent of CA1 path so we can
// observe pure PRA clear semantics.
function presetIfr(via) {
  // Use signalCa1 to set IFR_CA1 (polarity match path).
  via.write(VIA_PCR, 0x00); // wants FALL — but caller will reset PCR after.
  via.signalCa1(0);
  // No direct way to set IFR_CA2 via public API; check rawIfr first.
  return via.rawIfr;
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.log(`[FAIL] ${name}: ${e.message}`); }
}

// ---------------- PRA.1 — IFR_CA1 always cleared on PRA write --------------
check('PRA.1 PRA write clears IFR_CA1 unconditionally', () => {
  const { via } = makeVia();
  via.write(VIA_PCR, 0x00);     // wants FALL
  via.signalCa1(0);              // → IFR_CA1 set
  assert.equal(via.rawIfr & IFR_CA1, IFR_CA1);
  via.write(VIA_DDRA, 0xff);
  via.write(VIA_PRA, 0x55);
  assert.equal(via.rawIfr & IFR_CA1, 0, 'IFR_CA1 must be cleared');
});

// ---------------- PRA.2 — IFR_CA2 conditional on IS_CA2_INDINPUT ----------
check('PRA.2a PCR=0x00 (NOT indinput) + IFR_CA2 set → PRA write clears IFR_CA2', () => {
  const { via } = makeVia();
  via.write(VIA_PCR, 0x00);
  // Direct IFR_CA2 set via public ifr field — exercises the
  // `(PCR & 0x0a) != 0x02` branch independent of CA2-input plumbing.
  via.ifr = (via.ifr | IFR_CA1 | IFR_CA2) & 0xff;
  via.write(VIA_DDRA, 0xff);
  via.write(VIA_PRA, 0x55);
  assert.equal(via.rawIfr & IFR_CA1, 0, 'IFR_CA1 cleared');
  assert.equal(via.rawIfr & IFR_CA2, 0, 'IFR_CA2 cleared (NOT indinput)');
});

check('PRA.2b PCR=0x02 (IS_CA2_INDINPUT) + IFR_CA2 set → PRA write KEEPS IFR_CA2', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x02);     // indinput
  via.ifr = (via.ifr | IFR_CA1 | IFR_CA2) & 0xff;
  via.write(VIA_DDRA, 0xff);
  backend.ca2Calls.length = 0;  // discard PCR-setup setCa2 call
  via.write(VIA_PRA, 0x55);
  assert.equal(via.rawIfr & IFR_CA1, 0, 'IFR_CA1 cleared unconditionally');
  assert.equal(via.rawIfr & IFR_CA2, IFR_CA2,
    'IFR_CA2 preserved in IS_CA2_INDINPUT mode');
  assert.equal(backend.ca2Calls.length, 0,
    'no CA2 handshake call (indinput mode)');
});

check('PRA.2c PCR=0x02 + IFR_CA2 set → PRA READ also KEEPS IFR_CA2', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x02);
  via.ifr = (via.ifr | IFR_CA1 | IFR_CA2) & 0xff;
  backend.ca2Calls.length = 0;
  via.read(VIA_PRA);
  assert.equal(via.rawIfr & IFR_CA1, 0, 'IFR_CA1 cleared on PRA read');
  assert.equal(via.rawIfr & IFR_CA2, IFR_CA2,
    'IFR_CA2 preserved on PRA read (indinput mode)');
  assert.equal(backend.ca2Calls.length, 0, 'no CA2 handshake (indinput)');
});

// ---------------- PRA.3 — IS_CA2_HANDSHAKE: CA2 → LOW --------------------
check('PRA.3 PCR=0x08 (handshake) → PRA write drives CA2 low', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x08);
  backend.ca2Calls.length = 0;
  via.write(VIA_DDRA, 0xff);
  via.write(VIA_PRA, 0x55);
  assert.deepEqual(backend.ca2Calls, [0], 'exactly one setCa2(0) call');
});

// ---------------- PRA.4 — IS_CA2_PULSE_MODE: CA2 → LOW then HIGH ----------
check('PRA.4 PCR=0x0a (pulse) → PRA write drives CA2 low then high', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x0a);
  backend.ca2Calls.length = 0;
  via.write(VIA_DDRA, 0xff);
  via.write(VIA_PRA, 0x55);
  assert.deepEqual(backend.ca2Calls, [0, 1],
    'pulse mode: setCa2(0) then setCa2(1)');
});

// ---------------- PRA.5 — PRA read mirrors store semantics ----------------
check('PRA.5 PRA read clears IFR_CA1 + drives CA2 handshake', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x08);     // handshake
  via.signalCa1(0);              // → IFR_CA1 (PCR.0=0, wants FALL)
  backend.ca2Calls.length = 0;
  // Note: signalCa1 raised CA2 via toggle-mode (7g.4) — ca2_out_state=1 now.
  via.read(VIA_PRA);
  assert.equal(via.rawIfr & IFR_CA1, 0, 'PRA read must clear IFR_CA1');
  assert.deepEqual(backend.ca2Calls, [0], 'PRA read must drive CA2 low');
});

// ---------------- PRA.6 — IRQ re-eval via polled clkPtr -------------------
check('PRA.6 ier & CA1 set + IFR_CA1 set → PRA write stamps setIrqAt(polled clk)', () => {
  const clkPtr = { value: 100 };
  const { via, backend } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IER_CA1);
  via.write(VIA_PCR, 0x00);
  // Pre-set IFR_CA1 via signalCa1 — IRQ raised already at clk=100.
  via.signalCa1(0);
  const preCount = backend.irqAtCalls.length;
  // Advance clkPtr — when PRA write clears IFR_CA1 and IRQ goes low,
  // updateIrqAtClk fires with polled clk = 250.
  clkPtr.value = 250;
  via.write(VIA_DDRA, 0xff);
  via.write(VIA_PRA, 0x55);
  const last = backend.irqAtCalls.at(-1);
  assert.ok(backend.irqAtCalls.length > preCount, 'setIrqAt must fire on edge');
  assert.equal(last.s, false, 'IRQ must transition to deasserted');
  assert.equal(last.clk, 250,
    `polled clk stamp must be 250 (got ${last.clk})`);
});

// ---------------- PRA.7 — handshake observed BEFORE PA store --------------
check('PRA.7 setCa2(0) ordered before storePa() in same PRA write', () => {
  const trace = [];
  const backend = {
    storePa: () => { trace.push('storePa'); },
    storePb: () => {},
    readPa: () => 0xff,
    readPb: () => 0xff,
    setCa2: (s) => { trace.push(`setCa2(${s})`); },
    setIrq: () => {},
    setIrqAt: () => {},
  };
  const via = new Via6522({
    backend,
    clkPtr: { value: 100 },
    clkRef: () => 100,
    alarmContext: alarmContextNew('smoke-7g5-pra7'),
    name: 'via-smoke-7g5-pra7',
  });
  via.reset();
  via.write(VIA_PCR, 0x08);     // handshake
  via.write(VIA_DDRA, 0xff);
  // Reset trace AFTER setup (DDRA + PCR writes also touch storePa/setCa2).
  trace.length = 0;
  via.write(VIA_PRA, 0x55);
  // VICE order: handshake/IFR/IRQ block first → setCa2(0) before storePa.
  const ca2Idx = trace.indexOf('setCa2(0)');
  const storeIdx = trace.indexOf('storePa');
  assert.ok(ca2Idx >= 0, 'setCa2(0) must occur');
  assert.ok(storeIdx >= 0, 'storePa must occur');
  assert.ok(ca2Idx < storeIdx,
    `setCa2(0) must come before storePa (got order: ${trace.join(', ')})`);
});

// ---------------- PRAN.1 — PRA_NHS write no side effects ------------------
check('PRAN.1 PRA_NHS write: no IFR clear, no CA2 touch', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x08);
  via.signalCa1(0);
  const ifrBefore = via.rawIfr;
  backend.ca2Calls.length = 0;
  via.write(VIA_DDRA, 0xff);
  via.write(VIA_PRA_NHS, 0x55);
  assert.equal(via.rawIfr, ifrBefore, 'IFR unchanged by PRA_NHS write');
  assert.equal(backend.ca2Calls.length, 0, 'no CA2 calls from PRA_NHS write');
});

// ---------------- PRAN.2 — PRA_NHS read no side effects -------------------
check('PRAN.2 PRA_NHS read: no IFR clear, no CA2 touch', () => {
  const { via, backend } = makeVia();
  via.write(VIA_PCR, 0x08);
  via.signalCa1(0);
  const ifrBefore = via.rawIfr;
  backend.ca2Calls.length = 0;
  via.read(VIA_PRA_NHS);
  assert.equal(via.rawIfr, ifrBefore, 'IFR unchanged by PRA_NHS read');
  assert.equal(backend.ca2Calls.length, 0, 'no CA2 calls from PRA_NHS read');
});

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
