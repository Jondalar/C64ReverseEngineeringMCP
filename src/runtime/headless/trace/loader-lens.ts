// Spec 784 A2 — the loader-lens landing map + read-set.
//
// THE net-new linkage: recover, from a loader-scoped capture, WHICH physical medium
// block the REAL loader read and WHERE its bytes came to rest in C64 RAM — the ground
// truth a per-project extractor's manifest is validated against (B4). Because the real
// loader decides, a wrong STATIC interpretation (relocator / depacker / copy-loop) is
// caught.
//
// Two lanes, two truths:
//
//  1. READ-SET (buildReadSet) — the AUTHORITY. From the BLOCK_READ (0x35) stream the
//     TRX64 drive emits: one record per physical (track, sector) the drive actually
//     LATCHED GCR bytes off (read_pra/GCR_read), in read order. This is what
//     validate_extraction diffs a manifest against. It does NOT depend on the C64-side
//     write timeline, so buffering / relocation cannot corrupt it.
//
//  2. LANDING MAP (buildLandingMap) — the DEST-side human view (runtime_loader_lens):
//     which RAM address each transferred payload landed at. Rebuilt (Spec 784 Option A)
//     to defeat three defects the original write-time correlation had:
//       (a) Multi-stream run builder — a landing survives interleaved scratch writes
//           (KERNAL jiffy $A0-$A2, IRQ) instead of being flushed at the first gap.
//       (b) Dataflow gate — a run counts as a disk-landing ONLY if transfer reads
//           ($DD00 accesses) occurred in its cycle window. A pure memory-copy
//           (relocator moving already-loaded bytes) has ZERO $DD00 reads → dropped.
//           This is what killed the old 78×T35 false map (all of it was the copy).
//       (c) Source by READ time — a landing's source block is FIFO-matched against the
//           BLOCK_READ stream by cycle, NOT the head position at WRITE time (which,
//           under buffering, is a rotated-past sector, not the one that was read).

import { TraceOp, ACCESS_WRITE, ACCESS_READ, decodeFileHeader, decodeEventStream, type DecodedEvent } from "./binary-format.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** One physical block the drive actually READ (Spec 784 read-set, BLOCK_READ 0x35). */
export interface ReadSetEntry {
  halftrack: number;
  track: number;
  sector: number;
  /** GCR data bytes the drive latched off this (halftrack, sector) in this pass. */
  bytes: number;
  /** Drive cycle the head left the sector (read complete). */
  cycle: number;
}

export interface LandingMapEntry {
  /** Where the bytes came FROM on the medium (FIFO-matched read-set block; null if
   *  no block-read preceded this landing — e.g. a capture without the BLOCK_READ lane). */
  source: { halftrack: number; track: number; sector: number } | null;
  /** Where they LANDED in C64 RAM (start address of the run). */
  c64Dest: number;
  /** Byte length of the run. */
  len: number;
  /** sha256 of the landed bytes (hex) — the identity the manifest span must match. */
  sha256: string;
  /** Cycle the run began landing. */
  cycleStart: number;
  /** Transfer reads ($DD00 accesses) observed in this run's window — the dataflow
   *  evidence that qualified it as a disk-landing (a memory-copy has ~0). */
  transferReads: number;
}

export interface LandingMapOptions {
  /** Runs shorter than this are treated as scratch and dropped. Default 16. */
  minRunLen?: number;
  /** Ignore RAM writes to the I/O + ROM-shadow window (only $0002..maxDest land). */
  maxDest?: number;
  /** A run qualifies as a disk-landing only if ≥ this many transfer reads fell in its
   *  cycle window. Small floor (stray-IRQ resistance), NOT payload-proportional: a
   *  memory-copy has 0, a real transfer has hundreds. Default 4. */
  minTransferReads?: number;
  /** The C64 I/O address whose READS mark a byte transfer from the drive (the
   *  fastloader / KERNAL serial port). Default $DD00 (CIA2 PRA — IEC CLK/DATA). */
  transferReadAddr?: number;
}

