#!/usr/bin/env node
// Spec 143 complement — VICE vs headless swimlane JSONL diff tool.
//
// Aligns two swimlane captures on a configurable anchor src event, re-bases
// timestamps so both start at 0 from the anchor, then walks both lists in
// pairwise ts order to find the first behavioral divergence.
//
// Usage:
//   node scripts/swimlane-diff-v2.mjs \
//     --vice   traces/swimlane_motm_2026-05-06T10-27-38-861Z/vice.jsonl \
//     --headless traces/swimlane_motm_2026-05-06T10-35-32-151Z/headless.jsonl \
//     [--anchor c64-w-DD00] [--max-rows 200] [--out traces/swimlane_diff_<ts>]
//
// NPM script: trace:motm-swimlane-diff
//
// Row schema (both sides must match):
//   { ts, tdrv, src, addr, value,
//     c64:  { pc, a, x, y, sp, p },
//     vic:  { raster, ctrl1, irq, imr },
//     cia1: { pra, prb, icr, imr, ta, tb, cra, crb },
//     cia2: { pra, prb, icr, imr, ta, tb, cra, crb },
//     iec:  { atn, clk, data, srq },
//     drv:  { pc, a, x, y, sp, p },
//     via1: { pra, prb, ifr, ier, pcr, acr },
//     via2: { pra, prb, ifr, ier } }
//
// Diff strategy (per spec):
//   1. src + addr  — what bus event happened
//   2. value       — byte on bus
//   3. Per-chip state: c64, vic, cia1, cia2, iec, drv, via1, via2
//
// Outputs:
//   report.md        human-readable diff report
//   report.json      machine-readable, classification: aligned | count-mismatch |
//                      event-divergent | state-divergent
//   aligned.jsonl    paired rows {vice, headless, deltaFields}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) { out[key] = true; }
      else { out[key] = v; i++; }
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = parseArgs(process.argv.slice(2));

const vicePath      = args.vice;
const headlessPath  = args.headless;
const anchorSrc     = args.anchor ?? "c64-w-DD00";
const maxRows       = Number(args["max-rows"] ?? 200);

// Output directory
const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.out
  ? resolve(repoRoot, args.out)
  : resolve(repoRoot, "traces", `swimlane_diff_${tsTag}`);

if (!vicePath || !headlessPath) {
  console.error(
    "Usage: node scripts/swimlane-diff-v2.mjs\n" +
    "  --vice <vice.jsonl> --headless <headless.jsonl>\n" +
    "  [--anchor c64-w-DD00] [--max-rows 200] [--out <dir>]"
  );
  process.exit(2);
}

