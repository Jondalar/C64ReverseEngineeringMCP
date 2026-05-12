#!/usr/bin/env node
// Spec 408 — 1541 Phase B (CPU and memory) drive memory dispatch smoke.
//
// Doctrine: 1:1 VICE TDE port. Doc anchors:
//   docs/vice-1541-arch.md §4.1 (physical 1541 layout),
//                          §4.2 (dispatch tables),
//                          §4.3 (ROM loading),
//                          §13 Phase B steps 4-6,
//                          §14 invariant 8 (open bus on unmapped pages).
//
// VICE cite: src/drive/drivemem.c:217 drivemem_init() — blanket all
//            256 pages with drive_read_free / drive_store_free /
//            drive_peek_free; src/drive/iec/memiec.c:138-177
//            memiec_init() — overlay RAM ($00-$07), VIA1 ($18-$1B),
//            VIA2 ($1C-$1F), stock mirrors at $20/$40/$60 blocks,
//            ROM ($C0-$FF) for DRIVE_TYPE_1541 with all
//            drive_ramX_enabled flags = 0.
//
// Test pattern per spec 408 acceptance:
//   1. Construct a DriveBus with a synthetic 16 KB ROM whose bytes
//      encode their offset (rom[i] = i & 0xff).
//   2. For each page in the stock 1541 layout, assert that read /
//      write target the expected dispatcher:
//        - RAM ($0000-$07FF): write → readback returns written byte.
//        - VIA1 ($1800-$1BFF): write → routes to via1.write
//          (verify by reading back a known register, e.g. DDRA at $03).
//        - VIA2 ($1C00-$1FFF): write → routes to via2.write
//          (verify by reading back DDRA at $03).
//        - ROM ($C000-$FFFF): write ignored; read returns synthetic
//          ROM byte = (addr - 0xC000) & 0xff.
//        - Open bus elsewhere ($0800-$17FF, $2800-$37FF, etc.):
//          read returns last bus value (sticky latch).
//   3. Mirror verification: writes to $2000 RAM mirror appear at
//      $0000 too (a14/a15 don't decode on stock); VIA1 mirror at
//      $3800-$3BFF goes to the same VIA1 chip core (verify via DDRB).
//   4. Reset vector: with synthetic ROM placing $A0 at $FFFC and
//      $EA at $FFFD, the drive CPU after reset() has PC=$EAA0.

import { DriveBus, DriveCpu } from "../dist/runtime/headless/drive/drive-cpu.js";

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

// ---- Build a synthetic 16 KB ROM ---------------------------------
// rom[i] = i & 0xff, EXCEPT rom[$3FFC] = $A0, rom[$3FFD] = $EA so the
// reset vector at CPU $FFFC/$FFFD = $EAA0 (1541 ROM reset entry).
function makeSyntheticRom() {
  const rom = new Uint8Array(0x4000);
  for (let i = 0; i < rom.length; i++) rom[i] = i & 0xff;
  rom[0x3ffc] = 0xa0;
  rom[0x3ffd] = 0xea;
  return rom;
}

// ---- Test 1: RAM dispatch ($0000-$07FF) --------------------------
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  // Write a marker to every page of RAM, read back.
  let allRam = true;
  for (let p = 0; p < 0x08; p++) {
    const addr = (p << 8) | 0x42;
    const marker = 0x10 + p;
    bus.write(addr, marker);
    const got = bus.read(addr);
    if (got !== marker) { allRam = false; break; }
  }
  check("RAM $0000-$07FF: write/readback round-trips on every page", allRam);
  // Direct check the underlying ram array reflects the write.
  bus.write(0x0000, 0xa5);
  check("RAM $0000 writes commit to bus.ram[0x0000]", bus.ram[0x0000] === 0xa5);
  bus.write(0x07ff, 0x5a);
  check("RAM $07FF writes commit to bus.ram[0x07FF]", bus.ram[0x07ff] === 0x5a);
}

