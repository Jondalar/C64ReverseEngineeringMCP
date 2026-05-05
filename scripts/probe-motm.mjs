#!/usr/bin/env node
// Spec 138 — motm probe orchestrator (Q8: sequential A+B+C all 3).
//
// For each probe variant:
//   1. Run headless with --probe-mode <X>, capture bus-trace JSONL
//   2. (Optional) Run VICE capture (skipped if --no-vice)
//   3. Diff vs VICE baseline
//   4. Append result to summary table
//
// Output: probe report JSON + Markdown summarizing all 3 variants.
//
// Usage:
//   npm run probe:motm -- [--id motm] [--max-events 1000]
//                         [--no-vice]              # skip VICE capture
//                         [--vice-trace <path>]    # use existing capture
//                         [--out probe-report.md]

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
const id = args.id ?? "motm";
const maxEvents = Number(args["max-events"] ?? 1000);
const noVice = !!args["no-vice"];
const projectDir = args["project-dir"] ?? process.env.C64RE_PROJECT_DIR ?? repoRoot;
const tsTag = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(projectDir, "traces", `probe_${id}_${tsTag}`);
mkdirSync(outDir, { recursive: true });

console.error(`Spec 138 motm probe orchestrator`);
console.error(`Manifest entry: ${id}  Output dir: ${outDir}`);
console.error(`Max events / variant: ${maxEvents}`);
console.error(`VICE capture: ${noVice ? "SKIP" : "RUN"}`);

const variants = ["A", "B", "C"];
const headlessJsonl = {};
const diffs = {};

// 1. Run headless for each variant
for (const v of variants) {
  const out = join(outDir, `headless_${v}.jsonl`);
  console.error(``);
  console.error(`=== Variant ${v}: headless capture ===`);
  const r = spawnSync(process.execPath, [
    join(repoRoot, "scripts/bus-trace-motm.mjs"),
    "--id", id,
    "--max-events", String(maxEvents),
    "--cycle-budget", "50000000",
    "--out", out,
    "--probe-mode", v,
  ], {
    cwd: repoRoot,
    env: { ...process.env, C64RE_PROJECT_DIR: projectDir },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`Variant ${v} headless run failed (exit ${r.status})`);
    process.exit(1);
  }
  headlessJsonl[v] = out;
}

// 2. VICE capture (one capture, reused for all 3 variants since VICE
// doesn't change per variant)
let viceJsonl = args["vice-trace"];
if (!viceJsonl && !noVice) {
  viceJsonl = join(outDir, `vice.jsonl`);
  console.error(``);
  console.error(`=== VICE capture (shared baseline) ===`);
  const r = spawnSync(process.execPath, [
    join(repoRoot, "scripts/vice-iec-capture.mjs"),
    "--id", id,
    "--max-events", String(maxEvents),
    "--budget-ms", "180000",
    "--out", viceJsonl,
  ], {
    cwd: repoRoot,
    env: { ...process.env, C64RE_PROJECT_DIR: projectDir },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`VICE capture failed — proceeding without diff`);
    viceJsonl = null;
  }
}

