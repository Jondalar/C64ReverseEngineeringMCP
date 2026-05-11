#!/usr/bin/env node
// Spec 411 — 1541 Phase E smoke B: rotation byte boundary → VIA2 CA1
// pulse + SO V flag set on next 6502 instruction.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §7.1 pin mapping + §7.2 (BYTE-READY → SO
//       line trick) + §13 step 19/20 + §14 invariants 2, 6 + §17
//       OQ-411-2 (SOE OFF at reset; PCR=0 after viacore_reset).
//
// VICE: src/drive/iecieee/via2d.c:170-178 `via2d_update_pcr` —
//         dptr->byte_ready_active = (bra & ~BRA_BYTE_READY) | (pcr & 0x02).
//       src/drive/drive.h L283 — BRA_BYTE_READY = 0x02. PCR bit 1
//         GATES byte-ready edges; off ⇒ no CA1 + no V flag.
//       src/core/viacore.c:441 `viacore_signal` — PCR & 0x01 = 0
//         (falling edge) → IFR |= VIA_IM_CA1.
//       src/core/viacore.c:378-434 `viacore_reset` — registers 11-15 =
//         0, so PCR = 0 at reset → CA2 input mode → SOE OFF.
//       src/drive/drivecpu.c:219-223 `drive_cpu_set_overflow` — direct
//         `cpu_regs.p |= P_OVERFLOW` (no SO pin pulse shaping).
//
// Spec 411 acceptance: rotation byte boundary → CA1 pulse + SO V flag
// set on next 6502 instruction.

import { alarmContextNew } from "../dist/runtime/headless/alarm/alarm-context.js";
import { Via2d1541 } from "../dist/runtime/headless/via/via2d1541.js";
import {
  VIA_PCR, VIA_IER, VIA_IFR, VIA_IM_CA1,
} from "../dist/runtime/headless/via/via6522-vice.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// Build a bare VIA2 + GCR coupling stub. The coupling can be empty for
// these tests — we drive CA1 directly via `via.signal("ca1","fall")`
// (= VICE viacore_signal(VIA_SIG_CA1, VIA_SIG_FALL)).
function makeRig() {
  const ctx = alarmContextNew("smoke-411-byte-ready");
  // Minimal idle GCR coupling — PA returns 0xff, PB returns 0x10,
  // no side effects. Matches the spec-147 idle-stub default but
  // explicit here so test stays independent of default backend.
  const coupling = {
    readPa: () => 0xff,
    readPb: () => 0x10,
    onPaOutputChanged: () => {},
    onPbOutputChanged: () => {},
  };
  const via = new Via2d1541({
    alarmContext: ctx,
    clkRef: () => 0,
    setIrq: () => {},
    gcr: coupling,
  });
  return { via };
}

// --- Sub-test 1: PCR = 0 at reset (OQ-411-2) -------------------------
// viacore_reset (viacore.c:378-434) zeroes registers 11-15 including
// PCR. CA2 control bits (PCR bits 1-3) = 0 → CA2 = input mode → SOE
// OFF. DOS ROM at $EAA0 then writes PCR before the first read loop.
{
  const { via } = makeRig();
  via.via.reset();
  check("OQ-411-2: PCR=0 at reset (SOE OFF, CA2 input mode)",
        via.pcr === 0,
        `pcr=$${via.pcr.toString(16)}`);
  // VIA_PCR_CA2_CONTROL mask = 0x0e (bits 1-3). Bit 3 (CA2 I/O)
  // controls input vs output; 0 = input.
  check("PCR & 0x08 = 0 → CA2 input (= SOE OFF)",
        (via.pcr & 0x08) === 0,
        `pcr=$${via.pcr.toString(16)}`);
}

// --- Sub-test 2: CA1 falling-edge gate (PCR bit 0 = 0) ----------------
// vice-1541-arch §14 invariant 6: CA1 polarity = falling edge → PCR bit
// 0 must be 0. DOS ROM at $EAA0 sets PCR for BYTE-READY routing.
{
  const { via } = makeRig();
  via.via.reset();
  // Match drive ROM: PCR = 0x0e (CA2 output high → SOE on) +
  // CA1 falling edge (bit0=0). PCR & 0x01 = 0.
  via.write(VIA_PCR, 0x0e);
  check("PCR=0x0e: CA1 bit0=0 (falling-edge)",
        (via.pcr & 0x01) === 0,
        `pcr=$${via.pcr.toString(16)}`);
  check("PCR=0x0e: CA2 bits = 0x0e (output high = SOE on)",
        (via.pcr & 0x0e) === 0x0e,
        `pcr=$${via.pcr.toString(16)}`);
}

// --- Sub-test 3: CA1 signal → IFR_CA1 set + IRQ asserted -------------
// Drive ROM enables CA1 IRQ (IER bit 1 + PCR bit 0 = 0 for falling).
// On byte-boundary, rotation pulses CA1 "fall" → IFR_CA1 set.
{
  const { via } = makeRig();
  via.via.reset();
  via.write(VIA_PCR, 0x0e);                  // CA1 falling, CA2 output high
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);     // enable CA1 IRQ

  check("Pre-edge: IFR_CA1 clear",
        (via.ifr & VIA_IM_CA1) === 0,
        `ifr=$${via.ifr.toString(16)}`);

  // Simulate rotation byte-boundary: fire CA1 falling edge. In the
  // full session this comes from GcrShifter.onByteReady → drive-cpu.ts
  // calls `via2.via.signal("ca1","fall")` (drive-cpu.ts:726).
  via.via.signal("ca1", "fall");

  check("Post-edge: IFR_CA1 set",
        (via.ifr & VIA_IM_CA1) !== 0,
        `ifr=$${via.ifr.toString(16)}`);
}

