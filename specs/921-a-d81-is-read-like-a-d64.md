# Spec 921 — A D81 is read like a D64: inspect, extract, register, and every sector accounted for

**Status:** BUILT on `spec/921-d81-static` (2026-11-12); S1-S7 green in `scripts/smoke-921-d81.mjs`, S8 (the 4 Metal Dust disks) is the owner's acceptance, by hand.
**Repo:** C64RE only (static media reading). TRX64: no change — its 1581 (Spec 872) already mounts D81.
**Number:** 921 (registry: `specs/README.md`).
**Origin:** the MetalDustUltimate session (a SuperCPU → C64 Ultimate port, 4 × D81), 2026-11-12;
the owner: "Jo, spec schreiben. Was vom d/g64 können wir evtl. wiederverwenden und dann bauen".
**Depends on:** nothing new. Reuses the D64 path (`src/disk/base.ts`) and Spec 832's chain verdicts.

---

## §1 The problem

A project whose source media are 1581 disks cannot start. Its four images are D81s
(819 200 bytes, no error bytes). Measured on master (0.11.0):

- `inspect_disk` / `extract_disk` / `extract_disk_custom_lut` all end in
  `Unsupported disk image`: `createDiskParser` (`src/disk/index.ts`) knows G64 and D64 only.
- `project_inventory_sync` skips them: "no inventory pattern covers this file type".
  `DEFAULT_PATTERNS` (`src/server-tools/registration.ts`) cover `input/disk/*.d64|*.g64`; there is
  no `d81` kind; `project_init` routes `.d64/.g64` to `input/disk/` but not `.d81`.
- `disk_sector_allocation` walks the 1541 table (`SECTORS_PER_TRACK`, 35 tracks, BAM at 18/0).
  On a D81 it would describe a disk that does not exist.

Read from the 4 images (header 40/0 only): DOS `3D`, names "METAL DUST DISK1..4", 12 / 2 / 2 / 4
directory entries, all PRG, no partitions. 800 KB per side with two files means most of the disk
is read by the game's own loader — so what the directory does NOT explain is the interesting part.

Parts:
- **P1 Read.** A D81 opens: header, directory chain, file chains, file bytes.
- **P2 Partitions.** 1581 `CBM` entries (type 5): a partition is a contiguous block range; one that
  holds a header is a subdirectory with its own directory.
- **P3 Manifest + tools.** `format: "d81"` through inspect / extract / custom-LUT / the UI's disk
  reads; extract runs the same analyze/disasm/verify as for a D64.
- **P4 Register.** `.d81` is a kind: inventory sync and `project_init` handle it like a D64.
- **P5 Account.** Every one of the 3 200 sectors is system, file, partition, empty — or
  **unexplained data**. Never "free" for a sector that holds bytes.
- **P6 No 1541 assumptions left** in the readers a D81 now reaches (geometry, system sectors,
  substrate wording).

## §2 Scenarios

```gherkin
Scenario: a D81 lists and extracts like a D64
  Given the synthetic D81 from scripts/lib/d81-fixture.mjs (one PRG on 1/0)
  When  inspect_disk and extract_disk run on it
  Then  the listing names the disk, its id, "3D" and the PRG with its load address
  And   the manifest says format "d81", the file's chain is 1/0 → complete, the bytes match

Scenario: an unexplained sector is reported, not freed
  Given a D81 with one PRG and bytes written to 60/7 that no chain reaches
  When  disk_sector_allocation runs
  Then  60/7 is orphan_data and 40/0..40/2 are system, 40/3 directory
  And   the total is 3 200 sectors on 80 tracks of 40
```

| # | Solves | Scenario | Test | Where |
|---|---|---|---|---|
| S1 | P1 | fixture lists: name, id, DOS, one PRG, load address | `scripts/smoke-921-d81.mjs` | by hand / `npm run smoke:921` |
| S2 | P1 | multi-sector file, cyclic chain, unreadable link → same verdicts as a D64 | same | same |
| S3 | P2 | a CBM partition with a subdirectory: entry listed as `CBM`, its files listed under it, partition bytes extract as the contiguous range | same | same |
| S4 | P3 | `extract_disk` writes `format: "d81"`, files, auto analysis like a D64 | same (MCP) | same |
| S5 | P4 | `input/disk/x.d81` and `input/x.d81` register on sync (kind `d81`); `project_init` routes a loose `.d81` to `input/disk/` | same | same |
| S6 | P5 | orphan sector reported as `orphan_data`; zero-filled unclaimed as empty; system cells 40/0–40/2, dir chain | same | same |
| S7 | P6 | D64 and G64 smokes unchanged (no regression) | existing `smoke-d64-no-bam`, `smoke-bug015*`, `smoke-861*` | by hand |
| S8 | P1–P5 | the 4 Metal Dust disks: listing, file counts, chain verdicts, allocation with unexplained ranges | by hand, absolute paths, nothing copied (game data) | report to the requesting session |

## §3 Decision

**D1 — Geometry belongs to the image, not to a global table.** `DiskImage` gains
`sectorsPerTrack(track): number` and `systemSectors(): Array<{track, sector, owner}>`.
D64 and G64 answer from `SECTORS_PER_TRACK` / 18/0 + directory chain as today; D81 answers 40 and
40/0 header, 40/1–2 BAM, the directory chain. Readers that a D81 reaches switch from
`SECTORS_PER_TRACK[t]` to the parser: `disk-custom-lut.ts` (allocation, sector walk),
`view-builders.ts` disk views, `workspace-ui/server.ts` sector reads. Lost: a second table for the
1581 beside the 1541 one — every reader would still have to know which to pick.

