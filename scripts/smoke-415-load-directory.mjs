#!/usr/bin/env node
// Spec 415 — 1541 Phase I step 37: read test (LOAD"$",8 directory).
//
// Doctrine: 1:1 VICE TDE port.
//
// Doc:  docs/vice-1541-arch.md §13 Phase I step 37:
//         "Read test: known-good D64, LOAD\"$\",8 then LIST."
//       §6 (VIA1 IEC) — directory read exercises full ATN handshake +
//         TALK/UNLISTEN sequence.
//
// VICE: src/drive/iec/via1d1541.c:212 store_prb (drive→bus PB write,
//         IEC bus carries the directory bytes one byte at a time)
//       src/drive/iec/via1d1541.c:337 read_prb (bus→drive: ATN/CLK/DATA)
//       src/c64/cia2.c (host CIA2 PA mirrors IEC; directory bytes
//         arrive into LOAD via KERNAL CHRIN)
//
// Acceptance per spec 415:
//   - mount known-good D64 (samples/scramble_infinity.d64),
//   - boot to READY,
//   - send `LOAD"$",8` + run cycles for KERNAL+drive to complete,
//   - assert directory listing visible in screen RAM ($0400 region):
//       expect to find at least the disk header + ≥1 file entry +
//       "BLOCKS FREE" footer (or recognisable directory structure).
//
// Tier (PLAN.md): 415 = validation. Per spec acceptance, this is a
// boot+LOAD smoke with a screen-RAM oracle (not a golden hash — the
// directory contents already form a deterministic oracle).

import { resolve as resolvePath } from "node:path";
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

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, "samples/scramble_infinity.d64");

if (!existsSync(diskPath)) {
  console.error(`disk image missing: ${diskPath}`);
  process.exit(1);
}

const results = [];
function check(label, cond, detail) {
  results.push({ label, pass: !!cond, detail });
}

const { session } = startIntegratedSession({
  diskPath,
  mode: "true-drive",
  useMicrocodedCpu: true,
});
session.resetCold("pal-default");

// Boot to READY.
session.runFor(2_000_000);

// Issue LOAD"$",8 — KERNAL OPEN/CHKIN/CHRIN sequence runs the IEC
// ATN-handshake protocol against the drive, which TALKs the directory
// back as a fake BASIC program in $0801. After LOAD finishes the user
// would type LIST; we don't need LIST since the directory bytes are
// already in C64 RAM at $0801. But to mirror Phase I step 37 exactly
// we send LIST and let the KERNAL print it to the screen.
session.typeText('LOAD"$",8\r', 80_000, 80_000);

// LOAD"$",8 with true-drive emulation = ~6-10s. Give a generous 12s
// budget at PAL ~985248 Hz.
const PAL_HZ = 985_248;
const LOAD_BUDGET = 12 * PAL_HZ;
{
  const target = session.c64Cpu.cycles + LOAD_BUDGET;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}

// Drop to LIST so the directory bytes get printed into screen RAM.
session.typeText("LIST\r", 80_000, 80_000);
{
  const target = session.c64Cpu.cycles + 2 * PAL_HZ;
  while (session.c64Cpu.cycles < target) session.runFor(200_000);
}

// PETSCII (screen-code) decode for $0400..$07E7 region. Same routine
// as smoke-406-vice-corpus.mjs (lines 86-97). Returns plain ASCII for
// pattern matching.
function decodeScreen(ram) {
  // Screen-code → ASCII mapping (full lower-32 + punctuation range).
  // Codes 0x00-0x1F = letters '@A..Z[£]↑←' (we map @, A..Z literally).
  // Codes 0x20-0x3F = space + punctuation + digits (already ASCII-aligned).
  let s = "";
  for (let i = 0x0400; i <= 0x07e7; i++) {
    const c = ram[i] & 0x7f;
    if (c === 0x00) s += "@";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x20 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}

const ram = session.c64Bus.ram;
const screen = decodeScreen(ram);

// Sanity log: dump the screen as 25×40 lines for easy debugging.
const screenLines = [];
for (let row = 0; row < 25; row++) {
  screenLines.push(screen.slice(row * 40, (row + 1) * 40));
}

// Oracle 1: directory listing always contains "BLOCKS FREE" footer
// (CBM DOS prints it as the last line of any directory).
const hasBlocksFree = /BLOCKS\s*FREE/.test(screen);
check(
  'screen RAM contains "BLOCKS FREE" footer (= directory listing rendered)',
  hasBlocksFree,
  hasBlocksFree ? undefined : `(no match in 1000-byte screen RAM)`,
);

// Oracle 2: directory listing contains "PRG" file-type tag (Scramble
// disk has multiple PRG entries).
const hasPrg = / PRG/.test(screen);
check(
  'screen RAM contains "PRG" file-type tag (= ≥1 directory entry visible)',
  hasPrg,
);

// Oracle 3: directory header line. CBM directories list a quoted disk
// name on row 1 (e.g. "0 \"SCRAMBLE INF\" ...").
const hasQuotedHeader = /"[A-Z0-9 ]{2,16}"/.test(screen);
check(
  "screen RAM contains quoted disk-header (= directory header rendered)",
  hasQuotedHeader,
);

// ---------- Report ----------
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`Spec 415 load-directory smoke — ${results.length} checks`);
for (const r of results) {
  const tag = r.pass ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${r.label}${r.detail ? ` (${r.detail})` : ""}`);
}
if (failed > 0) {
  console.log(`\n=== screen RAM dump (25x40, post-LIST) ===`);
  for (const line of screenLines) console.log(`| ${line}`);
}
console.log(`---`);
console.log(`summary: ${passed}/${results.length} pass, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
