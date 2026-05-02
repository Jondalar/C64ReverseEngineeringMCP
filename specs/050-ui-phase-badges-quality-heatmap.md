# Spec 050: UI Phase Badges + Quality Columns + Heatmap Overlay

## Problem

Sprint 19 (per-artifact status), Sprint 37 (quality + relevance +
heatmap hint) shipped data + endpoints. UI does not yet render any
of it. Users do not see phase progress or quality scores; the disk
heatmap shows origin (kernal/custom) but not protection /
drive-code / bad-CRC overlays.

## Goal

Three blocks in one sprint, all touching existing UI panels:

- Block A — disk heatmap status overlay (Sprint 37 carryover)
- Block B — dashboard quality + relevance columns
- Block D — phase status badges in dashboard / disk-layout /
  payloads / cartridge panels

(Block C — annotation draft viewer — is split out as Spec 051 for
size.)

## Approach

### Block A — Disk heatmap status overlay

`ui/src/App.tsx` `DiskPanel` cylindrical view gains a second SVG
path layer per sector:

- Fill stays the existing origin colour (kernal / custom-loader /
  unknown).
- Stroke 1.5px draws a hint colour border:
  - drive-code → purple
  - protected → red
  - raw-unanalyzed → blue
  - bad-crc → red dashed (`stroke-dasharray="2,2"`)
  - gap → yellow

Tooltip on hover shows: origin + hint + linked payload id.

Legend below the heatmap lists the six colours with current counts.

Source: payload entity's `payloadDiskHint` field (Sprint 37).
Resolved through `buildDiskLayoutView` aggregator that emits
`sectorHints: Array<{track, sector, hint}>` on the disk view.

### Block B — Dashboard quality + relevance columns

Dashboard per-artifact rows gain three sortable columns:

- `completionPct` (Spec 022, role-aware)
- `qualityScore` (Spec 040)
- `relevanceRank` (Spec 041)

Color-code each cell:
- green: ≥ 80
- yellow: 50–80
- red: < 50

Clickable column headers sort by that column. Default sort:
- Cracker mode (`projectProfile.defaultRole === "cracker"`) →
  by `relevanceRank` ascending
- Otherwise → by `completionPct` descending

### Block D — Phase status badges

A `PhaseBadge` component renders a 7-cell pill: each cell is ✓
(done), ⨯ (pending), or — (not required for active workflow).
Frozen artifacts render with a 🔒 icon and the frozen phase
highlighted.

Rendered in:
- Dashboard per-PRG row (left of completion column)
- Disk-Layout file row
- Payloads card header
- Cartridge-Layout chunk row

Click a badge → opens an artifact-detail panel with the per-step
status list and the recommended next action. A "Freeze artifact"
button calls `agent_freeze_artifact` for asset PRGs.

## Endpoint additions

The per-artifact-status endpoint (Sprint 19) already returns the
fields. Add `payloadDiskHint` aggregation to the disk-layout view
endpoint (`buildDiskLayoutView`).

## Acceptance Criteria

- Fixture project disk heatmap shows red border on bad-CRC
  sectors and purple on T1/S0 drive code (after manual
  set_payload_disk_hint calls).
- Dashboard sorts by `qualityScore` when the user clicks the
  column.
- Cracker-mode profile auto-sorts by `relevanceRank`.
- Phase badges appear in all four panels and respond to click.

## Tests

- Smoke: DiskPanel renders with 1 hinted sector, assert the SVG
  contains the expected stroke colour.
- Smoke: dashboard sorts deterministically when given canned per-
  artifact-status response.

## Out Of Scope

- Linear-grid disk layout toggle.
- Cylindrical layout for cartridge panel (cart stays as-is).

## Dependencies

- Sprint 19 per-artifact-status endpoint.
- Sprint 37 (Spec 037 + 040 + 041) data layer.
- Existing DiskPanel / DashboardPanel / PayloadsPanel /
  CartridgePanel components.
