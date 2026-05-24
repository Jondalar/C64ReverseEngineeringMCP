#!/usr/bin/env node
// scripts/runtime-product-proof.mjs
//
// Spec 715 — Runtime Product Proof runner (small real canary baseline).
//
// The product proof is the small `baseline` gate group: a fast, real canary set
// that answers "does the central runtime still work like yesterday?" in minutes.
// The big subsystem suites are `focused` (run on subsystem change) and old
// bring-up smokes are `historical` (diagnostic only). See runtime-proof-manifest.mjs.
//
// Modes:
//   (default) / --baseline / --freeze   run the baseline canary set (= product proof)
//   --capability <cap>                  run baseline+focused gates for <cap>
//   --gate <id>                         run a single gate by id
//   --focused                           run ALL focused gates (heavy)
//   --list                              print the manifest grouped, then exit
//
// Flags: --no-build · --freeze · --json · --drive1541 <sel>
//
// Exit: 0 all selected gates passed · 1 any failed · 2 usage error.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_VERSION, CAPABILITIES, FOCUSED_TRIGGERS, GATES,
  baselineGates, focusedGates, historicalGates, gatesForCapability,
} from "./runtime-proof-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const opts = {
  list: argv.includes("--list"),
  baseline: argv.includes("--baseline"),
  focusedAll: argv.includes("--focused"),
  freeze: argv.includes("--freeze"),
  json: argv.includes("--json"),
  noBuild: argv.includes("--no-build"),
  capability: flagValue("--capability"),
  gate: flagValue("--gate"),
  drive1541: flagValue("--drive1541") || process.env.C64RE_DRIVE1541 || "vice",
};

// ---- --list -----------------------------------------------------------------
if (opts.list) {
  console.log(`Runtime Product Proof manifest — ${MANIFEST_VERSION}`);
  const show = (title, gates) => {
    console.log(`\n=== ${title} (${gates.length}) ===`);
    let cap = null;
    for (const g of gates) {
      if (g.capability !== cap) { console.log(`  ▸ ${g.capability}`); cap = g.capability; }
      console.log(`    - ${g.id.padEnd(28)} [T${g.tier}]  ${g.command.join(" ")}`);
    }
  };
  show("BASELINE  (npm run proof:product — the merge barrier)", baselineGates());
  show("FOCUSED   (npm run proof:capability -- <cap> — on subsystem change)", focusedGates());
  show("HISTORICAL (diagnostic only — NOT baseline-capable)", historicalGates());
  console.log(`\nChange-surface → focused suite:`);
  for (const [surface, suite] of Object.entries(FOCUSED_TRIGGERS)) console.log(`    ${surface}  →  ${suite}`);
  console.log(`\n${GATES.length} gates total · ${baselineGates().length} baseline · ${focusedGates().length} focused · ${historicalGates().length} historical.`);
  process.exit(0);
}

// ---- select gates -----------------------------------------------------------
let selected, scope;
if (opts.gate) {
  selected = GATES.filter((g) => g.id === opts.gate);
  scope = `gate:${opts.gate}`;
  if (selected.length === 0) { console.error(`[product-proof] no gate '${opts.gate}'. Use --list.`); process.exit(2); }
} else if (opts.capability) {
  if (!CAPABILITIES[opts.capability]) {
    console.error(`[product-proof] unknown capability '${opts.capability}'. Known: ${Object.keys(CAPABILITIES).join(", ")}`);
    process.exit(2);
  }
  selected = gatesForCapability(opts.capability);
  scope = `capability:${opts.capability}`;
} else if (opts.focusedAll) {
  selected = focusedGates();
  scope = "focused:all";
} else {
  selected = baselineGates();
  scope = "product:baseline";
}

if (opts.freeze && (opts.capability || opts.gate || opts.focusedAll)) {
  console.error("[product-proof] --freeze requires the baseline scope (no --capability/--gate/--focused).");
  process.exit(2);
}

// ---- build once -------------------------------------------------------------
function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, C64RE_DRIVE1541: opts.drive1541 } });
  if (r.error) { console.error(`[product-proof] ${label} spawn error: ${r.error.message}`); return 1; }
  return r.status ?? 1;
}

console.log("================= RUNTIME PRODUCT PROOF =================");
console.log(`Manifest:  ${MANIFEST_VERSION}`);
console.log(`Scope:     ${scope}`);
console.log(`Gates:     ${selected.length}`);
console.log(`Drive1541: ${opts.drive1541}\n`);

if (!opts.noBuild) {
  console.log("[product-proof] npm run build:mcp ...");
  if (run("npm", ["run", "build:mcp"], "build:mcp") !== 0) {
    console.error("[product-proof] build:mcp FAILED — aborting before any gate.");
    process.exit(1);
  }
  console.log("[product-proof] build OK.\n");
}

