// VSF save / load for a standalone DriveSession.
//
// Spec 704 §11 R3 — vice-backed rebuild. The legacy 5-module drive snapshot
// (DRIVECPU/DRIVERAM/VIA1/VIA2/GCRHEAD) is retired; the standalone drive is a
// Vice1541Facade, so VSF carries a single opaque vice drive module
// (drive1541.snapshot()/restore()). That facade snapshot is a stub (empty)
// until Spec 611.8 wires the host snapshot_t — until then save/load is a
// no-op round-trip, but the format + plumbing are forward-compatible.

import { writeFileSync, readFileSync } from "node:fs";
import { VsfWriter, readVsf, VSF_MACHINE_C64 } from "./vsf-format.js";
import { VSF_MODULE_DRIVECPU } from "./module-mapping.js";
import type { DriveSessionRecord } from "../drive1541/drive-session-manager.js";

export interface VsfSaveResult {
  outputPath: string;
  bytesWritten: number;
  modules: string[];
}

export interface VsfLoadResult {
  inputPath: string;
  loadedModules: string[];
  ignoredModules: string[];
  errors: Array<{ module: string; error: string }>;
}

export function saveDriveSessionVsf(record: DriveSessionRecord, outputPath: string): VsfSaveResult {
  const writer = new VsfWriter(VSF_MACHINE_C64);
  writer.addModule(VSF_MODULE_DRIVECPU, record.drive.snapshot());
  const bytes = writer.toBytes();
  writeFileSync(outputPath, bytes);
  return { outputPath, bytesWritten: bytes.length, modules: [VSF_MODULE_DRIVECPU] };
}

export function loadDriveSessionVsf(record: DriveSessionRecord, inputPath: string): VsfLoadResult {
  const bytes = readFileSync(inputPath);
  const file = readVsf(bytes);
  const loadedModules: string[] = [];
  const ignoredModules: string[] = [];
  const errors: Array<{ module: string; error: string }> = [];
  for (const mod of file.modules) {
    if (mod.name !== VSF_MODULE_DRIVECPU) {
      ignoredModules.push(mod.name);
      continue;
    }
    try {
      record.drive.restore(mod.data);
      loadedModules.push(mod.name);
    } catch (e) {
      errors.push({ module: mod.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { inputPath, loadedModules, ignoredModules, errors };
}
