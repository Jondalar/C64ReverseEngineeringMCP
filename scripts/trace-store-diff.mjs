#!/usr/bin/env node
// Spec 217 — trace-store-diff CLI.
//
// Compares anchor occurrences between two trace stores (typically
// VICE baseline vs headless run). Emits a markdown report + writes
// diff_annotations rows into the second (headless) store.
//
// Usage:
//   node scripts/trace-store-diff.mjs \
//     --vice <path/to/vice/trace.duckdb> \
//     --headless <path/to/headless/trace.duckdb> \
//     [--anchor rx_wait,rx_byte,...] \
//     [--tolerance 256] \
//     [--align-anchor ab_entry] \
//     [--out report.md]
//
// --align-anchor: normalize all reported clocks to
//   relative_master_clock = anchor.master_clock - first(<name>.master_clock)
// per side. Lets you compare stores whose absolute master_clock origins
// differ (e.g. boot-time variance of ~15M cycles). Falls back to a
// (run_id, cpu, seq) join on the instructions table for legacy stores
// whose anchors row does not yet have a master_clock column.

import { resolve as resolvePath, basename, dirname, join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[k] = true; }
      else { out[k] = v; i++; }
    } else { out._.push(a); }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const viceDb = args.vice ? resolvePath(args.vice) : null;
const hlDb = args.headless ? resolvePath(args.headless) : null;
if (!viceDb || !existsSync(viceDb) || !hlDb || !existsSync(hlDb)) {
  console.error("usage: trace-store-diff.mjs --vice <duckdb> --headless <duckdb> [--anchor ...] [--tolerance 256] [--out report.md]");
  process.exit(2);
}
const tolerance = BigInt(args.tolerance ?? 256);
const anchorFilter = args.anchor ? args.anchor.split(",").map((s) => s.trim()) : null;
const alignAnchor = typeof args["align-anchor"] === "string" ? args["align-anchor"] : null;
const outPath = args.out
  ? resolvePath(args.out)
  : join(dirname(hlDb), `diff-${basename(viceDb, ".duckdb")}-vs-${basename(hlDb, ".duckdb")}.md`);

console.log(`trace-store-diff`);
console.log(`  vice      : ${viceDb}`);
console.log(`  headless  : ${hlDb}`);
console.log(`  tolerance : ±${tolerance} master_clocks`);
console.log(`  anchor    : ${anchorFilter ? anchorFilter.join(",") : "all"}`);
console.log(`  align     : ${alignAnchor ?? "(absolute)"}`);
console.log(`  out       : ${outPath}`);

const duck = await import("@duckdb/node-api");
const inst = await duck.DuckDBInstance.create(":memory:");
const conn = await inst.connect();
await conn.run(`ATTACH '${viceDb}' AS vice (READ_ONLY)`);
await conn.run(`ATTACH '${hlDb}' AS hl`);

// Make sure diff_annotations table exists in headless DB.
await conn.run(`
  CREATE TABLE IF NOT EXISTS hl.diff_annotations (
    diff_id     TEXT,
    anchor      TEXT,
    occurrence  UBIGINT,
    status      TEXT,
    vice_clock  UBIGINT,
    hl_clock    UBIGINT,
    delta_clock BIGINT,
    notes       TEXT
  )
`);

// Run-id pair for diff_id.
const viceRunRow = (await conn.runAndReadAll("SELECT value FROM vice.meta WHERE key='run_id' LIMIT 1")).getRows();
const hlRunRow   = (await conn.runAndReadAll("SELECT value FROM hl.meta WHERE key='run_id' LIMIT 1")).getRows();
const viceRunId = viceRunRow[0]?.[0] ?? "vice-unknown";
const hlRunId = hlRunRow[0]?.[0] ?? "hl-unknown";
const diffId = `${viceRunId}_vs_${hlRunId}`;

// Wipe previous diff for this diffId.
await conn.run(`DELETE FROM hl.diff_annotations WHERE diff_id='${diffId}'`);

