#!/usr/bin/env node
// Spec 431 — Sprint-430 canary gate.
//
// Orchestrates capture + diff for every canary in
// samples/canaries/spec-430.json. Exit non-zero on any expected-green
// regression or any expected-red unexpected-match (track flip).
//
// Usage:
//   node scripts/spec-430-canary-gate.mjs [--only <id,id,...>]
//                                         [--skip-capture]
//
// --skip-capture re-uses the last capture if present (saves ~minutes
// during local iteration).
//
// Emits docs/spec-430-progress.md with the per-canary verdict table
// and the path to the JSON divergence report (machine-readable).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolvePath(__dirname, "..");

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

function gitSha() {
  const r = spawnSync("git", ["rev-parse", "--short=10", "HEAD"], {
    cwd: repoRoot, encoding: "utf8",
  });
  return r.status === 0 ? (r.stdout.trim() || "dev") : "dev";
}

const args = parseArgs(process.argv.slice(2));
const onlySet = args.only
  ? new Set(args.only.split(",").map((s) => s.trim()))
  : null;
const skipCapture = args["skip-capture"] === true;

const registry = JSON.parse(
  readFileSync(resolvePath(repoRoot, "samples/canaries/spec-430.json"), "utf8"),
);

const sha = gitSha();
const canaries = registry.canaries.filter(
  (c) => !onlySet || onlySet.has(c.id),
);

const results = [];
for (const c of canaries) {
  console.log(`\n========== ${c.id} (${c.expected}) ==========`);

  const hlDb = resolvePath(
    repoRoot,
    `samples/traces/spec-430/${c.id}/headless-${sha}/trace.duckdb`,
  );

  if (!skipCapture || !existsSync(hlDb)) {
    const cap = spawnSync(
      "node",
      ["scripts/spec-430-canary-trace.mjs", "--canary", c.id],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (cap.status !== 0) {
      results.push({ id: c.id, expected: c.expected, status: "capture-failed" });
      continue;
    }
  } else {
    console.log(`[${c.id}] skip-capture: re-using ${hlDb}`);
  }

  const diff = spawnSync(
    "node",
    ["scripts/spec-430-diff.mjs", "--canary", c.id],
    { cwd: repoRoot, stdio: "inherit" },
  );

  // Read the JSON report the diff script just wrote.
  const reportPath = resolvePath(
    repoRoot,
    `samples/traces/spec-430/${c.id}/diff-${sha}.json`,
  );
  let report = null;
  if (existsSync(reportPath)) {
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); }
    catch { /* keep null */ }
  }
  results.push({
    id: c.id,
    expected: c.expected,
    status: report?.status ?? "diff-failed",
    diffExit: diff.status,
    reportPath,
    divergedAt: report?.divergence?.divergedAt ?? null,
  });
}

// Verdict table
const verdict = (r) => {
  if (r.status === "match" && r.expected === "green") return "PASS";
  if (r.status === "diverged" && r.expected === "red") return "PASS (red as expected)";
  if (r.status === "smoke-only") return "PASS (smoke-only — no VICE baseline)";
  if (r.status === "vice-baseline-missing") return "WARN (VICE baseline missing)";
  if (r.status === "capture-failed") return "FAIL (capture)";
  if (r.status === "diverged" && r.expected === "green") return "FAIL (regression)";
  if (r.status === "match" && r.expected === "red") return "WARN (track flip — review)";
  return `UNKNOWN (${r.status})`;
};

console.log("\n========== SUMMARY ==========");
for (const r of results) {
  console.log(`  ${r.id.padEnd(10)} ${verdict(r).padEnd(35)} ${r.reportPath ?? ""}`);
}

// Write progress doc
const progressPath = resolvePath(repoRoot, "docs/spec-430-progress.md");
mkdirSync(dirname(progressPath), { recursive: true });
const lines = [
  `# Spec 430 — Sprint progress`,
  ``,
  `Sha: \`${sha}\`  ·  Generated: ${new Date().toISOString()}`,
  ``,
  `## Canary verdicts`,
  ``,
  `| Canary | Expected | Status | Verdict | Divergence row | Report |`,
  `|---|---|---|---|---|---|`,
];
for (const r of results) {
  lines.push(
    `| ${r.id} | ${r.expected} | ${r.status} | ${verdict(r)} | `
    + `${r.divergedAt ?? "—"} | `
    + `[json](${(r.reportPath ?? "").replace(repoRoot + "/", "")}) |`,
  );
}
lines.push("");
lines.push(`## How to reproduce`);
lines.push("");
lines.push("```sh");
lines.push("npm run canary:spec-430                     # full gate");
lines.push("npm run canary:spec-430 -- --only lnr-s1    # one canary");
lines.push("npm run canary:spec-430 -- --skip-capture   # re-use HL trace");
lines.push("```");
lines.push("");
writeFileSync(progressPath, lines.join("\n"));
console.log(`\nProgress: ${progressPath}`);

// Gate exit code
const fail = results.some(
  (r) =>
    (r.expected === "green" && r.status !== "match" && r.status !== "smoke-only")
    || (r.expected === "red" && r.status === "match")
    || r.status === "capture-failed"
    || r.status === "diff-failed",
);
process.exit(fail ? 1 : 0);
