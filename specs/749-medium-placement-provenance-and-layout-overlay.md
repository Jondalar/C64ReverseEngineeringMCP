# Spec 749 — Medium Placement Provenance + Layout Overlay (disk + cartridge)

**Status:** DRAFT / CONCEPT (2026-06-02). Generalises BUG-031 (disk) to the shared
disk+cartridge model. Cross-link: BUG-031, BUG-024, Spec 748.3.

## 1. Problem

A reversed payload/artifact's bytes physically live at one or more locations on one
or more media: disk **sector(s)** (track/sector) or cartridge **slot(s)**
(bank/slot). The knowledge model records this as `mediumSpans` (a list of
`sector`|`slot` spans on the entity and the payload schemas).

Two structural gaps:

1. **A span records the POSITION but not WHICH medium image it is on.**
   `EntityMediumSpanSchema` / `MediumSpanSchema` `sector` = `{track, sector,
   offsetInSector, length}` and `slot` = `{bank, slot, offsetInBank, length}` — no
   image reference. So with N images in a project (e.g. Wasteland's 4 disk sides
   s1–s4, or several `.crt`), there is no way to know which image a span belongs to.

2. **The same content can legitimately live on MULTIPLE media/locations.** A shared
   engine block on disk sides s1 AND s3; the same routine mirrored across two cart
   banks; a boot file duplicated per side. "Find the one source image" is wrong;
   placement is inherently many-to-many.

Consequences observed (BUG-031 + its cartridge analogue):

- The layout-view builders cannot SCOPE a payload overlay to the right image. With
  >1 image present a span either fans out to ALL images (wrong — `block2_engine_0200`,
  side-1 content, appears on s2/s3/s4) or matching fails and nothing shows.
- The disk/cart **front-end tabs do not render** the overlaid custom entries the
  builder emits — `disk-layout.json` carries 64 entries/disk but the Disk tab draws
  only the CBM manifest + BAM wheel. (Builder emits; UI ignores.)

## 2. Concept — the medium-placement model

1. A `MediumSpan` (`sector` | `slot`) gains an explicit, optional **medium
   reference** = which disk-side / cart image this span is on.
2. `mediumSpans[]` stays a LIST → the same artifact on several images = several
   spans, each carrying its own medium + position. Multi-medium and multi-location
   are first-class, not special cases.
3. **Scoping rule** for a layout view of image X: overlay spans whose `medium`
   resolves to X. A span with NO `medium` is **unscoped** → shown but visibly badged
   `unscoped` (honest: "located, image not yet attributed"), never silently asserted
   on every image as if confirmed.
4. **Reference key** = the `disk-manifest` / `crt-manifest` **artifact id** (stable,
   unique). The image basename (`wasteland_s1[…]`) is a human alias resolved for
   display + accepted as input (resolved to the id).

## 3. Symmetry disk ↔ cartridge

The model is identical across mediums; only the position fields differ:

| | disk | cartridge |
|---|---|---|
| span kind | `sector{track,sector,offsetInSector,length}` | `slot{bank,slot,offsetInBank,length}` |
| medium artifact role | `disk-manifest` | `crt-manifest` |
| layout view | `buildDiskLayoutView` | `buildCartridgeLayoutView` |
| front-end | Disk tab | Cartridge tab |

The new `medium` field, the scoping rule, the overlay pass, and the front-end render
are shared — implement once per layer, parameterised by medium kind.

## 4. Slices

- **749.1 — schema.** Add `medium?: string` (a `disk-manifest`/`crt-manifest`
  artifact id) to both span kinds in `EntityMediumSpanSchema` + `MediumSpanSchema`.
  Backward compatible: absent ⇒ unscoped.
- **749.2 — register_payload.** `medium_spans` entries accept `image` (artifact id OR
  image basename, resolved to the id). Surfaced in the tool description.
- **749.3 — builder scoping.** `buildDiskLayoutView` + `buildCartridgeLayoutView`
  overlay spans scoped by `medium`; an unscoped span is overlaid on every image of
  its kind but flagged `unscoped` (OR hidden — see OQ2). Replaces the current
  fan-to-all in the BUG-031 disk pass. **Closes BUG-031's scoping half.**
- **749.4 — UI render.** The Disk tab AND the Cartridge tab render the
  `origin=custom` entries from `disks[]/cartridges[].files|chunks` (geometry segments
  from `sectorChain` + list rows + the `unscoped` badge). **Closes BUG-031's UI half.**
- **749.5 — (optional) auto-derive medium.** When a payload is carved from
  `extract_disk` / `extract_crt` / a load trace on a known image, set `medium`
  automatically so the user need not pass it. Bridges the manual provenance gap;
  feeds from Spec 748.3 (trace→cartography extractor).

## 5. Open Questions

- **OQ1 — medium key.** Store the artifact id (canonical) and accept/display the
  basename, or store the basename? _Lean: artifact id canonical, basename for I/O +
  display._
- **OQ2 — unscoped span in a multi-image project.** Show-on-all-with-`unscoped`-badge,
  hide, or show-on-none? _Lean: show + badge (visible, honest, not wrong)._
- **OQ3 — force scoping when >1 image exists?** Require `medium` on register_payload
  when the project has multiple disk/cart images, or allow unscoped with a warning?
  _Lean: allow unscoped + warn._
- **OQ4 — shared vs kind-specific field.** One `medium?` on both span kinds, or a
  kind-specific shape? _Lean: shared optional `medium?` on the union members._

## 6. Relation to existing work

- **BUG-031** is the disk instance of this concept. It closes when 749.3 (disk
  scoping) + 749.4 (disk UI render) land. The committed builder-overlay is the
  unscoped-fan precursor that 749.3 replaces with scoping.
- **BUG-024** gave payloads the `medium_spans`; 749 gives those spans an image so the
  views can place them correctly across multiple images.
- **Spec 748.3** (trace→cartography extractor) is the automation that emits
  medium-scoped spans from a finalized trace (drive T/S reads × C64 store targets) —
  i.e. it populates 749.1's `medium` field automatically.