// 3. Diff per variant if VICE trace present
const summary = { id, max_events: maxEvents, variants: {}, vice_trace: viceJsonl };
for (const v of variants) {
  const result = { headless_jsonl: headlessJsonl[v], diff: null };
  if (viceJsonl && existsSync(viceJsonl)) {
    const diffJson = join(outDir, `diff_${v}.json`);
    const diffMd = join(outDir, `diff_${v}.md`);
    console.error(``);
    console.error(`=== Variant ${v}: diff vs VICE ===`);
    const r = spawnSync(process.execPath, [
      join(repoRoot, "scripts/vice-iec-diff.mjs"),
      "--theirs", viceJsonl,
      "--ours", headlessJsonl[v],
      "--out-json", diffJson,
      "--out-md", diffMd,
      "--scenario", `${id}-probe-${v}`,
    ], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (r.status === 0 && existsSync(diffJson)) {
      const diff = JSON.parse(readFileSync(diffJson, "utf-8"));
      result.diff = {
        type: diff.divergence?.type ?? "match",
        first_idx_theirs: diff.divergence?.first_idx_theirs ?? -1,
        first_idx_ours: diff.divergence?.first_idx_ours ?? -1,
        their_byte_stream: diff.byte_streams.theirs.slice(0, 8),
        our_byte_stream: diff.byte_streams.ours.slice(0, 8),
        first_byte_diff_idx: diff.byte_streams.first_diff_idx,
        diff_md_path: diffMd,
      };
    }
  }
  summary.variants[v] = result;
}

// 4. Render summary
const reportMd = join(outDir, "probe-report.md");
const lines = [];
lines.push(`# Spec 138 motm probe report — ${id}`);
lines.push("");
lines.push(`Date: ${new Date().toISOString()}`);
lines.push(`Max events / variant: ${maxEvents}`);
lines.push(`VICE trace: ${viceJsonl ?? "(none — diff skipped)"}`);
lines.push("");
lines.push(`## Summary table`);
lines.push("");
lines.push(`| Variant | Headless events | Diff classification | First idx (theirs/ours) | First byte diff |`);
lines.push(`|---|---|---|---|---|`);
for (const v of variants) {
  const r = summary.variants[v];
  let evCount = "?";
  if (existsSync(r.headless_jsonl)) {
    evCount = readFileSync(r.headless_jsonl, "utf-8").split("\n").filter(Boolean).length;
  }
  const d = r.diff;
  const cls = d?.type ?? "(no diff)";
  const idxs = d ? `${d.first_idx_theirs}/${d.first_idx_ours}` : "-";
  const byteIdx = d?.first_byte_diff_idx === -1 ? "(none)" : (d?.first_byte_diff_idx ?? "-");
  lines.push(`| ${v} | ${evCount} | \`${cls}\` | ${idxs} | ${byteIdx} |`);
}
lines.push("");
lines.push(`## Decision tree (per Spec 138)`);
lines.push("");
const cA = summary.variants.A.diff;
const cB = summary.variants.B.diff;
const cC = summary.variants.C.diff;
// "match" = no event-level divergence AND non-empty byte streams that agree.
const isMatch = (d) => {
  if (!d) return false;
  if (d.type !== "match") return false;
  const bs = d.their_byte_stream ?? [];
  if (bs.length === 0) return false; // empty byte stream is not "match"
  return d.first_byte_diff_idx === -1;
};
if (cA && isMatch(cA)) {
  lines.push(`- **Variant A matches VICE first byte stream**. Push-flush alone sufficient. Spec 140 implements flush-only.`);
} else if (cB && isMatch(cB)) {
  lines.push(`- A diverges, B matches: tick-order is part of issue. Spec 140 implements flush + drive-first tick.`);
} else if (cC && isMatch(cC)) {
  lines.push(`- A+B diverge, C matches: pure push-model needed. Spec 140 disables lockstep tick in TrueDrive.`);
} else if (cA || cB || cC) {
  const cClassif = (d) => d ? (d.type ?? "?") : "(no diff)";
  const allEmpty =
    (cA?.their_byte_stream ?? []).length === 0 &&
    (cA?.our_byte_stream ?? []).length === 0;
  if (allEmpty) {
    lines.push(`- **Inconclusive**: VICE+headless byte streams empty. Both sides did not capture motm receive window in same phase. Re-run with longer budget or fix PC-arming.`);
  } else {
    lines.push(`- All three variants diverge from VICE. A=\`${cClassif(cA)}\`, B=\`${cClassif(cB)}\`, C=\`${cClassif(cC)}\`.`);
    lines.push(`- Cache (ADR-2) likely required. Spec 140 = flush + cache + further investigation.`);
  }
} else {
  lines.push(`- No VICE diff available — skip decision tree.`);
}
lines.push("");
lines.push(`## Per-variant diff artifacts`);
lines.push("");
for (const v of variants) {
  const r = summary.variants[v];
  lines.push(`### Variant ${v}`);
  lines.push(`- Headless trace: ${r.headless_jsonl}`);
  if (r.diff) {
    lines.push(`- Diff JSON: ${r.diff.diff_md_path.replace(".md", ".json")}`);
    lines.push(`- Diff MD: ${r.diff.diff_md_path}`);
    lines.push(`- VICE first 8 bytes: ${r.diff.their_byte_stream.join(" ")}`);
    lines.push(`- Ours first 8 bytes: ${r.diff.our_byte_stream.join(" ")}`);
  } else {
    lines.push(`- (no diff)`);
  }
  lines.push("");
}

writeFileSync(reportMd, lines.join("\n"));
writeFileSync(join(outDir, "probe-summary.json"), JSON.stringify(summary, null, 2));

console.error(``);
console.error(`Report MD: ${reportMd}`);
console.error(``);
console.log(lines.join("\n"));
