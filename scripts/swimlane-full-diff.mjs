#!/usr/bin/env node
// Spec 152 — Pairwise per-instruction diff between VICE and headless full-trace JSONL captures.
//
// Anchors both streams at the first row where side=="c64" && pc == anchorC64Pc
// (default $4000 = AB.prg entry).  Then walks forward pairwise, comparing
// hard fields on every instruction boundary.  Stops at first divergence.
//
// VICE deviations tolerated (documented in vice-full-trace.mjs):
//   - `bus` always [] on VICE side  → skipped
//   - `_approx` present on drive rows → skipped
//   - CIA IMR registers not reliable on VICE (imr==icr artifact) → skip *.imr
//
// Hard fields (must match, trip first-divergence):
//   side, pc, a, x, y, sp, p (with B-flag mask 0xEF), op
//
// Soft fields (warn but don't trip):
//   cia.icr, vic.raster, via.t1c, via.t2c — ±1 cycle precision tolerance
//
// --strict makes ALL fields hard (no soft warnings).
//
// Usage:
//   node scripts/swimlane-full-diff.mjs \
//     --vice <vice-full.jsonl> \
//     --headless <headless-full.jsonl> \
//     [--anchor-c64-pc 4000] \
//     [--max-rows 100000] \
//     [--strict] \
//     [--out traces/swimlane_full_diff_<ts>/]
//
// NPM script: trace:motm-full-diff

import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

// ─────────────────────────────────────────────────────────────────────────────
// CLI
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

const vicePath     = args.vice;
const headlessPath = args.headless;
const anchorPcHex  = args["anchor-c64-pc"] ?? "4000";
const anchorPc     = parseInt(anchorPcHex, 16);
const maxRows      = Number(args["max-rows"] ?? 100000);
const strict       = Boolean(args.strict);
const ts           = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -1);
const outDir       = args.out ?? resolve(repoRoot, `traces/swimlane_full_diff_${ts}`);

if (!vicePath || !headlessPath) {
  console.error("Usage: node scripts/swimlane-full-diff.mjs --vice <path> --headless <path> [options]");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL loader
// ─────────────────────────────────────────────────────────────────────────────

async function loadJsonl(filePath) {
  const rows = [];
  const rl = createInterface({ input: createReadStream(resolve(repoRoot, filePath)), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed));
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchor search
// ─────────────────────────────────────────────────────────────────────────────

function findAnchor(rows, anchorPc) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.side === "c64" && r.pc === anchorPc) return i;
  }
  return -1;
}

