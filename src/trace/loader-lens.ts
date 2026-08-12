// Spec 784 A2 — the loader-lens landing map + read-set.  Spec 785 C2 — the CART lane.
//
// THE net-new linkage: recover, from a loader-scoped capture, WHICH physical medium
// block the REAL loader read and WHERE its bytes came to rest in C64 RAM — the ground
// truth a per-project extractor's manifest is validated against (B4). Because the real
// loader decides, a wrong STATIC interpretation (relocator / depacker / copy-loop) is
// caught.
//
// **WHAT A READ-SET PROVES (Spec 785 §2.1 — binding on every caller).** It proves USED
// and it never proves UNUSED. A run that did not reach level 90 says nothing about the
// block level 90 needs. It is a LOWER BOUND on ONE run, so every surface built on it
// says "used in run X" / "not seen in run X" — never a bare "used" / "unused".
//
// Three lanes, three truths:
//
//  1. DISK READ-SET (buildReadSet) — the disk AUTHORITY. From the BLOCK_READ (0x35)
//     stream the TRX64 drive emits: one record per physical (track, sector) the drive
//     actually LATCHED GCR bytes off (read_pra/GCR_read), in read order. This is what
//     validate_extraction diffs a disk manifest against. It does NOT depend on the
//     C64-side write timeline, so buffering / relocation cannot corrupt it.
//
//  1b. CART READ-SET (buildCartReadSet) — the cartridge AUTHORITY, Spec 785 C1/C2. From
//     the CART_READ (0x36) stream: one record per BANK RESIDENCY — while `bank` served
//     `slot`, the CPU read `bytes` bytes out of it, touching window offsets
//     offLo..=offHi. Chip-side truth at the read, so it does not care whether or when
//     the C64 copied anything anywhere. Two producer facts every reader must honour:
//       (a) `offLo..offHi` is a BOUNDING range, not a coverage set. The residency
//           records the min/max offset touched; offsets inside it are NOT individually
//           proven read. When `bytes` < the range width the residency is SPARSE (a LUT
//           scan is the canonical case) and containment inside the range is a weak
//           signal, not proof — `cartBankUsage` flags it.
//       (b) The producer DRAINS periodically, closing live residencies, so one
//           uninterrupted walk through a bank arrives as several consecutive records
//           for the same (bank, slot) whose ranges abut. Aggregate by (bank, slot)
//           before drawing any conclusion — `cartBankUsage` does.
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

import { TraceOp, ACCESS_WRITE, ACCESS_READ, decodeFileHeader, decodeEventStream, type DecodedEvent, type TraceFileMeta } from "./binary-format.js";
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

/** One CART bank residency the CPU actually read out of (Spec 785 C1, CART_READ 0x36).
 *  Producer semantics — see the file header: `offLo..offHi` BOUNDS the offsets touched
 *  (it is not a coverage set), `bytes` counts SERVED reads including repeats and opcode
 *  fetches, and one walk may arrive as several consecutive records because the producer
 *  drains periodically. Aggregate with `cartBankUsage` before concluding anything. */
export interface CartReadSetEntry {
  /** Bank that served the window during this residency. */
  bank: number;
  /** 0 = ROML $8000-$9FFF, 1 = ROMH $A000-$BFFF / $E000-$FFFF (ultimax). */
  slot: number;
  /** `slot` rendered — "ROML" / "ROMH" / "slot<n>". */
  slotName: string;
  /** Lowest / highest 8K-window offset touched, inclusive. A BOUNDING range. */
  offLo: number;
  offHi: number;
  /** Served reads during the residency (repeats + opcode fetches included). */
  bytes: number;
  /** C64 master clock of the residency's FIRST served read. */
  cycle: number;
}

/** Where a landed run's bytes came from. Tagged so a consumer can tell the media
 *  apart without sniffing fields (Spec 785 C2 — before this it was disk-shaped only).
 *  The disk variant carries exactly the fields it always did. */
export type LandingSource =
  | { medium: "disk"; halftrack: number; track: number; sector: number }
  | { medium: "cart"; bank: number; slot: number; slotName: string; offLo: number; offHi: number };

