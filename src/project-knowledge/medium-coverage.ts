// Uniform block-coverage over the neutral Medium substrate (MediumLayoutView).
//
// Spec 785 §2 — a byte range on a medium is described by THREE independent
// axes, not one flag:
//
//   Medium  → PHYSICS      per-medium          → Data / No Data
//   BLOCKS  → LoaderModel  index, load chain   → Used / Unused
//   PAYLOADS→ meaning      disassembly         → Identified / Unknown
//
//   * Data / No Data is a property of the BYTES ($ff erased, $00 never
//     written on flash; free/zero sectors on disk). No loader required.
//   * Used is a property of the LoaderModel: something fetches these bytes.
//     Its evidence is a payload (`MediumLayout.files`) — a directory entry,
//     a LUT entry, a chunk-directory entry.
//   * Identified is meaning: a disassembly-derived region
//     (`MediumLayout.resident`) says we know what the bytes ARE. It is NEVER
//     evidence that the loader fetched anything (785 B2) — before 785 the two
//     were unioned into one `claimSpans`, so a cartridge with 0 payloads and
//     494 code islands reported "65/65 data blocks attributed".
//
// The Discovery→RE lifecycle gate needs ONE medium-agnostic signal: are there
// data-bearing blocks on any medium that no payload has claimed yet? If yes,
// discovery is not done. It is NOT count-based ("some entity exists") and it
// does NOT branch on disk-vs-cart above the block.
//
// The medium-specific part lives BELOW the block layer, inside each grid
// reader; each reader emits the SAME `BlockCoverage` record per physical block
// and ONE shared aggregator turns those into the neutral MediumBlockCoverage:
//   - disk: every one of the 683/768 sectors physically exists; `free` /
//     `free_zero` = No Data, `file` = Used, `free_data` / `orphan_allocated` =
//     Data but not Used, `bam` / `directory` / `unknown` = system (neither a
//     payload block nor a gap).
//   - cartridge: every bank physically exists too (a .crt just drops empty
//     banks to save space — `flash-empty-ff`). Empty regions are No Data,
//     payload spans are Used, resident spans are Identified — all byte-exact
//     inside the chip.
//
// Everything above the reader is uniform.

import type { MediumLayoutView } from "./types.js";

type Medium = MediumLayoutView["mediums"][number];

export interface MediumBlockCoverage {
  mediumRef: string; // artifact id of the disk/cart image
  mediumKind: "disk" | "cartridge";
  mediumLabel: string;
  dataBlocks: number; // data-bearing blocks (sectors / chip-regions)
  attributedBlocks: number; // data-bearing AND fully claimed by payloads
  unclaimedBlocks: number; // data-bearing AND not fully claimed — the gate signal
  // Spec 785 B1 — the same three axes in BYTES, so a chip 1 % covered and one
  // 99 % covered stop reporting the same thing.
  dataBytes: number; // Data: block bytes that are not No-Data
  emptyBytes: number; // No Data: erased / never-written / free
  usedBytes: number; // Used: Data bytes claimed by a payload (LoaderModel)
  unclaimedBytes: number; // dataBytes - usedBytes
  identifiedBytes: number; // Identified: Data bytes claimed by a payload OR a disasm region
  unidentifiedBytes: number; // dataBytes - identifiedBytes
}

/** One physical block (a disk sector, a cart chip) in the neutral shape every
 *  grid reader emits. `system` blocks (BAM, directory, no-BAM-info) are neither
 *  payload data nor a gap and drop out of every number. */
interface BlockCoverage {
  sizeBytes: number;
  emptyBytes: number; // No-Data bytes inside this block
  usedBytes: number; // payload-claimed bytes (already excluding No-Data)
  identifiedBytes: number; // payload- or disasm-claimed bytes (already excluding No-Data)
  system: boolean;
}

type Interval = readonly [number, number];

/** Sort + merge overlapping/touching intervals into a disjoint ascending set. */
function normalize(intervals: Interval[]): Interval[] {
  const clean = intervals.filter(([a, b]) => b > a).sort((l, r) => l[0] - r[0]);
  if (clean.length === 0) return [];
  const merged: Array<[number, number]> = [[clean[0][0], clean[0][1]]];
  for (let i = 1; i < clean.length; i += 1) {
    const [s, e] = clean[i];
    const last = merged[merged.length - 1];
    if (s > last[1]) merged.push([s, e]);
    else if (e > last[1]) last[1] = e;
  }
  return merged;
}

function totalLength(intervals: Interval[]): number {
  let total = 0;
  for (const [a, b] of intervals) total += b - a;
  return total;
}

/** `source \ cut`, both assumed normalized. */
function subtract(source: Interval[], cut: Interval[]): Interval[] {
  if (cut.length === 0) return source;
  const out: Interval[] = [];
  for (const [s, e] of source) {
    let start = s;
    for (const [cs, ce] of cut) {
      if (ce <= start) continue;
      if (cs >= e) break;
      if (cs > start) out.push([start, Math.min(cs, e)]);
      start = Math.max(start, ce);
      if (start >= e) break;
    }
    if (start < e) out.push([start, e]);
  }
  return out;
}

