// PORT OF: vice/src/drive/iecieee/iecieee.c
//
// The disk-controller VIA2 dispatch for IEC/IEEE drives. For the 1541 family
// VIA2 (drv->via2) is the disk-controller VIA; VICE snapshots it here, NOT in
// iec.c (which carries VIA1 only). machine_drive_snapshot_write (c64drive.c:155)
// calls iec_drive_snapshot_write (VIA1) THEN iecieee_drive_snapshot_write
// (VIA2) THEN ieee_drive_snapshot_write (no-op for the 1541).
//
// Every function here is a thin dispatcher to already-ported via2d_* / viacore_*
// — no new logic, no serializer. NL-1 (one C file → one TS file, same
// basename), NL-2 (verbatim snake_case names), FC-2 (all non-static C functions
// exported). Spec 705.A step 2.3.

import {
  type diskunit_context_t,
  type snapshot_t,
} from "./drivetypes.js";
import {
  DRIVE_TYPE_1540,
  DRIVE_TYPE_1541,
  DRIVE_TYPE_1541II,
  DRIVE_TYPE_1570,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  DRIVE_TYPE_2031,
} from "./drivetypes.js";
import { via2d_init, via2d_setup_context } from "./via2d.js";
import {
  viacore_shutdown,
  viacore_reset,
  viacore_disable,
  viacore_snapshot_write_module,
  viacore_snapshot_read_module,
} from "./viacore.js";

// PORT OF: vice/src/drive/drive-sound.c (drive_sound_update — extern decl).
// Mirrors via2d.ts's local forwarder; the drive-sound subsystem is a no-op in
// the headless port. Only iecieee_drive_reset uses it (not the snapshot path).
function drive_sound_update(_event: number, _dnr: number): void {
  /* no-op — drive-sound.c not ported (headless has no audible drive). */
}

// PORT OF: vice/src/drive/drive.h (DRIVE_SOUND_MOTOR_ON)
const DRIVE_SOUND_MOTOR_ON = 1;

// PORT OF: vice/src/drive/iecieee/iecieee.c:36-39 (iecieee_drive_init)
export function iecieee_drive_init(drv: diskunit_context_t): void {
  via2d_init(drv);
}

// PORT OF: vice/src/drive/iecieee/iecieee.c:41-44 (iecieee_drive_shutdown)
export function iecieee_drive_shutdown(drv: diskunit_context_t): void {
  viacore_shutdown(drv.via2!);
}

// PORT OF: vice/src/drive/iecieee/iecieee.c:46-64 (iecieee_drive_reset)
export function iecieee_drive_reset(drv: diskunit_context_t): void {
  switch (drv.type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
    case DRIVE_TYPE_2031:
      viacore_reset(drv.via2!);
      drive_sound_update(DRIVE_SOUND_MOTOR_ON, drv.mynumber);
      break;
    default:
      viacore_disable(drv.via2!);
      break;
  }
}

// PORT OF: vice/src/drive/iecieee/iecieee.c:66-69 (iecieee_drive_setup_context)
export function iecieee_drive_setup_context(drv: diskunit_context_t): void {
  via2d_setup_context(drv);
}

// PORT OF: vice/src/drive/iecieee/iecieee.c:71-91 (iecieee_drive_snapshot_read)
export function iecieee_drive_snapshot_read(
  ctxptr: diskunit_context_t,
  s: snapshot_t,
): number {
  switch (ctxptr.type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
    case DRIVE_TYPE_2031:
      if (viacore_snapshot_read_module(ctxptr.via2!, s) < 0) {
        return -1;
      }
      break;
    default:
      break;
  }

  return 0;
}

// PORT OF: vice/src/drive/iecieee/iecieee.c:93-113 (iecieee_drive_snapshot_write)
export function iecieee_drive_snapshot_write(
  ctxptr: diskunit_context_t,
  s: snapshot_t,
): number {
  switch (ctxptr.type) {
    case DRIVE_TYPE_1540:
    case DRIVE_TYPE_1541:
    case DRIVE_TYPE_1541II:
    case DRIVE_TYPE_1570:
    case DRIVE_TYPE_1571:
    case DRIVE_TYPE_1571CR:
    case DRIVE_TYPE_2031:
      if (viacore_snapshot_write_module(ctxptr.via2!, s) < 0) {
        return -1;
      }
      break;
    default:
      break;
  }

  return 0;
}
