#!/usr/bin/env node
// Run Wolfgang Lorenz C64 emulator test suite (public domain) against
// HL integrated runtime. Detects test progress + failures by sampling
// c64 screen RAM ($0400-$07E7) periodically.
//
// Usage:
//   node scripts/run-lorenz-suite.mjs [--disk N] [--max-sec N] [--verbose]
//
// Default: Disk1, 600 sec wallclock cap.
//
// Detection:
//   - Each test prints test-name to screen on entry.
//   - On failure: prints "WRONG" / error info, halts.
//   - On full pass: "finish" test prints completion msg.
//
// We sample screen text every 1 sec, log changes, detect:
//   - "finish" / "OK" / similar → PASS
//   - "WRONG" / "ERROR" / halt-no-progress → FAIL
//   - timeout → INCONCLUSIVE

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i+1] : dflt;
}
const flag = (name) => args.includes(`--${name}`);

const diskNum = parseInt(arg("disk", "1"), 10);
const maxSec = parseInt(arg("max-sec", "600"), 10);
const verbose = flag("verbose");

// Lorenz disk entry points (each disk continues the chain).
const ENTRY_PER_DISK = { 1: "START", 2: "BEQR", 3: "TRAP1", 4: "TRAP10" };
const entryName = arg("entry", ENTRY_PER_DISK[diskNum] ?? "START");

const repoRoot = resolvePath(import.meta.dirname, "..");
const diskPath = resolvePath(repoRoot, `samples/vice-testprogs/lorenz-2.15/Disk${diskNum}.d64`);
if (!existsSync(diskPath)) {
  console.error(`Disk not found: ${diskPath}`);
  process.exit(2);
}

console.log(`Lorenz suite Disk${diskNum} (${diskPath})`);
console.log(`Max wallclock: ${maxSec}s`);

const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const { session } = startIntegratedSession({
  diskPath,
  mode: "true-drive",
  useMicrocodedCpu: true,
});
session.resetCold("pal-default");
session.runFor(800_000);
session.typeText(`LOAD"${entryName}",8\r`, 80_000, 80_000);
// Wait for LOAD to complete (~2-3 sec wallclock)
const PAL_HZ_BOOT = 985248;
const loadEnd = session.c64Cpu.cycles + 5 * PAL_HZ_BOOT;
while (session.c64Cpu.cycles < loadEnd) session.runFor(50_000);
session.typeText('RUN\r', 80_000, 80_000);

// PETSCII screen-code → ASCII (rough)
function screenToAscii(bytes) {
  let s = "";
  for (const b of bytes) {
    const c = b & 0x7f;
    if (c === 0x20) s += " ";
    else if (c >= 0x01 && c <= 0x1a) s += String.fromCharCode(c + 0x40); // A-Z
    else if (c >= 0x30 && c <= 0x39) s += String.fromCharCode(c);          // 0-9
    else if (c === 0x2e) s += ".";
    else if (c === 0x2c) s += ",";
    else if (c === 0x21) s += "!";
    else if (c === 0x3a) s += ":";
    else if (c === 0x3f) s += "?";
    else if (c >= 0x21 && c <= 0x3f) s += String.fromCharCode(c);
    else s += " ";
  }
  return s;
}

function screenSnapshot() {
  const ram = session.c64Bus.ram;
  const lines = [];
  for (let row = 0; row < 25; row++) {
    const start = 0x0400 + row * 40;
    const line = screenToAscii(ram.subarray(start, start + 40));
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines.filter(l => l.length > 0);
}

const PAL_HZ = 985248;
let target = Date.now() + maxSec * 1000;
const startWall = Date.now();
let lastScreen = "";
let lastChangeWall = startWall;
let result = "INCONCLUSIVE";
let lastTestName = "";

const ERROR_PATTERNS = [/WRONG/, /ERROR/, /BAD/, /FAILED/];
const SUCCESS_PATTERNS = [/FINISH/, /COMPLETE/, /ALL TESTS/];

while (Date.now() < target) {
  session.runFor(50_000);
  const wall = Date.now();
  const wallSec = (wall - startWall) / 1000;

  if (wall - lastChangeWall > 50 && wall - startWall > 1000) {
    const lines = screenSnapshot();
    const screen = lines.join(" | ");

    if (screen !== lastScreen) {
      lastScreen = screen;
      lastChangeWall = wall;

      // Try to extract test name (typically first non-blank short line)
      for (const l of lines) {
        const trimmed = l.trim().toLowerCase();
        if (trimmed.length > 0 && trimmed.length < 16 && !trimmed.includes(" ")) {
          if (trimmed !== lastTestName) {
            lastTestName = trimmed;
            if (verbose) {
              console.log(`[${wallSec.toFixed(1)}s] running: ${trimmed}`);
            }
          }
          break;
        }
      }

      // Check error patterns
      for (const pat of ERROR_PATTERNS) {
        if (pat.test(screen)) {
          result = `FAIL (matched ${pat.source})`;
          console.log(`[${wallSec.toFixed(1)}s] ${result}`);
          console.log(`Screen:\n${lines.map(l => "  " + l).join("\n")}`);
          target = Date.now();
          break;
        }
      }
      for (const pat of SUCCESS_PATTERNS) {
        if (pat.test(screen)) {
          result = `PASS (matched ${pat.source})`;
          console.log(`[${wallSec.toFixed(1)}s] ${result}`);
          console.log(`Screen:\n${lines.map(l => "  " + l).join("\n")}`);
          target = Date.now();
          break;
        }
      }
    } else {
      const stillSec = (wall - lastChangeWall) / 1000;
      if (stillSec > 60) {
        result = `STALL (no screen change for ${stillSec.toFixed(0)}s, last test: ${lastTestName})`;
        console.log(`[${wallSec.toFixed(1)}s] ${result}`);
        console.log(`Screen:\n${lines.map(l => "  " + l).join("\n")}`);
        target = Date.now();
      }
    }
  }

  if ((wall - startWall) > maxSec * 1000) break;
}

const totalWall = (Date.now() - startWall) / 1000;
console.log(`\n=== RESULT ===`);
console.log(`Last test: ${lastTestName || "(none detected)"}`);
console.log(`Result: ${result}`);
console.log(`Wallclock: ${totalWall.toFixed(1)}s`);
console.log(`c64 cycles run: ${session.c64Cpu.cycles}`);
console.log(`Final screen:`);
const finalLines = screenSnapshot();
for (const l of finalLines) console.log("  " + l);

process.exit(result.startsWith("PASS") ? 0 : 1);
