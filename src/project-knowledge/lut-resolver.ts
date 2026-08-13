// Spec 750 §1.1 / Decision 7 — resolve a table's rows from its description + the bytes.
//
// Rows are DERIVED, never stored. Correcting a descriptor corrects every row at once,
// and a rendered row cannot be stale. What persists elsewhere is only the resolved
// claim — payload X is claimed by (table, row) — because that is what must survive
// without the image.
//
// The whole point of this file is the four things that cannot be read off the bytes:
// whether `destination` is the destination or a pointer to it, which way the codec
// polarity runs, whether `length` was pre-biased, and whether `offset` points at the
// payload or past its header. Each is silently wrong for EVERY row when guessed, and
// each produces numbers that still look plausible. They live in the descriptor because
// they are facts about the image, not defaults of a tool.

import type { LutColumn, LutColumnRole, LutDescriptor } from "./types.js";

/** How to fetch a byte of the medium. Kept abstract so the same resolver serves a
 *  cartridge (bank + window address) and a disk (side + address) without knowing
 *  which it is looking at — Spec 750 §1: "disk and cartridge are the SAME model". */
export interface MediumReader {
  /** A byte, or undefined when the address is outside the image. `bank` is undefined
   *  for a medium without banking, or when the column does not override it. */
  readByte(bank: number | undefined, address: number): number | undefined;
}

/** One resolved row. Every field is optional because a table carries only the columns
 *  it has: an index-addressed table has no key, a data-only asset has no entry point. */
export interface ResolvedLutRow {
  index: number;
  /** The identity as it will be stored on a claim: (descriptorId, index). */
  key?: number[];
  bank?: number;
  /** Where the payload STARTS — `headerOffset` already subtracted. */
  offset?: number;
  /** The raw cell, before `headerOffset`. Kept because matching a manifest span may
   *  legitimately be against either, and mixing them is a silent few-byte drift. */
  offsetRaw?: number;
  length?: number;
  destination?: number;
  /** Set when `deref` applied: the address the pointer was read FROM. */
  destinationVia?: number;
  entry?: number;
  codecRaw?: number;
  /** The interpretation of `codecRaw` under this image's polarity. */
  packed?: boolean;
  track?: number;
  sector?: number;
  /** Anything that could not be read (address outside the image, missing column). */
  problems: string[];
}

export interface ResolveResult {
  rows: ResolvedLutRow[];
  /** Structural complaints about the DESCRIPTOR, not about a row. */
  problems: string[];
}

// ---------- cell reading ----------

function cellAddress(col: LutColumn, row: number, stride: number, which: "at" | "atLo" | "atHi"): number | undefined {
  const base = col[which];
  if (base === undefined) return undefined;
  return base + row * stride;
}

function readCell(
  reader: MediumReader,
  col: LutColumn,
  row: number,
  stride: number,
  bankOverride: number | undefined,
  problems: string[],
): number | undefined {
  const bank = col.bank ?? bankOverride;
  const width = col.width ?? 1;

  // Split 2-byte cell: two parallel arrays, one for each half. This is what a
  // `columns` table does, and it is why a row has no single address there.
  if (col.atLo !== undefined && col.atHi !== undefined) {
    const lo = reader.readByte(bank, cellAddress(col, row, stride, "atLo")!);
    const hi = reader.readByte(bank, cellAddress(col, row, stride, "atHi")!);
    if (lo === undefined || hi === undefined) {
      problems.push(`${col.role}: outside the image at row ${row}`);
      return undefined;
    }
    return lo | (hi << 8);
  }

  if (col.at === undefined) {
    problems.push(`${col.role}: no address (needs \`at\`, or \`atLo\`+\`atHi\`)`);
    return undefined;
  }

  const addr = cellAddress(col, row, stride, "at")!;
  const lo = reader.readByte(bank, addr);
  if (lo === undefined) {
    problems.push(`${col.role}: outside the image at row ${row} ($${addr.toString(16)})`);
    return undefined;
  }
  if (width === 1) return lo;

  const hi = reader.readByte(bank, addr + 1);
  if (hi === undefined) {
    problems.push(`${col.role}: high byte outside the image at row ${row}`);
    return undefined;
  }
  return lo | (hi << 8);
}

