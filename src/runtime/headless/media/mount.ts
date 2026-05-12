// Spec 265 — media mount / unmount / swap for drive slots.
//
// Supports:
//   .d64 / .g64 → disk image mount to drive slot 8 or 9
//   .prg        → PRG file (non-drive, informational only)
//   .crt        → cartridge — mapper type auto-detected via cartridge.ts
//   .vsf        → snapshot restore via Spec 251 loadSessionVsf
//
// Tape (.t64 / .tap) is deferred to V3.1.

import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { IntegratedSession } from "../integrated-session.js";
import { loadCartridgeMapper } from "../cartridge.js";
import type { HeadlessCartridgeMapperType } from "../types.js";
import { addRecent } from "./recent-files.js";
import type { MediaType } from "./fs-browser.js";
import { createNoDiskParser } from "../disk/no-disk-parser.js";

export type DriveSlot = 8 | 9;

export interface MountResult {
  slot?: DriveSlot;
  mountedPath: string;
  type: MediaType | "crt" | "vsf" | "prg";
  mapperType?: HeadlessCartridgeMapperType;
  sectors?: number;
  errors?: string[];
}

function extToType(ext: string): MediaType | undefined {
  switch (ext) {
    case ".d64": return "d64";
    case ".g64": return "g64";
    case ".crt": return "crt";
    case ".prg": return "prg";
    case ".vsf": return "vsf";
    case ".t64": return "t64";
    case ".tap": return "tap";
    default: return undefined;
  }
}

/**
 * Mount a disk image (.d64 / .g64) to the given drive slot on session.
 *
 * The hot-swap is accomplished by replacing the session's DiskProvider
 * and reloading the TrackBuffer from the new image. This preserves all
 * other session state (CPU, memory, IEC, etc.) — matching the "eject +
 * insert" behaviour of a real 1541.
 *
 * For .crt and .vsf we detect the type and return info but do NOT wire
 * them to the live session (that requires a session restart / VSF load
 * path, which the caller can invoke separately).
 */
