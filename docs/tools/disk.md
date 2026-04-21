# Disk Image Tools

D64 / G64 inspection and extraction. Supports both standard 1541 DOS disks
and custom-LUT disks where the BAM/dir is decorative and real files live in
non-directoried sectors.

## D64 / G64 high-level

| Tool | Description |
|---|---|
| `inspect_disk` | Read a D64 or G64 directory and list contained files without extraction. |
| `extract_disk` | Extract files from a D64 or G64 image and write `manifest.json` for follow-up analysis. Includes per-file `sectorChain` for downstream sector-allocation tools. |

The extracted `manifest.json` contains a `files[]` array. Each entry now
carries a `sectorChain` so workspace tools can reason about disk layout
without re-walking the image.

## G64 low-level

| Tool | Description |
|---|---|
| `list_g64_slots` | List all G64 half-track slots with raw offsets, lengths, and speed-zone metadata. |
| `inspect_g64_track` | Decode a specific G64 track / half-track via GCR; report discovered sectors plus raw slot metadata. |
| `inspect_g64_blocks` | Inspect raw GCR header / data block candidates with JSON + ASCII visualization. |
| `extract_g64_raw_track` | Export the raw circular byte ring for a track / half-track. |
| `inspect_g64_syncs` | Report bit-aligned sync positions. |
| `scan_g64_headers` | Scan header candidates using a VICE-like 1541 search model. |
| `read_g64_sector_candidate` | Read a sector via VICE-like sync/header scanning. |
| `extract_g64_sectors` | Decode a track and write one file per decoded sector. |
| `analyze_g64_anomalies` | Scan for missing, duplicate, unexpected, off-track, or half-track anomalies; can cross-check LUT track references. |

## Custom-LUT disks (planned)

The Lykia disks (and similar protected loaders) hide most of their content
behind a custom LUT sector instead of the standard DOS directory. See
[TODO.md](../../TODO.md) for the planned `extract_disk_custom_lut`,
`disk_sector_allocation`, and `suggest_disk_lut_sector` tools.

Until those land, custom-LUT extraction lives in per-project Python
helpers (e.g. `Lykia/tools/disk_manifest_merge.py`).
