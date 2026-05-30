# Bug: Disk geometry lacks track/sector navigation for occupied non-directory data

- **ID:** BUG-017
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: 790e7a4
- Surface: ui-v3 / Disk tab
- Project dir: current project UI acceptance session
- Tool / endpoint / tab: Disk Layout / Disk Geometry

## What happened

Some disks have only a few visible directory entries, but the disk geometry visualization shows that the disk is nearly full. The UI does not provide an obvious way to inspect/click through occupied tracks/sectors that are not represented by directory files.

The user can see that there is data on many tracks, but cannot navigate the raw track/sector occupancy directly from the disk visualization.

## Expected

The Disk view should let the user inspect disk data beyond directory entries:

- Track numbers / sector occupancy should be clickable or otherwise navigable.
- Clicking a track or sector in the geometry should update the Inspector/detail panel.
- The user should be able to step through tracks/sectors, including occupied non-directory data.
- Directory file selection remains available, but is not the only way to inspect disk contents.
- For copy-protected/custom-loader disks with sparse directories and full raw data, the UI must expose the raw disk layout.

## Repro steps

1. Open a disk image with few directory files but high raw occupancy.
2. Go to the Disk tab.
3. Observe the disk geometry/heatmap shows many occupied tracks.
4. Try to click/select tracks or sectors that are not listed as directory files.
5. Observe there is no obvious raw track/sector navigation.

Minimal command / call:

```text
UI action: Disk tab → inspect disk geometry on a mostly full disk with few directory entries.
```

## Evidence

- Error / output (verbatim):

```text
Die Disks haben "wenig" Directory Einträge, sind aber ranvoll .. wo sind die Tracks hin über der Disk ? Zum Durchklicken ?
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Visible Disk tab:
- few directory entries listed
- disk geometry visualization shows many occupied tracks/sectors
- no visible track/sector click-through navigation above/around the disk geometry
```

- Artifacts: user-provided browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

DiskPanel / Disk Geometry UI. Existing SVG likely visualizes occupancy but does not expose selected track/sector state or click handlers for raw sectors.

## Notes / follow-up

- This is important for copy-protected/custom-loader disks where meaningful data is not represented by normal directory entries.
- A minimal fix could add clickable track buttons/sector cells and a raw sector inspector before building a full hex viewer.

---

## Resolution

- **Root cause:** the Disk Geometry SVG rendered every sector cell (with full track/sector/category/hint/fileId data already in the snapshot) but the cells had no click handler and no raw-sector selection state — so occupied non-directory data (orphan_allocated, drive-code, raw-unanalyzed, bam, …) could only be reached if it happened to belong to a listed directory file. The raw 256-byte read endpoint (`/api/disk/sector-bytes?path&track&sector`) already existed; only the UI navigation was missing.
- **Scope:** full (user-chosen) — clickable sectors + raw-sector detail + 256-byte hex viewer.
- **Fix (`ui/src/components/workspace-panels.tsx` `DiskPanel`):**
  - Every SVG sector `<path>` is now a clickable button (`disk-sector-clickable`, native `<title>` tooltip) → `inspectSector(track, sector)`.
  - `inspectSector` sets a `selectedSector` state (distinct accent highlight `disk-sector.sector-selected`, independent of directory-file selection) and opens the existing hex overlay with `fetchUrl=/api/disk/sector-bytes?…` (256-byte length) — reusing the product hex viewer, no new viewer needed.
  - A raw-sector detail line under the geometry shows `T<track>/S<sector>`, the sector category, hint, and file (or "no directory file"), with an explicit "Open hex (256 B)" button; a hint prompts when nothing is selected. Works for D64 and G64 (the endpoint's `createDiskParser` handles both). The selection clears when the active disk changes.
  - CSS added to BOTH `index.css` (v1 product) and `workspace-panels.css` (v3) — the disk CSS is duplicated across the two sheets.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug017` 9/9 — UI source wiring (inspectSector, per-sector onClick, selection+highlight, sector-bytes URL, detail line) + a real-D64 HTTP E2E (`/api/disk/sector-bytes` returns 256 raw bytes for T18/S0 with the correct content, out-of-range track → 404). v1+v3 build green; ui typecheck 13 pre-existing / 0 new.
- **Regression risk:** low — additive UI + an already-existing endpoint; directory-file selection is unchanged; no backend change. (Future: a richer in-panel hex/ASCII split or sector-chain follow could build on this.)