for (const p of [vicePath, headlessPath]) {
  if (!existsSync(resolve(repoRoot, p))) {
    console.error(`File not found: ${p}`);
    process.exit(2);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load
// ─────────────────────────────────────────────────────────────────────────────

function loadJsonl(path) {
  const lines = readFileSync(resolve(repoRoot, path), "utf-8")
    .split("\n")
    .filter(Boolean);
  return lines.map((l, idx) => {
    try { return JSON.parse(l); }
    catch { console.error(`Parse error on line ${idx + 1} of ${path}`); return null; }
  }).filter(Boolean);
}

const viceRows      = loadJsonl(vicePath).slice(0, maxRows);
const headlessRows  = loadJsonl(headlessPath).slice(0, maxRows);

console.error(`Loaded: vice=${viceRows.length} rows  headless=${headlessRows.length} rows`);
console.error(`Anchor src: ${anchorSrc}`);

// ─────────────────────────────────────────────────────────────────────────────
// Anchor alignment
//
// Find first row in each file where src === anchorSrc.
// Re-base ts: all subsequent ts values subtract anchor.ts so both start at 0.
// ─────────────────────────────────────────────────────────────────────────────

function findAnchor(rows, src) {
  const idx = rows.findIndex(r => r.src === src);
  return idx;
}

const viceAnchorIdx     = findAnchor(viceRows, anchorSrc);
const headlessAnchorIdx = findAnchor(headlessRows, anchorSrc);

if (viceAnchorIdx < 0) {
  console.error(`ERROR: No "${anchorSrc}" event found in VICE file. Available src values: ${[...new Set(viceRows.map(r => r.src))].join(", ")}`);
  console.error(`Try a different --anchor. Cannot align.`);
  process.exit(3);
}
if (headlessAnchorIdx < 0) {
  console.error(`ERROR: No "${anchorSrc}" event found in headless file. Available src values: ${[...new Set(headlessRows.map(r => r.src))].join(", ")}`);
  console.error(`Try a different --anchor. Cannot align.`);
  process.exit(3);
}

// Slice to anchor point onward
const viceAligned     = viceRows.slice(viceAnchorIdx);
const headlessAligned = headlessRows.slice(headlessAnchorIdx);

const viceAnchorTs     = viceAligned[0].ts;
const headlessAnchorTs = headlessAligned[0].ts;

// Re-base ts for display (do not mutate originals; carry delta)
function rebase(rows, anchorTs) {
  return rows.map(r => ({ ...r, ts: r.ts - anchorTs, _origTs: r.ts }));
}

const viceRebased     = rebase(viceAligned, viceAnchorTs);
const headlessRebased = rebase(headlessAligned, headlessAnchorTs);

console.error(`Anchor: vice row ${viceAnchorIdx} (ts=${viceAnchorTs})  headless row ${headlessAnchorIdx} (ts=${headlessAnchorTs})`);
console.error(`Post-anchor: vice=${viceRebased.length} rows  headless=${headlessRebased.length} rows`);

// ─────────────────────────────────────────────────────────────────────────────
// Diff helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Compare all scalar fields in two objects, return list of {field, vice, headless}. */
function diffObject(chip, v, h) {
  if (!v || !h) return [];
  const deltas = [];
  const keys = new Set([...Object.keys(v), ...Object.keys(h)]);
  for (const k of keys) {
    if (v[k] !== h[k]) {
      deltas.push({ field: `${chip}.${k}`, vice: v[k], headless: h[k] });
    }
  }
  return deltas;
}

/** Full field-level diff between one VICE row and one headless row. */
function diffRows(v, h) {
  const deltas = [];

  // 1. src + addr
  if (v.src !== h.src)   deltas.push({ field: "src",   vice: v.src,   headless: h.src });
  if (v.addr !== h.addr) deltas.push({ field: "addr",  vice: v.addr,  headless: h.addr });
  // 2. value
  if (v.value !== h.value) deltas.push({ field: "value", vice: v.value, headless: h.value });
  // 3. Per-chip state
  deltas.push(...diffObject("c64",  v.c64,  h.c64));
  deltas.push(...diffObject("vic",  v.vic,  h.vic));
  deltas.push(...diffObject("cia1", v.cia1, h.cia1));
  deltas.push(...diffObject("cia2", v.cia2, h.cia2));
  deltas.push(...diffObject("iec",  v.iec,  h.iec));
  deltas.push(...diffObject("drv",  v.drv,  h.drv));
  deltas.push(...diffObject("via1", v.via1, h.via1));
  deltas.push(...diffObject("via2", v.via2, h.via2));

  return deltas;
}

/** Classify the divergence type from the first diverging delta list. */
function classifyDivergence(deltas, srcMatch) {
  if (!srcMatch) return "event-divergent";
  // If only chip-state fields differ (src+addr+value match), it's state-divergent
  const nonState = deltas.filter(d => ["src","addr","value"].includes(d.field));
  if (nonState.length === 0) return "state-divergent";
  return "event-divergent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk pairwise
// ─────────────────────────────────────────────────────────────────────────────

const N = Math.min(viceRebased.length, headlessRebased.length);
let firstDivIdx = -1;
let firstDivDeltas = [];
const alignedPairs = [];

for (let i = 0; i < N; i++) {
  const v = viceRebased[i];
  const h = headlessRebased[i];
  const deltas = diffRows(v, h);

  const srcMatch = v.src === h.src && v.addr === h.addr;
  alignedPairs.push({
    idx: i,
    vice: { src: v.src, ts: v.ts, addr: v.addr, value: v.value },
    headless: { src: h.src, ts: h.ts, addr: h.addr, value: h.value },
    deltaFields: deltas,
  });

  if (deltas.length > 0 && firstDivIdx < 0) {
    firstDivIdx = i;
    firstDivDeltas = deltas;
  }
}

// Count mismatch check
const countMismatch = viceRebased.length !== headlessRebased.length;

// Classification
let classification;
if (firstDivIdx < 0 && !countMismatch) {
  classification = "aligned";
} else if (countMismatch && firstDivIdx < 0) {
  classification = "count-mismatch";
} else if (firstDivIdx >= 0) {
  const v = viceRebased[firstDivIdx];
  const h = headlessRebased[firstDivIdx];
  classification = classifyDivergence(firstDivDeltas, v.src === h.src && v.addr === h.addr);
}

console.error(`Classification: ${classification}`);
if (firstDivIdx >= 0) {
  console.error(`First divergence at pairwise index ${firstDivIdx}`);
  for (const d of firstDivDeltas.slice(0, 5)) {
    console.error(`  ${d.field}: vice=${fmtVal(d.vice)}  headless=${fmtVal(d.headless)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtHex(v, w = 2) {
  if (typeof v !== "number") return String(v);
  return `$${v.toString(16).toUpperCase().padStart(w, "0")}`;
}

function fmtVal(v) {
  if (typeof v === "number") return fmtHex(v);
  return String(v);
}

/** Compact one-line representation of a swimlane row for context window. */
function compactRow(r, label) {
  if (!r) return `[${label}] (none)`;
  const c = r.c64 ?? {};
  const d = r.drv ?? {};
  const iec = r.iec ?? {};
  return (
    `[${label}] ts+${r.ts} src=${r.src} val=${fmtHex(r.value)} ` +
    `c64.pc=${fmtHex(r.c64?.pc ?? 0, 4)} ` +
    `drv.pc=${fmtHex(r.drv?.pc ?? 0, 4)} ` +
    `iec.atn=${iec.atn} clk=${iec.clk} data=${iec.data} ` +
    `cia2.pra=${fmtHex(r.cia2?.pra ?? 0)} via1.prb=${fmtHex(r.via1?.prb ?? 0)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Build reports
// ─────────────────────────────────────────────────────────────────────────────

function buildJsonReport() {
  const report = {
    tool: "swimlane-diff-v2",
    generated: new Date().toISOString(),
    inputs: {
      vice: resolve(repoRoot, vicePath),
      headless: resolve(repoRoot, headlessPath),
    },
    metadata: {
      viceRowCount: viceRows.length,
      headlessRowCount: headlessRows.length,
      viceTsRange: viceRows.length ? [viceRows[0].ts, viceRows[viceRows.length-1].ts] : null,
      headlessTsRange: headlessRows.length ? [headlessRows[0].ts, headlessRows[headlessRows.length-1].ts] : null,
    },
    anchor: {
      src: anchorSrc,
      viceRowIndex: viceAnchorIdx,
      headlessRowIndex: headlessAnchorIdx,
      viceAbsoluteTs: viceAnchorTs,
      headlessAbsoluteTs: headlessAnchorTs,
    },
    postAnchor: {
      viceRows: viceRebased.length,
      headlessRows: headlessRebased.length,
      pairsCompared: N,
    },
    classification,
    countMismatch: {
      detected: countMismatch,
      vicePostAnchorRows: viceRebased.length,
      headlessPostAnchorRows: headlessRebased.length,
    },
    firstDivergence: firstDivIdx < 0 ? null : {
      pairIndex: firstDivIdx,
      viceFileRowIndex: viceAnchorIdx + firstDivIdx,
      headlessFileRowIndex: headlessAnchorIdx + firstDivIdx,
      vice: viceRebased[firstDivIdx],
      headless: headlessRebased[firstDivIdx],
      deltaFields: firstDivDeltas,
    },
  };
  return report;
}

function buildMarkdownReport() {
  const lines = [];
  const vr = viceRows;
  const hr = headlessRows;

  lines.push(`# Swimlane Diff Report`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(``);

  // ── Input metadata ────────────────────────────────────────────────────────
  lines.push(`## Input Files`);
  lines.push(``);
  lines.push(`| | VICE | Headless |`);
  lines.push(`|---|---|---|`);
  lines.push(`| File | \`${basename(vicePath)}\` | \`${basename(headlessPath)}\` |`);
  lines.push(`| Path | \`${resolve(repoRoot, vicePath)}\` | \`${resolve(repoRoot, headlessPath)}\` |`);
  lines.push(`| Row count | ${vr.length} | ${hr.length} |`);
  lines.push(`| ts range | ${vr[0]?.ts ?? "?"} – ${vr[vr.length-1]?.ts ?? "?"} | ${hr[0]?.ts ?? "?"} – ${hr[hr.length-1]?.ts ?? "?"} |`);
  const vSrcs = [...new Set(vr.map(r => r.src))].sort().join(", ");
  const hSrcs = [...new Set(hr.map(r => r.src))].sort().join(", ");
  lines.push(`| src types | ${vSrcs} | ${hSrcs} |`);
  lines.push(``);

  // ── Anchor ────────────────────────────────────────────────────────────────
  lines.push(`## Anchor Point`);
  lines.push(``);
  lines.push(`Anchor src: \`${anchorSrc}\``);
  lines.push(``);
  lines.push(`| | VICE | Headless |`);
  lines.push(`|---|---|---|`);
  lines.push(`| File row index | ${viceAnchorIdx} | ${headlessAnchorIdx} |`);
  lines.push(`| Absolute ts | ${viceAnchorTs} c64 cycles | ${headlessAnchorTs} c64 cycles |`);
  lines.push(`| Post-anchor rows | ${viceRebased.length} | ${headlessRebased.length} |`);
  lines.push(`| Pairs compared | ${N} | |`);
  lines.push(``);

  // ── Classification ────────────────────────────────────────────────────────
  lines.push(`## Classification: \`${classification}\``);
  lines.push(``);
  if (classification === "aligned") {
    lines.push(`Both captures agree on all ${N} aligned pairs. No divergence detected.`);
    lines.push(``);
    if (countMismatch) {
      lines.push(`Note: row counts differ (vice=${viceRebased.length}, headless=${headlessRebased.length}) but all overlapping pairs match.`);
      lines.push(``);
    }
    return lines.join("\n");
  }

  if (countMismatch) {
    lines.push(`Row count mismatch: VICE has ${viceRebased.length} post-anchor rows, headless has ${headlessRebased.length}.`);
    lines.push(``);
  }

  // ── First divergence ──────────────────────────────────────────────────────
  if (firstDivIdx >= 0) {
    const v = viceRebased[firstDivIdx];
    const h = headlessRebased[firstDivIdx];

    lines.push(`## First Divergence`);
    lines.push(``);
    lines.push(`Pairwise index: **${firstDivIdx}** (${firstDivIdx} rows matched after anchor)`);
    lines.push(``);
    lines.push(`| Field | VICE | Headless |`);
    lines.push(`|---|---|---|`);
    lines.push(`| ts (rebased) | +${v.ts} | +${h.ts} |`);
    lines.push(`| src | \`${v.src}\` | \`${h.src}\` |`);
    lines.push(`| addr | ${fmtHex(v.addr, 4)} | ${fmtHex(h.addr, 4)} |`);
    lines.push(`| value | ${fmtHex(v.value)} | ${fmtHex(h.value)} |`);
    lines.push(``);

    // Per-field delta table
    if (firstDivDeltas.length > 0) {
      lines.push(`### Diverging Fields`);
      lines.push(``);
      lines.push(`| Field | VICE | Headless | Delta |`);
      lines.push(`|---|---|---|---|`);
      for (const d of firstDivDeltas) {
        const delta = (typeof d.vice === "number" && typeof d.headless === "number")
          ? (d.headless - d.vice)
          : "—";
        lines.push(`| \`${d.field}\` | ${fmtVal(d.vice)} | ${fmtVal(d.headless)} | ${typeof delta === "number" ? (delta >= 0 ? `+${delta}` : delta) : delta} |`);
      }
      lines.push(``);

      // One-liner diagnosis
      const firstKey = firstDivDeltas[0];
      lines.push(`**First diverging field:** \`${firstKey.field}\` — VICE=\`${fmtVal(firstKey.vice)}\` ours=\`${fmtVal(firstKey.headless)}\` at ts+${v.ts} \`${v.src}\``);
      lines.push(``);
    }

    // ── Context window (5 before + 5 after) ──────────────────────────────
    lines.push(`## Context Window (5 before + 5 after divergence)`);
    lines.push(``);
    lines.push("```");
    const ctxStart = Math.max(0, firstDivIdx - 5);
    const ctxEnd   = Math.min(N - 1, firstDivIdx + 5);
    for (let i = ctxStart; i <= ctxEnd; i++) {
      const marker = i === firstDivIdx ? ">>>" : "   ";
      lines.push(`${marker} [${i}] ${compactRow(viceRebased[i], "VICE")}`);
      lines.push(`${marker} [${i}] ${compactRow(headlessRebased[i], "HDLS")}`);
      if (i < ctxEnd) lines.push("");
    }
    lines.push("```");
    lines.push(``);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Write outputs
// ─────────────────────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });

// 1. JSON report
const reportJson = buildJsonReport();
const reportJsonPath = resolve(outDir, "report.json");
writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2));

// 2. Markdown report
const reportMd = buildMarkdownReport();
const reportMdPath = resolve(outDir, "report.md");
writeFileSync(reportMdPath, reportMd);

// 3. Aligned JSONL
const alignedJsonlPath = resolve(outDir, "aligned.jsonl");
const alignedLines = alignedPairs.map(p => JSON.stringify(p)).join("\n");
writeFileSync(alignedJsonlPath, alignedLines + "\n");

console.error(``);
console.error(`Output directory: ${outDir}`);
console.error(`  report.json   ${reportJsonPath}`);
console.error(`  report.md     ${reportMdPath}`);
console.error(`  aligned.jsonl ${alignedJsonlPath}`);
console.error(``);

// Summary to stdout
console.log(`Classification: ${classification}`);
if (firstDivIdx >= 0) {
  const v = viceRebased[firstDivIdx];
  const h = headlessRebased[firstDivIdx];
  console.log(`First divergence at pairwise index ${firstDivIdx} (ts+${v.ts}):`);
  console.log(`  VICE src=${v.src} val=${fmtHex(v.value)}`);
  console.log(`  HDLS src=${h.src} val=${fmtHex(h.value)}`);
  for (const d of firstDivDeltas.slice(0, 8)) {
    console.log(`  ${d.field}: VICE=${fmtVal(d.vice)} HDLS=${fmtVal(d.headless)}`);
  }
} else {
  console.log(`No divergence in ${N} aligned pairs.`);
}
