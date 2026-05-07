#!/usr/bin/env node
// Spec 218 — bit-swimlane diff for motm post-4096-byte TX#3.
//
// Reads two trace stores (VICE baseline + headless), aligns them to
// ab_entry.master_clock, resolves the post-4096-byte TX window, and
// emits a markdown report with:
//   1. Window resolution (per-side clocks + deltas)
//   2. C64 TX path PC trace within window (vs vice)
//   3. Drive RX path PC trace within window (vs vice)
//   4. First diverging drive PC (does drive enter $0420-$044C wrong path)
//   5. 24-bit bit-swimlane for TX#3 (DD00 writes + drive $1800 reads)
//   6. Hypothesis bucket summary (H1 / H2 / H3 evidence)
//
// Usage:
//   node scripts/trace-store-bit-swimlane.mjs \
//     --vice samples/traces/v2-baseline/motm-vice-store-2026-05-07/trace.duckdb \
//     --headless samples/traces/v2-baseline/motm-s218-headless-store-2026-05-07/trace.duckdb \
//     [--out report.md] \
//     [--tx-occurrence 3] \
//     [--window-pre 20000] \
//     [--window-post 80000]
//
// Window is bounded relative to master_clock (cross-CPU normalised).

import { resolve as resolvePath, basename, dirname, join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

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
  console.error("usage: trace-store-bit-swimlane.mjs --vice <duckdb> --headless <duckdb> [--out report.md]");
  process.exit(2);
}
const txOccurrence = Number(args["tx-occurrence"] ?? 3);
const windowPre = BigInt(args["window-pre"] ?? 20000);
const windowPost = BigInt(args["window-post"] ?? 80000);

const outPath = args.out
  ? resolvePath(args.out)
  : (() => {
      const dir = join(dirname(hlDb), "..", "..", "..", "analysis", "runtime", `motm-tx${txOccurrence}-bit-diff-${new Date().toISOString().slice(0, 10)}`);
      mkdirSync(dir, { recursive: true });
      return join(dir, `motm-tx${txOccurrence}-bit-diff.md`);
    })();

console.log(`trace-store-bit-swimlane (Spec 218)`);
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

// ----- helpers -----
async function rows(sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRows();
}
function asBig(v) {
  if (v === null || v === undefined) return null;
  return typeof v === "bigint" ? v : BigInt(v);
}
function fmtHex(n, w = 4) {
  if (n === null || n === undefined) return "-";
  const v = typeof n === "bigint" ? Number(n) : n;
  return "$" + v.toString(16).padStart(w, "0");
}

// ----- alignment offsets via instructions JOIN -----
async function firstAnchorMC(catalog, name) {
  const r = await rows(`
    SELECT MIN(i.master_clock) FROM ${catalog}.anchors a
    JOIN ${catalog}.instructions i ON i.run_id=a.run_id AND i.cpu=a.cpu AND i.seq=a.seq
    WHERE a.name='${name}'
  `);
  return asBig(r[0]?.[0]);
}
const viceAbEntry = await firstAnchorMC("vice", "ab_entry");
const hlAbEntry = await firstAnchorMC("hl", "ab_entry");
if (viceAbEntry === null || hlAbEntry === null) {
  console.error(`ab_entry not found in both stores (vice=${viceAbEntry}, hl=${hlAbEntry})`);
  process.exit(2);
}

// ----- TX#N anchor master_clock per side -----
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
if (viceTx === null) {
  console.error(`vice has no bitbang_tx_24bit occurrence ${txOccurrence}`);
  process.exit(2);
}
if (hlTx === null) {
  console.error(`headless has no bitbang_tx_24bit occurrence ${txOccurrence}`);
  process.exit(2);
}

const viceWinFrom = viceTx - windowPre;
const viceWinTo = viceTx + windowPost;
const hlWinFrom = hlTx - windowPre;
const hlWinTo = hlTx + windowPost;

