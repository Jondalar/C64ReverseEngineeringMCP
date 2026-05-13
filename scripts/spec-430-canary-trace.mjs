#!/usr/bin/env node
// Spec 431 — Canary trace capture wrapper.
//
// Reads samples/canaries/spec-430.json, captures a headless trace for the
// named canary into the trace store under
// samples/traces/spec-430/<canary>/headless-<sha>/trace.duckdb.
//
// Usage:
//   node scripts/spec-430-canary-trace.mjs --canary <id>
//   node scripts/spec-430-canary-trace.mjs --canary all
//
// Never writes JSONL/CSV outside the trace store
// (feedback_trace_into_duckdb).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
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
  if (r.status !== 0) return "dev";
  return r.stdout.trim() || "dev";
}

function loadRegistry() {
  const path = resolvePath(repoRoot, "samples/canaries/spec-430.json");
  if (!existsSync(path)) {
    console.error(`canary registry missing: ${path}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function captureOne(canary, registry, sha) {
  const defaults = registry.default ?? {};
  const mode = canary.mode ?? defaults.mode ?? "true-drive";
  const runSec = canary.run_sec ?? defaults.run_sec ?? 30;
  const bootType = canary.boot_type ?? defaults.boot_type ?? "";
  const microcoded = canary.useMicrocodedCpu
    ?? defaults.useMicrocodedCpu ?? true;

  const diskPath = resolvePath(repoRoot, canary.disk);
  if (!existsSync(diskPath)) {
    console.error(`[${canary.id}] disk missing: ${diskPath}`);
    return { canary: canary.id, status: "missing-disk" };
  }

  const outDir = resolvePath(
    repoRoot,
    `samples/traces/spec-430/${canary.id}/headless-${sha}`,
  );
  const dbPath = join(outDir, "trace.duckdb");

  // Clean previous run for this exact sha so capture is idempotent.
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true });
  }
  mkdirSync(outDir, { recursive: true });

  // Re-use existing capture script. It writes into samples/traces/v2-baseline/
  // by default; we use --label to control the directory suffix and then
  // move/rename. Simpler: invoke capture with custom env to redirect outRoot.
  //
  // The existing script computes outRoot as
  //   samples/traces/v2-baseline/<label>-headless-store-<date>
  // and exits if dbPath exists. To stay aligned, we wrap by setting
  // an env override (added below) OR by capturing to v2-baseline path
  // and post-moving. Post-move is robust and does not require modifying
  // headless-trace-store-capture.mjs.
  const label = `spec-430-${canary.id}-${sha}`;
  const date = new Date().toISOString().slice(0, 10);
  const srcDir = resolvePath(
    repoRoot,
    `samples/traces/v2-baseline/${label}-headless-store-${date}`,
  );
  // Pre-clean the v2-baseline staging dir (capture script aborts if
  // its target db already exists).
  if (existsSync(srcDir)) rmSync(srcDir, { recursive: true, force: true });

  const capArgs = [
    "scripts/headless-trace-store-capture.mjs",
    "--disk", canary.disk,
    "--label", label,
    "--run-sec", String(runSec),
    "--mode", mode,
    "--type", bootType,
    "--no-parquet",
  ];
  if (microcoded) capArgs.push("--microcoded");

  console.log(`[${canary.id}] capture start`);
  console.log(`  disk      : ${canary.disk}`);
  console.log(`  run_sec   : ${runSec}`);
  console.log(`  microcoded: ${microcoded}`);
  const r = spawnSync("node", capArgs, {
    cwd: repoRoot, stdio: "inherit",
    env: { ...process.env, C64RE_GIT_SHA: sha },
  });

  if (r.status !== 0) {
    console.error(`[${canary.id}] capture failed (exit ${r.status})`);
    return { canary: canary.id, status: "capture-failed", exit: r.status };
  }

  // Locate the just-created dir under v2-baseline (today's date suffix).
  if (!existsSync(srcDir)) {
    console.error(`[${canary.id}] capture output not found: ${srcDir}`);
    return { canary: canary.id, status: "output-missing" };
  }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  renameSync(srcDir, outDir);

  console.log(`[${canary.id}] capture ok → ${dbPath}`);
  return { canary: canary.id, status: "ok", dbPath };
}

const args = parseArgs(process.argv.slice(2));
if (!args.canary) {
  console.error("usage: spec-430-canary-trace.mjs --canary <id|all>");
  process.exit(2);
}

const registry = loadRegistry();
const sha = gitSha();
const targets = args.canary === "all"
  ? registry.canaries
  : registry.canaries.filter((c) => c.id === args.canary);

if (targets.length === 0) {
  console.error(`no canary matching ${args.canary}`);
  process.exit(2);
}

const results = [];
for (const c of targets) {
  results.push(captureOne(c, registry, sha));
}

console.log("\n=== summary ===");
for (const r of results) {
  console.log(`  ${r.canary.padEnd(10)} ${r.status}`);
}

const anyFail = results.some((r) => r.status !== "ok");
process.exit(anyFail ? 1 : 0);
