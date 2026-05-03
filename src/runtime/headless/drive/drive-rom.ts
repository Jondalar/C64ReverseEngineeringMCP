// 1541 DOS ROM loader.
//
// Resolution order:
//   1. C64RE_1541_ROM_PATH env-var → user-supplied ROM path
//   2. resources/roms/dos1541-325302-01+901229-05.bin (bundled per Spec 062 Q1.α)
//   3. zero-fill (Sprint 60 fallback — no ROM-dependent code path is
//      exercised in the synthetic test; Sprint 61+ will require a ROM
//      to run KERNAL serial sequences through CommodoreDOS)
//
// ROM size: 16384 bytes ($C000-$FFFF in drive address space).

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DRIVE_ROM_SIZE = 0x4000;
export const DRIVE_ROM_BASE = 0xc000;

export const BUNDLED_ROM_FILENAME = "dos1541-325302-01+901229-05.bin";

export interface LoadedDriveRom {
  bytes: Uint8Array;
  source: "env" | "bundled" | "zero-fill";
  path?: string;
}

function repoRoot(): string {
  // src/runtime/headless/drive/drive-rom.ts is 4 levels deep from repo root
  // when compiled to dist/runtime/headless/drive/drive-rom.js — same depth.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}

export function bundledRomPath(): string {
  return resolve(repoRoot(), "resources", "roms", BUNDLED_ROM_FILENAME);
}

export function loadDriveRom(): LoadedDriveRom {
  const envPath = process.env.C64RE_1541_ROM_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    const bytes = readFileSync(envPath);
    if (bytes.length !== DRIVE_ROM_SIZE) {
      throw new Error(`ROM at ${envPath} must be ${DRIVE_ROM_SIZE} bytes; got ${bytes.length}.`);
    }
    return { bytes, source: "env", path: envPath };
  }
  const bundled = bundledRomPath();
  if (existsSync(bundled)) {
    const bytes = readFileSync(bundled);
    if (bytes.length !== DRIVE_ROM_SIZE) {
      throw new Error(`Bundled ROM at ${bundled} must be ${DRIVE_ROM_SIZE} bytes; got ${bytes.length}.`);
    }
    return { bytes, source: "bundled", path: bundled };
  }
  // Sprint 60 fallback: zero-fill so drive can boot in isolation tests
  // that don't touch ROM. Sprint 61+ will fail loudly if ROM is missing.
  return { bytes: new Uint8Array(DRIVE_ROM_SIZE), source: "zero-fill" };
}
