#!/usr/bin/env node
// Spec 883 — nothing ships that nothing can reach.
//
// Walks the BUILT dist/ from every entry a package user can start and fails on any module
// that ships and is reached by none of them. It runs over dist/ rather than src/ on
// purpose: type-only imports are erased there, so an `import type` is not mistaken for a
// caller — the mistake that kept a whole TypeScript trace stack looking alive for months
// after the daemon took its job.
//
// Why a gate and not an audit: every corpse this caught had been found once already, by
// hand, and came back. `dist/analysis/regression.js` shipped in 0.2.0 behind two hidden
// tools whose text pointed at a script that is not in the package, and a supply-chain
// scanner then reported SQL findings in code nobody could run.
//
// Roots: the `bin`, the workbench (launch + HTTP server), and the pipeline child, which is
// spawned by path and would otherwise look unreachable in its entirety.
// Edges: static import / export-from, dynamic import(), require(), and string literals
// that name a dist file — by `dist/…` path, by relative path, or by a basename unique in
// dist/ (the pipeline builds `join(__dirname, "..", "..", "symbols", "listing-equates.js")`).
// The basename rule over-approximates, which is the safe direction: it can let a corpse
// through that shares its name with a live string, never fail a live module.
//
// A module that is legitimately unreachable at runtime — build-time, a test fixture,
// compiled into the UI bundle from source — is excluded from the tarball by an exact
// `!dist/…` entry in package.json `files`. The gate checks those too: an exclusion that
// names a file that does not exist, or one that IS reached, is stale and fails.
//
// Needs a fresh build (`npm run build` clears dist/ first): a stale output of a deleted
// source would otherwise count as shipped.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const rel = (p) => relative(ROOT, p).split(sep).join("/");

if (!existsSync(join(DIST, "cli.js"))) {
  console.error("check:dist-reachable — dist/ is not built; run `npm run build` first.");
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const binPaths = Object.values(typeof pkg.bin === "string" ? { c64re: pkg.bin } : pkg.bin ?? {});
const ROOTS = [
  ...binPaths,
  "dist/workspace-ui/launch.js",
  "dist/workspace-ui/server.js",
  "dist/pipeline/cli.cjs",
].map((p) => join(ROOT, p));

const all = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.c?js$/.test(n)) all.push(p);
  }
})(DIST);

const byBase = new Map();
for (const f of all) {
  const b = f.split(sep).pop();
  byBase.set(b, [...(byBase.get(b) ?? []), f]);
}

function edges(file) {
  const src = readFileSync(file, "utf8");
  const out = new Set();
  const add = (spec) => {
    if (!spec) return;
    if (spec.startsWith(".")) {
      for (const c of [spec, `${spec}.js`, `${spec}.cjs`, join(spec, "index.js")]) {
        const p = resolve(dirname(file), c);
        if (existsSync(p) && statSync(p).isFile()) { out.add(p); return; }
      }
    }
    const inDist = spec.match(/dist\/([\w\-./]+\.c?js)/);
    if (inDist && existsSync(join(DIST, inDist[1]))) { out.add(join(DIST, inDist[1])); return; }
    const base = spec.split("/").pop();
    const same = byBase.get(base);
    if (same?.length === 1 && /^[\w\-.]+\.c?js$/.test(spec)) out.add(same[0]);
  };
  const patterns = [
    /(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]/g,
    /import\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*['"]([^'"]+)['"]/g,
    /['"`]([^'"`\n]*?[\w\-]+\.c?js)['"`]/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) add(m[1]);
  return out;
}

const seen = new Set();
const queue = [...ROOTS];
while (queue.length) {
  const f = queue.pop();
  if (seen.has(f) || !existsSync(f)) continue;
  seen.add(f);
  for (const e of edges(f)) queue.push(e);
}

// An emit with nothing left once comments and module boilerplate are gone is a
// type-only file: harmless, and there is nothing in it to ship or to leak.
const isEmpty = (f) => readFileSync(f, "utf8")
  .replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")
  .replace(/export\s*\{\s*\};?|"use strict";?|Object\.defineProperty\(exports,\s*"__esModule"[^)]*\);?/g, "")
  .trim().length === 0;

const excluded = new Set((pkg.files ?? [])
  .filter((f) => f.startsWith("!dist/") && !f.includes("*"))
  .map((f) => f.slice(1)));

let fail = 0;
const unreachable = all.filter((f) => !seen.has(f) && !isEmpty(f)).map(rel).sort();
const shipped = unreachable.filter((f) => !excluded.has(f));

console.log(`check:dist-reachable — ${seen.size}/${all.length} modules reached from ${ROOTS.length} entries; ${excluded.size} excluded from the tarball by name.`);
for (const f of shipped) {
  fail++;
  console.log(`  FAIL  ships and nothing reaches it: ${f}`);
}
for (const f of [...excluded].sort()) {
  if (!existsSync(join(ROOT, f))) { fail++; console.log(`  FAIL  stale exclusion, no such file: !${f}`); }
  else if (seen.has(join(ROOT, f))) { fail++; console.log(`  FAIL  excluded but reached at runtime, so the package would break: !${f}`); }
}

if (fail) {
  console.log(`\nRED  ${fail} finding(s). A module nothing reaches is either dead — delete it, and the tests that only`);
  console.log(`     test it — or build-time / fixture / UI-bundle only — add an exact "!dist/…" entry to files.`);
  process.exit(1);
}
console.log("GREEN  every shipped module is reachable, and every exclusion is current.");
