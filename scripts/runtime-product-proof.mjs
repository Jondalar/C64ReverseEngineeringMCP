#!/usr/bin/env node
// scripts/runtime-product-proof.mjs
//
// Spec 715 — Runtime Product Proof runner.
//
// Manifest-driven product proof. The complete product proof is a manifest of
// capability gates PLUS the real-software seven-game canary — NOT the single
// legacy game-loop script treated as universal (Spec 715 §2.3).
//
// Modes:
//   (default / --full)        run every gate in the manifest
//   --barrier                 run only merge-barrier gates (default for --freeze)
//   --capability <cap>        run only gates owning <cap>
//   --list                    print the manifest and exit
//   --gate <id>               run a single gate by id
//
// Flags:
//   --no-build                skip `npm run build:mcp` (assume dist/ current)
//   --freeze                  on a full barrier run, write the baseline record
//                             doc (commit + manifest version + per-gate result)
//   --json                    emit machine-readable JSON summary to stdout tail
//   --drive1541 <sel>         pass C64RE_DRIVE1541 to children (default vice)
//
// Exit code:
//   0  every selected gate passed
//   1  any selected gate failed
//   2  CLI usage error
//
// Gate policy (Spec 715 §4/§5) — what to run when, summarized:
//   Tier 0 docs-only            : no emulator gate
//   Tier 1 local capability     : build + owning focused gate(s)
//   Tier 2 integrated capability: build + capability suite + 1 integrated proof
//   Tier 3 global semantics     : full product proof before share/merge
//   Full product proof (this, --barrier) is the merge boundary gate.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_VERSION,
  CAPABILITIES,
  GATES,
  gatesForCapability,
  barrierGates,
} from "./runtime-proof-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const opts = {
  list: argv.includes("--list"),
  full: argv.includes("--full"),
  barrier: argv.includes("--barrier"),
  freeze: argv.includes("--freeze"),
  json: argv.includes("--json"),
  noBuild: argv.includes("--no-build"),
  capability: flagValue("--capability"),
  gate: flagValue("--gate"),
  drive1541: flagValue("--drive1541") || process.env.C64RE_DRIVE1541 || "vice",
};

// ---- --list -----------------------------------------------------------------
if (opts.list) {
  console.log(`Runtime Product Proof manifest — version ${MANIFEST_VERSION}`);
  console.log("");
  for (const [cap, desc] of Object.entries(CAPABILITIES)) {
    console.log(`▸ ${cap}`);
    console.log(`    ${desc}`);
    for (const g of gatesForCapability(cap)) {
      const flags = [`T${g.tier}`, g.barrier ? "barrier" : "optional"].join(" ");
      console.log(`    - ${g.id.padEnd(28)} [${flags}]  node ${g.command.join(" ")}`);
    }
    console.log("");
  }
  const total = GATES.length;
  const barrier = barrierGates().length;
  console.log(`${total} gates across ${Object.keys(CAPABILITIES).length} capabilities (${barrier} merge-barrier).`);
  process.exit(0);
}

// ---- select gates -----------------------------------------------------------
let selected;
let scope;
if (opts.gate) {
  selected = GATES.filter((g) => g.id === opts.gate);
  scope = `gate:${opts.gate}`;
  if (selected.length === 0) {
    console.error(`[product-proof] no gate with id '${opts.gate}'. Use --list.`);
    process.exit(2);
  }
} else if (opts.capability) {
  if (!CAPABILITIES[opts.capability]) {
    console.error(`[product-proof] unknown capability '${opts.capability}'. Known: ${Object.keys(CAPABILITIES).join(", ")}`);
    process.exit(2);
  }
  selected = gatesForCapability(opts.capability);
  scope = `capability:${opts.capability}`;
} else if (opts.barrier || opts.freeze) {
  selected = barrierGates();
  scope = "product:barrier";
} else {
  selected = GATES;
  scope = "product:full";
}

if (opts.freeze && (opts.capability || opts.gate)) {
  console.error("[product-proof] --freeze requires a full product/barrier run, not a focused scope.");
  process.exit(2);
}