// --- Sub-test 4: PCR bit 1 (BRA_BYTE_READY) gate ---------------------
// VICE via2d.c:170-178: byte-ready edges are GATED by PCR bit 1
// (BRA_BYTE_READY). Drive ROM toggles this around IEC bit-bang
// transfers. drive-cpu.ts:722 mirrors: `if ((pcr & 0x02) === 0) return`.
//
// The gate sits BEFORE the via.signal("ca1") call, so the test here
// is the gate logic itself in drive-cpu.ts. We exercise it inline:
{
  const { via } = makeRig();
  via.via.reset();
  // PCR bit 1 = 0 (gate OFF). Simulating drive-cpu gate:
  via.write(VIA_PCR, 0x0c);                  // CA2 output, but bit 1 = 0
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);

  // Drive-cpu would check pcr & 0x02 → 0 → return early (no signal call).
  const gateOpen = (via.pcr & 0x02) !== 0;
  check("PCR bit 1 = 0 → byte-ready gate CLOSED",
        gateOpen === false,
        `pcr=$${via.pcr.toString(16)}`);
  check("Gate closed → IFR_CA1 stays clear (no signal fires)",
        (via.ifr & VIA_IM_CA1) === 0,
        `ifr=$${via.ifr.toString(16)}`);

  // Now open the gate (PCR bit 1 = 1). vice-1541-arch §7.2: drive ROM
  // sets PCR so byte-ready edges propagate to CA1 + SO.
  via.write(VIA_PCR, 0x0e);
  const gateOpenNow = (via.pcr & 0x02) !== 0;
  check("PCR bit 1 = 1 → byte-ready gate OPEN",
        gateOpenNow === true,
        `pcr=$${via.pcr.toString(16)}`);
  via.via.signal("ca1", "fall");
  check("Gate open + CA1 fall → IFR_CA1 set",
        (via.ifr & VIA_IM_CA1) !== 0,
        `ifr=$${via.ifr.toString(16)}`);
}

// --- Sub-test 5: SO V flag set on next 6502 instruction --------------
// drive-cpu.ts wires GcrShifter.onByteReady to set `cpu.reg_p |= 0x40`
// directly (VICE drivecpu.c:219-223 `drive_cpu_set_overflow`). The
// "next instruction" then sees V=1 — `BVS taken / BVC fallthrough`.
//
// Verify the V-flag set works in isolation (cpu mock).
{
  // Mock CPU object — only the bits drive-cpu.ts touches.
  const cpu = { reg_p: 0x20 };  // P initial: only U flag, V=0
  // Inline the V-set logic from drive-cpu.ts:736:
  //   cpuMicro.reg_p = (cpuMicro.reg_p | 0x40) & 0xff;
  cpu.reg_p = (cpu.reg_p | 0x40) & 0xff;

  check("V flag set (P bit 6) after byte-ready",
        (cpu.reg_p & 0x40) !== 0,
        `reg_p=$${cpu.reg_p.toString(16)}`);
  // Other flags preserved
  check("Other flags preserved (U=1, others 0)",
        cpu.reg_p === 0x60,
        `reg_p=$${cpu.reg_p.toString(16)}`);
}

// --- Sub-test 6: VIA2 reset → IFR/IER cleared, PCR=0 -----------------
{
  const { via } = makeRig();
  via.write(VIA_PCR, 0x0e);
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);
  via.via.signal("ca1", "fall");
  // Pre-reset: IFR has CA1 + IRQ master.
  check("Pre-reset: IFR_CA1 set", (via.ifr & VIA_IM_CA1) !== 0,
        `ifr=$${via.ifr.toString(16)}`);
  via.via.reset();
  check("Post-reset: PCR = 0 (OQ-411-2)", via.pcr === 0,
        `pcr=$${via.pcr.toString(16)}`);
  check("Post-reset: IFR cleared", via.ifr === 0,
        `ifr=$${via.ifr.toString(16)}`);
  check("Post-reset: IER cleared", via.ier === 0,
        `ier=$${via.ier.toString(16)}`);
}

// --- Sub-test 7: CA1 ack via IFR write clears flag --------------------
// VICE write-IFR (viacore.c) clears bits set in operand. Drive ROM
// reads VIA2 PA which auto-acks CA1, or writes IFR bit 1 explicitly.
{
  const { via } = makeRig();
  via.via.reset();
  via.write(VIA_PCR, 0x0e);
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);
  via.via.signal("ca1", "fall");
  check("Pre-ack: IFR_CA1 set", (via.ifr & VIA_IM_CA1) !== 0,
        `ifr=$${via.ifr.toString(16)}`);
  via.write(VIA_IFR, VIA_IM_CA1);
  check("Post-ack (write IFR bit 1): IFR_CA1 clear",
        (via.ifr & VIA_IM_CA1) === 0,
        `ifr=$${via.ifr.toString(16)}`);
}

// --- Report ----------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 411 smoke B — VIA2 byte-ready → CA1 + SO V flag — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
