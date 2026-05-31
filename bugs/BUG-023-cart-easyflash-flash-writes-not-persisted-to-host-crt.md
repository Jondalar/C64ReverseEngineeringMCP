# Bug: writable cartridge (EasyFlash) flash writes not persisted to the host .crt

- **ID:** BUG-023-cart
- **Date:** 2026-05-31
- **Reporter:** llm
- **Area:** runtime
- **Severity:** medium
- **Status:** fixed (EasyFlash re-pack + host .crt write-back on eject/persist)

## Root class (same as BUG-023)

VICE's `fwrite`/file side effects must map to real host-file writes in the TS
port. VICE writes the `.crt` back at detach/save (`easyflash_save_image`); our
port only mutated the in-RAM flash + the `.c64re` checkpoint (`getWritableImage`,
Spec 714.5). So a flash-programming cart (EasyFlash) never changed its host
`.crt` file. `media.bytes` / the checkpoint blob is a mirror, not the persistence
authority. Same RFL audit-failure class as the disk case (BUG-023).

## Fix

- `parseCrt` keeps the original `.crt` bytes (`ParsedCartridgeImage.rawBytes`).
- `EasyFlashMapper.getCrtImage()` re-packs the live flash back into a valid `.crt`:
  copy the original bytes, overwrite each CHIP packet's data from the matching
  flash bank (ROML→loFlash, ROMH→hiFlash; bank `b` at `b<<13`). Header / names /
  load addresses / chip order are preserved exactly — only data changes
  (VICE-faithful save).
- `media/persist-cartridge.ts` `persistCartridgeToFile(cart, backingPath)` writes
  the re-packed `.crt` to its host file; skips non-writable / non-dirty carts.
- `media/ingress.ts`: the CRT mount stores the host `.crt` path
  (`session.cartPath`); the CRT eject writes the programmed flash back BEFORE
  detaching (VICE saves the `.crt` on detach). `v3-ws-server.ts` forwards the
  picker's `p.path` as `backingPath`.

## Gate

`scripts/smoke-023-cart-write-through.mjs` (`npm run smoke:023-cart`, 7/7):
synthetic EasyFlash `.crt` → mutate bank0 ROML+ROMH flash → `getCrtImage`
re-pack → write the host `.crt` → re-read from the filesystem → ROML/ROMH bank0
== programmed flash + mtime advanced + a re-mount sees it; a non-dirty cart is
skipped (no redundant host write). Spec 714.5 cartridge persistence stays green
(33/33).

## Remaining / follow-up

- Real end-to-end (boot an EasyFlash title, program flash via the AMD command
  sequence, eject, re-read host `.crt`) is a runtime gate — deferred (needs a
  real writable EF `.crt` + boot). The re-pack + host write-back is proven here.
- Other writable mappers (MegaByter / flash800, GMOD2 m93c86 EEPROM,
  spi-flash) get `getCrtImage` per family in a later slice.
- Belongs to Spec 742 (one media ownership + write-through model).
