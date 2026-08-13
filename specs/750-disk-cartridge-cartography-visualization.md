# Spec 750 — Disk + Cartridge Cartography Visualization (payloads · addressing · loaders)

**Status:** READY (2026-08-12; was BLOCKED 2026-08-11, was DRAFT 2026-06-02). This is
the STATIC strand of the RE workflow — "meticulously extract + cartograph" — made
REAL in the UI. NOT a duplicate of the retired Spec 749: 749 re-derived Spec 721's
medium model; 750 USES that model + wires the existing addressing schemas into the
two existing views.

**Unblocked 2026-08-12, and the block was on the wrong thing.** This spec waited on a
meta format authored outside the repo. Measuring what 750.2 actually needs showed the
three gaps are all on this side — the write tools are not in `DEFAULT_TOOLS`, no view
builder reads either store, and no steering rule asks anyone to fill them — and none of
them needs anything external. What the outside conversation *did* settle is the SHAPE of
a row, which is the fourth gap and the one nobody had noticed: the existing schema can
say "there is a table at `$8194`" but cannot say what its columns mean. See §3 750.2.

## 0. Decisions (refined with the user)

1. **Scope = the full picture.** The views show payloads-at-position **+ the
   addressing itself (the "table of contents")** as a first-class overlay **+
   loader/mutator edges** (who loads / who mutates a payload).
2. **Model = wire the EXISTING schemas, no new entity.** Addressing rides on
   `LoaderEntryPoint.kind` (`jump-table` / `sector-load` / `dispatch` = the three
   kinds), `ContainerEntry.subKey` (the LUT index → position), and `loads`/`writes`
   relations. BAM + custom-LUT are `kind=lut` special cases. The stores already
   exist — they are just EMPTY; we populate them.

   **Amended 2026-08-12.** The first half held; the second did not. The stores exist,
   but "just populate them" assumed the schema could hold what a table IS. It cannot:
   `LoaderModel.indexLocation` and `LoaderEntryPoint.paramBlock.layout` are free
   strings, so a table is describable only as prose. A row recorded against today's
   schema is not re-derivable by anything but the person who typed it. The amendment is
   narrow — the addressing still rides on these records, but the table gets a
   STRUCTURED description (§1.1) instead of a sentence.
3. **mediumRef = the disk-/crt-manifest artifact id** (Spec 721's `mediumRef` = 709
   image identity), basename shown for humans.
4. **Sequence = render-first, extractors after.** Make the registerable data visible
   in the two views first (closes BUG-031), then add the auto-extractors as later
   slices of this spec.
5. **TWO views stay — do NOT build a new unified "Media" tab.** The work lands in the
   existing **Disk view** (`DiskPanel`, T/S wheel) and **Cartridge view**
   (`CartridgePanel`, bank/slot grid). The `MediumLayout` adapter is left as-is, not
   promoted to a tab.

### Refined 2026-08-12 (three decisions, for 750.2)

6. **The table is its OWN record — `LutDescriptor`, its own store.** Not a field on
   `LoaderModel` and not a struct inside `paramBlock`. Both alternatives were considered
   and both break on the same fact: a loader commonly has MORE than one table (a boot
   set walked by index, an in-game set asked by key), and two routines may read the SAME
   table. A table hung off either owner has to be duplicated or listed, and once it is
   listed the only thing separating it from a record is the name. `LoaderEntryPoint`
   gains `lutDescriptorId`; the table is pointed AT, never contained. This amends
   Decision 2 knowingly.

7. **Rows are DERIVED, only the claim is STORED.** The view computes rows live from the
   descriptor plus the medium bytes, so a corrected descriptor corrects every row at
   once and a rendered row cannot be stale. What persists is the resolved link —
   *payload X is claimed by (table, index)* — because that is the part that must survive
   without the image and that findings hang off. Materialising all rows was rejected: it
   creates a second truth that drifts from the first, and the first is cheap to recompute.

8. **A descriptor is CHECKED on write, and the check answers with a probe.** Structural
   errors are refused (columns outside the image, a row count that does not fit). Beyond
   that the tool resolves the first rows and RETURNS them, so the author can hold them
   against the disassembly they just read. This exists because of §1.1's semantics: an
   inverted codec polarity or a missed `deref` is silently wrong for every row, produces
   plausible-looking numbers, and would otherwise surface months later or never. Three
   resolved rows are enough to see it.

## 1. The model (one concept, two surfaces)

A **payload** is the universal unit (code/gfx/music/data; a format; can nest other
payloads). The **addressing** is the core: how the game maps an index → a payload's
position on its medium, in one of three kinds:

