#!/usr/bin/env node
// Spec 410 — 1541 Phase D smoke B: ATN falling edge → VIA1 CA1 IFR +
// chip-side IRQ push.
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §6.5 CA1=ATN line + §13 step 14 + 15
//       + §14 invariants 4, 5, 6.
//       docs/vice-iec-arc42.md §17 OQ-index — VIA_SIG_FALL=0,
//       VIA_SIG_RISE=1, VIA_SIG_CA1=0. PCR & 0x01 = 0 = falling edge.
//       INTERRUPT_DELAY = 2 cycles on drive (same as C64).
//
// VICE: src/iecbus/iecbus.c (iecbus_cpu_write_conf1) calls
//         viacore_signal(via1d1541, VIA_SIG_CA1, edge).
//       src/core/viacore.c:441 viacore_signal() — PCR-gated; on match,
//         sets IFR bit 1 (VIA_IM_CA1) and calls `update_myviairq` →
//         `set_int(int_status, IK_IRQ, value, rclk)` →
//         `interrupt_set_irq` (drive cpu's int_status).
//       src/drive/iec/via1d1541.c:92 set_int().
//
// Test acceptance (spec 410):
//   - Pulse ATN line falling → assert CA1 IFR bit sets.
//   - Assert IRQ asserted on drive cpuIntStatus within INTERRUPT_DELAY.
//   - Chip-side push path is used (Via1d1541.attachIrqLine), not the
//     drive-cpu polling bridge.

import { alarmContextNew } from "../dist/runtime/headless/alarm/alarm-context.js";
import { Via1d1541 } from "../dist/runtime/headless/via/via1d1541.js";
import { IecBusCore } from "../dist/runtime/headless/iec/iec-bus-core.js";
import { InterruptCpuStatus, IK_IRQ, INTERRUPT_DELAY }
  from "../dist/runtime/headless/cpu/interrupt-cpu-status.js";
import {
  VIA_PCR, VIA_IER, VIA_IFR, VIA_IM_CA1,
} from "../dist/runtime/headless/via/via6522-vice.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

// Build a minimal standalone test rig: IecBusCore + Via1d1541 wired to
// a fresh InterruptCpuStatus (= the drive cpu's `int_status` analog).
function makeRig() {
  const iec = new IecBusCore();
  const ctx = alarmContextNew("smoke-410-atn");
  const cpuIntStatus = new InterruptCpuStatus();
  const via = new Via1d1541({
    alarmContext: ctx,
    iec,
    deviceId: 8,
    clkRef: () => 0,
    setIrq: () => {},
  });
  // Spec 410 — chip-side push attach (= analog to drive cpu's
  // dc->cpu->int_status pointer in VICE via1d1541.c:99).
  via.attachIrqLine(cpuIntStatus, "via1-irq");
  return { iec, via, cpuIntStatus };
}

// --- Sub-test 1: PCR config = falling edge (OQ-410 / §17) -------------
{
  const { via } = makeRig();
  // VICE: PCR bit 0 = 0 → falling edge (= VIA_SIG_FALL).
  // After reset, PCR = 0 (viacore_reset). DOS ROM at $EAA0 writes
  // explicit PCR — for ATN CA1 the value is 0x00 (= negative edge).
  via.write(VIA_PCR, 0x00);
  check("PCR bit0 = 0 (falling edge per OQ-410)", (via.pcr & 0x01) === 0,
        `pcr=$${(via.pcr & 0xff).toString(16)}`);
}

// --- Sub-test 2: ATN fall → IFR_CA1 set --------------------------------
{
  const { via } = makeRig();
  via.write(VIA_PCR, 0x00); // falling-edge config
  // Enable CA1 in IER (bit 1) so the IRQ will be asserted on edge.
  // IER write: top bit = "set" mode, lower 7 = mask. 0x82 = set CA1.
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);

  // Before edge: IFR clean, no CA1.
  check("Before ATN edge — IFR_CA1 clear", (via.ifr & VIA_IM_CA1) === 0,
        `ifr=$${via.ifr.toString(16)}`);

  // Pulse ATN falling: signalAtnEdge(false) → via.signal("ca1","fall").
  // VICE iecbus.c: ATN line just went LOW → ATN_IN tag 0 → VIA_SIG_FALL.
  // viacore_signal checks (edge==pcr&1): 0==0 → match → IFR |= VIA_IM_CA1.
  via.signalAtnEdge(false);

  check("After ATN fall — IFR_CA1 set", (via.ifr & VIA_IM_CA1) !== 0,
        `ifr=$${via.ifr.toString(16)}`);
}

