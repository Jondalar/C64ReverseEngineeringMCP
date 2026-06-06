// Spec 705.B — always-on bounded in-memory checkpoint ring + pin lifecycle.
//
// Built on the green 705.A native RuntimeCheckpoint (kernel.snapshot/restore).
// The ring is TRANSIENT (in-memory only): it lets pause/inspect rewind into the
// recent past without prior preparation (the user often discovers an
// interesting visible result only after its cause). It is NOT persistence — no
// dump/undump (a later slice), no replay event-log (Spec 705 §3.5, later), no
// rewind UI (API-first; the WS RPC surface lands separately).
//
// Binding decisions (Spec 705 §3.3, resolved 2026-05-23 by measurement):
//   - capacity policy: BYTES, default budget 128 MiB. A real checkpoint ≈ 400 KB
//     (vicPresentation framebuffer ~317 KB + 64 KB RAM dominate), so 128 MiB ≈
//     ~320 checkpoints. Evict OLDEST first; PINNED entries are exempt.
//   - capture interval: every 25 PAL frames (~0.5 s) — driven by the controller
//     loop, NOT here (this module is policy + storage only).
//
// Pin (§3.4) is the only durability primitive in 705.B: a pinned checkpoint
// survives ring eviction and returns a stable ref. Promote-to-Experiment needs
// the Experiment object model (§3.1) and is a later slice.

import { createHash } from "node:crypto";
import type { MachineSnapshot } from "./machine-kernel.js";

/** Public, payload-free view of a ring entry. */
export interface RuntimeCheckpointRef {
  id: string;
  /** Controller frame counter at capture. */
  frame: number;
  /** CPU cycle count at capture. */
  cycles: number;
  /** Pinned entries are exempt from eviction. */
  pinned: boolean;
  /** Estimated retained bytes (see estimateCheckpointBytes). */
  byteSize: number;
  /** Wall-clock capture time (ms since epoch). */
  createdAtMs: number;
}

/**
 * Spec 714.4/714.5 — top-level payload fields that hold large mutable media
 * byte blobs. Each is extracted into the content-addressed pool on capture and
 * rehydrated on restore, so identical content (a constant .crt; an unchanged
 * disk/flash across checkpoints) is stored once. Order is irrelevant.
 */
const POOLED_BLOB_SLOTS = ["driveDiskImage", "cartBytes", "cartFlash"] as const;

interface RingEntry extends RuntimeCheckpointRef {
  snapshot: MachineSnapshot;
  /** Spec 714.4/714.5 — pooled-slot → content hash for each large media blob
   *  present on this entry. The bytes are NOT stored on the entry's snapshot
   *  payload (the slot is nulled there); they live once in the pool and are
   *  rehydrated by restoreSnapshot(). */
  blobHashes: Record<string, string>;
}

export interface RuntimeCheckpointRingOptions {
  /** Memory budget in bytes; evict oldest unpinned once exceeded. Default 128 MiB. */
  budgetBytes?: number;
}

export interface RuntimeCheckpointRingStats {
  count: number;
  pinnedCount: number;
  totalBytes: number;
  budgetBytes: number;
  oldestFrame: number | null;
  newestFrame: number | null;
  /** Spec 714.4 — distinct disk-image versions held in the content-addressed
   *  pool (shared across entries), and their total deduplicated byte size. */
  diskImageVersions: number;
  diskPoolBytes: number;
}

export const DEFAULT_CHECKPOINT_RING_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * Estimate the retained byte size of a checkpoint by walking its payload:
 * typed arrays contribute byteLength, numbers 8, strings their length, arrays
 * and plain objects recurse. This is the same shape the 705.B sizing
 * measurement used; it is an estimate for the eviction budget, not an exact
 * heap accounting (V8 overhead per object is ignored).
 */
export function estimateCheckpointBytes(snap: MachineSnapshot): number {
  return walk(snap.payload) + 16; // + small fixed wrapper overhead
}

