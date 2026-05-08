#!/usr/bin/env node
// Spec 207 — lint rule rejecting new code paths that fork emulator
// timing. Complements `audit-no-peer-tick.mjs` (Spec 200-c5) by
// catching loop drivers that bypass kernel SyncStrategy.
//
// Forbidden patterns outside the kernel/scheduler allowlist:
//   - `setInterval(` / `setImmediate(` driving emulator state
//   - Manual mutation of CPU cycle counters: `cpu.cycles = ...`,
//     `cpu.cycles += ...`, `c64Cpu.cycles = ...`
//   - Standalone instantiation of `new HeadlessKernelBus(`
//   - Replacement of session-internal step methods (`stepInstruction =`)
//
// Per-line override: append `// audit-ok: <reason>`.
//
// Usage: node scripts/audit-timing-fork.mjs
// Exit non-zero on violations.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(REPO_ROOT, "src");

// Files allowed to manage cycle counters or scheduler internals.
const ALLOWLIST_PREFIXES = [
  "src/runtime/headless/kernel/",
  "src/runtime/headless/scheduler/",
  "src/runtime/headless/cpu/",
  "src/runtime/headless/cpu6510.ts",
  "src/runtime/headless/drive/drive-cpu.ts",
];

const RULES = [
  {
    label: "setInterval (emulator-loop driver)",
    pattern: /\bsetInterval\s*\(/,
  },
  {
    label: "setImmediate (emulator-loop driver)",
    pattern: /\bsetImmediate\s*\(/,
  },
  {
    label: "cycles mutation (timing fork)",
    pattern: /\b(c64Cpu|cpu|driveCpu)\.cycles\s*[\+\-]?=/,
  },
  {
    label: "step method override (bypass kernel)",
    pattern: /\.(stepInstruction|stepFrame|runCycles|runFor)\s*=\s*(function|\()/,
  },
  {
    label: "new HeadlessKernelBus outside kernel",
    pattern: /new\s+HeadlessKernelBus\s*\(/,
  },
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
      if (/\/\/\s*audit-ok:\s*\S+/.test(line)) continue;
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim(), label: rule.label });
        }
      }
    }
  }
  return violations;
}

const violations = scan();
if (violations.length === 0) {
  console.log("audit-timing-fork: 0 violations");
  process.exit(0);
}
console.log(`audit-timing-fork: ${violations.length} violation(s)`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  [${v.label}]`);
  console.log(`    ${v.text}`);
}
console.log("");
console.log("Move into one of the allowlisted prefixes:");
for (const p of ALLOWLIST_PREFIXES) console.log(`  ${p}`);
console.log("or annotate `// audit-ok: <reason>` on the same line.");
process.exit(1);
