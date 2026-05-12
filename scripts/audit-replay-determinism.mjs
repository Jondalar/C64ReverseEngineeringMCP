#!/usr/bin/env node
// Spec 231 — determinism audit.
//
// Greps for Math.random / Date.now / process.hrtime in
// src/runtime/headless/** (TypeScript sources only).
//
// Allowlist: lines annotated with `// audit-ok: <reason>`.
// These patterns are acceptable in meta/timing code (perf tracking,
// diagnostic timestamps) that does NOT affect emulator state.
//
// Exit 0 = no violations; exit 1 = violations found.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCAN_DIR = join(REPO_ROOT, "src", "runtime", "headless");

const NON_DETERMINISM_PATTERNS = [
  /\bMath\.random\s*\(/,
  /\bDate\.now\s*\(/,
  /\bprocess\.hrtime\b/,
];

function listSourceFiles() {
  const out = execSync(
    `find "${SCAN_DIR}" -name "*.ts" -not -path "*/node_modules/*"`,
    { encoding: "utf8" },
  );
  return out.trim().split("\n").filter(Boolean);
}

const files = listSourceFiles();
const violations = [];

for (const file of files) {
  const rel = relative(REPO_ROOT, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Per-line override: `// audit-ok: <reason>` with non-empty reason.
    const overrideMatch = line.match(/\/\/\s*audit-ok:\s*(.+)$/);
    if (overrideMatch && overrideMatch[1].trim().length > 0) continue;

    for (const pattern of NON_DETERMINISM_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          file: rel,
          line: i + 1,
          text: line.trim(),
          pattern: pattern.source,
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log("audit-replay-determinism: 0 violations");
  process.exit(0);
}

console.log(`audit-replay-determinism: ${violations.length} violation(s)`);
for (const v of violations) {
  console.log(`  ${v.file}:${v.line}  [${v.pattern}]`);
  console.log(`    ${v.text}`);
}
console.log("");
console.log("Each violation must be annotated with `// audit-ok: <reason>`");
console.log("(reason non-empty) if it does not affect emulator state.");
process.exit(1);
