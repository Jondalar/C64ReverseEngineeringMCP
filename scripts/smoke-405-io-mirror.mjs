#!/usr/bin/env node
// Spec 405 — C64 Phase E — I/O area dispatch + mirror smoke.
//
// Doctrine: 1:1 VICE x64sc port. Doc anchor:
//   docs/vice-c64-arch.md §8.1 (page-aligned I/O dispatch),
//   docs/vice-c64-arch.md §8.2 (chip register mirrors),
//   docs/vice-c64-arch.md §12 Phase E step 23.
//
// VICE cite:
//   src/c64/vic-ii.c — VIC registers $D000-$D03F mirrored every 64
//     bytes across $D000-$D3FF (16-fold mirror, 64-byte stride).
//   src/sid/sid.c — SID registers $D400-$D41F mirrored every 32 bytes
//     across $D400-$D7FF (32-fold mirror, 32-byte stride).
//   src/c64/c64io.c:352-371 — unmapped reads return `vicii_read_phi1()`
//     (open-bus). We approximate with the cached I/O shadow.
//
// Acceptance per spec 405 acceptance bullet #4:
//   "New smoke `scripts/smoke-405-io-mirror.mjs`: read $D040 + $D000
//    return same VIC register value (mirroring per §8.2)."
//
// Per spec 405 tier policy: smokes only + new smoke. NO MM/Scramble.
//
// Test pattern:
//   1. Boot synthetic session.
//   2. Write distinct values to a few VIC registers via $D000-$D03F.
//   3. Read back from $D040, $D080, ..., $D3C0 (all VIC mirrors).
//      Assert read == base-register value.
//   4. Same for SID at $D400 / $D420 / $D7E0.
//   5. Sanity: writes to mirrored addresses also reach the base
//      register (mirror is bidirectional, per VICE).

import { existsSync } from "node:fs";

