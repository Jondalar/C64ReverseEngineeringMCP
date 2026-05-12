#!/usr/bin/env node
// Spec 416 — IEC Phase A smoke: iecbus_t formula coverage.
//
// Doctrine: 1:1 VICE IEC port. Validates that our IecBusCore
// implements the §15 Phase A formulas byte-for-byte against the
// VICE C reference.
//
// Doc anchors:
//   docs/vice-iec-arc42.md §5.1 (iecbus_t structure)
//   docs/vice-iec-arc42.md §5.2 (iec_update_cpu_bus / iec_update_ports)
//   docs/vice-iec-arc42.md §15 A (Phase A clone-checklist steps 1-3)
//   docs/vice-iec-arc42.md §17.1 (OQ-416-1 / OQ-416-2 resolutions)
//
// VICE source citations:
//   src/iecbus.h:35,56-83        — IECBUS_NUM=16 + iecbus_t struct
//   src/iecbus/iecbus.c:197-203  — iecbus_init memset + drv_port=0x85
//   src/c64/c64iec.c:121-124     — iec_update_cpu_bus formula
//   src/c64/c64iec.c:126-138     — iec_update_ports AND-fold + drv_port
//   src/c64/c64iec.c:145-150     — iec_drive_write (drv_bus 1541 formula)
//   src/c64/c64cia2.c:150        — `tmp = (uint8_t)~byte` PA invert
//
// Test strategy:
//   1. Construct a fresh IecBusCore. Assert init state matches VICE
//      iecbus_init (struct = 0xff except drv_port = 0x85).
//   2. iec_update_cpu_bus byte-table (OQ-416-2 bit map): for each
//      raw PA byte, compute data = ~PA & 0xff, run the VICE formula
//      in JS (reference), call core.iec_update_cpu_bus(data), assert
//      core.cpu_bus matches reference for every input.
//   3. drv_port bit-layout: for known cpu_bus + drv_bus[8] combos,
//      compute cpu_port + drv_port via the §5.2 formulas in JS and
//      assert TS core matches. Verifies ATN=7, CLK_IN=2, DATA_IN=0
//      wiring.
//   4. End-to-end: c64_store_dd00(data) + drive_store_pb(byte, 8)
//      cycle through a few realistic states (idle, ATN-asserted,
//      drive-pulling-data) and confirm cpu_bus / cpu_port / drv_port
//      all match the reference path.

import { IecBusCore } from "../dist/runtime/headless/iec/iec-bus-core.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}
const hex = (v, w = 2) => "$" + (v & 0xff).toString(16).padStart(w, "0");

// ---------- Reference (VICE-exact) implementations in JS -----------

// src/c64/c64iec.c:121-124
function refUpdateCpuBus(data) {
  const d = data & 0xff;
  return (((d << 2) & 0x80) | ((d << 2) & 0x40) | ((d << 1) & 0x10)) & 0xff;
}

// src/c64/c64iec.c:145-150 — drv_bus[unit] for type-1541 drives.
// VICE: drv_bus = ((data<<3)&0x40) | ((data<<6) & ((~data ^ cpu_bus)<<3) & 0x80)
// drv_data[unit] = data (the inverted PB byte from store_prb / iec_drive_write).
function refDrvBus(drvData, cpuBus) {
  const dd = drvData & 0xff;
  const term1 = (dd << 3) & 0x40;
  const xor = ((~dd) ^ cpuBus) >>> 0; // uint32_t
  const shifted = (xor << 3) >>> 0;
  const term2 = (dd << 6) & shifted & 0x80;
  return (term1 | term2) & 0xff;
}

// src/c64/c64iec.c:126-138 — iec_update_ports.
// drv_bus is a 16-element array, units 4..15 fold. Inactive units = 0xff.
function refUpdatePorts(cpuBus, drvBus) {
  let cp = cpuBus & 0xff;
  for (let u = 4; u < 16; u++) cp &= drvBus[u] & 0xff;
  cp &= 0xff;
  const dp = (
    ((cp >> 4) & 0x04) |       // CLK   bit6 → drv_port bit 2 (CLK_IN)
    (cp >> 7) |                // DATA  bit7 → drv_port bit 0 (DATA_IN)
    ((cpuBus << 3) & 0x80)     // ATN   bit4 → drv_port bit 7
  ) & 0xff;
  return { cpu_port: cp, drv_port: dp };
}