// VICE halftrack (2..84) → 1541 track (1..42). Halftrack 36 = track 18 (power-on).
export function halftrackToTrack(halftrack: number): number {
  return Math.floor(halftrack / 2);
}

/**
 * Build the READ-SET (the authority) from a decoded event stream: the ordered list of
 * physical blocks the drive actually latched GCR bytes off (BLOCK_READ 0x35). This is
 * loader-agnostic and buffering-proof — it is drive-side truth, independent of when the
 * C64 wrote the bytes to RAM.
 */
export function buildReadSet(events: DecodedEvent[]): ReadSetEntry[] {
  const out: ReadSetEntry[] = [];
  for (const ev of events) {
    if (ev.op !== TraceOp.BLOCK_READ) continue;
    if (ev.halftrack === undefined || ev.sector === undefined) continue;
    out.push({
      halftrack: ev.halftrack,
      track: halftrackToTrack(ev.halftrack),
      sector: ev.sector,
      bytes: ev.bytes ?? 0,
      cycle: ev.cycle,
    });
  }
  return out;
}

interface Run {
  startAddr: number;
  nextAddr: number;
  bytes: number[];
  cycleStart: number;
  cycleEnd: number;
}

// Bounds the number of simultaneously-open write streams. Real loader traces keep 1-2
// active; the cap only backstops a pathological trace. When exceeded, the run with the
// oldest cycleEnd is evicted + emitted (it has gone stale).
const MAX_OPEN_RUNS = 256;

/**
 * Build the landing map (DEST-side human view) from a decoded loader-lens event stream.
 * See the file header for the three defects this rewrite defeats.
 *
 * Multi-stream: RAM writes are grouped into ascending-address runs keyed by their next
 * expected address, so a run survives interleaved scratch writes. Dataflow gate: a run
 * is kept only if enough transfer reads ($DD00) fell in its cycle window. Source: each
 * kept run is FIFO-matched to the nearest preceding BLOCK_READ by cycle.
 */
