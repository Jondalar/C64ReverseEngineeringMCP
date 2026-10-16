#!/usr/bin/env node
// Every e2e:, smoke:, test: and probe: script in package.json is either run by a step of
// .github/workflows/gates.yml (the list scripts/gate.sh executes) or carries a one-line reason in
// scripts/gate-coverage-allow.json for why it cannot run there. A script in neither is a test nobody
// runs, and it goes red unobserved — that is how fifteen of them were red at once.
//
// Also refused: an allow-list entry with no reason, one naming a script that no longer exists, and one
// for a script the gate already runs (the entry would hide it if the step were ever dropped).
//
//   npm run check:gate-coverage
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};
const workflow = readFileSync(join(ROOT, ".github/workflows/gates.yml"), "utf8");
const allow = JSON.parse(readFileSync(join(ROOT, "scripts/gate-coverage-allow.json"), "utf8"));

const WATCHED = /^(e2e|smoke|test|probe):/;
const npmRuns = (text) => [...text.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)].map((m) => m[1]);

// What the workflow runs: its `run:` lines (comments are not steps), plus whatever those scripts chain.
const runLines = workflow.split("\n").filter((l) => /^\s*(-\s+)?run:/.test(l)).map((l) => l.replace(/^\s*(-\s+)?run:\s*/, ""));
const covered = new Set();
const visit = (name) => {
  if (covered.has(name)) return;
  covered.add(name);
  if (scripts[name]) for (const n of npmRuns(scripts[name])) visit(n);
};
for (const line of runLines) for (const n of npmRuns(line)) visit(n);

const problems = [];
const watched = Object.keys(scripts).filter((n) => WATCHED.test(n));
for (const n of watched) {
  if (!covered.has(n) && !(n in allow)) problems.push(`${n}: in no gates.yml step and not in scripts/gate-coverage-allow.json — add a step, or a one-line reason it cannot run there`);
}
for (const [n, reason] of Object.entries(allow)) {
  if (typeof reason !== "string" || reason.trim().length < 10 || reason.includes("\n")) problems.push(`allow-list ${n}: needs a one-line reason`);
  if (!(n in scripts)) problems.push(`allow-list ${n}: no such package.json script — remove the entry`);
  else if (covered.has(n)) problems.push(`allow-list ${n}: gates.yml already runs it — remove the entry`);
  else if (!WATCHED.test(n)) problems.push(`allow-list ${n}: not an e2e:/smoke:/test:/probe: script — remove the entry`);
}

if (problems.length) {
  console.error(`check:gate-coverage RED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check:gate-coverage GREEN — ${watched.length} scripts: ${watched.filter((n) => covered.has(n)).length} in the gate, ${Object.keys(allow).length} allow-listed with a reason.`);
