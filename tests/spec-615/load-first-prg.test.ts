// Spec 615 §4 #2 — LOAD"<first-prg>",8,1 on POLARBEAR.d64.
// Compare loaded bytes vs D64 sector raw.

import { resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const { startIntegratedSession } = await import(
  "../../dist/runtime/headless/integrated-session-manager.js"
);
const { mountMedia } = await import(
  "../../dist/runtime/headless/media/mount.js"
);

const diskPath = resolvePath(
  import.meta.dirname, "..", "..", "samples/POLARBEAR.d64",
);
const d64 = readFileSync(diskPath);

// D64 sector layout: 256 bytes/sector. Track 18 sector 0 = BAM at offset
// 18*17... no, D64 has variable per-track. Track 18 sector 1 = first directory entry.
// Track 18 starts at offset 0x16500 (decimal 91392) in a 35-track D64.
// Directory entry layout (32 bytes):
//   $00 next track
//   $01 next sector
//   $02 file type ($82 = PRG, closed)
//   $03 track of first block
//   $04 sector of first block
//   $05-$14 filename (PETSCII, padded $A0)
//   ...
// Track 18 sec 1 is at d64 offset = 17*21*256 + 1*256 = 91392+256 = 91648 = 0x16600.
const T18_S1_OFF = 17 * 21 * 256 + 1 * 256;
const firstEntry = d64.subarray(T18_S1_OFF, T18_S1_OFF + 32);
const firstType = firstEntry[0x02];
const firstTrk = firstEntry[0x03];
const firstSec = firstEntry[0x04];
const filenamePetscii = firstEntry.subarray(0x05, 0x15);
const nameClean = filenamePetscii
  .toString("binary")
  .replace(/\xA0+$/, "")
  .toUpperCase();

console.log(`POLARBEAR.d64 first directory entry:`);
console.log(`  type=$${firstType?.toString(16)}, trk=${firstTrk}, sec=${firstSec}`);
console.log(`  name="${nameClean}"`);

// First PRG file's first byte sector. Compute D64 offset.
// PAL track-1-based sector offsets:
// tracks 1-17: 21 sec/trk; 18-24: 19; 25-30: 18; 31-35: 17
function trackOffset(trk: number): number {
  if (trk <= 17) return (trk - 1) * 21 * 256;
  if (trk <= 24) return 17 * 21 * 256 + (trk - 18) * 19 * 256;
  if (trk <= 30) return 17 * 21 * 256 + 7 * 19 * 256 + (trk - 25) * 18 * 256;
  return 17 * 21 * 256 + 7 * 19 * 256 + 6 * 18 * 256 + (trk - 31) * 17 * 256;
}
const prgOffset = trackOffset(firstTrk!) + firstSec! * 256;
const prgSector = d64.subarray(prgOffset, prgOffset + 256);
console.log(`First PRG first-sector D64 offset = 0x${prgOffset.toString(16)}`);
// First 2 bytes = load address (lo, hi). PRG body starts at byte 2.
console.log(`  load_addr_lo=$${prgSector[2]?.toString(16)} load_addr_hi=$${prgSector[3]?.toString(16)}  (sector[0]=$${prgSector[0]?.toString(16)} sector[1]=$${prgSector[1]?.toString(16)} = next link)`);

// Boot session, mount, LOAD"<name>",8,1.
const { session } = startIntegratedSession({
  mode: "true-drive",
  useMicrocodedCpu: true,
  vicRenderer: "literal-port",
  drive1541: "vice",
});
await mountMedia(session, 8, diskPath);
session.resetCold("pal-default");
session.runFor(2_000_000);

session.typeText(`LOAD"${nameClean}",8,1\r`, 80_000, 80_000);
const PAL_HZ = 985_248;
const target = session.c64Cpu.cycles + 60 * PAL_HZ;
while (session.c64Cpu.cycles < target) session.runFor(500_000);

// Decode screen.
function decodeScreen(ram: Uint8Array): string {
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i]! & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}
const ram = (session.c64Bus as { ram: Uint8Array }).ram;
console.log(`\nPost-LOAD c64 PC=$${session.c64Cpu.pc.toString(16)}`);
console.log("Screen (rows 6-15):");
const scr = decodeScreen(ram);
for (let row = 6; row < 16; row++) console.log(`| ${scr.slice(row*40, row*40+40)}`);

// LOAD"name",8,1 with secondary 1 → load at native address from PRG header.
// Native address from PRG: prgSector[2..3] (little-endian). PRG body bytes
// start at prgSector[4]. c64 RAM loaded at native_addr.
const loadAddr = prgSector[2]! | (prgSector[3]! << 8);
console.log(`\nExpected load address = $${loadAddr.toString(16)} (from PRG header bytes)`);

// Compare native_addr..native_addr+15 vs prgSector[4..19].
const c64Bytes: number[] = [];
const fileBytes: number[] = [];
for (let i = 0; i < 16; i++) {
  c64Bytes.push(ram[(loadAddr + i) & 0xffff]!);
  fileBytes.push(prgSector[4 + i]!);
}
function hex(n: number): string { return n.toString(16).padStart(2, "0"); }
console.log(`\nc64 RAM [$${loadAddr.toString(16)}..+15]: ${c64Bytes.map(hex).join(" ")}`);
console.log(`D64 PRG body bytes 0..15:         ${fileBytes.map(hex).join(" ")}`);

// Also peek $801 + $328 + $326-prev.
const peek = (a: number, n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(hex(ram[(a + i) & 0xffff]!));
  return out.join(" ");
};
console.log(`\nRAM[$0801..+15]:  ${peek(0x0801, 16)}`);
console.log(`RAM[$0326..+15]:  ${peek(0x0326, 16)}`);
console.log(`RAM[$0328..+15]:  ${peek(0x0328, 16)}`);
console.log(`RAM[$002B..$002C] BASIC TXTTAB lo/hi = $${hex(ram[0x2b]!)} $${hex(ram[0x2c]!)}`);
console.log(`RAM[$00AE..$00AF] LOAD/SAVE end ptr lo/hi = $${hex(ram[0xae]!)} $${hex(ram[0xaf]!)}`);

let match = true;
for (let i = 0; i < 16; i++) {
  if (c64Bytes[i] !== fileBytes[i]) { match = false; break; }
}
console.log(`\n#2 RESULT: ${match ? "PASS" : "FAIL"}`);
if (!match) {
  console.log("(c64 RAM does not match D64 PRG body)");
  process.exit(1);
}
