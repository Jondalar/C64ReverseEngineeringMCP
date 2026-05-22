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

// Spec 405 / OQ-405-3 — VSF module write order. Doc anchor:
// docs/vice-c64-arch.md §10.1. VICE cite: src/c64/c64-snapshot.c:76-91
// `c64_snapshot_write` writes modules in this exact sequence:
//   MAINCPU → C64 → CIA1 → CIA2 → SID → DRIVE → FSDRIVE → VICII →
//   C64GLUE → EVENT → MEMHACKS → TAPEPORT → KEYBOARD → JOYPORT_1 →
//   JOYPORT_2 → USERPORT.
//
// Note SID is BEFORE VICII (not after as in pre-spec-405 order).
// IEC state is embedded in the DRIVE chunk (= VIC drive
// subsystem owns the IEC bus serializer; we keep it as a sibling
// module here since our DRIVE chunk has its own VSF layout).
// FSDRIVE, C64GLUE, EVENT, MEMHACKS, TAPEPORT, JOYPORT_*, USERPORT
// have no in-scope game requirement and are not serialized; the
// resulting VSF is a strict subset of VICE's module list.
//
// Load (`loadSessionVsf`) dispatches via a switch and is therefore
// order-independent, but `saveSessionVsf` MUST emit in the VICE
// order so the bytes round-trip 1:1 with VICE-produced VSFs.
export function saveSessionVsf(session: IntegratedSession, outputPath: string): SessionVsfSaveResult {
  const writer = new VsfWriter(VSF_MACHINE_C64);
  const modules: string[] = [];

  // 1. MAINCPU (c64-snapshot.c:76).
  writer.addModule(VSF_MODULE_MAINCPU, serializeCpu(session.c64Cpu as any),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_MAINCPU);
  // 2. C64 (= C64MEM RAM + PLA latch; c64-snapshot.c:77).
  writer.addModule(VSF_MODULE_C64MEM, serializeC64Mem(session.c64Bus),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_C64MEM);
  // 3. CIA1 (c64-snapshot.c:78).
  writer.addModule(VSF_MODULE_CIA1, serializeCia(session.cia1),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_CIA1);
  // 4. CIA2 (c64-snapshot.c:79).
  writer.addModule(VSF_MODULE_CIA2, serializeCia(session.cia2),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_CIA2);
  // 5. SID (c64-snapshot.c:80) — BEFORE VICII.
  writer.addModule(VSF_MODULE_SID, serializeSid(session.sid),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_SID);
  // 6. DRIVE (c64-snapshot.c:81) — drive_snapshot_write_module emits
  //    DRIVECPU + DRIVERAM + VIA1d1541 + VIA2d1541 + GCR head state.
  //    We split into named sibling chunks for round-trip clarity;
  //    the wire-order stays grouped under "DRIVE".
  // Spec 704 §11 R3 — vice drive snapshot as a single opaque module.
  // facade.snapshot() is a stub (empty) until Spec 611.8 wires the host
  // snapshot_t; until then VSF does not capture drive state. The legacy
  // 5-module split (DRIVECPU/DRIVERAM/VIA1/VIA2/GCRHEAD) is retired.
  const driveBlob = (session.kernel.drive1541 as { snapshot?(): Uint8Array }).snapshot?.() ?? new Uint8Array(0);
  writer.addModule(VSF_MODULE_DRIVECPU, driveBlob);
  modules.push(VSF_MODULE_DRIVECPU);
  // 6b. IEC bus (= part of DRIVE chunk in VICE per OQ-405-3 note —
  //     "IEC state is embedded in DRIVE chunk, not a top-level module"
  //     — we keep it grouped with DRIVE here for the same reason).
  writer.addModule(VSF_MODULE_IEC, serializeIecBus(session.iecBus));
  modules.push(VSF_MODULE_IEC);
  // 7. FSDRIVE (c64-snapshot.c:82) — not modeled, skip.
  // 8. VICII (c64-snapshot.c:83).
  writer.addModule(VSF_MODULE_VICII, serializeVicII(session.vic),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_VICII);
  // 9. C64GLUE (c64-snapshot.c:84) — not modeled (HMOS discrete default
  //    has no observable state beyond config index, already in C64MEM).
  // 10. EVENT (c64-snapshot.c:85) — recording subsystem, not modeled.
  // 11. MEMHACKS (c64-snapshot.c:86) — REU/cart extensions, not modeled.
  // 12. TAPEPORT (c64-snapshot.c:87) — datasette deferred per OQ-405-1
  //     ("not implemented — no in-scope game requires it; deferred to
  //     post-arch-port spec").
  // 13. KEYBOARD (c64-snapshot.c:88).
  writer.addModule(VSF_MODULE_KEYBOARD, serializeKeyboard(session.keyboard),
    VSF_HL_MODULE_VERSION_MAJOR, VSF_HL_MODULE_VERSION_MINOR);
  modules.push(VSF_MODULE_KEYBOARD);
  // 14. JOYPORT_1 (c64-snapshot.c:89) — not modeled.
  // 15. JOYPORT_2 (c64-snapshot.c:90) — not modeled.
  // 16. USERPORT (c64-snapshot.c:91) — not modeled.

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
          // Spec 704 §11 R3 — vice drive opaque restore (stub until 611.8).
          // Legacy DRIVERAM/VIA1/VIA2/GCRHEAD modules are retired; old
          // snapshots carrying them fall through to default (ignored).
          (session.kernel.drive1541 as { restore?(b: Uint8Array): void }).restore?.(mod.data);
          result.loadedModules.push(mod.name); break;
        case VSF_MODULE_IEC:
          deserializeIecBus(session.iecBus, mod.data);
          result.loadedModules.push(mod.name); break;
        default:
          result.ignoredModules.push(mod.name);
      }
    } catch (e) {
      result.errors.push({ module: mod.name, error: (e as Error).message });
    }
  }

  // Spec 414 — Phase H step 34 + §14 invariant 10:
  //   "Snapshot restore is consistent — drive clock and alarm-clocks
  //    are both absolute and restored as a coherent set."
  //
  // The drive's `lastSyncC64Clk` baseline is internal bookkeeping
  // (= where the host-clock cursor sat when the last `executeToClock`
  // returned). It is NOT a VICE module field — VICE keeps the same
  // information as `cpu->last_clk` inside `drivecpu_context_t` and
  // serialises it through `drivecpu_snapshot_write_module`
  // (drivecpu.c:582-593). Our HL-VSF layout collapses that into the
  // pair (`session.c64Cpu.cycles`, `session.drive.cpu.cycles`) +
  // a derived sync baseline.
  //
  // Without this re-arm, post-restore `executeToClock(c64Clk)` would
  // early-return for every host cycle until the C64 clock caught up
  // to the pre-restore drive baseline (= "alarms fire instantly or
  // never" failure mode called out in §14 invariant 10).
  //
  // Re-arm strategy = `drive.enable(currentHostClk)`:
  //   - sets `enabled = true` (no-op if already on),
  //   - resets `lastSyncC64Clk = c64Cpu.cycles` (= cpu->stop_clk per
  //     drive.c:514),
  //   - clears `sleeping` (= drivecpu_wake_up per drive.c:520).
  //
  // This is the same invocation `mountMedia` makes and matches VICE
  // `drive_enable` semantics (drive.c:482-529). The drive's own
  // alarms (VIA1/VIA2 T1/T2/SR) are re-armed lazily by the next VIA
  // register write (= viacore alarm_set, see via6522-vice.ts:544 etc.)
  // — they're not persisted in the HL-VSF VIA module today (only the
  // visible register state is, per OQ-414-2 doc §11 footnote: full
  // 1:1 alarm absolute-clock persistence is a follow-up).
  //
  // Doc: docs/vice-1541-arch.md §13 Phase H step 34, §14 invariant 10,
  //      §17 OQ-414-2.
  // VICE: src/drive/drivecpu.c:582-593 (last_clk in DRIVECPU module),
  //       src/drive/drive.c:514 (cpu->stop_clk = *clk_ptr),
  //       src/core/viacore.c viacore_snapshot_module_read (alarm_set
  //         on restore with absolute clock).
  // Spec 704 §11 R3 — vice drive re-arm is handled inside
  // drive1541.restore; legacy session.drive.enable removed.

  return result;
}
