# Keystone Schema — the Medium → Payload spine (binding contract)

Decided earlier (pre-workflow-cockpit), never written down → the cockpit (Spec 773)
was grafted onto the OLD BAM-coupled disk-view instead of this. This file IS the
contract. **It must carry through Extraction → Storage → View → Build.** If a layer
diverges from it, that layer is wrong, not this.

## The layering (physics-agnostic)

```
Medium (magnetic disk / ROM / cart)
  → bits
  → bytes
  → BLOCKS            (sector / page / bank chunk — the addressable unit of the medium)
  → PAYLOADS          (a contiguous-or-scattered unit of meaning: a file, an area-asset,
                       an engine blob, a loader stage)
  → MEANING           (code = engine/loader, assets, level data, …)
```

## The one rule

**How BLOCKS → PAYLOADS is derived is a pluggable bottom layer (a `Representation` /
`LoaderModel`) and MUST be invisible to everything above it:**

| Access method | is just | the model above sees |
|---|---|---|
| 1541 DOS + BAM | one derivation of block→payload (T&S directory) | payloads + their block-spans |
| Custom-GCR loader (T&S addressing) | another derivation | payloads + their block-spans |
| Cartridge LUT | another derivation | payloads + their block-spans |

The View, the Store, the Build **never branch on BAM-vs-GCR-vs-LUT.** They consume
`Medium → blocks → payloads`. The loader/protection is metadata *on* the medium, an
`evidence`/`provenance` detail — never the thing a consumer keys on.

## Must carry through all four layers

1. **Extraction** — an extractor (built-in `extract_disk` OR an LLM-built custom-GCR
   extractor OR a cart reader) emits the SAME schema: a Medium, its blocks, and the
   payloads with their block-spans. The loader used is recorded as provenance, not as
   a different output shape. (A per-track/per-sector dump is the BLOCK layer, not a
   payload manifest.)
2. **Storage** — Medium + Payload are first-class records (via `MediumSpan` /
   `MediumResidentRegion`, already in `types.ts`). NOT a `disk-manifest` special case.
3. **View** — Disk/Cartridge view renders `Medium → block-occupancy → payloads`,
   medium-agnostic. Payloads present → show them; only blocks decoded (loader not yet
   reversed) → show block occupancy + "payloads pending". Never 0 just because there's
   no CBM directory.
4. **Build** — consumes the same payloads (engine/assets/loader) to author the new
   medium; the target loader (EF/LUT) is another `Representation`, symmetric to source.

## Slice order (each VERIFIED against Wasteland (BAM) AND The Pawn (custom-GCR))
- **S1 View** — rework `buildDiskLayoutView`: disk = disk-IMAGE artifact; blocks =
  sector occupancy; payloads = `mediumSpans`-mapped; directory = CBM-manifest *when
  present*. Wasteland → 4 disks + files; Pawn → 2 disks + block occupancy + payloads
  pending. (buildMediumLayoutView already has the span/payload overlay to reuse.)
- **S2 Extraction** — extractors emit the schema (Medium + blocks + payloads),
  loader-as-provenance.
- **S3 Storage** — Medium/Payload first-class; retire the disk-manifest special case.
- **S4 Build** — consumes the same payloads.

## Why this exists as a file
So it can't be grafted over again. Any change to extract/store/view/build cites this.