// ----- markdown -----
const lines = [];
const ts = new Date().toISOString();
lines.push(`# motm TX${txOccurrence} bit-swimlane diff`);
lines.push(``);
lines.push(`Generated: ${ts}`);
lines.push(``);
lines.push(`- VICE store:     \`${basename(dirname(viceDb))}\``);
lines.push(`- Headless store: \`${basename(dirname(hlDb))}\``);
lines.push(`- TX occurrence:  ${txOccurrence}`);
lines.push(`- Align anchor:   ab_entry`);
lines.push(``);

// ----- §1 Window resolution -----
lines.push(`## 1. Window resolution`);
lines.push(``);
lines.push(`| | VICE | headless | delta |`);
lines.push(`|---|---:|---:|---:|`);
lines.push(`| ab_entry.master_clock (abs) | ${viceAbEntry} | ${hlAbEntry} | ${hlAbEntry - viceAbEntry} |`);
lines.push(`| TX${txOccurrence}.master_clock (abs) | ${viceTx} | ${hlTx} | ${hlTx - viceTx} |`);
lines.push(`| TX${txOccurrence} relative to ab_entry | ${viceTx - viceAbEntry} | ${hlTx - hlAbEntry} | ${(hlTx - hlAbEntry) - (viceTx - viceAbEntry)} |`);
lines.push(``);

// Verify rx_byte counts upstream
const viceRxN = Number((await rows(`SELECT COUNT(*) FROM vice.anchors WHERE name='rx_byte'`))[0][0]);
const hlRxN = Number((await rows(`SELECT COUNT(*) FROM hl.anchors WHERE name='rx_byte'`))[0][0]);
const viceTxN = Number((await rows(`SELECT COUNT(*) FROM vice.anchors WHERE name='bitbang_tx_24bit'`))[0][0]);
const hlTxN = Number((await rows(`SELECT COUNT(*) FROM hl.anchors WHERE name='bitbang_tx_24bit'`))[0][0]);
lines.push(`Loader progress totals (full capture, not window):`);
lines.push(``);
lines.push(`| anchor | VICE | headless |`);
lines.push(`|---|---:|---:|`);
lines.push(`| rx_byte | ${viceRxN} | ${hlRxN} |`);
lines.push(`| bitbang_tx_24bit | ${viceTxN} | ${hlTxN} |`);
lines.push(``);

// ----- §2 C64 TX path PC trace -----
lines.push(`## 2. C64 TX path within window`);
lines.push(``);
lines.push(`PCs of interest: $425C–$42BD (bitbang_tx_24bit), $4294–$42AF (bitbang_tx_inner), $43C7–$43E9 (rx_wait/rx_byte).`);
lines.push(``);

async function pcHistogramC64(catalog, from, to) {
  const sql = `
    SELECT pc, COUNT(*) AS n
    FROM ${catalog}.instructions
    WHERE cpu='c64' AND master_clock BETWEEN ${from} AND ${to}
      AND ((pc BETWEEN 16988 AND 17085) OR (pc BETWEEN 17044 AND 17071) OR (pc BETWEEN 17351 AND 17385))
    GROUP BY pc ORDER BY n DESC LIMIT 20
  `;
  return rows(sql);
}
const vicePcHist = await pcHistogramC64("vice", viceWinFrom, viceWinTo);
const hlPcHist = await pcHistogramC64("hl", hlWinFrom, hlWinTo);

const allPcs = new Set([...vicePcHist.map(r => Number(r[0])), ...hlPcHist.map(r => Number(r[0]))]);
const vMap = new Map(vicePcHist.map(r => [Number(r[0]), Number(r[1])]));
const hMap = new Map(hlPcHist.map(r => [Number(r[0]), Number(r[1])]));

lines.push(`| pc | VICE count | HL count | delta |`);
lines.push(`|---|---:|---:|---:|`);
for (const pc of [...allPcs].sort((a, b) => a - b)) {
  const v = vMap.get(pc) ?? 0;
  const h = hMap.get(pc) ?? 0;
  lines.push(`| ${fmtHex(pc)} | ${v} | ${h} | ${h - v >= 0 ? "+" : ""}${h - v} |`);
}
lines.push(``);

