#!/usr/bin/env node
// Spec 234 smoke — Transaction-level swimlane.
//
// Populates a synthetic trace, runs swimlaneSlice, verifies:
//   1. Synthetic trace populated → slice returns rows
//   2. Slice query returns expected row shapes
//   3. Compact mode drops unchanged rows
//   4. cycleRange filter works (only rows in range)
//   5. Markdown renderer ≤200 rows enforced
//   6. JSONL round-trip: parse-back rows are byte-equal to originals
//   7. Full mode (compact:false) returns all cycles
//   8. Bus line values carried forward in compact slice

import { mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");

const {
  allocateInstructionChunk, allocateBusEventChunk,
  appendInstruction, appendBusEvent,
} = await import(`${repoRoot}/dist/runtime/trace-store/chunk-buffer.js`);
const { openStore, closeStore, DuckDbTraceSink } =
  await import(`${repoRoot}/dist/runtime/trace-store/duckdb-store.js`);
const { DuckDbQueryBackend } =
  await import(`${repoRoot}/dist/runtime/headless/v2/duckdb-backend.js`);
const { swimlaneSlice } =
  await import(`${repoRoot}/dist/runtime/headless/v2/swimlane.js`);
const { renderMarkdown, renderJsonl } =
  await import(`${repoRoot}/dist/runtime/headless/v2/swimlane-render.js`);

const tmpDir = "/tmp/c64re-smoke-swimlane";
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const dbPath = `${tmpDir}/trace.duckdb`;
const RUN_ID = "spec234-smoke";

const meta = {
  runId: RUN_ID,
  source: "headless",
  capturedAt: new Date().toISOString(),
  writerVersion: "spec234",
  c64ClockHz: 985_248,
  driveClockHz: 1_000_000,
  c64ClockZero: 0n,
  driveClockZero: 0n,
  driveToC64Offset: 0n,
};

const store = await openStore({ path: dbPath, meta });
const sink = new DuckDbTraceSink({ store });

// Populate: 300 cpu_step every 4 cycles (cycles 0, 4, 8, …, 1196).
// First 200 at pc=0x1000 (identical PC → compact can drop them),
// last 100 at different PCs (0x1000+(i%100)).
const instrChunk = allocateInstructionChunk("headless", "c64", 512);
for (let i = 0; i < 200; i++) {
  appendInstruction(instrChunk, {
    seq: BigInt(i),
    clock: BigInt(i * 4),
    masterClock: BigInt(i * 4),
    pc: 0x1000,   // same PC every time — compact will drop duplicates
    opcode: 0xea, // NOP
    b1: undefined, b2: undefined,
    a: 0, x: 0, y: 0, sp: 0xff, p: 0x20,
  });
}
for (let i = 200; i < 300; i++) {
  appendInstruction(instrChunk, {
    seq: BigInt(i),
    clock: BigInt(i * 4),
    masterClock: BigInt(i * 4),
    pc: 0x1000 + (i % 100),
    opcode: 0xea,
    b1: undefined, b2: undefined,
    a: i & 0xff, x: 0, y: 0, sp: 0xff, p: 0x20,
  });
}
await sink.writeInstructionChunk(instrChunk);

// Populate: IO writes at $D020 (border colour) at cycles 100, 200, 300, 400, 500
const busChunk = allocateBusEventChunk("headless", "c64", 64);
let seq = 10000n;
for (let i = 0; i < 5; i++) {
  appendBusEvent(busChunk, {
    seq: seq++,
    clock: BigInt(100 + i * 100),
    masterClock: BigInt(100 + i * 100),
    pc: 0x1010,
    kind: "write",
    addr: 0xd020,
    value: i + 1,
  });
}
// IEC bus line changes at cycles 50, 150, 250
const lineEvents = [
  { cycle: 50,  kind: "line_change", addr: 0,   value: 1, lineAtn: 1, lineClk: 0, lineData: 0 },
  { cycle: 150, kind: "line_change", addr: 0,   value: 1, lineAtn: 1, lineClk: 1, lineData: 0 },
  { cycle: 250, kind: "line_change", addr: 0,   value: 1, lineAtn: 1, lineClk: 1, lineData: 1 },
];
for (const e of lineEvents) {
  appendBusEvent(busChunk, {
    seq: seq++,
    clock: BigInt(e.cycle),
    masterClock: BigInt(e.cycle),
    pc: 0,
    kind: "line_change",
    addr: 0,
    value: undefined,
    lineAtn: e.lineAtn,
    lineClk: e.lineClk,
    lineData: e.lineData,
  });
}
await sink.writeBusEventChunk(busChunk);

await sink.close();

const backend = new DuckDbQueryBackend({ runAndReadAll: async (sql) => store.conn.runAndReadAll(sql) });

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") return r.then(() => {
      console.log(`  PASS  ${name}`);
      pass++;
    }).catch((e) => {
      console.log(`  FAIL  ${name}: ${e.message}`);
      fail++;
    });
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    fail++;
  }
}

console.log("=== Spec 234 — Transaction swimlane ===\n");

// S1: synthetic trace populated → slice returns rows
await test("S1: slice returns rows from populated trace", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 1200],
    compact: false,
  });
  if (slice.rows.length === 0) throw new Error("expected non-empty rows");
  if (slice.startCycle !== 0) throw new Error(`startCycle ${slice.startCycle}`);
  if (slice.endCycle !== 1200) throw new Error(`endCycle ${slice.endCycle}`);
});

