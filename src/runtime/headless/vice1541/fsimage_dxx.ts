// PORT OF: vice/src/diskimage/fsimage-dxx.c (full file)
// Header:  vice/src/diskimage/fsimage-dxx.h
// Spec:    specs/612-1541-port-fidelity-rules.md §1 NL, §2 PL, §5 FM-block
//
// One C file → one TS file (NL-1). One C function → one TS function with
// verbatim snake_case name (NL-2). Five exports match VICE non-static
// declarations: fsimage_dxx_write_half_track, fsimage_read_dxx_image,
// fsimage_dxx_read_sector, fsimage_dxx_write_sector, fsimage_dxx_init.
//
// The `fsimage_t` struct (vice/src/diskimage/fsimage.h:37-45) is referenced
// from `drivetypes.ts` as an opaque forward `interface fsimage_t {}`. The
// real field layout (`fd`, `name`, `error_info`) lives here as the local
// `Fsimage_t_view` until a dedicated `fsimage.ts` port lands (not in §3 FM
// yet). The cast is the minimum mechanical bridge — PL-3 compliant.
//
// VICE I/O primitives (`util_fpread`, `util_fpwrite`, `fflush`, FILE*) are
// translated to in-memory Uint8Array operations against `fsimage_t.fd`.
// VICE memory helpers (`lib_calloc`, `lib_malloc`, `lib_realloc`,
// `lib_free`) map to `new Uint8Array(n)` (zero-filled = calloc) and GC.
// `log_error` is a no-op stub pending a `log.ts` port.
//
// Helper functions sourced from `vice/src/diskimage/diskimage.c` and
// `fsimage-check.c` (`disk_image_speed_map`, `disk_image_sector_per_track`,
// `disk_image_raw_track_size`, `disk_image_gap_size`,
// `disk_image_header_gap_size`, `disk_image_sync_size`,
// `fsimage_check_sector`, `disk_image_check_sector`) are module-private
// inlines with verbatim VICE snake_case names so the future `diskimage.ts`
// can lift them untouched. FC-2 only checks fsimage-dxx.c exports.

import {
  CBMDOS_FDC_ERR_BLENGTH,
  CBMDOS_FDC_ERR_DCHECK,
  CBMDOS_FDC_ERR_DECODE,
  CBMDOS_FDC_ERR_DRIVE,
  CBMDOS_FDC_ERR_HCHECK,
  CBMDOS_FDC_ERR_HEADER,
  CBMDOS_FDC_ERR_ID,
  CBMDOS_FDC_ERR_NOBLOCK,
  CBMDOS_FDC_ERR_OK,
  CBMDOS_FDC_ERR_SYNC,
  CBMDOS_FDC_ERR_VERIFY,
  CBMDOS_FDC_ERR_WPROT,
  gcr_convert_sector_to_GCR,
  gcr_read_sector,
  gcr_write_sector,
} from "./gcr.js";
import {
  DISK_IMAGE_TYPE_D64,
  DISK_IMAGE_TYPE_D67,
  DISK_IMAGE_TYPE_D71,
  DISK_IMAGE_TYPE_D80,
  DISK_IMAGE_TYPE_D82,
  DISK_IMAGE_TYPE_G64,
  DISK_IMAGE_TYPE_G71,
  DISK_IMAGE_TYPE_P64,
  DISK_IMAGE_TYPE_X64,
  DRIVE_TYPE_1571,
  DRIVE_TYPE_1571CR,
  SECTOR_GCR_SIZE_WITH_HEADER,
  type disk_addr_t,
  type disk_image_t,
  type disk_track_t,
  type fsimage_t,
} from "./drivetypes.js";

// PORT OF: vice/src/diskimage/fsimage-dxx.c:45
let fsimage_dxx_log = 0;

// vice/src/cbmdos.h IPE_* return codes (only fsimage_dxx_read_sector uses them).
const CBMDOS_IPE_OK = 0;
const CBMDOS_IPE_READ_ERROR_BNF = 20;
const CBMDOS_IPE_READ_ERROR_SYNC = 21;
const CBMDOS_IPE_READ_ERROR_DATA = 22;
const CBMDOS_IPE_READ_ERROR_CHK = 23;
const CBMDOS_IPE_READ_ERROR_GCR = 24;
const CBMDOS_IPE_WRITE_ERROR_VER = 25;
const CBMDOS_IPE_WRITE_PROTECT_ON = 26;
const CBMDOS_IPE_READ_ERROR_BCHK = 27;
const CBMDOS_IPE_WRITE_ERROR_BIG = 28;
const CBMDOS_IPE_DISK_ID_MISMATCH = 29;
const CBMDOS_IPE_NOT_READY = 74;

