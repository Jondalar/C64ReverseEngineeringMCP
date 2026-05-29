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

    // Spec 615 P0 (Pawn copy protection): the legacy DiskProvider runs a
    // CBM-DOS validation pass (BAM read, dir walk) that rejects disks
    // with intentionally bad BAM/header bytes — exactly the copy-
    // protection trick on `the_pawn_s1.g64`. Real VICE doesn't reject
    // those: the drive ROM reads raw GCR bits and the DOS code itself
    // decides what to do. In vice-mode the legacy provider is bridge-
    // only metadata (sector count, file list for KERNAL traps); a parse
    // failure must NOT block the vice1541 attachDisk path that drives
    // the actual emulation.
    // Spec 723.6b: VICE1541 is the only drive, so a legacy-provider parse
    // failure is always non-fatal (it is bridge-only metadata).
    let newProvider: ReturnType<typeof DiskProvider.fromImagePath> | null = null;
    try {
      newProvider = DiskProvider.fromImagePath(path);
      const files = newProvider.listFiles();
      sectors = files.length;
    } catch (e) {
      errors.push(`legacy disk parse warning (non-fatal): ${(e as Error).message}`);
    }

    // Reload G64/D64 data into the shared TrackBuffer.
    const originalBytes: Uint8Array = new Uint8Array(readFileSync(path));
    let rawData: Uint8Array = originalBytes;
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
    // Spec 704 §11 R3 — legacy disk-attach removed (trackBuffer /
    // gcrShifter notifyMediaChange/notifyAttach, headPosition cap,
    // drive.enable). VICE1541 owns image + head geometry; the disk is
    // attached to the vice drive via drive1541.attachDisk below, which
    // re-points the head to the current half-track. Per VICE
    // drive_image_attach, mount does NOT reset the drive CPU.

    // Spec 723.6b — attach the disk to the VICE1541 facade so the
    // DD00/pushFlush bridge serves real LOAD scenarios. (Was the Spec 611
    // dual-attach guarded on drive1541="vice"; vice is now the only drive.)
    const kernelAny = session.kernel as unknown as {
      drive1541?: {
        attachDisk?: (m: { kind: "d64" | "g64" | "p64"; bytes: Uint8Array; readOnly: boolean }) => void;
        reset?: (kind: "cold" | "warm") => void;
      };
    };
    if (
      kernelAny.drive1541
      && typeof kernelAny.drive1541.attachDisk === "function"
      && (mediaType === "d64" || mediaType === "g64")
    ) {
      kernelAny.drive1541.attachDisk({
        kind: mediaType,
        bytes: originalBytes, // pre-buildG64; vice does its own encode for d64
        readOnly: false,
      });
      // MOUNT MUST NOT RESET THE DRIVE (user directive 2026-05-21).
      // On real hardware inserting/swapping a disk does NOT reset the 1541 —
      // the drive 6502 keeps running its current code (DOS idle loop, OR a
      // custom $DD00 fastloader's uploaded routine). Resetting on mount:
      //   (a) destroys in-flight loader state → you could never swap disks
      //       under an active DD00 loader, and
      //   (b) reset the drive clock baseline (last_clk → 0) while the C64
      //       clock was at ~7M, so the next catchUpTo() ran ~7M drive cycles
      //       of the DOS idle loop in one tick → a 4.5s UI freeze.
      // VICE's drive_image_attach likewise does not reset the drive CPU; it
      // only re-points the head to the current (mechanically unchanged)
      // half-track, which facade.attachDisk already does. The ONLY cold
      // reset is the explicit Drive-Power button (session/drive_power).
    }

    // Update the kernel's diskProvider so KERNAL file traps see new files.
    // Guard: newProvider may be null if the legacy parser rejected the
    // image in vice mode (copy-protection BAM). In vice mode the drive
    // ROM serves LOAD directly via IEC, not the KERNAL trap, so a null
    // provider is functionally harmless — keep previous slot value.
    if (newProvider !== null) {
      (session as unknown as { diskProvider: unknown }).diskProvider = newProvider;
      (session.kernel as unknown as { diskProvider: unknown }).diskProvider = newProvider;
      // Spec 723.3c: KERNAL fileio-trap state removed; no trap diskProvider to wire.
    }
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
  // Spec 704 §11 R3 / 723.6b — vice detach: drive1541.detachDisk writes
  // back any dirty GCR + sets the WPS detach window (VICE
  // drive_image_detach). VICE1541 is the only drive.
  const kernelAny = session.kernel as unknown as {
    drive1541?: { detachDisk?: () => void };
  };
  if (kernelAny.drive1541?.detachDisk) {
    kernelAny.drive1541.detachDisk();
  }
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
