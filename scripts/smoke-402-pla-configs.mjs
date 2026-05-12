#!/usr/bin/env node
// Spec 402 — PLA config table fidelity smoke.
//
// Doctrine: 1:1 VICE x64sc port. Doc anchors:
//   docs/vice-c64-arch.md §4.1 (16+ memory configurations),
//                       §4.2 (standard configurations table),
//                       §12 Phase B step 6,
//                       §13 invariant 3 (per-page table-driven dispatch).
//
// VICE cite: src/c64/c64mem.c:80 (NUM_CONFIGS=32),
//            src/c64/c64mem.c:83 (NUM_VBANKS=4),
//            src/c64/c64meminit.c (builds mem_read_tab[][] at init).
//
// Acceptance per spec 402: iterate all 16 no-cart configs
// (LORAM|HIRAM|CHAREN combinations × GAME=EXROM=1), write a known
// byte to a marker address, read back via the expected per-config
// path (RAM / KERNAL / BASIC / CHARGEN / I/O). Assert read matches
// the §4.2 table.

import { HeadlessMemoryBus } from "../dist/runtime/headless/memory-bus.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// --- Synthetic ROMs so we can fingerprint each region ---
function makeBusWithSyntheticRoms() {
  const bus = new HeadlessMemoryBus();
  const basic = new Uint8Array(0x2000);
  for (let i = 0; i < basic.length; i++) basic[i] = 0xb0 | (i & 0x0f);
  bus.loadBasicRom(basic);
  const kernal = new Uint8Array(0x2000);
  for (let i = 0; i < kernal.length; i++) kernal[i] = 0xe0 | (i & 0x0f);
  bus.loadKernalRom(kernal);
  const charRom = new Uint8Array(0x1000);
  for (let i = 0; i < charRom.length; i++) charRom[i] = 0xc0 | (i & 0x0f);
  bus.loadCharRom(charRom);
  return bus;
}

// VICE truth table — c64meminit.c header comment (lines 45-65):
//   bit2=CHAREN, bit1=HIRAM, bit0=LORAM (no-cart subcase EXROM=GAME=1).
// VICE rows 0..7 with `bits = (charen<<2)|(hiram<<1)|loram`:
//   0 (000): ram everywhere
//   1 (001) LORAM=1: chr@$D000
//   2 (010) HIRAM=1: chr@$D000, ker@$E000
//   3 (011) LORAM=1+HIRAM=1: bas, chr, ker
//   4 (100) CHAREN=1: ram everywhere
//   5 (101) LORAM=1+CHAREN=1: io@$D000
//   6 (110) HIRAM=1+CHAREN=1: io, ker
//   7 (111) all set: bas, io, ker  (boot default)
//
// Cite: src/c64/c64meminit.c top comment.
// NOTE: docs/vice-c64-arch.md §4.2 column layout was confusing (LORAM/HIRAM
// columns appear in reverse-bit order vs the "$01 2..0" string); the VICE
// source comment is the canonical truth-table.
const TABLE = [
  { bits: 0, bankA: "ram",   bankD: "ram",  bankE: "ram"    },
  { bits: 1, bankA: "ram",   bankD: "char", bankE: "ram"    },
  { bits: 2, bankA: "ram",   bankD: "char", bankE: "kernal" },
  { bits: 3, bankA: "basic", bankD: "char", bankE: "kernal" },
  { bits: 4, bankA: "ram",   bankD: "ram",  bankE: "ram"    },
  { bits: 5, bankA: "ram",   bankD: "io",   bankE: "ram"    },
  { bits: 6, bankA: "ram",   bankD: "io",   bankE: "kernal" },
  { bits: 7, bankA: "basic", bankD: "io",   bankE: "kernal" },
];

// Probe addresses (one byte per window). $D000 chosen so I/O dispatches
// through the registered handler stub; $A000 for BASIC; $E000 for KERNAL.
const PROBE_BASIC  = 0xA000;
const PROBE_CHAR   = 0xD000;
const PROBE_KERNAL = 0xE000;
const PROBE_IO     = 0xD012;   // VIC raster reg (any IO addr works for "is IO routed?")
const PROBE_RAM_A  = 0xA000;
const PROBE_RAM_D  = 0xD000;
const PROBE_RAM_E  = 0xE000;

function classifyA(bus, bits) {
  // Drive memory through PLA: write $01 = ($30 base | bits). $00 = $2F so
  // bits 0..2 are output pins (= latched data feeds PLA).
  bus.write(0x0000, 0x2f);
  bus.write(0x0001, 0x30 | bits);
  // Pre-seed RAM at probe locations with $00 so "RAM" path returns $00.
  bus.ram[PROBE_RAM_A] = 0x00;
  bus.ram[PROBE_RAM_D] = 0x00;
  bus.ram[PROBE_RAM_E] = 0x00;
  const a = bus.read(PROBE_BASIC);
  const d = bus.read(PROBE_CHAR);
  const e = bus.read(PROBE_KERNAL);
  return { a, d, e };
}

