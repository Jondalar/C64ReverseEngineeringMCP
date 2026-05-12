#!/usr/bin/env node
// Spec 269 — Export smoke (PNG / WAV / video).
//
// Cases:
//   1. PNG export 392×272 — file created, correct dimensions
//   2. PNG export scale=2 → 784×544
//   3. WAV export 2s — file ≈ expected size (≥ 44 bytes header + PCM)
//   4. WAV determinism — two identical runs produce byte-equal WAV
//   5. Video export (skip if ffmpeg absent) — mp4 created, non-empty
//
// Prerequisites: npm run build:mcp

import { resolve as resolvePath } from "node:path";
import { existsSync, statSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repoRoot = resolvePath(import.meta.dirname, "..");

// Detect ffmpeg.
const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
const hasFfmpeg = ffmpegCheck.status === 0;

// ---- Fixtures ----
const syntheticDisk = resolvePath(repoRoot, "samples/synthetic/1byte.g64");
if (!existsSync(syntheticDisk)) {
  console.error(`fixture missing: ${syntheticDisk}`);
  console.error("Run: npm run smoke:gen");
  process.exit(2);
}

// ---- Imports ----
let exportScreenshot, exportVideo, exportScenarioAudio, saveScenario, deleteScenario;
try {
  ({ exportScreenshot } = await import(`${repoRoot}/dist/runtime/headless/export/screenshot.js`));
  ({ exportVideo } = await import(`${repoRoot}/dist/runtime/headless/export/video.js`));
  ({ exportScenarioAudio } = await import(`${repoRoot}/dist/runtime/headless/export/audio-export.js`));
  ({ saveScenario, deleteScenario } = await import(`${repoRoot}/dist/runtime/headless/v2/scenario-registry.js`));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

// ---- Helpers ----
const results = [];
function test(name, ok, detail = "") {
  results.push({ name, pass: ok, detail });
  const label = ok ? "PASS" : "FAIL";
  console.log(`  ${label}  ${name}${detail ? `: ${detail}` : ""}`);
}

function skip(name, reason) {
  results.push({ name, pass: null, detail: reason });
  console.log(`  SKIP  ${name}: ${reason}`);
}

function fileBytes(p) { return existsSync(p) ? statSync(p).size : -1; }
function fileHash(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

// Tmp output dir for smoke artifacts.
const outDir = resolvePath(tmpdir(), `c64re-smoke-export-${process.pid}`);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
function outFile(name) { return resolvePath(outDir, name); }

// ---- Minimal scenario (no real startSnapshot — cycles from reset) ----
const SCENARIO_ID = `smoke-export-test-${Date.now()}`;
const scenario = {
  id: SCENARIO_ID,
  diskPath: syntheticDisk,
  mode: "fast-trap",
  cycleBudget: 50_000,  // ~50ms — fast for smoke
  inputs: [],
  startSnapshot: "",    // empty = no snapshot, session starts from constructor
};
saveScenario(scenario);

console.log(`\n=== Spec 269 — Export smoke ===`);
console.log(`  scenario: ${SCENARIO_ID}  disk: ${syntheticDisk}`);
console.log(`  ffmpeg: ${hasFfmpeg ? "present" : "ABSENT (video test skipped)"}`);
console.log(`  outDir: ${outDir}\n`);

try {
  // ---- Case 1: PNG 1x (392×272) ----
  {
    const p = outFile("frame-1x.png");
    const r = await exportScreenshot(SCENARIO_ID, p, { scale: 1 });
    const ok = existsSync(p) && r.width === 392 && r.height === 272 && r.bytes > 0;
    test("1. PNG 1x → 392×272", ok,
         `w=${r.width} h=${r.height} bytes=${r.bytes} cycles=${r.cycles_ran}`);
  }

  // ---- Case 2: PNG scale=2 (784×544) ----
  {
    const p = outFile("frame-2x.png");
    const r = await exportScreenshot(SCENARIO_ID, p, { scale: 2 });
    const ok = existsSync(p) && r.width === 784 && r.height === 544 && r.bytes > 0;
    test("2. PNG scale=2 → 784×544", ok,
         `w=${r.width} h=${r.height} bytes=${r.bytes}`);
  }

  // ---- Case 3: WAV 2s ----
  {
    const p = outFile("audio-2s.wav");
    const r = await exportScenarioAudio(SCENARIO_ID, p, { duration: 2 });
    // Expected: 44-byte header + stereo s16le: 2 * 44100 * 2ch * 2bytes = 352 800 + 44
    // But the session is only running 50k cycles (~50ms), so audio may be shorter
    // depending on implementation. Check WAV header at minimum: ≥ 44 bytes + some audio.
    const sz = fileBytes(p);
    const ok = existsSync(p) && sz >= 44 + 100; // at least a few samples
    test("3. WAV export 2s — file created with PCM", ok,
         `size=${sz} samples=${r.samples} sr=${r.sample_rate}`);
  }

  // ---- Case 4: WAV determinism ----
  {
    const p1 = outFile("audio-det-a.wav");
    const p2 = outFile("audio-det-b.wav");
    await exportScenarioAudio(SCENARIO_ID, p1, { duration: 1 });
    await exportScenarioAudio(SCENARIO_ID, p2, { duration: 1 });
    const h1 = fileHash(p1);
    const h2 = fileHash(p2);
    const ok = h1 === h2;
    test("4. WAV determinism — two runs byte-equal", ok,
         ok ? "hashes match" : `h1=${h1.slice(0,12)} h2=${h2.slice(0,12)}`);
  }

  // ---- Case 5: Video (skip if no ffmpeg) ----
  if (!hasFfmpeg) {
    skip("5. MP4 video export", "ffmpeg not installed — install via: brew install ffmpeg");
  } else {
    const p = outFile("video-2s.mp4");
    const r = await exportVideo(SCENARIO_ID, p, { duration: 2, scale: 1 });
    const sz = fileBytes(p);
    const ok = existsSync(p) && sz > 1000; // mp4 must have meaningful data
    test("5. MP4 video export — non-empty file", ok,
         `size=${sz} frames=${r.frames} duration=${r.duration_sec}s`);
  }

} finally {
  // Clean up scenario.
  deleteScenario(SCENARIO_ID);
}

// ---- Summary ----
console.log("\n--- Summary ---");
const passed = results.filter(r => r.pass === true).length;
const failed = results.filter(r => r.pass === false).length;
const skipped = results.filter(r => r.pass === null).length;
console.log(`PASS: ${passed}  FAIL: ${failed}  SKIP: ${skipped}`);
if (!hasFfmpeg) {
  console.log("NOTE: ffmpeg absent — install for full coverage (brew install ffmpeg)");
}
if (failed > 0) process.exit(1);
