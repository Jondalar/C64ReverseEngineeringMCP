// Uniform block-coverage over the neutral Medium substrate (MediumLayoutView).
//
// The Discovery→RE lifecycle gate needs ONE medium-agnostic signal: are there
// data-bearing blocks on any medium that no payload / known region has claimed
// yet? If yes, discovery is not done — the human/LLM must still disassemble
// (or, as an exception, trace) to attribute them. It is NOT count-based
// ("some entity exists") and it does NOT branch on disk-vs-cart above the block.
//
// The medium-specific part lives BELOW the block layer, inside each grid reader:
//   - disk: every one of the 683 sectors physically exists; a sector is
//     data-bearing when it is not all-zero. `free_data` / `orphan_allocated` =
//     data present but unclaimed. (`free` / `free_zero` = empty, `bam` /
//     `directory` = system → neither a payload block nor a gap.)
//   - cartridge: every bank physically exists too (VICE just drops empty banks
//     from the .crt image to save space — `flash-empty-ff`). A chip's bytes are
//     data-bearing unless covered by an empty region; unclaimed = chip bytes not
//     covered by any file / resident-region / empty span.
//
// Both readers emit the SAME MediumBlockCoverage. Everything above is uniform.

import type { MediumLayoutView } from "./types.js";

type Medium = MediumLayoutView["mediums"][number];

export interface MediumBlockCoverage {
  mediumRef: string; // artifact id of the disk/cart image
  mediumKind: "disk" | "cartridge";
  mediumLabel: string;
  dataBlocks: number; // data-bearing blocks (sectors / chip-regions)
  attributedBlocks: number; // data-bearing AND claimed (payload/known region)
  unclaimedBlocks: number; // data-bearing AND unclaimed — the gate signal
}

/** Union length of a set of [start,end) intervals (bytes). Overlaps counted once. */
function unionLength(intervals: Array<readonly [number, number]>): number {
  const clean = intervals.filter(([a, b]) => b > a).sort((l, r) => l[0] - r[0]);
  if (clean.length === 0) return 0;
  let total = 0;
  let curStart = clean[0][0];
  let curEnd = clean[0][1];
  for (let i = 1; i < clean.length; i += 1) {
    const [s, e] = clean[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

function diskCoverage(medium: Medium): MediumBlockCoverage {
  let dataBlocks = 0;
  let attributedBlocks = 0;
  let unclaimedBlocks = 0;
  const grid = medium.grid;
  if (grid.kind === "sector-grid") {
    for (const cell of grid.sectors) {
      switch (cell.category) {
        case "file":
          dataBlocks += 1;
          attributedBlocks += 1;
          break;
        case "free_data":
        case "orphan_allocated":
          dataBlocks += 1;
          unclaimedBlocks += 1;
          break;
        // free / free_zero = empty; bam / directory = system; unknown = no BAM
        // info → none of these is a payload-data gap.
        default:
          break;
      }
    }
  }
  return {
    mediumRef: medium.artifactId,
    mediumKind: "disk",
    mediumLabel: medium.mediumLabel,
    dataBlocks,
    attributedBlocks,
    unclaimedBlocks,
  };
}

function cartCoverage(medium: Medium): MediumBlockCoverage {
  const grid = medium.grid;
  let dataBlocks = 0;
  let attributedBlocks = 0;
  let unclaimedBlocks = 0;
  if (grid.kind === "bank-grid") {
    // claimed = payloads + LUT chunks (files) + known regions (resident).
    const claimSpans = [...medium.files, ...medium.resident].flatMap((r) => r.spans);
    const emptySpans = medium.empty.flatMap((r) => r.spans);
    type SlotSpan = Extract<(typeof claimSpans)[number], { kind: "slot" }>;
    for (const chip of grid.chips) {
      const size = chip.size;
      if (size <= 0) continue;
      const inChip = (span: (typeof claimSpans)[number]): span is SlotSpan =>
        span.kind === "slot" &&
        span.bank === chip.bank &&
        (chip.slot ? span.slot === chip.slot : true);
      const clip = (span: SlotSpan): readonly [number, number] => [
        Math.max(0, span.offsetInBank),
        Math.min(size, span.offsetInBank + span.length),
      ];
      const emptyLen = unionLength(emptySpans.filter(inChip).map(clip));
      if (emptyLen >= size) continue; // whole chip is erased flash → not data
      dataBlocks += 1;
      const coveredLen = unionLength([...claimSpans, ...emptySpans].filter(inChip).map(clip));
      if (size - coveredLen > 0) unclaimedBlocks += 1;
      else attributedBlocks += 1;
    }
  }
  return {
    mediumRef: medium.artifactId,
    mediumKind: "cartridge",
    mediumLabel: medium.mediumLabel,
    dataBlocks,
    attributedBlocks,
    unclaimedBlocks,
  };
}

export function computeMediumCoverage(medium: Medium): MediumBlockCoverage {
  return medium.mediumKind === "cartridge" ? cartCoverage(medium) : diskCoverage(medium);
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
