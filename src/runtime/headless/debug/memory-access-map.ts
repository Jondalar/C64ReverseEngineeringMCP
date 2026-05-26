// src/runtime/headless/debug/memory-access-map.ts
//
// SPIKE — runtime memory-access / region-liveness map. Attaches a lightweight
// aggregating observer to the C64 memory bus (HeadlessMemoryBus.setAccessObserver)
// and, over a workload window, records per-page read/write counts + ordering, then
// classifies each region:
//
//   unused     — never read, never written in the window
//   read-only  — read but never written (ROM / const tables / code fetched)
//   dead       — written but NEVER read afterwards (stale scratch / consumed-once
//                source data) → SAFE to reclaim for a loader / overlay / save buffer
//   live       — read after being written (active working data)
//
// This is the general RE answer to "which RAM is free / dead / reclaimable" — e.g.
// confirming a boot-only decompression source is dead during gameplay so a resident
// loader can live there. PURE aggregation, O(1) per access, scales to whole sessions.

export type PageClass = "unused" | "read-only" | "dead" | "live";

export interface PageStat {
  page: number;        // 0..255 (page << 8 = base address)
  reads: number;
  writes: number;
  lastWriteIdx: number;   // global access index of the last write (-1 = none)
  readAfterWrite: boolean; // a read occurred after the last write (data consumed)
  cls: PageClass;
}

export interface MemoryRegionSummary {
  start: number;       // inclusive base address
  end: number;         // inclusive end address ($..FF of the last page)
  cls: PageClass;
  reads: number;
  writes: number;
}

export interface MemoryAccessMap {
  pages: PageStat[];                 // all 256 pages
  regions: MemoryRegionSummary[];    // contiguous same-class page runs
}

interface BusLike {
  setAccessObserver(obs: ((kind: "read" | "write", address: number, value: number) => void) | null): void;
}

/** Live tracker — attach to a bus, run a workload, then `finish()` for the map. */
export class MemoryAccessTracker {
  private readonly reads = new Uint32Array(256);
  private readonly writes = new Uint32Array(256);
  private readonly lastWriteIdx = new Int32Array(256).fill(-1);
  private readonly readAfterWrite = new Uint8Array(256);
  private idx = 0;
  private readonly bus: BusLike;

  constructor(bus: BusLike) {
    this.bus = bus;
  }

  /** Attach the observer (call before the workload). */
  attach(): void {
    this.bus.setAccessObserver((kind, address) => {
      const p = (address >>> 8) & 0xff;
      const i = this.idx++;
      if (kind === "read") {
        this.reads[p]++;
        if (this.lastWriteIdx[p] >= 0) this.readAfterWrite[p] = 1;
      } else {
        this.writes[p]++;
        this.lastWriteIdx[p] = i;
        this.readAfterWrite[p] = 0; // reset: a new write supersedes prior consumption
      }
    });
  }

  /** Detach + return the classified map. */
  finish(): MemoryAccessMap {
    this.bus.setAccessObserver(null);
    return this.build();
  }

  private classify(p: number): PageClass {
    const r = this.reads[p]!, w = this.writes[p]!;
    if (r === 0 && w === 0) return "unused";
    if (w === 0) return "read-only";
    if (r === 0) return "dead";
    // written + read: dead iff the last write was never consumed by a later read.
    return this.readAfterWrite[p] ? "live" : "dead";
  }

  private build(): MemoryAccessMap {
    const pages: PageStat[] = [];
    for (let p = 0; p < 256; p++) {
      pages.push({
        page: p,
        reads: this.reads[p]!,
        writes: this.writes[p]!,
        lastWriteIdx: this.lastWriteIdx[p]!,
        readAfterWrite: this.readAfterWrite[p] === 1,
        cls: this.classify(p),
      });
    }
    // contiguous same-class runs → regions
    const regions: MemoryRegionSummary[] = [];
    let s = 0;
    for (let p = 1; p <= 256; p++) {
      if (p === 256 || pages[p]!.cls !== pages[s]!.cls) {
        let reads = 0, writes = 0;
        for (let q = s; q < p; q++) { reads += pages[q]!.reads; writes += pages[q]!.writes; }
        regions.push({ start: s << 8, end: ((p - 1) << 8) | 0xff, cls: pages[s]!.cls, reads, writes });
        s = p;
      }
    }
    return { pages, regions };
  }
}

/** Convenience: attach a tracker to a session's bus, run `workload`, return the map.
 *  `session` must expose `c64Bus` (HeadlessMemoryBus). */
export function analyzeMemoryAccess(
  session: { c64Bus: BusLike },
  workload: () => void,
): MemoryAccessMap {
  const t = new MemoryAccessTracker(session.c64Bus);
  t.attach();
  try {
    workload();
  } finally {
    return t.finish();
  }
}
