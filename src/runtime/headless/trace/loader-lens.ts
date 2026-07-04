// Spec 784 A2 — the loader-lens landing map.
//
// THE net-new linkage: correlate a loader-scoped capture's 1541 head timeline
// (DRIVE_HEAD, the SOURCE) with the C64's RAM-write bursts (RAM_WRITE, the DEST)
// to recover, per landed payload, WHICH medium block's bytes came to rest at WHICH
// C64 address. This is the ground truth a per-project extractor's manifest is
// validated against (B4) — the real loader decides, so a wrong static
// interpretation is caught.
//
// Method (loader-agnostic, v1): the loader lands a payload as a contiguous ascending
// RAM-write sweep. Each such run's SOURCE = the sector the read head was over when
// the run began (the head immediately precedes the burst it fed). Scratch writes
// (short, scattered) are filtered by a minimum run length. Sector 0xff = head between
// sectors (rotation gap) — carried as the last VALID sector.

import { TraceOp, ACCESS_WRITE, decodeFileHeader, decodeEventStream, type DecodedEvent } from "./binary-format.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface LandingMapEntry {
  /** Where the bytes came FROM on the medium. */
  source: { halftrack: number; track: number; sector: number };
  /** Where they LANDED in C64 RAM (start address of the run). */
  c64Dest: number;
  /** Byte length of the run. */
  len: number;
  /** sha256 of the landed bytes (hex) — the identity the manifest span must match. */
  sha256: string;
  /** Cycle the run began landing. */
  cycleStart: number;
}

export interface LandingMapOptions {
  /** Runs shorter than this are treated as scratch and dropped. Default 16. */
  minRunLen?: number;
  /** Ignore RAM writes to the I/O + ROM-shadow window (only $0002..maxDest land). */
  maxDest?: number;
}

// VICE halftrack (2..84) → 1541 track (1..42). Halftrack 36 = track 18 (power-on).
export function halftrackToTrack(halftrack: number): number {
  return Math.floor(halftrack / 2);
}

interface Run {
  startAddr: number;
  nextAddr: number;
  bytes: number[];
  head: { halftrack: number; sector: number } | null;
  cycleStart: number;
}

/**
 * Build the landing map from a decoded loader-lens event stream (RAM_WRITE +
 * DRIVE_HEAD). Events must be in capture (cycle) order — decodeEventStream yields
 * them so. Only C64 RAM_WRITE writes count as landings; DRIVE_RAM_WRITE (drive-side)
 * and reads are ignored.
 */
export function buildLandingMap(events: DecodedEvent[], opts: LandingMapOptions = {}): LandingMapEntry[] {
  const minRunLen = opts.minRunLen ?? 16;
  const maxDest = opts.maxDest ?? 0xd000;
  const out: LandingMapEntry[] = [];

  // The last head sample with a real sector (0xff = gap is skipped as a source).
  let lastValidHead: { halftrack: number; sector: number } | null = null;
  let run: Run | null = null;

  const flush = () => {
    if (run && run.bytes.length >= minRunLen && run.head) {
      const buf = Uint8Array.from(run.bytes);
      out.push({
        source: {
          halftrack: run.head.halftrack,
          track: halftrackToTrack(run.head.halftrack),
          sector: run.head.sector,
        },
        c64Dest: run.startAddr,
        len: run.bytes.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
        cycleStart: run.cycleStart,
      });
    }
    run = null;
  };

  for (const ev of events) {
    if (ev.op === TraceOp.DRIVE_HEAD) {
      if (ev.sector !== undefined && ev.sector !== 0xff && ev.halftrack !== undefined) {
        lastValidHead = { halftrack: ev.halftrack, sector: ev.sector };
      }
      continue;
    }
    if (ev.op !== TraceOp.RAM_WRITE) continue;
    if (ev.access !== ACCESS_WRITE) continue;
    if (ev.addr === undefined || ev.value === undefined) continue;
    if (ev.addr < 0x0002 || ev.addr >= maxDest) continue; // land in RAM only

    if (run && ev.addr === run.nextAddr) {
      run.bytes.push(ev.value);
      run.nextAddr += 1;
    } else {
      flush();
      run = {
        startAddr: ev.addr,
        nextAddr: ev.addr + 1,
        bytes: [ev.value],
        head: lastValidHead,
        cycleStart: ev.cycle,
      };
    }
  }
  flush();
  return out;
}

/**
 * Build the landing map from a `.c64retrace` binary capture file (the loader-lens
 * capture: a trace armed with the drive-mechanism + drive8-cpu + memory domains).
 * Reads + decodes the whole event stream, then correlates (see buildLandingMap).
 */
export function landingMapFromCaptureFile(path: string, opts: LandingMapOptions = {}): LandingMapEntry[] {
  // Copy into a fresh 0-offset buffer (Node Buffer pools share an ArrayBuffer).
  const buf = new Uint8Array(readFileSync(path));
  const { version, headerLen } = decodeFileHeader(buf);
  const events = decodeEventStream(buf, headerLen, version);
  return buildLandingMap(events, opts);
}
