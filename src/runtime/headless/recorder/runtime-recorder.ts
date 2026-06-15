// Spec 766.5 — the emulation-thread side of the runtime recorder.
//
// Owns the shared-memory handoff (two lossy rings) and the worker that does all
// the heavy work. The emulation thread calls captureAnchor() at the 0.5 s anchor
// cadence; that is the ONLY hot-path touchpoint and it does only:
//   - encode the snapshot payload into a REUSED scratch (zero-alloc after warmup)
//   - one ring memcpy of the framed anchor record
//   - O(1) medium gen checks; a (rare) ring memcpy of a medium image only when a
//     medium's content generation changed (gen-gate — never re-ships the 1 MiB
//     cart every anchor; THAT was BUG-049).
// It never reads the store, never hashes a big buffer per second, never blocks on
// the worker. All querying (scrub/dump) is async request/response to the worker.
//
// Two rings: a small ANCHOR ring (frequent ~100 KiB records) and a big-but-few
// MEDIUM ring (rare ≤2 MiB records). Separate so the common anchor traffic does
// not force every slot to medium size. The worker drains both.

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  RecorderRingProducer, createRecorderRingSab, type RecorderRingLayout,
} from "./recorder-ring.js";
import { AnchorEncoder, decodeAnchor } from "./anchor-codec.js";
import {
  REC_ANCHOR, REC_MEDIUM, ANCHOR_HEADER_BYTES, writeAnchorHeader,
  encodeMediumRecord, decodeCartMedium, MEDIUM_KIND_DISK, MEDIUM_KIND_CART,
} from "./anchor-record.js";
import {
  collectMediumDescriptors, type MediumKernelLike, type MediumDescriptor,
} from "./medium-source.js";

const WORKER_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "recorder-worker.js");

export interface RuntimeRecorderOptions {
  /** Anchor ring geometry (frequent, ~100 KiB records). */
  anchorLayout?: RecorderRingLayout;
  /** Medium ring geometry (rare, ≤ slotPayloadBytes). */
  mediumLayout?: RecorderRingLayout;
  /** Worker store slab bytes (scrub depth). */
  capacityBytes?: number;
  /** Medium versions retained per kind. */
  mediumKeep?: number;
}

const DEFAULT_ANCHOR_LAYOUT: RecorderRingLayout = { slotPayloadBytes: 384 * 1024, slotCount: 16 };
const DEFAULT_MEDIUM_LAYOUT: RecorderRingLayout = { slotPayloadBytes: 2 * 1024 * 1024, slotCount: 4 };

export interface RecorderAnchorRef {
  seq: number; cycle: number; wallMs: number; diskGen: number; cartGen: number; schemaVersion: number;
}
export interface RecorderStats {
  anchorCount: number; oldestCycle: number | null; newestCycle: number | null;
  slabBytes: number; slabUsed: number; evicted: number;
  mediumDisk: number | null; mediumCart: number | null; dropped: number;
}

export class RuntimeRecorder {
  private readonly anchorProducer: RecorderRingProducer;
  private readonly mediumProducer: RecorderRingProducer;
  private readonly worker: Worker;
  private readonly enc = new AnchorEncoder();
  private lastDiskGen = -1;
  private lastCartGen = -1;
  private reqSeq = 0;
  private readonly pending = new Map<number, (m: { ok: boolean; value: unknown }) => void>();
  private disposed = false;
  /** Count of anchors handed to the ring (producer side; not the stored count). */
  produced = 0;
  /** Medium images shipped (gen changes). */
  mediumShipped = 0;

  constructor(opts: RuntimeRecorderOptions = {}) {
    const anchorLayout = opts.anchorLayout ?? DEFAULT_ANCHOR_LAYOUT;
    const mediumLayout = opts.mediumLayout ?? DEFAULT_MEDIUM_LAYOUT;
    const anchorSab = createRecorderRingSab(anchorLayout);
    const mediumSab = createRecorderRingSab(mediumLayout);
    this.anchorProducer = new RecorderRingProducer(anchorSab, anchorLayout);
    this.mediumProducer = new RecorderRingProducer(mediumSab, mediumLayout);
    this.worker = new Worker(WORKER_PATH, {
      workerData: {
        sab: anchorSab, layout: anchorLayout,
        mediumSab, mediumLayout,
        capacityBytes: opts.capacityBytes ?? 32 * 1024 * 1024,
        mediumKeep: opts.mediumKeep ?? 3,
        drainIntervalMs: 25,
      },
    });
    this.worker.on("message", (m: { type: string; reqId?: number; ok?: boolean; value?: unknown }) => {
      if (m.type === "reply" && m.reqId !== undefined) {
        const r = this.pending.get(m.reqId);
        if (r) { this.pending.delete(m.reqId); r({ ok: !!m.ok, value: m.value }); }
        this.unrefIfIdle();
      }
    });
    this.worker.on("error", () => { /* worker death must never crash the emu thread */ });
    // The recorder must not keep the process alive on its own (the daemon's server
    // loop does that). But while a query is in flight the worker MUST stay ref'd or
    // its reply is never delivered (a bare `await` with nothing else pending would
    // otherwise let the loop drain). req() ref's; the last reply un-ref's.
    this.worker.unref();
  }

  private unrefIfIdle(): void {
    if (this.pending.size === 0) { try { this.worker.unref(); } catch { /* ignore */ } }
  }

