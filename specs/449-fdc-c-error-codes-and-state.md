# Spec 449 — `fdc.c` error codes + state machine

**Status:** OPEN  
**Priority:** MEDIUM  
**Parent:** Epic 440  
**Depends on:** Spec 448

## VICE source

- `drive/fdc.c` ~400 LoC (mostly 1571/1581 — for 1541 only the
  error-code enum + helpers matter)
- `cbmdos.h` — error code constants

For the 1541-only milestone:
- `CBMDOS_FDC_ERR_*` enum: OK, HEADER, SYNC, DCHECK, NOBLOCK,
  DATA, DRIVE, FLOPPY, WPROT, COMP

## Headless target

Currently partial in `src/disk/gcr.ts` (read-result status string).
Move to dedicated `src/disk/fdc.ts` with literal enum.

## Acceptance

1. `src/disk/fdc.ts` defines the literal `fdc_err_t` enum.
2. `gcr_read_sector` / `gcr_write_sector` return values use the
   enum (not strings).
3. Audit doc `docs/spec-449-fdc-audit.md`.
4. Canaries green.

## Do Not

- Don't port 1571/1581 fdc logic.
- Don't introduce custom error codes beyond VICE.
