// Spec 064 Sprint 69 smoke — CIA1/CIA2 timer model + IRQ wiring.
//
// Tests:
// - Cia6526 timer A underflow sets ICR bit 0 + irqAsserted
// - Read of ICR clears flags + drops IRQ line
// - IntegratedSession: CIA1 timer fires regular jiffy IRQs during
//   KERNAL cold-start; jiffy clock $A0/$A1/$A2 advances within first
//   ~2M instructions
// - File-IO traps default OFF (no trap activity in default mode)
// - File-IO traps still selectable via enableKernalFileIoTraps option
//   (Sprint 67 fallback path) for sessions where real KERNAL serial
//   stalls

import { existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Cia6526, ICR_TA, CIA_CRA, CIA_TALO, CIA_TAHI, CIA_ICR } from "../dist/runtime/headless/cia/cia6526.js";

// ---- Test 1: timer A underflow sets ICR_TA + irqAsserted (when masked) ----
{
  const dummy = { readPins: () => 0xff, onOutputChanged: () => {} };
  const cia = new Cia6526(dummy, dummy);
  cia.write(CIA_TALO, 9);              // latch low
  cia.write(CIA_TAHI, 0);               // latch high (timer stopped → loads counter)
  cia.write(CIA_CRA, 0x01);             // START + continuous
  cia.tick(10);                         // underflow at cycle 10
  assert.equal(cia.icrFlags & ICR_TA, ICR_TA, "ICR_TA set after underflow");
  assert.equal(cia.irqAsserted(), false, "IRQ not asserted while ICR mask=0");
  cia.write(CIA_ICR, 0x80 | ICR_TA);    // enable mask bit 0
  assert.equal(cia.irqAsserted(), true, "IRQ asserted after enable");
  console.log("  ✓ Cia6526 timer A underflow + IRQ assert");
}

// ---- Test 2: Read of ICR clears flags + drops IRQ ----
{
  const dummy = { readPins: () => 0xff, onOutputChanged: () => {} };
  const cia = new Cia6526(dummy, dummy);
  cia.icrFlags = ICR_TA;
  cia.icrMask = ICR_TA;
  assert.equal(cia.irqAsserted(), true);
  const v = cia.read(CIA_ICR);
  assert.equal(v & 0x80, 0x80, "summary bit set");
  assert.equal(v & ICR_TA, ICR_TA, "TA flag in returned byte");
  assert.equal(cia.icrFlags, 0, "ICR flags cleared after read");
  assert.equal(cia.irqAsserted(), false, "IRQ dropped");
  console.log("  ✓ ICR read clears flags + drops IRQ line");
}

// ---- Test 3: IntegratedSession KERNAL cold-start jiffy clock ----
{
  const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
  const candidate = join(samples, "maniac_mansion_s1[activision_1987](german)(manual)(!).g64");
  if (!existsSync(candidate)) {
    console.log("  (jiffy test skipped — no sample G64)");
  } else {
    const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
    const { session } = startIntegratedSession({ diskPath: candidate });
    session.resetCold();
    session.runFor(2_000_000);
    const jiffyHi = session.c64Bus.ram[0xa0];
    const jiffyMid = session.c64Bus.ram[0xa1];
    const jiffyLo = session.c64Bus.ram[0xa2];
    const total = (jiffyHi << 16) | (jiffyMid << 8) | jiffyLo;
    assert.ok(total > 0, `jiffy clock advanced from 0; got ${total} (= $${total.toString(16)})`);
    assert.equal(session.cia1.taLatch, 17045, "CIA1 TA latch = NTSC 60Hz default (17045)");
    assert.notEqual(session.cia1.cra & 0x01, 0, "CIA1 timer A running");
    assert.notEqual(session.cia1.icrMask & ICR_TA, 0, "CIA1 timer A IRQ enabled");
    console.log(`  ✓ KERNAL jiffy clock advanced to ${total} after 2M insns; CIA1 timer A running`);
  }
}

// ---- Test 4: file-IO traps OFF by default ----
{
  const samples = "/Users/alex/Development/C64/Tools/C64ReverseEngineeringMCP/samples";
  const candidate = join(samples, "maniac_mansion_s1[activision_1987](german)(manual)(!).g64");
  if (existsSync(candidate)) {
    const { startIntegratedSession } = await import("../dist/runtime/headless/integrated-session-manager.js");
    const { session } = startIntegratedSession({ diskPath: candidate });
    assert.equal(session.enableKernalFileIoTraps, false, "default = traps off");
    const { session: trapped } = startIntegratedSession({ diskPath: candidate, enableKernalFileIoTraps: true });
    assert.equal(trapped.enableKernalFileIoTraps, true, "opt-in works");
    console.log("  ✓ File-IO traps OFF by default; opt-in via flag");
  }
}

console.log("Sprint 69 smoke (CIA1/CIA2 timer model + IRQ wiring) OK");
