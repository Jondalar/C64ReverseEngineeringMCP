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

interface RingEntry extends RuntimeCheckpointRef {
  snapshot: MachineSnapshot;
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
  private totalBytes = 0;
  private seq = 0;

  constructor(opts: RuntimeCheckpointRingOptions = {}) {
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_CHECKPOINT_RING_BUDGET_BYTES;
  }

  /**
   * Append a fresh checkpoint and evict oldest-unpinned until within budget.
   * The caller owns the capture cadence + the instruction-boundary contract
   * (kernel.snapshot() must be taken at an atomic boundary with the loop idle).
   */
  capture(snapshot: MachineSnapshot, frame: number, cycles: number): RuntimeCheckpointRef {
    const byteSize = estimateCheckpointBytes(snapshot);
    const entry: RingEntry = {
      id: `cp_${frame}_${this.seq++}`,
      frame, cycles, pinned: false, byteSize, createdAtMs: Date.now(),
      snapshot,
    };
    this.entries.push(entry);
    this.totalBytes += byteSize;
    this.evict();
    return toRef(entry);
  }

  /** Evict oldest UNPINNED entries until within budget (or only pinned remain). */
  private evict(): void {
    while (this.totalBytes > this.budgetBytes) {
      const idx = this.entries.findIndex((e) => !e.pinned);
      if (idx < 0) break; // everything left is pinned — honor the user's intent
      const [gone] = this.entries.splice(idx, 1);
      this.totalBytes -= gone!.byteSize;
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

  /** The stored MachineSnapshot for `id` (for the kernel to restore), or undefined. */
  restoreSnapshot(id: string): MachineSnapshot | undefined {
    return this.entries.find((x) => x.id === id)?.snapshot;
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
  }

  stats(): RuntimeCheckpointRingStats {
    let pinnedCount = 0;
    for (const e of this.entries) if (e.pinned) pinnedCount++;
    return {
      count: this.entries.length,
      pinnedCount,
      totalBytes: this.totalBytes,
      budgetBytes: this.budgetBytes,
      oldestFrame: this.entries.length ? this.entries[0]!.frame : null,
      newestFrame: this.entries.length ? this.entries[this.entries.length - 1]!.frame : null,
    };
  }
}

function toRef(e: RingEntry): RuntimeCheckpointRef {
  return {
    id: e.id, frame: e.frame, cycles: e.cycles,
    pinned: e.pinned, byteSize: e.byteSize, createdAtMs: e.createdAtMs,
  };
}
