#!/usr/bin/env node
// Spec 097 (M0.4c) — LOAD acceptance smoke CLI.
//
// Iterates the matrix defined in load-matrix.ts, runs each target,
// reports pass/fail/skip. Exit 0 = all required green. Exit 1 = any
// required red. local-only targets that skip due to missing fixture
// don't fail the run.
//
// Args:
//   --strict     fail on missing local-only fixtures (CI mode)
//   --filter=L2  run only the comma-separated target IDs
//   --only=L7    run a single target (alias for --filter)

import { existsSync } from "node:fs";

const args = {};
for (const a of process.argv.slice(2)) {
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq < 0) args[a.slice(2)] = true;
  else args[a.slice(2, eq)] = a.slice(eq + 1);
}

let runLoadSmoke, DEFAULT_LOAD_SMOKE_TARGETS;
try {
  ({ runLoadSmoke, DEFAULT_LOAD_SMOKE_TARGETS } = await import(
    "../dist/runtime/headless/smoke/load-matrix.js"
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

let targets = DEFAULT_LOAD_SMOKE_TARGETS;
const filter = args.filter ?? args.only;
if (filter) {
  const ids = String(filter).split(",").map((s) => s.trim().toUpperCase());
  targets = targets.filter((t) => ids.includes(t.id.toUpperCase()));
  if (targets.length === 0) {
    console.error(`no targets match filter: ${filter}`);
    process.exit(2);
  }
}

if (args.strict) {
  for (const t of targets) {
    if (t.mode === "local-only" && !existsSync(t.fixturePath)) {
      console.error(`[strict] required fixture missing: ${t.fixturePath}`);
      process.exit(1);
    }
  }
}

console.log(`load-acceptance smoke — ${targets.length} target(s)`);
const results = [];
const t0 = Date.now();
for (const target of targets) {
  process.stdout.write(`  [${target.id}] ${target.label} ... `);
  const tStart = Date.now();
  const result = await runLoadSmoke(target);
  const ms = Date.now() - tStart;
  results.push({ ...result, ms });
  const tag = result.status === "pass" ? "PASS"
    : result.status === "skip" ? "SKIP"
    : "FAIL";
  process.stdout.write(`${tag} (${ms}ms)\n`);
  if (result.status !== "pass") {
    if (result.reason) console.log(`      reason: ${result.reason}`);
    const d = result.details;
    if (Object.keys(d).length > 0) {
      console.log(`      details:`);
      for (const [k, v] of Object.entries(d)) {
        const fmt = typeof v === "number" && k !== "elapsedC64Cyc"
          ? `0x${v.toString(16)}`
          : String(v);
        console.log(`        ${k}: ${fmt}`);
      }
    }
  }
}

const totalMs = Date.now() - t0;
const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;

console.log(`---`);
console.log(`summary: ${passed} passed, ${failed} failed, ${skipped} skipped (${totalMs}ms)`);
process.exit(failed > 0 ? 1 : 0);