// vice/src/diskconstants.h slice
const BAM_TRACK_1541 = 18;
const BAM_SECTOR_1541 = 0;
const BAM_ID_1541 = 162;
const BAM_TRACK_1571 = 18;
const BAM_SECTOR_1571 = 0;
const BAM_ID_1571 = 162;
const HDR_TRACK_8050 = 39;
const HDR_SECTOR_8050 = 0;
const HDR_ID_8050 = 24;

// vice/src/diskimage/x64.h
const X64_HEADER_LENGTH = 64;
const HAVE_X64_IMAGE = true;

// -----------------------------------------------------------------------------
// fsimage_t struct view (PL-3 cast — see file-level note above).
// VICE: typedef struct fsimage_s { FILE *fd; char *name;
//          struct { uint8_t *map; int dirty; int len; } error_info; } fsimage_t;
// -----------------------------------------------------------------------------

interface Fsimage_error_info {
  map: Uint8Array | null;
  dirty: number;
  len: number;
}

interface Fsimage_t_view {
  fd: Uint8Array;
  name: string | null;
  error_info: Fsimage_error_info;
}

function _fsimage_view(f: fsimage_t): Fsimage_t_view {
  return f as unknown as Fsimage_t_view;
}

// -----------------------------------------------------------------------------
// vice/src/diskimage/diskimage.c module-private inlines (PORT OF blocks
// reference the canonical C source so a future diskimage.ts can lift them).
// -----------------------------------------------------------------------------

// PORT OF: vice/src/diskimage/diskimage.c:132-137
const sector_map_d64: Readonly<number[]> = [17, 18, 19, 21];
// PORT OF: vice/src/diskimage/diskimage.c:143-148
const sector_map_d67: Readonly<number[]> = [17, 18, 20, 21];
// PORT OF: vice/src/diskimage/diskimage.c:153-158
const sector_map_d80: Readonly<number[]> = [23, 25, 27, 29];
// PORT OF: vice/src/diskimage/diskimage.c:201-206
const raw_track_size_d64: Readonly<number[]> = [6250, 6666, 7142, 7692];
// PORT OF: vice/src/diskimage/diskimage.c:217-222
const raw_track_size_d67: Readonly<number[]> = [6250, 6666, 7142, 7692];
// PORT OF: vice/src/diskimage/diskimage.c:226-231
const raw_track_size_d80: Readonly<number[]> = [9375, 10000, 10714, 11538];
// PORT OF: vice/src/diskimage/diskimage.c:271-276
const gap_size_d64: Readonly<number[]> = [9, 12, 17, 8];
// PORT OF: vice/src/diskimage/diskimage.c:281-286
const gap_size_d67: Readonly<number[]> = [9, 12, 4, 8];

// PORT OF: vice/src/diskimage/diskimage.c:82-125 (disk_image_speed_map)
function disk_image_speed_map(format: number, track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D67:
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
      return (track < 31 ? 1 : 0) + (track < 25 ? 1 : 0) + (track < 18 ? 1 : 0);
    case DISK_IMAGE_TYPE_D80:
      return (track < 65 ? 1 : 0) + (track < 54 ? 1 : 0) + (track < 40 ? 1 : 0);
    case DISK_IMAGE_TYPE_D82: {
      let t = track;
      if (t > 77) t -= 77;
      return (t < 65 ? 1 : 0) + (t < 54 ? 1 : 0) + (t < 40 ? 1 : 0);
    }
    case DISK_IMAGE_TYPE_D71: {
      let t = track;
      if (t > 35) t -= 35;
      return (t < 31 ? 1 : 0) + (t < 25 ? 1 : 0) + (t < 18 ? 1 : 0);
    }
    case DISK_IMAGE_TYPE_G71: {
      let t = track;
      if (t > 42) t -= 42;
      return (t < 31 ? 1 : 0) + (t < 25 ? 1 : 0) + (t < 18 ? 1 : 0);
    }
    default:
      return 0;
  }
}

