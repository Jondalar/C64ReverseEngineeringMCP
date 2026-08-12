// BUG-023-cart / Spec 742 — host-file write-back for writable cartridges.
//
// Same RFL class as the disk case: VICE writes the .crt back at detach/save
// (easyflash_save_image), our port only mutated the in-RAM flash + the .c64re
// checkpoint. This writes the re-packed .crt to its host backing file so a
// flash-programming cart (EasyFlash) persists to disk. VICE writes the .crt on
// detach/save (not per flash byte), so this runs on eject / explicit persist.
// Read-only / non-writable carts are skipped with a clear reason.

import { writeFileSync } from "node:fs";

export interface CartLike {
  isWritableDirty?(): boolean;
  persistsWritableState?(): boolean;
  getCrtImage?(): Uint8Array | null;
}

export interface CartPersistResult { written: boolean; path?: string; bytes?: number; reason?: string }

export function persistCartridgeToFile(cart: CartLike | undefined | null, backingPath: string): CartPersistResult {
  if (!cart) return { written: false, reason: "no cartridge attached" };
  if (!cart.getCrtImage) return { written: false, reason: "mapper cannot re-pack a .crt" };
  if (cart.persistsWritableState && !cart.persistsWritableState()) return { written: false, reason: "mapper does not persist writable state" };
  if (cart.isWritableDirty && !cart.isWritableDirty()) return { written: false, reason: "cartridge not dirty" };
  if (!backingPath) return { written: false, reason: "no backing file path" };
  const img = cart.getCrtImage();
  if (!img) return { written: false, reason: "mapper returned no .crt image" };
  writeFileSync(backingPath, img);
  return { written: true, path: backingPath, bytes: img.length };
}