// ----- §3 Drive PC trace -----
lines.push(`## 3. Drive RX path within window`);
lines.push(``);
lines.push(`PCs of interest: $0714–$0732 (drive_rx_active), $07BE–$07C8 (drive_rx_wait), $0420–$044C (suspected wrong handler).`);
lines.push(``);

async function pcHistogramDrive(catalog, from, to) {
  const sql = `
    SELECT pc, COUNT(*) AS n
    FROM ${catalog}.instructions
    WHERE cpu='drive8' AND master_clock BETWEEN ${from} AND ${to}
      AND ((pc BETWEEN 1812 AND 1842) OR (pc BETWEEN 1982 AND 1992) OR (pc BETWEEN 1056 AND 1100))
    GROUP BY pc ORDER BY n DESC LIMIT 30
  `;
  return rows(sql);
}
const viceDrvHist = await pcHistogramDrive("vice", viceWinFrom, viceWinTo);
const hlDrvHist = await pcHistogramDrive("hl", hlWinFrom, hlWinTo);
const allDrvPcs = new Set([...viceDrvHist.map(r => Number(r[0])), ...hlDrvHist.map(r => Number(r[0]))]);
const vDrvMap = new Map(viceDrvHist.map(r => [Number(r[0]), Number(r[1])]));
const hDrvMap = new Map(hlDrvHist.map(r => [Number(r[0]), Number(r[1])]));

lines.push(`| pc | region | VICE | HL | delta |`);
lines.push(`|---|---|---:|---:|---:|`);
for (const pc of [...allDrvPcs].sort((a, b) => a - b)) {
  let region = "?";
  if (pc >= 0x0714 && pc <= 0x0732) region = "rx_active";
  else if (pc >= 0x07BE && pc <= 0x07C8) region = "rx_wait";
  else if (pc >= 0x0420 && pc <= 0x044C) region = "WRONG_HANDLER";
  const v = vDrvMap.get(pc) ?? 0;
  const h = hDrvMap.get(pc) ?? 0;
  lines.push(`| ${fmtHex(pc)} | ${region} | ${v} | ${h} | ${h - v >= 0 ? "+" : ""}${h - v} |`);
}
lines.push(``);

const viceWrong = viceDrvHist.filter(r => Number(r[0]) >= 0x0420 && Number(r[0]) <= 0x044C).reduce((s, r) => s + Number(r[1]), 0);
const hlWrong = hlDrvHist.filter(r => Number(r[0]) >= 0x0420 && Number(r[0]) <= 0x044C).reduce((s, r) => s + Number(r[1]), 0);
lines.push(`Wrong-handler ($0420-$044C) hits: VICE=${viceWrong}, headless=${hlWrong}.`);
if (hlWrong > 0 && viceWrong === 0) {
  lines.push(``);
  lines.push(`> **Smoking gun**: headless drive enters \`$0420-$044C\` ${hlWrong} times in the window; VICE never does. The drive is dispatching to the wrong RX handler in this TX, consistent with the post-4096-byte stall.`);
}
lines.push(``);

// ----- §4 Bus events on $DD00 (C64 TX) and $1800 (drive RX line read) -----
lines.push(`## 4. Bus events within window`);
lines.push(``);
async function busCount(catalog, addr, from, to, kind) {
  const r = await rows(`
    SELECT COUNT(*) FROM ${catalog}.bus_events
    WHERE addr=${addr} AND kind='${kind}' AND master_clock BETWEEN ${from} AND ${to}
  `);
  return Number(r[0][0]);
}
const viceDdW = await busCount("vice", 0xDD00, viceWinFrom, viceWinTo, "write");
const hlDdW = await busCount("hl", 0xDD00, hlWinFrom, hlWinTo, "write");
const viceDdR = await busCount("vice", 0xDD00, viceWinFrom, viceWinTo, "read");
const hlDdR = await busCount("hl", 0xDD00, hlWinFrom, hlWinTo, "read");
const vice18W = await busCount("vice", 0x1800, viceWinFrom, viceWinTo, "write");
const hl18W = await busCount("hl", 0x1800, hlWinFrom, hlWinTo, "write");
const vice18R = await busCount("vice", 0x1800, viceWinFrom, viceWinTo, "read");
const hl18R = await busCount("hl", 0x1800, hlWinFrom, hlWinTo, "read");

