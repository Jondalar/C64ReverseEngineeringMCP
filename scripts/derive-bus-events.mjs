#!/usr/bin/env node
// Spec 217 — derive bus_events from instructions table.
//
// Runs entirely as DuckDB INSERT ... SELECT (no JS-side iteration —
// large traces would OOM). For each absolute-mode instruction whose
// target ∈ watch addresses, derives kind + value from opcode +
// post-instruction register state.
//
// Reconstructable opcodes (absolute mode):
//   reads:  LDA $abs (AD), LDX $abs (AE), LDY $abs (AC), BIT $abs (2C),
//           CMP/CPX/CPY $abs (CD/EC/CC),
//           AND/ORA/EOR/ADC/SBC $abs (2D/0D/4D/6D/ED)
//   writes: STA $abs (8D), STX $abs (8E), STY $abs (8C)
//   RMW:    INC/DEC/ASL/LSR/ROL/ROR $abs (EE/CE/0E/4E/2E/6E)
//
// Value:
//   LDA / STA → A   |   LDX / STX → X   |   LDY / STY → Y
//   BIT       → top-2 bits via N+V flags (rest lost)
//   CMP/CPX/CPY/AND/ORA/EOR/ADC/SBC/RMW → NULL (read-modify-side-loss)
//
// Usage:
//   node scripts/derive-bus-events.mjs --db <path/to/trace.duckdb>
//                                      [--addr 0xDD00 ...]
//                                      [--replace]

import { resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";

function parseArgs(argv) {
  const out = { _: [], addr: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--addr") {
      const v = argv[i + 1]; i++;
      out.addr.push(/^0x/i.test(v) ? parseInt(v, 16) : Number(v));
    } else if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const dbPath = args.db ? resolvePath(args.db) : null;
if (!dbPath || !existsSync(dbPath)) {
  console.error("usage: derive-bus-events.mjs --db <path/to/trace.duckdb> [--addr 0xDD00 ...] [--replace]");
  process.exit(2);
}

const DEFAULT_ADDRS = [
  0xdd00,
  0x1800,
  0x180d, 0x180e,
  0x1c00,
  0x1c04, 0x1c05, 0x1c06, 0x1c07,
];
const watchAddrs = args.addr.length ? args.addr : DEFAULT_ADDRS;

const READ_OPCODES  = [0xad, 0xae, 0xac, 0x2c, 0xcd, 0xec, 0xcc, 0x2d, 0x0d, 0x4d, 0x6d, 0xed];
const WRITE_OPCODES = [0x8d, 0x8e, 0x8c, 0xee, 0xce, 0x0e, 0x4e, 0x2e, 0x6e];
const ALL_OPCODES   = [...READ_OPCODES, ...WRITE_OPCODES];

console.log(`derive-bus-events`);
console.log(`  db          : ${dbPath}`);
console.log(`  watch addrs : ${watchAddrs.map((a) => "$" + a.toString(16).padStart(4, "0")).join(", ")}`);
console.log(`  opcodes     : ${ALL_OPCODES.length}`);

const duck = await import("@duckdb/node-api");
const inst = await duck.DuckDBInstance.create(dbPath);
const conn = await inst.connect();

const runMeta = await conn.runAndReadAll("SELECT value FROM meta WHERE key='run_id' LIMIT 1");
const runId = runMeta.getRows()[0]?.[0] ?? "unknown";
console.log(`  run_id      : ${runId}`);

if (args.replace) {
  await conn.run(`DELETE FROM bus_events WHERE run_id='${runId}'`);
  console.log(`  cleared previous bus_events for run`);
}

const seqStartResult = await conn.runAndReadAll(
  `SELECT COALESCE(MAX(seq), 0) FROM bus_events WHERE run_id='${runId}'`,
);
const seqStartRow = seqStartResult.getRows()[0]?.[0];
const seqStart = (typeof seqStartRow === "bigint" ? seqStartRow : BigInt(seqStartRow ?? 0)) + 1n;
console.log(`  seq start   : ${seqStart}`);

// All work in one INSERT ... SELECT. DuckDB streams.
const writeOpList = WRITE_OPCODES.join(",");
const readOpList = READ_OPCODES.join(",");
const allOpList = ALL_OPCODES.join(",");
const addrList = watchAddrs.join(",");

// VICE cpuhistory captures registers BEFORE instruction (per
// 6510core.c monitor_cpuhistory_store at line 2409, fires after
// FETCH_OPCODE before execute). So:
//   STA opcodes: a == stored value (pre = post for STA). RELIABLE.
//   LDA opcodes: a == stale pre-LDA value. NEXT row's a == loaded
//                value (post-LDA = pre-next-instr). Use LEAD.
const insertSql = `
WITH src AS (
  SELECT
    cpu, clock, master_clock, pc, opcode, b1, b2, a, x, y, p, source,
    LEAD(a) OVER (PARTITION BY cpu ORDER BY clock, pc) AS a_next,
    LEAD(x) OVER (PARTITION BY cpu ORDER BY clock, pc) AS x_next,
    LEAD(y) OVER (PARTITION BY cpu ORDER BY clock, pc) AS y_next,
    LEAD(p) OVER (PARTITION BY cpu ORDER BY clock, pc) AS p_next
  FROM instructions
  WHERE run_id='${runId}'
)
INSERT INTO bus_events (
  run_id, seq, cpu, clock, master_clock, pc,
  kind, addr, value, old_value,
  line_atn, line_clk, line_data,
  source
)
SELECT
  '${runId}' AS run_id,
  CAST((ROW_NUMBER() OVER (ORDER BY clock, pc) - 1 + ${seqStart}) AS UBIGINT) AS seq,
  cpu,
  clock,
  master_clock,
  pc,
  CASE WHEN opcode IN (${writeOpList}) THEN 'write' ELSE 'read' END AS kind,
  CAST(b1 + b2 * 256 AS USMALLINT) AS addr,
  CASE
    WHEN opcode = 141 THEN a            -- STA: pre-STA a = stored value
    WHEN opcode = 142 THEN x            -- STX
    WHEN opcode = 140 THEN y            -- STY
    WHEN opcode = 173 THEN a_next       -- LDA: NEXT row's a = loaded value
    WHEN opcode = 174 THEN x_next       -- LDX
    WHEN opcode = 172 THEN y_next       -- LDY
    WHEN opcode = 44  THEN (p_next & 192) -- BIT: NEXT row's P bit7=N, bit6=V
    ELSE NULL
  END AS value,
  NULL AS old_value,
  NULL AS line_atn, NULL AS line_clk, NULL AS line_data,
  source
FROM src
WHERE opcode IN (${allOpList})
  AND b1 IS NOT NULL AND b2 IS NOT NULL
  AND (b1 + b2 * 256) IN (${addrList})
`;

console.log(`running INSERT ... SELECT (DuckDB streams; no JS memory)...`);
const t0 = Date.now();
await conn.run(insertSql);
const dt = Date.now() - t0;
console.log(`done in ${dt}ms`);

const countNew = await conn.runAndReadAll(
  `SELECT COUNT(*) FROM bus_events WHERE run_id='${runId}' AND seq >= ${seqStart}`,
);
const newRows = countNew.getRows()[0][0];
console.log(`  inserted    : ${newRows} bus_events rows`);

const summary = await conn.runAndReadAll(`
  SELECT addr, kind, count(*) AS n
  FROM bus_events WHERE run_id='${runId}'
  GROUP BY addr, kind ORDER BY addr, kind
`);
console.log(`\nbus_events summary by (addr, kind):`);
for (const [addr, kind, n] of summary.getRows()) {
  const aHex = "$" + Number(addr).toString(16).padStart(4, "0");
  console.log(`  ${aHex}\t${kind}\t${n}`);
}

inst.closeSync();
console.log(`\ndone.`);
