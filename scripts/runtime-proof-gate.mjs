#!/usr/bin/env node
// scripts/runtime-proof-gate.mjs
//
// Unified Runtime Proof Gate runner per Spec 600 (doctrine) + Spec 601
// (baseline truth table). Orchestrator only — runs the existing per-game
// scripts under scripts/test-*-screenshots.mjs and classifies each run
// against the Spec 601 expected state.
//
// NOT in scope for this script (per Spec 600):
//   - emulator/runtime code changes
//   - new oracle PNG capture
//   - pixel-level PNG diffing (human-reviewed)
//
// Exit code:
//   0  every game matches Spec 601 expected baseline
//   1  any GREEN-expected game failed, OR
//      any RED-expected game progressed unexpectedly without --accept-new-state
//   2  CLI usage error
//
// Flags:
//   --list                  print Spec 601 game registry and exit
//   --only <key>            run only the named game (still classified vs Spec 601)
//   --reuse-artifacts       skip re-run if a cached run exists, OR fall back to
//                           the baked Spec 601 baseline PC when the /tmp
//                           screenshot for that game still exists on disk
//   --update-baseline-doc   refresh the auto-actuals block in
//                           docs/runtime-proof-baseline-2026-05-16.md
//                           (between markers, never touches hand-written prose)
//   --accept-new-state      tolerate unexpected GREEN on a RED-expected game
//                           (does NOT mutate Spec 601; only suppresses exit-fail)

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const CACHE_DIR = resolve("samples/screenshots/runtime-gates");
const CACHE_FILE = resolve(CACHE_DIR, "last-run.json");
const BASELINE_DOC = resolve("docs/runtime-proof-baseline-2026-05-16.md");

// Spec 601 § "Stuck-PC vocabulary". Integers, lowercase-hex normalized.
// Range $e5cd..$e5d4 covers the entire KERNAL BASIC READY wait loop;
// the prior enumeration ($e5cd / $e5cf / $e5d4) missed $e5d0..$e5d3
// which are also in the loop (observed: Pawn cut surfaced PC=$e5d1).
const STUCK_PCS = new Set([
  0xe5cd, 0xe5ce, 0xe5cf, 0xe5d0,
  0xe5d1, 0xe5d2, 0xe5d3, 0xe5d4,              // KERNAL READY / BASIC main loop
  0xf6bf, 0xa483,                              // KERNAL LOAD / SAVE stalls
  0xf6c5, 0xf6da,                              // KERNAL LOAD region (LNR / Pawn red)
  0xeea9, 0xeeaf, 0xeeb2, 0xed5a, 0xed5d,      // KERNAL serial RX (fastloader RX stall)
]);

// Spec 601 baseline truth table. baselinePc = last-observed final PC at
// runtime-green-2026-05-16; used only as --reuse-artifacts fallback when
// the on-disk /tmp screenshot still exists but the run cache is empty.
const GAMES = [
  { key: "motm",      script: "scripts/test-motm-screenshots.mjs",
    expected: "GREEN", baselinePc: "b7bd",
    proofs: ["motm-title-45s.png", "motm-credits.png", "motm-ingame.png"],
    screenshot: "/tmp/motm-long-t150s.png" },
  { key: "mm",        script: "scripts/test-mm-screenshots.mjs",
    expected: "GREEN", baselinePc: "61d",
    proofs: ["mm-character-select.png"],
    screenshot: "/tmp/mm-t120s.png" },
  { key: "im2",       script: "scripts/test-im2-screenshots.mjs",
    expected: "GREEN", baselinePc: "2d2a",
    proofs: ["im2-title.png", "im2-ingame.png"],
    screenshot: "/tmp/im2-t180s.png" },
  { key: "scramble",  script: "scripts/test-scramble-screenshots.mjs",
    expected: "GREEN", baselinePc: "ff48",
    proofs: ["scramble-loadscreen.png", "scramble-title.png", "scramble-menu.png"],
    screenshot: "/tmp/scr-t120s.png" },
  { key: "polarbear", script: "scripts/test-polarbear-screenshots.mjs",
    expected: "GREEN", baselinePc: "1a2d",
    proofs: ["polarbear-load.png", "polarbear-text1_menu.png", "polarbear-scores_menu.png"],
    screenshot: "/tmp/polar-t060s.png" },
  { key: "pawn",      script: "scripts/test-pawn-screenshots.mjs",
    expected: "RED", baselinePc: "f6da",
    proofs: ["thepawn1.png", "thepawn2.png"],
    screenshot: "/tmp/pawn-t060s.png" },
  { key: "lnr",       script: "scripts/test-lnr-screenshots.mjs",
    expected: "RED", baselinePc: "f6c5",
    proofs: ["LNR_System3.png"],
    screenshot: "/tmp/lnr-t090s.png" },
];

