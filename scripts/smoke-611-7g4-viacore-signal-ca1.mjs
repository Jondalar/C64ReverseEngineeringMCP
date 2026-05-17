#!/usr/bin/env node
// Spec 611 phase 611.7g.4 — viacore_signal SIG_CA1 verbatim port smoke.
//
// VICE source:  src/core/viacore.c:441-457 viacore_signal (CA1 path)
//               + 203-213 update_myviairq
// TS target:    src/runtime/headless/_quarantine_vice1541_v4/via6522.ts signalCa1
//               + private updateIrqAtClk(clk?)
// Replaces:     hand-rolled signalCa1 missing VICE CA2 toggle-mode
//               raise on CA1 active edge, plus undefined-clk IRQ
//               stamping fallback (updateIrqAtClk forwarded undefined
//               straight through to backend.setIrqAt).
// Deferred:     viacore read/store VIA_PRA CA2 handshake paths
//               (viacore.c:666-682 + 1073-1095) — separate source
//               ownership unit, NOT this commit.
//
// Contract set (CA1.1 — CA1.6):
//   CA1.1  Polarity mismatch leaves IFR_CA1 cleared.
//   CA1.2  Polarity match sets IFR_CA1.
//   CA1.3  Polarity match + IER_CA1 set + clk param → backend.setIrqAt(true, clk).
//   CA1.4  CA2 toggle (handshake-output) mode + ca2_out_state==0 → CA1
//          active edge raises CA2 (ca2_out_state=1, backend.setCa2(1)).
//          Pre-low is established via PCR=0x0c "manual low output" — existing
//          TS PCR-write path — to keep this unit independent of the separate
//          PRA-handshake source ownership unit (deferred).
//   CA1.5  CA2 toggle mode + ca2_out_state==1 → CA1 active edge MUST NOT
//          re-raise (no spurious setCa2(1) call).
//   CA1.6  Polled clk semantics: when clk param omitted, updateIrqAtClk
//          falls back to live clkPtr (VICE update_myviairq() = *clk_ptr).
//
// Gate: runtime-proof-gate --drive1541=vice --only load-directory
import assert from 'node:assert/strict';
import { Via6522, IFR_CA1, IFR_CA2, VIA_PRA, VIA_PCR, VIA_DDRA, VIA_IER }
  from '../dist/runtime/headless/_quarantine_vice1541_v4/via6522.js';
// IER bits mirror IFR bits in 6522.
const IER_CA1 = IFR_CA1;
import { alarmContextNew } from '../dist/runtime/headless/alarm/alarm-context.js';
const createAlarmContext = () => alarmContextNew('smoke-7g4');

function makeVia({ clkPtr, alarmContext, backendOverrides = {} } = {}) {
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
    ...backendOverrides,
  };
  const via = new Via6522({
    backend,
    clkPtr: clkPtr ?? { value: 100 },
    clkRef: () => (clkPtr?.value ?? 100),
    alarmContext: alarmContext ?? createAlarmContext(),
    name: 'via1d-smoke',
  });
  via.reset();
  return { via, backend };
}

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.log(`[FAIL] ${name}: ${e.message}`); }
}

// ---------------- CA1.1 — polarity mismatch leaves IFR cleared -------------
check('CA1.1 polarity mismatch → IFR_CA1 stays 0', () => {
  const { via } = makeVia();
  via.write(VIA_PCR, 0x01);          // PCR.0=1 → wants RISE
  via.signalCa1(0);                  // FALL → mismatch
  assert.equal(via.rawIfr & IFR_CA1, 0, 'IFR_CA1 must be 0');
});

// ---------------- CA1.2 — polarity match sets IFR_CA1 ----------------------
check('CA1.2 polarity match → IFR_CA1 set', () => {
  const { via } = makeVia();
  via.write(VIA_PCR, 0x00);          // PCR.0=0 → wants FALL
  via.signalCa1(0);                  // FALL → match
  assert.equal(via.rawIfr & IFR_CA1, IFR_CA1, 'IFR_CA1 must be set');
});