**D2 — One directory reader, two layouts.** `parseDirectory` (base.ts) takes a
`DirectoryLayout {header:[t,s], firstDir, nameOffset, idOffset, dosOffset, validTrack, maxSector}`.
D64 layout = today's constants (18/0, 18/1, $90, $A2), so D64 output is byte-identical. D81 layout =
40/0, the header's link (normally 40/3), name $04, id $16, DOS $19. The directory-entry format is the
same on both (32 bytes, type/T/S/name/size), as are the cycle guard and the "no DOS" fail-soft.

**D3 — Chains are reused unchanged.** `extractFileFromChain`, `walkFileSectorChain`,
`loadAddressRejection` take a `getSector` and know nothing of geometry. The D81 is the third caller.

**D4 — `D81Parser`** (`src/disk/d81-parser.ts`): 80 × 40 × 256; offset `((t-1)*40+s)*256`.
Detected by size 819 200, or 822 400 with 3 200 error bytes (ignored, like D64 error bytes).
No BAM requirement for detection (A disk needs data, not a BAM): size decides; the header only
decides whether a DOS directory is read. Probe order: G64 magic, D81 size, D64 size — sizes do not
overlap.

**D5 — Partitions.** `getFileType` maps type 5 to `CBM`. A `CBM` entry is a contiguous range of
`size` sectors from its T/S, in track-then-sector order; `extractFile` returns those sectors whole
(256 bytes each), the manifest chain lists them, status `complete`. When the range starts at sector 0,
is a multiple of 40 sectors, at least 120, and its first sector carries `D` at $02, it is a
subdirectory: its directory is read with the D81 layout relative to that header and its files are
listed after it as `PART/NAME`. Nested partitions are read the same way, with a depth guard.

**D6 — Kind `d81`.** Added to the artifact kind enum, `KIND_BY_EXT`, `INPUT_ROLE_BY_EXT`
(`source-disk`), `DEFAULT_PATTERNS` (`input/disk/*.d81`), the `project_init` route and media set,
`MediaType` in the fs browser. Disk images that sit loose in `input/` itself (`input/*.d64|g64|d81`)
are registered in place by sync — that is where this project's four sit, and a D64 there had the
same gap. Lost: moving them into `input/disk/` — a file a user placed is not moved.

**D7 — Substrate.** A D81 is a sector image like a D64: no GCR, so it is never a custom-GCR
candidate. `recordDiskSubstrate` records it as a sector image (the same "static depack" posture as a
D64; runtime payload extraction stays locked) and the evidence text names MFM/D81, not 18/0.

**D8 — Accounting.** `disk_sector_allocation` asks the parser for track count, sectors per track
and system sectors. A sector no chain or system role claims is `orphan_data` when any byte is
non-zero, else `unclaimed_padding` (as today). The answer for a D81 says "unexplained data" for
orphan ranges and never calls them free.

## §4 Not in scope

- D71 / G71 (1571). Same pattern, no project needs it yet.
- Writing D81 images (a builder like `d64-builder.ts`).
- The 1581's own loaders or the Metal Dust loader: that is the project's RE, not C64RE's.

## §5 As built

- **D1** `DiskImage` (`src/disk/base.ts`) gained `sectorsPerTrack`, `allocationTracks`, `systemSectors`, `walkFile`. D64/G64 answer from `SECTORS_PER_TRACK` and track 18 (`d64SystemSectors`), `D81Parser` from 40 sectors and 40/0-40/2 + the directory chain. Readers moved to the parser: `disk-custom-lut.ts` (`isValidTs`, `readContiguousSectors`, `diskSectorAllocation`, `suggestDiskLutSector`), `view-builders.ts` (disk layout view: directory start, BAM cells, sectors per track, 1581 BAM from 40/1-40/2, `diskLayoutToMediums` takes the count from the cells), `workspace-ui/server.ts` (`/api/disk/file-bytes` through `parser.extractFile`, `/api/disk/sector-bytes`). Left on the 1541 table on purpose: the D64/G64 builders and GCR code (`d64-builder.ts`, `g64-builder.ts`, `g64-parser.ts`), the 1541 BAM branch of the disk layout view (only reached for a non-D81 parser), and `diskSectorAllocation`'s fallback when the image cannot be parsed.
- **D2** `parseDirectory(getSector, layout)` with `DirectoryLayout`; `D64_LAYOUT` is the old constants, so D64 output is unchanged. `DiskDirectory.dosType` carries "3D".
- **D3** chain functions unchanged; `D81Parser.walkFile`/`extractFile` call them.
- **D4** `src/disk/d81-parser.ts`, probed by size in `createDiskParser`/`isDiskImage`.
- **D5** `getFileType` maps 5 to `CBM`; `partitionSectors`/`walkPartition`/`extractPartition` in `base.ts`; `D81Parser.getDirectory` expands subdirectory partitions as `PART/NAME` (depth 4, revisited-header guard); `.cbm` extension in `disk-extractor.ts`.
- **D6** kind `d81` in `ArtifactKindSchema`, `INVENTORY_KIND_VALUES`, `KIND_BY_EXT`, `INPUT_ROLE_BY_EXT`, `DEFAULT_PATTERNS` (`input/disk/*.d81` and the loose `input/*.d64|g64|d81`), `sortLooseInputMedia` route, `MediaType`, the kind lists in the MCP tools, `registration-delta`.
- **D7** `recordDiskSubstrate`: a D81 is a sector image (standard, static depack), evidence names 40/0 and MFM.
- **D8** `diskSectorAllocation` takes tracks, sectors and system cells from the parser; the answer prints "unexplained data" ranges (`formatOrphanRanges`), the legend and the owner of an unclaimed sector no longer say free.
- Test: `scripts/smoke-921-d81.mjs` (`npm run smoke:921`), fixture builder `D81Image` in `scripts/lib/d81-fixture.mjs`.