// ---- build once -------------------------------------------------------------
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, C64RE_DRIVE1541: opts.drive1541 },
  });
  if (r.error) {
    console.error(`[product-proof] ${label} spawn error: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

console.log("================= RUNTIME PRODUCT PROOF =================");
console.log(`Manifest:  ${MANIFEST_VERSION}`);
console.log(`Scope:     ${scope}`);
console.log(`Gates:     ${selected.length}`);
console.log(`Drive1541: ${opts.drive1541}`);
console.log("");

if (!opts.noBuild) {
  console.log("[product-proof] npm run build:mcp ...");
  const b = run("npm", ["run", "build:mcp"], "build:mcp");
  if (b !== 0) {
    console.error("[product-proof] build:mcp FAILED — aborting before any gate.");
    process.exit(1);
  }
  console.log("[product-proof] build OK.\n");
}

// ---- run gates --------------------------------------------------------------
const results = [];
for (const g of selected) {
  const started = Date.now();
  console.log(`\n──── gate: ${g.id}  (${g.capability}, T${g.tier})  node ${g.command.join(" ")} ────`);
  const status = run("node", g.command, g.id);
  const ms = Date.now() - started;
  results.push({ id: g.id, capability: g.capability, tier: g.tier, barrier: g.barrier, status, ms });
}

// ---- summary ----------------------------------------------------------------
console.log("\n================= PRODUCT PROOF SUMMARY =================");
console.log(`Manifest:  ${MANIFEST_VERSION}`);
console.log(`Scope:     ${scope}\n`);

let lastCap = null;
let pass = 0;
const failed = [];
for (const r of results) {
  if (r.capability !== lastCap) {
    console.log(`\n  ${r.capability}`);
    lastCap = r.capability;
  }
  const ok = r.status === 0;
  if (ok) pass++;
  else failed.push(r.id);
  const secs = (r.ms / 1000).toFixed(1).padStart(6);
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${r.id.padEnd(28)} ${secs}s${ok ? "" : `  (exit ${r.status})`}`);
}

const allGreen = failed.length === 0;
console.log("\n--------------------------------------------------------");
console.log(`${pass}/${results.length} gates pass.`);
if (!allGreen) console.log(`FAILED: ${failed.join(", ")}`);
console.log(allGreen ? `RESULT: GREEN (${scope})` : `RESULT: RED (${scope})`);

// ---- freeze record ----------------------------------------------------------
function gitShort() {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return (r.stdout || "").trim() || "unknown";
}
function gitFull() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  return (r.stdout || "").trim() || "unknown";
}

if (opts.freeze) {
  if (!allGreen) {
    console.error("\n[product-proof] --freeze refused: product proof is RED. No baseline written.");
    process.exit(1);
  }
  const commit = gitFull();
  const short = gitShort();
  const stamp = new Date().toISOString();
  const docDir = resolve(ROOT, "docs");
  if (!existsSync(docDir)) mkdirSync(docDir, { recursive: true });
  const recordPath = resolve(docDir, "runtime-product-baseline-2026-05-24.md");
  const lines = [];
  lines.push("# Runtime Product Baseline — runtime-product-green-2026-05-24");
  lines.push("");
  lines.push("Frozen by Spec 715 §3 / §715.4. This is the active product-level");
  lines.push("\"is the runtime green\" authority, replacing the Spec 600/601 seven-game");
  lines.push("gate as the *whole* proof (it remains one capability within this manifest).");
  lines.push("");
  lines.push("```text");
  lines.push(`baseline-id      : runtime-product-green-2026-05-24`);
  lines.push(`master-commit    : ${commit}`);
  lines.push(`master-short     : ${short}`);
  lines.push(`manifest-version : ${MANIFEST_VERSION}`);
  lines.push(`frozen-at        : ${stamp}`);
  lines.push(`drive1541        : ${opts.drive1541}`);
  lines.push(`result           : GREEN (${pass}/${results.length} gates)`);
  lines.push("```");
  lines.push("");
  lines.push("## Gate results");
  lines.push("");
  lines.push("| capability | gate | tier | barrier | result | seconds |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of results) {
    lines.push(`| ${r.capability} | \`${r.id}\` | ${r.tier} | ${r.barrier ? "yes" : "no"} | ${r.status === 0 ? "PASS" : "FAIL"} | ${(r.ms / 1000).toFixed(1)} |`);
  }
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run proof:product               # full manifest, this baseline");
  lines.push("npm run proof:capability -- cartridge   # one capability");
  lines.push("node scripts/runtime-product-proof.mjs --list");
  lines.push("```");
  lines.push("");
  writeFileSync(recordPath, lines.join("\n"));
  console.log(`\n[product-proof] baseline frozen → docs/runtime-product-baseline-2026-05-24.md`);
  console.log(`[product-proof] baseline-id: runtime-product-green-2026-05-24  commit ${short}`);
}

if (opts.json) {
  console.log("\n===JSON===");
  console.log(JSON.stringify({
    manifestVersion: MANIFEST_VERSION,
    scope,
    commit: gitShort(),
    pass,
    total: results.length,
    green: allGreen,
    failed,
    results,
  }, null, 2));
}

process.exit(allGreen ? 0 : 1);
