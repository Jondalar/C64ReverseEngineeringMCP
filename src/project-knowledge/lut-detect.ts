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

/** The smallest run this will call a table. Set from a real cartridge, not from
 *  taste: at four rows the shape test is met by chance throughout ordinary code. */
const MIN_ROWS = 8;

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

  // ONLY the cartridge bank window. The RAM ranges that used to be here ($1000-$3FFF
  // and friends) were wide enough that any COUNTING TABLE landed in one — and a game
  // is full of those. A real cartridge answered with screen-offset tables
  // (`00 01 02 03 …` and `04 0e 18 22 2c …`, a ten-wide grid), which satisfy monotone,
  // spread and dense perfectly while being the opposite of an addressing table.
  //
  // A table that indexes payloads INSIDE a bank holds bank-window addresses. That is
  // the property worth testing; "these bytes ascend" is not.
  if (min >= 0x80 && max <= 0xbf) return { ok: true, window: "$8000-$BFFF (cart window)" };
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
  // A pitch below MIN_ROWS cannot hold a table of MIN_ROWS entries without the arrays
  // overlapping, so those pitches only ever matched adjacent scraps of code.
  for (const pitch of [16, 24, 32, 48, 64, 80, 96, 128, 160, 192, 256]) {
    if (pitch * 2 >= bytes.length) break;
    for (let a = 0; a + pitch < bytes.length; a += pitch) {
      const hiStart = a + pitch;
      // How far does a windowed, non-dominated run reach from hiStart? That length IS
      // the candidate row count.
      let rowCount = 0;
      for (let len = MIN_ROWS; len <= Math.min(pitch, bytes.length - hiStart); len++) {
        if (looksLikeHighBytes(bytes, hiStart, len).ok) rowCount = len;
      }
      // MIN_ROWS is the single most important number here. At four rows the test is
      // met by chance all over ordinary code — a real cartridge answered with four
      // 89%-confident candidates, every one of them a coincidence inside a routine.
      // An index worth finding has entries; a four-entry run is noise wearing a table's
      // shape.
      if (rowCount < MIN_ROWS) continue;
      const hi = looksLikeHighBytes(bytes, hiStart, rowCount);
      if (!hi.ok) continue;
      if (a + rowCount > bytes.length) continue;
      // The lo half must be genuinely varied — two runs of near-constant bytes are
      // padding side by side, not an address split across arrays.
      // The lo half of an address column is nearly all distinct: consecutive payloads
      // do not start at the same low byte. Code, by contrast, repeats itself. This is
      // the discriminator that a "few distinct values" test does not give you.
      const loDistinct = distinctCount(bytes, a, rowCount);
      if (loDistinct < Math.ceil(rowCount * 0.7)) continue;

      // THE discriminator. Decode the pair as 16-bit addresses and ask whether they
      // behave like a table of positions: payloads are laid out in order, so the
      // decoded values climb. Noise does not climb — it wanders.
      //
      // Without this the detector was a sieve: a real 64-bank cartridge produced 288
      // candidates over 65 windows, four or five per window, every one of them a run
      // of code that happened to satisfy "high bytes inside the window". Being inside
      // the window is nearly free in cartridge code; being MONOTONE is not.
      const decoded: number[] = [];
      for (let i = 0; i < rowCount; i++) decoded.push(bytes[a + i] | (bytes[hiStart + i] << 8));
      let ascending = 0;
      for (let i = 1; i < decoded.length; i++) if (decoded[i] > decoded[i - 1]) ascending++;
      const ascendingRatio = ascending / (decoded.length - 1);
      if (ascendingRatio < 0.7) continue;
      // And they must actually spread: sixteen addresses inside forty bytes of each
      // other is a run of operands, not a table of payload positions.
      const span = Math.max(...decoded) - Math.min(...decoded);
      if (span < rowCount * 8) continue;
      if (isFill(bytes, a, rowCount) || isFill(bytes, hiStart, rowCount)) continue;

      const columns: ProposedColumn[] = [{
        atLo: baseAddress + a,
        atHi: baseAddress + hiStart,
        width: 2,
        evidence: `${rowCount} lo bytes at $${(baseAddress + a).toString(16)} with ${loDistinct} distinct values, ${rowCount} hi bytes at $${(baseAddress + hiStart).toString(16)} all inside ${hi.window}, and the decoded addresses climb (${(ascendingRatio * 100).toFixed(0)}% ascending, spanning $${span.toString(16)})`,
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
      // Row count dominates. Corroborating columns are worth little on their own —
      // in code, ANY short run has few distinct values, so counting them rewarded
      // exactly the false positives. Length is the thing chance does not supply.
      const lengthTerm = Math.min(0.35, (rowCount - MIN_ROWS) / 64);
      const densityTerm = 0.1 * (loDistinct / rowCount);
      const orderTerm = 0.2 * ascendingRatio;
      const confidence = Math.min(
        0.9,
        0.15 + lengthTerm + densityTerm + orderTerm + 0.05 * Math.min(3, columns.length - 1),
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

  // A record needs FIELDS. At stride 2 with one column-like position, any run of
  // ordinary data qualifies — the real cartridge answered with a 306-row "table" that
  // was just code seen through a 2-byte window. Three bytes is the smallest thing that
  // can carry an addressing decision (a position and something about it).
  for (let stride = 3; stride <= 16; stride++) {
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
    // One column-like position is not a table, it is a coincidence with a name. A
    // record whose fields all vary freely is also not detectable as one — say nothing
    // rather than something.
    if (columnar.length < 2) continue;

    // A "table" that covers the whole scanned window IS the window. Without a
    // terminator to end it, a stride of 3 over 8 KB reports 2730 records at 80%
    // confidence — the folded bank, not an index. A real untermined table is a small
    // part of what it sits in; a terminated one has said where it ends and may be
    // any length.
    if (terminator === undefined && rows * stride > bytes.length * 0.25) continue;
    // And an index has a plausible number of entries. Thousands of records is a
    // bitmap being read through the wrong lens.
    if (rows > 512) continue;

    const score = columnar.length / stride;
    if (score < 0.35) continue;

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

// ── the ANCHOR: start from the code, not from the bytes ──────────────────────
//
// Scanning bytes for table-shaped runs does not work on real cartridge content, and
// two real images settled it: after six tightenings it still answered with two false
// candidates per 8 KB window, because every shape signal — high bytes inside the bank
// window, few distinct values, monotone and spread — is ordinary in game data. One of
// them showed exactly why: a screen-offset table (`00 01 02 03 …`, `04 0e 18 22 …`)
// satisfies "monotone, spread, dense" perfectly while being the opposite of an
// addressing table, and a game holds dozens.
//
// The anchor belongs in the CODE. A loader that indexes a table compiles to
// `LDA $8500,X` — and the analyser already records every one of those with its base
// address resolved (`codeAnalysis.instructions`, addressingMode `abs,x`/`abs,y`). That
// base IS a column address, named by the machine rather than guessed at. The shape
// checks above keep their job: they CONFIRM a candidate and find its siblings. They
// are no longer the thing that finds it.

export interface IndexedAccess {
  /** Where the instruction is. */
  address: number;
  /** The base address it indexes — a column of a table, if it is reading one. */
  base: number;
  mnemonic: string;
  mode: string;
}

/** Pull every resolved indexed absolute access out of an analysis report's
 *  instructions. Loads AND stores: a loader reads its table, a builder writes it. */
export function indexedAccesses(instructions: Array<{
  address: number; mnemonic?: string; addressingMode?: string;
  targetAddress?: number; operandValue?: number;
}>): IndexedAccess[] {
  const out: IndexedAccess[] = [];
  for (const i of instructions) {
    const mode = i.addressingMode ?? "";
    if (mode !== "abs,x" && mode !== "abs,y") continue;
    const base = i.targetAddress ?? i.operandValue;
    if (base === undefined) continue;
    out.push({ address: i.address, base, mnemonic: (i.mnemonic ?? "").toLowerCase(), mode });
  }
  return out;
}

/** The longest run of addresses in arithmetic progression. Columns of one table are
 *  each padded to the same size, so their base addresses step by a constant. */
function longestProgression(sorted: number[]): { pitch: number; members: number[] } | undefined {
  let best: { pitch: number; members: number[] } | undefined;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const pitch = sorted[j] - sorted[i];
      // A pitch below 4 is two fields of one record, not two columns; above 4 KB the
      // "columns" are in different parts of the image and the pitch means nothing.
      if (pitch < 4 || pitch > 0x1000) continue;
      const members = [sorted[i]];
      let next = sorted[i] + pitch;
      for (const b of sorted) {
        if (b === next) { members.push(b); next += pitch; }
      }
      if (members.length >= 3 && (!best || members.length > best.members.length)) {
        best = { pitch, members };
      }
    }
  }
  return best;
}

export interface AnchoredCandidate {
  /** Column base addresses, ascending — these came from the CODE. */
  bases: number[];
  /** The instructions that read/write them, so a reader can go and look. */
  readers: number[];
  /** How tightly the reading code sits together. Columns of one table are indexed by
   *  one routine, usually within a few dozen bytes of each other. */
  codeSpan: number;
  /** The regular pitch the columns sit at, when one was found. */
  pitch?: number;
  /** Bases the same code touches that do NOT fit the pitch — reported, not hidden. */
  others?: number[];
  /** Confirmation from the bytes, when a medium was supplied. */
  shape?: ProposedDescriptor;
  evidence: string[];
  needsFromCode: string[];
}

/** Group indexed accesses into candidate TABLES.
 *
 *  Two bases belong to the same table when the instructions reading them sit close
 *  together in the code — one routine walking one table. That is a far stronger
 *  grouping rule than "these addresses are near each other", because a routine may
 *  index columns that are pages apart, and two unrelated routines may index adjacent
 *  addresses. */
export function anchorCandidates(
  accesses: IndexedAccess[],
  opts: { codeWindow?: number; minColumns?: number } = {},
): AnchoredCandidate[] {
  const codeWindow = opts.codeWindow ?? 64;
  const minColumns = opts.minColumns ?? 2;
  const sorted = [...accesses].sort((a, b) => a.address - b.address);

  const groups: IndexedAccess[][] = [];
  let cur: IndexedAccess[] = [];
  for (const a of sorted) {
    if (!cur.length || a.address - cur[cur.length - 1].address <= codeWindow) cur.push(a);
    else { groups.push(cur); cur = [a]; }
  }
  if (cur.length) groups.push(cur);

  const out: AnchoredCandidate[] = [];
  for (const g of groups) {
    const bases = [...new Set(g.map((a) => a.base))].sort((x, y) => x - y);
    if (bases.length < minColumns) continue;
    const readers = g.map((a) => a.address);
    const codeSpan = readers[readers.length - 1] - readers[0];

    // Within a routine's accesses, the COLUMNS OF ONE TABLE sit at a regular pitch —
    // parallel arrays each padded to the same size. Everything else the routine
    // touches (a SID register, a scratch byte, another table) does not fit that
    // progression. Without this the anchor is grounded but coarse: one real routine
    // came back as 67 bases including $D400-$D406.
    const progression = longestProgression(bases);
    if (progression && progression.members.length >= 3) {
      out.push({
        bases: progression.members,
        readers,
        codeSpan,
        pitch: progression.pitch,
        others: bases.filter((b) => !progression.members.includes(b)),
        evidence: [
          `${progression.members.length} base addresses at a REGULAR PITCH of ${progression.pitch} bytes — parallel columns of one table`,
          `indexed by ${g.length} instruction(s) within ${codeSpan} bytes of code, starting at $${readers[0].toString(16)}`,
          ...g.filter((a) => progression.members.includes(a.base)).slice(0, 6)
            .map((a) => `  $${a.address.toString(16)}  ${a.mnemonic} $${a.base.toString(16)},${a.mode.endsWith("x") ? "X" : "Y"}`),
          ...(bases.length > progression.members.length
            ? [`${bases.length - progression.members.length} further base(s) in the same code do NOT fit the pitch — a routine touches more than one thing`]
            : []),
        ],
        needsFromCode: SEMANTICS_FROM_CODE,
      });
      continue;
    }

    out.push({
      bases,
      readers,
      codeSpan,
      evidence: [
        `${bases.length} distinct base address(es) indexed by ${g.length} instruction(s) within ${codeSpan} bytes of code, starting at $${readers[0].toString(16)}`,
        ...g.slice(0, 6).map((a) => `  $${a.address.toString(16)}  ${a.mnemonic} $${a.base.toString(16)},${a.mode.endsWith("x") ? "X" : "Y"}`),
      ],
      needsFromCode: SEMANTICS_FROM_CODE,
    });
  }
  return out.sort((a, b) => b.bases.length - a.bases.length);
}

/** Render anchored candidates. The reading instruction is quoted with every one,
 *  because that is what makes this a finding rather than a guess. */
export function formatAnchored(list: AnchoredCandidate[]): string {
  if (!list.length) {
    return "No indexed absolute access found in that code. A loader that reads its table through a pointer (`LDA ($fb),Y`) leaves no base address to anchor on — read the disassembly.";
  }
  const hx = (n: number) => `$${n.toString(16).toUpperCase().padStart(4, "0")}`;
  const out: string[] = [];
  list.forEach((c, i) => {
    out.push(`── candidate ${i + 1} — ${c.bases.length} column base(s)${c.pitch ? ` at a pitch of ${c.pitch}` : ""}: ${c.bases.map(hx).join(" ")}`);
    for (const e of c.evidence) out.push(`     ${e}`);
    out.push("");
  });
  out.push("Each base above is an address the CODE indexes — not a shape found in the bytes.");
  out.push("");
  out.push("NOT INFERRED — read these out of the loader and pass them to declare_lut_descriptor:");
  for (const n of SEMANTICS_FROM_CODE) out.push(`  - ${n}`);
  return out.join("\n");
}