function walk(v: unknown): number {
  if (v == null) return 0;
  // typed arrays / ArrayBuffer views
  const bl = (v as { byteLength?: number }).byteLength;
  if (typeof bl === "number") return bl;
  if (Array.isArray(v)) {
    let n = 0;
    for (const x of v) n += typeof x === "number" ? 8 : walk(x);
    return n;
  }
  if (typeof v === "object") {
    let n = 0;
    for (const x of Object.values(v as Record<string, unknown>)) n += walk(x);
    return n;
  }
  if (typeof v === "number") return 8;
  if (typeof v === "string") return v.length;
  if (typeof v === "boolean") return 4;
  return 0;
}

export class RuntimeCheckpointRing {
  readonly budgetBytes: number;
  private entries: RingEntry[] = []; // oldest first
  private totalBytes = 0; // sum of entry core byteSizes (excludes pooled disk images)
  private seq = 0;
  // Spec 714.4 — content-addressed disk-image pool: identical disk versions are
  // stored ONCE (refcounted across entries); pinned entries keep their version
  // alive; eviction releases unreferenced versions.
  private diskPool = new Map<string, { bytes: Uint8Array; refs: number }>();
  private diskPoolBytes = 0;

  constructor(opts: RuntimeCheckpointRingOptions = {}) {
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_CHECKPOINT_RING_BUDGET_BYTES;
  }

  /**
   * Append a fresh checkpoint and evict oldest-unpinned until within budget.
   * The caller owns the capture cadence + the instruction-boundary contract
   * (kernel.snapshot() must be taken at an atomic boundary with the loop idle).
   *
   * Spec 714.4: the snapshot's `driveDiskImage` is extracted into the
   * content-addressed pool (deduped by sha256) and replaced on the stored entry
   * with a hash ref, so an unchanged disk costs one stored image across many
   * checkpoints. restoreSnapshot() rehydrates the exact bytes.
   */
  capture(snapshot: MachineSnapshot, frame: number, cycles: number): RuntimeCheckpointRef {
    const payload = snapshot.payload as Record<string, unknown>;
    const blobHashes: Record<string, string> = {};
    for (const slot of POOLED_BLOB_SLOTS) {
      const v = payload[slot];
      if (v instanceof Uint8Array && v.byteLength > 0) {
        const hash = createHash("sha256").update(v).digest("hex");
        const pooled = this.diskPool.get(hash);
        if (pooled) {
          pooled.refs++;
        } else {
          this.diskPool.set(hash, { bytes: v, refs: 1 });
          this.diskPoolBytes += v.byteLength;
        }
        blobHashes[slot] = hash;
        payload[slot] = null; // stored entry keeps only the hash ref
      }
    }
    const byteSize = estimateCheckpointBytes(snapshot);
    const entry: RingEntry = {
      id: `cp_${frame}_${this.seq++}`,
      frame, cycles, pinned: false, byteSize, createdAtMs: Date.now(),
      snapshot, blobHashes,
    };
    this.entries.push(entry);
    this.totalBytes += byteSize;
    this.evict();
    return toRef(entry);
  }

  /** Combined retained bytes: entry cores + the deduplicated disk-image pool. */
  private retainedBytes(): number {
    return this.totalBytes + this.diskPoolBytes;
  }

  /** Evict oldest UNPINNED entries until within budget (or only pinned remain).
   *  Each eviction releases the entry's disk-image pool reference (freeing the
   *  pooled bytes only when the last referencing entry is gone). */
  private evict(): void {
    while (this.retainedBytes() > this.budgetBytes) {
      const idx = this.entries.findIndex((e) => !e.pinned);
      if (idx < 0) break; // everything left is pinned — honor the user's intent
      const [gone] = this.entries.splice(idx, 1);
      this.totalBytes -= gone!.byteSize;
      for (const hash of Object.values(gone!.blobHashes)) this.releaseDiskImage(hash);
    }
  }