// ---------- Sub-test 1: init state per iecbus_init -----------------
{
  const core = new IecBusCore();
  check(
    "init: cpu_bus = 0xff",
    core.cpu_bus === 0xff,
    `got ${hex(core.cpu_bus)}`,
  );
  check(
    "init: cpu_port = 0xff",
    core.cpu_port === 0xff,
    `got ${hex(core.cpu_port)}`,
  );
  check(
    "init: drv_port = 0x85 (READ_DATA|READ_CLK|READ_ATN)",
    core.drv_port === 0x85,
    `got ${hex(core.drv_port)}`,
  );
  check(
    "init: drv_bus length = 16 (IECBUS_NUM)",
    core.drv_bus.length === 16,
    `got ${core.drv_bus.length}`,
  );
  check(
    "init: drv_data length = 16 (IECBUS_NUM)",
    core.drv_data.length === 16,
    `got ${core.drv_data.length}`,
  );
  for (let u = 0; u < 16; u++) {
    if ((core.drv_bus[u] & 0xff) !== 0xff) {
      check(`init: drv_bus[${u}] = 0xff`, false, `got ${hex(core.drv_bus[u])}`);
    }
    if ((core.drv_data[u] & 0xff) !== 0xff) {
      check(`init: drv_data[${u}] = 0xff`, false, `got ${hex(core.drv_data[u])}`);
    }
  }
  check("init: iec_old_atn = 0x10 (released)", core.iec_old_atn === 0x10, `got ${hex(core.iec_old_atn)}`);
}

// ---------- Sub-test 2: iec_update_cpu_bus byte-by-byte (256 bytes) ---
{
  const core = new IecBusCore();
  let mismatches = 0;
  for (let pa = 0; pa < 256; pa++) {
    const data = (~pa) & 0xff; // c64cia2.c:150 invert
    const want = refUpdateCpuBus(data);
    core.iec_update_cpu_bus(data);
    if (core.cpu_bus !== want) {
      mismatches++;
      if (mismatches <= 3) {
        check(
          `cpu_bus pa=${hex(pa)} data=${hex(data)}`,
          false,
          `got ${hex(core.cpu_bus)} want ${hex(want)}`,
        );
      }
    }
  }
  check(
    "iec_update_cpu_bus: all 256 PA bytes match VICE formula",
    mismatches === 0,
    `mismatches=${mismatches}`,
  );

  // Spot-check the OQ-416-2 bit map table (data = ~PA, so bits are
  // pre-inverted PA bits). data bit 5 → cpu_bus bit 7 etc.
  // PA=0xff (= no IEC line asserted) → data = 0x00 → cpu_bus = 0x00
  // Wait: cpu_bus bit set = c64 NOT asserting. PA=0xff is "all
  // released" (CIA latch all 1s = drives all outputs HIGH). After
  // invert: data=0. After formula: cpu_bus=0. But init = 0xff!
  // Reconciliation: the init state assumes nobody has written DD00
  // yet. After the first DD00 store of 0xff, cpu_bus drops to 0 —
  // which is "all asserted" semantically WRONG. The PA byte semantic
  // is: PA bit 3=0 means C64 is asserting ATN. So PA=0xff means
  // C64 is asserting none. After ~ → data=0 → cpu_bus=0 means
  // "released = bit clear" — exactly the inverse encoding from init.
  // VICE handles this by initializing iecbus to 0xff once and only
  // touching it via PA stores; after the first store, the encoding
  // flips to "released = bit clear" via formula. The AND-fold in
  // iec_update_ports then yields cpu_port=0x00 = "all lines LOW".
  // This is correct — see VICE c64.c:526 which does NOT call
  // iec_update_cpu_bus on init (the post-PA-store encoding only
  // takes effect after the first store).
  //
  // Smoke just confirms the formula is byte-exact vs reference.
  // Boot-time semantic correctness is tested elsewhere (game smokes).

  // Per OQ-416-2 doc table: pick PA=0x00 (CIA latched all 0 = c64
  // pulling everything LOW post-invert). data = ~0 & 0xff = 0xff.
  // cpu_bus = ((0xff<<2)&0x80)|((0xff<<2)&0x40)|((0xff<<1)&0x10)
  //         = 0x80 | 0x40 | 0x10 = 0xd0.
  core.iec_update_cpu_bus(0xff);
  check(
    "OQ-416-2 spot: data=0xff → cpu_bus=0xd0 (DATA|CLK|ATN released-bits set)",
    core.cpu_bus === 0xd0,
    `got ${hex(core.cpu_bus)}`,
  );
}

// ---------- Sub-test 3: drv_port bit layout (ATN=7, CLK_IN=2, DATA_IN=0) ---
{
  // Cover the eight (ATN, CLK, DATA) combinations of cpu_bus bits
  // 4/6/7. drv_bus[8] = 0xff (drive transparent → fold-through).
  for (let combo = 0; combo < 8; combo++) {
    const atn = (combo >> 0) & 1; // 1 = released
    const clk = (combo >> 1) & 1;
    const dat = (combo >> 2) & 1;
    const cpuBus =
      (atn ? 0x10 : 0) |
      (clk ? 0x40 : 0) |
      (dat ? 0x80 : 0);
    const core = new IecBusCore();
    core.cpu_bus = cpuBus;
    // drv_bus stays 0xff (memset). recompute drv_bus[8] would normally
    // happen on store_prb / c64 store; skip and let AND fold be identity.
    core.iec_update_ports();
    const ref = refUpdatePorts(cpuBus, core.drv_bus);
    check(
      `drv_port combo atn=${atn} clk=${clk} dat=${dat} cpu_bus=${hex(cpuBus)}`,
      core.cpu_port === ref.cpu_port && core.drv_port === ref.drv_port,
      `cpu_port got=${hex(core.cpu_port)} want=${hex(ref.cpu_port)}, drv_port got=${hex(core.drv_port)} want=${hex(ref.drv_port)}`,
    );
    // Bit-level layout check: only ATN bit comes from cpu_bus directly.
    const expectAtnBit = atn ? 0x80 : 0; // drv_port bit 7
    const expectClkBit = clk ? 0x04 : 0; // drv_port bit 2
    const expectDataBit = dat ? 0x01 : 0; // drv_port bit 0
    check(
      `drv_port bit layout combo=${combo}: ATN=7 CLK_IN=2 DATA_IN=0`,
      (core.drv_port & 0x80) === expectAtnBit &&
        (core.drv_port & 0x04) === expectClkBit &&
        (core.drv_port & 0x01) === expectDataBit,
      `drv_port=${hex(core.drv_port)} expectAtn=${expectAtnBit} expectClk=${expectClkBit} expectData=${expectDataBit}`,
    );
  }
}