// ----- Alignment offsets (master_clock domain) -----
// We project master_clock onto anchors via LEFT JOIN to instructions on
// (run_id, cpu, seq). This works whether or not the anchors table has
// its own master_clock column (legacy stores do not).
async function firstAnchorMasterClock(catalog, anchorName) {
  const sql = `
    SELECT MIN(i.master_clock)
    FROM ${catalog}.anchors a
    JOIN ${catalog}.instructions i
      ON i.run_id = a.run_id AND i.cpu = a.cpu AND i.seq = a.seq
    WHERE a.name = '${anchorName}'
  `;
  const r = (await conn.runAndReadAll(sql)).getRows();
  const v = r[0]?.[0];
  if (v === null || v === undefined) return null;
  return typeof v === "bigint" ? v : BigInt(v);
}

let viceOffset = 0n;
let hlOffset = 0n;
let alignNote = "absolute master_clock";
if (alignAnchor) {
  const v = await firstAnchorMasterClock("vice", alignAnchor);
  const h = await firstAnchorMasterClock("hl", alignAnchor);
  if (v === null || h === null) {
    console.error(`align-anchor '${alignAnchor}' not found in both stores (vice=${v}, hl=${h})`);
    process.exit(2);
  }
  viceOffset = v;
  hlOffset = h;
  alignNote = `aligned to first(${alignAnchor}.master_clock)  vice_offset=${v}  hl_offset=${h}`;
  console.log(`  vice off  : ${v}`);
  console.log(`  hl off    : ${h}`);
}

// Anchor list — common anchors only.
const anchorRows = (await conn.runAndReadAll(`
  SELECT v.name, v.cpu, v.pc,
         COUNT(*) AS vice_n,
         (SELECT COUNT(*) FROM hl.anchors h WHERE h.name = v.name) AS hl_n
  FROM vice.anchors v
  GROUP BY v.name, v.cpu, v.pc
  ORDER BY v.name
`)).getRows();

const lines = [];
const ts = new Date().toISOString();
lines.push(`# Trace diff — ${diffId.slice(0, 80)}`);
lines.push("");
lines.push(`Generated: ${ts}`);
lines.push(``);
lines.push(`- VICE run:     \`${viceRunId}\``);
lines.push(`- Headless run: \`${hlRunId}\``);
lines.push(`- Tolerance:    ±${tolerance} master_clocks`);
lines.push(`- Alignment:    ${alignNote}`);
lines.push(``);

// ----- Section 1: anchor occurrence summary -----
lines.push(`## 1. Anchor occurrence summary`);
lines.push(``);
lines.push(`| anchor | cpu | pc | VICE | headless | delta | delta % |`);
lines.push(`|---|---|---:|---:|---:|---:|---:|`);
for (const [name, cpu, pc, viceN, hlN] of anchorRows) {
  if (anchorFilter && !anchorFilter.includes(name)) continue;
  const v = Number(viceN);
  const h = Number(hlN);
  const delta = h - v;
  const pct = v > 0 ? ((delta / v) * 100).toFixed(1) : "—";
  const pcHex = "$" + Number(pc).toString(16).padStart(4, "0");
  lines.push(`| \`${name}\` | ${cpu} | ${pcHex} | ${v} | ${h} | ${delta >= 0 ? "+" : ""}${delta} | ${pct}% |`);
}
lines.push(``);

// ----- Section 2: per-anchor occurrence diff (top N) -----
const occLimit = Number(args["occ-limit"] ?? 100);
const annSeqStart = (await conn.runAndReadAll(
  `SELECT COALESCE(MAX(rowid), 0) FROM hl.diff_annotations`,
)).getRows()[0][0];

const eligible = anchorRows
  .map((r) => ({ name: r[0], cpu: r[1], pc: Number(r[2]), viceN: Number(r[3]), hlN: Number(r[4]) }))
  .filter((a) => a.viceN > 0 && a.hlN > 0)
  .filter((a) => !anchorFilter || anchorFilter.includes(a.name));