// ---------------- CA1.3 — match + IER + clk → setIrqAt(true, clk) ----------
check('CA1.3 IRQ raised at exact clk param via setIrqAt', () => {
  const clkPtr = { value: 100 };
  const { via, backend } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IER_CA1);   // enable CA1 IRQ
  via.write(VIA_PCR, 0x00);             // wants FALL
  clkPtr.value = 250;                   // clkPtr lags actual write site
  via.signalCa1(0, 257);                // explicit write-time clk
  assert.ok(backend.irqAtCalls.length >= 1, 'setIrqAt must fire');
  const last = backend.irqAtCalls.at(-1);
  assert.equal(last.s, true, 'IRQ assert state must be true');
  assert.equal(last.clk, 257, `IRQ clk stamp must be 257 (got ${last.clk})`);
});

// ---------------- CA1.4 — CA2 toggle mode auto-raise on CA1 edge -----------
check('CA1.4 toggle-mode + ca2_out_state=0 → CA1 edge raises CA2', () => {
  const { via, backend } = makeVia();
  // Establish ca2_out_state=0 via existing PCR-write "manual low output".
  via.write(VIA_PCR, 0x0c);
  assert.equal(backend.lastCa2, 0, 'PCR=0x0c must drive CA2 low');
  // Switch into handshake/toggle-output mode (PCR.CA2 = 100b = 0x08).
  // ca2_out_state stays 0 because PCR-write does not touch state for
  // non-manual modes.
  backend.ca2Calls.length = 0;
  via.write(VIA_PCR, 0x08);
  assert.equal(backend.lastCa2, 0, 'PCR switch to handshake must keep CA2 low');
  // Active CA1 edge (PCR.0=0 → wants FALL) must raise CA2.
  via.signalCa1(0);
  assert.equal(backend.lastCa2, 1, 'CA1 active edge must raise CA2');
  assert.equal(backend.ca2Calls.at(-1), 1, 'last setCa2 must be (1)');
});

// ---------------- CA1.5 — no spurious raise when already HIGH --------------
check('CA1.5 toggle-mode + ca2_out_state=1 → CA1 edge does NOT toggle', () => {
  const { via, backend } = makeVia();
  // Manual high output → ca2_out_state=1.
  via.write(VIA_PCR, 0x0e);
  assert.equal(backend.lastCa2, 1, 'PCR=0x0e must drive CA2 high');
  // Switch into handshake/toggle mode keeping state=1.
  via.write(VIA_PCR, 0x08);
  backend.ca2Calls.length = 0;
  via.signalCa1(0);                  // active edge, match
  // VICE branch: `if (IS_CA2_TOGGLE_MODE() && !ca2_out_state)` — false → no raise.
  assert.equal(backend.ca2Calls.length, 0, 'no setCa2 call expected');
  assert.equal(via.rawIfr & IFR_CA1, IFR_CA1, 'IFR_CA1 still set on match');
});

// ---------------- CA1.6 — polled clk fallback when clk omitted -------------
check('CA1.6 clk omitted → setIrqAt uses polled clkPtr', () => {
  const clkPtr = { value: 100 };
  const { via, backend } = makeVia({ clkPtr });
  via.write(VIA_IER, 0x80 | IER_CA1);
  via.write(VIA_PCR, 0x00);
  clkPtr.value = 333;
  via.signalCa1(0);                  // no explicit clk
  const last = backend.irqAtCalls.at(-1);
  assert.ok(last, 'setIrqAt must still fire when clk omitted');
  assert.equal(last.s, true);
  // updateIrqAtClk(undefined) → use polled clkPtr → 333
  assert.equal(last.clk, 333, `polled fallback clk must be 333 (got ${last.clk})`);
});

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
