// Sprint 113 / Spec 146 follow-up — PLA banking + write-thru ROM unit tests.
//
// Verifies HeadlessMemoryBus matches VICE truth table for all 8 lower-3-bit
// modes (no-cart) plus motm-relevant write-thru behavior at $A000-$BFFF and
// $E000-$FFFF, and the VICE-equivalent $00/$01 read formula.
//
// VICE source cited per test:
// - c64mem.c:216 — mem_config = (((~dir | data) & 7) | (export.exrom<<3) | (export.game<<4))
// - c64mem.c:893-933 — chargen mapped at configs {1,2,3,9,10,11,26,27}
// - c64meminit.c:140-272 — BASIC at {3,7,11,15}, KERNAL at {2,3,6,7,10,11,14,15,26,27,30,31}
// - c64meminit.c:96-101 — io_config[]; IO at {5,6,7,13,14,15,29,30,31}
// - c64pla.c:53-55 — data_read = (data | ~dir) & (data_out | pullup), pullup=0x17
//
// Standalone runner — no jest framework. Run via:
//   npx tsx tests/unit/c64/pla-banking.test.ts

import { strict as assert } from "node:assert";
import { HeadlessMemoryBus } from "../../../src/runtime/headless/memory-bus.js";

interface Case { name: string; run: () => void }
const cases: Case[] = [];
function test(name: string, run: () => void): void { cases.push({ name, run }); }

function makeBus(): HeadlessMemoryBus {
  const bus = new HeadlessMemoryBus();
  // Mark BASIC / KERNAL / CHAR with distinct high nibbles so the read source
  // is testable. Values: BASIC = 0xB?, KERNAL = 0xE?, CHAR = 0xC?.
  const basic = new Uint8Array(0x2000);
  for (let i = 0; i < basic.length; i++) basic[i] = 0xB0 | (i & 0x0F);
  bus.loadBasicRom(basic);
  const kernal = new Uint8Array(0x2000);
  for (let i = 0; i < kernal.length; i++) kernal[i] = 0xE0 | (i & 0x0F);
  bus.loadKernalRom(kernal);
  const charRom = new Uint8Array(0x1000);
  for (let i = 0; i < charRom.length; i++) charRom[i] = 0xC0 | (i & 0x0F);
  bus.loadCharRom(charRom);
  return bus;
}

// helper: write banking byte to $01, leaving DDR at default $2F.
function setMode(bus: HeadlessMemoryBus, mode: number): void {
  bus.write(0x0001, mode & 0xff);
}

// ----- 8 no-cart banking modes (lower 3 bits of $01 with DDR=$2F) -----

interface ModeExpect {
  loramHiramCharen: [number, number, number];
  a000: "RAM" | "BASIC";
  d000: "RAM" | "IO" | "CHAR";
  e000: "RAM" | "KERNAL";
}

// Per VICE c64mem.c truth table, no-cart, mem_config = lo3.
const noCartTable: Record<number, ModeExpect> = {
  // (LORAM, HIRAM, CHAREN)
  0: { loramHiramCharen: [0, 0, 0], a000: "RAM",   d000: "RAM",  e000: "RAM"    },
  1: { loramHiramCharen: [1, 0, 0], a000: "RAM",   d000: "CHAR", e000: "RAM"    },
  2: { loramHiramCharen: [0, 1, 0], a000: "RAM",   d000: "CHAR", e000: "KERNAL" },
  3: { loramHiramCharen: [1, 1, 0], a000: "BASIC", d000: "CHAR", e000: "KERNAL" },
  4: { loramHiramCharen: [0, 0, 1], a000: "RAM",   d000: "RAM",  e000: "RAM"    },
  5: { loramHiramCharen: [1, 0, 1], a000: "RAM",   d000: "IO",   e000: "RAM"    },
  6: { loramHiramCharen: [0, 1, 1], a000: "RAM",   d000: "IO",   e000: "KERNAL" },
  7: { loramHiramCharen: [1, 1, 1], a000: "BASIC", d000: "IO",   e000: "KERNAL" },
};

