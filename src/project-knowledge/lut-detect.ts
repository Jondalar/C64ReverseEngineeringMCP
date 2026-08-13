// Spec 750.7 — propose a table's SHAPE from the bytes. Never its semantics.
//
// A table's structure is visible in the image: parallel arrays of equal length, or
// records at a fixed stride. What is NOT visible is what the columns MEAN — whether
// `destination` holds the destination or a pointer to it, which way the `codec`
// polarity runs. Those live only in the loader code, and §1.1 exists because guessing
// them is silently wrong for every row at once with numbers that still look plausible.
//
// So everything here proposes structure and leaves semantics EMPTY, loudly. A
// suggestion is a reading aid; it does not write itself into the store, and it does not
// "helpfully" default a field whose wrong value cannot be noticed.

export interface DetectorInput {
  /** The bytes to scan. */
  bytes: Uint8Array;
  /** Address the first byte sits at, so proposals carry real addresses. */
  baseAddress: number;
  /** Bank these bytes belong to, when the medium has banks. */
  bank?: number;
}

export interface ProposedColumn {
  /** Only ever a HINT — the bytes cannot name a role. Absent when nothing is implied. */
  roleHint?: "bank" | "offset" | "length" | "destination" | "entry" | "codec" | "track" | "sector";
  at?: number;
  atLo?: number;
  atHi?: number;
  width: 1 | 2;
  /** Why this looked like a column, in words a reader can check against the bytes. */
  evidence: string;
}

export interface ProposedDescriptor {
  layout: "packed" | "columns";
  rowCount: number;
  recordStride?: number;
  terminator?: number;
  columns: ProposedColumn[];
  /** 0..1 — how much of this the bytes actually support. Never a claim of correctness. */
  confidence: number;
  evidence: string[];
  /** The fields a human must fill from the disassembly. Always non-empty by design. */
  needsFromCode: string[];
}

// ---------- primitives ----------

/** Distinct values in a run — a column of bank numbers or high bytes has few. */
function distinctCount(bytes: Uint8Array, start: number, len: number, stride = 1): number {
  const seen = new Set<number>();
  for (let i = 0; i < len; i++) {
    const at = start + i * stride;
    if (at >= bytes.length) break;
    seen.add(bytes[at]);
  }
  return seen.size;
}

/** Are all values in a run plausible HIGH bytes of an address in one of the windows a
 *  C64 medium actually uses? This is the signal that a run is the hi half of a split
 *  16-bit column — the thing a human most often mis-transcribes. */
function looksLikeHighBytes(bytes: Uint8Array, start: number, len: number): { ok: boolean; window: string } {
  const vals: number[] = [];
  for (let i = 0; i < len; i++) {
    if (start + i >= bytes.length) return { ok: false, window: "" };
    vals.push(bytes[start + i]);
  }
  if (!vals.length) return { ok: false, window: "" };
  const min = Math.min(...vals), max = Math.max(...vals);

  // A run one value DOMINATES is padding or a constant, not an address column. Real
  // high bytes of a table's addresses walk up as the payloads march through the
  // window. Without this a mostly-zero region reads as "an address column in zero
  // page", which is how the first version of this detector answered with a confident
  // false positive on a table it should have found four arrays to the left.
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  const dominant = Math.max(...counts.values()) / vals.length;
  if (dominant > 0.6) return { ok: false, window: "" };
  // And it must actually vary: two distinct values over sixteen rows is a flag column.
  if (counts.size < 3) return { ok: false, window: "" };

  // A cartridge window ($8000-$BFFF) or a RAM page range tight enough that a run of
  // arbitrary data would not land inside it by chance. Zero page is deliberately NOT
  // here: "all values below $10" is satisfied by any sparse region, so it admits
  // padding rather than describing a destination.
  const windows: Array<[number, number, string]> = [
    [0x80, 0xbf, "$8000-$BFFF (cart window)"],
    [0x10, 0x3f, "$1000-$3FFF"],
    [0x40, 0x7f, "$4000-$7FFF"],
    [0xc0, 0xff, "$C000-$FFFF"],
  ];
  for (const [lo, hi, name] of windows) {
    if (min >= lo && max <= hi) return { ok: true, window: name };
  }
  return { ok: false, window: "" };
}

/** A run of $00 or $FF long enough to be padding rather than data. */
function isFill(bytes: Uint8Array, start: number, len: number): boolean {
  if (start + len > bytes.length || len === 0) return false;
  const v = bytes[start];
  if (v !== 0x00 && v !== 0xff) return false;
  for (let i = 1; i < len; i++) if (bytes[start + i] !== v) return false;
  return true;
}