/** Return top-N PC distribution for c64 side rows. */
function pcDistribution(rows, topN = 15) {
  const counts = new Map();
  for (const r of rows) {
    if (r.side !== "c64") continue;
    counts.set(r.pc, (counts.get(r.pc) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([pc, cnt]) => `  $${pc.toString(16).toUpperCase().padStart(4, "0")} (${pc}): ${cnt}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Field comparison
// ─────────────────────────────────────────────────────────────────────────────

// B-flag is bit 4 of P — mask it out for comparison (VICE vs headless may differ).
const P_MASK = 0xEF;

/**
 * Hard fields: must match, trip divergence.
 * Returns array of {field, vice, headless} for mismatches.
 */
function diffHard(v, h) {
  const deltas = [];

  const fields = ["side", "op"];
  for (const f of fields) {
    if (v[f] !== h[f]) deltas.push({ field: f, vice: v[f], headless: h[f] });
  }

  // PC
  if (v.pc !== h.pc) deltas.push({ field: "pc", vice: `$${v.pc.toString(16).toUpperCase().padStart(4,"0")}`, headless: `$${h.pc.toString(16).toUpperCase().padStart(4,"0")}` });

  // Registers (with B-flag mask on p)
  for (const reg of ["a", "x", "y", "sp"]) {
    if (v[reg] !== h[reg]) deltas.push({ field: reg, vice: v[reg], headless: h[reg] });
  }
  if ((v.p & P_MASK) !== (h.p & P_MASK)) {
    deltas.push({ field: "p", vice: `0x${(v.p & P_MASK).toString(16).padStart(2,"0")} (raw:0x${v.p.toString(16)})`, headless: `0x${(h.p & P_MASK).toString(16).padStart(2,"0")} (raw:0x${h.p.toString(16)})` });
  }

  return deltas;
}

/**
 * Soft fields: warn but don't trip divergence in non-strict mode.
 * Returns array of {field, vice, headless} for mismatches.
 */
function diffSoft(v, h) {
  const deltas = [];

  // CIA ICR (side-effecting reads on VICE — just warn)
  for (const cia of ["cia1", "cia2"]) {
    if (v[cia]?.icr !== h[cia]?.icr) {
      deltas.push({ field: `${cia}.icr`, vice: v[cia]?.icr, headless: h[cia]?.icr });
    }
  }

  // VIC raster — ±1 cycle tolerance
  if (v.vic?.raster !== undefined && h.vic?.raster !== undefined) {
    if (Math.abs(v.vic.raster - h.vic.raster) > 1) {
      deltas.push({ field: "vic.raster", vice: v.vic.raster, headless: h.vic.raster });
    }
  }

  // VIA timer counts — ±2 cycles tolerance
  for (const via of ["via1", "via2"]) {
    for (const timer of ["t1c", "t2c"]) {
      const vv = v[via]?.[timer];
      const hv = h[via]?.[timer];
      if (vv !== undefined && hv !== undefined && Math.abs(vv - hv) > 2) {
        deltas.push({ field: `${via}.${timer}`, vice: vv, headless: hv });
      }
    }
  }

  return deltas;
}

/**
 * Classify the divergence based on which hard fields differ.
 */
function classifyDivergence(hardDeltas) {
  const fields = hardDeltas.map(d => d.field);
  if (fields.includes("side")) return "side-divergent";
  if (fields.includes("pc")) return "pc-divergent";
  if (fields.includes("op")) return "op-divergent";
  return "state-divergent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Output formatters
// ─────────────────────────────────────────────────────────────────────────────

function fmtRow(r, label, idx) {
  if (!r) return `  ${label}: (no row)`;
  const pc = `$${r.pc.toString(16).toUpperCase().padStart(4,"0")}`;
  const op = `$${(r.op ?? 0).toString(16).toUpperCase().padStart(2,"0")}`;
  return `  [${idx}] ${label} ts=${r.ts} side=${r.side} pc=${pc} op=${op} A=${r.a} X=${r.x} Y=${r.y} SP=${r.sp} P=${r.p}`;
}

function contextBlock(viceRows, headlessRows, viceAnchor, headlessAnchor, divergeIdx, window = 5) {
  const lines = [];
  const start = Math.max(0, divergeIdx - window);
  const end   = Math.min(Math.min(viceRows.length, headlessRows.length) - 1, divergeIdx + window);

  for (let i = start; i <= end; i++) {
    const marker = i === divergeIdx ? ">>>" : "   ";
    lines.push(`${marker} row ${i} (vice file line ${viceAnchor + i + 1}, headless file line ${headlessAnchor + i + 1})`);
    lines.push(fmtRow(viceRows[i], "VICE    ", i));
    lines.push(fmtRow(headlessRows[i], "HEADLESS", i));
    lines.push("");
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Loading VICE trace:     ${vicePath}`);
  console.log(`Loading headless trace: ${headlessPath}`);

  let viceAll, headlessAll;
  try {
    viceAll     = await loadJsonl(vicePath);
    headlessAll = await loadJsonl(headlessPath);
  } catch (err) {
    console.error(`Failed to load trace files: ${err.message}`);
    process.exit(1);
  }

  console.log(`VICE rows: ${viceAll.length}  Headless rows: ${headlessAll.length}`);

  // ── Find anchor ──────────────────────────────────────────────────────────

  const viceAnchorIdx     = findAnchor(viceAll, anchorPc);
  const headlessAnchorIdx = findAnchor(headlessAll, anchorPc);

  const viceAnchorFound     = viceAnchorIdx >= 0;
  const headlessAnchorFound = headlessAnchorIdx >= 0;

  if (!viceAnchorFound || !headlessAnchorFound) {
    const missing = [];
    if (!viceAnchorFound) missing.push("VICE");
    if (!headlessAnchorFound) missing.push("headless");

    console.error(`\nERROR: Anchor c64.pc=$${anchorPc.toString(16).toUpperCase().padStart(4,"0")} not found in: ${missing.join(", ")}`);
    console.error("\nC64 PC distribution (top 15) — use this to pick a reachable anchor:");

    if (!viceAnchorFound) {
      const viceDist = pcDistribution(viceAll);
      const c64Count = viceAll.filter(r => r.side === "c64").length;
      console.error(`\n  VICE (${viceAll.length} total rows, ${c64Count} c64-side):`);
      for (const line of viceDist) console.error(line);
    }

    if (!headlessAnchorFound) {
      const headlessDist = pcDistribution(headlessAll);
      const c64Count = headlessAll.filter(r => r.side === "c64").length;
      console.error(`\n  Headless (${headlessAll.length} total rows, ${c64Count} c64-side):`);
      for (const line of headlessDist) console.error(line);
    }

    console.error(`\nHint: If traces only cover cold boot, extend --end-cycle / increase --max-rows in vice-full-trace.mjs and headless-full-trace.mjs.`);
    process.exit(2);
  }

  console.log(`Anchor found: VICE row ${viceAnchorIdx}, headless row ${headlessAnchorIdx}`);

  // ── Slice from anchor ────────────────────────────────────────────────────

  const viceRows     = viceAll.slice(viceAnchorIdx, viceAnchorIdx + maxRows);
  const headlessRows = headlessAll.slice(headlessAnchorIdx, headlessAnchorIdx + maxRows);
  const walkLen      = Math.min(viceRows.length, headlessRows.length);

  console.log(`Walking ${walkLen} rows from anchor (max-rows=${maxRows})...`);

  // ── Pairwise walk ────────────────────────────────────────────────────────

  let firstDivergence = null;
  const softWarnings = [];
  const alignedRows = [];

  for (let i = 0; i < walkLen; i++) {
    const v = viceRows[i];
    const h = headlessRows[i];

    const hardDeltas = diffHard(v, h);
    const softDeltas = strict ? [] : diffSoft(v, h);

    const deltaFields = [
      ...hardDeltas.map(d => ({ ...d, severity: "hard" })),
      ...softDeltas.map(d => ({ ...d, severity: "soft" })),
    ];

    alignedRows.push({ vice: v, headless: h, deltaFields });

    if (softDeltas.length > 0) {
      softWarnings.push({ row: i, deltas: softDeltas });
    }

    if (hardDeltas.length > 0) {
      firstDivergence = {
        rowIndex: i,
        viceFileLineApprox: viceAnchorIdx + i + 1,
        headlessFileLineApprox: headlessAnchorIdx + i + 1,
        classification: classifyDivergence(hardDeltas),
        hardDeltas,
        softDeltas,
        cycleDeltaTs: h.ts - v.ts,
        cycleDeltaTdrv: (h.tdrv ?? 0) - (v.tdrv ?? 0),
        viceRow: v,
        headlessRow: h,
      };
      break;
    }
  }

  // ── Determine final classification ───────────────────────────────────────

  let classification;
  if (!firstDivergence) {
    if (walkLen < maxRows && viceRows.length !== headlessRows.length) {
      classification = "aligned-up-to-max"; // exhausted shorter stream
    } else {
      classification = "aligned-up-to-max";
    }
  } else {
    classification = firstDivergence.classification;
  }

  // ── Build outputs ────────────────────────────────────────────────────────

  mkdirSync(outDir, { recursive: true });

  // ── report.json ──────────────────────────────────────────────────────────

  const reportJson = {
    spec: "152",
    generated: new Date().toISOString(),
    inputs: { vice: vicePath, headless: headlessPath },
    options: { anchorC64Pc: `$${anchorPc.toString(16).toUpperCase().padStart(4,"0")}`, maxRows, strict },
    anchor: {
      viceFileRow: viceAnchorIdx,
      headlessFileRow: headlessAnchorIdx,
    },
    classification,
    divergence_at: firstDivergence ? {
      rowIndex: firstDivergence.rowIndex,
      viceFileLine: firstDivergence.viceFileLineApprox,
      headlessFileLine: firstDivergence.headlessFileLineApprox,
      cycleDeltaTs: firstDivergence.cycleDeltaTs,
      cycleDeltaTdrv: firstDivergence.cycleDeltaTdrv,
    } : null,
    fields: firstDivergence ? {
      hard: firstDivergence.hardDeltas,
      soft: firstDivergence.softDeltas,
    } : { hard: [], soft: [] },
    softWarningsCount: softWarnings.length,
    rowsCompared: firstDivergence ? firstDivergence.rowIndex + 1 : walkLen,
    viceTotal: viceAll.length,
    headlessTotal: headlessAll.length,
    context: firstDivergence ? {
      vice: viceRows.slice(Math.max(0, firstDivergence.rowIndex - 5), firstDivergence.rowIndex + 6),
      headless: headlessRows.slice(Math.max(0, firstDivergence.rowIndex - 5), firstDivergence.rowIndex + 6),
    } : null,
  };

  writeFileSync(resolve(outDir, "report.json"), JSON.stringify(reportJson, null, 2));

  // ── aligned.jsonl ─────────────────────────────────────────────────────────

  const alignedLines = alignedRows.map(r => JSON.stringify(r));
  writeFileSync(resolve(outDir, "aligned.jsonl"), alignedLines.join("\n") + "\n");

  // ── report.md ─────────────────────────────────────────────────────────────

  const md = [];
  md.push("# Swimlane Full Diff — Spec 152");
  md.push("");
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`VICE:     \`${vicePath}\``);
  md.push(`Headless: \`${headlessPath}\``);
  md.push(`Anchor:   c64.pc=$${anchorPc.toString(16).toUpperCase().padStart(4,"0")}`);
  md.push(`Strict:   ${strict}`);
  md.push("");
  md.push(`## Result: \`${classification}\``);
  md.push("");

  if (!firstDivergence) {
    md.push(`No divergence found in ${walkLen} rows after anchor (max-rows=${maxRows}).`);
    md.push("");
    md.push(`Soft warnings (non-tripping): ${softWarnings.length}`);
    if (softWarnings.length > 0 && softWarnings.length <= 10) {
      for (const w of softWarnings) {
        md.push(`  Row ${w.row}: ${w.deltas.map(d => `${d.field} VICE=${d.vice} HL=${d.headless}`).join(", ")}`);
      }
    } else if (softWarnings.length > 10) {
      md.push(`  (first 5 shown)`);
      for (const w of softWarnings.slice(0, 5)) {
        md.push(`  Row ${w.row}: ${w.deltas.map(d => `${d.field} VICE=${d.vice} HL=${d.headless}`).join(", ")}`);
      }
    }
  } else {
    const div = firstDivergence;
    md.push(`## First Divergence at Row ${div.rowIndex}`);
    md.push("");
    md.push(`- VICE file line (approx):     ${div.viceFileLineApprox}`);
    md.push(`- Headless file line (approx): ${div.headlessFileLineApprox}`);
    md.push(`- Cycle delta (ts):   ${div.cycleDeltaTs > 0 ? "+" : ""}${div.cycleDeltaTs}`);
    md.push(`- Cycle delta (tdrv): ${div.cycleDeltaTdrv > 0 ? "+" : ""}${div.cycleDeltaTdrv}`);
    md.push("");
    md.push("### Hard Field Deltas (tripped divergence)");
    md.push("");
    md.push("| Field | VICE | Headless |");
    md.push("|-------|------|----------|");
    for (const d of div.hardDeltas) {
      md.push(`| \`${d.field}\` | \`${d.vice}\` | \`${d.headless}\` |`);
    }
    md.push("");

    if (div.softDeltas.length > 0) {
      md.push("### Soft Field Deltas (warnings only)");
      md.push("");
      md.push("| Field | VICE | Headless |");
      md.push("|-------|------|----------|");
      for (const d of div.softDeltas) {
        md.push(`| \`${d.field}\` | \`${d.vice}\` | \`${d.headless}\` |`);
      }
      md.push("");
    }

    md.push("### Context (±5 rows)");
    md.push("");
    md.push("```");
    md.push(contextBlock(viceRows, headlessRows, viceAnchorIdx, headlessAnchorIdx, div.rowIndex, 5));
    md.push("```");
    md.push("");
    md.push("### Plausible Root Causes");
    md.push("");
    const classification2 = div.classification;
    if (classification2 === "pc-divergent") {
      md.push("- PC diverges: control flow took different path. Check JSR/JMP/branch targets.");
      md.push("- If pc differs by 1-2: opcode length mismatch (wrong instruction decode width).");
    } else if (classification2 === "op-divergent") {
      md.push("- Same PC but different opcode: memory content differs at this address.");
      md.push("- Possible self-modifying code or RAM init divergence.");
    } else if (classification2 === "state-divergent") {
      md.push("- Same PC+opcode but different registers: side-effects diverged earlier.");
      md.push("- Check IRQ timing, CIA timer counts, VIC raster at previous rows.");
    } else if (classification2 === "side-divergent") {
      md.push("- c64/drive interleave differs: one side ran more drive instructions before next C64 instruction.");
      md.push("- May indicate drive CPU speed or lockstep ratio discrepancy.");
    }
    md.push("");
    md.push(`Rows compared before divergence: ${div.rowIndex}`);
    md.push(`Soft warnings total: ${softWarnings.length}`);
  }

  md.push("");
  md.push("## Capture Summary");
  md.push("");
  md.push(`| | VICE | Headless |`);
  md.push(`|--|------|----------|`);
  md.push(`| Total rows | ${viceAll.length} | ${headlessAll.length} |`);
  md.push(`| Anchor row | ${viceAnchorIdx} | ${headlessAnchorIdx} |`);
  md.push(`| Rows after anchor | ${viceRows.length} | ${headlessRows.length} |`);

  writeFileSync(resolve(outDir, "report.md"), md.join("\n") + "\n");

  // ── Console summary ───────────────────────────────────────────────────────

  console.log("");
  console.log(`Classification: ${classification}`);
  if (firstDivergence) {
    const div = firstDivergence;
    console.log(`First divergence at row ${div.rowIndex}:`);
    for (const d of div.hardDeltas) {
      console.log(`  ${d.field}: VICE=${d.vice} vs headless=${d.headless}`);
    }
    console.log(`  Cycle delta ts: ${div.cycleDeltaTs}`);
  } else {
    console.log(`No divergence in ${walkLen} compared rows. Soft warnings: ${softWarnings.length}`);
  }
  console.log("");
  console.log(`Output written to: ${outDir}`);
  console.log(`  report.md    — human-readable`);
  console.log(`  report.json  — machine-readable`);
  console.log(`  aligned.jsonl — paired rows for downstream tooling`);
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
