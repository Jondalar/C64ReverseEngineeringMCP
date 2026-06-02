# Spec 721 — Visual-Origin Join (Frozen Inspect ↔ Extraction / Medium / Trace / Disassembly)

**Status:** DRAFT — refined 2026-05-25 (re-scoped from the general "runtime-informed annotation" draft onto the central join).
**Parent specs:** `specs/710-frozen-vic-inspect-checkpoint-evidence.md` (DONE — the visual side + `FrozenInspectEvidence`/`MemoryRef`), `specs/708-declarative-trace-definitions-tracedb-control.md` (retained DuckDB trace runs/marks), `specs/709-reproducible-media-ingress.md` (media identity), `specs/720-disasm-output-quality.md` (static labels), `specs/042-*` (`propose_annotations`). Revives `specs/_archive/249-*` (runtime tables) + `specs/_archive/235-*` (runtime↔disasm link) as the annotation OUTPUT of the join.
**Scope:** ONE join — a visible object selected in Frozen Inspect resolves to its ORIGIN: the extracted asset, its file/medium location, the trace chain that put it on screen, and the code that uses it. No large implementation in this spec — data model + two small PoCs first.

## 1. The central join (why this spec)

This is the killer-combo seam. Frozen Inspect (710) turns a paused pixel/region
into `FrozenInspectEvidence` (checkpoint-bound `VisualNode`s + `MemoryRef`s).
Extraction turns files/media into asset candidates. The trace store (708) records
how bytes got where. Disassembly (720) names the code. **721 joins them:**

> a visible object → its `MemoryRange` → the `Routine` that wrote/uses it →
> the `ArtifactRange` (file offset) it came from → the `MediaRegion` (disk
> sector / CRT bank) it physically lives in.

Today these are silos: 710 gives the picture+RAM refs, extraction gives asset
candidates, the trace store gives writer/copy/depack chains, 720 gives labels —
nothing resolves "this sprite on screen ⇒ that file at that offset, depacked by
that routine." 721 is exactly that resolution, with an HONEST classification of
how direct the link is.

**710 is not reopened. 711 (code-overlay intervention) sits AFTER this join** —
it needs the VisualElement→Routine→ArtifactRange chain 721 produces.

## 2. Two equal runtime sources (one model)

The join must work from EITHER runtime source, producing the SAME evidence model:

- **Agent-driven headless run** with a retained DuckDB trace (Spec 708
  `traceRun` + marks, `vic/inspect` resolve via the checkpoint).
- **Human-assisted UI run** with TRACE ON (the v3 workbench, same 708 trace
  capture + 710 freeze-inspect).

Both emit the identical substrate the join consumes:
`traceRun` (DuckDB) · `mark` · `checkpoint` (710 capture-on-freeze) · `media`
identity (709). The join NEVER assumes which source produced them — it consumes
the retained `traceRef` + `FrozenInspectEvidence` + `AssetCandidate`s. Neither
source is privileged; an agent batch and a human session are interchangeable
inputs.

## 3. Extraction side — `AssetCandidate`

A deterministic extraction pass (over PRG / D64 / G64 / CRT) emits asset
candidates the join can match against. No runtime needed to produce these.

```ts
interface AssetCandidate {
  id: string;
  artifactId: string;                 // owning extracted artifact (knowledge store)
  kind: "sprite" | "charset" | "screen" | "bitmap" | "tile" | "font" | "table" | "unknown";
  source: {
    fileRef?: string;                 // file/artifact the bytes live in
    mediumRef?: string;               // disk image / CRT identity (709)
    offset: number;                   // byte offset within file/medium region
    length: number;
  };
  format: string;                     // e.g. "sprite-24x21" / "sprite-mc" / "charset-2k" / "koala" / "bitmap-hires"
  preview?: { hash: string; pngRef?: string };  // content hash of the asset bytes (+ optional render)
  confidence: number;                 // 0..1 (heuristic strength)
}
```