export async function mountMedia(
  session: IntegratedSession,
  slot: DriveSlot,
  path: string,
): Promise<MountResult> {
  if (!existsSync(path)) {
    return { slot, mountedPath: path, type: "d64", errors: [`file not found: ${path}`] };
  }

  const ext = extname(path).toLowerCase();
  const mediaType = extToType(ext);
  if (!mediaType) {
    return { slot, mountedPath: path, type: "d64", errors: [`unsupported extension: ${ext}`] };
  }

  if (mediaType === "t64" || mediaType === "tap") {
    return { slot, mountedPath: path, type: mediaType, errors: ["tape media deferred to V3.1"] };
  }

  // .crt — detect mapper type, return info only (session requires restart).
  if (mediaType === "crt") {
    let mapperType: HeadlessCartridgeMapperType | undefined;
    const errors: string[] = [];
    try {
      const mapper = loadCartridgeMapper(path);
      mapperType = mapper.getMapperType();
    } catch (e) {
      errors.push(`cartridge parse error: ${(e as Error).message}`);
    }
    addRecent(path, "crt");
    return { slot, mountedPath: path, type: "crt", mapperType, errors: errors.length ? errors : undefined };
  }

  // .vsf — load snapshot. Requires the session VSF loader (Spec 251).
  if (mediaType === "vsf") {
    const errors: string[] = [];
    try {
      const { loadSessionVsf } = await import("../vsf/session-vsf.js");
      loadSessionVsf(session, path);
      addRecent(path, "vsf");
    } catch (e) {
      errors.push(`VSF load error: ${(e as Error).message}`);
    }
    return { mountedPath: path, type: "vsf", errors: errors.length ? errors : undefined };
  }

  // .prg — load into RAM at header address (if session is live).
  if (mediaType === "prg") {
    const errors: string[] = [];
    try {
      session.loadPrgIntoRam(path);
      addRecent(path, "prg");
    } catch (e) {
      errors.push(`PRG load error: ${(e as Error).message}`);
    }
    return { slot, mountedPath: path, type: "prg", errors: errors.length ? errors : undefined };
  }

  // .d64 / .g64 — hot-swap disk image in drive slot 8 (only slot 8
  // is wired today; slot 9 records the intent but defers actual wiring
  // per the Spec 115 v1 multi-drive shape note in integrated-session.ts).
  const errors: string[] = [];
  let sectors: number | undefined;

  if (slot !== 8) {
    errors.push(`drive slot ${slot} declared but not yet wired (Spec 115 v1); disk registered only`);
    addRecent(path, mediaType);
    return { slot, mountedPath: path, type: mediaType, sectors, errors };
  }

  try {
    // Replace the DiskProvider and reload the TrackBuffer/parser.
    // IntegratedSession.diskPath is readonly but the underlying kernel
    // fields (trackBuffer, parser, diskProvider) accept hot replacement
    // for exactly this use case.
    const { DiskProvider } = await import("../providers.js");
    const { G64Parser } = await import("../../../disk/g64-parser.js");
    const { buildG64 } = await import("../../../disk/g64-builder.js");
    const { readFileSync } = await import("node:fs");

    const newProvider = DiskProvider.fromImagePath(path);
    const files = newProvider.listFiles();
    sectors = files.length;

    // Reload G64/D64 data into the shared TrackBuffer.
    let rawData: Uint8Array = new Uint8Array(readFileSync(path));
    // D64 images need to be pre-encoded to G64 byte stream (same as kernel build).
    if (mediaType === "d64") {
      rawData = buildG64({ d64: rawData });
    }
    const newParser = new G64Parser(rawData);

    // Disk-insert event. Real-HW: door switch closed + media inserted
    // → drive's read amplifier sees fresh GCR stream → all in-flight
    // bit-stream state and any drive-side caches drop. Drive head does
    // NOT move (= 1541 is peripheral, drive position preserved).
    //
    // Each component owning a parser-ref or track-cache exposes a
    // notifyMediaChange(newParser) hook that handles its own state
    // reset. Keeps the data-path hookups encapsulated and makes
    // multi-disk-title swaps clean.
    session.trackBuffer.notifyMediaChange(newParser);
    if (session.drive.trackBuffer
        && session.drive.trackBuffer !== session.trackBuffer) {
      session.drive.trackBuffer.notifyMediaChange(newParser);
    }
    session.gcrShifter?.notifyMediaChange(newParser);
    // HeadPosition cap = constructed from initial parser's
    // halfTrackCount (kernel.ts:168-172). NoDisk parser → 0 → fallback
    // 35 tracks. motm.g64 has 37 tracks (extended for copy protection),
    // so without re-cap the head can't reach tracks 36/37 after a
    // mount-swap → fastloader read failures → retry loop. Update cap
    // to match new image. Mirrors what kernel ctor does on direct boot.
    const newHalfTrackCount = newParser.getHalfTrackCount();
    if (newHalfTrackCount > 0) {
      session.headPosition.setMaxHalfTracks(newHalfTrackCount);
    }
    // VICE drive_image_attach: set attach_clk = current cpu cycle.
    // Drive sees no-sync + neutral data for DRIVE_ATTACH_DELAY cycles
    // (~1.8 sec PAL), letting drive ROM settle without abrupt
    // bit-stream transition. Mirrors real HW media-insert physics.
    session.gcrShifter?.notifyAttach(session.c64Cpu.cycles);

    // Spec 414 — Phase H step 32: re-arm drive enable after image
    // (re-)attach. VICE `drive_enable()` (drive.c:482-529) does:
    // (a) check `Drive%uTrueEmulation` resource — TS always-on,
    // (b) `drive_image_attach` for each populated slot — done above
    //     via parser swap + headPosition cap update,
    // (c) `cpu->stop_clk = *clk_ptr` — done by enable() via
    //     setSyncBaseline,
    // (d) `drivecpu_wake_up()` — done by enable() via wakeUp(),
    // (e) UI update — no-op in headless.
    // Idempotent: enable() on an already-enabled drive only resyncs
    // the baseline + clears sleep, both of which are correct after
    // a media swap.
    //
    // Doc: docs/vice-1541-arch.md §2.4 (image attach), §13 Phase H
    //      step 32, §17 OQ-414-1.
    // VICE: src/drive/drive.c:482-529 `drive_enable`.
    session.drive.enable(session.c64Cpu.cycles);

    // Update the kernel's diskProvider so KERNAL file traps see new files.
    (session as unknown as { diskProvider: unknown }).diskProvider = newProvider;
    (session.kernel as unknown as { diskProvider: unknown }).diskProvider = newProvider;
    (session.kernalFileIo as unknown as { diskProvider?: unknown }).diskProvider = newProvider;
    // Update parser aliases on session + kernel. Currently dead aliases
    // (no consumer outside ctor) but kept consistent with direct-boot
    // path so future readers see the live image, not the NoDisk sentinel.
    (session.kernel as unknown as { parser: unknown }).parser = newParser;
    (session as unknown as { parser: unknown }).parser = newParser;
    session.diskPath = path;

    addRecent(path, mediaType);
  } catch (e) {
    errors.push(`disk mount error: ${(e as Error).message}`);
  }

  return { slot, mountedPath: path, type: mediaType, sectors, errors: errors.length ? errors : undefined };
}

/** Eject (clear) the disk in the given drive slot.
 *
 * Spec 414 — note: detach does NOT call `drive.disable()`. Per VICE
 * (`drive_image_detach`, driveimage.c:230) image detach only:
 *   - writes back GCR/P64 if dirty,
 *   - sets `detach_clk` for the WPS pulse window,
 *   - clears `image` and `GCR_image_loaded`.
 * The drive remains enabled; the CPU keeps running its ROM and the
 * IEC bus continues to be serviced. Only the TrueEmulation resource
 * toggle calls `drive_disable()` (drive.c:531-560). Doc §13 Phase H
 * step 32, §17 OQ-414-1.
 */
export function unmountMedia(
  session: IntegratedSession,
  slot: DriveSlot,
): { slot: DriveSlot; ejected: boolean } {
  // VICE drive_image_detach: set detach_clk + swap to no-disk parser.
  // Drive sees no-sync + neutral for DRIVE_DETACH_DELAY (~600K cycles).
  // Track data freed; head position preserved.
  const empty = createNoDiskParser();
  session.trackBuffer.notifyMediaChange(empty);
  if (session.drive.trackBuffer
      && session.drive.trackBuffer !== session.trackBuffer) {
    session.drive.trackBuffer.notifyMediaChange(empty);
  }
  session.gcrShifter?.notifyMediaChange(empty);
  session.gcrShifter?.notifyDetach(session.c64Cpu.cycles);
  session.diskPath = "";
  return { slot, ejected: true };
}

/**
 * Swap the disk in slot — eject + mount the new path, no session reset.
 * Equivalent to the real-HW multi-disk side-swap ("swap to Side B").
 */
export async function swapDisk(
  session: IntegratedSession,
  slot: DriveSlot,
  newPath: string,
): Promise<MountResult> {
  unmountMedia(session, slot);
  return mountMedia(session, slot, newPath);
}