function diskBlocks(medium: Medium): BlockCoverage[] {
  const grid = medium.grid;
  if (grid.kind !== "sector-grid") return [];
  const blockSize = medium.blockSize > 0 ? medium.blockSize : 254;
  // Meaning-claims projected onto sectors: a disassembly-derived region pinned
  // to T/S says we know what the sector IS, never that a file fetches it.
  const residentSectors = new Set<string>();
  for (const region of medium.resident) {
    for (const span of region.spans) {
      if (span.kind === "sector") residentSectors.add(`${span.track}:${span.sector}`);
    }
  }
  const block = (over: Partial<BlockCoverage>): BlockCoverage => ({
    sizeBytes: blockSize,
    emptyBytes: 0,
    usedBytes: 0,
    identifiedBytes: 0,
    system: false,
    ...over,
  });
  return grid.sectors.map((cell) => {
    switch (cell.category) {
      case "file":
        return block({ usedBytes: blockSize, identifiedBytes: blockSize });
      case "free_data":
      case "orphan_allocated":
        return block({
          identifiedBytes: residentSectors.has(`${cell.track}:${cell.sector}`) ? blockSize : 0,
        });
      case "free":
      case "free_zero":
        return block({ emptyBytes: blockSize });
      // bam / directory = system; unknown = no BAM info → neither payload data
      // nor a gap.
      default:
        return block({ system: true });
    }
  });
}

function cartBlocks(medium: Medium): BlockCoverage[] {
  const grid = medium.grid;
  if (grid.kind !== "bank-grid") return [];
  // Spec 785 B2 — payload claims (files: LUT/chunk-directory entries and
  // registered payloads) and meaning claims (resident: disassembly-derived
  // regions) stay APART. Unioning them is what made the number unfalsifiable.
  const payloadSpans = medium.files.flatMap((file) => file.spans);
  const residentSpans = medium.resident.flatMap((region) => region.spans);
  const emptySpans = medium.empty.flatMap((region) => region.spans);
  type SlotSpan = Extract<(typeof payloadSpans)[number], { kind: "slot" }>;

  return grid.chips.map((chip) => {
    const size = chip.size;
    if (size <= 0) {
      return { sizeBytes: 0, emptyBytes: 0, usedBytes: 0, identifiedBytes: 0, system: true };
    }
    const inChip = (span: (typeof payloadSpans)[number]): span is SlotSpan =>
      span.kind === "slot" &&
      span.bank === chip.bank &&
      (chip.slot ? span.slot === chip.slot : true);
    const clip = (span: SlotSpan): Interval => [
      Math.max(0, span.offsetInBank),
      Math.min(size, span.offsetInBank + span.length),
    ];
    const project = (spans: typeof payloadSpans): Interval[] =>
      normalize(spans.filter(inChip).map(clip));

    const empty = project(emptySpans);
    const payload = project(payloadSpans);
    const resident = project(residentSpans);
    return {
      sizeBytes: size,
      emptyBytes: totalLength(empty),
      usedBytes: totalLength(subtract(payload, empty)),
      identifiedBytes: totalLength(subtract(normalize([...payload, ...resident]), empty)),
      system: false,
    };
  });
}

/** The ONE aggregator above the block layer — no disk/cart branch lives here. */
function aggregate(medium: Medium, blocks: BlockCoverage[]): MediumBlockCoverage {
  let dataBlocks = 0;
  let attributedBlocks = 0;
  let unclaimedBlocks = 0;
  let dataBytes = 0;
  let emptyBytes = 0;
  let usedBytes = 0;
  let identifiedBytes = 0;
  for (const block of blocks) {
    if (block.system || block.sizeBytes <= 0) continue;
    const empty = Math.min(block.sizeBytes, Math.max(0, block.emptyBytes));
    emptyBytes += empty;
    const data = block.sizeBytes - empty;
    if (data <= 0) continue; // wholly erased flash / free sector → not data
    const used = Math.min(Math.max(0, block.usedBytes), data);
    const identified = Math.min(Math.max(used, block.identifiedBytes), data);
    dataBlocks += 1;
    dataBytes += data;
    usedBytes += used;
    identifiedBytes += identified;
    if (used >= data) attributedBlocks += 1;
    else unclaimedBlocks += 1;
  }
  return {
    mediumRef: medium.artifactId,
    mediumKind: medium.mediumKind,
    mediumLabel: medium.mediumLabel,
    dataBlocks,
    attributedBlocks,
    unclaimedBlocks,
    dataBytes,
    emptyBytes,
    usedBytes,
    unclaimedBytes: dataBytes - usedBytes,
    identifiedBytes,
    unidentifiedBytes: dataBytes - identifiedBytes,
  };
}

export function computeMediumCoverage(medium: Medium): MediumBlockCoverage {
  return aggregate(medium, medium.mediumKind === "cartridge" ? cartBlocks(medium) : diskBlocks(medium));
}

/** Per-medium coverage for every disk/cart in the project (empty when no media). */
export function computeDiscoveryCoverage(view: MediumLayoutView | undefined | null): MediumBlockCoverage[] {
  if (!view || !Array.isArray(view.mediums)) return [];
  return view.mediums.map(computeMediumCoverage);
}

/**
 * Discovery is complete when no medium has a data-bearing block still
 * unclaimed. A project with no media (nothing to inventory) is vacuously
 * complete — the coverage gate then does not cap the lifecycle.
 */
export function discoveryCoverageComplete(coverages: MediumBlockCoverage[]): boolean {
  return coverages.every((c) => c.unclaimedBlocks === 0);
}