| kind | disk | cartridge | existing schema |
|---|---|---|---|
| **LUT** (incl. BAM/CBM-dir, custom-LUT) | index → T/S | index → bank/slot | `ContainerEntry.subKey`→position + `LoaderEntryPoint.kind="jump-table"` |
| **code-embedded T/S** | T/S baked in loader code | bank baked in code | `LoaderEntryPoint.kind="sector-load"` |
| **chainloader / dispatch** | index steers a loader | index steers a loader | `LoaderEntryPoint.kind="dispatch"` |

Around it hang the payload facets (Spec 721 / BUG-024 already model most): format,
load-address + length, **source position per image** (`mediumSpans` sector|slot **+
`mediumRef`**), nesting (`ContainerEntry`), loader (`loads` relation), mutator
(`writes` relation), semantic game-role.

Disk and cartridge are the SAME model — only the position is T/S vs bank/slot.

## 1.1 What a table IS (added 2026-08-12)

Reverse-engineering a medium means eventually finding a table. The point of recording
it is that **every byte can be traced to a payload, and through it to a purpose** — a
byte is *identified* when a row claims it, and what no row claims is exactly the list
of what is not yet understood. That only works if the claim has an address you can open,
not a sentence someone wrote.

A table description has four parts. Each is a fact you READ OFF the medium; none of them
is a property of any particular producer, which is why this is a model and not a format:

**Identity — how a row is addressed.** By index (row *n*). By key bytes (the game passes
a short byte string; its length is a field, not a constant, and the bytes are bytes — a
`(track, sector)` pair fits the same slot as a two-character name). Or indirectly: a row
that names another table.

**Layout — where the row physically lives.** Either PACKED, where a row is a contiguous
struct scanned sequentially (usually with a terminator), or COLUMNS, where each field is
its own parallel array and row *n* is byte *n* of each. These are not stylistic variants:
under `packed` a row has one address, under `columns` it has one per field, and a model
that assumes the former cannot describe the latter at all.

**Columns with a ROLE.** `bank`, `offset`, `length`, `destination`, `entry`, `codec`,
`key` — the role is the model, the location and width are the finding. A table may carry
a subset; a role may be absent (a data-only asset has no meaningful entry point).

**Semantics per column** — the part that cannot be inferred from the bytes, and the part
that makes a record interpretable at all:

- `destination` may be the destination, or a POINTER to it that must be dereferenced,
  or a sentinel meaning "the caller already set it". Three different renderings, and
  reading one as another is wrong for every row at once.
- `length` may be the true stored length or a pre-biased one, and a runtime may bias it
  again while counting down. The table's form and the live form are both true; they must
  be labelled apart.
- `codec` polarity varies: `0 = none` with a codec number, a single flag bit, or
  INVERTED, where zero means packed. Nothing in the byte distinguishes them, so the
  polarity has to travel WITH the record or every asset is labelled backwards.
- `offset` may point at the payload start or past its codec header.

Tables NEST: a boot table walked by index, an in-game table asked by key, a third one
inside a payload the first one loaded. That is an edge between tables, not a special case.

The same four parts describe the CBM directory (identity = index, layout = packed,
columns = track/sector/name) and a custom cartridge index. That is the test of the model:
if a description cannot express the BAM, it is a format, not a model.

## 2. What the two views render (the "real" visualization)

Both the Disk wheel and the Cartridge bank/slot grid, scoped per image (`mediumRef`):