const args = process.argv.slice(2);
const flags = {
  list: args.includes("--list"),
  reuse: args.includes("--reuse-artifacts"),
  updateDoc: args.includes("--update-baseline-doc"),
  acceptNew: args.includes("--accept-new-state"),
  only: null,
  drive1541: "legacy",
};
const onlyIdx = args.indexOf("--only");
if (onlyIdx >= 0) {
  flags.only = args[onlyIdx + 1];
  if (!flags.only) {
    console.error("--only requires a game key");
    process.exit(2);
  }
}
// Resolve --drive1541 / C64RE_DRIVE1541 selector. Accepts:
//   --drive1541 vice            (space-separated)
//   --drive1541=vice            (equals form)
//   C64RE_DRIVE1541=vice        (env var)
//   ... and the same for "both" / "legacy". Programmatic CLI form
//   wins over the env var.
function readDrive1541Selector(argv, env) {
  for (const a of argv) {
    if (a.startsWith("--drive1541=")) {
      return a.slice("--drive1541=".length);
    }
  }
  const i = argv.indexOf("--drive1541");
  if (i >= 0 && i + 1 < argv.length) {
    return argv[i + 1];
  }
  const e = env.C64RE_DRIVE1541;
  if (e === "vice" || e === "both" || e === "legacy") {
    return e;
  }
  return "legacy";
}
flags.drive1541 = readDrive1541Selector(args, process.env);

// Spec 611 §5 + §7 false-green guard.
//
// Phases 611.0–611.6 build VICE1541 incrementally but the C64 / IEC /
// disk runtime path still flows through LEGACY1541. Running real
// per-game LOAD gates with --drive1541=vice in that window would
// produce PASS results that are LEGACY1541's PASS, not VICE1541's —
// a false "VICE1541 passes runtime proof" claim.
//
// Until the phase that wires the Drive1541 surface end-to-end (per
// Spec 611 §5 row 611.7 "first real disk-read phase"), this gate
// refuses --drive1541=vice (and --drive1541=both). Remove this guard
// in the same commit that lands 611.7's end-to-end wiring AND its
// substep (a) D64 directory match.
if (flags.drive1541 !== "legacy") {
  console.error(
    `[runtime-proof-gate] refusing --drive1541=${flags.drive1541}: ` +
      `LOAD / game gates against VICE1541 are forbidden until Spec 611 ` +
      `phase 611.7 wires the Drive1541 surface end-to-end. Currently the ` +
      `C64 / IEC / disk runtime path still flows through LEGACY1541, so a ` +
      `pass here would be a false-green for VICE1541. See ` +
      `specs/611-new-vice1541-side-by-side.md §5 + §7 for the rule.`,
  );
  process.exit(2);
}

if (flags.list) {
  console.log("Spec 601 baseline truth table (runtime-green-2026-05-16):");
  console.log("");
  for (const g of GAMES) {
    console.log(`  ${g.key.padEnd(10)} expected=${g.expected.padEnd(5)} baselinePc=$${g.baselinePc}`);
    console.log(`    script:     ${g.script}`);
    console.log(`    screenshot: ${g.screenshot}`);
    console.log(`    proofs:     ${g.proofs.map((p) => `samples/screenshots/proof/${p}`).join(", ")}`);
  }
  console.log("");
  console.log(`stuck-PC vocab (Spec 601):  ${[...STUCK_PCS].map((v) => "$" + v.toString(16)).join(" ")}`);
  console.log(`cache file:                 ${CACHE_FILE}`);
  console.log(`baseline doc:               ${BASELINE_DOC}`);
  process.exit(0);
}

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}

function saveCache(cache) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + "\n");
}

function classify(finalPc) {
  if (!finalPc) return "UNKNOWN";
  const v = parseInt(finalPc, 16);
  if (Number.isNaN(v)) return "UNKNOWN";
  return STUCK_PCS.has(v) ? "RED" : "GREEN";
}

function runGame(g) {
  return new Promise((resolveRun) => {
    console.log(`[${g.key}] running ${g.script} ...`);
    const child = spawn("node", [g.script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); process.stdout.write(c); });
    child.stderr.on("data", (c) => process.stderr.write(c));
    child.on("close", (code) => {
      const m = [...stdout.matchAll(/PC=\$([0-9a-f]+)/g)];
      const finalPc = m.length ? m[m.length - 1][1] : null;
      resolveRun({ exitCode: code, finalPc, capturedAt: new Date().toISOString() });
    });
  });
}