function expectSource(bus: HeadlessMemoryBus, addr: number, expected: ModeExpect[keyof ModeExpect[Extract<keyof ModeExpect, "a000" | "d000" | "e000">]] | string): void {
  const v = bus.read(addr);
  switch (expected) {
    case "BASIC":
      assert.equal(v & 0xF0, 0xB0, `addr $${addr.toString(16)}: expected BASIC, got $${v.toString(16)}`);
      break;
    case "KERNAL":
      assert.equal(v & 0xF0, 0xE0, `addr $${addr.toString(16)}: expected KERNAL, got $${v.toString(16)}`);
      break;
    case "CHAR":
      assert.equal(v & 0xF0, 0xC0, `addr $${addr.toString(16)}: expected CHAR ROM, got $${v.toString(16)}`);
      break;
    case "IO":
      // I/O default values vary; just assert it's NOT a ROM signature.
      assert.ok((v & 0xF0) !== 0xB0 && (v & 0xF0) !== 0xE0 && (v & 0xF0) !== 0xC0,
        `addr $${addr.toString(16)}: expected I/O, got ROM-shape $${v.toString(16)}`);
      break;
    case "RAM":
      // RAM at $A000/$D000/$E000 was filled by reset() pattern; just assert
      // it's NOT a ROM signature (would catch BASIC/KERNAL/CHAR leakage).
      assert.ok((v & 0xF0) !== 0xB0 && (v & 0xF0) !== 0xE0 && (v & 0xF0) !== 0xC0,
        `addr $${addr.toString(16)}: expected RAM, got ROM-shape $${v.toString(16)}`);
      break;
  }
}

for (const [modeStr, exp] of Object.entries(noCartTable)) {
  const lo3 = Number(modeStr);
  const port = 0x30 | lo3; // upper bits set; lo3 picks banking
  test(`mode lo3=${lo3} ($01=$${port.toString(16)}): $A000 = ${exp.a000}`, () => {
    const bus = makeBus();
    setMode(bus, port);
    expectSource(bus, 0xA000, exp.a000);
    expectSource(bus, 0xA100, exp.a000); // mid-bank address
  });
  test(`mode lo3=${lo3} ($01=$${port.toString(16)}): $D000 = ${exp.d000}`, () => {
    const bus = makeBus();
    setMode(bus, port);
    expectSource(bus, 0xD000, exp.d000);
    if (exp.d000 === "CHAR") {
      // mid-chargen addr — verify we hit chargen array, not just $D000.
      expectSource(bus, 0xD800, exp.d000);
    }
  });
  test(`mode lo3=${lo3} ($01=$${port.toString(16)}): $E000 = ${exp.e000}`, () => {
    const bus = makeBus();
    setMode(bus, port);
    expectSource(bus, 0xE000, exp.e000);
    expectSource(bus, 0xFFFA, exp.e000); // NMI vector slot — motm-relevant
    expectSource(bus, 0xFFFE, exp.e000); // IRQ vector slot
  });
}

// ----- write-thru-ROM (motm-critical) -----

test("write-thru-ROM at $FFFA in mode $36 (KERNAL mapped) persists into RAM", () => {
  const bus = makeBus();
  // mode $36 = lo3 6 = LORAM=0, HIRAM=1, CHAREN=1 → KERNAL + IO at $D000.
  setMode(bus, 0x36);
  // Read first to confirm KERNAL is mapped (returns $E?).
  assert.equal(bus.read(0xFFFA) & 0xF0, 0xE0, "KERNAL mapped pre-write");
  // Write the byte: should write thru to RAM, not affect KERNAL ROM bytes.
  bus.write(0xFFFA, 0x11);
  bus.write(0xFFFB, 0x22);
  // Read still returns KERNAL while still in mode 6.
  assert.equal(bus.read(0xFFFA) & 0xF0, 0xE0, "KERNAL still mapped post-write");
  // Switch to all-RAM (mode $34: LORAM=0, HIRAM=0, CHAREN=1).
  setMode(bus, 0x34);
  assert.equal(bus.read(0xFFFA), 0x11, "$FFFA reads written RAM byte after KERNAL unmap");
  assert.equal(bus.read(0xFFFB), 0x22, "$FFFB reads written RAM byte after KERNAL unmap");
});

test("write-thru-ROM at $A000 in mode $37 (BASIC mapped) persists into RAM", () => {
  const bus = makeBus();
  // mode $37 = lo3 7 = LORAM=1, HIRAM=1, CHAREN=1 → BASIC + IO + KERNAL.
  setMode(bus, 0x37);
  assert.equal(bus.read(0xA000) & 0xF0, 0xB0, "BASIC mapped pre-write");
  bus.write(0xA000, 0x33);
  bus.write(0xA1FF, 0x44);
  assert.equal(bus.read(0xA000) & 0xF0, 0xB0, "BASIC still mapped post-write");
  // Switch to all-RAM mode $34 (LORAM=0, HIRAM=0, CHAREN=1).
  setMode(bus, 0x34);
  assert.equal(bus.read(0xA000), 0x33, "$A000 reads written RAM byte after BASIC unmap");
  assert.equal(bus.read(0xA1FF), 0x44, "$A1FF reads written RAM byte after BASIC unmap");
});