  /**
   * Capture one anchor (hot path, ~2×/s). `payload` is the kernel.snapshot()
   * payload (shallow + omitFramebuffer). `kernel` is read O(1) for the medium
   * generations; a medium image is shipped only when its generation changed.
   */
  captureAnchor(payload: unknown, cycle: number, wallMs: number, schemaVersion: number, kernel: MediumKernelLike): void {
    if (this.disposed) return;
    const media = collectMediumDescriptors(kernel);
    let diskGen = 0, cartGen = 0;
    for (const m of media) { if (m.kind === "disk") diskGen = m.generation; else if (m.kind === "cart") cartGen = m.generation; }

    // Anchor: encode into the reused scratch with a header reserve, fill the
    // header in place, one ring memcpy. Zero-alloc after warmup.
    const rec = this.enc.encodeWithReserve(ANCHOR_HEADER_BYTES, payload);
    writeAnchorHeader(rec, 0, { cycle, wallMs, diskGen, cartGen, schemaVersion });
    if (this.anchorProducer.write(REC_ANCHOR, rec)) this.produced++;

    // Medium gen-gate: ship bytes only on a content-generation change.
    for (const m of media) this.maybeShipMedium(m, wallMs);
  }

  private maybeShipMedium(m: MediumDescriptor, wallMs: number): void {
    const last = m.kind === "disk" ? this.lastDiskGen : this.lastCartGen;
    if (m.generation === last) return;
    const bytes = m.getBytes();
    if (!bytes) return;
    const kind = m.kind === "disk" ? MEDIUM_KIND_DISK : MEDIUM_KIND_CART;
    // encodeMediumRecord allocs (rare path — only on a gen change), then one ring
    // memcpy. If the image exceeds the medium slot it is dropped (sizing bug) —
    // the gen is NOT advanced so a later capture retries with a larger slot.
    const mrec = encodeMediumRecord({ kind, generation: m.generation, wallMs }, bytes);
    if (this.mediumProducer.write(REC_MEDIUM, mrec)) {
      if (m.kind === "disk") this.lastDiskGen = m.generation; else this.lastCartGen = m.generation;
      this.mediumShipped++;
    }
  }

  // ---- async query API (scrub / dump; never on the hot path) ----

  private req<T>(type: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; value: T }> {
    if (this.disposed) return Promise.resolve({ ok: false, value: null as T });
    return new Promise((res) => {
      const reqId = ++this.reqSeq;
      this.pending.set(reqId, (m) => res({ ok: m.ok, value: m.value as T }));
      try { this.worker.ref(); } catch { /* ignore */ } // keep the loop alive for the reply
      this.worker.postMessage({ type, reqId, ...extra });
    });
  }

  async stats(): Promise<RecorderStats> { return (await this.req<RecorderStats>("stats")).value; }
  async list(): Promise<RecorderAnchorRef[]> { return (await this.req<RecorderAnchorRef[]>("list")).value ?? []; }

  /** Anchor codec bytes + header for a seq (null if evicted). */
  async getAnchor(seq: number): Promise<{ header: RecorderAnchorRef; bytes: Uint8Array } | null> {
    const r = await this.req<{ header: RecorderAnchorRef; bytes: Uint8Array }>("getAnchor", { seq });
    return r.ok ? r.value : null;
  }

  async findByCycle(cycle: number): Promise<RecorderAnchorRef | null> {
    const r = await this.req<RecorderAnchorRef>("findByCycle", { cycle });
    return r.ok ? r.value : null;
  }

  async getMedium(kind: number, gen: number): Promise<{ kind: number; generation: number; bytes: Uint8Array } | null> {
    const r = await this.req<{ kind: number; generation: number; bytes: Uint8Array }>("getMedium", { kind, gen });
    return r.ok ? r.value : null;
  }

  /**
   * Spec 766.5b — reassemble a full restorable MachineSnapshot from a stored
   * anchor: decode the core payload, then re-inject the LARGE medium fields it
   * referenced (disk GCRIMAGE, cart .crt + flash) from the medium store. Returns
   * null if the anchor was evicted, or if a referenced medium is no longer
   * retained (a too-old scrub target). The small cart bank/control state already
   * rides the anchor's `media` metadata.
   */
  async reconstruct(seq: number): Promise<{ ref: RecorderAnchorRef; schemaVersion: number; payload: Record<string, unknown> } | null> {
    const got = await this.getAnchor(seq);
    if (!got) return null;
    const payload = decodeAnchor(new Uint8Array(got.bytes)) as Record<string, unknown>;
    const header = got.header;
    const ref: RecorderAnchorRef = { ...header, seq };

    if (header.diskGen > 0) {
      const m = await this.getMedium(MEDIUM_KIND_DISK, header.diskGen);
      if (!m) return null; // disk version evicted → cannot faithfully restore
      payload.driveDiskImage = new Uint8Array(m.bytes);
    }
    // A cartridge is present iff the anchor metadata carries it; cartGen alone is
    // ambiguous (gen 0 = "no flash writes yet", not "no cart").
    const media = payload.media as { cartridge?: unknown } | undefined;
    if (media?.cartridge) {
      const m = await this.getMedium(MEDIUM_KIND_CART, header.cartGen);
      if (!m) return null;
      const { rom, flash } = decodeCartMedium(new Uint8Array(m.bytes));
      payload.cartBytes = rom;
      payload.cartFlash = flash;
    }
    return { ref, schemaVersion: header.schemaVersion, payload };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.worker.postMessage({ type: "stop" }); } catch { /* ignore */ }
    void this.worker.terminate();
  }
}

export { MEDIUM_KIND_DISK, MEDIUM_KIND_CART };
