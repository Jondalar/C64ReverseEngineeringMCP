# Generalization Defect Audit - Medium/Payload Spine

Date: 2026-07-03

## Finding

The intended model is correct and already partially present:

```text
Medium -> blocks -> payloads -> meaning
```

`docs/redesign/keystone-schema.md` states this as the binding contract. TRX64 also
documents the same responsibility split in
`/Users/alex/Development/C64/Tools/TRX64/docs/capability-cut-decisions.md`:
format decode and medium capability move to TRX64/static; C64RE owns payload,
provenance, knowledge, and build orchestration.

The current implementation is still only halfway there. It has `mediumSpans`,
payload entities, and a unified `MediumLayoutView`, but several entry points still
treat CBM directory manifests as the first-class product shape.

## Concrete Evidence

- `src/disk-extractor.ts` is directory-first: `extractDiskImage()` calls
  `parser.getDirectory()` and writes `manifest.json` with `files[]`.
- `src/project-knowledge/manifest-import.ts` promotes `disk-manifest` and
  `crt-manifest` shapes directly into entities. That is useful as one
  representation import, but it is not the substrate.
- `src/disk-custom-lut.ts` proves the case-coupling: custom LUT extraction appends
  `origin=custom` files into the same disk manifest shape instead of writing a
  neutral block-to-payload representation.
- `src/project-knowledge/view-builders.ts` contains the right mitigation in
  `buildDiskLayoutView()` and `buildMediumLayoutView()`: disk image artifacts drive
  disk count, directory data is optional, and payload `mediumSpans` overlay blocks.
  But this still projects from disk/cart legacy views rather than from a persisted
  Medium/Payload substrate.
- Before this audit slice, `MediumLayoutView` was only composed inside
  `buildWorkspaceUiSnapshot()` and was not persisted by `buildAllViews()`. The
  generalist view therefore was not a first-class build artifact.

## Required Invariant

Consumers above block derivation must never branch on "BAM", "custom GCR",
"LUT", "cart", or title. They consume:

- medium identity and blocks
- payloads with one or more spans on those blocks
- provenance describing which representation/loader derived the relation

Loader/protection is provenance on the payload derivation. It is not a separate
consumer shape.

## Slice Direction

1. View substrate: persist `medium-layout.json` and require it in `build_all_views`.
   Done in this slice.
2. Extraction substrate: add a neutral extraction result that writes Medium +
   blocks + payload spans. Existing directory/LUT/CRT extractors become
   Representation producers into that schema.
3. Storage substrate: promote Medium records from view-only JSON into first-class
   knowledge records. `disk-manifest` remains one import format, not the anchor.
4. Verification: one harness must cover standard BAM disk, custom-GCR disk with no
   usable directory, and cartridge. Passing a title-specific assertion is not
   sufficient.

## Corpus Gate

The minimum green must prove one code path across:

- MotM or equivalent readable BAM disk: directory-derived payloads render.
- The Pawn custom-GCR disks: disk images render block geometry without a CBM
  directory, payloads may be pending.
- Wasteland-style code-derived loads: registered scattered sector spans render as
  payloads, not as one-off manifest files.
- Accolade/EasyFlash cartridge: slot/bank payload spans render through the same
  medium layout.

Any fix that only improves one of these without preserving the same
Medium -> Payload path is a case patch.
