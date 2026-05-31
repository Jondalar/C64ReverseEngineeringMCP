// PORT OF: vice/src/diskimage/fsimage-gcr.c (full file)
// Header:  vice/src/diskimage/fsimage-gcr.h
// Spec:    specs/612-1541-port-fidelity-rules.md §1 NL, §2 PL, §5 FM-block
//
// G64 image read/write — the on-disk side of GCR-encoded 1541 disk images.
// One C file → one TS file (NL-1); functions ported with verbatim snake_case
// names (NL-2). `fsimage_t` (forward-empty in drivetypes.ts) is concretised
// here via declaration merging per VICE fsimage.h:37-45. The minimal libc /
// util.c surface VICE calls into (fread/fwrite/fseek/ftell/fflush/
// util_fpread/util_fpwrite/util_*_le_buf*) is inlined as non-exported helpers
// with PORT OF citations; same treatment for disk_image_raw_track_size /
// disk_image_speed_map (vice/src/diskimage/diskimage.c) pending diskimage.ts.

import type { disk_image_t, disk_track_t, fsimage_t } from "./drivetypes.js";
import {
  MAX_GCR_TRACKS,
  DISK_IMAGE_TYPE_D64,
  DISK_IMAGE_TYPE_D67,
  DISK_IMAGE_TYPE_D71,
  DISK_IMAGE_TYPE_D80,
  DISK_IMAGE_TYPE_D82,
  DISK_IMAGE_TYPE_G64,
  DISK_IMAGE_TYPE_G71,
  DISK_IMAGE_TYPE_P64,
} from "./drivetypes.js";
import {
  CBMDOS_FDC_ERR_OK,
  CBMDOS_FDC_ERR_HEADER,
  CBMDOS_FDC_ERR_SYNC,
  CBMDOS_FDC_ERR_NOBLOCK,
  CBMDOS_FDC_ERR_DCHECK,
  CBMDOS_FDC_ERR_VERIFY,
  CBMDOS_FDC_ERR_WPROT,
  CBMDOS_FDC_ERR_HCHECK,
  CBMDOS_FDC_ERR_BLENGTH,
  CBMDOS_FDC_ERR_ID,
  CBMDOS_FDC_ERR_DRIVE,
  CBMDOS_FDC_ERR_DECODE,
  gcr_read_sector,
  gcr_write_sector,
} from "./gcr.js";

// PORT OF: vice/src/diskimage/fsimage.h:37-45 (struct fsimage_s) — concretise
// the forward-empty `fsimage_t` from drivetypes.ts via declaration merging.
declare module "./drivetypes.js" {
  interface fsimage_t {
    /** VICE: `FILE *fd`. Null mirrors `fd == NULL` in VICE. */
    fd: FILE_t | null;
    /** VICE: `char *name`. */
    name: string | null;
    /** VICE: `struct { uint8_t *map; int dirty; int len; } error_info`. */
    error_info: {
      map: Uint8Array | null;
      dirty: number;
      len: number;
    };
    /** BUG-023 — VICE-faithful host-file write-through. Installed at attach for
     *  writable path-backed media; called at the writeback commit (same point
     *  as VICE's fwrite) to mirror the in-RAM G64 image to the host file. */
    hostFlush?: (() => void) | null;
  }
}

// PORT OF: C stdio (ISO C99 §7.19) — in-memory `FILE *` equivalent. Auto-
// grows on extend (mirrors `fseek(SEEK_END)` + `fwrite` on a regular file).
export interface FILE_t {
  buf: Uint8Array;
  length: number;
  cursor: number;
}

// PORT OF: ISO C99 fseek whence constants + fseek itself.
const SEEK_SET = 0;
const SEEK_CUR = 1;
const SEEK_END = 2;
function fseek(fd: FILE_t, offset: number, whence: number): number {
  let pos: number;
  if (whence === SEEK_SET) pos = offset;
  else if (whence === SEEK_CUR) pos = fd.cursor + offset;
  else if (whence === SEEK_END) pos = fd.length + offset;
  else return -1;
  if (pos < 0) return -1;
  fd.cursor = pos;
  return 0;
}