// ---------- Sub-test 4: end-to-end with drv_data (1541 formula) ----
{
  // Drive PB raw bytes covering: 0xff (idle), 0x00 (full pull),
  // 0x02 (DATA_OUT pulled), 0x08 (CLK_OUT pulled), 0x0a (both),
  // 0x10 (ATNA bit set), 0x12 (DATA_OUT + ATNA), 0xfd, 0xf7.
  const driveBytes = [0xff, 0x00, 0x02, 0x08, 0x0a, 0x10, 0x12, 0xfd, 0xf7];
  const paBytes = [0x00, 0xff, 0xe7, 0xef, 0xf7, 0xfb, 0x07, 0x18];
  let mismatches = 0;
  let firstFail = null;
  for (const pa of paBytes) {
    for (const drvByte of driveBytes) {
      const core = new IecBusCore();
      // C64 store DD00 (PA byte). c64_store_dd00 expects pre-inverted.
      const dataInv = (~pa) & 0xff;
      core.c64_store_dd00(dataInv);
      // Drive PB store. drive_store_pb expects raw ORB byte; sets
      // drv_data[unit] = ~byte then recomputes drv_bus + ports.
      core.drive_store_pb(drvByte, 8);

      // Reference path:
      const refCpuBus = refUpdateCpuBus(dataInv);
      const refDrvData = (~drvByte) & 0xff;
      const refDrvBusArr = new Uint8Array(16);
      refDrvBusArr.fill(0xff);
      refDrvBusArr[8] = refDrvBus(refDrvData, refCpuBus);
      const ref = refUpdatePorts(refCpuBus, refDrvBusArr);

      const ok =
        core.cpu_bus === refCpuBus &&
        core.drv_data[8] === refDrvData &&
        core.drv_bus[8] === refDrvBusArr[8] &&
        core.cpu_port === ref.cpu_port &&
        core.drv_port === ref.drv_port;
      if (!ok) {
        mismatches++;
        if (!firstFail) {
          firstFail = {
            pa, drvByte,
            got: {
              cpu_bus: core.cpu_bus,
              drv_data8: core.drv_data[8],
              drv_bus8: core.drv_bus[8],
              cpu_port: core.cpu_port,
              drv_port: core.drv_port,
            },
            want: {
              cpu_bus: refCpuBus,
              drv_data8: refDrvData,
              drv_bus8: refDrvBusArr[8],
              cpu_port: ref.cpu_port,
              drv_port: ref.drv_port,
            },
          };
        }
      }
    }
  }
  check(
    `end-to-end: ${paBytes.length} PA × ${driveBytes.length} drv combos match VICE reference`,
    mismatches === 0,
    mismatches === 0
      ? ""
      : `mismatches=${mismatches} firstFail pa=${hex(firstFail.pa)} drvByte=${hex(firstFail.drvByte)} got=${JSON.stringify(firstFail.got)} want=${JSON.stringify(firstFail.want)}`,
  );
}

// ---------- Sub-test 5: drv_data[16] indexing semantics (OQ-416-1) -
{
  const core = new IecBusCore();
  // After init all 16 entries should be 0xff. drive_store_pb on unit
  // 8 should leave units 0..7,9..15 untouched.
  core.drive_store_pb(0x00, 8); // drv_data[8] = 0xff (~0=0xff). pick 0x55:
  core.drive_store_pb(0x55, 8);
  check(
    "drv_data[8] = ~0x55 = 0xaa after drive_store_pb",
    core.drv_data[8] === 0xaa,
    `got ${hex(core.drv_data[8])}`,
  );
  for (const u of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15]) {
    if ((core.drv_data[u] & 0xff) !== 0xff) {
      check(
        `drv_data[${u}] untouched by drive_store_pb(8)`,
        false,
        `got ${hex(core.drv_data[u])}`,
      );
    }
  }
  check("drv_data[u]==0xff for all u != 8 after store_pb(8)", true);
}

// ---------- Report ----------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 416 smoke — IEC bus formulas — ${pass}/${results.length} pass, ${fail} fail`);
if (fail > 0) {
  for (const r of results) if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
  process.exit(1);
}