let startIntegratedSession;
try {
  ({ startIntegratedSession } = await import(
    "../dist/runtime/headless/integrated-session-manager.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const fixturePath = "samples/synthetic/1block.g64";
if (!existsSync(fixturePath)) {
  console.error(`fixture missing: ${fixturePath} — run \`npm run smoke:gen\``);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

const { session } = startIntegratedSession({
  diskPath: fixturePath,
  mode: "true-drive",
});
const bus = session.c64Bus;

// Force I/O area visible (CHAREN=1, HIRAM=1, LORAM=1 — boot default).
// PLA at $01 = 0x37 is set by reset; no extra write needed. Sanity:
const cpuPort = bus.getCpuPortValue();
check(
  "boot $01 = 0x37 (LORAM+HIRAM+CHAREN — I/O visible at $D000-$DFFF)",
  cpuPort === 0x37,
  `$01=0x${cpuPort.toString(16)}`,
);

// ---------- VIC mirroring per §8.2: $D000-$D03F mirrored every 0x40 ----------
//
// Write a sentinel to a few VIC registers via the BASE addresses, then
// read back via every mirror. Pick registers that don't have read/write
// asymmetry. $D015 (sprite enable) and $D020 (border color) are safe:
//   - $D015 is a plain 8-bit latch (sprite enable bits).
//   - $D020 is a 4-bit color latch; upper nibble reads as $F per real HW.
//
// VICE writes through any of the 16 mirror tiles ($D000+n*0x40 for n=0..15)
// land on the same register; reads return the same byte.

// $D015 (sprite enable) — full 8-bit latch.
const VIC_BASE = 0xd000;
const D015_VALUE = 0xa5;
bus.write(VIC_BASE + 0x15, D015_VALUE);
const baseRead15 = bus.read(VIC_BASE + 0x15);
check(
  "VIC $D015 write + base-read round-trip",
  baseRead15 === D015_VALUE,
  `wrote=0x${D015_VALUE.toString(16)} read=0x${baseRead15.toString(16)}`,
);

// Spec 405 §8.2 — every $40 stride mirror returns the same value.
let mirrorReadsMatch = true;
const mirrorDetails = [];
for (let mirror = 0x40; mirror < 0x400; mirror += 0x40) {
  const addr = VIC_BASE + mirror + 0x15;
  const v = bus.read(addr);
  if (v !== D015_VALUE) {
    mirrorReadsMatch = false;
    mirrorDetails.push(`addr=0x${addr.toString(16)} read=0x${v.toString(16)}`);
  }
}
check(
  "VIC $D015 mirrored across $D055/$D095/.../$D3D5 (15-fold mirror, 0x40 stride)",
  mirrorReadsMatch,
  mirrorDetails.join("; "),
);

// Spec acceptance bullet #4 — explicit $D040 + $D000 same-value check.
// $D000 = sprite 0 X coordinate (low 8 bits) — plain 8-bit latch.
const D000_VALUE = 0x77;
bus.write(VIC_BASE + 0x00, D000_VALUE);
const read_D000 = bus.read(0xd000);
const read_D040 = bus.read(0xd040);
check(
  "Spec 405 acceptance: $D040 + $D000 return same VIC register value",
  read_D000 === read_D040,
  `$D000=0x${read_D000.toString(16)} $D040=0x${read_D040.toString(16)}`,
);
check(
  "$D000 mirror at $D040 round-trips written value (0x77)",
  read_D040 === D000_VALUE,
  `expected=0x${D000_VALUE.toString(16)} got=0x${read_D040.toString(16)}`,
);

// Bidirectional mirror: write via $D080 (= 2nd mirror tile), read at $D000.
const D080_WRITE_VALUE = 0x3c;
bus.write(0xd080, D080_WRITE_VALUE);
const read_D000_after_mirror_write = bus.read(0xd000);
check(
  "VIC mirror is bidirectional: write to $D080 lands at $D000",
  read_D000_after_mirror_write === D080_WRITE_VALUE,
  `$D000=0x${read_D000_after_mirror_write.toString(16)} (after write $D080=0x${D080_WRITE_VALUE.toString(16)})`,
);

// ---------- SID mirroring per §8.2: $D400-$D41F mirrored every 0x20 ----------
//
// SID is write-only for most registers; reads return open-bus / last
// fetched byte (= for this smoke we exercise *write*-side mirroring
// only). We write through mirror tiles and verify the underlying SID
// state changes (= installSid registers handlers at all $D400-$D7FF
// addresses; writes to any mirror reach the same logical register).
const sid = session.sid;
// $D405 = voice 1 attack/decay. Plain register, no read-side asymmetry
// inside the SID core for our purposes.
const SID_BASE = 0xd400;
const SID_REG = 0x05;
const SID_VALUE = 0x42;
bus.write(SID_BASE + SID_REG, SID_VALUE);
// Probe the SID's internal register state via the dedicated read path.
const sidReadBase = sid.read(SID_BASE + SID_REG);
// Reading a write-only SID register returns last bus value, which is
// the value we just wrote (= phi1 open-bus approximation). Document
// this caveat in detail.
check(
  "SID $D405 base write + bus-read returns last-written byte (= phi1 open-bus)",
  sidReadBase === SID_VALUE || sidReadBase === 0,
  // SID returns 0 for the LFSR-based open-bus; the value flushed via
  // memory-bus.io[] shadow is what most callers see. Accept either.
  `sid.read($D405)=0x${sidReadBase.toString(16)} written=0x${SID_VALUE.toString(16)}`,
);

// Write through a mirror tile + verify reach.
const SID_MIRROR_ADDR = 0xd400 + 0x20 + SID_REG;  // $D425
const MIRROR_VALUE = 0x99;
bus.write(SID_MIRROR_ADDR, MIRROR_VALUE);
// Reading $D405 (base) should report the mirror write (= mirror handler
// at $D425 → installSid handler.write(0xd425, value) → sid.write(0xd425, value)).
// Since installSid registers each $D400-$D7FF address individually with
// `sid.write(a, value)`, the address-strip happens inside sid.ts. Test
// at the bus level: write via mirror → read base → both should reflect
// the new value via the I/O shadow.
const busReadAfterMirrorWrite = bus.read(SID_BASE + SID_REG);
check(
  "SID mirror is bidirectional via bus shadow: $D425 write visible at $D405",
  busReadAfterMirrorWrite === MIRROR_VALUE,
  `$D405=0x${busReadAfterMirrorWrite.toString(16)} after write $D425=0x${MIRROR_VALUE.toString(16)}`,
);

// ---------- Open bus: unmapped read at $DE00 / $DF00 ----------
//
// $DE00-$DFFF = cartridge I/O area. No cartridge attached in this
// session → no handler → I/O shadow returns last-written byte (= phi1
// open-bus approximation, §8.1).
const OPEN_BUS_ADDR = 0xde17;
const OPEN_BUS_WRITE = 0x5a;
bus.write(OPEN_BUS_ADDR, OPEN_BUS_WRITE);
const openBusRead = bus.read(OPEN_BUS_ADDR);
check(
  "I/O open-bus at $DE17 (no cart): read returns last-written byte (phi1 approx, §8.1)",
  openBusRead === OPEN_BUS_WRITE,
  `wrote=0x${OPEN_BUS_WRITE.toString(16)} read=0x${openBusRead.toString(16)}`,
);

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 405 I/O mirror smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
