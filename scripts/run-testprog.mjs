#!/usr/bin/env node
// Universal VICE testprog runner. Loads a .prg into HL, runs N sec,
// captures screen RAM + border + raster + final c64 PC. Saves snapshot
// for manual / future automated review.
//
// Usage:
//   node scripts/run-testprog.mjs <path-to-prg> [--max-sec N] [--mode kernal|true-drive]
//
// For .prg files: loaded via kernal-load mode (faster boot).
// For .d64 files: true-drive mode + LOAD"*",8,1.

import { resolve as resolvePath, basename } from "node:path";
import { existsSync, writeFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i+1] : dflt;
}

const prgPath = args[0];
if (!prgPath || prgPath.startsWith("--")) {
  console.error("Usage: node scripts/run-testprog.mjs <path-to-prg> [--max-sec N] [--mode kernal|true-drive]");
  process.exit(2);
}
const fullPath = resolvePath(prgPath);
if (!existsSync(fullPath)) {
  console.error(`Not found: ${fullPath}`);
  process.exit(2);
}
const maxSec = parseInt(arg("max-sec", "30"), 10);
const mode = arg("mode", fullPath.endsWith(".d64") || fullPath.endsWith(".g64") ? "true-drive" : "kernal-load");

const repoRoot = resolvePath(import.meta.dirname, "..");
const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

// Always use true-drive (so IEC tests can talk to drive). For .prg
// tests we attach motm.g64 as dummy disk + inject the .prg into c64 RAM.
const dummyDisk = resolvePath(repoRoot, "samples/motm.g64");
const sessionOpts = (fullPath.endsWith(".d64") || fullPath.endsWith(".g64"))
  ? { diskPath: fullPath, mode: "true-drive", useMicrocodedCpu: true }
  : { diskPath: dummyDisk, mode: "true-drive", useMicrocodedCpu: true };

const { session } = startIntegratedSession(sessionOpts);
session.resetCold("pal-default");

console.log(`Test: ${basename(fullPath)} | mode=${mode} | maxSec=${maxSec}s`);

if (fullPath.endsWith(".d64") || fullPath.endsWith(".g64")) {
  session.runFor(800_000);
  session.typeText('LOAD"*",8,1\rRUN\r', 80_000, 80_000);
} else {
  // PRG load: inject into c64 RAM + set BASIC pointers + RUN/SYS.
  const data = readFileSync(fullPath);
  const loadAddr = data[0] | (data[1] << 8);
  const program = data.subarray(2);
  const progEnd = loadAddr + program.length;
  console.log(`Load addr: $${loadAddr.toString(16)} | size: ${program.length}`);
  for (let i = 0; i < program.length; i++) {
    session.c64Bus.ram[loadAddr + i] = program[i];
  }
  // Boot BASIC, then patch pointers.
  session.runFor(2_000_000);
  // Set BASIC pointers: VARTAB ($2D/$2E), ARYTAB ($2F/$30), STREND ($31/$32).
  // Without these, BASIC RUN treats program as empty.
  session.c64Bus.ram[0x002d] = progEnd & 0xff;
  session.c64Bus.ram[0x002e] = (progEnd >> 8) & 0xff;
  session.c64Bus.ram[0x002f] = progEnd & 0xff;
  session.c64Bus.ram[0x0030] = (progEnd >> 8) & 0xff;
  session.c64Bus.ram[0x0031] = progEnd & 0xff;
  session.c64Bus.ram[0x0032] = (progEnd >> 8) & 0xff;
  if (loadAddr === 0x0801) {
    session.typeText(`RUN\r`, 80_000, 80_000);
  } else {
    session.typeText(`SYS ${loadAddr}\r`, 80_000, 80_000);
  }
}

const PAL_HZ = 985248;
const target = Date.now() + maxSec * 1000;
const startWall = Date.now();
while (Date.now() < target) session.runFor(50_000);

const wallSec = (Date.now() - startWall) / 1000;
const ram = session.c64Bus.ram;

// Decode screen
function screenToAscii(bytes) {
  let s = "";
  for (const b of bytes) {
    const c = b & 0x7f;
    if (c === 0x20) s += " ";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40);
    else if (c >= 0x30 && c <= 0x39) s += String.fromCharCode(c);
    else if (c >= 0x21 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}

const lines = [];
for (let row = 0; row < 25; row++) {
  const start = 0x0400 + row * 40;
  lines.push(screenToAscii(ram.subarray(start, start + 40)).trimEnd());
}

console.log(`\n=== Result after ${wallSec.toFixed(1)}s ===`);
console.log(`c64 PC: $${session.c64Cpu.pc.toString(16)}`);
console.log(`Border: $${ram[0xd020].toString(16)} | BG: $${ram[0xd021].toString(16)}`);
console.log(`Screen:`);
for (const l of lines.filter(l => l.length > 0)) console.log("  " + l);

// Heuristic pass/fail:
// - Border green ($05) → likely PASS for tests using border indicator
// - Border red ($02) → likely FAIL
// - Screen contains "OK" / "PASS" → PASS
// - Screen contains "ERROR" / "WRONG" / "FAIL" → FAIL
const screen = lines.join(" ");
const border = ram[0xd020];
let verdict = "INCONCLUSIVE";
if (border === 0x05) verdict = "PASS (border green)";
else if (border === 0x02) verdict = "FAIL (border red)";
else if (/PASS|OK\b/i.test(screen)) verdict = "PASS (screen)";
else if (/ERROR|WRONG|FAIL|BAD/i.test(screen)) verdict = "FAIL (screen)";

console.log(`\nVerdict: ${verdict}`);
process.exit(verdict.startsWith("PASS") ? 0 : verdict.startsWith("FAIL") ? 1 : 2);
