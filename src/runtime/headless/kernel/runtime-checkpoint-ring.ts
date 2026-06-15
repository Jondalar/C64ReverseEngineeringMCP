// Spec 705.B — always-on bounded in-memory checkpoint ring + pin lifecycle.
// Spec 765 — flat-backed storage (the BUG-049 zero-alloc re-storage).
//
// Built on the green 705.A native RuntimeCheckpoint (kernel.snapshot/restore).
// The ring is TRANSIENT (in-memory only): it lets pause/inspect rewind into the
// recent past without prior preparation (the user often discovers an
// interesting visible result only after its cause). It is NOT persistence — no
// dump/undump (Spec 707 does that), no replay event-log, no rewind UI here
// (the WS RPC + scrub seekbar are a separate surface).
//
// === Spec 765 storage model (supersedes 705.B's storage, NOT its capability) ===
//
// BUG-049 root cause (measured 2026-06-15): the old ring retained a GRAPH of
// hundreds of nested snapshot objects, each ~400 KB (RAM 64 KB + 2 VIC
// framebuffers ~317 KB dominate), allocated fresh every ~0.5-1 s. Growing that
// old-gen object graph → periodic major-GC pauses → daemon dips under 50 fps →
// audio under-delivered → worklet ring underrun → "kratzen".
//
// Fix (the "Mittelweg", user-ratified 2026-06-15): pre-allocate ONE flat
// `ArrayBuffer` slab at construction, divided into N fixed-size slots. The
// dominant BIG buffers (RAM + the two literal-port framebuffers) are COPIED into
// the next free slot via `.set()` and the stored entry references slab SUBARRAY
// VIEWS (tiny objects, no backing alloc) instead of detached `.slice()` copies.
// → the slab is a handful of GC objects of FIXED size that never grow, so the
//   major GC has ~nothing to retain/scan (V8 does not scan typed-array bytes).
// The small scalar chip state (cpu/cia/sid/iec/alarms/…) stays a per-slot JS
// object — it is ~a few KB, never caused the churn, and keeping it as-is means
// `kernel.restore()` is UNCHANGED → the probe-705b / 7-game fidelity gates carry
// zero new risk (the only place the Spec 620 C→TS bug families could re-enter
// would be a byte-codec rewrite of that state, which we deliberately avoid).
//
// Pairs with `kernel.snapshot({ shallow: true })` for the auto-capture path:
// shallow returns the LIVE big-buffer refs (no `.slice()`), the ring copies them
// once into the slab → genuinely zero-alloc on the hot capture path. Detached
// (default) snapshots still work — the ring copies whatever big buffers it is
// handed; the RETAINED entry always points at slab views either way.
//
// Binding decisions carried over from 705.B:
//   - capture interval: driven by the controller loop, NOT here (policy + storage only).
//   - Pin (§3.4): a pinned slot is exempt from round-robin reuse; survives eviction.

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
  /** Estimated retained bytes (the fixed slot size + small wrapper). */
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

// === Spec 765 flat-slot layout ===
// The big per-checkpoint buffers, packed at fixed offsets in each slab slot.
// Sizes are the PAL single-path constants:
//   RAM           = 64 KiB                      (HeadlessC64Bus.ram)
//   literalPortFb = 65*8 × 312 = 162240 bytes   (mid-frame accumulator)
//   ...Stable     = 65*8 × 312 = 162240 bytes   (immediately-visible freeze image)
// Both framebuffers are OPTIONAL (null when present-capture is off); their slot
// regions are simply unused in that case. A capture whose buffers do not match
// these sizes is rejected (throws) rather than silently truncated (PL-7) — the
// controller catches it as a dropped checkpoint (a ring gap, never a crash).
const RAM_BYTES = 0x10000; // 65536
const FB_BYTES = 65 * 8 * 312; // 162240
/**
 * Fixed bytes per slab slot. Spec 765 (BUG-049 §8): the slab holds ONLY RAM —
 * the dominant per-second cost was the two VIC framebuffers (~317 KiB), but a
 * framebuffer is a DERIVABLE shadow (pure function of RAM + VIC regs + raster),
 * NOT reconstruction state ("only the CPU writes RAM", 746 §1). So the always-on
 * perma-anchor omits it (controller passes `omitFramebuffer`), and a scrub/dump
 * regenerates it by running one frame. The rare anchor that DOES carry a
 * framebuffer (an explicit/dump capture, for .c64re full-fidelity) keeps it as a
 * detached JS slice ON THE ENTRY — off the hot per-second path. Exported for the
 * gate.
 */
