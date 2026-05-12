#!/usr/bin/env node
// Spec 217 Spike A — DuckDB trace-store smoke.
//
// Validates:
//  1. @duckdb/node-api loads on this platform
//  2. Schema applied + meta inserted
//  3. NullTraceSink hot-path throughput target ≥1M instr-row/sec
//  4. DuckDbTraceSink throughput target ≥500K instr-row/sec
//  5. Chunk-buffer typed-array appender works
//  6. Bus events + chip events round-trip
//  7. Parquet ZSTD export + round-trip query
//  8. NULL handling for master_clock + operand bytes

import { mkdirSync, existsSync, statSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

const {
  allocateInstructionChunk,
  allocateBusEventChunk,
  allocateChipEventChunk,
  appendInstruction,
  appendBusEvent,
  appendChipEvent,
} = await import(`${repoRoot}/dist/runtime/trace-store/chunk-buffer.js`);

const { NullTraceSink } = await import(`${repoRoot}/dist/runtime/trace-store/trace-sink.js`);
const {
  openStore,
  closeStore,
  exportParquet,
  DuckDbTraceSink,
  SCHEMA_VERSION,
} = await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? "  " + detail : ""}`);
    pass++;
  } else {
    console.log(`  FAIL  ${name}${detail ? "  " + detail : ""}`);
    fail++;
  }
}

console.log("trace-store-smoke — Spec 217 Spike A\n");

// ---------- 1. Module load ----------
check("@duckdb/node-api loads (verified by import above)", true);

// ---------- 2. Schema + meta ----------
const tmpDir = resolvePath(repoRoot, "samples/screenshots/trace-store-smoke");
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const dbPath = resolvePath(tmpDir, "trace.duckdb");
const meta = {
  runId: "smoke-20260507",
  source: "headless",
  capturedAt: new Date().toISOString(),
  writerVersion: "spike-a",
  c64ClockHz: 985_248,
  driveClockHz: 1_000_000,
  c64ClockZero: 0n,
  driveClockZero: 0n,
  driveToC64Offset: 0n,
};
const store = await openStore({ path: dbPath, meta });

const metaRows = await store.conn.runAndReadAll("SELECT key, value FROM meta ORDER BY key");
const metaMap = new Map(metaRows.getRows());
check("meta.schema_version present", metaMap.get("schema_version") === SCHEMA_VERSION,
  `got ${metaMap.get("schema_version")} expected ${SCHEMA_VERSION}`);
check("meta.run_id present", metaMap.get("run_id") === "smoke-20260507");
check("meta.source present", metaMap.get("source") === "headless");
check("meta.c64_clock_hz present", metaMap.get("c64_clock_hz") === "985248");
check("meta.drive_to_c64_offset present", metaMap.get("drive_to_c64_offset") === "0");

// Empty-string encoding for unknown
const meta2 = {
  ...meta, runId: "smoke-unknown",
  c64ClockZero: null, driveClockZero: null, driveToC64Offset: null,
};
const tmpDb2 = resolvePath(tmpDir, "trace-unknown.duckdb");
const store2 = await openStore({ path: tmpDb2, meta: meta2 });
const metaRows2 = await store2.conn.runAndReadAll("SELECT key, value FROM meta WHERE key='drive_to_c64_offset'");
const r2 = metaRows2.getRows();
check("unknown bigint encoded as ''", r2.length === 1 && r2[0][1] === "",
  `got '${r2[0]?.[1]}'`);
await closeStore(store2);

// ---------- 3. NullTraceSink throughput ----------
const N_INSTR = 200_000;
const CHUNK = 50_000;
{
  const nullSink = new NullTraceSink();
  const t0 = Date.now();
  let seq = 0n;
  let clk = 0n;
  for (let off = 0; off < N_INSTR; off += CHUNK) {
    const remaining = Math.min(CHUNK, N_INSTR - off);
    const chunk = allocateInstructionChunk("headless", "c64", remaining);
    for (let i = 0; i < remaining; i++) {
      appendInstruction(chunk, {
        seq: seq++, clock: clk, masterClock: clk,
        pc: 0x4000 + (i & 0xff), opcode: 0xa9, b1: 0x42, b2: undefined,
        a: 0x42, x: 0, y: 0, sp: 0xfd, p: 0x24,
      });
      clk += 3n;
    }
    await nullSink.writeInstructionChunk(chunk);
  }
  const sum = await nullSink.close();
  const dt = Math.max(1, Date.now() - t0);
  const rate = (sum.instructionsWritten / dt) * 1000;
  check(`NullTraceSink ingested ${N_INSTR} rows`, sum.instructionsWritten === N_INSTR);
  check(`NullTraceSink rate ≥1M rows/sec`, rate >= 1_000_000,
    `${rate.toFixed(0)} rows/sec`);
}

// ---------- 4. DuckDbTraceSink throughput ----------
{
  const sink = new DuckDbTraceSink({ store });
  const t0 = Date.now();
  let seq = 0n;
  let clk = 0n;
  const TOTAL = 100_000;
  for (let off = 0; off < TOTAL; off += CHUNK) {
    const remaining = Math.min(CHUNK, TOTAL - off);
    const chunk = allocateInstructionChunk("headless", "c64", remaining);
    for (let i = 0; i < remaining; i++) {
      // mix in some null master_clock and null b1/b2 to test NULL path
      const isNull = (i & 0x3f) === 0;
      appendInstruction(chunk, {
        seq: seq++, clock: clk,
        masterClock: isNull ? undefined : clk,
        pc: 0x4000 + (i & 0xff),
        opcode: 0xa9,
        b1: isNull ? undefined : 0x42,
        b2: undefined,
        a: 0x42, x: 0, y: 0, sp: 0xfd, p: 0x24,
      });
      clk += 3n;
    }
    await sink.writeInstructionChunk(chunk);
  }
  const sum = await sink.close();
  const dt = Math.max(1, Date.now() - t0);
  const rate = (sum.instructionsWritten / dt) * 1000;
  check(`DuckDbTraceSink ingested ${TOTAL} instructions`, sum.instructionsWritten === TOTAL);
  check(`DuckDbTraceSink rate ≥500K rows/sec`, rate >= 500_000,
    `${rate.toFixed(0)} rows/sec`);
}

// ---------- 5. Round-trip query ----------
{
  const r = await store.conn.runAndReadAll("SELECT count(*) FROM instructions");
  const rows = r.getRows();
  check("instructions table count matches insert", rows[0][0] === 100_000n,
    `got ${rows[0][0]}`);
  const rNull = await store.conn.runAndReadAll("SELECT count(*) FROM instructions WHERE master_clock IS NULL");
  check("NULL master_clock rows present", rNull.getRows()[0][0] > 0n,
    `nulls=${rNull.getRows()[0][0]}`);
  const rPc = await store.conn.runAndReadAll(
    "SELECT pc, count(*) AS n FROM instructions GROUP BY pc ORDER BY n DESC LIMIT 3"
  );
  check("PC histogram query works", rPc.getRows().length === 3);
}

// ---------- 6. Bus + chip events ----------
{
  const sink = new DuckDbTraceSink({ store });
  const busChunk = allocateBusEventChunk("headless", "c64", 1024);
  let seq = 0n;
  let clk = 0n;
  for (let i = 0; i < 1024; i++) {
    appendBusEvent(busChunk, {
      seq: seq++,
      clock: clk,
      masterClock: clk,
      pc: 0xee60 + (i & 0xf),
      kind: i % 2 === 0 ? "read" : "write",
      addr: 0xdd00,
      value: i & 0xff,
      oldValue: (i + 1) & 0xff,
      lineAtn: i % 3 === 0 ? true : false,
      lineClk: undefined,
      lineData: i % 5 === 0,
    });
    clk += 5n;
  }
  await sink.writeBusEventChunk(busChunk);

  const chipChunk = allocateChipEventChunk("headless", "c64", 256);
  seq = 1_000_000n;
  for (let i = 0; i < 256; i++) {
    appendChipEvent(chipChunk, {
      seq: seq++,
      clock: clk,
      masterClock: clk,
      pc: 0xff48,
      chip: i % 2 === 0 ? "cia1" : "cia2",
      kind: i % 3 === 0 ? "irq_assert" : "irq_clear",
      unit: 0,
      value: i & 0xff,
      oldValue: undefined,
    });
    clk += 11n;
  }
  await sink.writeChipEventChunk(chipChunk);
  await sink.close();

  const r = await store.conn.runAndReadAll(
    "SELECT count(*) FROM bus_events WHERE addr=56576"  // $DD00
  );
  check("bus_events round-trips by addr=$DD00", r.getRows()[0][0] === 1024n,
    `got ${r.getRows()[0][0]}`);
  const rChip = await store.conn.runAndReadAll(
    "SELECT chip, count(*) FROM chip_events GROUP BY chip ORDER BY chip"
  );
  const chipRows = rChip.getRows();
  check("chip_events round-trips by chip", chipRows.length === 2 && chipRows[0][1] === 128n);
  const rLine = await store.conn.runAndReadAll(
    "SELECT count(*) FROM bus_events WHERE line_clk IS NULL"
  );
  check("bus_events NULL line_clk preserved", rLine.getRows()[0][0] === 1024n,
    `got ${rLine.getRows()[0][0]}`);
}

// ---------- 7. Parquet export + round-trip ----------
{
  const parquetDir = resolvePath(tmpDir, "parquet");
  const written = await exportParquet(store, { outDir: parquetDir, compression: "ZSTD" });
  check("parquet export wrote files", written.length >= 7);
  // Compute compression ratio for instructions table.
  const parquetInstr = resolvePath(parquetDir, "instructions.parquet");
  if (existsSync(parquetInstr)) {
    const pSize = statSync(parquetInstr).size;
    // 100K rows × ~38 bytes/row uncompressed = ~3.8 MiB raw, parquet/zstd should be much smaller.
    check("instructions.parquet exists", true, `${pSize} bytes`);
    check("parquet size sane (<10 MiB for 100K rows)", pSize < 10 * 1024 * 1024,
      `${(pSize / 1024).toFixed(1)} KiB`);
  } else {
    check("instructions.parquet exists", false, "not written");
  }
  // Round-trip: query parquet via duckdb (separate connection)
  const r = await store.conn.runAndReadAll(
    `SELECT count(*) FROM read_parquet('${parquetInstr}')`
  );
  check("parquet round-trip count matches table", r.getRows()[0][0] === 100_000n,
    `got ${r.getRows()[0][0]}`);
}

// ---------- 8. cleanup ----------
await closeStore(store);

console.log(`\n---\nsummary: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