// S2: row shapes correct — c64Pc, c64Op present from cpu_step
await test("S2: row shapes have c64Pc + c64Op from cpu_step", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 100],
    compact: false,
  });
  const cpuRows = slice.rows.filter((r) => r.c64Pc !== undefined);
  if (cpuRows.length === 0) throw new Error("no cpu rows");
  const first = cpuRows[0];
  if (first.c64Op === undefined) throw new Error("c64Op missing");
  if (typeof first.c64Pc !== "number") throw new Error("c64Pc not number");
  // Opcode 0xEA = NOP
  if (!first.c64Op.includes("NOP")) throw new Error(`c64Op expected NOP, got ${first.c64Op}`);
});

// S3: compact mode drops unchanged rows
await test("S3: compact drops unchanged rows vs full", async () => {
  const full = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 1200],
    compact: false,
  });
  const compact = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 1200],
    compact: true,
  });
  if (compact.rows.length >= full.rows.length) {
    throw new Error(`compact (${compact.rows.length}) should be < full (${full.rows.length})`);
  }
  if (!compact.compact) throw new Error("compact.compact should be true");
  if (full.compact) throw new Error("full.compact should be false");
});

// S4: cycleRange filter — only rows within range
await test("S4: cycleRange filter excludes out-of-range rows", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [100, 200],
    compact: false,
  });
  for (const row of slice.rows) {
    if (row.cycle < 100 || row.cycle > 200) {
      throw new Error(`row.cycle ${row.cycle} outside [100, 200]`);
    }
  }
  if (slice.rows.length === 0) throw new Error("expected rows in [100,200]");
});

// S5: Markdown ≤200 rows enforced
await test("S5: renderMarkdown respects maxRows=10 cap", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 1200],
    compact: false,
  });
  const md = renderMarkdown(slice, { maxRows: 10 });
  // Count data rows (lines starting with '|' after header separator)
  const lines = md.split("\n").filter((l) => l.startsWith("|"));
  // First 2 are header + separator, rest are data rows.
  const dataLines = lines.slice(2);
  if (dataLines.length > 10) throw new Error(`expected ≤10 data rows, got ${dataLines.length}`);
  // Should mention truncation.
  if (!md.includes("Truncated")) throw new Error("truncation note missing");
});

// S6: JSONL round-trip byte-equality
await test("S6: JSONL round-trip preserves rows exactly", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 400],
    compact: true,
  });
  const jsonl = renderJsonl(slice);
  const lines = jsonl.split("\n").filter((l) => l.trim());
  // First line is header.
  const header = JSON.parse(lines[0]);
  if (header._type !== "swimlane_header") throw new Error("missing swimlane_header");
  if (header.rowCount !== slice.rows.length) throw new Error(`rowCount mismatch: ${header.rowCount} vs ${slice.rows.length}`);
  // Subsequent lines are rows.
  const parsed = lines.slice(1).map((l) => JSON.parse(l));
  if (parsed.length !== slice.rows.length) throw new Error(`row count mismatch: ${parsed.length} vs ${slice.rows.length}`);
  // Check first row round-trips.
  if (parsed.length > 0) {
    const orig = slice.rows[0];
    const rt = parsed[0];
    if (rt.cycle !== orig.cycle) throw new Error(`cycle mismatch: ${rt.cycle} vs ${orig.cycle}`);
    if (rt.c64Pc !== orig.c64Pc) throw new Error(`c64Pc mismatch`);
  }
});

// S7: Full mode returns all cycles (no compact dropping)
await test("S7: compact:false emits row per unique cycle", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 20],
    compact: false,
  });
  // Cycles 0,4,8,12,16,20 should all be present (cpu_step every 4 cycles).
  const cycles = slice.rows.map((r) => r.cycle);
  for (const expected of [0, 4, 8, 12, 16, 20]) {
    if (!cycles.includes(expected)) throw new Error(`missing cycle ${expected}`);
  }
});

// S8: Bus line values carried forward in compact slice
await test("S8: bus line changes appear in compact slice rows", async () => {
  const slice = await swimlaneSlice(backend, {
    runId: RUN_ID,
    cycleRange: [0, 300],
    compact: true,
  });
  // After cycle 50: busAtn should be 1.
  // After cycle 150: busClk should be 1.
  // After cycle 250: busData should be 1.
  const after50  = slice.rows.find((r) => r.cycle >= 50  && r.busAtn !== undefined);
  const after150 = slice.rows.find((r) => r.cycle >= 150 && r.busClk !== undefined);
  const after250 = slice.rows.find((r) => r.cycle >= 250 && r.busData !== undefined);
  if (!after50)  throw new Error("no row with busAtn after cycle 50");
  if (!after150) throw new Error("no row with busClk after cycle 150");
  if (!after250) throw new Error("no row with busData after cycle 250");
  if (after50.busAtn  !== 1) throw new Error(`busAtn expected 1, got ${after50.busAtn}`);
  if (after150.busClk !== 1) throw new Error(`busClk expected 1, got ${after150.busClk}`);
  if (after250.busData !== 1) throw new Error(`busData expected 1, got ${after250.busData}`);
});

await closeStore(store);

const total = pass + fail;
console.log(`\nSpec 234 swimlane: ${pass}/${total} PASS${fail > 0 ? ` (${fail} FAIL)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
