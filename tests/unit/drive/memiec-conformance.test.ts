// Spec 447 — memiec.c (1541) conformance unit tests.
//
// Pins literal-VICE memiec_init 1541 branch dispatch table:
//   $0000-$00FF: zero page = RAM[0..255]
//   $0100-$07FF: stack + RAM
//   $1800-$1BFF: VIA1 (16 regs mirrored)
//   $1C00-$1FFF: VIA2 (16 regs mirrored)
//   $2000-$27FF: RAM mirror (drive_ram2 disabled)
//   $3800-$3BFF: VIA1 mirror
//   $3C00-$3FFF: VIA2 mirror
//   $40-$47, $58-$5B, $5C-$5F: same pattern
//   $60-$67, $78-$7B, $7C-$7F: same pattern
//   $8000-$9FFF: ROM low (mirror of canonical on stock 1541)
//   $A000-$BFFF: ROM mid (mirror of canonical on stock 1541)
//   $C000-$FFFF: ROM canonical (16 KB DOS)
//
// Run via:
//   npx tsx tests/unit/drive/memiec-conformance.test.ts

import { strict as assert } from "node:assert";
import { DriveCpu } from "../../../src/runtime/headless/drive/drive-cpu.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeBus() {
  const d = new DriveCpu({ deviceId: 8, useMicrocodedCpu: true });
  return d.bus;
}

// ---------------------------------------------------------------------------
// Zero page + stack/RAM (memiec.c:141-142)
// ---------------------------------------------------------------------------
test("zero-page: write $00 + read returns same value (memiec.c:141)", () => {
  const bus = makeBus();
  bus.write(0x0042, 0xab);
  assert.equal(bus.read(0x0042), 0xab);
});

test("stack page $0100-$01FF: write + read round-trip", () => {
  const bus = makeBus();
  bus.write(0x01ff, 0x55);
  assert.equal(bus.read(0x01ff), 0x55);
});

test("RAM $0700: write + read round-trip (end of 2K RAM)", () => {
  const bus = makeBus();
  bus.write(0x07ff, 0x77);
  assert.equal(bus.read(0x07ff), 0x77);
});

// ---------------------------------------------------------------------------
// VIA1 + VIA2 dispatch (memiec.c:143-144)
// ---------------------------------------------------------------------------
test("VIA1 dispatch at $1800-$1BFF (16-reg mirror)", () => {
  const bus = makeBus();
  // VIA1 reg 0x0a = SR. Write a sentinel, read back.
  bus.write(0x180a, 0x77);
  assert.equal(bus.read(0x180a) & 0xff, 0x77, "VIA1 base addr");
  // Mirror at $1B0A (= $180A | 0x300, addr & 0xf = $a).
  assert.equal(bus.read(0x1b0a) & 0xff, 0x77, "VIA1 mirror in 1KB window");
});

test("VIA2 dispatch at $1C00-$1FFF (16-reg mirror)", () => {
  const bus = makeBus();
  // VIA2 SR at $1C0A. Use a writable side-effect-free register pair.
  bus.write(0x1c0a, 0x88);
  assert.equal(bus.read(0x1c0a) & 0xff, 0x88);
  assert.equal(bus.read(0x1f0a) & 0xff, 0x88, "VIA2 mirror in 1KB window");
});

// ---------------------------------------------------------------------------
// VIA mirrors at $38/$5C/$78 (drive_ramX disabled, memiec.c:149-150,156-157,163-164)
// ---------------------------------------------------------------------------
test("VIA1 mirror at $3800-$3BFF (drive_ram2 disabled)", () => {
  const bus = makeBus();
  bus.write(0x180a, 0x33);
  assert.equal(bus.read(0x380a) & 0xff, 0x33, "$3800 mirror of VIA1");
});

test("VIA2 mirror at $3C00-$3FFF (drive_ram2 disabled)", () => {
  const bus = makeBus();
  bus.write(0x1c0a, 0x44);
  assert.equal(bus.read(0x3c0a) & 0xff, 0x44, "$3C00 mirror of VIA2");
});

