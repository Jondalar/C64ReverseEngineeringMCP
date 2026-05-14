#!/usr/bin/env node
// Spec 419 — IEC Phase D smoke: ATN edge → drive VIA1 CA1 IFR +
// chip-side IRQ pushed to drive InterruptCpuStatus within
// INTERRUPT_DELAY drive cycles.
//
// Doctrine: 1:1 VICE IEC port. Validates the integrated path from
// CIA2 PA write surface (= IecBus.setC64Output) all the way through
// IecBus core ATN-edge detection, Via1d1541 CA1 signal, viacore_signal
// PCR-gated IFR set, and update_myviairq → set_int → interrupt_set_irq
// stamping the drive cpuIntStatus with `rclk = drive_clk` for the
// 2-cycle interrupt-delay model.
//
// Doc anchors:
//   docs/vice-iec-arc42.md §15 Phase D (steps 10-12)
//   docs/vice-iec-arc42.md §5.5  (viacore_signal CA1 polarity gate)
//   docs/vice-iec-arc42.md §5.6  (update_myviairq_rclk stamping)
//   docs/vice-iec-arc42.md §5.10 (interrupt_check_irq_delay semantics)
//   docs/vice-iec-arc42.md §17.4 (OQ-419-1 + OQ-419-2 resolutions)
//   docs/vice-iec-arc42.md §16   (invariants 3, 4)
//
// VICE source citations (verified 2026-05-12 against vice-3.7.1):
//   src/iecbus/iecbus.c:65        — `static uint8_t iec_old_atn = 0x10;`
//                                    (= file-scope single static, OQ-419-1)
//   src/iecbus/iecbus.c:208       — iecbus_cpu_undump re-seeds iec_old_atn
//   src/iecbus/iecbus.c:247-268   — write_conf1 ATN edge compare +
//                                    viacore_signal(via1d1541, VIA_SIG_CA1,
//                                                   iec_old_atn ? 0 : VIA_SIG_RISE)
//   src/via.h:134                 — `#define VIA_SIG_CA1  0`
//   src/via.h:139                 — `#define VIA_SIG_FALL 0`
//   src/via.h:140                 — `#define VIA_SIG_RISE 1`     (OQ-419-2)
//   src/core/viacore.c:441-461    — viacore_signal CA1 case:
//                                    `if ((edge ? 1 : 0) ==
//                                          (PCR & VIA_PCR_CA1_CONTROL)) {
//                                       ifr |= VIA_IM_CA1;
//                                       update_myviairq(...)
//                                     }`
//   src/core/viacore.c:203-208    — `inline static void
//                                     update_myviairq_rclk(via, rclk)`
//   src/core/viacore.c:210-213    — `update_myviairq` ⇒
//                                    `update_myviairq_rclk(via, *clk_ptr)`
//   src/drive/iec/via1d1541.c:92  — `set_int()` →
//                                    `interrupt_set_irq(dc->cpu->int_status,
//                                                       int_num, value, rclk)`
//   src/interrupt.h:39            — `#define INTERRUPT_DELAY 2`
//
// PA polarity convention (verified 2026-05-12 against iec-bus.ts +
// smoke-417 sub-test 5): IecBus.setC64Output expects raw CIA2 PA byte;
// it applies `tmp = ~byte` per c64cia2.c:150. Net effect on the line:
//   raw PA bit 3 = 1  ⇒ ATN line LOW  (= asserted, cpu_bus & 0x10 = 0)
//   raw PA bit 3 = 0  ⇒ ATN line HIGH (= released, cpu_bus & 0x10 = 0x10)
//
// DOS 1541 ROM PCR convention (verified 2026-05-12 by inspecting
// resources/roms/dos1541-325302-01+901229-05.bin):
//   $EB2F: LDA #$01 / STA $180C  → PCR = $01 (positive CA1 edge,
//   IFR_CA1 fires on CA1 input rise = ATN line LOW = ATN ASSERTED).
//   The CA1 input pin is the inverted ATN line (7406 inverter), so
//   ATN H→L on the bus presents as L→H on CA1 = positive edge.
//
// Test acceptance per spec 419:
//   1. iec_old_atn state machine (init = 0x10; flips on actual edge;
//      no flip on redundant same-state write).
//   2. ATN assert via CIA2 PA write surface ⇒ drive VIA1 CA1 IFR set
//      + IRQ asserted on drive cpuIntStatus.
//   3. irqClk stamped at the drive clock supplied via
//      IecBus.driveClockSource (= §15 step 12 + §5.6 + §5.10).
//   4. checkIrqDelay returns true after >= INTERRUPT_DELAY drive
//      cycles past the IRQ stamp clock (= §5.10).
//   5. PCR polarity gate works for both PCR=0 (= negative edge) and
//      PCR=$01 (= DOS 1541 positive edge).
//   6. Redundant same-state PA write ⇒ no signal (= edge-only).

