// Spec 766.4 — the recorder's worker-owned anchor store.
//
// Lives ENTIRELY on the recorder worker thread. The emulation thread never
// touches it (BUG-049: no store read/eval on the hot path). It holds the recent
// scrub history in a single pre-allocated ArrayBuffer "slab" plus a light index;
// the slab is a BYTE RING that overwrites the oldest anchors once full, giving a
// bounded ~3-4 min depth at the 0.5 s / ~70 KiB-anchor cadence with a ~32 MiB
// slab. Medium images (.crt / disk) are NOT in the slab — they are deduped in a
// small per-kind map keyed by generation, so an unchanged 1 MiB cart is stored
// once, not once per anchor.
//
// Byte-ring discipline: writes are CONTIGUOUS in an absolute (never-wrapping, 53-
// bit) position space; the physical slab offset is `abs % capacity`. A record
// that would straddle the slab end skips the tail gap (advances abs to the next
// slab boundary) so every stored body is one contiguous physical run — trivial
// byte-exact read-back. An index entry is alive while its start is within the
// last `capacity` bytes of the frontier; older entries are evicted (their bytes
// were overwritten). No allocation per stored anchor beyond the index entry.

import {
  ANCHOR_HEADER_BYTES, readAnchorHeader, type AnchorHeader,
  MEDIUM_KIND_DISK, MEDIUM_KIND_CART,
} from "./anchor-record.js";

export interface AnchorIndexEntry {
  seq: number;           // monotonic store sequence (stable id, survives eviction checks)
  cycle: number;         // capture machine clock
  wallMs: number;        // capture wall-clock ms
  diskGen: number;       // referenced disk medium generation
  cartGen: number;       // referenced cart medium generation
  schemaVersion: number; // RuntimeCheckpoint schema (for restore)
  absStart: number;      // absolute byte position of the codec body
  phys: number;          // physical slab offset of the codec body
  len: number;           // codec body byte length
}

export interface StoredMedium { kind: number; generation: number; bytes: Uint8Array; wallMs: number; }

export interface AnchorStoreStats {
  anchorCount: number;
  oldestCycle: number | null;
  newestCycle: number | null;
  slabBytes: number;
  slabUsed: number;          // bytes currently referenced by live entries
  evicted: number;           // anchors dropped to the ring (overwrite-oldest)
  mediumDisk: number | null; // current stored disk generation, or null
  mediumCart: number | null;
}

export class AnchorStore {
  private readonly slab: Uint8Array;
  private readonly capacity: number;
  private writeAbs = 0;
  private nextSeq = 0;
  private evicted = 0;
  private readonly entries: AnchorIndexEntry[] = []; // oldest → newest
  // medium dedup: keep the most recent `mediumKeep` generations per kind so a
  // scrub backward still finds the medium the older anchors referenced.
  private readonly mediumKeep: number;
  private readonly mediumByKind = new Map<number, StoredMedium[]>(); // kind → recent (oldest→newest)

  constructor(capacityBytes = 32 * 1024 * 1024, mediumKeep = 3) {
    this.slab = new Uint8Array(capacityBytes);
    this.capacity = capacityBytes;
    this.mediumKeep = Math.max(1, mediumKeep);
  }

  /** Store one anchor (header + codec body). Returns the assigned seq. */
  putAnchor(header: AnchorHeader, codec: Uint8Array): number {
    const len = codec.length;
    if (len > this.capacity) throw new Error(`anchor (${len}B) exceeds slab capacity (${this.capacity}B)`);

    let phys = this.writeAbs % this.capacity;
    if (phys + len > this.capacity) {        // would straddle the end → skip the tail gap
      this.writeAbs += this.capacity - phys;
      phys = 0;
    }
    const absStart = this.writeAbs;
    this.slab.set(codec, phys);
    this.writeAbs += len;

    const entry: AnchorIndexEntry = {
      seq: this.nextSeq++, cycle: header.cycle, wallMs: header.wallMs,
      diskGen: header.diskGen, cartGen: header.cartGen, schemaVersion: header.schemaVersion,
      absStart, phys, len,
    };
    this.entries.push(entry);

    // Evict everything the new frontier overwrote (start more than `capacity`
    // bytes behind the new end).
    const liveFloor = this.writeAbs - this.capacity;
    while (this.entries.length > 0 && this.entries[0]!.absStart < liveFloor) {
      this.entries.shift();
      this.evicted++;
    }
    return entry.seq;
  }

  /** Store / dedup a medium image by (kind, generation). Idempotent per gen. */
  putMedium(kind: number, generation: number, bytes: Uint8Array, wallMs: number): void {
    let list = this.mediumByKind.get(kind);
    if (!list) { list = []; this.mediumByKind.set(kind, list); }
    if (list.some((m) => m.generation === generation)) return; // already have this version
    list.push({ kind, generation, bytes: bytes.slice(), wallMs });
    while (list.length > this.mediumKeep) list.shift(); // evict oldest version
  }

  /** Copy out the codec body of a stored anchor by seq (null if evicted). */
  getAnchorBytes(seq: number): Uint8Array | null {
    const e = this.entries.find((x) => x.seq === seq);
    if (!e) return null;
    return this.slab.slice(e.phys, e.phys + e.len);
  }

  /** Parse the header of a stored anchor (cheap; null if evicted). NB: the header
   *  is carried in the index, not re-read from the slab (the slab holds only the
   *  codec body). */
  getAnchorHeader(seq: number): AnchorHeader | null {
    const e = this.entries.find((x) => x.seq === seq);
    if (!e) return null;
    return { cycle: e.cycle, wallMs: e.wallMs, diskGen: e.diskGen, cartGen: e.cartGen, schemaVersion: e.schemaVersion };
  }

  /** The newest stored anchor at or before `cycle`, or null. */
  findByCycle(cycle: number): AnchorIndexEntry | null {
    let best: AnchorIndexEntry | null = null;
    for (const e of this.entries) {
      if (e.cycle <= cycle && (best === null || e.cycle > best.cycle)) best = e;
    }
    return best;
  }

  /** Light listing of all present anchors (oldest → newest), no bodies. */
  list(): AnchorIndexEntry[] { return this.entries.slice(); }

  /** The stored medium for (kind, generation), or null if not retained. */
  getMedium(kind: number, generation: number): StoredMedium | null {
    return this.mediumByKind.get(kind)?.find((m) => m.generation === generation) ?? null;
  }

  /** The most recent stored medium of a kind, or null. */
  latestMedium(kind: number): StoredMedium | null {
    const list = this.mediumByKind.get(kind);
    return list && list.length > 0 ? list[list.length - 1]! : null;
  }

  stats(): AnchorStoreStats {
    const n = this.entries.length;
    let used = 0;
    for (const e of this.entries) used += e.len;
    return {
      anchorCount: n,
      oldestCycle: n > 0 ? this.entries[0]!.cycle : null,
      newestCycle: n > 0 ? this.entries[n - 1]!.cycle : null,
      slabBytes: this.capacity,
      slabUsed: used,
      evicted: this.evicted,
      mediumDisk: this.latestMedium(MEDIUM_KIND_DISK)?.generation ?? null,
      mediumCart: this.latestMedium(MEDIUM_KIND_CART)?.generation ?? null,
    };
  }
}

export { ANCHOR_HEADER_BYTES, readAnchorHeader, MEDIUM_KIND_DISK, MEDIUM_KIND_CART };
