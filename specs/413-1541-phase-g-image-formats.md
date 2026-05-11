# Spec 413 — 1541 Phase G: Image formats

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 412
**Doctrine:** 1:1 VICE TDE port.

## Goal

Bring D64 / G64 / P64 image attach/detach in line with
`docs/vice-1541-arch.md §13 Phase G` (steps 27–30) and §9.

## Doc anchor

- §13 Phase G
- §9 disk image formats
- §14 invariants 9, 11

## Canonical content (verbatim §13 Phase G)

27. D64 attach: per track, encode each sector's header + data into
    GCR; store in `gcr->tracks[ht].data`.
28. G64 attach: load tracks raw.
29. D64 detach: per track, scan GCR for SYNC + headers, decode
    sectors back to D64 layout. Detect modifications via
    `GCR_dirty_track`.
30. P64: optional; use existing CAPS library or skip.

## VICE source cite

- Image attach/detach: `src/drive/driveimage.c:169` /
  `driveimage.c:230`.
- GCR conversion: `src/diskimage/fsimage-gcr.c`.
- P64: `src/diskimage/p64.c`.

## Audit — current TS state

Files:

- `src/disk-extractor.ts`
- `src/disk/*.ts` (D64, G64 parsers)
- `src/runtime/headless/drive/track-buffer.ts`
- Memory: G64 / D64 mount working (motm boots from G64).
- P64: not supported.

Status:

- D64 + G64 both attach successfully.
- D64 detach + writeback: probably absent (read-only).
- WPS pulse on attach: yes (memo).

Deviations to verify:

1. **D64 → GCR encoding** (§13 step 27):
   - Required: per-track GCR encoding from sector headers + data.
   - **TODO fresh session**: cite `fsimage-gcr.c` encoding; diff TS.

2. **G64 raw load** (§13 step 28):
   - Required: load track data verbatim, respect track_size.
   - Current TS: working for motm (= half-track 35+ supported).

3. **D64 detach scan-back** (§13 step 29):
   - Required: scan GCR for SYNC + decode sectors; mark dirty
     tracks via `GCR_dirty_track`.
   - Current TS: not implemented (read-only).
   - Stub for now; full write support is post-arch-port.

4. **P64** (§13 step 30):
   - Optional. Skip per "optional, but..."

## TS extras to DELETE

- Any custom disk image abstractions not in VICE (= TS likely has
  same-shape parsers, but verify no wrapper layers).

## NTSC stub

- Image formats are NTSC/PAL-independent.

## Producer changes

1. Verify D64 → GCR encoding cite-perfect.
2. Verify G64 load handles half-tracks (motm).
3. Stub D64 detach with "// not implemented: post-arch-port".

## Consumer changes

- None outside disk parsers + mount path.

## Acceptance

- Build clean.
- VICE drive testprogs 4/4 PASS.
- New smoke `scripts/smoke-413-d64-gcr.mjs`: known D64, encode to
  GCR, scan-back decode to D64 = byte-identical.
- New smoke `scripts/smoke-413-g64-half-track.mjs`: G64 with
  half-track at 35.5, mount, head step to 35.5, verify track data.
- MM (G64), Scramble (D64) unchanged.

## Open Questions

- **OQ-413-1**: D64 GCR encoding — VICE may pre-encode at attach
  or lazy-encode per-track-fetch? Cite `driveimage.c:169`.
- **OQ-413-2**: P64 — defer or implement? Doc says optional.
  Memo lists no P64 dependent games in scope.

## Files touched

- `src/disk/*.ts` (audit)
- `src/runtime/headless/drive/track-buffer.ts` (audit)
- 2 new smokes
- `specs/413-1541-phase-g-image-formats.md` (this)

## Next spec

Spec 414 — 1541 Phase H: Lifecycle and integration.
