// VSF save / load for a DriveSession (Sprint 64).
//
// Saves all subsystems the drive owns. C64 RAM + MainCPU added when
// session-manager integration lands (deferred). On load, modules
// the runtime doesn't model (VIC, SID, CIA1, full CIA2, KEYBOARD,
// JOYSTICK, TAPE, EXPANSION) are skipped with a warning, per Spec
// 062 Sprint 64.

import { writeFileSync, readFileSync } from "node:fs";
import { VsfWriter, readVsf, VSF_MACHINE_C64 } from "./vsf-format.js";
import {
  VSF_MODULE_DRIVECPU, VSF_MODULE_DRIVERAM,
  VSF_MODULE_VIA1D1541, VSF_MODULE_VIA2D1541,
  VSF_MODULE_IEC, VSF_MODULE_GCRHEAD,
  serializeCpu, deserializeCpu,
  serializeVia, deserializeVia,
  serializeRam, deserializeRam,
  serializeIecBus, deserializeIecBus,
  serializeGcrHead, deserializeGcrHead,
} from "./module-mapping.js";
import type { DriveSessionRecord } from "../drive/drive-session-manager.js";

const KNOWN_OWNED_MODULES = new Set<string>([
  VSF_MODULE_DRIVECPU, VSF_MODULE_DRIVERAM,
  VSF_MODULE_VIA1D1541, VSF_MODULE_VIA2D1541,
  VSF_MODULE_IEC, VSF_MODULE_GCRHEAD,
]);

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
  const drive = record.session.drive;
  writer.addModule(VSF_MODULE_DRIVECPU, serializeCpu(drive.cpu as any));
  writer.addModule(VSF_MODULE_DRIVERAM, serializeRam(drive.bus.ram));
  writer.addModule(VSF_MODULE_VIA1D1541, serializeVia(drive.bus.via1));
  writer.addModule(VSF_MODULE_VIA2D1541, serializeVia(drive.bus.via2));
  writer.addModule(VSF_MODULE_IEC, serializeIecBus(record.session.iecBus));
  writer.addModule(VSF_MODULE_GCRHEAD, serializeGcrHead(record.headPosition, record.trackBuffer));
  const bytes = writer.toBytes();
  writeFileSync(outputPath, bytes);
  return {
    outputPath,
    bytesWritten: bytes.length,
    modules: [...KNOWN_OWNED_MODULES],
  };
}

export function loadDriveSessionVsf(record: DriveSessionRecord, inputPath: string): VsfLoadResult {
  const bytes = readFileSync(inputPath);
  const file = readVsf(bytes);
  const loadedModules: string[] = [];
  const ignoredModules: string[] = [];
  const errors: Array<{ module: string; error: string }> = [];
  const drive = record.session.drive;
  for (const mod of file.modules) {
    if (!KNOWN_OWNED_MODULES.has(mod.name)) {
      ignoredModules.push(mod.name);
      continue;
    }
    try {
      switch (mod.name) {
        case VSF_MODULE_DRIVECPU: deserializeCpu(drive.cpu as any, mod.data); break;
        case VSF_MODULE_DRIVERAM: deserializeRam(drive.bus.ram, mod.data); break;
        case VSF_MODULE_VIA1D1541: deserializeVia(drive.bus.via1, mod.data); break;
        case VSF_MODULE_VIA2D1541: deserializeVia(drive.bus.via2, mod.data); break;
        case VSF_MODULE_IEC: deserializeIecBus(record.session.iecBus, mod.data); break;
        case VSF_MODULE_GCRHEAD: deserializeGcrHead(record.headPosition, record.trackBuffer, mod.data); break;
      }
      loadedModules.push(mod.name);
    } catch (e) {
      errors.push({ module: mod.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { inputPath, loadedModules, ignoredModules, errors };
}
