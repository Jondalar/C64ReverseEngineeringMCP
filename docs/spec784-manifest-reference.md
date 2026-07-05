# Spec 784 — loader-extraction manifest reference

The **manifest** is the contract between a per-project extractor (any language) and
C64RE's bulk registration. You author the extractor from the *annotated* loader
(Discovery: disassemble + semantically annotate the stub / drive-code / handshake
first), then the extractor emits this JSON. Two tools consume it:

- `register_payloads_from_manifest` — bulk-registers every payload with its full medium
  spans + LoaderModel provenance (one call, not N `register_payload` calls).
- `validate_extraction` — diffs the manifest against the loader-lens **read-set** (what
  the REAL loader physically read) to catch a wrong static interpretation
  (the Accolade/Wasteland bug class).

`extract_disk` auto-emits this shape for the stock-DOS layer as `manifest.spec784.json`
(LoaderModel `kernal-directory`). For the custom-loader stage you author it yourself.

## Shape

```jsonc
{
  "manifestVersion": 1,                 // REQUIRED, literal 1
  "extractor": "pawn-serial-extract",   // REQUIRED, your extractor's name (free string)
  "sourceImage": "the_pawn_s1.g64",     // optional, default image basename for spans that omit `image`

  // REQUIRED, >=1. The distinct loaders that produced the payloads. Every
  // payload.derivedBy MUST equal one loaderModels[].id.
  "loaderModels": [
    {
      "id": "kernal-directory",         // REQUIRED, referenced by payload.derivedBy
      "kind": "dos",                    // REQUIRED, open string (dos | custom-fastloader | sector-stream | cart-lut | cross-bank-packer | ...)
      "indexLocation": "track 18 (BAM + directory)", // optional, where the loader's INDEX lives
      "disasmArtifactId": "art-...",    // optional, the backing loader disassembly artifact
      "notes": "stock CBM-DOS"          // optional
    },
    {
      "id": "pawn-serial",
      "kind": "custom-fastloader",
      "indexLocation": "T18/S04 4-byte records",
      "notes": "$DD00 2-bit serial, custom GCR"
    }
  ],

  // REQUIRED, >=1. Each payload = one logical blob the loader produces.
  "payloads": [
    {
      "name": "BOOT",                   // REQUIRED, unique per manifest
      "derivedBy": "kernal-directory",  // REQUIRED, MUST match a loaderModels[].id
      "loadAddress": 2049,              // optional (number), C64 dest load address ($0801)
      "format": "prg",                  // optional: raw | prg | exomizer-raw | exomizer-sfx | byteboozer | byteboozer-lykia | rle | bwc-bitstream | bwc-raw | pucrunch | unknown
      "packer": null,                   // optional, packer name if `format` is a raw variant
      "length": 512,                    // optional (number), payload byte length
      "contentHash": "ab12...",         // optional, sha256/md5 of the blob (dedup key)
      "addressStart": 2049,             // optional, resident address range start
      "addressEnd": 2560,               // optional, resident address range end
      "bytesPath": "analysis/disk/pawn/01_boot.prg", // optional, extracted blob path RELATIVE TO PROJECT ROOT

      // REQUIRED, >=1. The FULL ordered block chain — NEVER start-only (the Pawn
      // 168/1329 bug this contract exists to prevent). One entry per block read.
      "spans": [
        { "kind": "sector", "track": 18, "sector": 4, "length": 254 },
        { "kind": "sector", "track": 18, "sector": 5, "length": 254, "offsetInSector": 0 },
        { "kind": "sector", "track": 18, "sector": 6, "length": 4,   "image": "the_pawn_s1.g64" }
      ]
    },
    {
      "name": "GAME",
      "derivedBy": "pawn-serial",
      "loadAddress": 24576,
      "format": "byteboozer",
      "spans": [
        { "kind": "sector", "track": 33, "sector": 0, "length": 254 },
        { "kind": "sector", "track": 33, "sector": 6, "length": 254 },
        { "kind": "sector", "track": 34, "sector": 1, "length": 254 }
      ]
    }
  ]
}
```

## Span kinds

A span is a discriminated union on `kind`:

- **`sector`** (disk): `{ kind:"sector", track, sector, length, offsetInSector?, image? }`
  - `track` >= 1, `sector` >= 0, `length` = DATA bytes used in this block (254 for a full
    CBM sector, the remainder for the last). `offsetInSector` default 0. `image`
    overrides `sourceImage` for a cross-medium span.
- **`slot`** (cartridge, Spec 785): `{ kind:"slot", bank, slot, offsetInBank, length, image? }`
  - `slot` ∈ `ROML | ROMH | ULTIMAX_ROMH | EEPROM | OTHER`. Cart slot spans are
    validated by Spec 785 (bank lane), NOT by `validate_extraction`.

## Rules the validator enforces

1. `manifestVersion` is literally `1`.
2. `extractor` non-empty; `loaderModels` and `payloads` each have >= 1 entry.
3. Every `payload.derivedBy` resolves to a `loaderModels[].id`.
4. No duplicate `loaderModels[].id`.
5. Every payload has >= 1 span (the full chain — start-only is the bug this prevents).

## Workflow

```
disassemble + annotate the loader (Discovery)
  → author extractor → emit this manifest
  → runtime_trace_start domains=['memory','drive8-cpu','drive-mechanism'] → drive boot → runtime_trace_finalize
  → validate_extraction (manifest vs read-set: catches wrong interpretation)
  → register_payloads_from_manifest (bulk-register the validated payloads)
```