// ---------- columns layout ----------

/** Look for N parallel arrays of the same length at a regular pitch.
 *
 *  The anchor is a lo/hi PAIR: two runs `rowCount` apart where the second holds only
 *  plausible high bytes. Once the pitch is known, the arrays around it fall out. */
export function detectColumnsLayout(input: DetectorInput): ProposedDescriptor[] {
  const { bytes, baseAddress, bank } = input;
  const out: ProposedDescriptor[] = [];

  // Pitch = how far apart consecutive column arrays sit. Arrays are padded to a round
  // size, so the pitch is round — but the ROW COUNT is not tied to it. Sixteen rows in
  // a 64-byte pitch is the normal case, and an earlier version derived rowCount FROM
  // the pitch: it then answered with an 8-row sub-window of a 16-row table and looked
  // right while being a strictly worse reading. The row count comes out of the DATA —
  // the length of the windowed run in the hi array.
  for (const pitch of [8, 16, 24, 32, 48, 64, 80, 96, 128, 160, 192, 256]) {
    if (pitch * 2 >= bytes.length) break;
    for (let a = 0; a + pitch < bytes.length; a += pitch) {
      const hiStart = a + pitch;
      // How far does a windowed, non-dominated run reach from hiStart? That length IS
      // the candidate row count.
      let rowCount = 0;
      for (let len = 4; len <= Math.min(pitch, bytes.length - hiStart); len++) {
        if (looksLikeHighBytes(bytes, hiStart, len).ok) rowCount = len;
      }
      if (rowCount < 4) continue;
      const hi = looksLikeHighBytes(bytes, hiStart, rowCount);
      if (!hi.ok) continue;
      if (a + rowCount > bytes.length) continue;
      // The lo half must be genuinely varied — two runs of near-constant bytes are
      // padding side by side, not an address split across arrays.
      const loDistinct = distinctCount(bytes, a, rowCount);
      if (loDistinct < 3) continue;
      if (isFill(bytes, a, rowCount) || isFill(bytes, hiStart, rowCount)) continue;

      const columns: ProposedColumn[] = [{
        atLo: baseAddress + a,
        atHi: baseAddress + hiStart,
        width: 2,
        evidence: `${rowCount} lo bytes at $${(baseAddress + a).toString(16)} with ${loDistinct} distinct values, and ${rowCount} hi bytes at $${(baseAddress + hiStart).toString(16)} all inside ${hi.window}`,
      }];

      // Neighbouring arrays at the same pitch: candidates for the 1-byte columns
      // (bank, codec, a flag). Their ROLE is not knowable from the bytes.
      for (const delta of [-pitch, pitch * 2, pitch * 3]) {
        const at = a + delta;
        if (at < 0 || at + rowCount > bytes.length) continue;
        const d = distinctCount(bytes, at, rowCount);
        if (d < 2 || d > Math.max(4, rowCount / 2)) continue;
        if (isFill(bytes, at, rowCount)) continue;
        columns.push({
          at: baseAddress + at,
          width: 1,
          evidence: `${rowCount} bytes at $${(baseAddress + at).toString(16)} with only ${d} distinct values — a small-alphabet column (bank? codec? flags?), the bytes cannot say which`,
        });
      }

      // The lo/hi pair is the signal; extra columns corroborate; a longer table is
      // stronger evidence than a short one, because a short windowed run happens by
      // chance far more often.
      const confidence = Math.min(
        0.9,
        0.4 + 0.1 * (columns.length - 1) + (hi.window.includes("cart") ? 0.15 : 0) + Math.min(0.2, rowCount / 100),
      );
      out.push({
        layout: "columns",
        rowCount,
        columns,
        confidence,
        evidence: [
          `parallel arrays at a pitch of ${pitch} bytes, ${rowCount} rows (the row count is the length of the windowed run, not the pitch)`,
          ...columns.map((c) => c.evidence),
        ],
        needsFromCode: SEMANTICS_FROM_CODE,
      });
    }
  }

  // Best few, most-corroborated first. A detector that returns forty candidates has
  // told you nothing.
  return dedupe(out).sort((x, y) => y.confidence - x.confidence).slice(0, 4);
}

// ---------- packed layout ----------

/** Look for records at a fixed stride: score each stride by how column-like the
 *  positions become when the run is folded at it. */