// ---- run gates --------------------------------------------------------------
const results = [];
for (const g of selected) {
  const started = Date.now();
  console.log(`\n──── gate: ${g.id}  (${g.capability}, ${g.group}, T${g.tier})  ${g.command.join(" ")} ────`);
  const status = run(g.command[0], g.command.slice(1), g.id);
  results.push({ id: g.id, capability: g.capability, group: g.group, tier: g.tier, status, ms: Date.now() - started });
}

// ---- summary ----------------------------------------------------------------
console.log("\n================= PRODUCT PROOF SUMMARY =================");
console.log(`Manifest:  ${MANIFEST_VERSION}`);
console.log(`Scope:     ${scope}\n`);
let lastCap = null, pass = 0;
const failed = [];
for (const r of results) {
  if (r.capability !== lastCap) { console.log(`\n  ${r.capability}`); lastCap = r.capability; }
  const ok = r.status === 0;
  if (ok) pass++; else failed.push(r.id);
  console.log(`    ${ok ? "PASS" : "FAIL"}  ${r.id.padEnd(28)} ${(r.ms / 1000).toFixed(1).padStart(6)}s${ok ? "" : `  (exit ${r.status})`}`);
}
const allGreen = failed.length === 0;
console.log("\n--------------------------------------------------------");
console.log(`${pass}/${results.length} gates pass.`);
if (!allGreen) console.log(`FAILED: ${failed.join(", ")}`);
console.log(allGreen ? `RESULT: GREEN (${scope})` : `RESULT: RED (${scope})`);

// ---- freeze record ----------------------------------------------------------
const gitOut = (args) => (spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout || "").trim();
if (opts.freeze) {
  if (!allGreen) { console.error("\n[product-proof] --freeze refused: baseline is RED. No baseline written."); process.exit(1); }
  const commit = gitOut(["rev-parse", "HEAD"]) || "unknown";
  const short = gitOut(["rev-parse", "--short", "HEAD"]) || "unknown";
  const stamp = new Date().toISOString();
  const docDir = resolve(ROOT, "docs");
  if (!existsSync(docDir)) mkdirSync(docDir, { recursive: true });
  const recordPath = resolve(docDir, "runtime-product-baseline-2026-05-24.md");
  const L = [];
  L.push("# Runtime Product Baseline — runtime-product-green-2026-05-24");
  L.push("");
  L.push("Frozen by Spec 715. The active product-level \"is the runtime green\" authority:");
  L.push("a small, fast, real canary baseline (\"does the central runtime still work like");
  L.push("yesterday?\"). The big subsystem suites (616/617, 713/714.5, seven-game, 705/707,");
  L.push("706, 708, 709) are FOCUSED gates run only on subsystem change — not this baseline.");
  L.push("");
  L.push("```text");
  L.push(`baseline-id      : runtime-product-green-2026-05-24`);
  L.push(`master-commit    : ${commit}`);
  L.push(`master-short     : ${short}`);
  L.push(`manifest-version : ${MANIFEST_VERSION}`);
  L.push(`frozen-at        : ${stamp}`);
  L.push(`drive1541        : ${opts.drive1541}`);
  L.push(`result           : GREEN (${pass}/${results.length} baseline gates)`);
  L.push("```");
  L.push("");
  L.push("## Baseline gate results");
  L.push("");
  L.push("| capability | gate | tier | result | seconds |");
  L.push("|---|---|---|---|---|");
  for (const r of results) L.push(`| ${r.capability} | \`${r.id}\` | ${r.tier} | ${r.status === 0 ? "PASS" : "FAIL"} | ${(r.ms / 1000).toFixed(1)} |`);
  L.push("");
  L.push("## Reproduce");
  L.push("");
  L.push("```bash");
  L.push("npm run proof:product                  # the small baseline (this record)");
  L.push("npm run proof:capability -- cartridge  # baseline+focused for one capability");
  L.push("npm run proof:list                     # full manifest, grouped");
  L.push("```");
  L.push("");
  writeFileSync(recordPath, L.join("\n"));
  console.log(`\n[product-proof] baseline frozen → docs/runtime-product-baseline-2026-05-24.md (commit ${short})`);
}

if (opts.json) {
  console.log("\n===JSON===");
  console.log(JSON.stringify({ manifestVersion: MANIFEST_VERSION, scope, commit: gitOut(["rev-parse", "--short", "HEAD"]), pass, total: results.length, green: allGreen, failed, results }, null, 2));
}

process.exit(allGreen ? 0 : 1);
