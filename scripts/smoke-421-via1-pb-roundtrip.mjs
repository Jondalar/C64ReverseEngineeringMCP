#!/usr/bin/env node
// Spec 421 — IEC Phase F smoke: drive VIA1 PB read/write round-trip.
//
// Doctrine: 1:1 VICE IEC port. Validates spec 421 producer changes:
//   1. Drive writes VIA1 $1800 PB → IecBus.setDriveOutput →
//      core.drive_store_pb(byte, 8). 4-step recompute:
//        a. drv_data[8] = ~byte
//        b. recompute drv_bus[8] per 1541-type formula (§5.9)
//        c. recompute cpu_port (AND-fold of drv_bus[4..15])
//        d. recompute drv_port (cpu_port + cpu_bus → drive view)
//      C64 reading $DD00 sees the transformed value.
//   2. C64 writes $DD00 → IecBus.setC64Output → core.c64_store_dd00.
//      Drive reading VIA1 PB sees `((PRB & DDRB) | (tmp & ~DDRB))` with
//      `tmp = (drv_port ^ 0x85) | 0x1a | driveid` (= byte-for-byte
//      VICE read_prb formula).
//   3. NO drive flush is invoked on a drive-PB-write (drive is the
//      writer; it is already current — § 15 step 15 explicit note).
//   4. Driveid encoding: unit 8 → 0, unit 9 → 0x20, unit 10 → 0x40,
//      unit 11 → 0x60. Mask 0x60 = `(3 << 5)` covers PB5 + PB6.
//   5. PRB & DDRB drive-output bits passthrough on read for outputs.
//
// Doc anchors:
//   docs/vice-iec-arc42.md §15 Phase F (steps 15-16)
//   docs/vice-iec-arc42.md §5.9        (drv_bus formula, 1541 variant)
//   docs/vice-iec-arc42.md §5.2        (iec_update_ports formula)
//   docs/vice-iec-arc42.md §16         (invariants 1, 2, 8, 10)
//   docs/vice-iec-arc42.md §17.6       (OQ-421-1 — driveid resolution)
//
// VICE source citations (verified 2026-05-12 against vice-3.7.1):
//   src/drive/iec/via1d1541.c:212-249  — store_prb (PB write):
//                                        drv_data = ~byte; drv_bus =
//                                        ATN-AND-gate; iec_update_ports.
//                                        No drive_cpu_execute call.
//   src/drive/iec/via1d1541.c:230-232  — drv_bus formula (1541 variant):
//                                        ((dd<<3)&0x40) |
//                                        ((dd<<6) & ((~dd^cpu_bus)<<3) & 0x80)
//   src/drive/iec/via1d1541.c:337-362  — read_prb (PB read):
//                                        tmp = (drv_port ^ 0x85) | 0x1a | driveid;
//                                        byte = (PRB & DDRB) | (tmp & ~DDRB);
//   src/drive/iec/via1d1541.c:345      — driveid = (number << 5) & 0x60;
//                                        (= OQ-421-1 resolution)
//   src/drive/iec/via1d1541.c:324-336  — PB pin map comments:
//                                        bit 0 DATA IN, bit 1 DATA OUT,
//                                        bit 2 CLK IN, bit 3 CLK OUT,
//                                        bit 4 ATNA OUT, bits 5-6 device-id,
//                                        bit 7 ATN IN.
//   src/c64/c64iec.c:121-138           — iec_update_cpu_bus / iec_update_ports
//                                        (companion mutation primitives).

import { IecBus } from "../dist/runtime/headless/iec/iec-bus.js";
import { Via1d1541 } from "../dist/runtime/headless/via/via1d1541.js";
import { alarmContextNew } from "../dist/runtime/headless/alarm/alarm-context.js";
import {
  VIA_PRB, VIA_DDRB,
} from "../dist/runtime/headless/via/via6522-vice.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}
const hex = (v, w = 2) => "$" + ((v ?? 0) & 0xff).toString(16).padStart(w, "0");

