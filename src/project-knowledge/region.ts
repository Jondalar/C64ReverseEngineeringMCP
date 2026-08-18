// Spec 813 §2 — a region is a NAMED ADDRESS SET, not a picture crop.
//
// A rectangle marked on the screen is only one way to produce one. In text mode it
// resolves to `$0400 + row*40 + col` plus the matching colour-RAM bytes; in a memory
// view it is written down directly. Same object either way, same predicates, one
// implementation — which is what makes "later, in RAM/IO too" free rather than a
// second feature.
//
// The comparison runs over BYTES. That makes it exact and blind to the sprites,
// raster splits and colour cycling happening around the box, which is the whole
// reason a region can turn 810's verbal criterion into a byte-exact one.

/** Which view of the address space a range is read through (TRX64 `peek_lens`). */
export type RegionLens = "cpu" | "ram" | "io" | "rom" | "cart";

export interface RegionRange {
  addr: number;
  len: number;
  lens: RegionLens;
}

/** How a region came to be, kept so a human can see what was marked. */
export interface RegionOrigin {
  kind: "screen-rect";
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface Region {
  name: string;
  ranges: RegionRange[];
  origin?: RegionOrigin;
  /** Where the definition came from — the report says which, and why that matters. */
  source: "local" | "entity";
  /** Set when a local definition shadows a store entity of the same name. */
  shadowsEntity?: string;
}

export const SCREEN_COLS = 40;
export const SCREEN_ROWS = 25;

/**
 * The text-mode address set for a character rectangle.
 *
 * `screenBase` and `colorBase` come from the machine (the VIC bank + $D018, and
 * $D800 fixed): this function does not guess them, because guessing the VIC's
 * addressing is exactly the mistake BUG-051 was. One range PER ROW — a rectangle is
 * not contiguous in memory, and reading the bounding span instead would compare
 * bytes the human never marked.
 */
export function screenRectRanges(
  rect: { col: number; row: number; cols: number; rows: number },
  bases: { screenBase: number; colorBase?: number },
): RegionRange[] {
  const ranges: RegionRange[] = [];
  for (let r = 0; r < rect.rows; r++) {
    const off = (rect.row + r) * SCREEN_COLS + rect.col;
    ranges.push({ addr: (bases.screenBase + off) & 0xffff, len: rect.cols, lens: "ram" });
    if (bases.colorBase !== undefined) {
      ranges.push({ addr: (bases.colorBase + off) & 0xffff, len: rect.cols, lens: "io" });
    }
  }
  return ranges;
}

/** Total bytes a region reads — the runtime caps a read at 32 KiB (Spec 813 §8). */
export function regionSize(region: Region): number {
  return region.ranges.reduce((n, r) => n + r.len, 0);
}

// -- screen codes -------------------------------------------------------------
//
// §3 — the C64 text screen IS characters, one byte per cell, so matching text on it
// is a table lookup and a substring search. No OCR, no image hashing.

// Screen codes 0-31: @ A-Z [ pound ] up-arrow left-arrow.
const SC_LOW = "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[£]↑←";

/** One screen code to the character it draws. Reverse video (bit 7) draws the same
 *  character, so it is masked off. Graphics codes ($40-$7F) have no letter and come
 *  back as a space: they never match a searched string, and they never merge two
 *  words into one either. */
export function screenCodeToChar(code: number): string {
  const c = code & 0x7f;
  if (c < 32) return SC_LOW[c];
  if (c < 64) return String.fromCharCode(c); // space ! " # ... 0-9 : ; < = > ?
  return " ";
}

/** A screen-code buffer as text, one string per row. */
export function screenCodesToRows(codes: Uint8Array, cols = SCREEN_COLS): string[] {
  const rows: string[] = [];
  for (let i = 0; i < codes.length; i += cols) {
    let s = "";
    for (let j = i; j < Math.min(i + cols, codes.length); j++) s += screenCodeToChar(codes[j]);
    rows.push(s);
  }
  return rows;
}

/**
 * Does the screen show `needle`?
 *
 * Matching is done per ROW and case-insensitively, with runs of spaces collapsed: a
 * menu that pads its entries with spaces still matches what a human reads off the
 * screen, and a needle is never accidentally found across a line break — the two
 * halves of "PRESS" split over the right edge are not the word.
 */
export function screenShows(codes: Uint8Array, needle: string, cols = SCREEN_COLS): boolean {
  const want = normalizeScreenText(needle);
  if (!want) return false;
  return screenCodesToRows(codes, cols).some((row) => normalizeScreenText(row).includes(want));
}

export function normalizeScreenText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toUpperCase();
}

