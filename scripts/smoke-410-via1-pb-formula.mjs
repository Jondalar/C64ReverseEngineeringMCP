#!/usr/bin/env node
// Spec 410 — 1541 Phase D smoke A: VIA1 PB read formula byte-for-byte.
//
// Doctrine: 1:1 VICE TDE port. Validates that the drive VIA1
// `read_prb` formula matches VICE exact:
//
//   byte = ((PRB & DDRB) | (((drv_port ^ 0x85) | 0x1A | driveid) & ~DDRB))
//
// Doc: docs/vice-1541-arch.md §6.4 (read PB) + §14 invariant 4.
// VICE: src/drive/iec/via1d1541.c:337-362 `read_prb()`.
//
// Test strategy (per spec 410 acceptance):
//   1. Construct an IecBusCore directly (no full session).
//   2. Construct a standalone Via1d1541 wired to that bus.
//   3. Seed `iec.drv_port` to synthetic values.
//   4. For each (PRB, DDRB) combo, call the chip's PB read (`via.read(0)`)
//      and assert it equals the reference formula computed in JS.
//   5. Repeat for deviceId 8..11 — verify driveid bits.
//      Per OQ-410-1 (doc §17): unit 0/dev 8 → driveid=$00,
//      unit 1/dev 9 → $20, unit 2/dev 10 → $40, unit 3/dev 11 → $60.

import { alarm_context_new } from "../dist/runtime/headless/alarm/alarm-context.js";
import { Via1d1541 } from "../dist/runtime/headless/via/via1d1541.js";
import { IecBusCore } from "../dist/runtime/headless/iec/iec-bus-core.js";
import { VIA_PRB, VIA_DDRB } from "../dist/runtime/headless/via/via6522-vice.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail: detail ?? "" });
}

function makeVia(deviceId) {
  const iec = new IecBusCore();
  const ctx = alarm_context_new(`smoke-410-pb-dev${deviceId}`);
  const via = new Via1d1541({
    alarmContext: ctx,
    iec,
    deviceId,
    clkRef: () => 0,
    setIrq: () => {},
  });
  return { via, iec };
}

// Reference (VICE-exact) formula, restated in JS for diff against TS.
// Cite: src/drive/iec/via1d1541.c:344-356 `read_prb()`.
function refReadPrb({ prb, ddrb, drv_port, deviceId }) {
  const driveid = ((deviceId - 8) << 5) & 0x60;
  const tmp = ((drv_port ^ 0x85) | 0x1A | driveid) & 0xff;
  return ((prb & ddrb) | (tmp & ~ddrb)) & 0xff;
}

// --- Sub-test 1: driveid table per OQ-410-1 ----------------------------
const driveidTable = [
  { deviceId: 8,  expected: 0x00 },
  { deviceId: 9,  expected: 0x20 },
  { deviceId: 10, expected: 0x40 },
  { deviceId: 11, expected: 0x60 },
];
for (const t of driveidTable) {
  const calc = ((t.deviceId - 8) << 5) & 0x60;
  check(
    `driveid bits unit ${t.deviceId - 8} (dev ${t.deviceId}) = $${t.expected.toString(16).padStart(2, "0")}`,
    calc === t.expected,
    `got $${calc.toString(16).padStart(2, "0")}`,
  );
}

// --- Sub-test 2: PB read byte-for-byte vs VICE ------------------------
// Synthetic drv_port values exercising every IN bit + a few corners.
const drvPorts = [0x00, 0x85, 0xff, 0x80, 0x05, 0x01, 0x84, 0xaa, 0x55];
// PRB/DDRB combos: all-output (DDRB=0xff = drive owns line), all-input
// (DDRB=0 → reads bus only), and mixed.
const ddrbList = [0x00, 0x1A, 0xff, 0x18, 0x02];
const prbList  = [0x00, 0xff, 0x55, 0x12];

for (const deviceId of [8, 9, 10, 11]) {
  const { via, iec } = makeVia(deviceId);
  for (const drvPort of drvPorts) {
    for (const ddrb of ddrbList) {
      via.write(VIA_DDRB, ddrb);
      for (const prb of prbList) {
        via.write(VIA_PRB, prb);
        // Seed iec drv_port AFTER PRB write — `via.write(VIA_PRB)` calls
        // `store_prb` which recomputes `iec.drv_port` from cpu_port.
        // We pin drv_port to the synthetic value so the read formula is
        // tested against a known input regardless of bus state.
        iec.drv_port = drvPort & 0xff;
        // Drive read of $1800 (= VIA_PRB).
        const got = via.read(VIA_PRB) & 0xff;
        const expected = refReadPrb({ prb, ddrb, drv_port: drvPort, deviceId });
        check(
          `dev${deviceId} drv_port=$${drvPort.toString(16).padStart(2,"0")} ddrb=$${ddrb.toString(16).padStart(2,"0")} prb=$${prb.toString(16).padStart(2,"0")}`,
          got === expected,
          `got=$${got.toString(16).padStart(2,"0")} want=$${expected.toString(16).padStart(2,"0")}`,
        );
      }
    }
  }
}

// --- Report ------------------------------------------------------------
const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`Spec 410 smoke A — VIA1 PB read formula — ${pass}/${results.length} pass, ${fail} fail`);
if (fail > 0) {
  for (const r of results) if (!r.pass) console.log(`  [FAIL] ${r.label}: ${r.detail}`);
  process.exit(1);
}
