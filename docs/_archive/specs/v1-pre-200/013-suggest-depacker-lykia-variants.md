# Spec 013: Suggest Depacker — Lykia / Shared-Encoding Variants

## Problem

`suggest_depacker` recognises the common Exomizer/Byteboozer/RLE
forms but misses Lykia-disk packed files: streams with a `00 XX`
2-byte prefix and Exomizer shared-encoding sets that begin with a
canonical prefix such as `00 0C 40 3F ...`. Agents currently have to
guess the depacker for these files.

## Goal

`suggest_depacker` returns a ranked candidate list that includes the
Lykia / shared-encoding variants when their fingerprints are present.

## Heuristics

Add detectors for:

1. **Exomizer shared-encoding prefix**
   - Magic-byte sequence at offset 0 that matches one of the known
     shared-encoding tables (e.g. `00 0C 40 3F ...` for Lykia disk1).
   - Suggest `depack_exomizer_raw` with the appropriate shared
     encoding artifact.

2. **Lykia 2-byte prefix LZ77**
   - `00 XX` two-byte prefix where `XX` matches the observed
     length-byte distribution of Lykia disk streams.
   - Suggest `byteboozer_lykia` (existing decoder).

3. **Generic shared-encoding fallback**
   - If the project knowledge layer has registered a
     `shared-encoding` artifact and the candidate file's prefix
     matches the encoding table, surface the artifact id in the
     suggestion.

## Output

Each suggestion entry adds:

- `variant`: short identifier (`exomizer-shared`, `lykia-lz77`, ...)
- `evidence`: the matched prefix bytes
- `confidence`: 0..1
- `recommendedTool` and `recommendedToolArgs`

## Acceptance Criteria

- `suggest_depacker` on a Lykia disk1 packed file returns
  `lykia-lz77` (or `exomizer-shared` where applicable) as the top
  candidate with non-trivial confidence.
- Standard Exomizer/Byteboozer/RLE detection keeps its current
  ranking on non-Lykia files.
- Suggestion metadata is sufficient to invoke the recommended tool
  without further heuristics.

## Tests

- Fixture file from Lykia disk1 (or synthetic equivalent).
- Snapshot suggestion output for each variant.
- Regression: existing depacker suggestions on common samples remain
  unchanged.