lines.push(`| addr | kind | VICE | HL | delta |`);
lines.push(`|---|---|---:|---:|---:|`);
lines.push(`| $DD00 | write | ${viceDdW} | ${hlDdW} | ${hlDdW - viceDdW >= 0 ? "+" : ""}${hlDdW - viceDdW} |`);
lines.push(`| $DD00 | read  | ${viceDdR} | ${hlDdR} | ${hlDdR - viceDdR >= 0 ? "+" : ""}${hlDdR - viceDdR} |`);
lines.push(`| $1800 | write | ${vice18W} | ${hl18W} | ${hl18W - vice18W >= 0 ? "+" : ""}${hl18W - vice18W} |`);
lines.push(`| $1800 | read  | ${vice18R} | ${hl18R} | ${hl18R - vice18R >= 0 ? "+" : ""}${hl18R - vice18R} |`);
lines.push(``);

// ----- §5 24-bit swimlane for TX#N -----
lines.push(`## 5. 24-bit swimlane (TX${txOccurrence})`);
lines.push(``);
lines.push(`First 30 \`$DD00\` writes after TX${txOccurrence} entry, side-by-side. Drive \`$1800\` read clocks paired by nearest master_clock within the same window.`);
lines.push(``);

async function ddWritesAfter(catalog, fromMc, n = 30) {
  const sql = `
    SELECT seq, master_clock, value
    FROM ${catalog}.bus_events
    WHERE addr=56576 AND kind='write' AND master_clock >= ${fromMc}
    ORDER BY master_clock ASC
    LIMIT ${n}
  `;
  return rows(sql);
}
const viceDd = await ddWritesAfter("vice", viceTx, 30);
const hlDd = await ddWritesAfter("hl", hlTx, 30);

lines.push(`| idx | vice_dd_clk_rel | vice_dd_val | hl_dd_clk_rel | hl_dd_val | delta_clock | val_match |`);
lines.push(`|---:|---:|---|---:|---|---:|---|`);
const limit = Math.min(viceDd.length, hlDd.length, 30);
let firstValDiff = -1;
let firstClkDivergeBeyondTol = -1;
const tol = 256n;
for (let i = 0; i < limit; i++) {
  const vClkRel = asBig(viceDd[i][1]) - viceTx;
  const hClkRel = asBig(hlDd[i][1]) - hlTx;
  const vVal = Number(viceDd[i][2]);
  const hVal = Number(hlDd[i][2]);
  const valMatch = vVal === hVal;
  const dCk = hClkRel - vClkRel;
  const absD = dCk < 0n ? -dCk : dCk;
  if (!valMatch && firstValDiff < 0) firstValDiff = i;
  if (absD > tol && firstClkDivergeBeyondTol < 0) firstClkDivergeBeyondTol = i;
  lines.push(`| ${i} | ${vClkRel} | ${fmtHex(vVal, 2)} | ${hClkRel} | ${fmtHex(hVal, 2)} | ${dCk >= 0n ? "+" : ""}${dCk} | ${valMatch ? "✓" : "✗"} |`);
}
lines.push(``);