// PORT OF: vice/src/diskimage/diskimage.c:170-194 (disk_image_sector_per_track)
function disk_image_sector_per_track(format: number, track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_D71:
    case DISK_IMAGE_TYPE_G71:
      return sector_map_d64[disk_image_speed_map(format, track)]!;
    case DISK_IMAGE_TYPE_D67:
      return sector_map_d67[disk_image_speed_map(format, track)]!;
    case DISK_IMAGE_TYPE_D80:
    case DISK_IMAGE_TYPE_D82:
      return sector_map_d80[disk_image_speed_map(format, track)]!;
    default:
      return 0;
  }
}

// PORT OF: vice/src/diskimage/diskimage.c:241-266 (disk_image_raw_track_size)
function disk_image_raw_track_size(format: number, track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_D71:
    case DISK_IMAGE_TYPE_G71:
      return raw_track_size_d64[disk_image_speed_map(format, track)]!;
    case DISK_IMAGE_TYPE_D67:
      return raw_track_size_d67[disk_image_speed_map(format, track)]!;
    case DISK_IMAGE_TYPE_D80:
    case DISK_IMAGE_TYPE_D82:
      return raw_track_size_d80[disk_image_speed_map(format, track)]!;
    default:
      return 1;
  }
}

// PORT OF: vice/src/diskimage/diskimage.c:288-312 (disk_image_gap_size)
function disk_image_gap_size(format: number, track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_D71:
    case DISK_IMAGE_TYPE_G71:
      return gap_size_d64[disk_image_speed_map(format, track)]!;
    case DISK_IMAGE_TYPE_D67:
      return gap_size_d67[disk_image_speed_map(format, track)]!;
    case DISK_IMAGE_TYPE_D80:
    case DISK_IMAGE_TYPE_D82:
      return 25;
    default:
      return 1;
  }
}

// PORT OF: vice/src/diskimage/diskimage.c:317-341 (disk_image_header_gap_size)
function disk_image_header_gap_size(format: number, _track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_D71:
    case DISK_IMAGE_TYPE_G71:
      return 9;
    case DISK_IMAGE_TYPE_D67:
      return 4;
    default:
      return 1;
  }
}

// PORT OF: vice/src/diskimage/diskimage.c:347-371 (disk_image_sync_size)
function disk_image_sync_size(format: number, _track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_X64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
    case DISK_IMAGE_TYPE_D71:
    case DISK_IMAGE_TYPE_G71:
      return 5;
    case DISK_IMAGE_TYPE_D67:
      return 5;
    default:
      return 1;
  }
}

// PORT OF: vice/src/diskimage/fsimage-check.c (fsimage_check_sector) —
// inline because fsimage-dxx.c calls disk_image_check_sector which
// delegates to fsimage_check_sector for DISK_IMAGE_DEVICE_FS.
function fsimage_check_sector(image: disk_image_t, track: number, sector: number): number {
  if (track < 1) return -1;
  const max = disk_image_sector_per_track(image.type, track);
  if (max === 0) return -1;
  if (sector >= max) return -1;
  let off = 0;
  for (let t = 1; t < track; t++) off += disk_image_sector_per_track(image.type, t);
  return off + sector;
}

// PORT OF: vice/src/diskimage/diskimage.c:384-392 (disk_image_check_sector)
function disk_image_check_sector(image: disk_image_t, track: number, sector: number): number {
  return fsimage_check_sector(image, track, sector);
}

// PORT OF: vice/src/drive/drive.c (drive_get_disk_drive_type) — stub
// returning DRIVE_TYPE_NONE until drive.ts (§4 LO layer 13) lands. The
// 1571 special-side path stays dormant for the stock 1541 D64 case.
function drive_get_disk_drive_type(_device: number): number {
  return 0;
}

// VICE I/O / mem helpers — in-memory translations (no real FILE I/O).

function util_fpread(fd: Uint8Array, buf: Uint8Array, size: number, offset: number): number {
  if (offset < 0 || offset + size > fd.length) return -1;
  for (let i = 0; i < size; i++) buf[i] = fd[offset + i]!;
  return 0;
}

