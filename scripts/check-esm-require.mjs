#!/usr/bin/env node
// A bare `require()` in this ESM bundle is a silent runtime failure, not a compile error.
//
// It type-checks, because @types/node declares `require`. It then throws at runtime, where
// it is almost always inside a try/catch that turns the throw into a plausible-looking
// default — so the module reports "no", "false", "none" forever and nothing ever says why.
//
// It has bitten twice in one day:
//
//   src/server-tools/error-helpers.ts — isProjectInitialised() delegated through
//     require("../project-root.js"), threw on every call, and its catch returned false.
//     c64re_whats_next therefore refused EVERY project with "Project not initialised",
//     and an unattended session lost the tool for a whole run and blamed a local hook.
//
//   src/server-tools/citation-resolver.ts — the same thing, caught before shipping only
//     because the resolver's "dormant" branch looked too eager in a test.
//
// `createRequire(import.meta.url)` is the correct form and is allowed.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", ".git"]);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const offenders = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, "utf8");
  if (/createRequire\s*\(/.test(text)) continue; // the correct form; its require is fine
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;          // a comment about require is not one
    if (!/\brequire\s*\(/.test(line)) return;
    if (/import\s*\(/.test(line)) return;
    offenders.push({ file: file.replace(ROOT, "src"), line: i + 1, text: line.trim() });
  });
}

if (offenders.length === 0) {
  console.log("no bare require() in the ESM sources");
  process.exit(0);
}

console.error("bare require() in ESM sources — these throw at runtime and usually land in a catch:\n");
for (const o of offenders) console.error(`  ${o.file}:${o.line}\n     ${o.text}`);
console.error("\nUse a static import, or `createRequire(import.meta.url)` when a CJS-only module is genuinely needed.");
process.exit(1);
