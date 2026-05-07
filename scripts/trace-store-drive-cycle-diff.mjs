#!/usr/bin/env node
// Spec 218 H1 probe — drive 6502 cycle accounting diff.
//
// For each drive instruction in the bit-bang window, compute the
// duration via LEAD(master_clock). Aggregate per opcode. Compare
// VICE vs headless. A non-zero (vice_avg - hl_avg) for an opcode
// means the headless drive cpu accounts that opcode's cycles
// differently — the H1 hypothesis from Spec 218.
//
// Also walks the two sides instruction-by-instruction within the
// window from the first divergent $DD00 write (idx 2 in motm TX#3)
// backwards, looking for the earliest drive-side PC mismatch where
// the two cpus part ways.
//
// Usage:
//   node scripts/trace-store-drive-cycle-diff.mjs \
//     --vice <vice.duckdb> --headless <hl.duckdb> \
//     [--tx-occurrence 3] \
//     [--window-pre 20000] [--window-post 5000] \
//     [--out report.md]

import { resolve as resolvePath, basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

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
  console.error("usage: trace-store-drive-cycle-diff.mjs --vice <duckdb> --headless <duckdb>");
  process.exit(2);
}
const txOccurrence = Number(args["tx-occurrence"] ?? 3);
const windowPre = BigInt(args["window-pre"] ?? 20000);
const windowPost = BigInt(args["window-post"] ?? 5000);
const startAnchor = typeof args["start-anchor"] === "string" ? args["start-anchor"] : null;
const streamLimit = Number(args["stream-limit"] ?? 4000);
const cpuArg = (typeof args.cpu === "string" ? args.cpu : "drive8");
if (cpuArg !== "drive8" && cpuArg !== "c64") {
  console.error(`--cpu must be 'drive8' or 'c64' (got '${cpuArg}')`);
  process.exit(2);
}
const outPath = args.out
  ? resolvePath(args.out)
  : (() => {
      const dir = join(dirname(hlDb), "..", "..", "..", "analysis", "runtime", `motm-tx${txOccurrence}-bit-diff-${new Date().toISOString().slice(0, 10)}`);
      mkdirSync(dir, { recursive: true });
      return join(dir, `motm-tx${txOccurrence}-drive-cycle-diff.md`);
    })();

console.log(`trace-store-drive-cycle-diff (Spec 218 H1)`);
console.log(`  vice          : ${viceDb}`);
console.log(`  headless      : ${hlDb}`);
console.log(`  tx-occurrence : ${txOccurrence}`);
console.log(`  window        : tx_clock-${windowPre} .. tx_clock+${windowPost}`);
console.log(`  out           : ${outPath}`);

const duck = await import("@duckdb/node-api");
const inst = await duck.DuckDBInstance.create(":memory:");
const conn = await inst.connect();
await conn.run(`ATTACH '${viceDb}' AS vice (READ_ONLY)`);
await conn.run(`ATTACH '${hlDb}' AS hl (READ_ONLY)`);

async function rows(sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRows();
}
function asBig(v) { return v === null || v === undefined ? null : (typeof v === "bigint" ? v : BigInt(v)); }
function fmtHex(n, w = 4) {
  if (n === null || n === undefined) return "-";
  const v = typeof n === "bigint" ? Number(n) : n;
  return "$" + v.toString(16).padStart(w, "0");
}

// Resolve TX#N master_clock per side.
async function nthAnchorMC(catalog, name, n) {
  const r = await rows(`
    SELECT i.master_clock FROM ${catalog}.anchors a
    JOIN ${catalog}.instructions i ON i.run_id=a.run_id AND i.cpu=a.cpu AND i.seq=a.seq
    WHERE a.name='${name}' AND a.occurrence=${n}
    ORDER BY a.occurrence LIMIT 1
  `);
  return asBig(r[0]?.[0]);
}
const viceTx = await nthAnchorMC("vice", "bitbang_tx_24bit", txOccurrence);
const hlTx = await nthAnchorMC("hl", "bitbang_tx_24bit", txOccurrence);
if (viceTx === null || hlTx === null) {
  console.error(`bitbang_tx_24bit#${txOccurrence} missing in one side`);
  process.exit(2);
}
const viceFrom = viceTx - windowPre;
const viceTo = viceTx + windowPost;
const hlFrom = hlTx - windowPre;
const hlTo = hlTx + windowPost;

const lines = [];
lines.push(`# motm TX${txOccurrence} drive cycle-accounting diff (H1)`);
lines.push(``);
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(``);
lines.push(`- VICE TX${txOccurrence}.master_clock: ${viceTx}`);
lines.push(`- HL   TX${txOccurrence}.master_clock: ${hlTx}`);
lines.push(`- Window pre/post: ${windowPre} / ${windowPost} cycles`);
lines.push(``);

