# D64 TrueDrive Path (Spec 112 / M3.4)

## v1 approach: pre-encode D64 → in-memory G64

When `IntegratedSession` opens a `.d64` file it reads the raw bytes
and immediately encodes them to a full G64 byte stream via
`buildG64({ d64 })`. The session then constructs `G64Parser` over
the encoded buffer exactly as it would for a native G64 file. From
that point on, the drive ROM, IEC bus, GCR pipeline, head position,
and track buffer are completely format-agnostic — they only see G64.

This satisfies the spec's M3.4a (factor + reuse the GCR encoder) and
follows the documented fallback path: "Pre-encode whole D64 → in-memory
G64 on first access. ~330 KB per disk, acceptable." Per-sector lazy
encoding was rejected because it adds cache complexity for negligible
memory savings inside the headless budget.

## Encoder reuse

The encoder primitives already lived in `src/disk/gcr-encode.ts`
(per-nybble, per-group, per-sector helpers — buildSectorHeaderRaw +
buildSectorDataRaw + encodeSectorGCR) and `src/disk/g64-builder.ts`
(full disk wrap with VICE-conformant header + offset/speed tables).
M3.4a confirms the same encoder powers both:

- the `extract_disk` MCP tool's synthesis path, and
- the runtime's D64 → G64 transparent encoding,

so any future change to GCR encoding cannot drift between extract and
runtime.

## Validation

`regress.matrix.json` entry **L1**: `samples/synthetic/1byte.d64`
LOAD"X",8,1 in `mode: "true-drive"`. Asserts EOI bit in $90,
loadStart=$0801, payloadSize=1, firstByte=$42.

Result: `npm run regress` 5/5 PASS (L2/L3/L7/L8 G64 + L1 D64).

## Mode separation (M3.4d)

`mode: "true-drive"` runs the real KERNAL serial bit-bang via the
real drive ROM walking BAM and directory; D64 sources go through the
G64 encode wrapper exactly like any other G64. `mode: "fast-trap"`
keeps the existing trap-path KERNAL serial helpers active for analysis
workflows. The L1 fixture is locked to `true-drive`, so any silent
fallback to traps surfaces as a regress fail.

## v1 deviations + open follow-ups

- **Per-sector lazy encoding**: not implemented. If a future asset
  type stresses memory budget, factor `encodeSectorGCR` into a
  TrackBuffer hook and lazy-encode on first head-position seek.
- **D64 error info bytes**: ignored (rarely used in real software;
  out of scope per spec).
- **Standard-disk D64 fixture (L4)**: synthetic 1-byte covers the
  smoke; richer fixtures (multi-block files, directory walk, BAM
  reads against a real game disk) tracked under M3.4b follow-up.
- **Directory walk byte-for-byte (M3.4b)**: not yet asserted as a
  separate fixture. Implicit in L1 because BASIC's LOAD parses the
  directory entry to find the file's start sector, but a dedicated
  `LOAD"$",8` listing test would tighten the contract.
- **D81 / GEOS / oversized variants**: explicitly out of scope.

## Files

- `src/runtime/headless/integrated-session.ts` — D64 → G64 encode at
  session construct.
- `src/disk/gcr-encode.ts` — sector + group GCR primitives.
- `src/disk/g64-builder.ts` — full-disk G64 wrap with VICE header.
- `regress.matrix.json` entry L1 — D64 LOAD acceptance.
