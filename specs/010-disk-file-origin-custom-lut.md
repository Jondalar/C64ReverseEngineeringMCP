# Spec 010: Disk File Origin And Custom LUT Extraction

## Problem

Some C64 disks treat the standard 1541 directory as decorative and place
their real payload in non-directoried sectors indexed by a custom
look-up table (LUT) the drive code reads from a fixed track/sector. The
Lykia disk (2026-04-20) is the canonical case: only one PRG is visible
through the DOS dir, while 40+ logical files live in sectors indexed
from `T18S18`. Today this is patched in via throw-away Python
(`Lykia/tools/disk_manifest_merge.py`).

The MCP must own this layer so that custom-LUT files become
first-class disk-file entries with the same descriptor shape as
KERNAL-side files.

## Schema Change

Extend the disk-file descriptor used in `manifest.json`:

```ts
interface DiskFileEntry {
  index: number;
  origin: "kernal" | "custom";   // NEW
  name: string;
  type: "PRG" | "SEQ" | "BIN" | ...;
  track: number;
  sector: number;
  sizeSectors: number;
  sizeBytes: number;
  loadAddress?: number;
  sectorChain: DiskFileSectorLink[];
  relativePath: string;
  md5?: string;                   // NEW
  first16?: string;               // NEW (hex)
  last16?: string;                // NEW (hex)
  kindGuess?: string;             // NEW (heuristic)
  origin_detail?: {               // NEW
    // origin="kernal": directory T/S of the entry
    // origin="custom": LUT T/S, entry index, raw payload bytes
  };
}
```

`extract_disk` fills these fields for KERNAL-side files; the new tools
fill them for custom-side files. Missing `origin` defaults to
`"kernal"` for backwards compatibility.

## New MCP Tools

### `extract_disk_custom_lut`

Parameters:

- `image_path`
- `lut_track`, `lut_sector`
- `entry_offset` (default 0), `entry_stride` (default 6),
  `entry_count` (default 42)
- `payload_format`: `ts_size_load` | `ts_load_size` | `chained` | `raw`
- `sentinel_payload` (optional hex) — empty/deleted slot marker
- `output_dir`

Behavior: parses the LUT, extracts each indexed file, emits
descriptors with `origin: "custom"`, and merges them into the
project's `manifest.json` next to existing KERNAL files.

### `disk_sector_allocation`

Parameters:

- `image_path`

Behavior: walks the combined `files` array in `manifest.json` and
returns a map `{ "T/S": { owner, role } }`. Roles include
`system` (BAM/dir/LUT), `kernal_file`, `custom_file`,
`unclaimed_padding`, `orphan_data`. Reports overlaps explicitly.

### `suggest_disk_lut_sector`

Parameters:

- `image_path`

Behavior: scans every sector for plausible fixed-stride entry tables
(valid T/S pairs, consistent stride, sentinel markers) and reports
candidate `(T, S, stride, count)` tuples ranked by confidence.

## View Changes

`project-knowledge/view-builders.ts` disk-layout view colour-codes
files by `origin`. `kernal` and `custom` use distinct visual treatment;
missing `origin` falls back to `kernal`.

## Acceptance Criteria

- The Lykia disk1 case can be reproduced end-to-end without Python:
  `suggest_disk_lut_sector` recommends the LUT, `extract_disk_custom_lut`
  emits 40+ file entries, and `disk_sector_allocation` reports zero
  overlaps and zero unclaimed sectors that should be claimed.
- A standard DOS disk continues to work and shows `origin: "kernal"`
  on every entry.
- The disk-layout view UI distinguishes KERNAL vs custom files.

## Tests

- Unit fixture for `suggest_disk_lut_sector` against the Lykia disk1
  image (or a synthetic equivalent).
- Smoke for `extract_disk_custom_lut` with each `payload_format`.
- Smoke for `disk_sector_allocation` on a clean DOS disk and on a
  custom-LUT disk.

## Migration Notes

- New fields are optional; existing manifests remain valid.
- The view-builder treats absent `origin` as `kernal`.
- Throw-away script `Lykia/tools/disk_manifest_merge.py` can be retired
  once parity is reached.
