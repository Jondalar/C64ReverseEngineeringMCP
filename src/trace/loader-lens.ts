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
//  1. DISK READ-SET (buildReadSet) — the disk AUTHORITY. From the BLOCK_READ2 (0x37)
//     stream the TRX64 drive emits (Spec 907): one record per (half-track, sector) VISIT
//     the drive actually LATCHED GCR bytes off, credited to the sector whose header the
//     head last passed, header bytes and data bytes told apart (a visit with header bytes
//     only PASSED the sector, it did not take it). Each record carries two clocks and no
//     offset relates them (the drive runs at its own rate and restarts at 0 on a reset):
//     `cycle` of a ReadSetEntry is the C64 clock, the one to compare with C64 events.
//     Old captures carry BLOCK_READ (0x35) instead: drive clock only, credit may be off
//     by one sector (the next header ahead), no header/data split — still read, flagged
//     `record: "block-read"`, and the answer says so (`readSetNote`). This is what
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
//     which RAM address each transferred payload landed at. Rebuilt (Spec 784 Option A,
//     Spec 907 D1) to defeat the defects the original write-time correlation had:
//       (a) Multi-stream run builder — a landing survives interleaved scratch writes
//           (KERNAL jiffy $A0-$A2, IRQ) instead of being flushed at the first gap. Runs
//           are followed in BOTH directions (a `dey / sta (zp),y` copy walks downward);
//           a run is reported at its lowest address, bytes in address order.
//           A run ends when it has been idle for RUN_MAX_GAP cycles: a store to its next
//           address after that starts a new run (an unpacker's output run used to stay
//           open for tens of millions of cycles and absorb a byte of a later landing).
//       (b) Dataflow gate — a run counts as a disk-landing if most of ITS OWN stores came
//           within a few cycles after a transfer read ($DD00 access) — reads that merely
//           fall inside the run's lifespan prove nothing — or if it is a 1:1 copy (constant
//           XOR over >= 90 % of its bytes, each store within a few cycles of the read) out
//           of page-1 bytes a transfer pushed (the copy's pulls are ordinary reads of
//           $0100-$01FF; a capture that does not record them cannot be followed, and the
//           answer says so). A pure memory-copy (relocator moving already-loaded bytes)
//           or depack has no transfer read near its stores and reads no transfer-written
//           stack bytes → dropped. This is what killed the old 78×T35 false map.
//       (c) Page 1 is the stack. A transfer run lying wholly in it is a buffer, never a
//           landing; it is listed under the destination it was copied to, or on its own
//           as kind "buffer" when no copy was followed.
//       (d) Source by READ time — a landing's source block is matched against the
//           BLOCK_READ stream by cycle, NOT the head position at WRITE time (which,
//           under buffering, is a rotated-past sector, not the one that was read). For a
//           copy out of a buffer the cycle is when the buffer was filled.

import {
  streamCaptureEvents,
  readCaptureHeader,
} from "./capture-stream.js";
import { TraceOp, ACCESS_WRITE, ACCESS_READ, type DecodedEvent, type TraceFileMeta } from "./binary-format.js";
import { createHash } from "node:crypto";

/** One physical block the drive actually READ (Spec 784 read-set; Spec 907 BLOCK_READ2 0x37,
 *  or the legacy BLOCK_READ 0x35). */
export interface ReadSetEntry {
  halftrack: number;
  track: number;
  /** 0xff (BLOCK_READ2 only) = the half-track has no header; every byte is data. */
  sector: number;
  /** GCR bytes the drive latched off this (halftrack, sector) in this visit (header + data). */
  bytes: number;
  /** The clock to compare with C64-side events. BLOCK_READ2: the C64 clock at the sample.
   *  Legacy BLOCK_READ: the DRIVE clock, which is not comparable with the C64's after a
   *  drive reset (and runs at another rate anyway). */
  cycle: number;
  record: "block-read2" | "block-read";
  /** BLOCK_READ2 only: the drive clock of the same sample (drive-side joins). */
  drvCycle?: number;
  headerBytes?: number;
  dataBytes?: number;
  /** The visit took the sector's data. BLOCK_READ2: dataBytes >= TAKEN_MIN_DATA_BYTES
   *  (most of the data block; header bytes only, or the 1-2 bytes a sync hunt latches after
   *  the data sync, = the head passed the sector); sector 0xff: dataBytes > 0. Legacy:
   *  always true, the record cannot tell. */
  taken: boolean;
}

/** GCR bytes of one 1541 data block after its sync: 260 decoded bytes (block id $07,
 *  256 data, checksum, 2 off bytes) x 5/4. */
