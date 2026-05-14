// Spec 449 — `fdc_err_t` literal port (1541-only V1 scope).
//
// VICE source: `src/cbmdos.h:104-119`.
//   enum fdc_err_e {
//       CBMDOS_FDC_ERR_OK      = 1,
//       CBMDOS_FDC_ERR_HEADER  = 2,
//       CBMDOS_FDC_ERR_SYNC    = 3,
//       CBMDOS_FDC_ERR_NOBLOCK = 4,
//       CBMDOS_FDC_ERR_DCHECK  = 5,
//       CBMDOS_FDC_ERR_VERIFY  = 7,
//       CBMDOS_FDC_ERR_WPROT   = 8,
//       CBMDOS_FDC_ERR_HCHECK  = 9,
//       CBMDOS_FDC_ERR_BLENGTH = 10,
//       CBMDOS_FDC_ERR_ID      = 11,
//       CBMDOS_FDC_ERR_FSPEED  = 12,
//       CBMDOS_FDC_ERR_DRIVE   = 15,
//       CBMDOS_FDC_ERR_DECODE  = 16
//   };
//   typedef enum fdc_err_e fdc_err_t;
//
// Promoted from `src/disk/gcr.ts` INTERIM block (Spec 445) to its
// canonical home here. Value gaps at 6 and 13-14 preserved verbatim
// from VICE (WD17xx fault-register heritage; unobservable in 1541
// gcr.c emit paths).
//
// Scope (Spec 440 1541-only mandate, [[feedback_vice_no_alternatives]]):
//   - IN V1: fdc_err_t enum (this file).
//   - OUT V1: full `src/drive/ieee/fdc.c` state machine (IEEE-only —
//     1541 has no FDC chip), full `src/cbmdos.c` DOS command channel,
//     CBMDOS_IPE_* host-level error codes, CBMDOS_FT_*/FAM_* file
//     constants, cbmdos_cmd_parse_t structs, cbmdos_*() API fns.
//     See `docs/spec-449-fdc-cbmdos-mapping.md` for full ticketed list.

/**
 * cbmdos.h:104-119 `enum fdc_err_e` / `fdc_err_t` (numeric).
 *
 * Returned by GCR encode/decode paths (`gcr_convert_sector_to_GCR`,
 * `gcr_read_sector`, `gcr_write_sector`) to signal disk-side faults
 * to the drive CPU. `OK = 1` is success; non-zero non-OK values are
 * specific failure modes that propagate to the drive's job-status
 * register at $0000-$0005.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export type fdc_err_t = number;

/** cbmdos.h:105 — success / no error. */
export const CBMDOS_FDC_ERR_OK      = 1;
/** cbmdos.h:106 — header block mismatch / sector header not readable. */
export const CBMDOS_FDC_ERR_HEADER  = 2;
/** cbmdos.h:107 — no SYNC found within rotation window. */
export const CBMDOS_FDC_ERR_SYNC    = 3;
/** cbmdos.h:108 — data block missing (data-area sync absent). */
export const CBMDOS_FDC_ERR_NOBLOCK = 4;
/** cbmdos.h:109 — data block checksum mismatch. */
export const CBMDOS_FDC_ERR_DCHECK  = 5;
/** cbmdos.h:110 — write-verify mismatch. (Value gap at 6.) */
export const CBMDOS_FDC_ERR_VERIFY  = 7;
/** cbmdos.h:111 — write protect (no-notch / image read-only). */
export const CBMDOS_FDC_ERR_WPROT   = 8;
/** cbmdos.h:112 — header block checksum mismatch. */
export const CBMDOS_FDC_ERR_HCHECK  = 9;
/** cbmdos.h:113 — wrong block length. */
export const CBMDOS_FDC_ERR_BLENGTH = 10;
/** cbmdos.h:114 — disk ID mismatch (different disk than expected). */
export const CBMDOS_FDC_ERR_ID      = 11;
/** cbmdos.h:115 — spindle-speed deviation. */
export const CBMDOS_FDC_ERR_FSPEED  = 12;
/** cbmdos.h:116 — drive not ready / no media. (Value gaps at 13-14.) */
export const CBMDOS_FDC_ERR_DRIVE   = 15;
/** cbmdos.h:117 — GCR decode failure (invalid nibble pattern). */
export const CBMDOS_FDC_ERR_DECODE  = 16;
