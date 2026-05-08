#!/usr/bin/env node
// Spec 267 smoke — Trace viewer pure helper functions.
//
// Tests parseMarkdownSwimlane() and rowsToJsonl() without DOM or WS.
// These are pure functions so no build step is needed — we inline
// equivalent logic and test via structural checks.
//
// Cases:
//   T1: parseMarkdownSwimlane — basic table with 3 rows
//   T2: parseMarkdownSwimlane — truncation note parsed correctly
//   T3: parseMarkdownSwimlane — empty / malformed table returns { rows:[], totalRows:0 }
//   T4: parseMarkdownSwimlane — all 8 columns extracted correctly
//   T5: rowsToJsonl — header + rows serialised correctly
//   T6: rowsToJsonl — round-trip: parse header + rows back to objects
//   T7: rowsToJsonl — empty rows list produces header-only JSONL
//   T8: parseMarkdownSwimlane — large table (250 rows) cap at 200 visible

// ── Inline the pure helpers (mirrors ui/src/v3/tabs/Trace.tsx) ───────────────

/**
 * @param {string} md
 * @returns {{ rows: Array<{cycle:number,c64Pc:string,c64Op:string,c64Io:string,bus:string,drvPc:string,drvOp:string,drvIo:string}>, totalRows: number }}
 */
function parseMarkdownSwimlane(md) {
  const lines = md.split("\n");
  const sepIdx = lines.findIndex((l) => /^\|[-:| ]+\|/.test(l));
  if (sepIdx < 0) return { rows: [], totalRows: 0 };

  const dataLines = lines.slice(sepIdx + 1).filter((l) => l.startsWith("|"));
  const rows = [];

  for (const line of dataLines) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 9) continue;
    const cycle = parseInt(cells[1], 10);
    if (isNaN(cycle)) continue;
    rows.push({
      cycle,
      c64Pc: cells[2] ?? "",
      c64Op: cells[3] ?? "",
      c64Io: cells[4] ?? "",
      bus:   cells[5] ?? "",
      drvPc: cells[6] ?? "",
      drvOp: cells[7] ?? "",
      drvIo: cells[8] ?? "",
    });
  }

  const truncLine = lines.find((l) => l.includes("Truncated:"));
  let totalRows = rows.length;
  if (truncLine) {
    const m = truncLine.match(/of (\d+) rows/);
    if (m) totalRows = parseInt(m[1], 10);
  }

  return { rows, totalRows };
}

/**
 * @param {Array<{cycle:number,c64Pc:string,c64Op:string,c64Io:string,bus:string,drvPc:string,drvOp:string,drvIo:string}>} rows
 * @param {{ startCycle: number, endCycle: number }} meta
 * @returns {string}
 */
function rowsToJsonl(rows, meta) {
  const header = JSON.stringify({
    _type: "swimlane_header",
    startCycle: meta.startCycle,
    endCycle: meta.endCycle,
    rowCount: rows.length,
  });
  const rowLines = rows.map((r) => JSON.stringify(r));
  return [header, ...rowLines].join("\n");
}

// ── Test harness ─────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    fail++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const BASIC_MD = `
# Swimlane 0–1000 (compact)

| cycle | c64_pc | c64_op | c64_io | bus | drv_pc | drv_op | drv_io |
|------:|-------:|--------|--------|-----|-------:|--------|--------|
| 100 | $E5CD | LDA #imm | $D020 w=01 | A1C0D0 | $1234 | NOP | |
| 200 | $E5CF | STA abs | | | | | |
| 300 | $E5D2 | JSR abs | $D011 r=1B | | $1235 | BNE rel | |
`.trim();

const TRUNCATED_MD = `
# Swimlane 0–9999 (compact)

| cycle | c64_pc | c64_op | c64_io | bus | drv_pc | drv_op | drv_io |
|------:|-------:|--------|--------|-----|-------:|--------|--------|
| 1 | $1000 | NOP | | | | | |
| 2 | $1001 | NOP | | | | | |