// ----- §1 per-opcode duration aggregate -----
async function opcodeDurations(catalog, from, to) {
  const sql = `
    WITH q AS (
      SELECT
        opcode,
        master_clock,
        LEAD(master_clock) OVER (ORDER BY seq) AS next_mc
      FROM ${catalog}.instructions
      WHERE cpu='${cpuArg}' AND master_clock BETWEEN ${from} AND ${to}
    )
    SELECT
      opcode,
      COUNT(*) AS n,
      AVG(CAST(next_mc - master_clock AS DOUBLE)) AS avg_dur,
      MIN(CAST(next_mc - master_clock AS BIGINT)) AS min_dur,
      MAX(CAST(next_mc - master_clock AS BIGINT)) AS max_dur
    FROM q WHERE next_mc IS NOT NULL
    GROUP BY opcode
  `;
  return rows(sql);
}
const viceDur = await opcodeDurations("vice", viceFrom, viceTo);
const hlDur = await opcodeDurations("hl", hlFrom, hlTo);
const vMap = new Map(viceDur.map(r => [Number(r[0]), { n: Number(r[1]), avg: Number(r[2]), min: Number(r[3]), max: Number(r[4]) }]));
const hMap = new Map(hlDur.map(r => [Number(r[0]), { n: Number(r[1]), avg: Number(r[2]), min: Number(r[3]), max: Number(r[4]) }]));
const allOps = new Set([...vMap.keys(), ...hMap.keys()]);

lines.push(`## 1. Per-opcode average duration (master_clock cycles)`);
lines.push(``);
lines.push(`Window includes everything from \`TX${txOccurrence} - ${windowPre}\` to \`TX${txOccurrence} + ${windowPost}\`. Drive runs at 1MHz; durations expressed in master_clock (PAL c64 cycles ≈ 0.985 × drive cycles).`);
lines.push(``);
lines.push(`| opcode | vice_n | vice_avg | vice_min | vice_max | hl_n | hl_avg | hl_min | hl_max | Δavg | flag |`);
lines.push(`|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:--|`);
const opSorted = [...allOps].sort((a, b) => {
  const v = vMap.get(a)?.n ?? 0;
  const h = hMap.get(a)?.n ?? 0;
  return (h + v) > ((vMap.get(b)?.n ?? 0) + (hMap.get(b)?.n ?? 0)) ? -1 : 1;
});
for (const op of opSorted.slice(0, 30)) {
  const v = vMap.get(op);
  const h = hMap.get(op);
  if (!v || !h) continue;
  const dAvg = h.avg - v.avg;
  const flag = Math.abs(dAvg) > 0.05 ? "**Δ**" : "";
  lines.push(`| ${fmtHex(op, 2)} | ${v.n} | ${v.avg.toFixed(2)} | ${v.min} | ${v.max} | ${h.n} | ${h.avg.toFixed(2)} | ${h.min} | ${h.max} | ${dAvg >= 0 ? "+" : ""}${dAvg.toFixed(2)} | ${flag} |`);
}
lines.push(``);

// ----- §2 first-divergence walk -----
//
// Pull the drive instruction streams from each side starting at TX#N
// and walking forward by seq order. Find the earliest pair where
// either (a) PC differs between sides, or (b) cumulative master_clock
// drift between sides exceeds N cycles.
async function driveStream(catalog, fromMc, limit) {
  const sql = `
    SELECT seq, master_clock, pc, opcode, b1, b2, a, x, y, sp, p
    FROM ${catalog}.instructions
    WHERE cpu='${cpuArg}' AND master_clock >= ${fromMc}
    ORDER BY seq ASC
    LIMIT ${limit}
  `;
  return rows(sql);
}
// Start anchor for stream walk. Defaults to TX#N entry; --start-anchor
// overrides (e.g. ab_entry to walk from C64 fastloader entry).
let viceWalkStart = viceTx;
let hlWalkStart = hlTx;
let walkStartLabel = `TX${txOccurrence}`;
if (startAnchor) {
  const v = await nthAnchorMC("vice", startAnchor, 1);
  const h = await nthAnchorMC("hl", startAnchor, 1);
  if (v === null || h === null) {
    console.error(`start-anchor '${startAnchor}' not found in both stores`);
    process.exit(2);
  }
  viceWalkStart = v;
  hlWalkStart = h;
  walkStartLabel = startAnchor;
}
const vStream = await driveStream("vice", viceWalkStart, streamLimit);
const hStream = await driveStream("hl",   hlWalkStart,   streamLimit);

lines.push(`## 2. Drive instruction stream walk from ${walkStartLabel}`);
lines.push(``);
lines.push(`First ${streamLimit} drive instructions per side starting at ${walkStartLabel}.master_clock. Walked in lock-step by index. \`Δrel\` = (hl_mc - hl_start) - (vice_mc - vice_start) — drift relative to walk start.`);
lines.push(``);
lines.push(`| i | vice_pc | hl_pc | vice_op | hl_op | Δrel | status |`);
lines.push(`|---:|---|---|---|---|---:|---|`);