  /** Spec 714.4 — drop one reference to a pooled disk image; free it at zero. */
  private releaseDiskImage(hash: string | null): void {
    if (!hash) return;
    const pooled = this.diskPool.get(hash);
    if (!pooled) return;
    if (--pooled.refs <= 0) {
      this.diskPool.delete(hash);
      this.diskPoolBytes -= pooled.bytes.byteLength;
    }
  }

  pin(id: string): RuntimeCheckpointRef | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    e.pinned = true;
    return toRef(e);
  }

  /** Unpin; re-runs eviction since the entry is now reclaimable. */
  unpin(id: string): RuntimeCheckpointRef | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    e.pinned = false;
    const ref = toRef(e);
    this.evict();
    return ref;
  }

  /**
   * Spec 761 — drop anchors AFTER `id` (resume-from-X = a new timeline; the old
   * future is now stale). Pinned anchors are kept (the user's marked reference
   * points survive). Returns the number removed. No-op if `id` is unknown.
   */
  truncateAfter(id: string, opts: { keepPinned?: boolean } = {}): number {
    const idx = this.entries.findIndex((x) => x.id === id);
    if (idx < 0) return 0;
    const keepPinned = opts.keepPinned !== false;
    let removed = 0;
    // walk from the newest down to just-after idx so splices don't shift the cut
    for (let i = this.entries.length - 1; i > idx; i--) {
      const e = this.entries[i]!;
      if (keepPinned && e.pinned) continue;
      this.entries.splice(i, 1);
      this.totalBytes -= e.byteSize;
      for (const hash of Object.values(e.blobHashes)) this.releaseDiskImage(hash);
      removed++;
    }
    return removed;
  }

  /** The stored MachineSnapshot for `id` (for the kernel to restore), or undefined.
   *  Spec 714.4 — rehydrate the pooled disk image into a shallow payload view so
   *  the returned snapshot carries the exact `driveDiskImage` bytes (the stored
   *  entry holds only the hash ref). */
  restoreSnapshot(id: string): MachineSnapshot | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    const slots = Object.keys(e.blobHashes);
    if (slots.length === 0) return e.snapshot;
    const payload = { ...(e.snapshot.payload as Record<string, unknown>) };
    for (const slot of slots) {
      const pooled = this.diskPool.get(e.blobHashes[slot]!);
      payload[slot] = pooled ? pooled.bytes : null;
    }
    return { schemaVersion: e.snapshot.schemaVersion, payload } as MachineSnapshot;
  }

  get(id: string): RuntimeCheckpointRef | undefined {
    const e = this.entries.find((x) => x.id === id);
    return e ? toRef(e) : undefined;
  }

  /** Payload-free refs, oldest first. */
  list(): RuntimeCheckpointRef[] {
    return this.entries.map(toRef);
  }

  has(id: string): boolean {
    return this.entries.some((x) => x.id === id);
  }

  clear(): void {
    this.entries = [];
    this.totalBytes = 0;
    this.diskPool.clear();
    this.diskPoolBytes = 0;
  }

  stats(): RuntimeCheckpointRingStats {
    let pinnedCount = 0;
    for (const e of this.entries) if (e.pinned) pinnedCount++;
    return {
      count: this.entries.length,
      pinnedCount,
      totalBytes: this.retainedBytes(),
      budgetBytes: this.budgetBytes,
      oldestFrame: this.entries.length ? this.entries[0]!.frame : null,
      newestFrame: this.entries.length ? this.entries[this.entries.length - 1]!.frame : null,
      diskImageVersions: this.diskPool.size,
      diskPoolBytes: this.diskPoolBytes,
    };
  }
}

function toRef(e: RingEntry): RuntimeCheckpointRef {
  return {
    id: e.id, frame: e.frame, cycles: e.cycles,
    pinned: e.pinned, byteSize: e.byteSize, createdAtMs: e.createdAtMs,
  };
}