// ---- Test 2: VIA1 dispatch ($1800-$1BFF) -------------------------
// VIA register 3 = DDRA on the 6522. Write a known mask, read back.
// VIA registers mirror every 16 bytes within the 1 KB window — verify
// by writing at $1800+3 and reading at $1820+3 (= same DDRA).
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  bus.write(0x1803, 0x55); // DDRA
  check("VIA1 $1803 (DDRA) write routes to via1", bus.via1.via.ddra === 0x55);
  // Mirror within window: $1813 = same DDRA (addr & 0xf).
  bus.write(0x1813, 0xaa);
  check("VIA1 $1813 mirrors to DDRA (addr & 0xf)", bus.via1.via.ddra === 0xaa);
  // Page-table dispatch should select via1Read for every page in
  // $18-$1B (4 pages = 1 KB).
  let viaPagesOk = true;
  for (let p = 0x18; p < 0x1c; p++) {
    bus.write((p << 8) | 3, 0x33);
    if (bus.via1.via.ddra !== 0x33) { viaPagesOk = false; break; }
  }
  check("VIA1 dispatch covers pages $18-$1B", viaPagesOk);
}

// ---- Test 3: VIA2 dispatch ($1C00-$1FFF) -------------------------
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  bus.write(0x1c03, 0x77); // DDRA
  check("VIA2 $1C03 (DDRA) write routes to via2", bus.via2.via.ddra === 0x77);
  bus.write(0x1c13, 0xcc);
  check("VIA2 $1C13 mirrors to DDRA (addr & 0xf)", bus.via2.via.ddra === 0xcc);
  let via2PagesOk = true;
  for (let p = 0x1c; p < 0x20; p++) {
    bus.write((p << 8) | 3, 0x44);
    if (bus.via2.via.ddra !== 0x44) { via2PagesOk = false; break; }
  }
  check("VIA2 dispatch covers pages $1C-$1F", via2PagesOk);
}

// ---- Test 4: ROM dispatch ($C000-$FFFF read-only) ----------------
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  // ROM bytes = (addr-$C000) & 0xff.
  check("ROM $C000 reads synthetic byte (= 0x00)", bus.read(0xc000) === 0x00);
  check("ROM $C123 reads synthetic byte (= 0x23)", bus.read(0xc123) === 0x23);
  check("ROM $FFFF reads synthetic byte (= 0xFF)", bus.read(0xffff) === 0xff);
  // Reset-vector slots ($FFFC = $A0, $FFFD = $EA → CPU PC = $EAA0).
  check("ROM $FFFC = $A0 (reset-vector lo)", bus.read(0xfffc) === 0xa0);
  check("ROM $FFFD = $EA (reset-vector hi)", bus.read(0xfffd) === 0xea);
  // Write should be ignored (drive_store_free overrides; ROM unchanged).
  const before = bus.read(0xc100);
  bus.write(0xc100, 0xff);
  const after = bus.read(0xc100);
  check("ROM $C100 write ignored (read-only — drive_store_free)",
        before === after);
  // Page coverage: every page $C0..$FF dispatches via romRead.
  let romPagesOk = true;
  for (let p = 0xc0; p < 0x100; p++) {
    const addr = (p << 8) | 0x77;
    if (bus.read(addr) !== ((addr - 0xc000) & 0xff)) { romPagesOk = false; break; }
  }
  check("ROM dispatch covers pages $C0-$FF (64 pages = 16 KB)", romPagesOk);
}