export interface LandingMapEntry {
  /** Where the bytes came FROM on the medium (FIFO-matched read-set entry; null if
   *  no medium read preceded this landing — e.g. a capture without the BLOCK_READ /
   *  CART_READ lane). Disk is matched first (a run that passed the $DD00 dataflow gate
   *  IS a disk landing); the cart residency active at the run's start is the fallback
   *  when the capture carries no disk lane at all. */
  source: LandingSource | null;
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

/** Lane slot code → name. 0/1 are the only codes the producer emits. */
export function cartSlotName(slot: number): string {
  return slot === 0 ? "ROML" : slot === 1 ? "ROMH" : `slot${slot}`;
}

/**
 * Build the CART READ-SET (the cartridge authority) from a decoded event stream: the
 * ordered list of bank residencies the CPU actually read out of (CART_READ 0x36,
 * Spec 785 C1). Chip-side truth, loader-agnostic — it does not depend on the C64 ever
 * copying the bytes anywhere, so a depacker or a relocator cannot corrupt it.
 *
 * RAW records, in producer order. It proves USED-IN-THIS-RUN and never UNUSED (§2.1),
 * and it is not a coverage set: see the file header for the bounding-range and
 * drain-splitting caveats, and use `cartBankUsage` to aggregate.
 */
export function buildCartReadSet(events: DecodedEvent[]): CartReadSetEntry[] {
  const out: CartReadSetEntry[] = [];
  for (const ev of events) {
    if (ev.op !== TraceOp.CART_READ) continue;
    if (ev.bank === undefined || ev.slot === undefined) continue;
    if (ev.offLo === undefined || ev.offHi === undefined) continue;
    out.push({
      bank: ev.bank,
      slot: ev.slot,
      slotName: cartSlotName(ev.slot),
      offLo: ev.offLo,
      offHi: ev.offHi,
      bytes: ev.bytes ?? 0,
      cycle: ev.cycle,
    });
  }
  return out;
}

export interface CartOffsetRange { offLo: number; offHi: number }

/** What one (bank, slot) was read as, across the whole capture.
 *
 *  TWO range sets, because one cannot carry both meanings and the difference between
 *  them decides what a caller is allowed to conclude:
 *
 *   - `ranges` is the OUTER BOUND. Every offset read in this run lies inside it, so a
 *     span outside it was definitely not read. It is a hull, not a coverage set: the
 *     producer records min/max per residency, so scattered reads at $0700 and $1054
 *     arrive as one range spanning everything between.
 *   - `solidRanges` is the LOWER BOUND — merged from only those residencies that served
 *     at least as many reads as their range spans, which is what a contiguous sweep
 *     looks like. This is the only evidence strong enough to say the loader WALKED a
 *     region; a hull overlap can be coincidence.
 *
 *  Measured, and the reason this split exists: on one proof cartridge four residencies
 *  in one bank each served ~60-240 reads over a ~2200-offset hull, 13 million cycles
 *  after the loader's chunk stream had finished. Their hull overlapped an unrelated
 *  payload's span, and treating that as "the run read this payload" flagged a
 *  byte-verified manifest as wrong. */
export interface CartBankUsage {
  bank: number;
  slot: number;
  slotName: string;
  /** Merged, disjoint, ascending BOUNDING ranges (the outer bound). Abutting
   *  residencies — the producer's drain split, or a walk resumed at the next
   *  offset — collapse into one. */
  ranges: CartOffsetRange[];
  /** Merged ranges of the residencies that look like full sweeps (the lower bound). */
  solidRanges: CartOffsetRange[];
  /** Served reads summed over every residency of this (bank, slot). */
  bytes: number;
  /** Residency records that fed this entry. */
  residencies: number;
  /** Of those, how many looked like full sweeps. */
  solidResidencies: number;
  /** Total width of `ranges` in window offsets. */
  rangeWidth: number;
  /** Total width of `solidRanges`. */
  solidWidth: number;
  /** `bytes` < `rangeWidth` — fewer reads were served than the bounding range spans, so
   *  the range is demonstrably NOT fully covered (a LUT scan reading scattered rows is
   *  the canonical case). Containment inside a sparse range is a weak signal, not proof. */
  sparse: boolean;
  firstCycle: number;
  lastCycle: number;
}

/** Merge overlapping AND abutting (`offLo === last.offHi + 1`) ranges: a walk resumed
 *  after a producer drain is one read, not two. Input need not be sorted. */
function mergeRanges(input: CartOffsetRange[]): CartOffsetRange[] {
  const sorted = [...input].sort((a, b) => a.offLo - b.offLo || a.offHi - b.offHi);
  const out: CartOffsetRange[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && e.offLo <= last.offHi + 1) {
      if (e.offHi > last.offHi) last.offHi = e.offHi;
    } else {
      out.push({ offLo: e.offLo, offHi: e.offHi });
    }
  }
  return out;
}

const width = (rs: CartOffsetRange[]) => rs.reduce((n, r) => n + (r.offHi - r.offLo + 1), 0);

/**
 * Aggregate a raw cart read-set by (bank, slot): merge the bounding ranges, separate out
 * the full-sweep ones, sum the served reads. This is the form every consumer should
 * reason over — it undoes the producer's drain-splitting (see the file header) and it is
 * what `validate_extraction` diffs a manifest's slot spans against.
 */