// PORT OF: ISO C99 ftell
function ftell(fd: FILE_t): number {
  return fd.cursor;
}

// PORT OF: ISO C99 fflush — VICE only uses this as a "make visible to other
// readers" hint. No-op in the in-memory port.
function fflush(_fd: FILE_t): number {
  return 0;
}

// PORT OF: ISO C99 fread — returns the number of full items read (here
// always 0 or 1 since VICE calls `fread(buf, len, 1, fd)`).
function fread(buf: Uint8Array, size: number, nmemb: number, fd: FILE_t): number {
  const total = size * nmemb;
  if (fd.cursor + total > fd.length) return 0;
  buf.set(fd.buf.subarray(fd.cursor, fd.cursor + total), 0);
  fd.cursor += total;
  return nmemb;
}

// PORT OF: ISO C99 fwrite — auto-extends the in-memory backing when needed.
function fwrite(buf: Uint8Array, size: number, nmemb: number, fd: FILE_t): number {
  const total = size * nmemb;
  const end = fd.cursor + total;
  if (end > fd.buf.length) {
    const grown = new Uint8Array(Math.max(end, fd.buf.length * 2));
    grown.set(fd.buf.subarray(0, fd.length), 0);
    fd.buf = grown;
  }
  fd.buf.set(buf.subarray(0, total), fd.cursor);
  fd.cursor += total;
  if (fd.cursor > fd.length) fd.length = fd.cursor;
  return nmemb;
}

// PORT OF: vice/src/util.c (util_fpread) — pread(2)-style positional read.
function util_fpread(fd: FILE_t, buf: Uint8Array, size: number, offset: number): number {
  if (offset < 0 || offset + size > fd.length) return -1;
  buf.set(fd.buf.subarray(offset, offset + size), 0);
  return 0;
}

// PORT OF: vice/src/util.c (util_fpwrite) — pwrite(2)-style positional write.
// Auto-extends the in-memory backing to cover the offset+size range.
function util_fpwrite(fd: FILE_t, buf: Uint8Array, size: number, offset: number): number {
  if (offset < 0) return -1;
  const end = offset + size;
  if (end > fd.buf.length) {
    const grown = new Uint8Array(Math.max(end, fd.buf.length * 2));
    grown.set(fd.buf.subarray(0, fd.length), 0);
    fd.buf = grown;
  }
  fd.buf.set(buf.subarray(0, size), offset);
  if (end > fd.length) fd.length = end;
  return 0;
}

// PORT OF: vice/src/util.c (util_le_buf_to_word)
function util_le_buf_to_word(buf: Uint8Array, off = 0): number {
  return ((buf[off] ?? 0) | ((buf[off + 1] ?? 0) << 8)) & 0xffff;
}

// PORT OF: vice/src/util.c (util_le_buf_to_dword)
function util_le_buf_to_dword(buf: Uint8Array, off = 0): number {
  return (
    ((buf[off] ?? 0) |
      ((buf[off + 1] ?? 0) << 8) |
      ((buf[off + 2] ?? 0) << 16) |
      ((buf[off + 3] ?? 0) << 24)) >>>
    0
  );
}

// PORT OF: vice/src/util.c (util_word_to_le_buf)
function util_word_to_le_buf(buf: Uint8Array, value: number): void {
  buf[0] = value & 0xff;
  buf[1] = (value >> 8) & 0xff;
}

// PORT OF: vice/src/util.c (util_dword_to_le_buf)
function util_dword_to_le_buf(buf: Uint8Array, value: number): void {
  buf[0] = value & 0xff;
  buf[1] = (value >> 8) & 0xff;
  buf[2] = (value >> 16) & 0xff;
  buf[3] = (value >> 24) & 0xff;
}

// PORT OF: vice/src/lib.c (lib_malloc / lib_calloc / lib_free) — minimal
// JS-side equivalents. lib_malloc returns uninitialised memory; for parity
// with the codec consumers we also zero it (TS Uint8Array is already
// zero-initialised, matching lib_calloc behaviour). lib_free is a no-op in
// GC-managed JS.
function lib_malloc(size: number): Uint8Array {
  return new Uint8Array(size);
}

