// Spec 726.B — the ONE streaming reader for a `.c64retrace` binary log.
//
// The binary log is the timeline AUTHORITY and it is routinely multi-gigabyte: a
// single boot-to-gameplay firehose produced 2,136,107,703 bytes / 118,496,006
// events. Two rules follow, and both used to be obeyed in one file and ignored in
// the other (BUG-052):
//
//   1. The file is NEVER read whole. `readFileSync` throws ERR_FS_FILE_TOO_LARGE
//      past 2 GiB, and below that it still pins the whole log in one allocation.
//   2. The event stream is NEVER materialized. 118 M decoded event OBJECTS is
//      tens of gigabytes — the V8 heap dies, and it takes the MCP server process
//      with it, so the client sees only "Connection closed".
//
// So: read in bounded windows, carry the tail across the boundary (an event may
// straddle one), hand each decoded event to a visitor, keep nothing. A consumer
// folds what it needs as the events go past.

import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { decodeFileHeader, decodeEvent, type DecodedEvent, type TraceFileMeta } from "./binary-format.js";

// The header (defJson + meta) is KB; 16 MiB is ample. Env-overridable (floored
// above any real header) so a test can force the window loop on a small fixture.
export const CAPTURE_HEADER_MAX = Math.max(
  4096,
  Number(process.env.C64RE_INDEX_HEADER_BYTES) || 16 * 1024 * 1024,
);
/** Largest single encoded event (mark label-bounded) → the carry guard. */
export const MAX_EVENT_BYTES = 4096;
/** Window size, overridable (tests force a tiny window to exercise cross-boundary
 *  decode without a 2 GiB fixture). Floored well above one event. */
export const CAPTURE_WINDOW_BYTES = Math.max(
  64 * 1024,
  Number(process.env.C64RE_INDEX_WINDOW_BYTES) || 256 * 1024 * 1024,
);

/** readSync that fills `length` bytes at `bufOffset` (looping past short reads),
 *  returning the count actually read (< length only at EOF). */
export function readFullSync(
  fd: number,
  buf: Buffer,
  bufOffset: number,
  length: number,
  position: number,
): number {
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, bufOffset + read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read;
}

export interface CaptureHeader {
  meta: TraceFileMeta;
  headerLen: number;
  /** Format version — v1 mem-access records decode one byte shorter than v2, so
   *  every decode below must be told which (BUG-035). */
  version: number;
  /** Total file size in bytes. */
  size: number;
}

interface OpenedHeader extends CaptureHeader {
  fd: number;
  /** Events already inside the header read window — they seed the event stream. */
  seedCarry: Uint8Array;
}

function openHeader(path: string): OpenedHeader {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const hn = Math.min(size, CAPTURE_HEADER_MAX);
    const hbuf = Buffer.allocUnsafe(hn);
    readFullSync(fd, hbuf, 0, hn, 0);
    const hu8 = new Uint8Array(hbuf.buffer, hbuf.byteOffset, hn);
    const { meta, headerLen, version } = decodeFileHeader(hu8);
    return { fd, meta, headerLen, version, size, seedCarry: hu8.slice(headerLen, hn) };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** The capture's identity block alone. Reads the header window, never the log. */
export function readCaptureHeader(path: string): CaptureHeader {
  const h = openHeader(path);
  closeSync(h.fd);
  return { meta: h.meta, headerLen: h.headerLen, version: h.version, size: h.size };
}

export interface CaptureStreamResult extends CaptureHeader {
  /** Events handed to the visitor (MARKs included). */
  eventCount: number;
}

/**
 * Decode `path` event by event, handing each to `onEvent`. Nothing is retained:
 * peak memory is one window plus whatever the visitor chooses to keep.
 *
 * `onEvent` may return `false` to stop early (a consumer that has what it needs
 * does not pay for the rest of a multi-GB log).
 */
export function streamCaptureEvents(
  path: string,
  onEvent: (ev: DecodedEvent) => void | boolean,
  onHeader?: (h: CaptureHeader) => void,
): CaptureStreamResult {
  const h = openHeader(path);
  const { fd, meta, headerLen, version, size } = h;
  let eventCount = 0;
  try {
    onHeader?.({ meta, headerLen, version, size });
    const chunkBuf = Buffer.allocUnsafe(CAPTURE_WINDOW_BYTES);
    let carry = h.seedCarry;
    let filePos = Math.min(size, CAPTURE_HEADER_MAX);
    outer: for (;;) {
      if (carry.length > 0) chunkBuf.set(carry, 0);
      const space = CAPTURE_WINDOW_BYTES - carry.length;
      const toRead = Math.min(space, size - filePos);
      let got = 0;
      if (toRead > 0) {
        got = readFullSync(fd, chunkBuf, carry.length, toRead, filePos);
        filePos += got;
      }
      const windowLen = carry.length + got;
      if (windowLen === 0) break;
      const window = new Uint8Array(chunkBuf.buffer, chunkBuf.byteOffset, windowLen);
      let off = 0;
      for (;;) {
        const r = decodeEvent(window, off, version);
        if (!r) break;
        eventCount++;
        if (onEvent(r.ev) === false) break outer;
        off = r.next;
      }
      const tail = window.subarray(off).slice(); // copy — chunkBuf is reused next window
      // EOF: any tail left is a truncated final event (aborted trace) → drop.
      if (filePos >= size) break;
      if (tail.length > MAX_EVENT_BYTES) {
        throw new Error(
          `trace stream: ${tail.length} undecodable bytes near offset ${filePos} of ${path} (corrupt .c64retrace?)`,
        );
      }
      carry = tail;
    }
  } finally {
    closeSync(fd);
  }
  return { meta, headerLen, version, size, eventCount };
}