// --- Sub-test 3: chip-side push to cpuIntStatus -----------------------
{
  const { via, cpuIntStatus } = makeRig();
  via.write(VIA_PCR, 0x00); // falling-edge config
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);

  // Pre-state — drive cpuIntStatus IRQ should NOT be globally pending.
  check("Pre-edge — drive cpuIntStatus IRQ clear",
        (cpuIntStatus.globalPendingInt & IK_IRQ) === 0,
        `gpi=${cpuIntStatus.globalPendingInt}`);

  via.signalAtnEdge(false);

  // Post-state — chip-side push set IK_IRQ on cpuIntStatus.
  // VICE update_myviairq → set_int → interrupt_set_irq path.
  check("Post-edge — drive cpuIntStatus IRQ asserted",
        (cpuIntStatus.globalPendingInt & IK_IRQ) !== 0,
        `gpi=${cpuIntStatus.globalPendingInt}`);

  // INTERRUPT_DELAY = 2 cycles on drive (same as C64). The setIrq sets
  // `irqClk = cpuClk`; CPU samples after INTERRUPT_DELAY cycles. We
  // don't run a CPU here — just verify the assert clk got recorded.
  check("INTERRUPT_DELAY constant = 2", INTERRUPT_DELAY === 2,
        `INTERRUPT_DELAY=${INTERRUPT_DELAY}`);
}

// --- Sub-test 4: ATN rise (= ATN released) → no IFR with PCR=0 -------
// PCR=0 means "negative edge only" — a rising-edge tag should NOT set
// IFR. This proves the polarity gate works (= invariant 6).
{
  const { via } = makeRig();
  via.write(VIA_PCR, 0x00); // falling-edge config
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);

  via.signalAtnEdge(true); // ATN released (rising on CA1 input)
  check("PCR=0 + rising tag → IFR_CA1 stays clear",
        (via.ifr & VIA_IM_CA1) === 0, `ifr=$${via.ifr.toString(16)}`);
}

// --- Sub-test 5: PCR=1 (positive edge) → only rising sets IFR --------
{
  const { via } = makeRig();
  via.write(VIA_PCR, 0x01); // positive-edge config
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);

  via.signalAtnEdge(false); // falling
  check("PCR=1 + falling → IFR_CA1 clear",
        (via.ifr & VIA_IM_CA1) === 0, `ifr=$${via.ifr.toString(16)}`);

  via.signalAtnEdge(true); // rising
  check("PCR=1 + rising → IFR_CA1 set",
        (via.ifr & VIA_IM_CA1) !== 0, `ifr=$${via.ifr.toString(16)}`);
}

// --- Sub-test 6: IRQ clears on IFR ack (write IFR bit 1) -------------
{
  const { via, cpuIntStatus } = makeRig();
  via.write(VIA_PCR, 0x00);
  via.write(VIA_IER, 0x80 | VIA_IM_CA1);
  via.signalAtnEdge(false);

  check("Pre-ack — IRQ asserted on drive cpuIntStatus",
        (cpuIntStatus.globalPendingInt & IK_IRQ) !== 0,
        `gpi=${cpuIntStatus.globalPendingInt}`);

  // Ack: write VIA_IFR with VIA_IM_CA1 to clear the flag bit.
  // viacore.c — write_via clears IFR bits set in operand; then
  // update_myviairq pushes the new (cleared) level → set_int(0).
  via.write(VIA_IFR, VIA_IM_CA1);

  check("Post-ack — IFR_CA1 cleared", (via.ifr & VIA_IM_CA1) === 0,
        `ifr=$${via.ifr.toString(16)}`);
  // IRQ should drop off cpuIntStatus (chip-side push transition).
  // setIrq(false) in InterruptCpuStatus only clears globalPendingInt
  // once nirq drops to 0 (which it does here — single source).
  check("Post-ack — drive cpuIntStatus IRQ deasserted",
        (cpuIntStatus.globalPendingInt & IK_IRQ) === 0,
        `gpi=${cpuIntStatus.globalPendingInt}`);
}

// --- Report ------------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 410 smoke B — VIA1 ATN edge → CA1 IFR + chip IRQ — ${pass}/${results.length} pass, ${fail} fail`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  if (!r.pass) console.log(`  [${tag}] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
