# Spec 750 — Disk + Cartridge Cartography Visualization (payloads · addressing · loaders)

**Status:** DRAFT (2026-06-02). Refined with the user (3 decisions, below). This is
the STATIC strand of the RE workflow — "meticulously extract + cartograph" — made
REAL in the UI. NOT a duplicate of the retired Spec 749: 749 re-derived Spec 721's
medium model; 750 USES that model + wires the existing addressing schemas into the
two existing views.

## 0. Decisions (refined with the user)

1. **Scope = the full picture.** The views show payloads-at-position **+ the
   addressing itself (the "table of contents")** as a first-class overlay **+
   loader/mutator edges** (who loads / who mutates a payload).
2. **Model = wire the EXISTING schemas, no new entity.** Addressing rides on
   `LoaderEntryPoint.kind` (`jump-table` / `sector-load` / `dispatch` = the three
   kinds), `ContainerEntry.subKey` (the LUT index → position), and `loads`/`writes`
   relations. BAM + custom-LUT are `kind=lut` special cases. The stores already
   exist — they are just EMPTY; we populate them.
3. **mediumRef = the disk-/crt-manifest artifact id** (Spec 721's `mediumRef` = 709
   image identity), basename shown for humans.
4. **Sequence = render-first, extractors after.** Make the registerable data visible
   in the two views first (closes BUG-031), then add the auto-extractors as later
   slices of this spec.
5. **TWO views stay — do NOT build a new unified "Media" tab.** The work lands in the
   existing **Disk view** (`DiskPanel`, T/S wheel) and **Cartridge view**
   (`CartridgePanel`, bank/slot grid). The `MediumLayout` adapter is left as-is, not
   promoted to a tab.

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