function regionTag(addr, value) {
  if (addr === PROBE_BASIC) {
    if ((value & 0xf0) === 0xb0) return "basic";
    if (value === 0x00) return "ram";
    return `unknown($${value.toString(16)})`;
  }
  if (addr === PROBE_CHAR) {
    if ((value & 0xf0) === 0xc0) return "char";
    // IO at $D000 with no VIC handler returns the underlying io[] byte (= 0).
    // Distinguish IO from RAM via handler probe.
    if (value === 0x00) return "io_or_ram";
    return `unknown($${value.toString(16)})`;
  }
  if (addr === PROBE_KERNAL) {
    if ((value & 0xf0) === 0xe0) return "kernal";
    if (value === 0x00) return "ram";
    return `unknown($${value.toString(16)})`;
  }
  return "?";
}

// We separately probe IO vs RAM at $D000 by registering an IO handler
// that returns $5A. If the byte read is $5A under a config that should
// route through IO, the IO path is confirmed.
function makeBusWithIoSentinel() {
  const bus = makeBusWithSyntheticRoms();
  bus.registerIoHandler(0xD012, {
    read: () => 0x5a,
    write: () => {},
  });
  return bus;
}

// ------- §4.2 row-by-row -------
{
  for (const row of TABLE) {
    const bus = makeBusWithIoSentinel();
    const probe = classifyA(bus, row.bits);
    // $A000
    const aRegion = regionTag(PROBE_BASIC, probe.a);
    check(
      `cfg=${row.bits.toString(2).padStart(3,'0')} $A000 region matches §4.2 (got=${aRegion}, expected=${row.bankA})`,
      aRegion === row.bankA,
      `byte=$${probe.a.toString(16)}`,
    );
    // $E000
    const eRegion = regionTag(PROBE_KERNAL, probe.e);
    check(
      `cfg=${row.bits.toString(2).padStart(3,'0')} $E000 region matches §4.2 (got=${eRegion}, expected=${row.bankE})`,
      eRegion === row.bankE,
      `byte=$${probe.e.toString(16)}`,
    );
    // $D000 — distinguish RAM / I/O / Char via separate probes.
    if (row.bankD === "char") {
      check(
        `cfg=${row.bits.toString(2).padStart(3,'0')} $D000 = CharROM byte (CharROM expected)`,
        (probe.d & 0xf0) === 0xc0,
        `byte=$${probe.d.toString(16)}`,
      );
    } else if (row.bankD === "io") {
      // I/O path: read $D012 (VIC raster — our sentinel returns $5A).
      const ioByte = bus.read(PROBE_IO);
      check(
        `cfg=${row.bits.toString(2).padStart(3,'0')} $D012 IO sentinel = $5A (I/O expected)`,
        ioByte === 0x5a,
        `byte=$${ioByte.toString(16)}`,
      );
    } else {
      // RAM path: $D000 returns $00 (pre-seeded).
      check(
        `cfg=${row.bits.toString(2).padStart(3,'0')} $D000 = RAM (probe $00)`,
        probe.d === 0x00,
        `byte=$${probe.d.toString(16)}`,
      );
    }
  }
}

// ------- 32-entry config table sanity -------
{
  const bus = makeBusWithSyntheticRoms();
  const table = bus.getMemConfigTable();
  check(
    "memConfigTable has NUM_CONFIGS=32 entries (c64mem.c:80)",
    table.length === 32,
    `length=${table.length}`,
  );
  // boot default $01=$37 → idx = LORAM|HIRAM|CHAREN | GAME(=1)<<3 | EXROM(=1)<<4 = 7 | 0x18 = 0x1f.
  bus.write(0x0001, 0x37);
  const idx = bus.getMemConfigIndex();
  check(
    `boot default ($01=$37, no cart) → memConfigIndex = $1f (got $${idx.toString(16)})`,
    idx === 0x1f,
  );
  const cfg = bus.getMemConfig();
  check(
    `boot default cfg: BASIC + I/O + Kernal (§4.2 row 7)`,
    cfg.bankA === "basic" && cfg.bankD === "io" && cfg.bankE === "kernal",
    `bankA=${cfg.bankA} bankD=${cfg.bankD} bankE=${cfg.bankE}`,
  );
}

// ------- glue logic default (OQ-402-3) -------
{
  const bus = makeBusWithSyntheticRoms();
  check(
    "default glue logic = 'discrete' (HMOS) per c64gluelogic.c:144 / OQ-402-3",
    bus.getGlueLogic() === "discrete",
    `glueLogic=${bus.getGlueLogic()}`,
  );
}

// ------- Report -------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 402 PLA-configs smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