const limit = Math.min(vStream.length, hStream.length);
let firstPcDiff = -1;
let firstDriftBeyondTol = -1;
const driftTol = 4n;

for (let i = 0; i < limit; i++) {
  const vRow = vStream[i];
  const hRow = hStream[i];
  const vPc = Number(vRow[2]);
  const hPc = Number(hRow[2]);
  const vOp = Number(vRow[3]);
  const hOp = Number(hRow[3]);
  const vRel = asBig(vRow[1]) - viceWalkStart;
  const hRel = asBig(hRow[1]) - hlWalkStart;
  const dRel = hRel - vRel;
  const absD = dRel < 0n ? -dRel : dRel;
  const status =
    vPc !== hPc ? "PC-DIVERGE" :
    absD > driftTol ? `DRIFT ${dRel}` :
    "match";
  if (vPc !== hPc && firstPcDiff < 0) firstPcDiff = i;
  if (absD > driftTol && firstDriftBeyondTol < 0) firstDriftBeyondTol = i;
  // Print early rows + a window around first divergence + trailing context.
  const inEarly = i < 12;
  const inDivWindow = firstPcDiff >= 0 ? Math.abs(i - firstPcDiff) < 8 : false;
  const inDriftWindow = firstDriftBeyondTol >= 0 && firstPcDiff < 0 ? Math.abs(i - firstDriftBeyondTol) < 8 : false;
  if (inEarly || inDivWindow || inDriftWindow) {
    lines.push(`| ${i} | ${fmtHex(vPc)} | ${fmtHex(hPc)} | ${fmtHex(vOp, 2)} | ${fmtHex(hOp, 2)} | ${dRel >= 0n ? "+" : ""}${dRel} | ${status} |`);
  }
}
lines.push(``);
if (firstPcDiff >= 0) {
  const v = vStream[firstPcDiff];
  const h = hStream[firstPcDiff];
  const drift = (asBig(h[1]) - hlWalkStart) - (asBig(v[1]) - viceWalkStart);
  lines.push(`### First PC divergence`);
  lines.push(``);
  lines.push(`- index in stream: ${firstPcDiff}`);
  lines.push(`- VICE: pc=${fmtHex(Number(v[2]))} op=${fmtHex(Number(v[3]), 2)} mc=${asBig(v[1])} (rel ${asBig(v[1]) - viceWalkStart})`);
  lines.push(`- HL  : pc=${fmtHex(Number(h[2]))} op=${fmtHex(Number(h[3]), 2)} mc=${asBig(h[1])} (rel ${asBig(h[1]) - hlWalkStart})`);
  lines.push(`- cumulative drift at this index: ${drift} cycles`);
  if (firstDriftBeyondTol >= 0 && firstDriftBeyondTol < firstPcDiff) {
    const dv = vStream[firstDriftBeyondTol];
    const dh = hStream[firstDriftBeyondTol];
    lines.push(``);
    lines.push(`Cumulative drift first exceeded ±${driftTol} cycles at index ${firstDriftBeyondTol}, before any PC divergence.`);
    lines.push(`At that point both sides were on PC ${fmtHex(Number(dv[2]))} op ${fmtHex(Number(dv[3]), 2)}; the per-instruction cycle gap accumulated to drift the timeline.`);
  }
} else {
  lines.push(`No PC divergence within first ${limit} instructions. Either the divergence sits past the stream window or the drive paths actually agree and the bit-divergence is a C64-side phenomenon.`);
}
lines.push(``);

// ----- §3 per-opcode flagged ops -----
const flagged = [...allOps]
  .map(op => {
    const v = vMap.get(op);
    const h = hMap.get(op);
    if (!v || !h) return null;
    const dAvg = h.avg - v.avg;
    if (Math.abs(dAvg) <= 0.05) return null;
    return { op, v, h, dAvg };
  })
  .filter(Boolean)
  .sort((a, b) => Math.abs(b.dAvg) - Math.abs(a.dAvg));

lines.push(`## 3. Opcodes with non-zero average-duration delta (|Δ|>0.05)`);
lines.push(``);
if (flagged.length === 0) {
  lines.push(`(none — all opcodes execute with the same average master_clock duration on both sides; H1 cycle-accounting bug not visible at this aggregation.)`);
} else {
  lines.push(`These are the prime suspects for H1.`);
  lines.push(``);
  lines.push(`| opcode | vice_n | vice_avg | hl_n | hl_avg | Δavg |`);
  lines.push(`|---:|---:|---:|---:|---:|---:|`);
  for (const f of flagged.slice(0, 20)) {
    lines.push(`| ${fmtHex(f.op, 2)} | ${f.v.n} | ${f.v.avg.toFixed(2)} | ${f.h.n} | ${f.h.avg.toFixed(2)} | ${f.dAvg >= 0 ? "+" : ""}${f.dAvg.toFixed(2)} |`);
  }
}
lines.push(``);

writeFileSync(outPath, lines.join("\n") + "\n");
console.log(``);
console.log(`report -> ${outPath}`);

inst.closeSync();
