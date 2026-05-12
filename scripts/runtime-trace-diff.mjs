#!/usr/bin/env node
// runtime-trace-diff.mjs — pairwise diff between two VICE-runtime-trace JSONL files.
// Locates first instruction where states diverge between VICE and headless traces.
//
// Schema (both files must match):
//   { kind:"sample", sampleIndex, capturedAt, currentPc, items, memspace }
//   { kind:"instruction", sampleIndex, clock, pc, instructionBytes, registers,
//     memspace }  — registers: PC, A, X, Y, SP, FL, LIN, CYC
//
// Usage:
//   node scripts/runtime-trace-diff.mjs \
//     --vice   analysis/runtime/<id>/trace/runtime-trace.jsonl \
//     --headless traces/<id>_headless_runtime_<ts>/runtime-trace.jsonl \
//     [--anchor-c64-pc 4000]     hex, default 4000
//     [--anchor-drive-pc <hex>]  anchor on drive side instead / additionally
//     [--memspace c64|drive|both]  default both
//     [--max-rows 100000]
//     [--strict]                 promote soft fields (LIN/CYC/clock) to hard
//     [--out traces/runtime_diff_<ts>/]
//
// NPM: trace:motm-runtime-diff

import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// CLI arg parsing
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

const args = parseArgs(process.argv.slice(2));

const vicePath     = args.vice     ? resolve(repoRoot, args.vice)     : null;
const headlessPath = args.headless ? resolve(repoRoot, args.headless) : null;
const anchorC64Pc  = args["anchor-c64-pc"]   ? parseInt(args["anchor-c64-pc"],   16) : 0x4000;
const anchorDrvPc  = args["anchor-drive-pc"] ? parseInt(args["anchor-drive-pc"], 16) : null;
const memspace     = args.memspace ?? "both";
const maxRows      = Number(args["max-rows"] ?? 100_000);
const strict       = args.strict === true || args.strict === "true";

const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = args.out
  ? resolve(repoRoot, args.out)
  : join(repoRoot, "traces", `runtime_diff_${tsTag}`);

if (!vicePath || !headlessPath) {
  console.error("Usage: node scripts/runtime-trace-diff.mjs --vice <path> --headless <path> [--anchor-c64-pc hex] [--memspace c64|drive|both] [--max-rows N] [--strict] [--out dir/]");
  process.exit(1);
}
if (!existsSync(vicePath))     { console.error(`VICE trace not found: ${vicePath}`);     process.exit(2); }
if (!existsSync(headlessPath)) { console.error(`Headless trace not found: ${headlessPath}`); process.exit(2); }

mkdirSync(outDir, { recursive: true });

const reportMdPath   = join(outDir, "report.md");
const reportJsonPath = join(outDir, "report.json");
const alignedPath    = join(outDir, "aligned.jsonl");

console.error(`Runtime trace diff`);
console.error(`  VICE:     ${vicePath}`);
console.error(`  Headless: ${headlessPath}`);
console.error(`  Memspace: ${memspace}`);
console.error(`  Anchor c64 PC: $${anchorC64Pc.toString(16).toUpperCase()}`);
if (anchorDrvPc !== null) console.error(`  Anchor drive PC: $${anchorDrvPc.toString(16).toUpperCase()}`);
console.error(`  Strict: ${strict}  Max rows: ${maxRows.toLocaleString()}`);
console.error(`  Output: ${outDir}`);

// ─────────────────────────────────────────────────────────────────────────────
// JSONL streaming reader — reuses src/runtime/vice/trace-runtime.ts logic
// without importing TS (we use raw JSONL since scripts are plain ESM).
// ─────────────────────────────────────────────────────────────────────────────
async function* readInstructions(path, targetMemspace) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.kind !== "instruction") continue;
    if (targetMemspace !== "both" && obj.memspace !== targetMemspace) continue;
    yield obj;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Find anchor: first instruction event where pc matches anchor for given memspace
// ─────────────────────────────────────────────────────────────────────────────
async function findAnchorIndex(path, targetMemspace, anchorPc, label) {
  // Returns { found: bool, index: number (0-based in instruction stream), pcDist: Map }
  const pcDist = new Map();
  let idx = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try { obj = JSON.parse(t); } catch { continue; }
    if (obj.kind !== "instruction") continue;
    if (targetMemspace !== "both" && obj.memspace !== targetMemspace) continue;
    pcDist.set(obj.pc, (pcDist.get(obj.pc) ?? 0) + 1);
    if (obj.pc === anchorPc) {
      console.error(`  [${label}] Anchor $${anchorPc.toString(16).toUpperCase()} found at instruction index ${idx}`);
      rl.close();
      return { found: true, index: idx, pcDist };
    }
    idx++;
  }
  return { found: false, index: -1, pcDist };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diff logic
