# Bug: a bad pad byte turns a good data block into `gcr_error`

- **ID:** BUG-068
- **Date:** 2026-09-28
- **Reporter:** llm (the Last Ninja sessions, LN1 and Last Ninja Remix)
- **Area:** disk
- **Severity:** medium
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Surface: `read_g64_sector_candidate`, `extract_g64_sectors` and every door that reports a sector status
- Code: `src/disk/gcr.ts` `decodeGCRDataBlock`

## What happened

A data block is 65 GCR groups = 260 bytes: block id, 256 data bytes, checksum, two pad
bytes. `decodeGCRDataBlock` set `gcrValid` over all 65 groups, so one undecodable 5-bit
code in the pad bytes made the whole block `gcr_error`. On LN1 side 1
(`last_ninja_s1[system3_1987](pal)(!).g64`) 684 of 700 data blocks were flagged, every one
with a correct XOR checksum; side 2 had 70 more. The status text explained the flag away as
"the read overshoots the block, so the last group routinely lands in the tail gap".

## What the drive does

1541 DOS reads the block at $F4D1 (256 + $46 GCR bytes) and decodes it at $F8E0. The
group decoder $F7E6 returns four bytes in $52-$55; for the last group $F913 stores $52
(data[255]) and $F92B stores $53 (the checksum) — $54/$55, the pad bytes, are never read.
The decoder has no invalid-code check at all: its tables ($F8A0/$F8C0) map an invalid code
to $FF bits and the checksum at $F4FB decides.

## Fix

`gcrValid` now judges only the 258 bytes the drive uses (id, data, checksum). The pad
bytes are reported separately as `padGcrValid`; `read_g64_sector_candidate` prints
`pad=undecodable (not an error …)` when they fail. The status texts no longer call the
old false positives normal. LN1 side 1: 684 `gcr_error` + 16 `ok` → 700 `ok`.
Regression checks in `e2e:832-gcr` (bad pad → still valid; bad data or checksum code →
`gcr_error`).