export function cartBankUsage(entries: CartReadSetEntry[]): CartBankUsage[] {
  const byKey = new Map<string, CartReadSetEntry[]>();
  for (const e of entries) {
    const key = `${e.bank}/${e.slot}`;
    const list = byKey.get(key);
    if (list) list.push(e); else byKey.set(key, [e]);
  }
  const out: CartBankUsage[] = [];
  for (const list of byKey.values()) {
    const ranges = mergeRanges(list);
    // A residency serving at least as many reads as its range spans is consistent with
    // a contiguous sweep; one serving far fewer is a hull around scattered reads.
    const solid = list.filter((e) => e.bytes >= e.offHi - e.offLo + 1);
    const solidRanges = mergeRanges(solid);
    const bytes = list.reduce((n, e) => n + e.bytes, 0);
    const rangeWidth = width(ranges);
    out.push({
      bank: list[0].bank,
      slot: list[0].slot,
      slotName: list[0].slotName,
      ranges,
      solidRanges,
      bytes,
      residencies: list.length,
      solidResidencies: solid.length,
      rangeWidth,
      solidWidth: width(solidRanges),
      sparse: bytes < rangeWidth,
      firstCycle: Math.min(...list.map((e) => e.cycle)),
      lastCycle: Math.max(...list.map((e) => e.cycle)),
    });
  }
  out.sort((a, b) => a.firstCycle - b.firstCycle || a.bank - b.bank || a.slot - b.slot);
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
  // Spec 785 C2 — cart residencies, for source attribution on a capture with no disk
  // lane. Empty on every disk capture, so the disk path below is bit-for-bit unchanged.
  const cartReadSet = buildCartReadSet(events);

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
    const source = landingSource(readSet, cartReadSet, run.cycleStart);
    const buf = Uint8Array.from(run.bytes);
    out.push({
      source,
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

/** The cart residency that had already started by `cycle` (largest start cycle ≤ it).
 *  Max-scan rather than first-past-the-post so it does not assume record order. */
function activeCartResidency(cartReadSet: CartReadSetEntry[], cycle: number): CartReadSetEntry | null {
  let best: CartReadSetEntry | null = null;
  for (const r of cartReadSet) {
    if (r.cycle <= cycle && (best === null || r.cycle > best.cycle)) best = r;
  }
  return best;
}

/**
 * Attribute a landed run to a medium. Disk wins whenever a BLOCK_READ preceded the run:
 * the run only got here by passing the $DD00 dataflow gate, which IS the disk-transfer
 * evidence. The cart residency is the fallback for a capture carrying no disk lane.
 *
 * Spec 785 C2, stated because it bounds what this can mean: a cart landing has no
 * dataflow gate of its own. On disk, "$DD00 was read in this window" separates a
 * transfer from a memory-copy; on a cartridge the equivalent question — "was a bank
 * being read while this run filled" — is answered YES for every cycle of a title that
 * EXECUTES out of a bank, so it separates nothing. Cart source attribution here is
 * therefore a hint (which bank was live), never the proof the disk path's is; the cart
 * READ-SET, not this map, is what validate_extraction diffs a cart manifest against.
 */
function landingSource(
  readSet: ReadSetEntry[], cartReadSet: CartReadSetEntry[], cycle: number,
): LandingSource | null {
  const disk = nearestPrecedingRead(readSet, cycle);
  if (disk) {
    return { medium: "disk", halftrack: disk.halftrack, track: disk.track, sector: disk.sector };
  }
  const cart = activeCartResidency(cartReadSet, cycle);
  if (cart) {
    return {
      medium: "cart", bank: cart.bank, slot: cart.slot, slotName: cart.slotName,
      offLo: cart.offLo, offHi: cart.offHi,
    };
  }
  return null;
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
 * Read the CART READ-SET from a `.c64retrace` binary capture file — a trace armed with
 * the `cart-read` domain (`trx64cli boot --trace <path> --trace-domains cart-read`, or
 * `runtime_trace_start domains=[...,'cart-read']` on the daemon). The cartridge
 * authority for validate_extraction. Empty on a capture that never armed the lane.
 */
export function cartReadSetFromCaptureFile(path: string): CartReadSetEntry[] {
  const buf = new Uint8Array(readFileSync(path));
  const { version, headerLen } = decodeFileHeader(buf);
  const events = decodeEventStream(buf, headerLen, version);
  return buildCartReadSet(events);
}

/** The capture's own identity block (`TraceFileMeta`) — used to say WHICH run a
 *  "used in run X" claim refers to, and to catch a manifest bound to a different
 *  image than the one that ran (Spec 785 §4.1). */
export function captureMetaFromFile(path: string): TraceFileMeta {
  const buf = new Uint8Array(readFileSync(path));
  return decodeFileHeader(buf).meta;
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
