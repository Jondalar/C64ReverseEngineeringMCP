// CIA2 IEC write wiring tests.
//
// Run via:
//   npx tsx tests/unit/cia/cia2-iec-write.test.ts

import { strict as assert } from "node:assert";
import { alarm_context_new } from "../../../src/runtime/headless/alarm/alarm-context.js";
import { HeadlessMemoryBus } from "../../../src/runtime/headless/memory-bus.js";
import { installCia2 } from "../../../src/runtime/headless/peripherals/cia2.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function harness(writeOffset: number) {
  const bus = new HeadlessMemoryBus();
  bus.reset();
  const clk = { v: 1000 };
  const writes: Array<{ paOut: number; ddr: number; effectiveClock?: number }> = [];
  let pins = 0xc0;
  const installed = installCia2(bus, {
    alarmContext: alarm_context_new("test_cia2"),
    clkPtr: () => clk.v,
    writeOffset,
    iecWrite: (paOut, ddr, effectiveClock) => {
      writes.push({ paOut, ddr, effectiveClock });
    },
    iecReadPins: () => pins,
  });
  writes.length = 0;
  return {
    bus,
    clk,
    writes,
    cia: installed.cia,
    setPins: (value: number) => { pins = value & 0xff; },
  };
}

test("DDRA change forwards VICE-composed PA, not raw PRA", () => {
  const { bus, writes } = harness(0);

  bus.write(0xdd00, 0x03);
  assert.equal(writes.length, 0, "PRA write with DDRA=0 should not change composed PA");

  bus.write(0xdd02, 0x38);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    paOut: 0xc7,
    ddr: 0x38,
    effectiveClock: 1001,
  });
});

test("writeOffset=1 keeps legacy CIA callback clock", () => {
  const { bus, writes } = harness(1);

  bus.write(0xdd00, 0x03);
  bus.write(0xdd02, 0x38);

  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.paOut, 0xc7);
  assert.equal(writes[0]!.effectiveClock, 1000);
});

test("DD00 read matches VICE read_ciapa low-bit float formula", () => {
  const { bus, setPins } = harness(0);

  // MoTM AB setup: PRA=$03, DDRA=$38. VICE read_ciapa computes
  // ((PRA | ~DDRA) & $3f) | cpu_port. Therefore low bits read as
  // $07, not $03: PA2 is an input and floats high.
  bus.write(0xdd00, 0x03);
  bus.write(0xdd02, 0x38);
  setPins(0xc0);

  assert.equal(bus.read(0xdd00), 0xc7);
});

// ---- runner ---------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\ncia2-iec-write: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