export const SLOT_BYTES = RAM_BYTES; // 65536 — RAM only
const OFF_RAM = 0;

interface RingEntry extends RuntimeCheckpointRef {
  /** Index of the slab slot holding this entry's RAM. */
  slotIdx: number;
  /**
   * The SMALL scalar payload graph (cpu/cia/sid/iec/alarms/keyboard/…) with
   * `ram` replaced by the slab subarray VIEW at capture time, the framebuffers
   * either null (perma-anchor) or detached JS slices (explicit/dump anchor), and
   * the pooled media slots nulled (their bytes live once in `diskPool`).
   */
  payload: Record<string, unknown>;
  schemaVersion: number;
  /** Spec 714.4/714.5 — pooled-slot → content hash for each large media blob. */
  blobHashes: Record<string, string>;
}

export interface RuntimeCheckpointRingOptions {
  /** Slab size in bytes; N = floor(budget / slot). Default 32 MiB ≈ ~86 slots. */
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
  /** Spec 765 — flat-slab telemetry. */
  slotBytes: number;
  slotCount: number;
  freeSlots: number;
}

// Spec 765 — 32 MiB slab default. At SLOT_BYTES = 64 KiB (RAM only, framebuffers
// no longer stored — §8) that is ~512 slots ≈ ~8.5 min of rewind at the 1 s
// auto-cadence. The slab is allocated ONCE (lazily); capture never grows it, so
// the old-gen footprint is constant (BUG-049: the growth was the major-GC
// trigger).
export const DEFAULT_CHECKPOINT_RING_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Legacy estimate kept for API compatibility (no external caller depends on the
 * exact value). With the flat slab a checkpoint's retained big-buffer cost is
 * the fixed slot size; the small scalar graph is negligible.
 */
export function estimateCheckpointBytes(_snap: MachineSnapshot): number {
  return SLOT_BYTES;
}

export class RuntimeCheckpointRing {
  readonly budgetBytes: number;
  /** Spec 765 — the one flat slab. ONE GC object, fixed size. Allocated LAZILY
   *  on first capture (not in the ctor) so a session that never auto-captures —
   *  the default — pays NOTHING, and power-on takes no 32 MiB zero-fill hit. */
  private slab: Uint8Array | null = null;
  private readonly slotCount: number;
  /** Free slot indices (LIFO). A slot is free when no live entry references it. */
  private freeSlots: number[];
  private entries: RingEntry[] = []; // oldest first
  private seq = 0;
  // Spec 714.4 — content-addressed disk-image pool: identical disk versions are
  // stored ONCE (refcounted across entries); pinned entries keep their version
  // alive; eviction releases unreferenced versions.
  private diskPool = new Map<string, { bytes: Uint8Array; refs: number }>();
  private diskPoolBytes = 0;

  constructor(opts: RuntimeCheckpointRingOptions = {}) {
    this.budgetBytes = opts.budgetBytes ?? DEFAULT_CHECKPOINT_RING_BUDGET_BYTES;
    this.slotCount = Math.max(1, Math.floor(this.budgetBytes / SLOT_BYTES));
    this.freeSlots = [];
    for (let i = this.slotCount - 1; i >= 0; i--) this.freeSlots.push(i);
  }

  /** Lazily allocate the flat slab on first use (see `slab` doc). On the fresh
   *  allocation it also PAGES IN the slab — one write per 4 KiB page — so the OS
   *  faults the pages here, not lazily on the first captures (which, unwarmed,
   *  would fault ~mid-boot and show as the power-on fps dip). Idempotent. */
  private ensureSlab(): Uint8Array {
    if (this.slab === null) {
      const s = new Uint8Array(this.slotCount * SLOT_BYTES);
      for (let i = 0; i < s.length; i += 4096) s[i] = 0; // touch → fault pages in now
      this.slab = s;
    }
    return this.slab;
  }

