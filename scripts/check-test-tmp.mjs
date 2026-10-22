#!/usr/bin/env node
// Fails when a test script makes its own temp directory. Scratch comes from testTmpDir() in
// scripts/lib/neutral-tmp.mjs, which removes it when the process ends, however it ends.
// Also flags scripts that write into a fixed path under /tmp or join onto os.tmpdir() to
// create something (a bare `cwd: tmpdir()` creates nothing and is fine).
// Run by hand: npm run check:test-tmp
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HELPER = join(ROOT, "scripts/lib/neutral-tmp.mjs");
const ROOTS = ["scripts", "tests"];

function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(mjs|cjs|js|ts)$/.test(n)) yield p;
  }
}

const RULES = [
  [/\bmkdtemp(Sync)?\s*\(/, "mkdtemp outside the helper — use testTmpDir(prefix)"],
  [/\bjoin\(\s*tmpdir\(\)\s*,/, "join(tmpdir(), …) names a path in the shared temp dir — use testTmpDir(prefix)"],
  [/["'`]\/(private\/)?tmp\/[^"'`]*["'`]/, "a fixed /tmp path — use testTmpDir(prefix)"],
];
// A fixed /tmp string that is only compared against or fed to a pure function creates nothing.
const ALLOW = [/projectKey\(["'`]\/tmp\//, /pickPrimary\([^)]*["'`]\/tmp\/x["'`]\)/];

// Not tests: the build mutex (ensure-built removes its lock itself), the playbook generator's doc string,
// and a dev tool that taps a live stream.
const NOT_TESTS = new Set(["scripts/ensure-built.mjs", "scripts/gen-mcp-llm-playbooks.mjs", "scripts/ws-av-tap.mjs"]);

const bad = [];
for (const r of ROOTS) {
  for (const f of walk(join(ROOT, r))) {
    if (f === HELPER || f === import.meta.filename || NOT_TESTS.has(relative(ROOT, f))) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/, "");
      for (const [re, why] of RULES) {
        if (re.test(code) && !ALLOW.some((a) => a.test(code))) bad.push(`${relative(ROOT, f)}:${i + 1}: ${why}\n    ${line.trim().slice(0, 160)}`);
      }
    });
  }
}
if (bad.length) {
  console.error(`check-test-tmp: ${bad.length} place(s) make temp scratch outside testTmpDir():\n${bad.join("\n")}`);
  process.exit(1);
}
console.log("check-test-tmp: ok — every temp directory comes from testTmpDir()");
