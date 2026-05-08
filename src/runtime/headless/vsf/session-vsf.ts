// Spec 251 — full IntegratedSession VSF save/load.
//
// Round-trip the C64-main subsystems (cpu, ram, cpu-port + capacitor,
// CIA1, CIA2, VIC-II, fastsid SID, KEYBOARD) plus the existing drive
// VSF modules. Result: HL → VSF → HL byte-equal for the modules we
// own.
//
// VICE 3.7+ format only (per Spec 251 OQ1). Older versions rejected
// at load time.

import { writeFileSync, readFileSync } from "node:fs";
import {
  VsfWriter, readVsf, VSF_MACHINE_C64,
  VSF_VERSION_MAJOR as FILE_VERSION_MAJOR,
} from "./vsf-format.js";
import {
  VSF_MODULE_MAINCPU, VSF_MODULE_C64MEM,
  VSF_MODULE_CIA1, VSF_MODULE_CIA2,
  VSF_MODULE_VICII, VSF_MODULE_SID, VSF_MODULE_KEYBOARD,
  VSF_MODULE_DRIVECPU, VSF_MODULE_DRIVERAM,
  VSF_MODULE_VIA1D1541, VSF_MODULE_VIA2D1541,
  VSF_MODULE_IEC, VSF_MODULE_GCRHEAD,
  VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR,
  serializeCpu, deserializeCpu,
  serializeC64Mem, deserializeC64Mem,
  serializeCia, deserializeCia,
  serializeVicII, deserializeVicII,
  serializeSid, deserializeSid,
  serializeKeyboard, deserializeKeyboard,
  serializeRam, deserializeRam,
  serializeVia, deserializeVia,
  serializeIecBus, deserializeIecBus,
  serializeGcrHead, deserializeGcrHead,
} from "./module-mapping.js";
import type { IntegratedSession } from "../integrated-session.js";

export interface SessionVsfSaveResult {
  outputPath: string;
  bytesWritten: number;
  modules: string[];
}

export interface SessionVsfLoadResult {
  inputPath: string;
  loadedModules: string[];
  ignoredModules: string[];
  errors: Array<{ module: string; error: string }>;
}

export function saveSessionVsf(session: IntegratedSession, outputPath: string): SessionVsfSaveResult {
  const writer = new VsfWriter(VSF_MACHINE_C64);
  const modules: string[] = [];

  // C64-main side (Spec 251 — newly added).
  writer.addModule(VSF_MODULE_MAINCPU, serializeCpu(session.c64Cpu as any),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_MAINCPU);
  writer.addModule(VSF_MODULE_C64MEM, serializeC64Mem(session.c64Bus),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_C64MEM);
  writer.addModule(VSF_MODULE_CIA1, serializeCia(session.cia1),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_CIA1);
  writer.addModule(VSF_MODULE_CIA2, serializeCia(session.cia2),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_CIA2);
  writer.addModule(VSF_MODULE_VICII, serializeVicII(session.vic),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_VICII);
  writer.addModule(VSF_MODULE_SID, serializeSid(session.sid),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_SID);
  writer.addModule(VSF_MODULE_KEYBOARD, serializeKeyboard(session.keyboard),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_KEYBOARD);

  // Drive side (existing).
  writer.addModule(VSF_MODULE_DRIVECPU, serializeCpu(session.drive.cpu as any));
  writer.addModule(VSF_MODULE_DRIVERAM, serializeRam(session.drive.bus.ram));
  writer.addModule(VSF_MODULE_VIA1D1541, serializeVia(session.drive.bus.via1));
  writer.addModule(VSF_MODULE_VIA2D1541, serializeVia(session.drive.bus.via2));
  writer.addModule(VSF_MODULE_IEC, serializeIecBus(session.iecBus));
  writer.addModule(VSF_MODULE_GCRHEAD, serializeGcrHead(session.headPosition, session.trackBuffer));
  modules.push(VSF_MODULE_DRIVECPU, VSF_MODULE_DRIVERAM,
    VSF_MODULE_VIA1D1541, VSF_MODULE_VIA2D1541,
    VSF_MODULE_IEC, VSF_MODULE_GCRHEAD);

  const bytes = writer.toBytes();
  writeFileSync(outputPath, bytes);
  return { outputPath, bytesWritten: bytes.length, modules };
}

export function loadSessionVsf(session: IntegratedSession, inputPath: string): SessionVsfLoadResult {
  const bytes = readFileSync(inputPath);
  const file = readVsf(new Uint8Array(bytes));

  // Spec 251 OQ1: VICE 3.7+ only. File-level version 2.0 = current
  // VICE 3.7. Reject older.
  if (file.versionMajor < FILE_VERSION_MAJOR) {
    throw new Error(`VSF version ${file.versionMajor}.${file.versionMinor} unsupported. VICE 3.7+ required.`);
  }
  if (file.machineName !== VSF_MACHINE_C64) {
    throw new Error(`VSF machine '${file.machineName}' unsupported. C64 only.`);
  }

  const result: SessionVsfLoadResult = {
    inputPath, loadedModules: [], ignoredModules: [], errors: [],
  };

  for (const mod of file.modules) {
    try {
      switch (mod.name) {
        case VSF_MODULE_MAINCPU:
          deserializeCpu(session.c64Cpu as any, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_C64MEM:
          deserializeC64Mem(session.c64Bus, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_CIA1:
          deserializeCia(session.cia1, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_CIA2:
          deserializeCia(session.cia2, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_VICII:
          deserializeVicII(session.vic, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_SID:
          deserializeSid(session.sid, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_KEYBOARD:
          deserializeKeyboard(session.keyboard, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_DRIVECPU:
          deserializeCpu(session.drive.cpu as any, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_DRIVERAM:
          deserializeRam(session.drive.bus.ram, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_VIA1D1541:
          deserializeVia(session.drive.bus.via1, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_VIA2D1541:
          deserializeVia(session.drive.bus.via2, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_IEC:
          deserializeIecBus(session.iecBus, mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_GCRHEAD:
          deserializeGcrHead(session.headPosition, session.trackBuffer, mod.data);
          result.loadedModules.push(mod.name); break;
        default:
          result.ignoredModules.push(mod.name);
      }
    } catch (e) {
      result.errors.push({ module: mod.name, error: (e as Error).message });
    }
  }
  return result;
}