  /**
   * Spec 765 §8 — allocate + page in the slab NOW (idempotent). The controller
   * calls this at power-on (run start), BEFORE the first frame + audio, so the
   * one-time ~32 MiB alloc + page-fault cost is paid while nothing competes —
   * not lazily on the first auto-capture ~1 s into the CPU-heavy boot (which
   * showed as a power-on fps dip).
   */
  prewarm(): void {
    this.ensureSlab();
  }

  /**
   * Append a fresh checkpoint. RAM is copied into the next free slab slot; the
   * stored entry holds a slab VIEW for it + the small scalar graph + a
   * content-addressed ref for pooled media. Framebuffers, when present (an
   * explicit/dump anchor), are detached onto the entry off the slab.
   *
   * Contract (unchanged): the caller owns the capture cadence + the
   * instruction-boundary contract (kernel.snapshot() taken at an atomic boundary
   * with the loop idle). The snapshot may be `shallow` (live big-buffer refs) or
   * detached (sliced); the ring copies either into the slab regardless.
   *
   * Throws if no slot is free AND every entry is pinned (the user pinned more
   * than the ring can hold), or if a big buffer's size is unexpected. Both are
   * caught by the controller as a dropped checkpoint (a ring gap), never a crash.
   */
  capture(snapshot: MachineSnapshot, frame: number, cycles: number): RuntimeCheckpointRef {
    const payload = snapshot.payload as Record<string, unknown>;

    // Validate the big buffers up front (before mutating any ring state).
    const ram = payload["ram"];
    if (!(ram instanceof Uint8Array) || ram.length !== RAM_BYTES) {
      throw new Error(`[checkpoint] capture: RAM must be ${RAM_BYTES} bytes, got ${(ram as Uint8Array)?.length}`);
    }
    // Framebuffers (optional): null on the always-on perma-anchor (cheap), or a
    // pair of buffers on an explicit/dump anchor. Either way they DON'T ride the
    // RAM slab — when present they are detached (.slice) onto the entry, off the
    // per-second path. Validate size only when present.
    const vp = (payload["vicPresentation"] ?? null) as { literalPortFb?: Uint8Array | null; literalPortFbStable?: Uint8Array | null } | null;
    const fb = vp?.literalPortFb ?? null;
    const fbStable = vp?.literalPortFbStable ?? null;
    if (fb && fb.length !== FB_BYTES) throw new Error(`[checkpoint] capture: literalPortFb must be ${FB_BYTES} bytes, got ${fb.length}`);
    if (fbStable && fbStable.length !== FB_BYTES) throw new Error(`[checkpoint] capture: literalPortFbStable must be ${FB_BYTES} bytes, got ${fbStable.length}`);

    // Acquire a slot (evict the oldest unpinned entry if the slab is full).
    const slab = this.ensureSlab();
    const slotIdx = this.acquireSlot();

    // Copy RAM into the slab slot; the stored entry references a slab VIEW.
    const base = slotIdx * SLOT_BYTES;
    slab.set(ram, base + OFF_RAM);
    payload["ram"] = slab.subarray(base + OFF_RAM, base + OFF_RAM + RAM_BYTES);
    // Detach the framebuffers onto the entry (only when an explicit/dump anchor
    // carried them — the perma-anchor omits them and this is a no-op).
    if (vp) {
      if (fb) (vp as Record<string, unknown>)["literalPortFb"] = fb.slice();
      if (fbStable) (vp as Record<string, unknown>)["literalPortFbStable"] = fbStable.slice();
    }

    // Spec 714.4/714.5 — extract pooled media blobs (content-addressed dedup).
    const blobHashes: Record<string, string> = {};
    for (const slot of POOLED_BLOB_SLOTS) {
      const v = payload[slot];
      if (v instanceof Uint8Array && v.byteLength > 0) {
        const hash = createHash("sha256").update(v).digest("hex");
        const pooled = this.diskPool.get(hash);
        if (pooled) pooled.refs++;
        else { this.diskPool.set(hash, { bytes: v, refs: 1 }); this.diskPoolBytes += v.byteLength; }
        blobHashes[slot] = hash;
        payload[slot] = null; // stored entry keeps only the hash ref
      }
    }

    const entry: RingEntry = {
      id: `cp_${frame}_${this.seq++}`,
      frame, cycles, pinned: false,
      byteSize: SLOT_BYTES + (fb ? FB_BYTES : 0) + (fbStable ? FB_BYTES : 0),
      createdAtMs: Date.now(),
      slotIdx, payload, schemaVersion: snapshot.schemaVersion, blobHashes,
    };
    this.entries.push(entry);
    return toRef(entry);
  }