export const GCR_DATA_BLOCK_BYTES = 325;

/** A BLOCK_READ2 visit of a sector WITH a header took its data only when the drive latched
 *  MORE THAN HALF of the 325-byte GCR data block. The producer counts every byte latched
 *  after the data sync as data, so a loader that hunts for the next header sync and
 *  rejects the data block after its first byte or two (the block id) leaves a record with
 *  dataBytes 1 or 2 — a pass, not a read (#77: IM II, 905 of 1282 records were d1/d2;
 *  every real read was d324/d326). A loader reading the sector's data reads all of it
 *  (>= 321 bytes even when it skips the checksum), so half a block keeps every genuine
 *  read and also drops a loader that checks a few bytes after each sync before giving up.
 *  Sector 0xff (no header: the producer has no block length to measure against) keeps
 *  dataBytes > 0. */
export const TAKEN_MIN_DATA_BYTES = Math.floor(GCR_DATA_BLOCK_BYTES / 2) + 1;

/** Passed vs taken for one BLOCK_READ2 visit (see TAKEN_MIN_DATA_BYTES). */
export function blockRead2Taken(sector: number, dataBytes: number): boolean {
  if (sector === 0xff) return dataBytes > 0;
  return dataBytes >= TAKEN_MIN_DATA_BYTES;
}

/** The caveat a read-set carries when it includes legacy BLOCK_READ (0x35) records, else
 *  null. Every surface that prints a read-set fact must print this with it. */