// ─────────────────────────────────────────────────────────────────────────────
const FL_MASK = 0xEF; // mask out B-flag (bit 4)

function compareRegisters(vReg, hReg, strictMode) {
  const hardFields = ["PC", "A", "X", "Y", "SP"]; // FL handled separately
  const softFields = ["LIN", "CYC"];

  const hardMismatches = [];
  const softMismatches = [];

  // FL: compare with B-flag masked
  const vFL = (vReg.FL ?? 0) & FL_MASK;
  const hFL = (hReg.FL ?? 0) & FL_MASK;
  if (vFL !== hFL) {
    hardMismatches.push({ field: "FL", vice: vReg.FL, headless: hReg.FL, vMasked: vFL, hMasked: hFL });
  }

  for (const f of hardFields) {
    if ((vReg[f] ?? 0) !== (hReg[f] ?? 0)) {
      hardMismatches.push({ field: f, vice: vReg[f], headless: hReg[f] });
    }
  }

  if (strictMode) {
    for (const f of softFields) {
      if ((vReg[f] ?? 0) !== (hReg[f] ?? 0)) {
        hardMismatches.push({ field: f, vice: vReg[f], headless: hReg[f] });
      }
    }
  } else {
    for (const f of softFields) {
      if ((vReg[f] ?? 0) !== (hReg[f] ?? 0)) {
        softMismatches.push({ field: f, vice: vReg[f], headless: hReg[f] });
      }
    }
  }

  return { hardMismatches, softMismatches };
}

function fmtHex(n, pad = 4) {
  if (n === undefined || n === null) return "???";
  return "$" + n.toString(16).toUpperCase().padStart(pad, "0");
}

function fmtRegs(r) {
  if (!r) return "N/A";
  return `PC=${fmtHex(r.PC)} A=${fmtHex(r.A, 2)} X=${fmtHex(r.X, 2)} Y=${fmtHex(r.Y, 2)} SP=${fmtHex(r.SP, 2)} FL=${fmtHex(r.FL, 2)}`;
}