function util_fpwrite(fd: Uint8Array, buf: Uint8Array, size: number, offset: number): number {
  if (offset < 0 || offset + size > fd.length) return -1;
  for (let i = 0; i < size; i++) fd[offset + i] = buf[i]!;
  return 0;
}

function fflush(_fd: Uint8Array): void { /* in-memory */ }

function lib_calloc(count: number, size: number): Uint8Array {
  return new Uint8Array(count * size);
}

function lib_malloc(size: number): Uint8Array {
  return new Uint8Array(size);
}

function lib_realloc(buf: Uint8Array, newSize: number): Uint8Array {
  if (newSize === buf.length) return buf;
  const out = new Uint8Array(newSize);
  out.set(buf.subarray(0, Math.min(buf.length, newSize)));
  return out;
}

function log_error(_log: number, _msg: string): void { /* log.ts deferred */ }

// =============================================================================
// VICE exports (NL-2 verbatim snake_case)
// =============================================================================

// PORT OF: vice/src/diskimage/fsimage-dxx.c:47-147 (fsimage_dxx_write_half_track)
// CRITICAL writeback path: decodes a dirty GCR track back into D64
// sector bytes via gcr_read_sector and writes them to the image at the
// linear sector offset. Updates the per-sector error map. This was
// missing in the pre-612 quarantine port (audit showstopper).
export function fsimage_dxx_write_half_track(
  image: disk_image_t,
  half_track: number,
  raw: disk_track_t,
): number {
  let max_sector = 0;
  let error_info_created = 0;
  let res: number;
  let offset: number;
  const fsimage = _fsimage_view(image.fsimage!);
  let rf: number;

  const track = (half_track / 2) | 0;

  max_sector = disk_image_sector_per_track(image.type, track);
  let sectors = disk_image_check_sector(image, track, 0);
  if (sectors < 0) {
    log_error(fsimage_dxx_log, `Track: ${track} out of bounds.`);
    return -1;
  }

  if (track > image.tracks) {
    if (fsimage.error_info.map) {
      const newlen = sectors + max_sector;
      fsimage.error_info.map = lib_realloc(fsimage.error_info.map, newlen);
      for (let i = fsimage.error_info.len; i < newlen; i++) fsimage.error_info.map[i] = 0;
      fsimage.error_info.len = newlen;
      fsimage.error_info.dirty = 1;
    }
    image.tracks = track;
  }

  const buffer = lib_calloc(max_sector, 256);
  for (let sector = 0; sector < max_sector; sector++) {
    const tmpSect = new Uint8Array(256);
    rf = gcr_read_sector(raw, tmpSect, sector & 0xff);
    for (let i = 0; i < 256; i++) buffer[sector * 256 + i] = tmpSect[i]!;
    if (rf !== CBMDOS_FDC_ERR_OK) {
      log_error(fsimage_dxx_log, `Could not find data sector of T:${track} S:${sector}.`);
      if (fsimage.error_info.map === null) {
        let newlen = disk_image_check_sector(image, image.tracks, 0);
        if (newlen >= 0) {
          newlen += disk_image_sector_per_track(image.type, image.tracks);
          fsimage.error_info.map = lib_malloc(newlen);
          for (let i = 0; i < newlen; i++) fsimage.error_info.map[i] = CBMDOS_FDC_ERR_OK & 0xff;
          fsimage.error_info.len = newlen;
          fsimage.error_info.dirty = 1;
          error_info_created = 1;
        }
      }
    }
    if (fsimage.error_info.map !== null) {
      if (fsimage.error_info.map[sectors + sector] !== (rf & 0xff)) {
        fsimage.error_info.map[sectors + sector] = rf & 0xff;
        fsimage.error_info.dirty = 1;
      }
    }
  }
  offset = sectors * 256;
  if (HAVE_X64_IMAGE && image.type === DISK_IMAGE_TYPE_X64) offset += X64_HEADER_LENGTH;

  if (util_fpwrite(fsimage.fd, buffer, max_sector * 256, offset) < 0) {
    log_error(fsimage_dxx_log, `Error writing T:${track} to disk image.`);
    return -1;
  }
  if (fsimage.error_info.map) {
    if (fsimage.error_info.dirty) {
      offset = fsimage.error_info.len * 256 + sectors;
      if (HAVE_X64_IMAGE && image.type === DISK_IMAGE_TYPE_X64) offset += X64_HEADER_LENGTH;
      fsimage.error_info.dirty = 0;
      if (error_info_created) {
        res = util_fpwrite(fsimage.fd, fsimage.error_info.map, fsimage.error_info.len,
          fsimage.error_info.len * 256);
      } else {
        res = util_fpwrite(fsimage.fd, fsimage.error_info.map.subarray(sectors),
          max_sector, offset);
      }
      if (res < 0) {
        log_error(fsimage_dxx_log, `Error writing T:${track} error info to disk image.`);
        return -1;
      }
    }
  }
  fflush(fsimage.fd);
  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-dxx.c:149-334 (fsimage_read_dxx_image)
// Read .dxx image and encode each track into per-track GCR buffers in
// image->gcr->tracks[]. Per-track skew rotation per fsimage-dxx.c:285-304.
// 1571 second-side handling per fsimage-dxx.c:185-220.
export function fsimage_read_dxx_image(image: disk_image_t): number {
  const buffer = new Uint8Array(256);
  let bam_id_off: number;
  let gap: number;
  let headergap: number;
  let synclen: number;
  let track_size: number;
  const header = { id1: 0, id2: 0, sector: 0, track: 0 };
  let rf: number;
  const fsimage = _fsimage_view(image.fsimage!);
  let max_sector: number;
  let ptr: Uint8Array;
  let ptrOff: number;
  let half_track: number;
  let sectors: number;
  let offset: number;
  let trackoffset = 0;
  let tempgcr: Uint8Array;

  if (image.type === DISK_IMAGE_TYPE_D80 || image.type === DISK_IMAGE_TYPE_D82) {
    sectors = disk_image_check_sector(image, HDR_TRACK_8050, HDR_SECTOR_8050);
    bam_id_off = HDR_ID_8050;
  } else {
    sectors = disk_image_check_sector(image, BAM_TRACK_1541, BAM_SECTOR_1541);
    bam_id_off = BAM_ID_1541;
  }

  buffer[bam_id_off + 0] = 0xa0;
  buffer[bam_id_off + 1] = 0xa0;
  if (sectors >= 0) {
    util_fpread(fsimage.fd, buffer, 256, sectors << 8);
  } else {
    return -1;
  }
  header.id1 = buffer[bam_id_off + 0]!;
  header.id2 = buffer[bam_id_off + 1]!;

  const image_has_two_single_sides =
    image.type === DISK_IMAGE_TYPE_D71 && !(buffer[0x03]! & 0x80) ? 1 : 0;
  const dt = drive_get_disk_drive_type(image.device);
  const double_sided_drive = dt === DRIVE_TYPE_1571 || dt === DRIVE_TYPE_1571CR ? 1 : 0;

  // 1571 fills second side with "unformatted" data for D64
  if (double_sided_drive && image.type !== DISK_IMAGE_TYPE_D71) {
    header.track = 1;
    for (let track = 1; track <= image.max_half_tracks / 2; track++, header.track++) {
      half_track = (36 + track) * 2 - 2;
      track_size = disk_image_raw_track_size(image.type, track);
      const ht = image.gcr!.tracks[half_track]!;
      if (ht.data === null) ht.data = lib_malloc(track_size);
      else if (ht.size !== track_size) ht.data = lib_realloc(ht.data, track_size);
      ht.size = track_size;
      ht.data!.fill(0);

      half_track++;
      const ht2 = image.gcr!.tracks[half_track]!;
      if (ht2.data === null) ht2.data = lib_malloc(track_size);
      else if (ht2.size !== track_size) ht2.data = lib_realloc(ht2.data, track_size);
      ht2.size = track_size;
      ht2.data!.fill(0);
    }
  }

  header.track = 1;
  for (let track = 1; track <= image.max_half_tracks / 2; track++, header.track++) {
    half_track = track * 2 - 2;
    track_size = disk_image_raw_track_size(image.type, track);
    const ht = image.gcr!.tracks[half_track]!;
    if (ht.data === null) ht.data = lib_malloc(track_size);
    else if (ht.size !== track_size) ht.data = lib_realloc(ht.data, track_size);
    ptr = ht.data!;
    ht.size = track_size;

    if (track <= image.tracks) {
      tempgcr = lib_malloc(track_size);
      ptrOff = 0;

      if (image_has_two_single_sides && track === 36) {
        sectors = disk_image_check_sector(image, BAM_TRACK_1571 + 35, BAM_SECTOR_1571);
        buffer[BAM_ID_1571] = 0xa0;
        buffer[BAM_ID_1571 + 1] = 0xa0;
        if (sectors >= 0) util_fpread(fsimage.fd, buffer, 256, sectors << 8);
        header.id1 = buffer[BAM_ID_1571]!;
        header.id2 = buffer[BAM_ID_1571 + 1]!;
        header.track = 1;
      }

      gap = disk_image_gap_size(image.type, track);
      headergap = disk_image_header_gap_size(image.type, track);
      synclen = disk_image_sync_size(image.type, track);
      max_sector = disk_image_sector_per_track(image.type, track);

      tempgcr.fill(0x55);
      for (let sector = 0; sector < max_sector; sector++) {
        sectors = disk_image_check_sector(image, track, sector);
        offset = sectors * 256;
        if (HAVE_X64_IMAGE && image.type === DISK_IMAGE_TYPE_X64) offset += X64_HEADER_LENGTH;
        if (sectors >= 0) {
          rf = CBMDOS_FDC_ERR_DRIVE;
          if (util_fpread(fsimage.fd, buffer, 256, offset) >= 0) {
            rf = fsimage.error_info.map !== null
              ? fsimage.error_info.map[sectors]!
              : CBMDOS_FDC_ERR_OK;
          }
          header.sector = sector;
          gcr_convert_sector_to_GCR(buffer, 0, tempgcr, ptrOff, header,
            headergap, synclen, rf);
        }
        ptrOff += SECTOR_GCR_SIZE_WITH_HEADER + headergap + gap + synclen * 2;
      }

      // fsimage-dxx.c:289-304 — wraparound copy with skew. Per the VICE
      // comment block, the skew approximation is intentionally arbitrary
      // (tweaked to skew1.prg output for the first few tracks).
      trackoffset += ptrOff - gap;
      trackoffset += ((track_size * 100) / 270) | 0;
      trackoffset = trackoffset % track_size;
      ptr = ht.data!;
      ptr.fill(0x55);
      ptr.set(tempgcr.subarray(0, track_size - trackoffset), trackoffset);
      ptr.set(tempgcr.subarray(track_size - trackoffset), 0);
    } else {
      ptr.fill(0x55);
    }

    // empty odd half-track
    half_track++;
    const ht2 = image.gcr!.tracks[half_track]!;
    if (ht2.data === null) ht2.data = lib_malloc(track_size);
    else if (ht2.size !== track_size) ht2.data = lib_realloc(ht2.data, track_size);
    ht2.size = track_size;
    ht2.data!.fill(0);
  }
  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-dxx.c:336-429 (fsimage_dxx_read_sector)
// Read one (track, sector) into buf. Path A: image has no GCR (raw read).
// Path B: image has GCR — decode via gcr_read_sector. Error-map overlay
// per fsimage-dxx.c:386-396.
export function fsimage_dxx_read_sector(
  image: disk_image_t,
  buf: Uint8Array,
  dadr: disk_addr_t,
): number {
  const fsimage = _fsimage_view(image.fsimage!);
  let rf = CBMDOS_FDC_ERR_OK;

  const sectors = disk_image_check_sector(image, dadr.track, dadr.sector);
  if (sectors < 0) {
    log_error(fsimage_dxx_log, `Track ${dadr.track}, Sector ${dadr.sector} out of bounds.`);
    return -1;
  }

  let offset = sectors * 256;
  if (HAVE_X64_IMAGE && image.type === DISK_IMAGE_TYPE_X64) offset += X64_HEADER_LENGTH;

  // hard-error gate
  let harderror = 0;
  if (fsimage.error_info.map) {
    harderror = 1;
    rf = fsimage.error_info.map[sectors]!;
    if (rf === 0 || rf === 1 || rf === 5 || rf === 7 || rf === 8) harderror = 0;
  }

  if (harderror === 0) {
    if (image.gcr === null) {
      if (util_fpread(fsimage.fd, buf, 256, offset) < 0) {
        log_error(fsimage_dxx_log,
          `Error reading T:${dadr.track} S:${dadr.sector} from disk image.`);
        return -1;
      } else {
        rf = fsimage.error_info.map
          ? fsimage.error_info.map[sectors]!
          : CBMDOS_FDC_ERR_OK;
      }
    } else {
      rf = gcr_read_sector(image.gcr.tracks[dadr.track * 2 - 2]!, buf,
        dadr.sector & 0xff);
      // VICE HACK: error_info overlays a clean GCR read
      if (fsimage.error_info.map && rf === CBMDOS_FDC_ERR_OK) {
        rf = fsimage.error_info.map[sectors]!;
      }
    }
  }

  switch (rf) {
    case CBMDOS_FDC_ERR_OK: return CBMDOS_IPE_OK;
    case CBMDOS_FDC_ERR_HEADER: return CBMDOS_IPE_READ_ERROR_BNF;
    case CBMDOS_FDC_ERR_SYNC: return CBMDOS_IPE_READ_ERROR_SYNC;
    case CBMDOS_FDC_ERR_NOBLOCK: return CBMDOS_IPE_READ_ERROR_DATA;
    case CBMDOS_FDC_ERR_DCHECK: return CBMDOS_IPE_READ_ERROR_CHK;
    case CBMDOS_FDC_ERR_VERIFY: return CBMDOS_IPE_WRITE_ERROR_VER;
    case CBMDOS_FDC_ERR_WPROT: return CBMDOS_IPE_WRITE_PROTECT_ON;
    case CBMDOS_FDC_ERR_HCHECK: return CBMDOS_IPE_READ_ERROR_BCHK;
    case CBMDOS_FDC_ERR_BLENGTH: return CBMDOS_IPE_WRITE_ERROR_BIG;
    case CBMDOS_FDC_ERR_ID: return CBMDOS_IPE_DISK_ID_MISMATCH;
    case CBMDOS_FDC_ERR_DRIVE: return CBMDOS_IPE_NOT_READY;
    case CBMDOS_FDC_ERR_DECODE: return CBMDOS_IPE_READ_ERROR_GCR;
    default: return CBMDOS_IPE_OK;
  }
}

// PORT OF: vice/src/diskimage/fsimage-dxx.c:431-482 (fsimage_dxx_write_sector)
// Write one (track, sector). Writes both the raw .dxx backing store and
// (if a GCR overlay is present) re-encodes via gcr_write_sector. Updates
// the error map.
export function fsimage_dxx_write_sector(
  image: disk_image_t,
  buf: Uint8Array,
  dadr: disk_addr_t,
): number {
  const fsimage = _fsimage_view(image.fsimage!);

  const sectors = disk_image_check_sector(image, dadr.track, dadr.sector);
  if (sectors < 0) {
    log_error(fsimage_dxx_log,
      `Track: ${dadr.track}, Sector: ${dadr.sector} out of bounds.`);
    return -1;
  }
  let offset = sectors * 256;
  if (HAVE_X64_IMAGE && image.type === DISK_IMAGE_TYPE_X64) offset += X64_HEADER_LENGTH;

  if (util_fpwrite(fsimage.fd, buf, 256, offset) < 0) {
    log_error(fsimage_dxx_log,
      `Error writing T:${dadr.track} S:${dadr.sector} to disk image.`);
    return -1;
  }
  if (image.gcr !== null) {
    gcr_write_sector(image.gcr.tracks[dadr.track * 2 - 2]!, buf, dadr.sector & 0xff);
  }

  if (fsimage.error_info.map !== null &&
      fsimage.error_info.map[sectors] !== CBMDOS_FDC_ERR_OK) {
    offset = fsimage.error_info.len * 256 + sectors;
    if (HAVE_X64_IMAGE && image.type === DISK_IMAGE_TYPE_X64) offset += X64_HEADER_LENGTH;
    fsimage.error_info.map[sectors] = CBMDOS_FDC_ERR_OK;
    if (util_fpwrite(fsimage.fd, fsimage.error_info.map.subarray(sectors), 1, offset) < 0) {
      log_error(fsimage_dxx_log,
        `Error writing T:${dadr.track} S:${dadr.sector} error info to disk image.`);
    }
  }
  fflush(fsimage.fd);
  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-dxx.c:484-487 (fsimage_dxx_init)
// One-time log-channel init. log_open stubbed pending log.ts port.
export function fsimage_dxx_init(): void {
  fsimage_dxx_log = 1;
}