// -- resolution ---------------------------------------------------------------
//
// §5 — a region may be defined in the .feature (local) or resolved from the project
// store (entity). LOCAL WINS, and the run says so. Without that line someone edits
// the entity, nothing changes, and an hour goes into finding out why.

export interface StoredRegion {
  entityId: string;
  name: string;
  ranges: RegionRange[];
  origin?: RegionOrigin;
  /** The address the acceptance froze, if this region has ever been accepted. */
  frozenRanges?: RegionRange[];
}

export interface RegionResolution {
  regions: Map<string, Region>;
  /** One line per region, for the report. */
  lines: string[];
  /** 810's rule: a named target that MOVED is reported, never followed. */
  moved: string[];
  errors: string[];
}

export interface LocalRegionDef {
  name: string;
  rect?: { col: number; row: number; cols: number; rows: number };
}

/**
 * Resolve the regions a scenario names.
 *
 * `lookup` reaches into the project store; pass a function that returns undefined
 * when there is no store (a bare scenario run has none, and that must not be an
 * error unless a name actually needs one).
 */
export function resolveRegions(
  defs: LocalRegionDef[],
  bases: { screenBase: number; colorBase?: number },
  lookup?: (name: string) => StoredRegion | undefined,
): RegionResolution {
  const regions = new Map<string, Region>();
  const lines: string[] = [];
  const moved: string[] = [];
  const errors: string[] = [];

  for (const def of defs) {
    const stored = lookup?.(def.name);

    if (def.rect) {
      const region: Region = {
        name: def.name,
        ranges: screenRectRanges(def.rect, bases),
        origin: { kind: "screen-rect", ...def.rect },
        source: "local",
        ...(stored ? { shadowsEntity: stored.entityId } : {}),
      };
      regions.set(def.name, region);
      lines.push(
        `  ${def.name.padEnd(8)} ${describeRect(def.rect)}   local` +
          (stored ? ` (shadows entity ${stored.entityId})` : ""),
      );
      continue;
    }

    if (!stored) {
      errors.push(
        `the scenario uses the region "${def.name}" without defining it, and the project ` +
          `store has no region by that name. Either give it a rectangle — ` +
          `\`Given the region "${def.name}" covers 30,1 to 37,1\` — or save it as an entity first.`,
      );
      continue;
    }

    // 810's frozen-resolution rule. A criterion that silently re-resolved would check
    // a different address tomorrow and stay green while doing it.
    if (stored.frozenRanges && !sameRanges(stored.frozenRanges, stored.ranges)) {
      moved.push(
        `region "${def.name}" (${stored.entityId}) has MOVED since it was accepted: ` +
          `frozen at ${describeRanges(stored.frozenRanges)}, now ${describeRanges(stored.ranges)}. ` +
          `Reported, not followed — re-accept it deliberately or fix the entity.`,
      );
      continue;
    }

    regions.set(def.name, {
      name: def.name,
      ranges: stored.ranges,
      origin: stored.origin,
      source: "entity",
    });
    lines.push(
      `  ${def.name.padEnd(8)} ${stored.origin ? describeRect(stored.origin) : describeRanges(stored.ranges)}   entity ${stored.entityId}`,
    );
  }

  return { regions, lines, moved, errors };
}

function describeRect(r: { col: number; row: number; cols: number; rows: number }): string {
  return `${r.col},${r.row}-${r.col + r.cols - 1},${r.row + r.rows - 1}`;
}

function describeRanges(ranges: RegionRange[]): string {
  return ranges.map((r) => `$${r.addr.toString(16).padStart(4, "0")}+${r.len}`).join(" ");
}

function sameRanges(a: RegionRange[], b: RegionRange[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.addr === b[i].addr && r.len === b[i].len && r.lens === b[i].lens);
}

/** Concatenate the chunks a read returned, in range order — the region's bytes. */
export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