export function buildLandingMap(events: DecodedEvent[], opts: LandingMapOptions = {}): LandingMapEntry[] {
  const minRunLen = opts.minRunLen ?? 16;
  const maxDest = opts.maxDest ?? 0xd000;
  const minTransferReads = opts.minTransferReads ?? 4;
  const transferReadAddr = opts.transferReadAddr ?? 0xdd00;

  // Completed runs (start/end cycle + bytes), collected in emission order.
  const completed: Run[] = [];
  // Open runs keyed by nextAddr. A write to `addr` extends map[addr] (re-keyed to
  // addr+1) or starts a fresh run.
  const open = new Map<number, Run>();
  // Transfer-read cycles (sorted ascending by construction — events are in cycle order).
  const transferCycles: number[] = [];
  // Read-set (for FIFO source attribution), cycles ascending.
  const readSet = buildReadSet(events);

  const complete = (run: Run) => {
    if (run.bytes.length >= minRunLen) completed.push(run);
  };

  const evictOldest = () => {
    let oldestKey = -1;
    let oldestCycle = Infinity;
    for (const [k, r] of open) {
      if (r.cycleEnd < oldestCycle) { oldestCycle = r.cycleEnd; oldestKey = k; }
    }
    if (oldestKey >= 0) {
      const r = open.get(oldestKey)!;
      open.delete(oldestKey);
      complete(r);
    }
  };

  for (const ev of events) {
    // Transfer-read timeline: a READ of the fastloader/serial port = a byte pulled from
    // the drive. RAM_WRITE op carries both reads + writes (IO comes through 0x11 too).
    if (ev.op === TraceOp.RAM_WRITE && ev.access === ACCESS_READ && ev.addr === transferReadAddr) {
      transferCycles.push(ev.cycle);
      continue;
    }
    if (ev.op !== TraceOp.RAM_WRITE || ev.access !== ACCESS_WRITE) continue;
    if (ev.addr === undefined || ev.value === undefined) continue;
    if (ev.addr < 0x0002 || ev.addr >= maxDest) continue; // land in RAM only

    const existing = open.get(ev.addr);
    if (existing) {
      // Extend: consume the byte, advance the key to the next expected address.
      open.delete(ev.addr);
      existing.bytes.push(ev.value);
      existing.nextAddr = ev.addr + 1;
      existing.cycleEnd = ev.cycle;
      // Collision guard: if another run already occupies nextAddr, close it first.
      const clash = open.get(existing.nextAddr);
      if (clash) { open.delete(existing.nextAddr); complete(clash); }
      open.set(existing.nextAddr, existing);
    } else {
      const run: Run = {
        startAddr: ev.addr,
        nextAddr: ev.addr + 1,
        bytes: [ev.value],
        cycleStart: ev.cycle,
        cycleEnd: ev.cycle,
      };
      const clash = open.get(run.nextAddr);
      if (clash) { open.delete(run.nextAddr); complete(clash); }
      open.set(run.nextAddr, run);
      if (open.size > MAX_OPEN_RUNS) evictOldest();
    }
  }
  for (const r of open.values()) complete(r);

  // Emission order: by start cycle (open-map iteration is insertion order, not cycle).
  completed.sort((a, b) => a.cycleStart - b.cycleStart);

  // Count transfer reads in [start, end] via binary search over the sorted cycle list.
  const countTransfer = (start: number, end: number): number => {
    const lo = lowerBound(transferCycles, start);
    const hi = upperBound(transferCycles, end);
    return hi - lo;
  };

  const out: LandingMapEntry[] = [];
  for (const run of completed) {
    const transferReads = countTransfer(run.cycleStart, run.cycleEnd);
    // Dataflow gate: no transfer reads in the window ⇒ this is a memory-copy /
    // relocation of already-resident bytes, not a disk landing. Drop it.
    if (transferReads < minTransferReads) continue;
    const source = nearestPrecedingRead(readSet, run.cycleStart);
    const buf = Uint8Array.from(run.bytes);
    out.push({
      source: source ? { halftrack: source.halftrack, track: source.track, sector: source.sector } : null,
      c64Dest: run.startAddr,
      len: run.bytes.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      cycleStart: run.cycleStart,
      transferReads,
    });
  }
  return out;
}

/** Nearest BLOCK_READ with cycle ≤ `cycle` (the block being transferred as this run
 *  filled). Best-effort DEST→SOURCE hint; the read-set is the validation authority. */
function nearestPrecedingRead(readSet: ReadSetEntry[], cycle: number): ReadSetEntry | null {
  let best: ReadSetEntry | null = null;
  for (const r of readSet) {
    if (r.cycle <= cycle) best = r;
    else break; // readSet is cycle-ascending
  }
  return best;
}

/** First index with arr[i] >= x. */
function lowerBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
/** First index with arr[i] > x. */
function upperBound(arr: number[], x: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Read the READ-SET from a `.c64retrace` binary capture file (a trace armed with the
 * drive-mechanism + drive8-cpu + memory domains). The authority for validate_extraction.
 */
export function readSetFromCaptureFile(path: string): ReadSetEntry[] {
  const buf = new Uint8Array(readFileSync(path));
  const { version, headerLen } = decodeFileHeader(buf);
  const events = decodeEventStream(buf, headerLen, version);
  return buildReadSet(events);
}

/**
 * Build the landing map from a `.c64retrace` binary capture file (the loader-lens
 * capture). Reads + decodes the whole event stream, then correlates (see buildLandingMap).
 */
export function landingMapFromCaptureFile(path: string, opts: LandingMapOptions = {}): LandingMapEntry[] {
  // Copy into a fresh 0-offset buffer (Node Buffer pools share an ArrayBuffer).
  const buf = new Uint8Array(readFileSync(path));
  const { version, headerLen } = decodeFileHeader(buf);
  const events = decodeEventStream(buf, headerLen, version);
  return buildLandingMap(events, opts);
}