/** The stride between consecutive rows' cells for one column.
 *  `columns` — 1: the column IS an array, row n is cell n (times the cell width for a
 *              contiguous 2-byte cell; a split cell steps by 1 in each half).
 *  `packed`  — the record stride: every column advances by a whole record. */
function strideFor(d: LutDescriptor, col: LutColumn): number {
  if (col.stride !== undefined) return col.stride;
  if (d.layout === "packed") return d.recordStride ?? 1;
  const split = col.atLo !== undefined && col.atHi !== undefined;
  return split ? 1 : (col.width ?? 1);
}

// ---------- the four semantics ----------

/** `codec` → packed?, under this image's polarity. Nothing in the byte distinguishes
 *  the three, which is why the polarity is part of the description. */
function interpretCodec(col: LutColumn, raw: number): boolean | undefined {
  switch (col.polarity) {
    case "value":
      return raw !== 0;
    case "flag": {
      const bit = col.flagBit ?? 0;
      return ((raw >> bit) & 1) === 1;
    }
    case "inverted":
      // Zero means PACKED here. Reading a `value` image this way labels every raw
      // asset as packed and every packed one as raw, with nothing to notice it by.
      return raw === 0;
    default:
      return undefined;
  }
}

// ---------- resolve ----------

const byRole = (d: LutDescriptor, role: LutColumnRole): LutColumn | undefined =>
  d.columns.find((c) => c.role === role);

/** Structural check of a descriptor, independent of any row (Spec 750 Decision 8's
 *  hard half). Returns the complaints; empty means the shape is coherent. */
export function checkDescriptor(d: LutDescriptor): string[] {
  const problems: string[] = [];
  if (d.layout === "packed" && d.recordStride === undefined && !d.columns.some((c) => c.stride !== undefined)) {
    problems.push("layout=packed needs `recordStride` (or a per-column `stride`)");
  }
  if (d.rowCount === undefined && d.terminator === undefined) {
    problems.push("needs `rowCount` or a `terminator` — otherwise the table has no end");
  }
  for (const col of d.columns) {
    const split = col.atLo !== undefined && col.atHi !== undefined;
    if (col.at === undefined && !split) {
      problems.push(`column ${col.role}: needs \`at\`, or both \`atLo\` and \`atHi\``);
    }
    if (split && (col.width ?? 1) !== 2) {
      problems.push(`column ${col.role}: atLo/atHi is a 2-byte cell, but width is ${col.width ?? 1}`);
    }
    if (col.role === "codec" && !col.polarity) {
      // Not fatal, but the reading is undefined without it — say so rather than
      // silently defaulting, because a default here is wrong half the time.
      problems.push("column codec: no `polarity` — packed/raw cannot be decided (value | flag | inverted)");
    }
    if (col.deref && col.role !== "destination") {
      problems.push(`column ${col.role}: \`deref\` only means something for \`destination\``);
    }
  }
  const roles = d.columns.map((c) => c.role);
  const dupes = roles.filter((r, i) => roles.indexOf(r) !== i);
  if (dupes.length) problems.push(`duplicate column roles: ${[...new Set(dupes)].join(", ")}`);
  if (d.identity.scheme === "key-bytes" && !byRole(d, "key") && d.identity.keyWidth === undefined) {
    problems.push("identity=key-bytes needs a `key` column or `identity.keyWidth`");
  }
  return problems;
}

/** Resolve rows. `limit` caps the work for a probe (Decision 8: three rows are enough
 *  to see a polarity or a missed deref). */