test("write-thru-CHARROM at $D000 in mode $33 persists into RAM", () => {
  const bus = makeBus();
  // mode $33 = lo3 3 = LORAM=1, HIRAM=1, CHAREN=0 → BASIC + CHAR + KERNAL.
  setMode(bus, 0x33);
  assert.equal(bus.read(0xD000) & 0xF0, 0xC0, "char ROM mapped pre-write");
  bus.write(0xD000, 0x55);
  bus.write(0xD800, 0x66);
  // Char ROM is read-only; reads still return chargen.
  assert.equal(bus.read(0xD000) & 0xF0, 0xC0, "char ROM still mapped post-write");
  // Switch to all-RAM mode $34.
  setMode(bus, 0x34);
  assert.equal(bus.read(0xD000), 0x55, "$D000 reads written RAM byte after char ROM unmap");
  assert.equal(bus.read(0xD800), 0x66, "$D800 reads written RAM byte after char ROM unmap");
});

test("motm scenario: $36 vector-write then $14 (all RAM) reads vectors", () => {
  // motm-style: install IRQ vector at $FFFE/$FFFF in mode $16 (KERNAL mapped),
  // then flip to mode $14 (all RAM) — vectors must still read back.
  // mode $16 = LORAM=0 HIRAM=1 CHAREN=1 → KERNAL + IO.
  // mode $14 = LORAM=0 HIRAM=0 CHAREN=1 → all RAM, IO out.
  const bus = makeBus();
  setMode(bus, 0x36);
  bus.write(0xFFFE, 0xAB);
  bus.write(0xFFFF, 0xCD);
  setMode(bus, 0x34);
  assert.equal(bus.read(0xFFFE), 0xAB);
  assert.equal(bus.read(0xFFFF), 0xCD);
});

// ----- $00/$01 CPU port DDR semantics (VICE c64pla.c:53-55) -----

test("$00 read returns latched DDR (default $2F)", () => {
  const bus = makeBus();
  assert.equal(bus.read(0x0000), 0x2F);
});

test("$00 write+read DDR=$FF round-trips", () => {
  const bus = makeBus();
  bus.write(0x0000, 0xFF);
  assert.equal(bus.read(0x0000), 0xFF);
});

test("$01 read default = $37 (DDR=$2F, DATA=$37, pullup=$17)", () => {
  // VICE: data_out = data & dir = 0x37 & 0x2F = 0x27.
  // data_read = (data | ~dir) & (data_out | pullup)
  //           = (0x37 | 0xD0) & (0x27 | 0x17)
  //           = 0xF7 & 0x37 = 0x37.
  const bus = makeBus();
  assert.equal(bus.read(0x0001), 0x37);
});

test("$01 read with DDR=$00 returns pullup floor $17 (all input)", () => {
  // VICE: data_out = data & 0 = 0. data_read = (data | 0xFF) & (0 | 0x17) = 0xFF & 0x17 = 0x17.
  // Real HW: input pins float to pullup level. Bits 0,1,2 (LORAM/HIRAM/CHAREN)
  // and bit 4 (tape sense) pulled up; bits 3,5,6,7 float to 0.
  const bus = makeBus();
  bus.write(0x0000, 0x00);
  bus.write(0x0001, 0xFF);
  assert.equal(bus.read(0x0001), 0x17, `expected pullup-floor $17`);
});

test("$01 read with DDR=$FF returns latched data byte exactly", () => {
  // VICE: data_out = data & 0xFF = data. data_read = (data | 0) & (data | 0x17) = data | (extra pullup AND data).
  // For data=$05: (0x05) & (0x05|0x17) = 0x05 & 0x17 = 0x05.
  const bus = makeBus();
  bus.write(0x0000, 0xFF);
  bus.write(0x0001, 0x05);
  assert.equal(bus.read(0x0001), 0x05);
  bus.write(0x0001, 0xA5);
  // (0xA5) & (0xA5 | 0x17) = 0xA5 & 0xB7 = 0xA5.
  assert.equal(bus.read(0x0001), 0xA5);
});

test("banking honors (~dir|data)&7 not raw data when DDR has input bits", () => {
  // DDR=$28 (bit 5 + bit 3 output, lower 3 bits all input).
  // DATA=$00. With raw-data computation we'd read lo3=0 → all RAM.
  // With (~dir|data)&7 we get (~0x28|0x00)&7 = 0xD7 & 7 = 7 → BASIC+IO+KERNAL.
  const bus = makeBus();
  bus.write(0x0000, 0x28);
  bus.write(0x0001, 0x00);
  // Per VICE: lo3 input bits forced high, so banking sees lo3=7.
  assert.equal(bus.read(0xA000) & 0xF0, 0xB0, "BASIC mapped (LORAM/HIRAM input forced high)");
  assert.equal(bus.read(0xE000) & 0xF0, 0xE0, "KERNAL mapped");
});

// ----- runner --------------------------------------------------------------
let pass = 0, fail = 0;
for (const c of cases) {
  try { c.run(); pass++; console.log(`  PASS ${c.name}`); }
  catch (e) { fail++; console.log(`  FAIL ${c.name}: ${(e as Error).message}`); }
}
console.log(`\npla-banking: ${pass}/${cases.length} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
