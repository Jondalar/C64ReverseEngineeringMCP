#!/usr/bin/env node
// Spec 247 — Build bundled fingerprint library from ROM images.
//
// Reads KERNAL (resources/roms/kernal-901227-03.bin, $E000–$FFFF) and
// BASIC (resources/roms/basic-901226-01.bin, $A000–$BFFF) ROMs, auto-
// extracts routine fingerprints, and writes:
//   resources/fingerprints/bundled/kernal-c64.json
//   resources/fingerprints/bundled/basic-c64.json
//
// Usage:
//   node scripts/build-fingerprint-library.mjs [--verbose]
//   npm run build:fingerprints

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";

const repoRoot = resolvePath(import.meta.dirname, "..");
const verbose = process.argv.includes("--verbose");

// ---- Dynamic import from compiled dist ------------------------------------
let extractRoutinesFromRomFile;
try {
  ({ extractRoutinesFromRomFile } = await import(
    `${repoRoot}/dist/runtime/headless/v2/fingerprint-extractor.js`
  ));
} catch (e) {
  console.error("dist missing — run `npm run build:mcp` first");
  console.error(e?.message ?? e);
  process.exit(1);
}

// ---- Helpers --------------------------------------------------------------

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeLibrary(outPath, entries) {
  writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
  console.log(`  Wrote ${entries.length} entries → ${outPath}`);
}

// ---- Process a ROM --------------------------------------------------------

function processRom({ romPath, romName, baseAddr, outPath, version }) {
  if (!existsSync(romPath)) {
    console.warn(`  SKIP  ROM not found: ${romPath}`);
    return 0;
  }

  console.log(`\n  Extracting ${romName} from ${romPath}...`);
  const entries = extractRoutinesFromRomFile(romPath, romName, baseAddr, {
    minLength: 4,
    maxLength: 512,
    version,
  });

  if (verbose) {
    for (const e of entries) {
      console.log(`    $${e.entry.toString(16).toUpperCase().padStart(4,"0")}  ${e.length.toString().padStart(3)}B  ${e.name}`);
    }
  }

  writeLibrary(outPath, entries);
  return entries.length;
}

// ---- Main -----------------------------------------------------------------

const outDir = join(repoRoot, "resources/fingerprints/bundled");
ensureDir(outDir);

console.log("Spec 247 — Building bundled fingerprint library");

const kernalCount = processRom({
  romPath: join(repoRoot, "resources/roms/kernal-901227-03.bin"),
  romName: "kernal",
  baseAddr: 0xE000,
  outPath: join(outDir, "kernal-c64.json"),
  version: "C64 KERNAL 901227-03",
});

const basicCount = processRom({
  romPath: join(repoRoot, "resources/roms/basic-901226-01.bin"),
  romName: "basic",
  baseAddr: 0xA000,
  outPath: join(outDir, "basic-c64.json"),
  version: "C64 BASIC 901226-01",
});

console.log(`\nDone. KERNAL: ${kernalCount} routines, BASIC: ${basicCount} routines`);

// Acceptance check
if (kernalCount < 20) {
  console.error(`ERROR: expected ≥20 KERNAL routines, got ${kernalCount}`);
  process.exit(1);
}
if (basicCount < 5) {
  console.error(`ERROR: expected ≥5 BASIC routines, got ${basicCount}`);
  process.exit(1);
}

console.log("Acceptance: KERNAL ≥20 PASS, BASIC ≥5 PASS");