import { IecBus } from "../dist/runtime/headless/iec/iec-bus.js";
import { Via1d1541 } from "../dist/runtime/headless/via/via1d1541.js";
import { alarm_context_new } from "../dist/runtime/headless/alarm/alarm-context.js";
import {
  InterruptCpuStatus, IK_IRQ, INTERRUPT_DELAY,
} from "../dist/runtime/headless/cpu/interrupt-cpu-status.js";
import {
  VIA_PCR, VIA_IER, VIA_IFR, VIA_IM_CA1,
} from "../dist/runtime/headless/via/via6522-vice.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}
const hex = (v, w = 2) => "$" + (v & 0xff).toString(16).padStart(w, "0");

// CIA2 PA bit assignments (cf. iec-bus.ts).
const CIA2_PA_ATN_OUT  = 1 << 3;

// PA convention: bit set ⇒ line asserted (after C64 driver inversion).
// All bits clear (= 0x00) ⇒ all lines released ⇒ cpu_bus = 0xd0
// (DATA|CLK|ATN released bits set).
const PA_ALL_RELEASED = 0x00;
const PA_ATN_ASSERTED = CIA2_PA_ATN_OUT;       // = 0x08

// Build an integrated rig: IecBus + Via1d1541 attached + drive
// InterruptCpuStatus (= drive 6502 `int_status` analog). We model the
// drive clock with a mutable counter driven by the test (= `*clk_ptr`).
//
// Important: `attachDriveVia1` fires an init `pulseCa1(!atnLine)` which
// can transition the via's `_lastCa1` from its constructor default
// (`true`) to `false` (because atnLine starts released ⇒ CA1 input
// LOW). With default VIA_PCR = 0 (negative edge), this counts as a
// matching fall ⇒ IFR_CA1 set during attach. The rig clears the IFR
// after configuring PCR + IER so each sub-test starts from a clean
// baseline.
function makeRig({ pcr = 0x01, enableIer = true } = {}) {
  const iec = new IecBus();
  const ctx = alarm_context_new("smoke-419-atn");
  const cpuIntStatus = new InterruptCpuStatus();
  // Stub opcode-info getter so checkIrqDelay's DELAYS / ENABLES paths
  // don't touch undefined.
  cpuIntStatus.lastOpcodeInfoGetter = () => 0;
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx,
    iec: iec.core,
    deviceId: 8,
    clkRef: () => driveClk,
    setIrq: () => {},
  });
  via.attachIrqLine(cpuIntStatus, "via1-irq");
  iec.attachDriveVia1(via);
  // Spec 141 v2: drive clock source for ATN-edge IRQ stamping.
  iec.driveClockSource = () => driveClk;

  // Configure PCR + IER, then ack any residual IFR_CA1 set by the
  // attach-time pulseCa1(!atnLine) sync call.
  via.write(VIA_PCR, pcr & 0xff);
  if (enableIer) via.write(VIA_IER, 0x80 | VIA_IM_CA1);
  // Ack residual: writing IFR with the bit clears it; updateIrq then
  // pushes the deassert into cpuIntStatus.
  via.write(VIA_IFR, VIA_IM_CA1);
  // Belt-and-suspenders: re-seed irqClk + counters.
  cpuIntStatus.irqDelayCycles = 0;

  return {
    iec, via, cpuIntStatus,
    setDriveClk: (v) => { driveClk = v >>> 0; },
    getDriveClk: () => driveClk,
  };
}

