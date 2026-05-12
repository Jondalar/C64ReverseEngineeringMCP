// Spec 062 Sprint 60 smoke — drive CPU + RAM/ROM + VIA register skeleton.
//
// What this proves:
// - Drive 6502 instance runs in isolation (no IEC bus, no IRQ).
// - Drive bus maps RAM ($0000-$07FF), VIA1 ($1800), VIA2 ($1C00), ROM ($C000).
// - VIA register R/W with DDR awareness.
// - Cycle counter ticks correctly.
// - ROM loader resolves bundled binary OR falls back to zero-fill.

import assert from "node:assert/strict";
import { DriveCpu } from "../dist/runtime/headless/drive/drive-cpu.js";
import { VIA_DDRA, VIA_ORA } from "../dist/runtime/headless/drive/via6522.js";
import { loadDriveRom, DRIVE_ROM_SIZE } from "../dist/runtime/headless/drive/drive-rom.js";

// ---- Test 1: drive RAM read/write through CPU ----
{
  const drive = new DriveCpu();
  // Hand-assembled program at $0500: write $42 to $0700, read it back into A.
  //   A9 42       LDA #$42
  //   8D 00 07    STA $0700
  //   AD 00 07    LDA $0700
  //   00          BRK
  const program = [0xa9, 0x42, 0x8d, 0x00, 0x07, 0xad, 0x00, 0x07, 0x00];
  for (let i = 0; i < program.length; i++) drive.bus.ram[0x0500 + i] = program[i];
  drive.cpu.reset(0x0500);
  // Step 3 instructions (LDA, STA, LDA). 4th = BRK which calls IRQ vector — skip.
  for (let i = 0; i < 3; i++) drive.step();
  assert.equal(drive.bus.ram[0x0700], 0x42, "STA $0700 wrote correctly");
  assert.equal(drive.cpu.a, 0x42, "LDA $0700 read back correctly");
  console.log("  ✓ RAM round-trip through CPU");
}

// ---- Test 2: VIA1 register R/W with DDR + ORA semantics ----
{
  const drive = new DriveCpu();
  // Program: write DDR=$FF (all output), ORA=$AA, then read $1801 back.
  //   A9 FF       LDA #$FF
  //   8D 03 18    STA $1803  (DDRA)
  //   A9 AA       LDA #$AA
  //   8D 01 18    STA $1801  (ORA)
  //   AD 01 18    LDA $1801  (read back: pin state = OR latch on output bits)
  //   00          BRK
  const program = [
    0xa9, 0xff, 0x8d, 0x03, 0x18,
    0xa9, 0xaa, 0x8d, 0x01, 0x18,
    0xad, 0x01, 0x18,
    0x00,
  ];
  for (let i = 0; i < program.length; i++) drive.bus.ram[0x0500 + i] = program[i];
  drive.cpu.reset(0x0500);
  for (let i = 0; i < 5; i++) drive.step();
  assert.equal(drive.bus.via1.ddra, 0xff, "DDRA = $FF");
  assert.equal(drive.bus.via1.ora, 0xaa, "ORA = $AA");
  assert.equal(drive.cpu.a, 0xaa, "Read-back of all-output port returns OR latch");
  console.log("  ✓ VIA1 DDR + ORA round-trip");
}

// ---- Test 3: VIA1 input bits return live pin state when DDR = 0 ----
{
  const drive = new DriveCpu(); // device 8 → PB5/PB6 jumpers both high
  // DDR = $00 (all input), read $1800 (PB) — should return DEFAULT_VIA1_PB_INPUT
  // = $FF (all-high default with device-8 jumpers also high).
  const program = [0xa9, 0x00, 0x8d, 0x02, 0x18, 0xad, 0x00, 0x18, 0x00];
  for (let i = 0; i < program.length; i++) drive.bus.ram[0x0500 + i] = program[i];
  drive.cpu.reset(0x0500);
  for (let i = 0; i < 3; i++) drive.step();
  assert.equal(drive.cpu.a, 0xff, "All-input PB read returns default-high pin state");
  console.log("  ✓ VIA1 input pin state respected when DDR=0");
}

// ---- Test 4: VIA2 also reachable at $1C00 (same skeleton) ----
{
  const drive = new DriveCpu();
  // Write $55 to ORA at $1C01, read back. (DDR not set → for a write,
  // OR-latch updates regardless; readback returns the latch since DDR=0
  // bits read pin-state which is also $55-projection... no, actually:
  // for input bits the read returns pin state, not OR-latch. So with
  // DDR=0, read returns 0x00 (stub PA pins return 0x00) regardless of
  // what we wrote to ORA.)
  // To test the latch, set DDR=$FF first.
  const program = [
    0xa9, 0xff, 0x8d, 0x03, 0x1c,
    0xa9, 0x55, 0x8d, 0x01, 0x1c,
    0xad, 0x01, 0x1c,
    0x00,
  ];
  for (let i = 0; i < program.length; i++) drive.bus.ram[0x0500 + i] = program[i];
  drive.cpu.reset(0x0500);
  for (let i = 0; i < 5; i++) drive.step();
  assert.equal(drive.bus.via2.ora, 0x55, "VIA2 ORA = $55");
  assert.equal(drive.cpu.a, 0x55, "VIA2 read-back from $1C01");
  console.log("  ✓ VIA2 register space at $1C00 works");
}

// ---- Test 5: ROM loader produces 16KB regardless of source ----
{
  const rom = loadDriveRom();
  assert.equal(rom.bytes.length, DRIVE_ROM_SIZE, `ROM is ${DRIVE_ROM_SIZE} bytes`);
  console.log(`  ✓ ROM loader works (source: ${rom.source}${rom.path ? `, path: ${rom.path}` : ""})`);
}

// ---- Test 6: ROM mapped at $C000-$FFFF in drive bus ----
{
  // Use a synthetic ROM for predictable bytes.
  const rom = new Uint8Array(DRIVE_ROM_SIZE);
  rom[0] = 0xab;        // $C000
  rom[0x3fff] = 0xcd;   // $FFFF
  const drive = new DriveCpu({ romBytes: rom });
  assert.equal(drive.bus.read(0xc000), 0xab, "ROM byte at $C000");
  assert.equal(drive.bus.read(0xffff), 0xcd, "ROM byte at $FFFF");
  // Writes to ROM region are ignored.
  drive.bus.write(0xc000, 0xff);
  assert.equal(drive.bus.read(0xc000), 0xab, "ROM is read-only");
  console.log("  ✓ ROM mapped read-only at $C000-$FFFF");
}

// ---- Test 7: Cycle counter advances ----
{
  const drive = new DriveCpu();
  // NOP NOP NOP at $0500, each = 2 cycles
  for (let i = 0; i < 3; i++) drive.bus.ram[0x0500 + i] = 0xea;
  drive.cpu.reset(0x0500);
  const before = drive.cpu.cycles;
  for (let i = 0; i < 3; i++) drive.step();
  assert.equal(drive.cpu.cycles - before, 6, "3× NOP = 6 cycles");
  console.log("  ✓ Cycle counter ticks");
}

console.log("Sprint 60 smoke (drive CPU + RAM/ROM + VIA register skeleton) OK");
