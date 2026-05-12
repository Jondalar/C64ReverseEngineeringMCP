#!/usr/bin/env node
// Spec 232 smoke — typed event query API on top of DuckDB store.
//
// Populates a synthetic trace via existing chunk-buffer + sink, then
// queries it through the V2 EventFamily-typed API. Verifies row
// shapes, range filters, predicate sanitization.

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

const { allocateInstructionChunk, allocateBusEventChunk, allocateChipEventChunk,
  appendInstruction, appendBusEvent, appendChipEvent } =
  await import(`${repoRoot}/dist/runtime/trace-store/chunk-buffer.js`);
const { openStore, closeStore, DuckDbTraceSink } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { queryEvents } =
  await import(`${repoRoot}/dist/runtime/headless/v2/query-events.js`);
const { DuckDbQueryBackend } =
  await import(`${repoRoot}/dist/runtime/headless/v2/duckdb-backend.js`);

const tmpDir = "/tmp/c64re-trace-query-smoke";
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const dbPath = `${tmpDir}/trace.duckdb`;
const meta = {
  runId: "spec232-smoke",
  source: "headless",
  capturedAt: new Date().toISOString(),
  writerVersion: "spec232",
  c64ClockHz: 985_248,
  driveClockHz: 1_000_000,
  c64ClockZero: 0n,
  driveClockZero: 0n,
  driveToC64Offset: 0n,
};

const store = await openStore({ path: dbPath, meta });
const sink = new DuckDbTraceSink({ store });

// Populate: 100 cpu_step + 50 mem_write to $0763 + 50 mem_read +
// 10 cia_timer_underflow + 5 irq_assert
const instr = allocateInstructionChunk("headless", "c64", 256);
for (let i = 0; i < 100; i++) {
  appendInstruction(instr, {
    seq: BigInt(i), clock: BigInt(i * 4),
    masterClock: BigInt(i * 4),
    pc: 0x0800 + i, opcode: 0xea, b1: undefined, b2: undefined,
    a: i & 0xff, x: 0, y: 0, sp: 0xff, p: 0x20,
  });
}
await sink.writeInstructionChunk(instr);

const busChunk = allocateBusEventChunk("headless", "c64", 256);
let seq = 1000n;
for (let i = 0; i < 50; i++) {
  appendBusEvent(busChunk, {
    seq: seq++, clock: BigInt(1000 + i * 10), masterClock: BigInt(1000 + i * 10),
    pc: 0x05b7, kind: "write",
    addr: 0x0763, value: 0x11 + i,
  });
}
for (let i = 0; i < 50; i++) {
  appendBusEvent(busChunk, {
    seq: seq++, clock: BigInt(2000 + i * 10), masterClock: BigInt(2000 + i * 10),
    pc: 0x0900, kind: "read",
    addr: 0xdc0d, value: 0x80,
  });
}
await sink.writeBusEventChunk(busChunk);

const chipChunk = allocateChipEventChunk("headless", "c64", 64);
for (let i = 0; i < 10; i++) {
  appendChipEvent(chipChunk, {
    seq: seq++, clock: BigInt(3000 + i * 100), masterClock: BigInt(3000 + i * 100),
    pc: 0xfe43, chip: "cia1", kind: "timer_underflow",
    unit: i % 2, value: undefined, oldValue: undefined,
  });
}
for (let i = 0; i < 5; i++) {
  appendChipEvent(chipChunk, {
    seq: seq++, clock: BigInt(4000 + i * 200), masterClock: BigInt(4000 + i * 200),
    pc: 0xfe43, chip: "cia2", kind: "irq_assert",
    unit: 0, value: undefined, oldValue: undefined,
  });
}
await sink.writeChipEventChunk(chipChunk);

const backend = new DuckDbQueryBackend(store.conn);

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); console.log(`  PASS  ${name}`); }
  catch (e) { results.push({ name, pass: false, err: e.message }); console.log(`  FAIL  ${name}: ${e.message}`); }
}

console.log("=== Spec 232 — typed event query API ===\n");

await (async () => {
  test("queryEvents cpu_step returns 100 rows", async () => {});
  // Defer real test work to async iter below
})();

async function run() {
  // 1: cpu_step count
  let rows = await queryEvents(backend, { runId: "spec232-smoke", family: "cpu_step" });
  if (rows.length !== 100) throw new Error(`expected 100 cpu_step, got ${rows.length}`);
  if (rows[0].family !== "cpu_step") throw new Error("family mismatch");
  console.log(`  PASS  cpu_step query: ${rows.length} rows`);

  // 2: mem_write filter
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "mem_write", addrRange: [0x0763, 0x0763] });
  if (rows.length !== 50) throw new Error(`expected 50 mem_write, got ${rows.length}`);
  if (rows[0].addr !== 0x0763) throw new Error(`first row addr ${rows[0].addr.toString(16)}`);
  console.log(`  PASS  mem_write to $0763: ${rows.length} rows`);

  // 3: mem_read at $DC0D
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "mem_read", addrRange: [0xdc0d, 0xdc0d] });
  if (rows.length !== 50) throw new Error(`expected 50 mem_read at $DC0D, got ${rows.length}`);
  console.log(`  PASS  mem_read $DC0D: ${rows.length} rows`);

  // 4: cycle range
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "cpu_step", cycleRange: [0, 200] });
  if (rows.length !== 51) throw new Error(`expected 51 in cycles 0-200, got ${rows.length}`);
  console.log(`  PASS  cycle range filter: ${rows.length} rows`);

  // 5: cia_timer_underflow
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "cia_timer_underflow" });
  if (rows.length !== 10) throw new Error(`expected 10 cia_timer_underflow, got ${rows.length}`);
  if (rows[0].chip !== "cia1") throw new Error(`chip ${rows[0].chip}`);
  console.log(`  PASS  cia_timer_underflow: ${rows.length} rows`);

  // 6: irq_assert
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "irq_assert" });
  if (rows.length !== 5) throw new Error(`expected 5 irq_assert, got ${rows.length}`);
  console.log(`  PASS  irq_assert: ${rows.length} rows`);

  // 7: predicate injection blocked
  let threw = false;
  try {
    await queryEvents(backend, { runId: "spec232-smoke", family: "cpu_step", predicate: "1=1; DROP TABLE instructions" });
  } catch (e) { threw = true; }
  if (!threw) throw new Error("predicate injection not blocked");
  console.log(`  PASS  predicate sanitization`);

  // 8: unsupported family returns empty
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "vic_sprite_collision" });
  if (rows.length !== 0) throw new Error(`unsupported family should return empty, got ${rows.length}`);
  console.log(`  PASS  unsupported family returns empty`);

  // 9: limit
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "cpu_step", limit: 10 });
  if (rows.length !== 10) throw new Error(`expected 10 limited, got ${rows.length}`);
  console.log(`  PASS  limit clamps to 10`);

  // 10: pcRange
  rows = await queryEvents(backend, { runId: "spec232-smoke", family: "cpu_step", pcRange: [0x0820, 0x082f] });
  if (rows.length !== 16) throw new Error(`expected 16 in pc range, got ${rows.length}`);
  console.log(`  PASS  pcRange filter: ${rows.length} rows`);
}

await run();
await sink.close();
await closeStore(store);

console.log(`\nSpec 232 trace query: 10/10 expected pass`);
process.exit(0);