// ---------- Sub-test 1: iec_old_atn init + edge state machine -----------
// VICE: src/iecbus/iecbus.c:65 — `static uint8_t iec_old_atn = 0x10;`
// (= ATN released). Doc §17.4 OQ-419-1. The IecBusCore mirrors this
// (iec-bus-core.ts:43 `public iec_old_atn = 0x10;`).
{
  const { iec } = makeRig();
  // Note: ack inside makeRig() did NOT call setC64Output; the only
  // possible mutation of iec_old_atn before sub-tests is the constructor
  // chain. cpu_bus init = 0xff ⇒ iec_old_atn init via core ctor = 0x10.
  check(
    "iec_old_atn init = 0x10 (= ATN released, post-attach)",
    iec.core.iec_old_atn === 0x10,
    `got ${hex(iec.core.iec_old_atn)}`,
  );
  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 100);
  check(
    "after PA=ATN-asserted (PA bit 3=1): iec_old_atn = 0",
    iec.core.iec_old_atn === 0,
    `got ${hex(iec.core.iec_old_atn)}`,
  );
  iec.setC64Output(PA_ALL_RELEASED, 0x3f, 200);
  check(
    "after PA=ATN-released (PA bit 3=0): iec_old_atn = 0x10",
    iec.core.iec_old_atn === 0x10,
    `got ${hex(iec.core.iec_old_atn)}`,
  );
}

// ---------- Sub-test 2: ATN edge → drive VIA1 CA1 IFR (DOS PCR=$01) -----
// VICE DOS 1541 ROM at $EB2F: `LDA #$01 / STA $180C` (= PCR := $01,
// positive CA1 edge, fires on CA1 input rise = ATN LOW = asserted).
// Verified by inspecting the vendored ROM 2026-05-12 (only `STA $180C`
// site; preceding `LDA #$01`).
//
// VICE viacore_signal: `if ((edge ? 1 : 0) == (PCR & 0x01))` matches
// `edge==1` when `PCR&1==1` ⇒ fires on rising CA1 edge.
//
// In TS: IecBus.setC64Output → core.c64_store_dd00 → onAtnEdge(atnHigh)
// → driveVia1.pulseCa1(!atnHigh). pulseCa1 tracks `_lastCa1` and fires
// `via.signal("ca1", "rise"|"fall")`. CA1 input pin sees INVERTED ATN
// (7406 inverter), so ATN line LOW ⇒ CA1 HIGH ⇒ rise ⇒ PCR=$01 match.
{
  const { iec, via, cpuIntStatus } = makeRig({ pcr: 0x01 });

  check(
    "Pre-edge: VIA1 IFR_CA1 clear (rig acked attach-time edge)",
    (via.ifr & VIA_IM_CA1) === 0,
    `ifr=${hex(via.ifr)}`,
  );
  check(
    "Pre-edge: drive cpuIntStatus IRQ clear",
    (cpuIntStatus.globalPendingInt & IK_IRQ) === 0,
    `gpi=${cpuIntStatus.globalPendingInt}`,
  );

  // Pulse ATN low via the CIA2 PA write surface. Effective clock 4242
  // (= maincpu_clk + !write_offset analog from c64cia2.c:162).
  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 4242);

  check(
    "Post ATN-assert: VIA1 IFR_CA1 set",
    (via.ifr & VIA_IM_CA1) !== 0,
    `ifr=${hex(via.ifr)}`,
  );
  check(
    "Post ATN-assert: drive cpuIntStatus IRQ asserted",
    (cpuIntStatus.globalPendingInt & IK_IRQ) !== 0,
    `gpi=${cpuIntStatus.globalPendingInt}`,
  );
}

// ---------- Sub-test 3: rclk stamping (= §15 step 12, §5.6) -------------
// VICE: viacore_signal → update_myviairq → update_myviairq_rclk(via,
// *clk_ptr) → set_int(via, num, value, rclk). The drive clock at the
// moment of the IFR set is captured into `irqClk` on the drive
// InterruptCpuStatus and used by checkIrqDelay's `>= +INTERRUPT_DELAY`
// gate (= §5.10).
{
  const STAMP = 1000;
  const rig = makeRig({ pcr: 0x01 });
  const { iec, cpuIntStatus, setDriveClk, getDriveClk } = rig;
  setDriveClk(STAMP);

  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, STAMP);

  check(
    "irqClk stamped at drive clock = STAMP",
    cpuIntStatus.irqClk === STAMP,
    `irqClk=${cpuIntStatus.irqClk} expected=${STAMP}`,
  );

  // §5.10: checkIrqDelay returns true once `irqDelayCycles >=
  // INTERRUPT_DELAY`. bumpDelays increments the counter for every
  // cycle where `irqClk <= cpuClk`. Simulate INTERRUPT_DELAY drive
  // cycles by calling bumpDelays for each.
  for (let i = 0; i < INTERRUPT_DELAY; i++) {
    setDriveClk(getDriveClk() + 1);
    cpuIntStatus.bumpDelays(getDriveClk());
  }
  check(
    `checkIrqDelay true after ${INTERRUPT_DELAY} drive-cycle bumps`,
    cpuIntStatus.checkIrqDelay() === true,
    `irqDelayCycles=${cpuIntStatus.irqDelayCycles}`,
  );
}

