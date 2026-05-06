#!/usr/bin/env node
// Spec 200-c5 — audit rule: outside the kernel module, no production
// file may call peer-tick methods on chip objects accessed via the
// session. Enforces ADR §10 criterion 2 ("Session cannot tick C64,
// drive, CIA, VIA, VIC, SID, GCR directly").
//
// Forbidden invocations on session-rooted chip references:
//   session.<chip>.step(...)
//   session.<chip>.tick(...)
//   session.<chip>.executeToClock(...)
//   session.<chip>.runCycles(...)
// where <chip> is one of: c64Cpu, cpu, drive, cia1, cia2, via1, via2,
//                         vic, sid, gcr*
//
// Allowlist: any file under src/runtime/headless/kernel/.
//
// Per-line override: append `// audit-ok: <reason>` to the offending
// line. The reason text must be non-empty.
//
// Usage: node scripts/audit-no-peer-tick.mjs
// Exit non-zero on violations.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(REPO_ROOT, "src");
// Allowlisted directories. Code under these paths is treated as
// kernel-internal: chip implementations, scheduler strategies, drive
// internals, legacy non-integrated session helpers slated for
// migration in later 200-series specs.
const ALLOWLIST_PREFIXES = [
  "src/runtime/headless/kernel/",
  "src/runtime/headless/scheduler/",
  "src/runtime/headless/drive/drive-cpu.ts",
  "src/runtime/headless/drive/drive-session.ts",
  "src/runtime/headless/session-manager.ts",
  // Spec 201-c5: chip implementations are kernel-internal. They expose
  // backends/callbacks that the kernel wires; standalone fixtures
  // (without a kernel) fall back to direct IecBusCore calls.
  "src/runtime/headless/via/",
  "src/runtime/headless/cia/",
];

const CHIP_NAMES = [
  "c64Cpu",
  "cpu",
  "drive",
  "cia1",
  "cia2",
  "via1",
  "via2",
  "vic",
  "sid",
  "gcrShifter",
  "gcr",
];

const FORBIDDEN_METHODS = ["step", "tick", "executeToClock", "runCycles"];

// Spec 201-c5: forbidden direct cross-domain IEC mutations. These
// must go through `kernel.bus.c64Write/.driveWrite` so the access is
// observable and traceable. Reads of cached state remain allowed.
const FORBIDDEN_IECBUS_PATTERNS = [
  /\.iecBus\.setC64Output\s*\(/,
  /\.iecBus\.setDriveOutput\s*\(/,
  /\.iecBus\.drive_store_pb\s*\(/,
  /\.iec\.drive_store_pb\s*\(/,
  /\.iecBus\.beforeC64Read\s*=/,
  /\.iecBus\.releaseDriveClk\s*\(/,
  /\.iecBus\.releaseDriveData\s*\(/,
];

function listSourceFiles() {
  const out = execSync(`find ${SCAN_DIR} -name "*.ts" -not -path "*/node_modules/*"`, {
    encoding: "utf8",
  });
  return out.trim().split("\n").filter(Boolean);
}

function scan() {
  const files = listSourceFiles();
  const violations = [];

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    if (ALLOWLIST_PREFIXES.some((p) => rel.startsWith(p))) continue;

    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Per-line override: `// audit-ok: <reason>`
      const overrideMatch = line.match(/\/\/\s*audit-ok:\s*(.+)$/);
      if (overrideMatch && overrideMatch[1].trim().length > 0) continue;

      for (const chip of CHIP_NAMES) {
        for (const method of FORBIDDEN_METHODS) {
          const pattern = new RegExp(`\\.${chip}\\.${method}\\s*\\(`);
          if (pattern.test(line)) {
            violations.push({
              file: rel,
              line: i + 1,
              text: line.trim(),
              chip,
              method,
            });
          }
        }
      }

      for (const pattern of FORBIDDEN_IECBUS_PATTERNS) {
        if (pattern.test(line)) {
          violations.push({
            file: rel,
            line: i + 1,
            text: line.trim(),
            chip: "iecBus",
            method: pattern.source.replace(/[\\.*\\\\\\(\\\\s\\\\\\)\\=\\?\\+\\^\\$\\{\\}\\|\\[\\]]/g, "").slice(0, 40),
          });
        }
      }
    }
  }
  return violations;
}

const violations = scan();

if (violations.length === 0) {
  console.log("audit-no-peer-tick: 0 violations");
  process.exit(0);
}

console.log(`audit-no-peer-tick: ${violations.length} violation(s)`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  .${v.chip}.${v.method}(...)`);
  console.log(`    ${v.text}`);
}
console.log("");
console.log("Each violation must either be moved into one of:");
for (const p of ALLOWLIST_PREFIXES) console.log(`  ${p}`);
console.log("or annotated with `// audit-ok: <reason>` on the same line.");
process.exit(1);
