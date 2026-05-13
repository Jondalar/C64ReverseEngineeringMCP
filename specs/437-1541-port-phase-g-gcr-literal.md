# Spec 437 — Phase G: Literal port of `gcr.c` sector helpers

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase G  
**Depends on:** Specs 432–436 merged  
**Doctrine:** Literal VICE port. Bit-level. No byte-aligned scan, no
fixed-gap assumption, no custom header/data pairing heuristic.
**Anchors:**
- `docs/vice-1541-arch.md` §8 (Rotation — GCR / disk physics)
- `docs/vice-1541-arch.md` §8.2 (GCR encoding)
- `docs/vice-1541-arch.md` §8.4 (SYNC detection)
- `docs/vice-1541-arch.md` §8.5 (Wobble)

## VICE source of truth

- `/Users/alex/Development/C64/Tools/vice/vice/src/gcr.c` (357 LOC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/gcr.h`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/rotation.c`
  (consumer of `gcr.c`; cross-reference only — not rewritten here)

Functions to port literally:

- `gcr_find_sync(raw, p, s)`
- `gcr_decode_block(raw, p, buf, num)`
- `gcr_find_sector_header(raw, sector)`
- `gcr_read_sector(raw, data, sector)`
- `gcr_write_sector` — **out of scope** (write-back not required for
  the V1 silikon-equivalent goal); explicit no-op stub OK

## Behavioral contract (non-negotiable)

### `gcr_find_sync(raw, p, s)`

```text
scan bit-by-bit starting at arbitrary bit position p
wrap around track end (raw.length * 8)
return exact bit position after 10 consecutive 1-bits
```

No byte alignment. No `p & 7 == 0` shortcuts. No fixed-window
heuristic.

### `gcr_decode_block(raw, p, buf, num)`

```text
decode from arbitrary bit position p
handle p & 7 shift via bit-level reader
wrap around track end
emit `num` decoded bytes into buf
```

### `gcr_find_sector_header(raw, sector)`

```text
loop:
    p = gcr_find_sync(raw, p, sector_size_bits)
    header[6] = gcr_decode_block(raw, p, ..., 5)
    if header[0] == 0x08 && header[2] == sector:
        return p
    if wrapped one full revolution without match:
        return error
```

### `gcr_read_sector(raw, data, sector)`

```text
p = gcr_find_sector_header(raw, sector)
data_sync = gcr_find_sync(raw, p, 500 * 8)
        // must find data sync within 500 bytes (4000 bits) of header
gcr_decode_block(raw, data_sync, group, 65 GCR groups)
validate block id (0x07)
validate checksum (XOR of 256 data bytes)
emit 256 decoded data bytes into data[]
```

500*8 is the bit-distance ceiling, not a byte-distance.

## Headless files in scope

- `src/disk/gcr.ts` (475 LOC) — replace byte-aligned helpers with
  literal port
- `src/runtime/headless/drive/gcr-shifter.ts` (690 LOC) — audit;
  keep cycle-stepped rotation shifter (already 1:1 with VICE
  rotation.c per [[project_gcr_default_flipped]]); align its
  consumers to the new `gcr_*` API names
- `src/runtime/headless/drive/via2-gcr.ts` (123 LOC) — only touched
  if VIA2 SR coupling changes (it should not — read-side only here)

MCP tools touching GCR sectors (`read_g64_sector_candidate`,
`inspect_g64_blocks`, `analyze_g64_anomalies`, etc.) must route
through the new `gcr_read_sector` / `gcr_find_sector_header`.

## Wrapper purge (this phase's slice of Phase F)

- Quarantine `readTrackSectorLikeVice` — rename or delete. The name
  asserts VICE equivalence; either it now is the literal port or it
  must lose that claim.
- Delete any helper that assumes a fixed inter-sector gap.
- Delete any helper that scans for sync byte-aligned.
- Delete any helper that pairs header→data by index instead of by
  bit-distance scan.

## Tests required

Add `tests/gcr-bit-level.test.ts`:

1. Sync at bit position not divisible by 8 → decode succeeds.
2. Data sync at non-standard gap (varied between 50 and 400 bytes
   after header end) → decode succeeds; checksum valid.
3. Track wrap: sync straddling end-of-track → decode succeeds.
4. Bad checksum → `gcr_read_sector` returns the same error code
   shape VICE returns.
5. Missing data sync within 500 bytes → error.
6. Vectors from real G64 dumps of motm track 18, MM track 1, and
   The Pawn (the title that motivated the original
   byte-aligned-scan bug) → all sectors decode.

## Acceptance

1. `src/disk/gcr.ts` rewritten. File header lists every VICE
   function ported with line range.
2. `gcr_find_sync`, `gcr_decode_block`, `gcr_find_sector_header`,
   `gcr_read_sector` exported with literal names.
3. All MCP tools that read sectors call `gcr_read_sector` (or
   `gcr_find_sector_header` for inspection). Grep returns zero
   production callers of any deleted byte-aligned helper.
4. `readTrackSectorLikeVice` either is removed or has been renamed
   to drop the `LikeVice` suffix and reduced to a thin caller of
   `gcr_read_sector`.
5. `tests/gcr-bit-level.test.ts` passes (all 6 cases).
6. All 4 green canaries from Spec 431 remain green.
7. **LNR-S1 retest**: run `npm run canary:spec-430` after this
   phase. If still red, the next bug spec investigates against the
   literal port; do NOT re-open Spec 430 patching. If green, mark
   Spec 429 RESOLVED-BY-430.

## Do Not

- Do not modify rotation.c-equivalent code (`gcr-shifter.ts`) beyond
  consumer-API renames.
- Do not add write-back support.
- Do not patch The Pawn or LNR specifically.
- Do not keep `LikeVice`-suffixed helpers on production paths.
- Do not introduce a new caching layer for decoded sectors.

## Agent Instruction

```text
Implement Spec 437. Port VICE gcr.c literally into src/disk/gcr.ts:
gcr_find_sync, gcr_decode_block, gcr_find_sector_header,
gcr_read_sector. All bit-level. No byte alignment, no fixed-gap
assumptions, no LikeVice-named helpers on production paths. Route
every MCP tool that reads sectors through the new API. Add the
tests/gcr-bit-level.test.ts cases enumerated in the spec. Run
canaries; retest LNR-S1. If still red, file the next bug spec
against the literal port, not the old wrapper.
```