export function resolveLutRows(
  d: LutDescriptor,
  reader: MediumReader,
  opts: { limit?: number; bank?: number } = {},
): ResolveResult {
  const problems = checkDescriptor(d);
  const rows: ResolvedLutRow[] = [];

  const max = d.rowCount ?? 4096; // a terminator-ended table still needs a ceiling
  const want = Math.min(max, opts.limit ?? max);

  const cols = {
    bank: byRole(d, "bank"),
    offset: byRole(d, "offset"),
    length: byRole(d, "length"),
    destination: byRole(d, "destination"),
    entry: byRole(d, "entry"),
    codec: byRole(d, "codec"),
    key: byRole(d, "key"),
    track: byRole(d, "track"),
    sector: byRole(d, "sector"),
  };

  for (let i = 0; i < want; i++) {
    const rowProblems: string[] = [];
    const row: ResolvedLutRow = { index: i, problems: rowProblems };
    const read = (c: LutColumn | undefined) =>
      c === undefined ? undefined : readCell(reader, c, i, strideFor(d, c), opts.bank, rowProblems);

    row.bank = read(cols.bank);
    const rowBank = row.bank ?? opts.bank;

    // A terminator ends the table before rowCount does.
    if (d.terminator !== undefined) {
      const first = d.columns[0];
      const probe = readCell(reader, first, i, strideFor(d, first), opts.bank, []);
      if (probe === d.terminator) break;
    }

    const rawOffset = read(cols.offset);
    if (rawOffset !== undefined) {
      row.offsetRaw = rawOffset;
      // The cell may point PAST a codec header the loader skips. Matching a manifest
      // span against the wrong one of these two is a few bytes of drift that nothing
      // notices — hence both are reported.
      row.offset = rawOffset - (cols.offset?.headerOffset ?? 0);
    }

    const rawLen = read(cols.length);
    if (rawLen !== undefined) row.length = rawLen + (cols.length?.lengthBias ?? 0);

    const rawDest = read(cols.destination);
    if (rawDest !== undefined) {
      if (cols.destination?.deref) {
        // The cell holds an address INTO the medium; the destination is the 16-bit
        // little-endian word stored there.
        const lo = reader.readByte(rowBank, rawDest);
        const hi = reader.readByte(rowBank, rawDest + 1);
        if (lo === undefined || hi === undefined) {
          rowProblems.push(`destination: pointer $${rawDest.toString(16)} is outside the image`);
        } else {
          row.destination = lo | (hi << 8);
          row.destinationVia = rawDest;
        }
      } else {
        row.destination = rawDest;
      }
    }

    row.entry = read(cols.entry);
    row.track = read(cols.track);
    row.sector = read(cols.sector);

    const rawCodec = read(cols.codec);
    if (rawCodec !== undefined) {
      row.codecRaw = rawCodec;
      if (cols.codec) row.packed = interpretCodec(cols.codec, rawCodec);
    }

    if (cols.key || d.identity.keyWidth) {
      const width = d.identity.keyWidth ?? 1;
      const keyBase = cols.key ? readCell(reader, cols.key, i, strideFor(d, cols.key), opts.bank, rowProblems) : undefined;
      if (keyBase !== undefined) {
        const bytes: number[] = [];
        for (let k = 0; k < width; k++) {
          const b = reader.readByte(rowBank, keyBase + k);
          if (b === undefined) break;
          bytes.push(b);
        }
        if (bytes.length) row.key = bytes;
      }
    }

    rows.push(row);
  }

  return { rows, problems };
}

/** Render resolved rows as the probe Decision 8 hands back: enough for an author to
 *  hold them against the disassembly they just read. */
export function formatLutProbe(d: LutDescriptor, rows: ResolvedLutRow[]): string {
  const hx = (n: number | undefined, w = 4) => (n === undefined ? "—" : `$${n.toString(16).padStart(w, "0")}`);
  const out: string[] = [];
  for (const r of rows) {
    const parts = [`${String(r.index).padStart(3)}`];
    if (r.bank !== undefined) parts.push(`bank ${r.bank}`);
    if (r.track !== undefined) parts.push(`T${r.track}/S${r.sector ?? "?"}`);
    if (r.offset !== undefined) {
      parts.push(r.offsetRaw !== r.offset ? `${hx(r.offset)} (cell ${hx(r.offsetRaw)})` : hx(r.offset));
    }
    if (r.length !== undefined) parts.push(`${r.length} bytes`);
    if (r.destination !== undefined) {
      parts.push(r.destinationVia !== undefined ? `→ ${hx(r.destination)} via ${hx(r.destinationVia)}` : `→ ${hx(r.destination)}`);
    }
    if (r.entry !== undefined) parts.push(`entry ${hx(r.entry)}`);
    if (r.packed !== undefined) parts.push(r.packed ? "packed" : "raw");
    if (r.key?.length) {
      const ascii = r.key.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
      parts.push(`key ${r.key.map((b) => b.toString(16).padStart(2, "0")).join(" ")} "${ascii}"`);
    }
    if (r.problems.length) parts.push(`⚠ ${r.problems.join("; ")}`);
    out.push(parts.join("  "));
  }
  if (!out.length) out.push("(no rows resolved)");
  return out.join("\n");
}