  /** Get a free slot, evicting the oldest unpinned entry if the slab is full. */
  private acquireSlot(): number {
    if (this.freeSlots.length === 0) {
      const idx = this.entries.findIndex((e) => !e.pinned);
      if (idx < 0) {
        throw new Error(
          `[checkpoint] ring full: all ${this.slotCount} slots pinned — cannot capture without evicting a pinned anchor`,
        );
      }
      this.removeEntryAt(idx); // frees its slot back to freeSlots
    }
    return this.freeSlots.pop()!;
  }

  /** Remove the entry at `idx`, release its slot + pooled disk refs. */
  private removeEntryAt(idx: number): void {
    const [gone] = this.entries.splice(idx, 1);
    if (!gone) return;
    this.freeSlots.push(gone.slotIdx);
    for (const hash of Object.values(gone.blobHashes)) this.releaseDiskImage(hash);
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

  /** Unpin; the slot becomes reclaimable again on the next full-slab capture. */
  unpin(id: string): RuntimeCheckpointRef | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    e.pinned = false;
    return toRef(e);
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
      if (keepPinned && this.entries[i]!.pinned) continue;
      this.removeEntryAt(i);
      removed++;
    }
    return removed;
  }

  /**
   * The stored MachineSnapshot for `id` (for the kernel to restore), or undefined.
   *
   * The returned payload references slab VIEWS for the big buffers (valid until
   * the slot is reused) and rehydrates pooled media into a shallow payload view.
   * Contract: consume it synchronously (kernel.restore copies out immediately) —
   * do not hold it across a subsequent capture, which may overwrite the slot.
   */
  restoreSnapshot(id: string): MachineSnapshot | undefined {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return undefined;
    const slots = Object.keys(e.blobHashes);
    if (slots.length === 0) return { schemaVersion: e.schemaVersion, payload: e.payload };
    const payload = { ...e.payload };
    for (const slot of slots) {
      const pooled = this.diskPool.get(e.blobHashes[slot]!);
      payload[slot] = pooled ? pooled.bytes : null;
    }
    return { schemaVersion: e.schemaVersion, payload };
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
    this.freeSlots = [];
    for (let i = this.slotCount - 1; i >= 0; i--) this.freeSlots.push(i);
    this.diskPool.clear();
    this.diskPoolBytes = 0;
  }

  stats(): RuntimeCheckpointRingStats {
    let pinnedCount = 0;
    for (const e of this.entries) if (e.pinned) pinnedCount++;
    return {
      count: this.entries.length,
      pinnedCount,
      totalBytes: this.entries.length * SLOT_BYTES + this.diskPoolBytes,
      budgetBytes: this.budgetBytes,
      oldestFrame: this.entries.length ? this.entries[0]!.frame : null,
      newestFrame: this.entries.length ? this.entries[this.entries.length - 1]!.frame : null,
      diskImageVersions: this.diskPool.size,
      diskPoolBytes: this.diskPoolBytes,
      slotBytes: SLOT_BYTES,
      slotCount: this.slotCount,
      freeSlots: this.freeSlots.length,
    };
  }
}

function toRef(e: RingEntry): RuntimeCheckpointRef {
  return {
    id: e.id, frame: e.frame, cycles: e.cycles,
    pinned: e.pinned, byteSize: e.byteSize, createdAtMs: e.createdAtMs,
  };
}
