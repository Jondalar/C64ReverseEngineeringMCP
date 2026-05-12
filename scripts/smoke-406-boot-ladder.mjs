#!/usr/bin/env node
// Spec 406 — C64 Phase F: 4-stage boot ladder smoke.
//
// Doctrine: 1:1 VICE x64sc port. Phase F step 28 says "Boot real
// software: bare KERNAL boot, READY prompt, LOAD"$",8, LIST. Then a
// demo or game. Then a fastloader."
//
// Doc anchor: docs/vice-c64-arch.md §12 Phase F step 28.
// VICE source: vice/src/c64/c64.c:c64_machine_init() (cold reset path)
//              vice/src/kernal/kernal.s (boot ROM that prints READY)
//
// OQ-406-3 resolution (2026-05-11): per-stage golden master = PNG hash
// + screen RAM hash. Reference vorlage for cold boot:
//   samples/golden-master/c64-boot-ready.png
// Other stages captured + frozen on first green run.
//
// 4 stages (Spec 406 Producer §3):
//   1. cold reset → READY                  — bare KERNAL, no disk.
//   2. LOAD"$",8                           — synth blank disk; expect
//                                            "SEARCHING FOR $" + LOAD
//                                            completes to READY.
//   3. LOAD"*",8,1 on MM s1 g64            — title screen.
//   4. LOAD"*",8,1 on Scramble Infinity    — title screen.
//
// Hash policy: golden file exists → must match (FAIL on mismatch).
// Golden file missing → capture + freeze (= write the golden, print
// "FROZEN", succeed). Re-run after freeze must match.
//
// Usage:
//   node scripts/smoke-406-boot-ladder.mjs [--update-goldens]

import { resolve as resolvePath, join, dirname } from "node:path";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";

// Decode PNG → raw RGBA pixel buffer. PNG file byte hashes are
// brittle (compression / chunk-ordering differences) — hash the
// decoded pixels instead so the comparison is content-only.
function decodePngRgba(bytes) {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, rgba: Uint8Array.from(png.data) };
}
function pngContentHash(bytes) {
  const { width, height, rgba } = decodePngRgba(bytes);
  const h = createHash("sha256");
  // Hash a small header (w/h) then raw RGBA. Content-only.
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32LE(width, 0);
  hdr.writeUInt32LE(height, 4);
  h.update(hdr);
  h.update(rgba);
  return h.digest("hex");
}

const args = process.argv.slice(2);
function flag(name) { return args.includes(`--${name}`); }

const updateGoldens = flag("update-goldens");
const verbose = flag("verbose");

const repoRoot = resolvePath(import.meta.dirname, "..");
const goldenDir = resolvePath(repoRoot, "samples/golden-master");
if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });

const { startIntegratedSession } = await import(
  `${repoRoot}/dist/runtime/headless/integrated-session-manager.js`
);