let firstDivergence = null;

for (const a of eligible) {
  lines.push(`## 2. Anchor \`${a.name}\` — first ${Math.min(occLimit, a.viceN, a.hlN)} occurrences`);
  lines.push(``);
  lines.push(`VICE: ${a.viceN} occurrences. Headless: ${a.hlN} occurrences. Comparing first ${Math.min(occLimit, a.viceN, a.hlN)}.`);
  lines.push(``);
  // Pull first occLimit occurrences from each side aligned by occurrence number.
  // When --align-anchor is set, project master_clock from instructions and
  // subtract the per-side offset, producing relative master clocks that
  // can be compared across stores whose absolute origins differ.
  const sql = alignAnchor ? `
    WITH v AS (
      SELECT a.occurrence,
             (CAST(i.master_clock AS BIGINT) - ${viceOffset}) AS vice_clock
      FROM vice.anchors a
      JOIN vice.instructions i
        ON i.run_id = a.run_id AND i.cpu = a.cpu AND i.seq = a.seq
      WHERE a.name='${a.name}' AND a.occurrence <= ${occLimit}
        AND i.master_clock >= ${viceOffset}
    ),
    h AS (
      SELECT a.occurrence,
             (CAST(i.master_clock AS BIGINT) - ${hlOffset}) AS hl_clock
      FROM hl.anchors a
      JOIN hl.instructions i
        ON i.run_id = a.run_id AND i.cpu = a.cpu AND i.seq = a.seq
      WHERE a.name='${a.name}' AND a.occurrence <= ${occLimit}
        AND i.master_clock >= ${hlOffset}
    )
    SELECT v.occurrence, v.vice_clock, h.hl_clock,
           (h.hl_clock - v.vice_clock) AS delta_clock
    FROM v JOIN h ON v.occurrence = h.occurrence
    ORDER BY v.occurrence
  ` : `
    WITH v AS (
      SELECT occurrence, clock AS vice_clock
      FROM vice.anchors
      WHERE name='${a.name}' AND occurrence <= ${occLimit}
    ),
    h AS (
      SELECT occurrence, clock AS hl_clock
      FROM hl.anchors
      WHERE name='${a.name}' AND occurrence <= ${occLimit}
    )
    SELECT v.occurrence, v.vice_clock, h.hl_clock,
           (CAST(h.hl_clock AS BIGINT) - CAST(v.vice_clock AS BIGINT)) AS delta_clock
    FROM v JOIN h ON v.occurrence = h.occurrence
    ORDER BY v.occurrence
  `;
  const rows = (await conn.runAndReadAll(sql)).getRows();
  if (rows.length === 0) {
    lines.push(`(no overlapping occurrences)`);
    lines.push(``);
    continue;
  }

  let divergeAt = null;
  let matchCount = 0;
  let withinTolCount = 0;
  let divergeCount = 0;

  // Append annotations (JS sig: table, schema, catalog)
  const app = await conn.createAppender("diff_annotations", "main", "hl");
  for (const [occ, vClk, hClk, dClk] of rows) {
    const occNum = typeof occ === "bigint" ? occ : BigInt(occ);
    const vClkN = typeof vClk === "bigint" ? vClk : BigInt(vClk);
    const hClkN = typeof hClk === "bigint" ? hClk : BigInt(hClk);
    const delta = typeof dClk === "bigint" ? dClk : BigInt(dClk);
    const absD = delta < 0n ? -delta : delta;
    let status;
    if (absD === 0n) { status = "match"; matchCount++; }
    else if (absD <= tolerance) { status = "within_tolerance"; withinTolCount++; }
    else { status = "divergence"; divergeCount++; if (divergeAt === null) divergeAt = { occ: occNum, vClk: vClkN, hClk: hClkN, delta }; }

    app.appendVarchar(diffId);
    app.appendVarchar(a.name);
    app.appendUBigInt(occNum);
    app.appendVarchar(status);
    app.appendUBigInt(vClkN);
    app.appendUBigInt(hClkN);
    app.appendBigInt(delta);
    app.appendVarchar("");
    app.endRow();
  }
  app.flushSync();
  app.closeSync();

  lines.push(`| status | count |`);
  lines.push(`|---|---:|`);
  lines.push(`| match (Δ=0) | ${matchCount} |`);
  lines.push(`| within tolerance (|Δ|≤${tolerance}) | ${withinTolCount} |`);
  lines.push(`| divergence (|Δ|>${tolerance}) | ${divergeCount} |`);
  lines.push(``);

  if (divergeAt) {
    lines.push(`First divergence at occurrence ${divergeAt.occ}:`);
    lines.push(`- VICE master_clock = ${divergeAt.vClk}`);
    lines.push(`- HL   master_clock = ${divergeAt.hClk}`);
    lines.push(`- delta = ${divergeAt.delta} (> ±${tolerance})`);
    lines.push(``);
    if (firstDivergence === null) firstDivergence = { anchor: a.name, ...divergeAt };
  }
}

