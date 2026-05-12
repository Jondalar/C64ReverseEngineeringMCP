// C64 KERNAL / BASIC / CHARROM loader. Mirrors drive-rom.ts pattern.
//
// Resolution order per ROM:
//   1. ENV-VAR (C64RE_KERNAL_ROM_PATH / _BASIC_ROM_PATH / _CHARGEN_ROM_PATH)
//   2. Bundled file in resources/roms/
//   3. zero-fill (forces useReal=false at the call site)
//
// Per Spec 062 Sprint 65 — supports the integrated C64+drive session
// where real KERNAL serial routines bit-bang $DD00 to talk to the
// drive emulation across the iec-bus.

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const KERNAL_SIZE = 0x2000;     // 8KB at $E000-$FFFF
export const BASIC_SIZE = 0x2000;      // 8KB at $A000-$BFFF
export const CHARROM_SIZE = 0x1000;    // 4KB at $D000-$DFFF (when char banking active)

export const BUNDLED_KERNAL = "kernal-901227-03.bin";
export const BUNDLED_BASIC = "basic-901226-01.bin";
export const BUNDLED_CHARROM = "chargen-901225-01.bin";

export interface LoadedC64Rom {
  bytes: Uint8Array;
  source: "env" | "bundled" | "zero-fill";
  path?: string;
  filename: string;
  expectedSize: number;
}

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

function bundledPath(filename: string): string {
  return resolve(repoRoot(), "resources", "roms", filename);
}

function loadOne(envVar: string, filename: string, expectedSize: number): LoadedC64Rom {
  const envPath = process.env[envVar]?.trim();
  if (envPath && existsSync(envPath)) {
    const bytes = readFileSync(envPath);
    if (bytes.length !== expectedSize) {
      throw new Error(`${filename} at ${envPath} must be ${expectedSize} bytes; got ${bytes.length}.`);
    }
    return { bytes, source: "env", path: envPath, filename, expectedSize };
  }
  const bundled = bundledPath(filename);
  if (existsSync(bundled)) {
    const bytes = readFileSync(bundled);
    if (bytes.length !== expectedSize) {
      throw new Error(`Bundled ${filename} at ${bundled} must be ${expectedSize} bytes; got ${bytes.length}.`);
    }
    return { bytes, source: "bundled", path: bundled, filename, expectedSize };
  }
  return { bytes: new Uint8Array(expectedSize), source: "zero-fill", filename, expectedSize };
}

export function loadKernalRom(): LoadedC64Rom {
  return loadOne("C64RE_KERNAL_ROM_PATH", BUNDLED_KERNAL, KERNAL_SIZE);
}

export function loadBasicRom(): LoadedC64Rom {
  return loadOne("C64RE_BASIC_ROM_PATH", BUNDLED_BASIC, BASIC_SIZE);
}

export function loadCharRom(): LoadedC64Rom {
  return loadOne("C64RE_CHARGEN_ROM_PATH", BUNDLED_CHARROM, CHARROM_SIZE);
}

export interface LoadedC64RomSet {
  kernal: LoadedC64Rom;
  basic: LoadedC64Rom;
  charRom: LoadedC64Rom;
  allRomsAvailable: boolean;
}

export function loadAllC64Roms(): LoadedC64RomSet {
  const kernal = loadKernalRom();
  const basic = loadBasicRom();
  const charRom = loadCharRom();
  return {
    kernal, basic, charRom,
    allRomsAvailable: kernal.source !== "zero-fill" && basic.source !== "zero-fill" && charRom.source !== "zero-fill",
  };
}