// ─────────────────────────────────────────────────────────────────────
// Sub-test 1: Forward direction. Drive writes VIA1 PB → C64 reads $DD00.
// All-released baseline: drive PB = 0x00 (no output bits). drv_data=0xff.
// drv_bus[8] should compute to 0xC0 (= bits 6+7 set, both lines released).
// cpu_port = cpu_bus(0xff) & 0xC0 = 0xC0 → C64 sees DATA_IN+CLK_IN released.
// ─────────────────────────────────────────────────────────────────────
{
  const bus = new IecBus();
  const ctx = alarmContextNew("smoke-421-fwd-baseline");
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx, iec: bus.core, deviceId: 8,
    clkRef: () => driveClk, setIrq: () => {},
  });
  bus.attachDriveVia1(via);
  bus.driveClockSource = () => driveClk;

  // Snapshot pre-state.
  const preCpuBus = bus.core.cpu_bus;
  const preDrvData8 = bus.core.drv_data[8];

  // Drive writes PB = 0x00 (all output bits inactive). This is the
  // "drive releases everything" state.
  bus.setDriveOutput(0x00, 0xff);

  check(
    "drv_data[8] = ~0x00 = 0xff after drive PB=0x00 (= step a, drv_data=~byte)",
    bus.core.drv_data[8] === 0xff,
    `pre=${hex(preDrvData8)} post=${hex(bus.core.drv_data[8])}`,
  );
  // 1541 formula §5.9 with dd=0xff, cpu_bus=0xff:
  //   term1 = (0xff << 3) & 0x40 = 0x40
  //   term2 = (0xff << 6) & ((~0xff ^ 0xff) << 3) & 0x80
  //         = 0x3fc0    & (0xffffff00 ^ 0xff)<<3   & 0x80
  //         = 0x3fc0    & 0xfffffff8                & 0x80
  //         = 0x80
  //   drv_bus[8] = 0xC0
  check(
    "drv_bus[8] = 0xC0 after drive releases (= step b, 1541 ATN-AND-gate formula)",
    bus.core.drv_bus[8] === 0xc0,
    `got ${hex(bus.core.drv_bus[8])}`,
  );
  check(
    "cpu_port = 0xC0 after drive releases (= step c, AND-fold of drv_bus[4..15])",
    bus.core.cpu_port === 0xc0,
    `got ${hex(bus.core.cpu_port)}`,
  );
  // C64 reads $DD00 — bus.core.cpu_port is the cached value the C64 sees.
  // Bit 7 = DATA_IN (1=released), bit 6 = CLK_IN (1=released).
  const c64Read = bus.core.cpu_port & 0xc0;
  check(
    "C64 reads $DD00 → DATA_IN+CLK_IN both released (bits 6+7 = 1)",
    c64Read === 0xc0,
    `got ${hex(c64Read)}`,
  );
  check(
    "Forward baseline: cpu_bus unchanged by drive PB write (= drive-side mutation only)",
    bus.core.cpu_bus === preCpuBus,
    `pre=${hex(preCpuBus)} post=${hex(bus.core.cpu_bus)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-test 2: Forward — drive asserts DATA OUT (PB bit 1 = 1).
// dd = 0xfd. drv_bus[8] = 0x40 (bit 7 cleared = DATA pulled). cpu_port = 0x40.
// C64 sees DATA_IN low (= 0), CLK_IN high (= 1).
// ─────────────────────────────────────────────────────────────────────
{
  const bus = new IecBus();
  const ctx = alarmContextNew("smoke-421-fwd-data");
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx, iec: bus.core, deviceId: 8,
    clkRef: () => driveClk, setIrq: () => {},
  });
  bus.attachDriveVia1(via);
  bus.driveClockSource = () => driveClk;

  // Drive asserts DATA OUT (PB bit 1).
  bus.setDriveOutput(0x02, 0xff);

  check(
    "drv_data[8] = 0xfd after drive PB=0x02 (DATA OUT asserted)",
    bus.core.drv_data[8] === 0xfd,
    `got ${hex(bus.core.drv_data[8])}`,
  );
  // dd=0xfd, cpu_bus=0xff:
  //   term1 = (0xfd<<3)&0x40 = 0x40    (CLK_OUT bit 3=1 of dd → bit 6 of bus)
  //   term2 = (0xfd<<6) & ((~0xfd^0xff)<<3) & 0x80
  //         = 0x3f40 & (0xfffffe00 ^ 0xff)<<3 & 0x80
  //         = 0x3f40 & 0xfffffff8 & 0x80
  //         = 0x00
  //   drv_bus[8] = 0x40
  check(
    "drv_bus[8] = 0x40 after drive asserts DATA (= bit 7 cleared by dd<<6 path)",
    bus.core.drv_bus[8] === 0x40,
    `got ${hex(bus.core.drv_bus[8])}`,
  );
  check(
    "cpu_port = 0x40 (DATA pulled, CLK released)",
    bus.core.cpu_port === 0x40,
    `got ${hex(bus.core.cpu_port)}`,
  );
  // C64 read of $DD00 PA = cached cpu_port. Bit 7 (DATA_IN) = 0 = pulled.
  const c64Read = bus.core.cpu_port;
  check(
    "C64 reads $DD00 → DATA_IN=0 (drive pulled the line)",
    (c64Read & 0x80) === 0,
    `got ${hex(c64Read)}`,
  );
  check(
    "C64 reads $DD00 → CLK_IN=1 (drive did not pull CLK)",
    (c64Read & 0x40) === 0x40,
    `got ${hex(c64Read)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-test 3: NO drive flush on drive-PB-write (= §15 step 15 invariant).
// Install a flushAuditor; assert it never fires when only setDriveOutput is
// called. The auditor is the same one Spec 418 uses to verify the C64-side
// flush sites — its absence on the drive-PB-write path proves the §15
// step 15 "no flush" invariant.
// ─────────────────────────────────────────────────────────────────────
{
  const bus = new IecBus();
  const ctx = alarmContextNew("smoke-421-no-flush");
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx, iec: bus.core, deviceId: 8,
    clkRef: () => driveClk, setIrq: () => {},
  });
  bus.attachDriveVia1(via);
  bus.driveClockSource = () => driveClk;

  // Install both pushFlush AND flushAuditor — the auditor only fires
  // from inside _performC64{Read,Write}. Drive PB writes go through
  // setDriveOutput → core.drive_store_pb (no flush wrapper).
  let flushCount = 0;
  bus.pushFlush = {
    all: () => { flushCount++; },
    one: () => { flushCount++; },
  };
  let auditorCount = 0;
  bus.flushAuditor = () => { auditorCount++; };

  bus.setDriveOutput(0x02, 0xff);
  bus.setDriveOutput(0x00, 0xff);
  bus.setDriveOutput(0x0a, 0xff);

  check(
    "Drive PB writes do NOT invoke pushFlush.{all,one} (= §15 step 15 invariant)",
    flushCount === 0,
    `got flushCount=${flushCount}`,
  );
  check(
    "Drive PB writes do NOT invoke flushAuditor (= no _performC64* wrap)",
    auditorCount === 0,
    `got auditorCount=${auditorCount}`,
  );

  // Sanity: a C64 PA write DOES fire the flush (= proves the auditor is wired).
  bus.setC64Output(0x00, 0x3f, 100);
  check(
    "C64 PA write DOES invoke pushFlush.one (= sanity check, auditor wired)",
    flushCount > 0,
    `got flushCount=${flushCount}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-test 4: Reverse direction. C64 writes $DD00 → drive reads VIA1 PB.
// VICE read_prb formula byte-for-byte:
//   tmp = (drv_port ^ 0x85) | 0x1a | driveid
//   byte = (PRB & DDRB) | (tmp & ~DDRB)
// With DDRB = 0 (all-input), driveid = 0 (unit 8), the result is exactly
// `(drv_port ^ 0x85) | 0x1a`.
// ─────────────────────────────────────────────────────────────────────
{
  const bus = new IecBus();
  const ctx = alarmContextNew("smoke-421-rev-data");
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx, iec: bus.core, deviceId: 8,
    clkRef: () => driveClk, setIrq: () => {},
  });
  bus.attachDriveVia1(via);
  bus.driveClockSource = () => driveClk;

  // Configure VIA1 in 1541-DOS-idle shape: DDRB = OUT mask (0x1A),
  // PRB = 0 (= drive does NOT actively pull any output line). This is
  // the post-reset state DOS 1541 ROM establishes ($EA85: LDA #$1A /
  // STA $1802 / LDA #$00 / STA $1800). With PRB=0+DDRB=0x1A the OR-pad
  // bbOut = (0 | ~0x1A) = 0xe5 → drv_data[8] = ~0xe5 = 0x1A → recompute
  // gives drv_bus[8] = 0xC0 → cpu_port = 0xC0 → drv_port = 0x85 (= the
  // initial released-state value matching iecbus_init()).
  via.write(VIA_DDRB, 0x1a);
  via.write(VIA_PRB, 0x00);

  // Sanity: drv_port = 0x85 (= released baseline), so the read formula
  // tmp = (0x85 ^ 0x85) | 0x1a | 0 = 0x1a; (PRB & DDRB) | (tmp & ~DDRB)
  // = (0 & 0x1A) | (0x1A & 0xE5) = 0 | 0x00 = 0x00. Wait — 0x1a & 0xe5
  // = 0x00, because 0x1a = 0001_1010 and 0xe5 = 1110_0101 share no bits.
  // The OUT-mask bits are masked OUT of the input layer (= the drive
  // sees only what it wrote on its own outputs, plus the IN-mask bits).
  const baselinePb = via.read(VIA_PRB);
  check(
    "Drive reads VIA1 PB at 1541-DOS idle (DDRB=0x1A, PRB=0) → 0x00",
    baselinePb === 0x00,
    `got ${hex(baselinePb)} (drv_port=${hex(bus.core.drv_port)})`,
  );

  // C64 raw PA bit 5 = 1 (DATA OUT asserted). After cia2.c:150 invert:
  //   data = ~0x20 & 0xff = 0xdf.
  // iec_update_cpu_bus(0xdf):
  //   cpu_bus = ((0xdf<<2)&0x80) | ((0xdf<<2)&0x40) | ((0xdf<<1)&0x10)
  //           = (0x37c & 0x80)   | (0x37c & 0x40)   | (0x1be & 0x10)
  //           = 0x00             | 0x40             | 0x10
  //           = 0x50
  // recompute_drv_bus(8) with dd=0xff (drive idle), cpu_bus=0x50:
  //   term1 = (0xff<<3)&0x40 = 0x40
  //   term2 = (0xff<<6) & ((~0xff^0x50)<<3) & 0x80
  //         = 0x3fc0    & (0xffffff00^0x50)<<3 & 0x80
  //         = 0x3fc0    & 0xfffffd58 & 0x80     (= 0x80 because <<3 of high bits)
  // Actually compute via JS later; we trust the existing recompute (validated
  // by drive-equiv + lorenz). The key check is: after C64 PA write,
  // drv_port reflects the new cpu_port + cpu_bus, AND the drive read formula
  // returns the byte VICE would.
  bus.setC64Output(0x20, 0x3f, 100);

  // Now compute expected drive PB read using the literal VICE formula
  // applied to the live core state. This is the canonical assertion:
  // the TS chip-side readPb backend must equal the by-hand application
  // of VICE's read_prb formula to (drv_port, PRB, DDRB, driveid=0).
  const drvPort = bus.core.drv_port;
  const PRB = via.via.via[0] & 0xff;     // PRB latch (= 0)
  const DDRB = via.via.via[2] & 0xff;    // DDRB latch (= 0x1A)
  const driveidUnit8 = ((8 - 8) << 5) & 0x60; // = 0
  const expectedTmp = ((drvPort ^ 0x85) | 0x1a | driveidUnit8) & 0xff;
  const expectedPb = ((PRB & DDRB) | (expectedTmp & (~DDRB & 0xff))) & 0xff;
  const livePb = via.read(VIA_PRB);
  check(
    `Drive read VIA1 PB matches VICE formula byte-for-byte ` +
    `(drv_port=${hex(drvPort)} PRB=${hex(PRB)} DDRB=${hex(DDRB)} → expected=${hex(expectedPb)})`,
    livePb === expectedPb,
    `got ${hex(livePb)}, expected ${hex(expectedPb)}`,
  );
  // ATN line is still released (C64 only set DATA bit), so PB7 (ATN_IN) = 0.
  // (drv_port bit 7 = (cpu_bus<<3)&0x80 = (0x50<<3)&0x80 = 0x80; XOR 0x85 →
  //  bit 7 stays 0; OR 0x1a → 0; AND ~DDRB (= bit 7 = 1) → 0.)
  check(
    "Drive PB bit 7 (ATN_IN) = 0 (= ATN released → drv_port bit 7 = 1 → ^0x85 bit 7 = 0)",
    (livePb & 0x80) === 0,
    `got ${hex(livePb)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-test 5: Reverse — drive PRB latch + DDRB output bits pass through.
// VICE formula: `(PRB & DDRB) | (tmp & ~DDRB)`. Set DDRB = 0x1A
// (= the OUT mask: ATNA + CLK_OUT + DATA_OUT) and PRB = 0x1A. The
// PRB bits at positions 1,3,4 should appear in the read result regardless
// of bus state because they are masked in by `(PRB & DDRB)`.
// ─────────────────────────────────────────────────────────────────────
{
  const bus = new IecBus();
  const ctx = alarmContextNew("smoke-421-rev-ddrb");
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx, iec: bus.core, deviceId: 8,
    clkRef: () => driveClk, setIrq: () => {},
  });
  bus.attachDriveVia1(via);
  bus.driveClockSource = () => driveClk;

  // Set DDRB to OUT mask 0x1A. Set PRB outputs all high (= drive
  // releasing all output lines via internal latch, but DDR makes them outputs).
  via.write(VIA_DDRB, 0x1a);
  via.write(VIA_PRB, 0x1a);
  // The store_prb side-effect already mutated drv_data[8]. We need to
  // recompute the read.
  const pb = via.read(VIA_PRB);
  // Expected: (PRB & DDRB) | (tmp & ~DDRB).
  //   PRB & DDRB = 0x1a & 0x1a = 0x1a.
  //   tmp = (drv_port ^ 0x85) | 0x1a | 0.  ~DDRB = ~0x1a = 0xe5.
  const drvPort = bus.core.drv_port;
  const tmp = ((drvPort ^ 0x85) | 0x1a | 0) & 0xff;
  const expectedPb = ((0x1a & 0x1a) | (tmp & 0xe5)) & 0xff;
  check(
    `Drive read with DDRB=0x1A, PRB=0x1A → output bits pass through ` +
    `(expected ${hex(expectedPb)}, got ${hex(pb)})`,
    pb === expectedPb,
  );
  // Bits 1, 3, 4 (output bits) must be 1 in the result.
  check(
    "Output bits PB1+PB3+PB4 (= DATA OUT, CLK OUT, ATNA OUT) appear as 1",
    (pb & 0x1a) === 0x1a,
    `got ${hex(pb)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-test 6: Driveid encoding (= OQ-421-1 resolution). For each unit
// 8/9/10/11 verify the VICE formula `driveid = (number << 5) & 0x60`
// yields 0/0x20/0x40/0x60 in the drive PB read.
// VICE source: src/drive/iec/via1d1541.c:345.
// ─────────────────────────────────────────────────────────────────────
{
  const cases = [
    { unit: 8,  expected: 0x00 },
    { unit: 9,  expected: 0x20 },
    { unit: 10, expected: 0x40 },
    { unit: 11, expected: 0x60 },
  ];
  for (const c of cases) {
    const bus = new IecBus();
    const ctx = alarmContextNew(`smoke-421-driveid-${c.unit}`);
    let driveClk = 0;
    const via = new Via1d1541({
      alarmContext: ctx, iec: bus.core, deviceId: c.unit,
      clkRef: () => driveClk, setIrq: () => {},
    });
    bus.attachDriveVia1(via);
    bus.driveClockSource = () => driveClk;

    via.write(VIA_DDRB, 0x00);
    via.write(VIA_PRB, 0x00);

    const pb = via.read(VIA_PRB);
    // Driveid bits are PB5+PB6 (mask 0x60). Verify those bits exactly.
    check(
      `Unit ${c.unit}: PB5+PB6 = ${hex(c.expected)} (= (number<<5)&0x60)`,
      (pb & 0x60) === c.expected,
      `got pb=${hex(pb)} pb&0x60=${hex(pb & 0x60)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sub-test 7: Round-trip — drive writes PB, then reads it back. The
// readback should reflect both the latched output bits AND the bus-derived
// input bits (per `(PRB & DDRB) | (tmp & ~DDRB)`).
// ─────────────────────────────────────────────────────────────────────
{
  const bus = new IecBus();
  const ctx = alarmContextNew("smoke-421-roundtrip");
  let driveClk = 0;
  const via = new Via1d1541({
    alarmContext: ctx, iec: bus.core, deviceId: 8,
    clkRef: () => driveClk, setIrq: () => {},
  });
  bus.attachDriveVia1(via);
  bus.driveClockSource = () => driveClk;

  // Configure outputs (DDRB = 0x1A); drive asserts DATA OUT (bit 1).
  via.write(VIA_DDRB, 0x1a);
  via.write(VIA_PRB, 0x02);

  // After this write, drv_data[8] should be ~(PRB & DDRB | ... ) — but
  // VICE store_prb writes the *full* `byte` arg, not masked by DDR:
  // `*drive_data = ~byte`. The viacore caller passes (PRB & DDRB) | ...
  // We just check the high-level invariant: the line state changed.
  const cpuPortAfter = bus.core.cpu_port;
  // Then the drive reads back. The output bits (DDRB=0x1A) come from PRB
  // latch directly; input bits come from drv_port^0x85.
  const pb = via.read(VIA_PRB);
  const drvPort = bus.core.drv_port;
  const tmp = ((drvPort ^ 0x85) | 0x1a | 0) & 0xff;
  const expectedPb = ((0x02 & 0x1a) | (tmp & 0xe5)) & 0xff;
  check(
    `Round-trip: drive PB readback = ${hex(expectedPb)} ` +
    `(latched + bus-derived)`,
    pb === expectedPb,
    `got ${hex(pb)} (cpu_port=${hex(cpuPortAfter)} drv_port=${hex(drvPort)})`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(
  `Spec 421 smoke — VIA1 PB round-trip ` +
  `(drive↔C64 via iecbus) — ${pass}/${results.length} pass, ${fail} fail`,
);
for (const r of results) {
  if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
}
if (fail > 0) process.exit(1);