function lib_calloc(_nmemb: number, size: number): Uint8Array {
  return new Uint8Array(size);
}

// PORT OF: vice/src/diskimage/diskimage.c:201-206 (raw_track_size_d64)
const raw_track_size_d64: Readonly<Uint32Array> = new Uint32Array([
  6250, 6666, 7142, 7692,
]);

// PORT OF: vice/src/diskimage/diskimage.c:217-222 (raw_track_size_d67)
const raw_track_size_d67: Readonly<Uint32Array> = new Uint32Array([
  6250, 6666, 7142, 7692,
]);

// PORT OF: vice/src/diskimage/diskimage.c:226-231 (raw_track_size_d80)
const raw_track_size_d80: Readonly<Uint32Array> = new Uint32Array([
  9375, 10000, 10714, 11538,
]);

// PORT OF: vice/src/diskimage/diskimage.c:82-125 (disk_image_speed_map).
// Inlined here pending diskimage.ts port. Returns speed zone 0..3 for the
// given format + track.
function disk_image_speed_map(format: number, track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D67:
    case DISK_IMAGE_TYPE_D64:
    case DISK_IMAGE_TYPE_G64:
    case DISK_IMAGE_TYPE_P64:
      return ((track < 31) ? 1 : 0) + ((track < 25) ? 1 : 0) + ((track < 18) ? 1 : 0);
    case DISK_IMAGE_TYPE_D80:
      return ((track < 65) ? 1 : 0) + ((track < 54) ? 1 : 0) + ((track < 40) ? 1 : 0);
    case DISK_IMAGE_TYPE_D82:
      if (track > 77) track -= 77;
      return ((track < 65) ? 1 : 0) + ((track < 54) ? 1 : 0) + ((track < 40) ? 1 : 0);
    case DISK_IMAGE_TYPE_D71:
      if (track > 35) track -= 35;
      return ((track < 31) ? 1 : 0) + ((track < 25) ? 1 : 0) + ((track < 18) ? 1 : 0);
    case DISK_IMAGE_TYPE_G71:
      if (track > 42) track -= 42;
      return ((track < 31) ? 1 : 0) + ((track < 25) ? 1 : 0) + ((track < 18) ? 1 : 0);
    default:
      return 0;
  }
}

