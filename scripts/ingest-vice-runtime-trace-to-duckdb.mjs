#!/usr/bin/env node
// Ingest a VICE runtime-trace.jsonl (from vice_trace_runtime_start) into a
// trace-store-compatible DuckDB `instructions` table, so the existing
// trace_store_query / swimlane / diff tooling can opcode-step it.
//
// This is an INGEST (jsonl → DuckDB), the direction memory
// `feedback_trace_into_duckdb` wants — NOT a trace-dump one-off.
//
// Usage:
//   node scripts/ingest-vice-runtime-trace-to-duckdb.mjs \
//     --jsonl <runtime-trace.jsonl> \
//     --out   <store-dir> \
//     --run-id <id> \
//     [--cpu c64]
//
// Produces <store-dir>/trace.duckdb with an `instructions` table matching
// src/runtime/trace-store/duckdb-store.ts schema.

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const jsonl = arg("jsonl");
const outDir = arg("out");
const runId = arg("run-id", "vice-gold");
const cpu = arg("cpu", "c64");
if (!jsonl || !outDir) {
  console.error("need --jsonl <path> --out <store-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const dbPath = resolve(outDir, "trace.duckdb");
if (existsSync(dbPath)) {
  console.error(`refusing to overwrite existing ${dbPath}`);
  process.exit(1);
}

console.log(`ingest ${jsonl} → ${dbPath} (run_id=${runId}, cpu=${cpu})`);
const t0 = Date.now();
const instance = await DuckDBInstance.create(dbPath);
const conn = await instance.connect();

// Schema-compatible instructions table (duckdb-store.ts:88-104).
await conn.run(`CREATE TABLE instructions (
  run_id TEXT, seq UBIGINT, cpu TEXT, clock UBIGINT, master_clock UBIGINT,
  pc USMALLINT, opcode UTINYINT, b1 UTINYINT, b2 UTINYINT,
  a UTINYINT, x UTINYINT, y UTINYINT, sp UTINYINT, p UTINYINT, source TEXT
)`);

// Stream the jsonl via read_json_auto. Filter kind='instruction', flatten
// registers + instructionBytes (DuckDB arrays are 1-indexed).
await conn.run(`
  INSERT INTO instructions
  SELECT
    '${runId}' AS run_id,
    CAST(row_number() OVER () AS UBIGINT) AS seq,
    COALESCE(memspace, '${cpu}') AS cpu,
    CAST(clock AS UBIGINT) AS clock,
    CAST(clock AS UBIGINT) AS master_clock,
    CAST(pc AS USMALLINT) AS pc,
    CAST(instructionBytes[1] AS UTINYINT) AS opcode,
    CAST(COALESCE(instructionBytes[2], 0) AS UTINYINT) AS b1,
    CAST(COALESCE(instructionBytes[3], 0) AS UTINYINT) AS b2,
    CAST(registers.A AS UTINYINT) AS a,
    CAST(registers.X AS UTINYINT) AS x,
    CAST(registers.Y AS UTINYINT) AS y,
    CAST(registers.SP AS UTINYINT) AS sp,
    CAST(registers.FL AS UTINYINT) AS p,
    'vice-cpuhistory' AS source
  FROM read_json_auto('${jsonl}', format='newline_delimited',
                       maximum_object_size=33554432, ignore_errors=true)
  WHERE kind = 'instruction'
`);

const cnt = await conn.runAndReadAll(`SELECT count(*) AS n, min(clock) AS c0, max(clock) AS c1 FROM instructions`);
const row = cnt.getRowObjects()[0];
console.log(`rows=${row.n} clock=[${row.c0}..${row.c1}]  (${((Date.now()-t0)/1000).toFixed(1)}s)`);

writeFileSync(resolve(outDir, "summary.json"), JSON.stringify({
  run_id: runId, cpu, source_jsonl: jsonl, rows: Number(row.n),
  clock_min: String(row.c0), clock_max: String(row.c1),
  ingested_at: new Date().toISOString(),
  note: "VICE gold runtime-trace ingested via ingest-vice-runtime-trace-to-duckdb.mjs",
}, null, 2));

await conn.closeSync();
console.log("done");
