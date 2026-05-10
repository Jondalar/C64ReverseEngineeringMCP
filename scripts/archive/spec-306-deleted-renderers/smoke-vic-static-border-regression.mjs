#!/usr/bin/env node
// Spec 281 Phase 281e — static-RSEL=1 border regression smoke.
//
// Renders BASIC ready screen via vice-rasterized renderer for each
// of motm/MM/LNR/IM2 disks (= deterministic, no keyboard required)
// and compares against saved baseline hashes. Detects regressions in
// border geometry / display window behavior without depending on the
// keyboard typing path (which is currently broken for some chars,
// blocking full in-game gate).
//
// First run (no baseline file): writes baselines.
// Subsequent runs: pass if hash matches, fail with diff details.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import { startIntegratedSession } from "../dist/runtime/headless/integrated-session-manager.js";

const REPO = resolvePath(import.meta.dirname, "..");
const BASELINE_FILE = resolvePath(REPO, "samples/baselines/vic-static-border-281.json");
const FRAMES_DIR = resolvePath(REPO, "samples/baselines/vic-static-border-281");
mkdirSync(FRAMES_DIR, { recursive: true });

const TARGETS = [
  { name: "motm",    disk: "samples/motm.g64" },
  { name: "mm-s1",   disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64" },
  { name: "lnr-s1",  disk: "samples/last_ninja_remix_s1[system3_1991].g64" },
  { name: "im2",     disk: "samples/impossible_mission_ii[epyx_1987](!).g64" },
];

function frameHash(session, label) {
  const pngPath = resolvePath(FRAMES_DIR, `${label}.png`);
  session.renderToPng(pngPath);
  const bytes = readFileSync(pngPath);
  return { hash: createHash("sha256").update(bytes).digest("hex"), pngPath, size: bytes.length };
}

function bootBasicReady(diskPath) {
  const { session } = startIntegratedSession({
    diskPath,
    mode: "true-drive",
    useMicrocodedCpu: true,
    vicRenderer: "vice-rasterized",
  });
  session.resetCold("pal-default");
  // ~10M cycles = enough for KERNAL boot to READY prompt.
  session.runFor(10_000_000, { cycleBudget: 10_000_000 });
  return session;
}

console.log("=== Spec 281 static border regression smoke ===\n");

const baseline = existsSync(BASELINE_FILE)
  ? JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  : {};

const results = {};
let pass = 0, fail = 0, written = 0;

for (const t of TARGETS) {
  const diskPath = resolvePath(REPO, t.disk);
  if (!existsSync(diskPath)) {
    console.log(`  SKIP  ${t.name}: disk not found at ${diskPath}`);
    continue;
  }
  const session = bootBasicReady(diskPath);
  const { hash, pngPath, size } = frameHash(session, t.name);
  results[t.name] = { hash, size };
  if (!baseline[t.name]) {
    baseline[t.name] = { hash, size };
    console.log(`  WRITE ${t.name}: ${hash.slice(0,16)}... (${size}b) → baseline`);
    written++;
  } else if (baseline[t.name].hash === hash) {
    console.log(`  PASS  ${t.name}: ${hash.slice(0,16)}... (${size}b)`);
    pass++;
  } else {
    console.log(`  FAIL  ${t.name}: hash mismatch`);
    console.log(`        baseline: ${baseline[t.name].hash.slice(0,16)}... (${baseline[t.name].size}b)`);
    console.log(`        current : ${hash.slice(0,16)}... (${size}b)`);
    console.log(`        png     : ${pngPath}`);
    fail++;
  }
}

if (written > 0) {
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2));
  console.log(`\nWrote ${written} new baseline(s) to ${BASELINE_FILE}`);
}

console.log(`\n${pass}/${pass+fail} pass${fail > 0 ? ` (${fail} fail)` : ""}${written > 0 ? `, ${written} new` : ""}`);
process.exit(fail > 0 ? 1 : 0);
