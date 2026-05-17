// Spec 611 phase 611.3 — VICE1541 ROM loader.
//
// Reads the same 16 KB 1541 DOS ROM file as LEGACY1541's drive-rom.ts,
// but does NOT import any code from `src/runtime/headless/drive/**`
// (cross-implementation layering). The ROM bytes are platform data,
// not behaviour code — sharing the file at the filesystem layer is
// allowed; sharing the loader code is not.
//
// Resolution order (mirrors VICE1541's standalone need):
//   1. C64RE_1541_ROM_PATH env-var (user-supplied)
//   2. resources/roms/dos1541-325302-01+901229-05.bin (bundled)
//   3. zero-fill (16 KB of $00) — purely so phases prior to 611.3's
//      drivecpu bring-up don't crash on a missing ROM; with zero-fill
//      the drive 6502 reset vector ($FFFC/$FFFD) reads $0000 and the
//      drive will not boot, which is the correct failure mode.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Size of the 1541 DOS ROM (16 KB, mapped at $C000-$FFFF). */
export const VICE1541_ROM_SIZE = 0x4000;
/** Drive-side address where the ROM appears. */
export const VICE1541_ROM_BASE = 0xc000;
/** Bundled ROM filename — same bytes as LEGACY1541 uses. */
export const VICE1541_BUNDLED_ROM_FILENAME =
  "dos1541-325302-01+901229-05.bin";

export interface Vice1541LoadedRom {
  bytes: Uint8Array; // length = VICE1541_ROM_SIZE
  source: "env" | "bundled" | "zero-fill";
  path?: string;
}

function repoRoot(): string {
  // src/runtime/headless/vice1541/drive-rom-loader.ts is 4 levels
  // deep from repo root (same as the compiled dist/.../*.js path).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

export function vice1541BundledRomPath(): string {
  return resolve(
    repoRoot(),
    "resources",
    "roms",
    VICE1541_BUNDLED_ROM_FILENAME,
  );
}

function readRomFile(path: string): Uint8Array {
  const raw = readFileSync(path);
  if (raw.length === VICE1541_ROM_SIZE) {
    return new Uint8Array(raw);
  }
  if (raw.length > VICE1541_ROM_SIZE) {
    // Some VICE bundles ship a 32 KB combined image. Use the upper
    // half ($4000..$7FFF in file = $C000..$FFFF in drive memory) per
    // the bundled filename's split-ROM convention.
    return new Uint8Array(raw.slice(raw.length - VICE1541_ROM_SIZE));
  }
  // Smaller than expected — pad with $00. Drive will likely fail to
  // boot, which is the correct failure mode.
  const out = new Uint8Array(VICE1541_ROM_SIZE);
  out.set(raw, 0);
  return out;
}

export function loadVice1541Rom(): Vice1541LoadedRom {
  const envPath = process.env.C64RE_1541_ROM_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    return { bytes: readRomFile(envPath), source: "env", path: envPath };
  }
  const bundled = vice1541BundledRomPath();
  if (existsSync(bundled)) {
    return { bytes: readRomFile(bundled), source: "bundled", path: bundled };
  }
  return {
    bytes: new Uint8Array(VICE1541_ROM_SIZE),
    source: "zero-fill",
  };
}