export function readSetNote(readSet: ReadSetEntry[]): string | null {
  if (!readSet.some((e) => e.record === "block-read")) return null;
  return "this capture carries legacy BLOCK_READ (0x35) records: the sector credit may be off by one (the next sector ahead of the head) and the drive clock may not be comparable with the C64 clock after a drive reset — re-capture with a TRX64 that emits BLOCK_READ2 (0x37) for a sector-exact read-set";
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
  /** `landing` — bytes a transfer delivered to their destination. `buffer` — a run the
   *  transfer filled in page 1 (the stack) that no destination was followed out of: a
   *  scratch buffer, listed so a loader that really lands in page 1 stays visible. A
   *  buffer that WAS followed to a destination is not listed; it is that landing's
   *  `viaBuffer`. */
  kind: "landing" | "buffer";
  /** Where the bytes came FROM on the medium (FIFO-matched read-set entry; null if
   *  no medium read preceded this landing — e.g. a capture without the BLOCK_READ /
   *  CART_READ lane). Disk is matched first (a run that passed the $DD00 dataflow gate
   *  IS a disk landing); the cart residency active at the run's start is the fallback
   *  when the capture carries no disk lane at all. */
  source: LandingSource | null;
  /** Where they LANDED in C64 RAM — the LOWEST address of the run, whichever way the
   *  loader walked it (the sha256 and `len` are over the bytes in address order). */
  c64Dest: number;
  /** Byte length of the run. */
  len: number;
  /** sha256 of the landed bytes (hex) — the identity the manifest span must match. */
  sha256: string;
  /** Cycle the run began landing. */
  cycleStart: number;
  /** Transfer reads ($DD00 accesses) observed between this run's first and last store (a
   *  buffered copy: the buffer's span). Informational; the gate itself counts the run's
   *  own stores that followed a transfer read. */
  transferReads: number;
  /** Landings only: the page-1 buffer the bytes were copied out of (1:1, constant XOR,
   *  within a few cycles of the buffer read). Absent when the bytes landed directly. */
  viaBuffer?: { addr: number; len: number };
  /** Buffers only: how many runs of this address and length the capture held (a loader
   *  that buffers one sector at a time fills the same page once per sector). */
  repeats?: number;
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

/** An incremental consumer of the event stream. A `.c64retrace` is routinely
 *  multi-gigabyte, so every builder here is a fold: it sees each event once and
 *  keeps only what it needs. The array-taking `build*` wrappers below are the same
 *  fold fed from memory, for callers that already hold a decoded stream. */
export interface Fold<T> {
  push(ev: DecodedEvent): void;
  finish(): T;
}

function runFold<T>(fold: Fold<T>, events: DecodedEvent[]): T {
  for (const ev of events) fold.push(ev);
  return fold.finish();
}

/** A landing map is a handful of runs. Past this the capture is a firehose and the
 *  answer would be noise anyway — fail loudly rather than grow until the process dies.
 *  Env-overridable so a gate can reach the error path without a 2 GB fixture. */
const MAX_COMPLETED_RUNS = Math.max(1, Number(process.env.C64RE_MAX_LANDING_RUNS) || 250_000);

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
export function newReadSetFold(): Fold<ReadSetEntry[]> {
  const out: ReadSetEntry[] = [];
  return {
    push(ev) {
      if (ev.op !== TraceOp.BLOCK_READ && ev.op !== TraceOp.BLOCK_READ2) return;
      if (ev.halftrack === undefined || ev.sector === undefined) return;
      if (ev.op === TraceOp.BLOCK_READ2) {
        out.push({
          halftrack: ev.halftrack,
          track: halftrackToTrack(ev.halftrack),
          sector: ev.sector,
          bytes: ev.bytes ?? 0,
          cycle: ev.c64Cycle ?? ev.cycle,
          record: "block-read2",
          drvCycle: ev.cycle,
          headerBytes: ev.headerBytes ?? 0,
          dataBytes: ev.dataBytes ?? 0,
          taken: blockRead2Taken(ev.sector, ev.dataBytes ?? 0),
        });
        return;
      }
      out.push({
        halftrack: ev.halftrack,
        track: halftrackToTrack(ev.halftrack),
        sector: ev.sector,
        bytes: ev.bytes ?? 0,
        cycle: ev.cycle,
        record: "block-read",
        taken: true,
      });
    },
    finish: () => out,
  };
}

export function buildReadSet(events: DecodedEvent[]): ReadSetEntry[] {
  return runFold(newReadSetFold(), events);
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
export function newCartReadSetFold(): Fold<CartReadSetEntry[]> {
  const out: CartReadSetEntry[] = [];
  return {
    push(ev) {
      if (ev.op !== TraceOp.CART_READ) return;
      if (ev.bank === undefined || ev.slot === undefined) return;
      if (ev.offLo === undefined || ev.offHi === undefined) return;
      out.push({
        bank: ev.bank,
        slot: ev.slot,
        slotName: cartSlotName(ev.slot),
        offLo: ev.offLo,
        offHi: ev.offHi,
        bytes: ev.bytes ?? 0,
        cycle: ev.cycle,
      });
    },
    finish: () => out,
  };
}

export function buildCartReadSet(events: DecodedEvent[]): CartReadSetEntry[] {
  return runFold(newCartReadSetFold(), events);
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

/** What a run's bytes were copied out of: the transfer-written page-1 buffer. Filled
 *  only for runs outside page 1, one entry per destination write that followed. */
interface Provenance {
  /** Destination writes whose value came out of an intact, transfer-written buffer byte
   *  read within PROVENANCE_WINDOW cycles before the write. */
  hits: number;
  /** `value(write) XOR value(buffer byte)` of the first hit; -1 until there is one. */
  xor: number;
  /** Hits whose XOR differs from `xor` — a depacker / arithmetic copy, not a 1:1 move. */
  xorBroken: number;
  /** Transfer window the buffer bytes were written in. A write that follows a buffer
   *  from another window ends the run, so two sectors never fuse into one landing. */
  win: number;
  /** Earliest cycle a followed buffer byte was written — where the source is looked up. */
  srcCycle: number;
  /** The page-1 runs the followed bytes came from. */
  bufRuns: Set<Run>;
}

interface Run {
  /** First address written. */
  startAddr: number;
  /** Next address the run expects; meaningful for the direction once it is fixed. */
  nextAddr: number;
  /** 0 = one byte so far, +1 = ascending, -1 = descending. */
  dir: 0 | 1 | -1;
  /** Bytes in WRITE order (reversed into address order when the run is reported). */
  bytes: number[];
  cycleStart: number;
  cycleEnd: number;
  /** Writes of this run that came within TRANSFER_WRITE_WINDOW cycles after a transfer
   *  read — the bytes that were provably fed by the transfer, as opposed to the cycles
   *  the run merely spans. */
  fed: number;
  /** Keys under which the run sits in openUp / openDown, or -1. */
  upKey: number;
  downKey: number;
  prov: Provenance | null;
}

// Bounds the number of simultaneously-open write streams. Real loader traces keep 1-2
// active; the cap only backstops a pathological trace. When exceeded, the run with the
// oldest cycleEnd is evicted + emitted (it has gone stale).
const MAX_OPEN_RUNS = 256;

/** A write to page 1 counts as written DURING a transfer when a `$DD00` read happened at
 *  most this many cycles before it (a receive loop reads the port up to four times per
 *  byte, then pushes). */
const TRANSFER_WRITE_WINDOW = 64;
/** `$DD00` reads further apart than this belong to different transfer windows (the copy
 *  of a sector takes thousands of cycles, a receive loop's inter-byte gap tens). */
const TRANSFER_GAP = 1000;
/** A destination write follows a buffer read when the read came at most this many cycles
 *  before it (`pla / eor / dey / sta (zp),y` is ~11). */
const PROVENANCE_WINDOW = 16;
/** Share of a run's bytes that must be provably copied out of the buffer. */
const PROVENANCE_SHARE = 0.9;
/** A run is a direct disk landing when at least this share of ITS OWN writes followed a
 *  transfer read within TRANSFER_WRITE_WINDOW. Measured on Impossible Mission II: the
 *  direct title loads sit at 90-93 % (the rest are the stores after a track step), the
 *  RLE-unpacker output and the arithmetic scratch that used to pass the gate on the strength
 *  of unrelated `$DD00` reads inside their lifespan sit at 0 %. A majority is the line. */
const DIRECT_SHARE = 0.5;
/** A run whose next expected store comes later than this after its previous store is over;
 *  the store starts a new run. Without it a run stays open forever and a store to the next
 *  address, millions of cycles later, glues unrelated bytes onto a landing (a stale unpacker
 *  run grew by one main-game byte; the main-game copy then lost its first byte to it).
 *  The number is the drive's rotation: 1 revolution = 985248 Hz / 5 rev/s = 197050 cycles.
 *  The longest stall inside a genuine landing measured on a real loader capture (Impossible
 *  Mission II, direct title load across track steps) is 163596 cycles, below one revolution;
 *  two revolutions allow for one missed sector on top of it. Every gap that glued unrelated
 *  data there was above 1.4 million. */
const CYCLES_PER_REVOLUTION = 197_050;
const RUN_MAX_GAP = 2 * CYCLES_PER_REVOLUTION;
const PAGE1_LO = 0x0100;
const PAGE1_HI = 0x01ff;

/**
 * Build the landing map (DEST-side human view) from a decoded loader-lens event stream.
 * See the file header for the defects this rewrite defeats.
 *
 * Multi-stream: RAM writes are grouped into runs, ascending OR descending, keyed by the
 * next address each expects, so a run survives interleaved scratch writes. Two ways a run
 * is a landing: (1) dataflow gate — enough transfer reads ($DD00) fell in its cycle
 * window; (2) provenance — it is a 1:1 (constant-XOR) copy out of the page-1 bytes a
 * transfer pushed (a stack-buffered loader: receive → `pha`, then `pla` → store, with no
 * `$DD00` read near the store). A run lying wholly in page 1 is never a landing: it is
 * the buffer, listed as `kind:"buffer"` (once under the destination it was followed to,
 * else once per distinct address range). Source: each landing is matched to the nearest
 * preceding BLOCK_READ by cycle — of the buffer fill for a followed copy.
 */
export function newLandingMapFold(
  opts: LandingMapOptions = {},
): Fold<LandingMapEntry[]> & { stackNote(): string | null } {
  const minRunLen = opts.minRunLen ?? 16;
  const maxDest = opts.maxDest ?? 0xd000;
  const minTransferReads = opts.minTransferReads ?? 4;
  const transferReadAddr = opts.transferReadAddr ?? 0xdd00;

  // Completed runs (start/end cycle + bytes), collected in emission order.
  const completed: Run[] = [];
  // Open runs keyed by the address they expect next, one map per direction. A fresh
  // one-byte run sits in both; the first extension fixes its direction.
  const openUp = new Map<number, Run>();
  const openDown = new Map<number, Run>();
  const openAll = new Set<Run>();
  // Transfer-read cycles (sorted ascending by construction — events are in cycle order).
  const transferCycles: number[] = [];
  // The source lanes, folded in the SAME pass — a multi-gigabyte log is read once,
  // never three times (BUG-052).
  const readSetFold = newReadSetFold();
  const cartFold = newCartReadSetFold();

  // Transfer-window bookkeeping.
  let lastTransfer = -Infinity;
  let windowId = 0;
  // The page-1 buffer: per byte, the transfer window it was written in (-1 = not written
  // during a transfer, or since overwritten by something that was), value, write cycle,
  // and the run that wrote it.
  const bufWin = new Int32Array(256).fill(-1);
  const bufVal = new Uint8Array(256);
  const bufCycle = new Float64Array(256);
  const bufRun: Array<Run | null> = new Array(256).fill(null);
  // Page-1 reads that took an intact transfer-written byte, in the last PROVENANCE_WINDOW.
  interface BufRead { cycle: number; xorSrc: number; win: number; srcCycle: number; run: Run | null }
  let bufReads: BufRead[] = [];

  // Stores outside page 1 that followed a read of an intact transfer-written page-1 byte
  // (the copy-out of a stack buffer, whatever the transform). A capture that holds
  // transfer-filled page-1 buffers and next to none of these never recorded the copy-out.
  // A bare count of such page-1 READS would not do: an IRQ's RTI pulls the stack too, and
  // lands on transfer-written bytes by chance (444 of them in the IM II capture without
  // pulls) — none is followed by a store.
  let followedStores = 0;
  let unfollowedBuffers = false;

  const complete = (run: Run) => {
    if (!openAll.has(run)) return;
    if (run.upKey >= 0 && openUp.get(run.upKey) === run) openUp.delete(run.upKey);
    if (run.downKey >= 0 && openDown.get(run.downKey) === run) openDown.delete(run.downKey);
    run.upKey = run.downKey = -1;
    openAll.delete(run);
    if (run.bytes.length < minRunLen) return;
    if (completed.length >= MAX_COMPLETED_RUNS) {
      throw new Error(
        `loader-lens: this capture produced more than ${MAX_COMPLETED_RUNS} landing runs. ` +
          `That is a firehose, not a landing map — the trace almost certainly armed the ` +
          `whole 'memory' domain over a long session. Re-capture a narrower window ` +
          `(arm the load itself, not the boot and the menu around it), or raise minRunLen.`,
      );
    }
    completed.push(run);
  };

  const evictOldest = () => {
    let oldest: Run | null = null;
    for (const r of openAll) if (oldest === null || r.cycleEnd < oldest.cycleEnd) oldest = r;
    if (oldest) complete(oldest);
  };

  const register = (run: Run) => {
    if (run.dir !== -1) {
      run.upKey = run.dir === 1 ? run.nextAddr : run.startAddr + 1;
      const clash = openUp.get(run.upKey);
      if (clash && clash !== run) complete(clash);
      openUp.set(run.upKey, run);
    }
    if (run.dir !== 1) {
      run.downKey = run.dir === -1 ? run.nextAddr : run.startAddr - 1;
      const clash = openDown.get(run.downKey);
      if (clash && clash !== run) complete(clash);
      if (run.downKey >= 0) openDown.set(run.downKey, run);
    }
    openAll.add(run);
  };
  const unregister = (run: Run) => {
    if (run.upKey >= 0 && openUp.get(run.upKey) === run) openUp.delete(run.upKey);
    if (run.downKey >= 0 && openDown.get(run.downKey) === run) openDown.delete(run.downKey);
    run.upKey = run.downKey = -1;
  };

  /** The destination write (cycle, value) as a copy out of the buffer: the latest page-1
   *  read in the window, if any. */
  const followedRead = (cycle: number): BufRead | null => {
    let best: BufRead | null = null;
    for (const r of bufReads) if (r.cycle <= cycle && cycle - r.cycle <= PROVENANCE_WINDOW) best = r;
    return best;
  };

  const push = (ev: DecodedEvent): void => {
    readSetFold.push(ev);
    cartFold.push(ev);
    if (ev.op !== TraceOp.RAM_WRITE) return;
    if (ev.addr === undefined || ev.value === undefined) return;
    // RAM_WRITE carries reads AND writes (I/O comes through it too).
    if (ev.access === ACCESS_READ) {
      if (ev.addr === transferReadAddr) {
        // Transfer-read timeline: a READ of the fastloader/serial port = a byte pulled
        // from the drive.
        if (ev.cycle - lastTransfer > TRANSFER_GAP) windowId++;
        lastTransfer = ev.cycle;
        transferCycles.push(ev.cycle);
      } else if (ev.addr >= PAGE1_LO && ev.addr <= PAGE1_HI) {
        const i = ev.addr - PAGE1_LO;
        // A buffer byte counts only while it is intact and no later transfer window has
        // begun (that one is about to overwrite the buffer, so a read after it says
        // nothing about the window the byte was written in).
        if (bufWin[i] >= 0 && bufWin[i] === windowId && bufVal[i] === ev.value) {
          while (bufReads.length && ev.cycle - bufReads[0].cycle > PROVENANCE_WINDOW) bufReads.shift();
          bufReads.push({ cycle: ev.cycle, xorSrc: ev.value, win: bufWin[i], srcCycle: bufCycle[i], run: bufRun[i] });
        }
      }
      return;
    }
    if (ev.access !== ACCESS_WRITE) return;
    if (ev.addr < 0x0002 || ev.addr >= maxDest) return; // land in RAM only
    const addr = ev.addr;
    const inPage1 = addr >= PAGE1_LO && addr <= PAGE1_HI;

    // Provenance of a write OUTSIDE page 1.
    const follow = inPage1 ? null : followedRead(ev.cycle);
    if (follow) followedStores++;

    // Pick the run to extend: direction-fixed beats a one-byte run; ascending wins a tie.
    let up = openUp.get(addr);
    let down = openDown.get(addr);
    // A run that has been idle for longer than RUN_MAX_GAP is over, not extendable.
    if (up && ev.cycle - up.cycleEnd > RUN_MAX_GAP) { if (down === up) down = undefined; complete(up); up = undefined; }
    if (down && ev.cycle - down.cycleEnd > RUN_MAX_GAP) { complete(down); down = undefined; }
    const fed = ev.cycle - lastTransfer <= TRANSFER_WRITE_WINDOW;
    let existing: Run | undefined;
    if (up && down) existing = up.dir !== 0 ? up : down.dir !== 0 ? down : up;
    else existing = up ?? down;

    // A destination write following a different transfer window's buffer ends the run.
    if (existing && follow && existing.prov && existing.prov.hits > 0 && existing.prov.win !== follow.win) {
      complete(existing);
      existing = undefined;
    }

    let run: Run;
    if (existing) {
      run = existing;
      unregister(run);
      if (run.dir === 0) run.dir = up === run ? 1 : -1;
      run.bytes.push(ev.value);
      run.nextAddr = run.dir === 1 ? addr + 1 : addr - 1;
      run.cycleEnd = ev.cycle;
      if (fed) run.fed++;
      // A run that walked off the 16-bit address space is finished.
      if (run.nextAddr >= 0 && run.nextAddr <= 0xffff) register(run); else complete(run);
    } else {
      run = {
        startAddr: addr, nextAddr: addr, dir: 0, bytes: [ev.value],
        cycleStart: ev.cycle, cycleEnd: ev.cycle, fed: fed ? 1 : 0, upKey: -1, downKey: -1, prov: null,
      };
      register(run);
      if (openAll.size > MAX_OPEN_RUNS) evictOldest();
    }

    if (follow) {
      const p = run.prov ?? (run.prov = {
        hits: 0, xor: -1, xorBroken: 0, win: follow.win, srcCycle: Infinity, bufRuns: new Set(),
      });
      const x = (ev.value ^ follow.xorSrc) & 0xff;
      if (p.hits === 0) p.xor = x; else if (x !== p.xor) p.xorBroken++;
      p.hits++;
      if (follow.srcCycle < p.srcCycle) p.srcCycle = follow.srcCycle;
      if (follow.run) p.bufRuns.add(follow.run);
    }
    if (inPage1) {
      const i = addr - PAGE1_LO;
      bufWin[i] = fed ? windowId : -1;
      bufVal[i] = ev.value;
      bufCycle[i] = ev.cycle;
      bufRun[i] = run;
    }
  };
  const low = (r: Run) => (r.dir === -1 ? r.nextAddr + 1 : r.startAddr);
  const high = (r: Run) => (r.dir === 1 ? r.nextAddr - 1 : r.dir === -1 ? r.startAddr : r.startAddr);

  const finish = (): LandingMapEntry[] => {
    for (const r of [...openAll]) complete(r);
    openUp.clear(); openDown.clear(); openAll.clear();

    // Emission order: by start cycle (open-map iteration is insertion order, not cycle).
    completed.sort((a, b) => a.cycleStart - b.cycleStart);

    const readSet = readSetFold.finish();
    // Spec 785 C2 — cart residencies, for source attribution on a capture with no disk
    // lane. Empty on every disk capture, so the disk path below is bit-for-bit unchanged.
    const cartReadSet = cartFold.finish();

    // Count transfer reads in [start, end] via binary search over the sorted cycle list.
    const countTransfer = (start: number, end: number): number => {
      const lo = lowerBound(transferCycles, start);
      const hi = upperBound(transferCycles, end);
      return hi - lo;
    };
    const addressOrder = (r: Run) => (r.dir === -1 ? [...r.bytes].reverse() : r.bytes);

    // Pass 1 — classify. A run wholly in page 1 is a buffer candidate (it needs the
    // transfer evidence like any run); any other run is a landing by the gate or by
    // provenance.
    interface Landing { run: Run; transferReads: number; viaBuf: boolean }
    const landings: Landing[] = [];
    const buffers: Array<{ run: Run; transferReads: number }> = [];
    for (const run of completed) {
      const transferReads = countTransfer(run.cycleStart, run.cycleEnd);
      const direct = run.fed >= minTransferReads && run.fed >= DIRECT_SHARE * run.bytes.length;
      const lo = low(run), hi = high(run);
      if (lo >= PAGE1_LO && hi <= PAGE1_HI) {
        // Page 1 is the stack. A transfer filling it is a buffer, never a landing.
        if (direct) buffers.push({ run, transferReads });
        continue;
      }
      const p = run.prov;
      const viaBuf = !!p && p.hits >= PROVENANCE_SHARE * run.bytes.length && p.xorBroken === 0 && p.bufRuns.size > 0;
      // Dataflow gate: no transfer reads in the window and not a 1:1 copy of transferred
      // bytes ⇒ a memory-copy / relocation / depack of resident bytes, not a disk landing.
      if (!direct && !viaBuf) continue;
      landings.push({ run, transferReads, viaBuf });
    }

    const out: LandingMapEntry[] = [];
    const followed = new Set<Run>();
    for (const l of landings) {
      const { run } = l;
      let transferReads = l.transferReads;
      let viaBuffer: { addr: number; len: number } | undefined;
      let srcCycle = run.cycleStart;
      if (l.viaBuf && run.prov) {
        // The transfer evidence lives in the buffer's window, not in the copy's.
        let bLo = 0xffff, bHi = 0, c0 = Infinity, c1 = -Infinity;
        for (const b of run.prov.bufRuns) {
          followed.add(b);
          bLo = Math.min(bLo, low(b)); bHi = Math.max(bHi, high(b));
          c0 = Math.min(c0, b.cycleStart); c1 = Math.max(c1, b.cycleEnd);
        }
        viaBuffer = { addr: bLo, len: bHi - bLo + 1 };
        transferReads = Math.max(transferReads, countTransfer(c0, c1));
        srcCycle = run.prov.srcCycle;
      }
      const buf = Uint8Array.from(addressOrder(run));
      out.push({
        kind: "landing",
        source: landingSource(readSet, cartReadSet, srcCycle),
        c64Dest: low(run),
        len: run.bytes.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
        cycleStart: run.cycleStart,
        transferReads,
        ...(viaBuffer ? { viaBuffer } : {}),
      });
    }

    // Pass 2 — buffers nobody followed into a destination: kept visible, once per
    // distinct address range (a sector-per-run loader fills the same page 100 times).
    const seen = new Map<string, LandingMapEntry>();
    for (const b of buffers) {
      if (followed.has(b.run)) continue;
      const key = `${low(b.run)}/${b.run.bytes.length}`;
      const prior = seen.get(key);
      if (prior) { prior.repeats = (prior.repeats ?? 1) + 1; continue; }
      const buf = Uint8Array.from(addressOrder(b.run));
      const entry: LandingMapEntry = {
        kind: "buffer",
        source: landingSource(readSet, cartReadSet, b.run.cycleStart),
        c64Dest: low(b.run),
        len: b.run.bytes.length,
        sha256: createHash("sha256").update(buf).digest("hex"),
        cycleStart: b.run.cycleStart,
        transferReads: b.transferReads,
        repeats: 1,
      };
      seen.set(key, entry);
      out.push(entry);
    }
    unfollowedBuffers = out.some((e) => e.kind === "buffer");
    out.sort((a, b) => a.cycleStart - b.cycleStart);
    return out;
  };

  /** Valid after finish(): non-null when the capture holds transfer-filled page-1 buffers
   *  nobody was followed out of AND (almost) no store anywhere followed a read of a
   *  transfer-written page-1 byte. A loader that copies its stack buffer out with pulls
   *  leaves such stores; their total absence says the copy-out was not recorded (TRX64 up
   *  to 0.13.1 did not emit stack pulls), so the destinations of those buffers are unknown,
   *  not absent. */
  const stackNote = (): string | null => {
    if (followedStores >= minRunLen || !unfollowedBuffers) return null;
    return "this capture holds page-1 buffers filled by the transfer, but no store anywhere followed a read of one of their bytes: the stack pulls that copy a buffer out were not recorded (TRX64 up to 0.13.1 does not emit them). Where those buffers were copied to is NOT in this capture — re-capture with TRX64 0.13.2 or later; the buffers below are unfollowed because the data is missing, not because the loader never moved them";
  };

  return { push, finish, stackNote };
}

export function buildLandingMap(events: DecodedEvent[], opts: LandingMapOptions = {}): LandingMapEntry[] {
  return runFold(newLandingMapFold(opts), events);
}

/** Nearest BLOCK_READ/BLOCK_READ2 that took data, with cycle ≤ `cycle` (the block being transferred as this run
 *  filled). Best-effort DEST→SOURCE hint; the read-set is the validation authority. */
function nearestPrecedingRead(readSet: ReadSetEntry[], cycle: number): ReadSetEntry | null {
  let best: ReadSetEntry | null = null;
  for (const r of readSet) {
    if (r.cycle > cycle) break; // readSet is cycle-ascending (C64 clock for BLOCK_READ2)
    if (r.taken) best = r;      // a sector the head only passed is not a source
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
  const fold = newReadSetFold();
  streamCaptureEvents(path, (ev) => fold.push(ev));
  return fold.finish();
}

/**
 * Read the CART READ-SET from a `.c64retrace` binary capture file — a trace armed with
 * the `cart-read` domain (`trx64cli boot --trace <path> --trace-domains cart-read`, or
 * `runtime_trace_start domains=[...,'cart-read']` on the daemon). The cartridge
 * authority for validate_extraction. Empty on a capture that never armed the lane.
 */
export function cartReadSetFromCaptureFile(path: string): CartReadSetEntry[] {
  const fold = newCartReadSetFold();
  streamCaptureEvents(path, (ev) => fold.push(ev));
  return fold.finish();
}

/** Both read-sets, the landing map and the identity block from ONE pass.
 *  `validate_extraction` needs all of them; reading a 2 GB log several times is that many
 *  times the wait for the same bytes. The landing map is best-effort here: on a capture
 *  that is a firehose (more runs than MAX_COMPLETED_RUNS) it comes back `null` with the
 *  reason, and the read-set lanes — which never depended on it — are unaffected. */
export function readSetsFromCaptureFile(path: string): {
  readSet: ReadSetEntry[];
  cartReadSet: CartReadSetEntry[];
  landings: LandingMapEntry[] | null;
  landingsError?: string;
  /** See newLandingMapFold's stackNote: the capture lacks the stack pulls. */
  stackNote: string | null;
  meta: TraceFileMeta;
} {
  const disk = newReadSetFold();
  const cart = newCartReadSetFold();
  const land = newLandingMapFold();
  let landingsError: string | undefined;
  const { meta } = streamCaptureEvents(path, (ev) => {
    disk.push(ev); cart.push(ev);
    if (landingsError === undefined) {
      try { land.push(ev); } catch (e) { landingsError = e instanceof Error ? e.message : String(e); }
    }
  });
  let landings: LandingMapEntry[] | null = null;
  if (landingsError === undefined) {
    try { landings = land.finish(); } catch (e) { landingsError = e instanceof Error ? e.message : String(e); }
  }
  return { readSet: disk.finish(), cartReadSet: cart.finish(), landings, landingsError, stackNote: landings ? land.stackNote() : null, meta };
}

/** The capture's own identity block (`TraceFileMeta`) — used to say WHICH run a
 *  "used in run X" claim refers to, and to catch a manifest bound to a different
 *  image than the one that ran (Spec 785 §4.1). Reads the header, not the log. */
export function captureMetaFromFile(path: string): TraceFileMeta {
  return readCaptureHeader(path).meta;
}

/**
 * Build the landing map from a `.c64retrace` binary capture file (the loader-lens
 * capture). Streams the event stream once and folds as it goes (see newLandingMapFold).
 */
export function landingMapFromCaptureFile(path: string, opts: LandingMapOptions = {}): LandingMapEntry[] {
  const fold = newLandingMapFold(opts);
  streamCaptureEvents(path, (ev) => fold.push(ev));
  return fold.finish();
}

/** The landing map plus the read-set caveat (`readSetNote`) from ONE pass — what
 *  `runtime_loader_lens` prints, so a source taken from a legacy BLOCK_READ (0x35)
 *  capture says that its sector credit may be off by one. */
export function landingMapWithNoteFromCaptureFile(
  path: string, opts: LandingMapOptions = {},
): { map: LandingMapEntry[]; note: string | null; stackNote: string | null } {
  const land = newLandingMapFold(opts);
  const disk = newReadSetFold();
  streamCaptureEvents(path, (ev) => { land.push(ev); disk.push(ev); });
  const map = land.finish();
  return { map, note: readSetNote(disk.finish()), stackNote: land.stackNote() };
}
