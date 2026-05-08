#!/usr/bin/env node
// Spec 234 — CLI swimlane renderer.
//
// Reads a duckdb path + cycle range, renders swimlane to stdout.
//
// Usage:
//   node scripts/render-swimlane.mjs \
//     --db <path.duckdb> \
//     --run <runId> \
//     --start <cycle> \
//     --end <cycle> \
//     [--format md|jsonl]   (default: md)
//     [--full]              (disable compact)
//     [--max-rows 200]

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

const dbPath    = args.db    ? resolvePath(args.db)    : null;
const runId     = args.run   ?? null;
const startCyc  = args.start !== undefined ? Number(args.start) : null;
const endCyc    = args.end   !== undefined ? Number(args.end)   : null;
const format    = args.format ?? "md";
const compact   = !args.full;
const maxRows   = Number(args["max-rows"] ?? 200);

if (!dbPath || !runId || startCyc === null || endCyc === null) {
  console.error("Usage: render-swimlane.mjs --db <path> --run <runId> --start <n> --end <n> [--format md|jsonl] [--full] [--max-rows 200]");
  process.exit(1);
}

if (!existsSync(dbPath)) {
  console.error(`DuckDB file not found: ${dbPath}`);
  process.exit(2);
}

const repoRoot = resolvePath(import.meta.dirname, "..");

const duck = await import("@duckdb/node-api");
const { DuckDbQueryBackend } =
  await import(`${repoRoot}/dist/runtime/headless/v2/duckdb-backend.js`);
const { swimlaneSlice } =
  await import(`${repoRoot}/dist/runtime/headless/v2/swimlane.js`);
const { renderMarkdown, renderJsonl } =
  await import(`${repoRoot}/dist/runtime/headless/v2/swimlane-render.js`);

const inst = await duck.DuckDBInstance.create(dbPath);
const conn = await inst.connect();
const backend = new DuckDbQueryBackend({ runAndReadAll: async (sql) => conn.runAndReadAll(sql) });

const slice = await swimlaneSlice(backend, {
  runId,
  cycleRange: [startCyc, endCyc],
  compact,
});

if (format === "jsonl") {
  process.stdout.write(renderJsonl(slice) + "\n");
} else {
  process.stdout.write(renderMarkdown(slice, { maxRows }));
}

await conn.close();
await inst.close();