export function detectPackedLayout(input: DetectorInput): ProposedDescriptor[] {
  const { bytes, baseAddress } = input;
  const out: ProposedDescriptor[] = [];

  for (let stride = 2; stride <= 16; stride++) {
    const maxRows = Math.floor(bytes.length / stride);
    if (maxRows < 4) continue;

    // Where does it end? A record of pure $00/$FF is the classic terminator.
    let rows = maxRows;
    let terminator: number | undefined;
    for (let r = 0; r < maxRows; r++) {
      if (isFill(bytes, r * stride, stride)) { rows = r; terminator = bytes[r * stride]; break; }
    }
    if (rows < 4) continue;

    // Column-likeness: for each position in the record, few distinct values across
    // rows means a real column (a track number, a flag). All positions being wildly
    // varied means we folded arbitrary data at an arbitrary stride.
    const columnar: number[] = [];
    for (let pos = 0; pos < stride; pos++) {
      const d = distinctCount(bytes, pos, rows, stride);
      if (d >= 2 && d <= Math.max(3, rows / 3)) columnar.push(pos);
    }
    if (!columnar.length) continue;

    const score = columnar.length / stride;
    if (score < 0.25) continue;

    out.push({
      layout: "packed",
      rowCount: rows,
      recordStride: stride,
      terminator,
      columns: columnar.map((pos) => ({
        at: baseAddress + pos,
        width: 1,
        evidence: `position ${pos} of each ${stride}-byte record holds only ${distinctCount(bytes, pos, rows, stride)} distinct values across ${rows} records`,
      })),
      confidence: Math.min(0.8, 0.3 + score * 0.5 + (terminator !== undefined ? 0.15 : 0)),
      evidence: [
        `records of ${stride} bytes, ${rows} of them${terminator !== undefined ? `, ended by an all-$${terminator.toString(16).padStart(2, "0")} record` : " (no terminator found — rowCount is the run length)"}`,
        `${columnar.length} of ${stride} positions behave like columns`,
      ],
      needsFromCode: SEMANTICS_FROM_CODE,
    });
  }

  return out.sort((x, y) => y.confidence - x.confidence).slice(0, 3);
}

/** The fields a detector must never fill. Kept as one list so the refusal is stated in
 *  exactly one place and cannot drift from what the resolver actually needs. */
export const SEMANTICS_FROM_CODE = [
  "which ROLE each column plays — a small-alphabet column could be `bank`, `codec` or a flag, and the bytes cannot say",
  "`deref` — whether `destination` holds the destination or a POINTER to it",
  "`polarity` — whether `codec` runs value | flag | inverted (inverted means 0 = PACKED)",
  "`lengthBias` — whether the stored length was already biased",
  "`headerOffset` — whether `offset` points at the payload or past a codec header",
];

function dedupe(list: ProposedDescriptor[]): ProposedDescriptor[] {
  const seen = new Set<string>();
  const out: ProposedDescriptor[] = [];
  for (const d of list) {
    const key = `${d.layout}:${d.rowCount}:${d.columns.map((c) => c.at ?? c.atLo).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export function detectTables(input: DetectorInput): ProposedDescriptor[] {
  return [...detectColumnsLayout(input), ...detectPackedLayout(input)]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}

/** Render proposals for a reader. Every one carries what it CANNOT know, because a
 *  suggestion that reads like an answer is worse than no suggestion. */
export function formatProposals(list: ProposedDescriptor[]): string {
  if (!list.length) {
    return "No table-shaped run found in that range. That is a statement about the SHAPE only — a table whose columns are all high-entropy looks like data from the outside. Read the loader.";
  }
  const hx = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  const out: string[] = [];
  list.forEach((d, i) => {
    out.push(`── candidate ${i + 1} — ${d.layout}, ${d.rowCount} rows, confidence ${(d.confidence * 100).toFixed(0)}%`);
    for (const e of d.evidence) out.push(`     ${e}`);
    for (const c of d.columns) {
      const where = c.atLo !== undefined ? `${hx(c.atLo)} / ${hx(c.atHi!)} (split 2-byte)` : `${hx(c.at!)} (1 byte)`;
      out.push(`     column at ${where}${c.roleHint ? ` — hint: ${c.roleHint}` : ""}`);
    }
    out.push("");
  });
  out.push("NOT INFERRED — read these out of the loader and pass them to declare_lut_descriptor:");
  for (const n of SEMANTICS_FROM_CODE) out.push(`  - ${n}`);
  out.push("");
  out.push("Nothing above was written to the project. A shape is a reading aid; getting a semantic wrong is silently wrong for every row at once.");
  return out.join("\n");
}