// ---- Test 5: Open bus on unmapped pages ($14, $30, $50, $70) -----
// Per memiec.c stock layout: pages $08-$17 = open bus; $28-$37 =
// open bus; $48-$57 = open bus; $68-$77 = open bus.
// drive_read_free returns the last data-bus value.
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  // Prime the bus by reading a known ROM byte.
  bus.read(0xc042); // = 0x42
  // First open-bus read should return last bus value (0x42).
  check("Open bus $0800 returns last bus value after priming",
        bus.read(0x0800) === 0x42);
  // drive_store_free updates the latch — next open-bus read sees it.
  bus.write(0x1400, 0x99);
  check("drive_store_free updates open-bus latch", bus.read(0x1500) === 0x99);
  // Verify each documented open-bus block:
  // $0800-$17FF, $2800-$37FF, $4800-$57FF, $6800-$77FF.
  const probes = [
    { lo: 0x08, hi: 0x18, label: "$0800-$17FF" },
    { lo: 0x28, hi: 0x38, label: "$2800-$37FF" },
    { lo: 0x48, hi: 0x58, label: "$4800-$57FF" },
    { lo: 0x68, hi: 0x78, label: "$6800-$77FF" },
  ];
  for (const probe of probes) {
    bus.write(0xc000, 0xc0); // updates lastBusValue via romRead's
                              // store path? — no, ROM store is free.
                              // Use a RAM write to prime the latch.
    bus.write(0x0000, 0x5a); // prime via ram store (updates latch).
    let allOpen = true;
    for (let p = probe.lo; p < probe.hi; p++) {
      const v = bus.read((p << 8) | 0x33);
      if (v !== 0x5a) { allOpen = false; break; }
    }
    check(`Open bus block ${probe.label}: every page returns last bus value`, allOpen);
  }
}

// ---- Test 6: Stock 1541 RAM mirror ($2000-$27FF) ------------------
// memiec.c:148 — with drive_ram2_enabled=0, RAM is mirrored at
// $2000-$27FF (a14/a15 don't decode). Writing $0000 must show up at
// $2000 and vice versa.
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  bus.write(0x0000, 0x11);
  check("RAM mirror $2000 reads from $0000 (a14/a15 don't decode)",
        bus.read(0x2000) === 0x11);
  bus.write(0x2123, 0x77);
  check("RAM mirror $2123 commits to $0123",
        bus.ram[0x0123] === 0x77);
}

// ---- Test 7: Stock VIA mirrors at $3800 / $3C00 -------------------
// memiec.c:149-150 — VIA1 mirrored at $3800-$3BFF, VIA2 at $3C00-$3FFF
// (drive_ram2_enabled=0).
{
  const bus = new DriveBus({ romBytes: makeSyntheticRom() });
  bus.write(0x3803, 0x66); // VIA1 mirror DDRA
  check("VIA1 mirror $3803 → via1.ddra", bus.via1.via.ddra === 0x66);
  bus.write(0x3c03, 0x88); // VIA2 mirror DDRA
  check("VIA2 mirror $3C03 → via2.ddra", bus.via2.via.ddra === 0x88);
  // Spot-check mirror blocks 2 and 3.
  bus.write(0x5803, 0x12);
  check("VIA1 mirror $5803 → via1.ddra", bus.via1.via.ddra === 0x12);
  bus.write(0x7c03, 0x34);
  check("VIA2 mirror $7C03 → via2.ddra", bus.via2.via.ddra === 0x34);
}

// ---- Test 8: Reset vector = $EAA0 via CPU ------------------------
// Spec 408 step 6: on reset, drive 6502 fetches $FFFC/$FFFD into PC.
// Synthetic ROM seeds the vector to $EAA0 (1541 ROM reset entry).
{
  const drive = new DriveCpu({
    romBytes: makeSyntheticRom(),
    useMicrocodedCpu: true,
  });
  drive.reset();
  // Cpu65xxVice uses reg_pc.
  const pc = (drive.cpu.reg_pc ?? drive.cpu.pc) & 0xffff;
  check("Drive CPU reset fetches $FFFC/$FFFD → PC = $EAA0",
        pc === 0xeaa0, `pc=$${pc.toString(16)}`);
}

// ---- Report ------------------------------------------------------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 408 drive-mem dispatch smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