const cache = loadCache();
const targets = flags.only ? GAMES.filter((g) => g.key === flags.only) : GAMES;
if (flags.only && targets.length === 0) {
  console.error(`Unknown game key: ${flags.only}`);
  console.error(`Available: ${GAMES.map((g) => g.key).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const g of targets) {
  let source = "ran";
  let finalPc = null;
  let capturedAt = null;

  if (flags.reuse) {
    if (cache[g.key]) {
      source = "cache";
      finalPc = cache[g.key].finalPc;
      capturedAt = cache[g.key].capturedAt;
      console.log(`[${g.key}] REUSED from cache (PC=$${finalPc}, captured ${capturedAt})`);
    } else if (existsSync(g.screenshot)) {
      source = "baseline";
      finalPc = g.baselinePc;
      capturedAt = "runtime-green-2026-05-16";
      const st = statSync(g.screenshot);
      console.log(`[${g.key}] REUSED Spec-601 baseline (PC=$${finalPc}; screenshot ${g.screenshot} present, mtime=${new Date(st.mtimeMs).toISOString()})`);
    }
  }

  if (finalPc === null) {
    const run = await runGame(g);
    finalPc = run.finalPc;
    capturedAt = run.capturedAt;
    if (finalPc !== null) {
      cache[g.key] = {
        finalPc,
        screenshot: g.screenshot,
        screenshotMtimeMs: existsSync(g.screenshot) ? statSync(g.screenshot).mtimeMs : null,
        capturedAt,
        expected: g.expected,
      };
    }
  }

  const actual = classify(finalPc);
  let verdict;
  if (g.expected === "GREEN" && actual === "GREEN") verdict = "PASS";
  else if (g.expected === "GREEN") verdict = "FAIL";
  else if (g.expected === "RED" && actual === "RED") verdict = "PASS (red-expected)";
  else if (g.expected === "RED" && actual === "GREEN") verdict = flags.acceptNew ? "NEW-STATE (accepted)" : "UNEXPECTED-GREEN";
  else verdict = "UNKNOWN";

  results.push({ ...g, finalPc, actual, verdict, source, capturedAt });
}

saveCache(cache);

console.log("");
console.log("================= RUNTIME PROOF GATE =================");
console.log("Baseline: runtime-green-2026-05-16 (87b4957)");
console.log("Doctrine: specs/600-runtime-proof-gates.md");
console.log("Truth:    specs/601-baseline-truth-table.md");
console.log("");

let fails = 0;
for (const r of results) {
  const tag = `[${r.source}]`.padEnd(11);
  const pc = r.finalPc ? `$${r.finalPc}` : "?";
  console.log(`  ${tag} ${r.key.padEnd(10)} expected=${r.expected.padEnd(5)} actual=${r.actual.padEnd(7)} PC=${pc.padEnd(8)} -> ${r.verdict}`);
  if (r.verdict === "FAIL" || r.verdict === "UNEXPECTED-GREEN") fails++;
}

console.log("");
if (fails === 0) {
  console.log(`RESULT: gate GREEN (${results.length}/${results.length} match Spec 601 baseline).`);
} else {
  console.log(`RESULT: gate RED -- ${fails} deviation(s) from Spec 601 baseline.`);
}

if (flags.updateDoc) {
  updateBaselineDoc(results);
}

process.exit(fails === 0 ? 0 : 1);

function updateBaselineDoc(results) {
  if (!existsSync(BASELINE_DOC)) {
    console.error(`Baseline doc missing: ${BASELINE_DOC}`);
    return;
  }
  const beginTag = "<!-- BEGIN runtime-proof-gate-actuals -->";
  const endTag = "<!-- END runtime-proof-gate-actuals -->";
  const txt = readFileSync(BASELINE_DOC, "utf8");
  if (!txt.includes(beginTag) || !txt.includes(endTag)) {
    console.error(`Doc lacks markers ${beginTag} / ${endTag}; cannot update`);
    return;
  }
  const lines = [
    "",
    `_Auto-refreshed by \`scripts/runtime-proof-gate.mjs\` at ${new Date().toISOString()}._`,
    "",
    "| Game      | Expected | Actual  | Final PC | Source     | Verdict             |",
    "|-----------|----------|---------|----------|------------|---------------------|",
  ];
  for (const r of results) {
    const pc = r.finalPc ? `$${r.finalPc}` : "?";
    lines.push(`| ${r.key.padEnd(9)} | ${r.expected.padEnd(8)} | ${r.actual.padEnd(7)} | ${pc.padEnd(8)} | ${r.source.padEnd(10)} | ${r.verdict.padEnd(19)} |`);
  }
  lines.push("");
  const replaced = txt.replace(
    new RegExp(`${beginTag}[\\s\\S]*?${endTag}`),
    `${beginTag}${lines.join("\n")}${endTag}`,
  );
  writeFileSync(BASELINE_DOC, replaced);
  console.log(`Updated ${BASELINE_DOC}`);
}