// PORT OF: vice/src/diskimage/diskimage.c:241-266 (disk_image_raw_track_size).
function disk_image_raw_track_size(format: number, track: number): number {
  switch (format) {
    case DISK_IMAGE_TYPE_D64:
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

// -----------------------------------------------------------------------------
// Module state — module-level statics (NL-5).
// -----------------------------------------------------------------------------

// PORT OF: vice/src/diskimage/fsimage-gcr.c:44 (fsimage_gcr_log)
let fsimage_gcr_log = 0; /* LOG_DEFAULT */

// PORT OF: vice/src/diskimage/fsimage-gcr.c:45-46 (gcr_image_header_expected_1541)
const gcr_image_header_expected_1541: Readonly<Uint8Array> = new Uint8Array([
  0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x34, 0x31, 0x00,
]);

// PORT OF: vice/src/diskimage/fsimage-gcr.c:47-48 (gcr_image_header_expected_1571)
const gcr_image_header_expected_1571: Readonly<Uint8Array> = new Uint8Array([
  0x47, 0x43, 0x52, 0x2d, 0x31, 0x35, 0x37, 0x31, 0x00,
]);

// PORT OF: standard C `memcmp` — minimal lexicographic comparison used only
// by the header-magic check.
function memcmp(a: Uint8Array, b: Uint8Array, n: number): number {
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// PORT OF: standard C `memset` — used to fill empty tracks per fsimage-gcr.c:171.
function memset(buf: Uint8Array, value: number, n: number): void {
  buf.fill(value & 0xff, 0, n);
}

// PORT OF: vice/src/log.c (log_error) — VICE writes to its log subsystem;
// in the TS port we forward to console.error. Same call sites as VICE.
function log_error(_log: number, fmt: string, ...args: unknown[]): void {
  console.error(`[fsimage_gcr] ${fmt}`, ...args);
}

// PORT OF: vice/src/log.c (log_open)
function log_open(_name: string): number {
  return 0; /* LOG_DEFAULT */
}

// -----------------------------------------------------------------------------
// fsimage-gcr.c — ported functions (NL-2)
// -----------------------------------------------------------------------------

// PORT OF: vice/src/diskimage/fsimage-gcr.c:53-75 (fsimage_read_gcr_image)
// Initial GCR buffer setup — populates image->gcr->tracks[] for every half
// track. Empty tracks get a canonical raw-track-size buffer per the empty-
// track allocation branch at fsimage-gcr.c:170-173 (mirrored further below
// in fsimage_gcr_read_half_track).
export function fsimage_read_gcr_image(image: disk_image_t): number {
  if (image.gcr === null) return -1;

  let half_track: number;
  for (half_track = 0; half_track < MAX_GCR_TRACKS; half_track++) {
    /* free existing track */
    if (image.gcr.tracks[half_track]!.data !== null) {
      // lib_free(image->gcr->tracks[half_track].data);  // GC-managed in TS.
      image.gcr.tracks[half_track]!.data = null;
      image.gcr.tracks[half_track]!.size = 0;
    }
    /* load new track from image */
    if (half_track < image.max_half_tracks) {
      fsimage_gcr_read_half_track(image, half_track + 2, image.gcr.tracks[half_track]!);
    } else {
      /* create empty tracks for non existing tracks */
      const size = disk_image_raw_track_size(image.type, half_track >> 1);
      image.gcr.tracks[half_track]!.size = size;
      image.gcr.tracks[half_track]!.data = lib_malloc(size);
      memset(image.gcr.tracks[half_track]!.data!, 0, size);
    }
  }
  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:79-120 (fsimage_gcr_seek_half_track).
// Static in VICE — non-exported in the TS port. Returns the file offset of
// the half-track's data block (or 0 if the track has no data, or -1 on
// error). `max_track_length` / `num_half_tracks` are populated as out-params
// via wrapper objects (TS analogue of `uint16_t *` / `uint8_t *`).
function fsimage_gcr_seek_half_track(
  fsimage: fsimage_t,
  half_track: number,
  max_track_length: { value: number },
  num_half_tracks: { value: number },
): number {
  const buf = new Uint8Array(12);

  if (fsimage.fd === null) {
    log_error(fsimage_gcr_log, "Attempt to read without disk image.");
    return -1;
  }
  if (util_fpread(fsimage.fd, buf, 12, 0) < 0) {
    log_error(fsimage_gcr_log, "Could not read GCR disk image.");
    return -1;
  }
  if (memcmp(gcr_image_header_expected_1541, buf, gcr_image_header_expected_1541.length) !== 0
      && memcmp(gcr_image_header_expected_1571, buf, gcr_image_header_expected_1571.length) !== 0) {
    log_error(fsimage_gcr_log, "Unexpected GCR header found.");
    return -1;
  }

  num_half_tracks.value = buf[9]!;
  if (num_half_tracks.value > MAX_GCR_TRACKS) {
    log_error(fsimage_gcr_log, "Too many half tracks.");
    return -1;
  }

  max_track_length.value = util_le_buf_to_word(buf, 10);
  // if-0 block in VICE for NUM_MAX_MEM_BYTES_TRACK check — preserved as note.

  const entry = new Uint8Array(4);
  if (util_fpread(fsimage.fd, entry, 4, 12 + (half_track - 2) * 4) < 0) {
    log_error(fsimage_gcr_log, "Could not read GCR disk image.");
    return -1;
  }
  return util_le_buf_to_dword(entry);
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:125-174 (fsimage_gcr_read_half_track)
// Read an entire GCR track from the disk image. For offset==0 entries the
// half-track buffer is allocated to the canonical raw track size and filled
// with 0x55 per VICE fsimage-gcr.c:170-173.
export function fsimage_gcr_read_half_track(
  image: disk_image_t,
  half_track: number,
  raw: disk_track_t,
): number {
  const buf = new Uint8Array(4);
  const fsimage = image.fsimage;
  if (fsimage === null) return -1;

  raw.data = null;
  raw.size = 0;

  const max_track_length = { value: 0 };
  const num_half_tracks = { value: 0 };
  const offset = fsimage_gcr_seek_half_track(fsimage, half_track, max_track_length, num_half_tracks);

  if (offset < 0) {
    return -1;
  }

  if (offset !== 0) {
    if (fsimage.fd === null) return -1;
    if (util_fpread(fsimage.fd, buf, 2, offset) < 0) {
      log_error(fsimage_gcr_log, "Could not read GCR disk image.");
      return -1;
    }

    const track_len = util_le_buf_to_word(buf);

    if (track_len < 1 || track_len > max_track_length.value) {
      log_error(fsimage_gcr_log, "Track field length %u is not supported.", track_len);
      return -1;
    }

    raw.data = lib_calloc(1, track_len);
    raw.size = track_len;

    // VICE: `fread(raw->data, track_len, 1, fsimage->fd)`. The seek cursor
    // is already at `offset + 2` after util_fpread above (in the libc
    // semantics util_fpread leaves the cursor undefined — but VICE relies
    // on `fread` here to consume the bytes immediately following the
    // 2-byte length). Match by seeking explicitly.
    if (fseek(fsimage.fd, offset + 2, SEEK_SET) !== 0
        || fread(raw.data, track_len, 1, fsimage.fd) < 1) {
      log_error(fsimage_gcr_log, "Could not read GCR disk image.");
      return -1;
    }
  } else {
    raw.size = disk_image_raw_track_size(image.type, half_track >> 1);
    raw.data = lib_malloc(raw.size);
    memset(raw.data!, 0x55, raw.size);
  }
  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:176-180 (fsimage_gcr_read_track).
// Static in VICE — non-exported here. Convenience wrapper that doubles the
// track number to a half-track index.
function fsimage_gcr_read_track(image: disk_image_t, track: number, raw: disk_track_t): number {
  return fsimage_gcr_read_half_track(image, track << 1, raw);
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:185-277 (fsimage_gcr_write_half_track)
// Write an entire GCR track to the disk image. When the half-track's entry
// is currently zero the image is extended at EOF and both the offset table
// and the speed-zone table are patched. CRITICAL: the writeback path was
// missing in the pre-612 quarantine port.
export function fsimage_gcr_write_half_track(
  image: disk_image_t,
  half_track: number,
  raw: disk_track_t,
): number {
  let gap: number;
  let extend = 0;
  let res: number;
  const buf = new Uint8Array(4);

  const fsimage = image.fsimage;
  if (fsimage === null) return -1;
  if (fsimage.fd === null) return -1;

  const max_track_length = { value: 0 };
  const num_half_tracks = { value: 0 };
  let offset = fsimage_gcr_seek_half_track(fsimage, half_track, max_track_length, num_half_tracks);
  if (offset < 0) {
    return -1;
  }
  if (image.read_only !== 0) {
    log_error(fsimage_gcr_log, "Attempt to write to read-only disk image.");
    return -1;
  }

  if (raw.size > max_track_length.value) {
    log_error(fsimage_gcr_log, "Track too long for image.");
    return -1;
  }

  if (offset === 0) {
    // VICE: `offset = fseek(fsimage->fd, 0, SEEK_END);` — the fseek return
    // is 0 on success, then VICE falls through to `ftell` for the actual
    // position. Mirror that two-step exactly.
    offset = fseek(fsimage.fd, 0, SEEK_END);
    if (offset === 0) {
      offset = ftell(fsimage.fd);
    }
    if (offset < 0) {
      log_error(fsimage_gcr_log, "Could not extend GCR disk image.");
      return -1;
    }
    extend = 1;
  }

  if (raw.data !== null) {
    util_word_to_le_buf(buf, raw.size & 0xffff);

    if (util_fpwrite(fsimage.fd, buf, 2, offset) < 0) {
      log_error(fsimage_gcr_log, "Could not write GCR disk image.");
      return -1;
    }

    // Clear gap between the end of the actual track and the start of the
    // next track. VICE writes the raw data via `fwrite` (sequential cursor
    // continues from the pwrite above — but pwrite leaves the cursor
    // undefined per POSIX, so VICE relies on the implementation; we seek
    // explicitly for determinism).
    if (fseek(fsimage.fd, offset + 2, SEEK_SET) !== 0
        || fwrite(raw.data, raw.size, 1, fsimage.fd) < 1) {
      log_error(fsimage_gcr_log, "Could not write GCR disk image.");
      return -1;
    }
    gap = max_track_length.value - raw.size;

    if (gap > 0) {
      const padding = lib_calloc(1, gap);
      res = fwrite(padding, gap, 1, fsimage.fd);
      // lib_free(padding);  // GC-managed.
      if (res < 1) {
        log_error(fsimage_gcr_log, "Could not write GCR disk image.");
        return -1;
      }
    }

    if (extend) {
      util_dword_to_le_buf(buf, offset >>> 0);
      if (util_fpwrite(fsimage.fd, buf, 4, 12 + (half_track - 2) * 4) < 0) {
        log_error(fsimage_gcr_log, "Could not write GCR disk image.");
        return -1;
      }

      util_dword_to_le_buf(buf, disk_image_speed_map(image.type, half_track >> 1));
      if (util_fpwrite(fsimage.fd, buf, 4, 12 + (half_track - 2 + num_half_tracks.value) * 4) < 0) {
        log_error(fsimage_gcr_log, "Could not write GCR disk image.");
        return -1;
      }
    }
  }

  /* Make sure the stream is visible to other readers. */
  fflush(fsimage.fd);
  // BUG-023 — VICE writes the host file here (fd is the real file). Mirror the
  // committed in-RAM G64 image to the backing file at this exact point.
  fsimage.hostFlush?.();

  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:279-283 (fsimage_gcr_write_track).
// Static in VICE — non-exported here.
function fsimage_gcr_write_track(image: disk_image_t, track: number, raw: disk_track_t): number {
  return fsimage_gcr_write_half_track(image, track << 1, raw);
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:288-344 (fsimage_gcr_read_sector)
export function fsimage_gcr_read_sector(
  image: disk_image_t,
  buf: Uint8Array,
  dadr: { track: number; sector: number },
): number {
  if (dadr.track > image.tracks) {
    log_error(fsimage_gcr_log, "Track %u out of bounds.  Cannot read GCR track.", dadr.track);
    return -1;
  }

  let rf: number;
  if (image.gcr === null) {
    const raw: disk_track_t = { data: null, size: 0 };
    if (fsimage_gcr_read_track(image, dadr.track, raw) < 0) return -1;
    if (raw.data === null) return CBMDOS_IPE_NOT_READY;
    rf = gcr_read_sector(raw, buf, dadr.sector & 0xff);
  } else {
    rf = gcr_read_sector(image.gcr.tracks[(dadr.track * 2) - 2]!, buf, dadr.sector & 0xff);
  }
  if (rf !== CBMDOS_FDC_ERR_OK) {
    log_error(fsimage_gcr_log, "Cannot find track: %u sector: %u within GCR image.",
              dadr.track, dadr.sector);
    switch (rf) {
      case CBMDOS_FDC_ERR_HEADER:  return CBMDOS_IPE_READ_ERROR_BNF;   /* 20 */
      case CBMDOS_FDC_ERR_SYNC:    return CBMDOS_IPE_READ_ERROR_SYNC;  /* 21 */
      case CBMDOS_FDC_ERR_NOBLOCK: return CBMDOS_IPE_READ_ERROR_DATA;  /* 22 */
      case CBMDOS_FDC_ERR_DCHECK:  return CBMDOS_IPE_READ_ERROR_CHK;   /* 23 */
      case CBMDOS_FDC_ERR_VERIFY:  return CBMDOS_IPE_WRITE_ERROR_VER;  /* 25 */
      case CBMDOS_FDC_ERR_WPROT:   return CBMDOS_IPE_WRITE_PROTECT_ON; /* 26 */
      case CBMDOS_FDC_ERR_HCHECK:  return CBMDOS_IPE_READ_ERROR_BCHK;  /* 27 */
      case CBMDOS_FDC_ERR_BLENGTH: return CBMDOS_IPE_WRITE_ERROR_BIG;  /* 28 */
      case CBMDOS_FDC_ERR_ID:      return CBMDOS_IPE_DISK_ID_MISMATCH; /* 29 */
      case CBMDOS_FDC_ERR_DRIVE:   return CBMDOS_IPE_NOT_READY;        /* 74 */
      case CBMDOS_FDC_ERR_DECODE:  return CBMDOS_IPE_READ_ERROR_GCR;   /* 24 */
      default:                     return CBMDOS_IPE_NOT_READY;
    }
  }
  return CBMDOS_IPE_OK;
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:350-393 (fsimage_gcr_write_sector)
export function fsimage_gcr_write_sector(
  image: disk_image_t,
  buf: Uint8Array,
  dadr: { track: number; sector: number },
): number {
  if (dadr.track > image.tracks) {
    log_error(fsimage_gcr_log, "Track %u out of bounds.  Cannot write GCR sector", dadr.track);
    return -1;
  }

  if (image.gcr === null) {
    const raw: disk_track_t = { data: null, size: 0 };
    if (fsimage_gcr_read_track(image, dadr.track, raw) < 0 || raw.data === null) return -1;
    if (gcr_write_sector(raw, buf, dadr.sector & 0xff) !== CBMDOS_FDC_ERR_OK) {
      log_error(fsimage_gcr_log, "Could not find track %u sector %u in disk image",
                dadr.track, dadr.sector);
      return -1;
    }
    if (fsimage_gcr_write_track(image, dadr.track, raw) < 0) return -1;
  } else {
    if (gcr_write_sector(image.gcr.tracks[(dadr.track * 2) - 2]!, buf, dadr.sector & 0xff) !== CBMDOS_FDC_ERR_OK) {
      log_error(fsimage_gcr_log, "Could not find track %u sector %u in disk image",
                dadr.track, dadr.sector);
      return -1;
    }
    if (fsimage_gcr_write_track(image, dadr.track, image.gcr.tracks[(dadr.track * 2) - 2]!) < 0) {
      log_error(fsimage_gcr_log, "Failed writing track %u to disk image.", dadr.track);
      return -1;
    }
  }

  return 0;
}

// PORT OF: vice/src/diskimage/fsimage-gcr.c:397-400 (fsimage_gcr_init)
export function fsimage_gcr_init(): void {
  fsimage_gcr_log = log_open("Filesystem Image GCR");
}

// -----------------------------------------------------------------------------
// CBMDOS IPE codes — mirror vice/src/cbmdos.h. Local to satisfy the return
// values from fsimage_gcr_read_sector. Same numeric values as VICE.
// -----------------------------------------------------------------------------

// PORT OF: vice/src/cbmdos.h (CBMDOS_IPE_*) — IPE error code subset used by
// fsimage_gcr_read_sector. Numbers verbatim from VICE.
const CBMDOS_IPE_OK = 0;
const CBMDOS_IPE_READ_ERROR_BNF  = 20;
const CBMDOS_IPE_READ_ERROR_SYNC = 21;
const CBMDOS_IPE_READ_ERROR_DATA = 22;
const CBMDOS_IPE_READ_ERROR_CHK  = 23;
const CBMDOS_IPE_READ_ERROR_GCR  = 24;
const CBMDOS_IPE_WRITE_ERROR_VER = 25;
const CBMDOS_IPE_WRITE_PROTECT_ON = 26;
const CBMDOS_IPE_READ_ERROR_BCHK = 27;
const CBMDOS_IPE_WRITE_ERROR_BIG = 28;
const CBMDOS_IPE_DISK_ID_MISMATCH = 29;
const CBMDOS_IPE_NOT_READY = 74;