// ---------- Sub-test 4: polarity gate (PCR=0 vs PCR=$01) ----------------
// VICE viacore_signal compares `(edge ? 1 : 0) == (PCR & 0x01)`. Only
// matching combinations set IFR. Doc §17.4 OQ-419-2.
{
  // PCR=0 (= negative-edge config). ATN ASSERT ⇒ CA1 input rise ⇒
  // edge tag 1 ⇒ 1 != 0 ⇒ no IFR. ATN RELEASE ⇒ CA1 input fall ⇒
  // edge tag 0 ⇒ 0 == 0 ⇒ IFR set.
  const { iec, via } = makeRig({ pcr: 0x00 });
  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 1); // ATN assert (rise on CA1)
  check(
    "PCR=0 + ATN assert: IFR_CA1 stays clear (= polarity mismatch)",
    (via.ifr & VIA_IM_CA1) === 0,
    `ifr=${hex(via.ifr)}`,
  );
  iec.setC64Output(PA_ALL_RELEASED, 0x3f, 2); // ATN release (fall on CA1)
  check(
    "PCR=0 + ATN release: IFR_CA1 set (= polarity match)",
    (via.ifr & VIA_IM_CA1) !== 0,
    `ifr=${hex(via.ifr)}`,
  );
}
{
  // PCR=$01 (= DOS 1541 ROM convention).
  const { iec, via } = makeRig({ pcr: 0x01 });
  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 1); // ATN assert ⇒ rise ⇒ match
  check(
    "PCR=$01 + ATN assert: IFR_CA1 set",
    (via.ifr & VIA_IM_CA1) !== 0,
    `ifr=${hex(via.ifr)}`,
  );
  via.write(VIA_IFR, VIA_IM_CA1); // ack
  iec.setC64Output(PA_ALL_RELEASED, 0x3f, 3); // ATN release ⇒ fall ⇒ no
  check(
    "PCR=$01 + ATN release after ack: IFR stays clear",
    (via.ifr & VIA_IM_CA1) === 0,
    `ifr=${hex(via.ifr)}`,
  );
}

// ---------- Sub-test 5: redundant write = no edge = no signal -----------
// VICE iecbus.c:247 `if (iec_old_atn != (cpu_bus & 0x10))` guards the
// viacore_signal call. Same-state write must NOT propagate.
{
  const { iec, via } = makeRig({ pcr: 0x01 });

  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 1);
  check(
    "After 1st assert: IFR_CA1 set",
    (via.ifr & VIA_IM_CA1) !== 0,
    `ifr=${hex(via.ifr)}`,
  );
  via.write(VIA_IFR, VIA_IM_CA1); // ack
  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 2); // same state — no edge
  check(
    "Redundant ATN-asserted write (same iec_old_atn): IFR stays clear",
    (via.ifr & VIA_IM_CA1) === 0,
    `ifr=${hex(via.ifr)}`,
  );
}

// ---------- Sub-test 6: VIA_SIG_* constants behave per VICE -------------
// Doc §17.4 OQ-419-2 cites src/via.h:134, :139-140 verbatim. The TS
// signal API uses string-typed `"rise" | "fall"`; via6522-vice.ts
// signal() body maps `"rise" → 1`, `"fall" → 0`, identical to VICE
// constants. Behavioral check: with PCR=0 only fall edge sets IFR
// (= the polarity gate must distinguish edge tags).
{
  const { iec, via } = makeRig({ pcr: 0x00 });
  iec.setC64Output(PA_ATN_ASSERTED, 0x3f, 1); // assert ⇒ rise
  const fellOnly = (via.ifr & VIA_IM_CA1) === 0;
  iec.setC64Output(PA_ALL_RELEASED, 0x3f, 2); // release ⇒ fall ⇒ match
  const roseAfter = (via.ifr & VIA_IM_CA1) !== 0;
  check(
    "PCR=0: rise stays clear, fall sets IFR (polarity gate works)",
    fellOnly && roseAfter,
    `fellOnly=${fellOnly} roseAfter=${roseAfter}`,
  );
}

// ---------- Report -----------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(
  `Spec 419 smoke — ATN edge → drive VIA1 CA1 IFR + IRQ — ` +
  `${pass}/${results.length} pass, ${fail} fail`,
);
if (fail > 0) {
  for (const r of results) if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
  process.exit(1);
}