const STAGES = [
  {
    id: "cold-reset-ready",
    disk: "samples/synthetic/blank.d64",       // any disk; cold reset never touches it.
    type: "",                                  // no input; bare boot.
    bootCycles: 2_000_000,                     // 2s = enough to reach READY.
    runCycles: 0,
    goldenPng: "c64-boot-ready.png",
    goldenRam: "c64-boot-ready.screenram.bin",
    description: "cold reset → READY prompt (bare KERNAL boot)",
  },
  {
    id: "load-dollar",
    disk: "samples/synthetic/blank.d64",       // synth blank disk for directory listing.
    type: 'LOAD"$",8\r',
    bootCycles: 2_000_000,
    runCycles: 8_000_000,                       // ~8s = disk dir LOAD time.
    goldenPng: "c64-boot-load-dollar.png",
    goldenRam: "c64-boot-load-dollar.screenram.bin",
    description: 'LOAD"$",8 → SEARCHING FOR $ → READY (directory loaded)',
  },
  {
    id: "load-star-mm",
    disk: "samples/maniac_mansion_s1[activision_1987](german)(manual)(!).g64",
    type: 'LOAD"*",8,1\r',
    bootCycles: 2_000_000,
    runCycles: 180_000_000,                     // MM title ~180M cycles per memo (mm-s1).
    goldenPng: "c64-boot-mm-title.png",
    goldenRam: "c64-boot-mm-title.screenram.bin",
    description: 'LOAD"*",8,1 on MM s1 → title screen',
  },
  {
    id: "load-star-scramble",
    disk: "samples/scramble_infinity.d64",
    type: 'LOAD"*",8,1\rRUN\r',
    bootCycles: 2_000_000,
    runCycles: 180_000_000,                     // Scramble title ~180M per memo.
    goldenPng: "c64-boot-scramble-title.png",
    goldenRam: "c64-boot-scramble-title.screenram.bin",
    description: 'LOAD"*",8,1 + RUN on Scramble → title screen',
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function captureScreenRam(session) {
  // Screen RAM = $0400..$07E7 (text mode default). For bitmap-mode
  // stages we still capture the same 1000-byte region — the bytes
  // there are deterministic per stage even when VIC is in bitmap
  // mode, so the hash is stable.
  const ram = session.c64Bus.ram;
  return Uint8Array.from(ram.subarray(0x0400, 0x0400 + 1000));
}

function runStage(stage) {
  const diskPath = resolvePath(repoRoot, stage.disk);
  if (!existsSync(diskPath)) {
    return { stage, status: "SKIP", reason: `disk missing: ${diskPath}` };
  }
  const { session } = startIntegratedSession({
    diskPath, mode: "true-drive", useMicrocodedCpu: true,
  });
  session.resetCold("pal-default");

  // Boot to READY.
  session.runFor(stage.bootCycles);

  // Type stage input (if any).
  if (stage.type) {
    session.typeText(stage.type, 80_000, 80_000);
  }

  // Run remaining cycles.
  if (stage.runCycles > 0) {
    const target = session.c64Cpu.cycles + stage.runCycles;
    while (session.c64Cpu.cycles < target) session.runFor(200_000);
  }

  // Capture PNG to a temp file → hash.
  const tmpPng = join(repoRoot, ".tmp-smoke-406", `${stage.id}.png`);
  ensureDir(tmpPng);
  session.renderToPng(tmpPng);
  const pngBytes = readFileSync(tmpPng);
  // pngContentHash hashes decoded RGBA, not file bytes — robust to
  // PNG re-encoding differences (compression level, chunk order).
  const pngHash = pngContentHash(pngBytes);

  const ramBytes = captureScreenRam(session);
  const ramHash = sha256(ramBytes);

  const goldenPngPath = join(goldenDir, stage.goldenPng);
  const goldenRamPath = join(goldenDir, stage.goldenRam);

  const result = {
    stage,
    pngHash,
    ramHash,
    pngPath: tmpPng,
    pngBytes,
    ramBytes,
    goldenPngPath,
    goldenRamPath,
    pc: `$${session.c64Cpu.pc.toString(16)}`,
    border: `$${(session.c64Bus.ram[0xd020] & 0x0f).toString(16)}`,
  };

  // Compare against goldens.
  let pngMatch = null;
  let ramMatch = null;

  if (existsSync(goldenPngPath)) {
    const goldenPngBytes = readFileSync(goldenPngPath);
    const goldenPngHash = pngContentHash(goldenPngBytes);
    pngMatch = goldenPngHash === pngHash;
    result.goldenPngHash = goldenPngHash;
  }
  if (existsSync(goldenRamPath)) {
    const goldenRamBytes = readFileSync(goldenRamPath);
    const goldenRamHash = sha256(goldenRamBytes);
    ramMatch = goldenRamHash === ramHash;
    result.goldenRamHash = goldenRamHash;
  }
  result.pngMatch = pngMatch;
  result.ramMatch = ramMatch;
  return result;
}

console.log(`smoke-406-boot-ladder (Spec 406 / docs/vice-c64-arch.md §12 step 28)`);
console.log(`  golden dir: ${goldenDir}`);
console.log(`  update-goldens: ${updateGoldens}\n`);

const results = [];
let pass = 0, fail = 0, frozen = 0, skipped = 0;

for (const stage of STAGES) {
  console.log(`=== Stage ${stage.id} — ${stage.description} ===`);
  let r;
  try {
    r = runStage(stage);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    fail += 1;
    results.push({ stage, status: "ERROR", error: e.message });
    continue;
  }

  if (r.status === "SKIP") {
    console.log(`  SKIP: ${r.reason}`);
    skipped += 1;
    results.push(r);
    continue;
  }

  console.log(`  PC: ${r.pc}  border: ${r.border}`);
  console.log(`  png  hash: ${r.pngHash}`);
  console.log(`  ram  hash: ${r.ramHash}`);

  const pngExists = existsSync(r.goldenPngPath);
  const ramExists = existsSync(r.goldenRamPath);

  // Freeze missing goldens automatically (per OQ-406-3: "captured on
  // first green run and frozen as golden masters"). --update-goldens
  // forces re-freeze of existing files.
  let pngStatus, ramStatus;
  if (!pngExists || updateGoldens) {
    writeFileSync(r.goldenPngPath, r.pngBytes);
    pngStatus = pngExists ? "REFROZEN" : "FROZEN";
    if (!pngExists) frozen += 1;
  } else {
    pngStatus = r.pngMatch ? "MATCH" : "MISMATCH";
  }
  if (!ramExists || updateGoldens) {
    writeFileSync(r.goldenRamPath, r.ramBytes);
    ramStatus = ramExists ? "REFROZEN" : "FROZEN";
  } else {
    ramStatus = r.ramMatch ? "MATCH" : "MISMATCH";
  }

  console.log(`  png  -> ${pngStatus}`);
  console.log(`  ram  -> ${ramStatus}`);

  const stageOk =
    (pngStatus === "MATCH" || pngStatus === "FROZEN" || pngStatus === "REFROZEN") &&
    (ramStatus === "MATCH" || ramStatus === "FROZEN" || ramStatus === "REFROZEN");

  if (stageOk) {
    pass += 1;
    results.push({ ...r, status: "PASS", pngStatus, ramStatus });
  } else {
    fail += 1;
    results.push({ ...r, status: "FAIL", pngStatus, ramStatus });
    if (verbose) {
      console.log(`    expected png hash: ${r.goldenPngHash}`);
      console.log(`    actual   png hash: ${r.pngHash}`);
      console.log(`    expected ram hash: ${r.goldenRamHash}`);
      console.log(`    actual   ram hash: ${r.ramHash}`);
    }
  }
  console.log("");
}

console.log(`=== Summary ===`);
console.log(`PASS:    ${pass}`);
console.log(`FAIL:    ${fail}`);
console.log(`FROZEN:  ${frozen}  (= goldens written on this run)`);
console.log(`SKIPPED: ${skipped}`);
console.log(`Total:   ${STAGES.length}`);

const ok = fail === 0;
console.log(`\nVerdict: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
