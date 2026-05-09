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

    // Hot-swap the G64 parser inside the session's TrackBuffer.
    // TrackBuffer.source is declared `readonly` but we need to replace it
    // for disk-swap. We also clear the lazy-loaded tracks cache so the
    // new parser is consulted on next access. All drive-state (head
    // position, shifter, motor) is preserved — exactly "insert new disk".
    const tb = session.trackBuffer as unknown as {
      source: unknown;
      tracks: Map<number, unknown>;
    };
    tb.source = newParser;
    tb.tracks.clear();

    // Update the kernel's diskProvider so KERNAL file traps see new files.
    (session as unknown as { diskProvider: unknown }).diskProvider = newProvider;
    (session.kernel as unknown as { diskProvider: unknown }).diskProvider = newProvider;
    (session.kernalFileIo as unknown as { diskProvider?: unknown }).diskProvider = newProvider;
    session.diskPath = path;

    addRecent(path, mediaType);
  } catch (e) {
    errors.push(`disk mount error: ${(e as Error).message}`);
  }

  return { slot, mountedPath: path, type: mediaType, sectors, errors: errors.length ? errors : undefined };
}

/** Eject (clear) the disk in the given drive slot. */
export function unmountMedia(
  _session: IntegratedSession,
  slot: DriveSlot,
): { slot: DriveSlot; ejected: boolean } {
  // In V1 we don't zero-out the TrackBuffer because the drive ROM needs
  // data to respond to the bus. Eject is a UI concept — we just mark it.
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
