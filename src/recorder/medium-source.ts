// Spec 766.3 — recorder medium source (disk + cartridge), gen-gated.
//
// The recorder anchor (RAM + chip state, ~70 KiB) is shipped every 0.5 s. The
// MEDIUM (a .crt up to ~1 MiB, or a D64/G64 disk image) is large and rarely
// changes, so re-shipping it every anchor is exactly the BUG-049 monster
// (per-second hashing/copying of a 1 MiB cart on the emu thread). Instead the
// recorder ships the medium bytes only when its monotonic generation changed,
// and otherwise carries just the gen-key for the worker to match against what
// it already stored.
//
// Both media expose an O(1)-ish, bridge-side generation:
//   - cartridge: HeadlessCartridgeMapper.writableGeneration()  (pre-existing)
//   - disk:      Vice1541Facade.diskWriteGeneration()          (Spec 766.3)
//
// The bytes a descriptor yields are the SAME restore-format the kernel snapshot
// embeds (Spec 714.4/714.5), so reconstruct can re-inject them verbatim:
//   - disk: drive1541.snapshotDiskImage()  (the GCRIMAGE blob restoreDiskImage eats)
//   - cart: a bundle of the constant .crt bytes + the mutable flash image
//           (encodeCartMedium), keyed by writableGeneration so a flash write
//           re-ships both together. The small cart bank/control STATE rides the
//           anchor (snapshot `media` metadata), NOT here.
//
// This module is OUTSIDE vice1541/ (bridge layer) — it only reads the public
// facade/mapper/bus surface, never the VICE core (Spec 612 PL-5).

import { encodeCartMedium } from "./anchor-record.js";

/** A drive exposing the Spec 707/766 media surface (structural — the facade). */
interface MediumDrive {
  diskWriteGeneration?(): number;
  getAttachedMedia?(): { kind: string; bytes: Uint8Array; readOnly: boolean } | null;
  snapshotDiskImage?(): Uint8Array | null;
}

/** A cartridge mapper exposing the writable-state surface (structural). */
interface MediumCart {
  writableGeneration?(): number;
  getWritableImage?(): Uint8Array | null;
}

/** The kernel surface this helper reads (structural — no hard import). */
export interface MediumKernelLike {
  drive1541?: MediumDrive;
  c64Bus?: {
    getCartridge?(): MediumCart | undefined;
    getCartridgeMedia?(): { name: string; bytes: Uint8Array } | undefined;
  };
}

export type MediumKind = "disk" | "cart";

/**
 * A gen-gated medium handle. `generation` is cheap (O(1)); the producer
 * compares it against the last-shipped gen and calls `getBytes()` ONLY on a
 * change. `getBytes()` is allowed to commit/repack (it is off the per-frame
 * path — sampled at most ~2×/s, and only on a real change).
 */
export interface MediumDescriptor {
  kind: MediumKind;
  /** Monotonic content generation. Changes iff the medium bytes changed. */
  generation: number;
  /** Current medium bytes (committed). Lazy — only call on a gen change.
   *  For disk this flushes dirty GCR back into the image first (the same
   *  writeback VICE does at snapshot), so the bytes are current. */
  getBytes(): Uint8Array | null;
}

/**
 * Collect the currently-attached media as gen-gated descriptors. Returns an
 * empty array when nothing is attached. Pure read of the generations; no bytes
 * are copied here (that is deferred to `getBytes()` on a gen change).
 */
export function collectMediumDescriptors(kernel: MediumKernelLike): MediumDescriptor[] {
  const out: MediumDescriptor[] = [];

  const drive = kernel.drive1541;
  if (drive?.diskWriteGeneration && drive.snapshotDiskImage && drive.getAttachedMedia?.() != null) {
    out.push({
      kind: "disk",
      generation: drive.diskWriteGeneration(),
      // The GCRIMAGE snapshot blob (includes the live dirty track); restore feeds
      // it to restoreDiskImage(). snapshotDiskImage copies, so it is current.
      getBytes: () => drive.snapshotDiskImage?.() ?? null,
    });
  }

  const cart = kernel.c64Bus?.getCartridge?.();
  const cartMedia = kernel.c64Bus?.getCartridgeMedia?.();
  if (cart?.writableGeneration && cartMedia) {
    out.push({
      kind: "cart",
      generation: cart.writableGeneration(),
      // Constant .crt bytes + the mutable flash image, bundled so reconstruct
      // gets both. The bank/control state rides the anchor's `media` metadata.
      getBytes: () => encodeCartMedium(cartMedia.bytes, cart.getWritableImage?.() ?? null),
    });
  }

  return out;
}