function fmtBytes(bytes) {
  if (!bytes) return "??";
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Run diff for a single memspace side
// Returns { classification, divergenceIdx, firstDiv, context, totalPaired }
// ─────────────────────────────────────────────────────────────────────────────
async function diffSide(targetMemspace, anchorPc, label) {
  // 1. Find anchor in both files
  console.error(`\n[${label}] Finding anchor $${anchorPc.toString(16).toUpperCase()} in both traces...`);
  const [viceAnchor, headlessAnchor] = await Promise.all([
    findAnchorIndex(vicePath, targetMemspace, anchorPc, `vice/${label}`),
    findAnchorIndex(headlessPath, targetMemspace, anchorPc, `headless/${label}`),
  ]);

  if (!viceAnchor.found) {
    console.error(`  [vice/${label}] Anchor NOT FOUND. Top PCs:`);
    const topPcs = [...viceAnchor.pcDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [pc, n] of topPcs) console.error(`    $${pc.toString(16).toUpperCase().padStart(4, "0")}  ${n}`);
    return { classification: "anchor-not-found", side: label, which: "vice", pcDist: viceAnchor.pcDist };
  }
  if (!headlessAnchor.found) {
    console.error(`  [headless/${label}] Anchor NOT FOUND. Top PCs:`);
    const topPcs = [...headlessAnchor.pcDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [pc, n] of topPcs) console.error(`    $${pc.toString(16).toUpperCase().padStart(4, "0")}  ${n}`);
    return { classification: "anchor-not-found", side: label, which: "headless", pcDist: headlessAnchor.pcDist };
  }

  // 2. Collect ±10 context window + walk sequence
  const CONTEXT = 10;
  const viceGen     = readInstructions(vicePath, targetMemspace);
  const headlessGen = readInstructions(headlessPath, targetMemspace);

  // Skip to anchor in each stream
  for (let i = 0; i < viceAnchor.index; i++) {
    const r = await viceGen.next();
    if (r.done) break;
  }
  for (let i = 0; i < headlessAnchor.index; i++) {
    const r = await headlessGen.next();
    if (r.done) break;
  }

  // Ring buffer for context
  const ring = []; // last CONTEXT pairs
  let totalPaired = 0;
  let divergenceIdx = -1;
  let firstDiv = null;
  let rowsEmitted = 0;

  while (rowsEmitted < maxRows) {
    const [vR, hR] = await Promise.all([viceGen.next(), headlessGen.next()]);
    if (vR.done || hR.done) break;

    const v = vR.value;
    const h = hR.value;

    // Compare pc
    const pcMatch = v.pc === h.pc;
    const opcodeMatch = (v.instructionBytes?.[0] ?? -1) === (h.instructionBytes?.[0] ?? -2);

    // Compare registers
    const { hardMismatches, softMismatches } = compareRegisters(
      v.registers ?? {},
      h.registers ?? {},
      strict
    );

    // Clock soft-mismatch (just warn)
    const clockDiff = Math.abs(Number(v.clock) - Number(h.clock));
    const clockMismatch = clockDiff > 10; // > 10 cycles = flag as soft

    const pair = {
      vice: v,
      headless: h,
      deltaFields: {
        pcMatch,
        opcodeMatch,
        hardMismatches,
        softMismatches,
        clockDiff: strict ? undefined : clockDiff,
      },
    };

    // Emit to aligned.jsonl (only first maxRows)
    if (rowsEmitted < maxRows) {
      appendFileSync(alignedPath, JSON.stringify({ memspace: targetMemspace, seqIdx: totalPaired, ...pair }) + "\n");
    }

    ring.push(pair);
    if (ring.length > CONTEXT * 2 + 1) ring.shift();

    if (divergenceIdx < 0) {
      // Check for hard divergence
      const isDiverged = !pcMatch || !opcodeMatch || hardMismatches.length > 0 ||
        (strict && clockMismatch);

      if (isDiverged) {
        divergenceIdx = totalPaired;
        firstDiv = pair;
        // Print to stderr immediately so user sees it
        const reason = !pcMatch ? "pc-divergent"
          : !opcodeMatch ? "opcode-divergent"
          : "register-divergent";
        console.error(`\n  [${label}] FIRST DIVERGENCE at seq ${totalPaired} (reason: ${reason})`);
        console.error(`    VICE:     pc=${fmtHex(v.pc)} bytes=${fmtBytes(v.instructionBytes)} ${fmtRegs(v.registers)}`);
        console.error(`    Headless: pc=${fmtHex(h.pc)} bytes=${fmtBytes(h.instructionBytes)} ${fmtRegs(h.registers)}`);
        if (hardMismatches.length > 0) {
          console.error(`    Hard mismatches: ${hardMismatches.map((m) => `${m.field}(v=${m.vice},h=${m.headless})`).join(", ")}`);
        }
      }
    }

    totalPaired++;
    rowsEmitted++;

    // Stop after divergence + CONTEXT extra rows for context
    if (divergenceIdx >= 0 && totalPaired >= divergenceIdx + CONTEXT + 1) break;
  }

  const classification = divergenceIdx < 0 ? "aligned"
    : !firstDiv.deltaFields.pcMatch ? "pc-divergent"
    : !firstDiv.deltaFields.opcodeMatch ? "opcode-divergent"
    : "register-divergent";

  // Build ±CONTEXT window from ring
  const contextRows = [...ring];

  console.error(`  [${label}] Paired ${totalPaired.toLocaleString()} instructions. Result: ${classification}`);

  return {
    classification,
    side: label,
    memspace: targetMemspace,
    anchorPc,
    viceAnchorIdx: viceAnchor.index,
    headlessAnchorIdx: headlessAnchor.index,
    divergenceIdx,
    firstDiv,
    contextRows,
    totalPaired,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
const results = [];

if (memspace === "both" || memspace === "c64") {
  const r = await diffSide("c64", anchorC64Pc, "c64");
  results.push(r);
}
if (memspace === "both" || memspace === "drive") {
  const drvAnchor = anchorDrvPc ?? 0xEA7E; // drive ROM init as fallback
  const r = await diffSide("drive", drvAnchor, "drive");
  results.push(r);
}

// ─────────────────────────────────────────────────────────────────────────────
// Write report.json
// ─────────────────────────────────────────────────────────────────────────────
const reportJson = {
  generated: new Date().toISOString(),
  vice: vicePath,
  headless: headlessPath,
  strict,
  results: results.map((r) => ({
    memspace: r.memspace ?? r.side,
    classification: r.classification,
    anchorPc: r.anchorPc !== undefined ? fmtHex(r.anchorPc) : undefined,
    viceAnchorIdx: r.viceAnchorIdx,
    headlessAnchorIdx: r.headlessAnchorIdx,
    divergenceIdx: r.divergenceIdx,
    totalPaired: r.totalPaired,
    firstDiv: r.firstDiv ? {
      vicepc: fmtHex(r.firstDiv.vice.pc),
      headlesspc: fmtHex(r.firstDiv.headless.pc),
      hardMismatches: r.firstDiv.deltaFields.hardMismatches,
    } : null,
    pcDistTop: r.pcDist
      ? [...r.pcDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
          .map(([pc, n]) => ({ pc: fmtHex(pc), n }))
      : undefined,
  })),
};
writeFileSync(reportJsonPath, JSON.stringify(reportJson, null, 2));

// ─────────────────────────────────────────────────────────────────────────────
// Write report.md
// ─────────────────────────────────────────────────────────────────────────────
const lines = [];
lines.push(`# Runtime Trace Diff Report`);
lines.push(`\nGenerated: ${reportJson.generated}`);
lines.push(`\n| Field | Value |`);
lines.push(`|---|---|`);
lines.push(`| VICE | \`${vicePath}\` |`);
lines.push(`| Headless | \`${headlessPath}\` |`);
lines.push(`| Strict | ${strict} |`);
lines.push(`| Memspace | ${memspace} |`);

for (const r of results) {
  lines.push(`\n## Side: ${r.memspace ?? r.side}`);
  lines.push(`\n**Classification:** \`${r.classification}\``);

  if (r.classification === "anchor-not-found") {
    lines.push(`\nAnchor PC \`${fmtHex(r.anchorPc)}\` not found in **${r.which}** trace.`);
    lines.push(`\nTop PCs in that trace:`);
    lines.push(`\n| PC | Count |`);
    lines.push(`|---|---|`);
    if (r.pcDist) {
      const top = [...r.pcDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      for (const [pc, n] of top) {
        lines.push(`| ${fmtHex(pc)} | ${n} |`);
      }
    }
    continue;
  }

  lines.push(`\n| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Anchor PC | ${fmtHex(r.anchorPc)} |`);
  lines.push(`| VICE anchor instruction index | ${r.viceAnchorIdx} |`);
  lines.push(`| Headless anchor instruction index | ${r.headlessAnchorIdx} |`);
  lines.push(`| Total paired instructions | ${(r.totalPaired ?? 0).toLocaleString()} |`);
  lines.push(`| First divergence at seq | ${r.divergenceIdx >= 0 ? r.divergenceIdx : "none (fully aligned)"} |`);

  if (r.classification === "aligned") {
    lines.push(`\nNo hard divergence detected in ${(r.totalPaired ?? 0).toLocaleString()} paired instructions.`);
    continue;
  }

  // Divergence details
  if (r.firstDiv) {
    const v = r.firstDiv.vice;
    const h = r.firstDiv.headless;
    const df = r.firstDiv.deltaFields;

    lines.push(`\n### First Divergence (seq ${r.divergenceIdx})\n`);
    lines.push(`| Field | VICE | Headless |`);
    lines.push(`|---|---|---|`);
    lines.push(`| memspace | ${v.memspace ?? "?"} | ${h.memspace ?? "?"} |`);
    lines.push(`| PC | ${fmtHex(v.pc)} | ${fmtHex(h.pc)} |`);
    lines.push(`| Opcode | ${fmtHex(v.instructionBytes?.[0] ?? 0, 2)} | ${fmtHex(h.instructionBytes?.[0] ?? 0, 2)} |`);
    lines.push(`| InstructionBytes | \`${fmtBytes(v.instructionBytes)}\` | \`${fmtBytes(h.instructionBytes)}\` |`);
    lines.push(`| A | ${fmtHex(v.registers?.A ?? 0, 2)} | ${fmtHex(h.registers?.A ?? 0, 2)} |`);
    lines.push(`| X | ${fmtHex(v.registers?.X ?? 0, 2)} | ${fmtHex(h.registers?.X ?? 0, 2)} |`);
    lines.push(`| Y | ${fmtHex(v.registers?.Y ?? 0, 2)} | ${fmtHex(h.registers?.Y ?? 0, 2)} |`);
    lines.push(`| SP | ${fmtHex(v.registers?.SP ?? 0, 2)} | ${fmtHex(h.registers?.SP ?? 0, 2)} |`);
    lines.push(`| FL | ${fmtHex(v.registers?.FL ?? 0, 2)} (masked: ${fmtHex((v.registers?.FL ?? 0) & FL_MASK, 2)}) | ${fmtHex(h.registers?.FL ?? 0, 2)} (masked: ${fmtHex((h.registers?.FL ?? 0) & FL_MASK, 2)}) |`);
    lines.push(`| clock | ${v.clock} | ${h.clock} |`);
    lines.push(`| sampleIndex | ${v.sampleIndex} | ${h.sampleIndex} |`);

    if (df.hardMismatches?.length > 0) {
      lines.push(`\n**Hard field mismatches:**\n`);
      lines.push(`| Field | VICE | Headless |`);
      lines.push(`|---|---|---|`);
      for (const m of df.hardMismatches) {
        const vVal = m.vMasked !== undefined ? `${m.vice} (masked: ${m.vMasked})` : String(m.vice);
        const hVal = m.hMasked !== undefined ? `${m.headless} (masked: ${m.hMasked})` : String(m.headless);
        lines.push(`| ${m.field} | ${vVal} | ${hVal} |`);
      }
    }
    if (df.softMismatches?.length > 0) {
      lines.push(`\n**Soft field mismatches (LIN/CYC — expected for headless):**\n`);
      for (const m of df.softMismatches) {
        lines.push(`- ${m.field}: VICE=${m.vice}, headless=${m.headless}`);
      }
    }
  }

  // Context window
  if (r.contextRows?.length > 0) {
    const divIdx = r.divergenceIdx;
    const contextStart = Math.max(0, r.contextRows.length - 21); // last ~21 rows (±10 + div)

    lines.push(`\n### Context (±10 instructions around divergence)\n`);
    lines.push(`| Seq | Side | PC | A | X | Y | SP | FL | Opcode | Note |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|`);

    // The context ring has the rows ending at divergence + CONTEXT
    // We want to show them with their actual sequence indices
    const baseSeq = Math.max(0, divIdx - (r.contextRows.length - 1));
    for (let i = 0; i < r.contextRows.length; i++) {
      const pair = r.contextRows[i];
      const seq = baseSeq + i;
      const marker = seq === divIdx ? " ◀ DIVERGE" : "";
      const v = pair.vice;
      const h = pair.headless;
      lines.push(`| ${seq} | VICE | ${fmtHex(v.pc)} | ${fmtHex(v.registers?.A??0,2)} | ${fmtHex(v.registers?.X??0,2)} | ${fmtHex(v.registers?.Y??0,2)} | ${fmtHex(v.registers?.SP??0,2)} | ${fmtHex(v.registers?.FL??0,2)} | \`${fmtBytes(v.instructionBytes)}\` |${marker} |`);
      lines.push(`| ${seq} | HL | ${fmtHex(h.pc)} | ${fmtHex(h.registers?.A??0,2)} | ${fmtHex(h.registers?.X??0,2)} | ${fmtHex(h.registers?.Y??0,2)} | ${fmtHex(h.registers?.SP??0,2)} | ${fmtHex(h.registers?.FL??0,2)} | \`${fmtBytes(h.instructionBytes)}\` |${marker} |`);
    }
  }
}

lines.push(`\n---\n*Generated by scripts/runtime-trace-diff.mjs*`);
writeFileSync(reportMdPath, lines.join("\n") + "\n");

console.error(`\nOutput files:`);
console.error(`  ${reportMdPath}`);
console.error(`  ${reportJsonPath}`);
console.error(`  ${alignedPath}`);

// Summary
const overallClass = results.every((r) => r.classification === "aligned")
  ? "aligned"
  : results.some((r) => r.classification === "anchor-not-found")
  ? "anchor-not-found"
  : results.some((r) => r.classification === "pc-divergent")
  ? "pc-divergent"
  : results.some((r) => r.classification === "opcode-divergent")
  ? "opcode-divergent"
  : "register-divergent";

console.error(`\nOverall classification: ${overallClass}`);
for (const r of results) {
  const div = r.divergenceIdx >= 0 ? `seq ${r.divergenceIdx}` : "none";
  console.error(`  ${r.memspace ?? r.side}: ${r.classification}  (divergence at: ${div}, paired: ${r.totalPaired ?? "?"})`);
}