// ----- Section 3: cadence per Mc window for $43CF rx-byte (motm specific) -----
if (eligible.find((a) => a.name === "rx_byte")) {
  lines.push(`## 3. Cadence: rx_byte (\$43CF) per 1M master-clocks`);
  lines.push(``);
  const cadenceSql = `
    WITH v AS (
      SELECT FLOOR(clock / 1000000) AS mc, COUNT(*) AS n
      FROM vice.anchors WHERE name='rx_byte' GROUP BY 1
    ),
    h AS (
      SELECT FLOOR(clock / 1000000) AS mc, COUNT(*) AS n
      FROM hl.anchors WHERE name='rx_byte' GROUP BY 1
    )
    SELECT COALESCE(v.mc, h.mc) AS mc,
           COALESCE(v.n, 0) AS vice_n,
           COALESCE(h.n, 0) AS hl_n
    FROM v FULL OUTER JOIN h ON v.mc = h.mc
    ORDER BY mc
    LIMIT 60
  `;
  const cad = (await conn.runAndReadAll(cadenceSql)).getRows();
  if (cad.length > 0) {
    lines.push(`| Mc-window | VICE | headless | delta |`);
    lines.push(`|---:|---:|---:|---:|`);
    for (const [mc, vN, hN] of cad) {
      const v = Number(vN);
      const h = Number(hN);
      const d = h - v;
      lines.push(`| ${mc} | ${v} | ${h} | ${d >= 0 ? "+" : ""}${d} |`);
    }
    lines.push(``);
  }
}

// ----- Section 4: bus_events $DD00 cadence (if both have data) -----
const busViceN = Number((await conn.runAndReadAll(
  "SELECT COUNT(*) FROM vice.bus_events WHERE addr=56576",
)).getRows()[0][0]);
const busHlN = Number((await conn.runAndReadAll(
  "SELECT COUNT(*) FROM hl.bus_events WHERE addr=56576",
)).getRows()[0][0]);
lines.push(`## 4. Bus events @ \$DD00`);
lines.push(``);
lines.push(`| | VICE | headless | delta |`);
lines.push(`|---|---:|---:|---:|`);
lines.push(`| total | ${busViceN} | ${busHlN} | ${busHlN - busViceN >= 0 ? "+" : ""}${busHlN - busViceN} |`);
lines.push(``);

// Footer
lines.push(`---`);
lines.push(``);
lines.push(`Diff annotations stored in \`hl.diff_annotations\` (diff_id=\`${diffId}\`).`);
lines.push(`Re-run with \`--anchor <name>\` to focus or \`--tolerance N\` to widen.`);

writeFileSync(outPath, lines.join("\n") + "\n");

console.log(``);
console.log(`report -> ${outPath}`);
const annCount = (await conn.runAndReadAll(
  `SELECT COUNT(*) FROM hl.diff_annotations WHERE diff_id='${diffId}'`,
)).getRows()[0][0];
console.log(`diff_annotations rows written: ${annCount}`);

inst.closeSync();
