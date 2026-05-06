// Spec 151 — SID register R/W unit tests.
//
// Each test asserts behavior derived from VICE 3.7.1
// src/sid/fastsid.c. Cited file/line in each test comment.
//
// Standalone runner — no jest framework in this repo. Run via:
//   npx tsx tests/unit/sid/sid-register-rw.test.ts
// or via the smoke harness wired by scripts/smoke-sid-fidelity.mjs.

import { strict as assert } from "node:assert";
import { Sid6581 } from "../../../src/runtime/headless/sid/sid.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

// VICE: fastsid_store() — fastsid.c lines 1133-1183. Writes latch into
// psid->d[addr]. Read of writable regs returns stored value (modulo
// laststore decay; B-level returns latched).
test("write 0x00 then read 0x00 round-trips (V0 freq lo)", () => {
  const sid = new Sid6581();
  sid.write(0x00, 0x34);
  assert.equal(sid.read(0x00), 0x34);
});

test("write all writable regs 0x00..0x18 round-trip", () => {
  const sid = new Sid6581();
  for (let r = 0; r <= 0x18; r++) sid.write(r, (r * 7) & 0xff);
  for (let r = 0; r <= 0x18; r++) assert.equal(sid.read(r), (r * 7) & 0xff, `reg $${r.toString(16)}`);
});

// VICE: sid_read_chip() — sid.c line 278: 0x1d-0x1f open bus → returns
// maincpu_clk%256 when sound off, else laststore decay. B-level: 0.
test("$D41D-$D41F open-bus reads return 0", () => {
  const sid = new Sid6581();
  for (const r of [0x1d, 0x1e, 0x1f]) {
    assert.equal(sid.read(r), 0, `reg $${r.toString(16)}`);
  }
});

// VICE: sid_read_chip() $D419/$D41A path — pot register reads route
// through joyport pot handlers. B-level: routes through `potReader`
// callback (Sprint 108 contract).
test("$D419 routes through potReader(0)", () => {
  const sid = new Sid6581();
  sid.potReader = (i) => (i === 0 ? 0xab : 0xcd);
  assert.equal(sid.read(0x19), 0xab);
});

test("$D41A routes through potReader(1)", () => {
  const sid = new Sid6581();
  sid.potReader = (i) => (i === 0 ? 0xab : 0xcd);
  assert.equal(sid.read(0x1a), 0xcd);
});

test("$D419/$D41A return 0 with no potReader", () => {
  const sid = new Sid6581();
  assert.equal(sid.read(0x19), 0);
  assert.equal(sid.read(0x1a), 0);
});

// VICE: fastsid_reset() — fastsid.c line 1185-1194: stores 0 to all
// 32 registers.
test("reset() clears all registers to 0", () => {
  const sid = new Sid6581();
  for (let r = 0; r < 0x18; r++) sid.write(r, 0xff);
  sid.reset();
  for (let r = 0; r < 0x19; r++) assert.equal(sid.read(r), 0, `reg $${r.toString(16)}`);
});

// VICE: writeTrace contract (Sprint 109 / Spec 131 M7.2). Trace fires
// on every write including to unwritable / read-only regs.
test("writeTrace sees every write incl. open-bus addresses", () => {
  const sid = new Sid6581();
  const events: Array<{ addr: number; value: number }> = [];
  sid.writeTrace = (addr, value) => events.push({ addr, value });
  sid.write(0x04, 0x21);
  sid.write(0x18, 0x0f);
  sid.write(0x1d, 0xff);
  assert.equal(events.length, 3);
  assert.deepEqual(events[0], { addr: 0x04, value: 0x21 });
  assert.deepEqual(events[1], { addr: 0x18, value: 0x0f });
  assert.deepEqual(events[2], { addr: 0x1d, value: 0xff });
});

// VICE: addr & 0x1f mirror — sid_read_chip() / sid_store_chip() line
// 224 / 301. installSid() applies mirror, but the class itself also
// folds via & 0x1f so callers can pass absolute address.
test("addr masking: write at 0x20 == write at 0x00", () => {
  const sid = new Sid6581();
  sid.write(0x20, 0x77);
  assert.equal(sid.read(0x00), 0x77);
});

// ---- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nsid-register-rw: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