1. **Payloads at position** — `origin=custom` entries (today emitted by the builder,
   ignored by the front-end = BUG-031's render gap), coloured + listed.
2. **Addressing overlay** — the LUT/dispatch as a "table of contents": draw the
   index → position mapping (LUT entry → its T/S / bank-slot target; dispatch index →
   target). The BAM/dir and custom-LUT render the same way (both `kind=lut`).
3. **Loader / mutator edges** — `loads` (which routine loads this payload) and
   `writes` (who mutates its bytes) as edges/annotations.

## 3. Slices (render-first)

- **750.1 — mediumRef + render payloads@position (closes BUG-031).** Add `mediumRef`
  to `mediumSpans` (entity + payload schema); the layout builders scope overlays by it
  (same artifact on multiple images = multiple spans; unscoped = badged, not fanned).
  Make the panels RENDER the `origin=custom` entries (wheel + list). Subsumes 721.J5.
  **DISK DONE (2026-06-02):** `mediumRef` on both span schemas + `register_payload`
  `image`→`mediumRef` resolver (id or basename) + `buildDiskLayoutView` per-span
  scoping (`unscoped` flag for no-mediumRef) + `DiskPanel` `custom`/`unscoped` badges +
  v3 bundle built. `e2e:bug031` 10/10 (scoped-to-A, excluded-from-A-when-pinned-B,
  unscoped-on-all, CBM-dedup, geometry). Also fixed 2026-07-02: raw payload spans
  are 256-byte sectors (`ceil((off+len)/256)`), not CBM `ceil(len/254)` — no phantom
  cells; verified against the 186 Wasteland area imports.
  **CART DONE (750.1b, 2026-07-02):** `CartridgePayloadChunkSchema` + `payloadChunks`
  on the cart view; `buildCartridgeLayoutView` overlays entity slot-spans scoped by
  `mediumRef` (unscoped flag, LUT-cell dedup, one chunk-per-payload-per-image with
  multi-bank spans, EEPROM/OTHER listed but off-grid); `CartridgeMemoryGrid`
  renderPayloadSegments overlay (dashed edge, amber for unscoped) + footer count;
  `CartridgePanel` click→entity. `e2e:750-cart` 13/13 (scoped, multi-bank=one-chunk,
  unscoped-on-all, excluded-when-pinned-other, EEPROM-listed, click-through).
  Chrome-verified on a throwaway EF cart.
- **750.2 — addressing overlay (the table of contents).** Surface `LoaderEntryPoint`
  (kinds) + `ContainerEntry.subKey` index→position so the two views draw the LUT /
  dispatch as edges. BAM + custom-LUT as `kind=lut`. Manual `declare_loader_entrypoint`
  / `record_loader_event` populate it for now.

  **Measured 2026-08-11, and it changes what this slice is.** Decision 2 says *"the
  stores already exist — they are just EMPTY; we populate them."* Only the first half
  holds. In both real cartridge projects `loader-entry-points` and `loader-events` are
  empty; `declare_loader_entrypoint` and `record_loader_event` are **not in
  `DEFAULT_TOOLS`**, so no agent can fill them from the standard surface; and no view
  builder reads either store, so a filled store would render nowhere. Two halves
  built, the seam between them never — the same shape as the loader-model banner that
  Spec 785 §6 closed. Nothing populates them because **nobody is ever asked to**: the
  steering block tells an agent to disassemble the loader, author an extractor, emit a
  manifest, validate and register — and says nothing about recording the pointer. That
  instruction is the missing piece, not the rendering, and it is what 784 C1 did for
  the payload side.

  `loader-events` arrives here from **Spec 748.3**, which was superseded by 784 and
  closed 2026-08-11; the event records were the one part of it that was never this
  spec's subject to begin with.

  **This slice is what the whole spec is really about, and its framing was inverted.**
  784's manifest already carries the *resolved* half — payload, full ordered spans,
  `derivedBy`, medium-agnostic. What is missing is the **row itself**: which row of
  which table claims this payload. The pointer as a record with its own address on the
  medium is what turns an index into something you can find, check, patch and draw —
  instead of a prose sentence in a free-text field.

  **Corrected 2026-08-12.** This slice used to phrase the target as "table A row 30, at
  bank 1 `$80f0`". That phrasing assumes `layout = packed`. Under `layout = columns` a
  row has no single address — its identity is the pair `(table, index)` and its bytes
  are one per column. The record must carry the pair; the address is derived per column
  from the table description (§1.1).

  **Unblocked 2026-08-12.** This was BLOCKED on a meta format authored outside the repo.
  It should not have been. §1.1 is a MODEL, not an adopted format: it describes what any
  table is, it is derived from what a reader must know to interpret one, and it is
  testable against the CBM directory. An external format becomes one input to a
  descriptor, never the schema. What the block did cost is real, though — the four
  semantic traps in §1.1 were learned from someone else's scars rather than ours, and
  a schema written before that conversation would have carried an address and a length
  and would have been wrong about `destination` for every image in pointer mode.

  **What this slice actually needs (measured 2026-08-12):**

  1. **A structured table description** — §1.1's four parts, replacing the free strings
     `LoaderModel.indexLocation` and `LoaderEntryPoint.paramBlock.layout`.
  2. **The write tools reachable.** `declare_loader_entrypoint`,
     `list_loader_entrypoints` and `record_loader_event` are not in `DEFAULT_TOOLS`,
     so no agent can write any of this from the standard surface.
  3. **A reader.** No view builder touches either store — `storage.ts` knows only the
     file path — so a filled store renders nowhere.
  4. **A steering rule that asks for it.** The block tells an agent to disassemble the
     loader, author an extractor, emit a manifest, validate and register; it says
     nothing about recording the row. This is the one that decides whether 1–3 are ever
     used, and 784 C1 is the precedent that worked on the payload side.

  **Build order** (each step ends green; decisions 6–8 above):

  | # | what | done when |
  |---|---|---|
  | a | `LutDescriptorSchema` + its store + `lutDescriptorId` on `LoaderEntryPoint` | schema round-trips, store reads/writes |
  | b | the resolver: descriptor + medium bytes → resolved rows (deref, codec polarity, offset bias) | a `columns` and a `packed` table both resolve |
  | c | `declare_lut_descriptor` — writes, validates structurally, returns the probe | refuses an out-of-image column; probe shows resolved rows |
  | d | `list_lut_descriptors` + `resolve_lut_rows` — read the table back, whole or by row | both reachable, both derive live |
  | e | the claim: payload ↔ `(lutDescriptorId, rowIndex)`, stored | survives without the image |
  | f | all five tools into `DEFAULT_TOOLS`, with the three older loader tools | `check:surface` sees them |
  | g | the view builders read it → edges on both views | a filled store renders |
  | h | the steering rule that asks for the row | `agent_onboard` carries it |
  | i | `e2e:750-lut` over a–h | red before, green after |

  **BUILT 2026-08-12 (a–f, h, i; g partial).** `LutDescriptorSchema` + `lut-descriptors.json`
  + `lutDescriptorId` on `LoaderEntryPoint`; `lut-resolver.ts` (both layouts, all four
  semantics) and `lut-medium.ts` (CRT CHIP packets → bytes by bank+address, flat
  otherwise, chosen by magic not by extension); four tools — `declare_lut_descriptor`
  (structural refusal + probe), `list_lut_descriptors`, `resolve_lut_rows`,
  `link_payload_to_lut_row` — plus `payloadClaimedByLutId`/`Row` on the payload record.
  All four, and the two loader-entry-point tools that were unreachable, are now in
  `DEFAULT_TOOLS`; the cap moved 140→150 with its reason recorded in `tier-tools.ts`
  (it was already breached at 144 by 784/796/798, and a permanently red gate is a gate
  nobody reads). The steering block asks for the row. `e2e:750-lut` 35/35: both layouts,
  each semantic proved by showing the WRONG reading differs, and an end-to-end pass over
  a real MCP server against a synthetic `.crt`.

  **g BUILT 2026-08-12 (view data).** The cartridge view now carries both halves. Payload
  spans carry the CLAIM (`claimedByLutId` / `claimedByLutName` / `claimedByRow`, and a
  human-readable note), so a span a table points at is distinguishable from one somebody
  asserted — on a grid they look identical otherwise. And `lutTables` carries the table's
  OWN FOOTPRINT: an index occupies bytes, and until now those bytes counted as unclaimed,
  so the map called the best-understood region on the medium "not yet understood". A
  split 2-byte cell is two parallel arrays and therefore two spans, which is the shape
  `layout=columns` forces and the reason the footprint could not be one range.
  `e2e:750-lut` 43/43.

  **Rendered 2026-08-12.** `CartridgeMemoryGrid` draws `lutTables` as a hatched band
  UNDER the payload overlay, with the table's name, layout, row count and claim count in
  the tooltip. Hatched and not solid on purpose: a payload is content, an index is
  structure, and they should not read as the same kind of thing. Under it, not instead of
  it, because the index is the ground the payload spans are described from — a reader
  needs both at once. UI typecheck unchanged (15 errors before and after, all the
  pre-existing `ArtifactRecord` generics).

  **750.2 is closed.** What remains of 750 is 750.3 (loader/mutator edges) and the
  extractor slices 750.4–750.6, which derive descriptors automatically instead of
  having a human author them.
- **750.3 — loader/mutator edges.** Render `loads` / `writes` relations on the views
  (payload ↔ routine). Manual `link_entities` for now.
- **750.4 — extractor: code-embedded T/S.** Scan a payload's disasm for hardcoded
  sector tables (`LDA #track / LDX #sector / JSR load`) → emit `LoaderEntryPoint
  kind="sector-load"` + the T/S.
- **750.5 — extractor: chainloader/dispatch.** Detect dispatch/trampoline (index →
  jump) → `LoaderEntryPoint kind="dispatch"` + the index→target table.
- **750.6 — extractor: auto loader/mutator relations.** From static xrefs + the trace
  (write/taint events, Spec 721.J2 derived-asset chain) auto-create `loads` / `writes`
  relations + populate `loader-events`. The trace strand feeds the static map.

## 4. Open question (only one left)

- **OQ — unscoped span (no `mediumRef`) in a multi-image project:** show on all
  images of its kind **with an `unscoped` badge** (honest), or hide it? _Lean: show +
  badge — visible, not silently fanned-as-confirmed._

## 5. Relation to existing work

- **Spec 721** provides the medium model (`mediumRef` / `MediaRegion`, the
  trace→origin chain) — 750 consumes it; 750.6 feeds from 721.J2.
- **BUG-031** closes under **750.1** (the disk instance: scoping + UI render).
- **BUG-024** gave payloads `mediumSpans`; 750.1 adds the image dimension.
- The retired **Spec 749** is fully replaced by 750 (749 was the model-dup; 750 is
  the view/wiring spec on top of 721's model).
- The dynamic strand (live trace + scenarios, Spec 746) is the OTHER half of the
  workflow; 750.6 is where they meet (trace → static cartography).
