# Spec 290 — VIC-II raster cache (line memoization)

**Sprint:** 144  **Status:** PROPOSED 2026-05-09  **Depends:** 281, 289

## Goal

Cache rendered line output when registers + screen RAM unchanged
since last frame. ~10× perf gain on static screens. 1:1 VICE
`raster-cache-*.h` templates.

## VICE source

- `raster/raster-cache.c` + `raster-cache-*.h` template macros.
- Per-mode `get_*` functions that compute a cache key from
  visible registers + memory.
- `raster.cache[line]` array stores last-rendered byte sequence +
  invalidation flag.

## Plan

- 290a: Add `RasterCacheEntry` per line: { key, pixels, dirty }.
- 290b: Cache key = mode + xsmooth + ysmooth + screen_base_ptr +
  chargen_base_ptr + bg_color + border_color + sprite-active mask.
  When line's key unchanged from prior frame AND no lane changes,
  reuse cached pixels.
- 290c: Invalidation: any $D000-$D02E write OR screen RAM write
  in the line's char range marks the line dirty.

## OQs

- **OQ1:** Cache scope. (a) Per-line cache (= VICE), (b) per-segment
  cache (finer). Default (a) — matches VICE.
- **OQ2:** Memory budget for cache. PAL 312 lines × 504 px × 4
  bytes (RGBA) = ~630 KB per frame. (a) Full RGBA cache. (b) Cache
  pre-RGBA palette indices (= 312 × 504 × 1 = ~158 KB). Default
  (b) cheaper, identical output after palette LUT.
- **OQ3:** Test gate: (a) cache-hit perf measurement. (b) regression
  output identical with cache on/off. Default (b) — correctness
  matters more than measured perf.

## Acceptance

- [ ] Static-frame second-frame render reuses cache (= measurably
  faster, observable via perf timer)
- [ ] Cache invalidation on any tracked register write
- [ ] Output byte-identical to non-cached path (= 281 + 282 + 283 +
  284 smoke hashes unchanged)
