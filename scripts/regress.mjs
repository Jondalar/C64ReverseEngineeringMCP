#!/usr/bin/env node
// Spec 102 (M1.5) — regression matrix CLI.
//
// Reads regress.matrix.json, runs each entry, emits per-line result
// + JSONL summary to samples/regress/<timestamp>.jsonl.
// Exit 0 = all required pass; exit 1 = any required fail.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const matrixPath = process.argv[2] ?? "regress.matrix.json";
if (!existsSync(matrixPath)) {
  console.error(`matrix file not found: ${matrixPath}`);
  process.exit(2);
}

let runner;
try {
  runner = await import("../dist/runtime/headless/regress/runner.js");
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

const matrix = runner.loadMatrix(matrixPath);
console.log(`regress matrix v${matrix.schemaVersion} — ${matrix.entries.length} entries`);

const results = [];
const t0 = Date.now();
for (const entry of matrix.entries) {
  process.stdout.write(`  [${entry.id}] ${entry.label} ... `);
  const r = await runner.runEntry(entry);
  results.push(r);
  const tag = r.status === "pass" ? "PASS" : r.status === "skip" ? "SKIP" : "FAIL";
  process.stdout.write(`${tag} (${r.durationMs}ms)\n`);
  if (r.status !== "pass" && r.reason) console.log(`      reason: ${r.reason}`);
}

const totalMs = Date.now() - t0;
const passed = results.filter((r) => r.status === "pass").length;
const failed = results.filter((r) => r.status === "fail").length;
const skipped = results.filter((r) => r.status === "skip").length;

console.log(`---`);
console.log(`summary: ${passed} passed, ${failed} failed, ${skipped} skipped (${totalMs}ms)`);

// Emit JSONL artifact.
if (!existsSync("samples/regress")) mkdirSync("samples/regress", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = `samples/regress/run-${stamp}.jsonl`;
const lines = [
  JSON.stringify({ type: "header", schemaVersion: 1, matrixPath, entries: matrix.entries.length, startedAt: new Date().toISOString() }),
  ...results.map((r) => JSON.stringify({ type: "result", ...r })),
  JSON.stringify({ type: "summary", passed, failed, skipped, totalMs }),
];
writeFileSync(outPath, lines.join("\n") + "\n");
console.log(`artifact: ${outPath}`);

process.exit(failed > 0 ? 1 : 0);
