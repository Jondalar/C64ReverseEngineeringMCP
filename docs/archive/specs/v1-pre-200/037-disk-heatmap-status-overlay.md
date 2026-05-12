# Spec 037: Disk Heatmap Status Overlay

## Problem

The disk panel ships a cylindrical track-sector heatmap with origin
colouring (kernal vs custom-loader vs unknown). Status colouring
per Spec R7 — bad CRC, drive-code, raw-unanalyzed, gap, protection
— is not surfaced. Users cannot eyeball protection sectors,
drive-side code, or unanalyzed raw extracts without leaving the
panel.

## Goal

Add a status overlay layer to the existing cylindrical heatmap. The
overlay reads from a new payload-level field `payloadDiskHint` so
the source of truth lives on the payload entity (semantic layer),
not on transient UI computation.

## Approach

### Schema

Extend payload `EntityRecord` with:

```ts
payloadDiskHint?: "drive-code" | "protected" | "raw-unanalyzed" | "bad-crc" | "gap"
```

Stored on the payload entity that owns the sector range. A disk
file artifact may carry multiple payload entities; each payload's
`payloadDiskHint` colours its own sectors only.

### Auto-tagging on extract / inspect

| Tool | Sets `payloadDiskHint` |
|------|------------------------|
| `inspect_g64_blocks` / `inspect_g64_syncs` / `analyze_g64_anomalies` (CRC fail) | `bad-crc` |
| `inspect_g64_blocks` (sync anomaly, off-track) | `protected` |
| `extract_disk` for T1/S0 buffer where first 3 bytes decode as JMP $03XX | `drive-code` |
| `register_existing_files` for `.bin` rows in `analysis/disk/.../raw_sectors/` without semantic import | `raw-unanalyzed` |
| Manual override via new `set_payload_disk_hint(payload_id, hint)` | per caller |

### Aggregator

`buildDiskLayoutView` already builds per-disk file lists. Extend it
to include per-sector hint resolution:

1. For each disk file, look up its payload entities.
2. Collect each payload's `payloadDiskHint` and its sector range
   (from `mediumSpans[]`).
3. Emit a `sectorHints: Array<{track, sector, hint}>` field on the
   disk view.

### Renderer

`DiskPanel` cylindrical view (already in `ui/src/App.tsx`) gets a
second SVG path layer per sector:

- Fill stays the existing origin colour.
- Stroke (1.5px) draws an overlay ring in the hint colour:
  - `drive-code` → purple
  - `protected` → red
  - `raw-unanalyzed` → blue
  - `bad-crc` → red dashed
  - `gap` → yellow

Both colours stay visible: origin (fill) + status (border).

Legend panel below the heatmap lists all six colours with current
counts.

### MCP tools

- `set_payload_disk_hint(payload_id, hint)` — manual override.
- `clear_payload_disk_hint(payload_id)` — reset.

## Acceptance Criteria

- The fixture project's disk file (after `extract_disk` + an
  inspect run that detects bad CRC) shows red border on the bad
  sectors and purple border on T1/S0 drive-code.
- Hovering a sector shows a tooltip with origin + hint + linked
  payload id.
- Manual `set_payload_disk_hint` overrides the auto-tag.
- Legend updates counts as hints are added / removed.

## Tests

- Smoke: synthetic project with two payload entities, one tagged
  `drive-code` and one `bad-crc`; assert disk-layout view JSON
  carries the expected `sectorHints` entries.

## Out Of Scope

- Heatmap layout change (cylindrical stays). Linear-grid toggle
  deferred to a later sprint.
- D64 vs G64 layout differences (existing renderer already handles
  variable sectors per zone).

## Dependencies

- Spec 022 (per-artifact status) for relevance ranking visibility
  (Spec 041) but not blocking.
- Existing `DiskPanel` component.