if (firstValDiff >= 0) {
  lines.push(`First **value** divergence at $DD00 write index ${firstValDiff}. The C64 emits a different bit pattern in this TX between the two stores — points to upstream C64-side state divergence, not a drive sample-timing bug. **Hypothesis bucket**: H1 (drive cycle math affecting C64-observed timing) is **less likely**; investigate C64-side $DD00 derivation logic instead.`);
} else if (firstClkDivergeBeyondTol >= 0) {
  lines.push(`No value divergence in the first ${limit} writes; first **timing** divergence beyond ±${tol} cycles at index ${firstClkDivergeBeyondTol}. **Hypothesis bucket**: H1 (drive cycle accounting) or H2 (VIA T1 arithmetic) — drive-side timing fault makes the drive sample at the wrong moment.`);
} else {
  lines.push(`First ${limit} \`$DD00\` writes match in value AND clock within ±${tol}. Look further into the window or at \`$1800\` read timing — H3 (IEC propagation) becomes the strongest candidate.`);
}
lines.push(``);

// ----- §6 Hypothesis bucket summary -----
lines.push(`## 6. Hypothesis bucket evidence`);
lines.push(``);

// H1: drive PC trace divergence (already covered in §3); summarize again here.
lines.push(`### H1 — Drive 6502 cycle accounting`);
lines.push(``);
lines.push(`Cumulative drive-instruction count delta in window: vice_total=${viceDrvHist.reduce((s, r) => s + Number(r[1]), 0)}, hl_total=${hlDrvHist.reduce((s, r) => s + Number(r[1]), 0)}.`);
if (hlWrong > 0 && viceWrong === 0) {
  lines.push(`Drive enters wrong handler $0420-$044C only in headless. Strong suggestion that VIA T1/IFR delivery or a polled flag arrives mistimed and JMP target is wrong. **Investigate first.**`);
}
lines.push(``);

lines.push(`### H2 — VIA1 T1 arithmetic`);
lines.push(``);
async function chipCount(catalog, kind, from, to) {
  const r = await rows(`
    SELECT COUNT(*) FROM ${catalog}.chip_events
    WHERE chip='via1' AND kind='${kind}' AND master_clock BETWEEN ${from} AND ${to}
  `);
  return Number(r[0][0]);
}
const viceIfrSet = await chipCount("vice", "ifr_set", viceWinFrom, viceWinTo);
const hlIfrSet = await chipCount("hl", "ifr_set", hlWinFrom, hlWinTo);
const viceIrqA = await chipCount("vice", "irq_assert", viceWinFrom, viceWinTo);
const hlIrqA = await chipCount("hl", "irq_assert", hlWinFrom, hlWinTo);
lines.push(`| event | VICE | HL | delta |`);
lines.push(`|---|---:|---:|---:|`);
lines.push(`| via1 ifr_set | ${viceIfrSet} | ${hlIfrSet} | ${hlIfrSet - viceIfrSet} |`);
lines.push(`| via1 irq_assert | ${viceIrqA} | ${hlIrqA} | ${hlIrqA - viceIrqA} |`);
lines.push(``);
if (hlIfrSet > viceIfrSet * 1.1 || hlIrqA > viceIrqA * 1.1) {
  lines.push(`> Headless raises VIA1 IRQs more frequently in window. Consistent with prior probe finding (VIA1 IFR collapse + extra T1CH writes). **Stronger H2 evidence.**`);
}
lines.push(``);

lines.push(`### H3 — IEC propagation / poll-loop timing`);
lines.push(``);
lines.push(`DD00 vs 1800 ratio (writes:reads):`);
lines.push(``);
lines.push(`| | VICE | HL |`);
lines.push(`|---|---:|---:|`);
lines.push(`| $DD00 W : $1800 R | ${viceDdW}:${vice18R} | ${hlDdW}:${hl18R} |`);
lines.push(``);

// Footer
lines.push(`---`);
lines.push(``);
lines.push(`Re-run with \`--tx-occurrence N\` to slide the window to a different TX command.`);
lines.push(`Window: tx_clock − ${windowPre} cycles to tx_clock + ${windowPost} cycles (master_clock).`);

writeFileSync(outPath, lines.join("\n") + "\n");
console.log(``);
console.log(`report -> ${outPath}`);

inst.closeSync();