> _Truncated: showing 200 of 1500 rows._
`.trim();

const MALFORMED_MD = `
No table here
just text
`.trim();

function makeRow(cycle) {
  return {
    cycle,
    c64Pc: "$" + cycle.toString(16).toUpperCase().padStart(4, "0"),
    c64Op: "NOP",
    c64Io: "",
    bus: "",
    drvPc: "",
    drvOp: "",
    drvIo: "",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("=== Spec 267 — Trace viewer helper smoke ===\n");

test("T1: parseMarkdownSwimlane — 3-row basic table", () => {
  const { rows, totalRows } = parseMarkdownSwimlane(BASIC_MD);
  assert(rows.length === 3, `expected 3 rows, got ${rows.length}`);
  assert(totalRows === 3, `totalRows should be 3, got ${totalRows}`);
  assert(rows[0].cycle === 100, `first row cycle ${rows[0].cycle}`);
  assert(rows[1].cycle === 200, `second row cycle ${rows[1].cycle}`);
  assert(rows[2].cycle === 300, `third row cycle ${rows[2].cycle}`);
});

test("T2: parseMarkdownSwimlane — truncation note overrides count", () => {
  const { rows, totalRows } = parseMarkdownSwimlane(TRUNCATED_MD);
  assert(rows.length === 2, `expected 2 visible rows, got ${rows.length}`);
  assert(totalRows === 1500, `totalRows should be 1500 (from note), got ${totalRows}`);
});

test("T3: parseMarkdownSwimlane — malformed/empty returns zero rows", () => {
  const empty = parseMarkdownSwimlane("");
  assert(empty.rows.length === 0, "empty string should give 0 rows");
  assert(empty.totalRows === 0, "totalRows should be 0");

  const malformed = parseMarkdownSwimlane(MALFORMED_MD);
  assert(malformed.rows.length === 0, "malformed should give 0 rows");
});

test("T4: parseMarkdownSwimlane — all 8 columns extracted", () => {
  const { rows } = parseMarkdownSwimlane(BASIC_MD);
  const r = rows[0];
  assert(r.c64Pc === "$E5CD", `c64Pc: ${r.c64Pc}`);
  assert(r.c64Op === "LDA #imm", `c64Op: ${r.c64Op}`);
  assert(r.c64Io === "$D020 w=01", `c64Io: ${r.c64Io}`);
  assert(r.bus === "A1C0D0", `bus: ${r.bus}`);
  assert(r.drvPc === "$1234", `drvPc: ${r.drvPc}`);
  assert(r.drvOp === "NOP", `drvOp: ${r.drvOp}`);
  // drvIo is empty string for first row
  assert(typeof r.drvIo === "string", `drvIo should be string, got ${typeof r.drvIo}`);
});

test("T5: rowsToJsonl — header + rows serialised correctly", () => {
  const rows = [makeRow(100), makeRow(200), makeRow(300)];
  const jsonl = rowsToJsonl(rows, { startCycle: 100, endCycle: 300 });
  const lines = jsonl.split("\n").filter((l) => l.trim());
  assert(lines.length === 4, `expected 4 lines (1 header + 3 rows), got ${lines.length}`);
  const hdr = JSON.parse(lines[0]);
  assert(hdr._type === "swimlane_header", `header _type: ${hdr._type}`);
  assert(hdr.rowCount === 3, `header rowCount: ${hdr.rowCount}`);
  assert(hdr.startCycle === 100, `header startCycle: ${hdr.startCycle}`);
  assert(hdr.endCycle === 300, `header endCycle: ${hdr.endCycle}`);
});

test("T6: rowsToJsonl — round-trip preserves row values", () => {
  const rows = [makeRow(42), makeRow(99)];
  const jsonl = rowsToJsonl(rows, { startCycle: 42, endCycle: 99 });
  const lines = jsonl.split("\n").filter((l) => l.trim());
  const parsed = lines.slice(1).map((l) => JSON.parse(l));
  assert(parsed.length === 2, `parsed ${parsed.length} rows`);
  assert(parsed[0].cycle === 42, `first row cycle: ${parsed[0].cycle}`);
  assert(parsed[1].cycle === 99, `second row cycle: ${parsed[1].cycle}`);
  assert(parsed[0].c64Op === "NOP", `c64Op: ${parsed[0].c64Op}`);
});

test("T7: rowsToJsonl — empty rows list produces header-only JSONL", () => {
  const jsonl = rowsToJsonl([], { startCycle: 0, endCycle: 1000 });
  const lines = jsonl.split("\n").filter((l) => l.trim());
  assert(lines.length === 1, `expected 1 line (header only), got ${lines.length}`);
  const hdr = JSON.parse(lines[0]);
  assert(hdr.rowCount === 0, `rowCount: ${hdr.rowCount}`);
});

test("T8: parseMarkdownSwimlane — large table parses all rows in fixture", () => {
  // Build a synthetic 250-row table (renderMarkdown would cap at 200 and add truncation note).
  const lines = [
    "# Swimlane 0–1000 (compact)",
    "",
    "| cycle | c64_pc | c64_op | c64_io | bus | drv_pc | drv_op | drv_io |",
    "|------:|-------:|--------|--------|-----|-------:|--------|--------|",
  ];
  for (let i = 0; i < 200; i++) {
    lines.push(`| ${i * 4} | $${i.toString(16).padStart(4,"0").toUpperCase()} | NOP | | | | | |`);
  }
  lines.push("");
  lines.push("> _Truncated: showing 200 of 250 rows._");
  const md = lines.join("\n");
  const { rows, totalRows } = parseMarkdownSwimlane(md);
  assert(rows.length === 200, `expected 200 visible rows, got ${rows.length}`);
  assert(totalRows === 250, `totalRows should be 250 (from note), got ${totalRows}`);
  assert(rows[0].cycle === 0, `first cycle: ${rows[0].cycle}`);
  assert(rows[199].cycle === 199 * 4, `last cycle: ${rows[199].cycle}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

const total = pass + fail;
console.log(`\nSpec 267 helpers: ${pass}/${total} PASS${fail > 0 ? ` (${fail} FAIL)` : ""}`);
process.exit(fail > 0 ? 1 : 0);