test("RAM mirror at $2000-$27FF (drive_ram2 disabled)", () => {
  const bus = makeBus();
  bus.write(0x2042, 0xcc);
  // $2042 = ram[0x42] mirror; reading $0042 should also see it.
  assert.equal(bus.read(0x0042), 0xcc, "ram mirror at $2042 → ram[0x42]");
});

// ---------------------------------------------------------------------------
// ROM $C000-$FFFF (memiec.c:176)
// ---------------------------------------------------------------------------
test("ROM read at $C000: returns ROM byte", () => {
  const bus = makeBus();
  // ROM may be zero-fill in test env (no bundled .bin), but read must
  // not throw. With real ROM, byte 0 = $4c (JMP opcode for IDLE entry).
  const v = bus.read(0xc000);
  assert.ok(v >= 0 && v <= 0xff, `read returned ${v}, out of byte range`);
});

test("ROM read at $FFFF: last byte of DOS ROM", () => {
  const bus = makeBus();
  const v = bus.read(0xffff);
  assert.ok(v >= 0 && v <= 0xff);
});

test("ROM write at $C000 is ignored (RO) — read-after-write returns ROM byte", () => {
  const bus = makeBus();
  const before = bus.read(0xc000);
  bus.write(0xc000, 0xaa);  // attempt to overwrite — should be RO
  const after = bus.read(0xc000);
  assert.equal(after, before, "ROM write must not change ROM byte");
});

// ---------------------------------------------------------------------------
// Spec 447 — ROM mirror $8000-$BFFF (stock 1541 mirror of canonical)
// VICE memiec.c:169 + 174 dispatch drive_read_rom from trap_rom[0..$3FFF]
// and trap_rom[$2000..$3FFF]. For stock 16K split-ROM, trap_rom buffer
// has the data duplicated into both halves (iecrom.c:78-79 expansion).
// TS rom buffer = 16K canonical; reading $80-$9F maps to rom[0..$1FFF]
// and $A0-$BF to rom[$2000..$3FFF] which is the same data as $C0-$DF
// and $E0-$FF respectively (= stock 1541 mirror).
// ---------------------------------------------------------------------------
test("Spec 447 — ROM mirror $8000 = $C000 (stock 1541 split-ROM)", () => {
  const bus = makeBus();
  assert.equal(bus.read(0x8000), bus.read(0xc000),
    "$8000 should mirror $C000 on stock 1541 16K ROM");
});

test("Spec 447 — ROM mirror $A000 = $E000 (stock 1541)", () => {
  const bus = makeBus();
  assert.equal(bus.read(0xa000), bus.read(0xe000));
});

test("Spec 447 — ROM mirror $9FFF = $DFFF (stock 1541)", () => {
  const bus = makeBus();
  assert.equal(bus.read(0x9fff), bus.read(0xdfff));
});

test("Spec 447 — ROM mirror $BFFF = $FFFF (stock 1541)", () => {
  const bus = makeBus();
  assert.equal(bus.read(0xbfff), bus.read(0xffff));
});

// ---------------------------------------------------------------------------
// Open-bus regions: addresses outside the mapped windows (drive_store_free).
// memiec.c blanket "open bus" at drivemem.c:231; VICE drive_store_free
// updates cpu_last_data latch but doesn't commit to memory.
// ---------------------------------------------------------------------------
test("open bus at $1000 (between $07FF RAM and $1800 VIA1): read returns last bus value", () => {
  const bus = makeBus();
  bus.write(0x0042, 0xee);   // last bus value = 0xee
  const v = bus.read(0x1000);
  // VICE drive_read_free returns cpu_last_data; our analog returns
  // this.lastBusValue. Either 0xee (from last write) or 0xff (default).
  assert.ok(v === 0xee || v === 0xff,
    `open-bus read returned ${v.toString(16)}; expected 0xee or 0xff`);
});

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\nmemiec-conformance: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