The `preview.hash` (content hash of the asset's bytes in their NATIVE form) is
the exact-match key. `format` lets the join compare apples to apples (a sprite
candidate vs a sprite `MemoryRef`). This reuses the existing graphics-candidate
scanners (`scan_graphics_candidates`, sprite/charset/bitmap analyzers) — 721
formalizes their output into `AssetCandidate` records, it does not invent new
detectors.

## 4. Inspector join — resolve a `VisualNode` to its origin

Input: a `FrozenInspectEvidence` (710) — its `VisualNode`s carry `MemoryRef`s
(`screen_ram` / `color_ram` / `charset` / `bitmap` / `sprite_ptr` / `sprite_data`
with absolute addr + length) — plus the set of `AssetCandidate`s and a retained
`traceRef`.

**Step 1 — exact match (no trace needed).** Hash the RUNTIME-resident bytes at a
`MemoryRef` range (from the frozen checkpoint RAM) and compare to
`AssetCandidate.preview.hash` of the same `kind`/`format`. A hit ⇒ the on-screen
object IS that extracted asset, placed verbatim. → `exact_asset`.

**Step 2 — no exact match ⇒ resolve the chain via DuckDB.** The bytes were
transformed before display. Walk the trace store:
- **writer** — which PC/routine wrote this `MemoryRange` (write events to the addr range);
- **source** — where that routine READ from (taint / read events) → an `AssetCandidate` region;
- **copy** — a block move (memcpy-shaped read→write run);
- **depack** — a decompressor signature (Exomizer/ByteBoozer/BWC — the project's depack tooling) read-packed→write-unpacked.
A resolved chain (display bytes ⇐ writer ⇐ … ⇐ a packed/source `AssetCandidate`
on the medium) ⇒ `derived_asset`, carrying the chain as evidence.

**Step 3 — honest classification.** Every resolved `VisualNode` gets exactly one:
- `exact_asset` — RAM bytes == an extracted asset (hash) + (optionally) a load/copy trace placed them.
- `derived_asset` — no byte match, but a trace writer/source/copy/depack chain ties it to a source `AssetCandidate` on the medium.
- `runtime_generated` — bytes computed at runtime with no static asset origin (procedural table/sprite, cleared buffer, computed bitmap). Honestly "no file origin", not a forced guess.

No fabricated links: if neither a hash match nor a trace chain exists, the answer
is `runtime_generated` (or `unresolved` when even the writer is unknown), never a
nearest-guess asset.

## 5. Knowledge / disassembly result

The join writes into the EXISTING knowledge store (no new persistence model):

**Relation chain** (per resolved visual element):
```
VisualElement → MemoryRange → Routine → ArtifactRange → MediaRegion
```
- `VisualElement` = the promoted `FrozenInspectEvidence` node(s) (710 artifact).
- `MemoryRange` = the `MemoryRef` addr/length.
- `Routine` = the writer/owner routine (from the trace chain + 720 labels).
- `ArtifactRange` = file offset/length of the source `AssetCandidate`.
- `MediaRegion` = disk sector/track or CRT bank (709 identity).
Saved via `save_relation` / `link_entities` / `link_payload_to_*` — the join is a
set of relations + a classification, not a blob.

**One placement model, two representations.** The asset-side `AssetCandidate.source`
(`mediumRef` + offset/length) and the payload/entity-side `mediumSpans`
(`sector`/`slot`) are the SAME fact — where bytes live on a medium image. They must
share the `mediumRef` (the disk-side/CRT identity): `mediumSpans` carry `mediumRef`
so a span is scoped to its image, and the same artifact on multiple images is just
multiple spans (or multiple `MediaRegion`s on the chain). The disk/cartridge LAYOUT
views consume this scoped placement (721.J5).

**Annotation proposals** (with `EvidenceRef`s, `provenance:"runtime-join"`):
- a `RoutineAnnotation` for the writer/depack routine ("unpacks sprite set X from
  $… to $…"), and `LabelAnnotation`/`SegmentAnnotation` for the source and
  destination data ranges. These feed `propose_annotations` (Spec 042/720) and the
  per-routine LLM-synthesis bundle (the former §3/§4 of this spec — preserved as
  the annotation-GENERATION path, now fed by the join's resolved chain). Every
  proposal cites the trace evidence + the asset hash so a reviewer can verify it.
- byte-identical rebuild stays green (comments/labels only — inherited gate).

**UI navigation (LATER — not this spec):** screen marking → asset → file/offset →
code → trace, as a clickable chain in the v3 workbench. Designed here, built after
the data model + PoCs land (and overlaps 711).

## 6. Order + minimal proof slices

Strictly incremental. Data model + the simplest honest match FIRST; trace-backed
resolution second; UI/overlay last.

| ID | Slice | What it proves | Depends |
|---|---|---|---|
| **721.J1** | **Data model + exact sprite-match PoC.** Define `AssetCandidate` + the join-result types + the `exact_asset\|derived_asset\|runtime_generated` enum. Extract sprite `AssetCandidate`s from one PRG/disk; freeze-inspect a sprite (710); hash the RAM `sprite_data` range vs candidate hashes → emit an `exact_asset` relation. NO trace. | The hash-join + classification skeleton works on the simplest case. | 710, extraction scanners |
| **721.J2** | **Trace-backed derived-asset PoC.** A depacked/copied asset (no direct hash match). Use the DuckDB trace writer/source/copy/depack chain to resolve `derived_asset` back to a packed `AssetCandidate` on the medium; attach the chain as evidence. | The trace store resolves an origin when bytes were transformed; honest `derived_asset`. | 721.J1, 708 traceRef, depack tooling |
| **721.J3** | **Knowledge relations + annotation proposals.** Persist the `VisualElement→MemoryRange→Routine→ArtifactRange→MediaRegion` chain via `save_relation`; emit annotation proposals (routine + data labels) with `EvidenceRef`s. | The join lands as durable, reviewable knowledge that disasm consumes. | 721.J1/J2, 042/720 |
| **721.J4** | *(later)* **UI navigation + code overlay.** Clickable screen→asset→file/offset→code→trace; overlaps Spec 711. | End-to-end human navigation. | 721.J3, 711 |
| **721.J5** | **Medium-scoped placement on the LAYOUT views (disk + cartridge).** Carry `mediumRef` (§3/§5 — which disk-side/CRT image, 709 identity) on the payload/entity `mediumSpans` (sector\|slot), so the SAME representation answers "where + on which image". The `buildDiskLayoutView` / `buildCartridgeLayoutView` overlays then SCOPE payload spans by `mediumRef`: same artifact on multiple images = multiple spans; an unscoped span (no `mediumRef`) is shown but badged `unscoped`, never silently fanned to all. The Disk/Cartridge tabs RENDER the `origin=custom` entries (geometry segments + list). **This is the structured-placement / disk-geometry sibling of the visual join — same medium model, different surface.** Closes **BUG-031** (disk instance; the committed builder-overlay is the unscoped precursor) + its cartridge analogue. | The reversed disk/cart cartography colours the right image(s), not just the CBM/manifest. | 721.J1 (mediumRef model), 709 identity, BUG-024 mediumSpans |

Each PoC is a focused gate (a tiny script proving the one capability), not a big
suite. J1 is deterministic + needs no runtime trace; J2 needs a retained trace.

## 7. Acceptance

1. `AssetCandidate` model + join-result types + classification enum exist; an
   extraction pass emits sprite/charset/bitmap candidates with content hashes.
2. **Exact match (J1):** a freeze-inspected sprite whose RAM bytes equal an
   extracted candidate resolves to `exact_asset` with the candidate's
   file/offset; deterministic.
3. **Derived match (J2):** a depacked/copied on-screen asset resolves to
   `derived_asset` via a DuckDB writer/source/copy/depack chain back to a source
   candidate; the chain is attached as evidence.
4. **Honest no-origin:** a runtime-computed element resolves to `runtime_generated`
   (or `unresolved`), never a fabricated asset link.
5. **Source-agnostic:** the same join result is produced from an agent headless
   trace and a human UI TRACE-ON run (same `traceRef`/checkpoint/media model).
6. **Knowledge (J3):** the `VisualElement→…→MediaRegion` relation chain + cited
   annotation proposals are saved in the existing store; rebuild stays green.

## 8. Out of scope

- Large implementation in this spec — data model + J1/J2 PoCs only.
- Reopening Spec 710 (visual side is DONE).
- The UI navigation / code overlay (J4 / Spec 711) — designed, built after the join.
- New extraction detectors or new trace mechanics — reuse existing scanners (720)
  + trace store (708) + depack tooling.
- Whole-game / cross-artifact synthesis — one artifact at a time.
- NTSC / hardware variants.

## 9. References

- `specs/710-frozen-vic-inspect-checkpoint-evidence.md` — `FrozenInspectEvidence` / `MemoryRef` / `VisualNode` (the visual input).
- `specs/708-declarative-trace-definitions-tracedb-control.md` — retained `traceRun`/marks (writer/source/copy/depack chains).
- `specs/709-reproducible-media-ingress.md` — media identity (`MediaRegion`).
- `specs/720-disasm-output-quality.md` — static labels (`Routine`).
- `specs/042-*` — `propose_annotations` (consumes the join's proposals).
- `specs/_archive/249-*` (runtime tables) + `specs/_archive/235-*` (runtime↔disasm link) — the annotation-generation path, now fed by the join.
- Extraction: `scan_graphics_candidates`, sprite/charset/bitmap analyzers; depack tooling (exomizer/byteboozer/bwc).
- `specs/711-code-overlay-intervention-branches.md` — sits after this join (UI nav / overlay).
- `docs/re-phases.md` — Phase 2 (trace) → 5/6 (relations) → 7 (annotation synthesis) slotting.
