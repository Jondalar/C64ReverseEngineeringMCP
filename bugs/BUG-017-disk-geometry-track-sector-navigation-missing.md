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

Update after the first fix: individual sector clicks now work, but the old
track-grid control between the "Disk Geometry" header and the circular geometry
is still missing. That grid allowed selecting an entire track and showing it
directly in the monitor/sector view. The sector-only click path is useful, but
it does not replace the fast track-level navigation workflow.

## Expected

The Disk view should let the user inspect disk data beyond directory entries:

- Track numbers / sector occupancy should be clickable or otherwise navigable.
- A compact track/sector grid should be visible above the circular geometry,
  like the earlier UI, so the user can click a whole track quickly.
- Clicking a track or sector in the geometry should update the Inspector/detail panel.
- Clicking a track in the grid should show that track's sectors in the monitor/detail
  area without requiring precise clicks on the circular SVG.
- The user should be able to step through tracks/sectors, including occupied non-directory data.
- Directory file selection remains available, but is not the only way to inspect disk contents.
- For copy-protected/custom-loader disks with sparse directories and full raw data, the UI must expose the raw disk layout.

## Repro steps

1. Open a disk image with few directory files but high raw occupancy.
2. Go to the Disk tab.
3. Observe the disk geometry/heatmap shows many occupied tracks.
4. Try to click/select tracks or sectors that are not listed as directory files.
5. Observe that sector clicks exist, but the old track-grid navigation above the
   circular geometry is missing.

Minimal command / call:

```text
UI action: Disk tab → inspect disk geometry on a mostly full disk with few directory entries.
```

## Evidence

- Error / output (verbatim):

```text
Die Disks haben "wenig" Directory Einträge, sind aber ranvoll .. wo sind die Tracks hin über der Disk ? Zum Durchklicken ?
```

```text
ich kann zwar in die sectors klicken, aber wir hatten mal zwischen DISK GEOMETRY
und der Grafik ein Grid, da konnte man reinklicken für einen ganzen TRack,
und der wurd im mon einfach angezeigt. das ist sehr sehr hilfreich zu haben.
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
- The first fix added clickable sector cells and a raw sector inspector.
- Remaining missing piece: restore the compact track/sector grid workflow above
  the circular geometry, with track-level selection and monitor/detail update.

---

## Resolution

- **Root cause:** the Disk Geometry SVG rendered every sector cell (with full track/sector/category/hint/fileId data already in the snapshot) but the cells had no click handler and no raw-sector selection state — so occupied non-directory data (orphan_allocated, drive-code, raw-unanalyzed, bam, …) could only be reached if it happened to belong to a listed directory file. The raw 256-byte read endpoint (`/api/disk/sector-bytes?path&track&sector`) already existed; only the UI navigation was missing.
- **Scope:** partial — clickable sectors + raw-sector detail + 256-byte hex viewer shipped, but the old track-grid workflow is still missing.
- **Fix (`ui/src/components/workspace-panels.tsx` `DiskPanel`):**
  - Every SVG sector `<path>` is now a clickable button (`disk-sector-clickable`, native `<title>` tooltip) → `inspectSector(track, sector)`.
  - `inspectSector` sets a `selectedSector` state (distinct accent highlight `disk-sector.sector-selected`, independent of directory-file selection) and opens the existing hex overlay with `fetchUrl=/api/disk/sector-bytes?…` (256-byte length) — reusing the product hex viewer, no new viewer needed.
  - A raw-sector detail line under the geometry shows `T<track>/S<sector>`, the sector category, hint, and file (or "no directory file"), with an explicit "Open hex (256 B)" button; a hint prompts when nothing is selected. Works for D64 and G64 (the endpoint's `createDiskParser` handles both). The selection clears when the active disk changes.
  - CSS added to BOTH `index.css` (v1 product) and `workspace-panels.css` (v3) — the disk CSS is duplicated across the two sheets.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug017` 9/9 — UI source wiring (inspectSector, per-sector onClick, selection+highlight, sector-bytes URL, detail line) + a real-D64 HTTP E2E (`/api/disk/sector-bytes` returns 256 raw bytes for T18/S0 with the correct content, out-of-range track → 404). v1+v3 build green; ui typecheck 13 pre-existing / 0 new.
- **Regression risk:** low — additive UI + an already-existing endpoint; directory-file selection is unchanged; no backend change. (Future: restore the track-grid selector and richer in-panel hex/ASCII split or sector-chain follow.)

## Reopen note — 2026-05-30

BUG-017 is not complete. The sector-click part is fixed, but the earlier
track-grid selector is still absent. Keep this bug open until the UI again offers
fast track-level navigation above the circular disk geometry.

## Resolution — track grid restored (2026-05-30)

- **Root cause (reopen):** a clickable track strip DID exist between the "Disk
  Geometry" header and the circular SVG, but it was gated `if (!isD64) return
  null` — so on G64 images (common for cracked disks) it disappeared, and it only
  ever opened a whole-track hex via D64 offset math (no track highlight).
- **Fix (`DiskPanel`):** the track strip now renders for EVERY format (un-gated).
  Each track button calls `showTrack(track)`, which highlights that track's
  sectors in the geometry (`selectedTrack` → `.disk-sector.track-selected`,
  `.disk-track-mon.active`) and shows the track in the hex/monitor: D64 reads the
  whole track by offset (as before); other formats (G64) open the track's first
  decoded sector via the format-agnostic `/api/disk/sector-bytes` endpoint
  (`inspectSector(track, firstSectorOfTrack(track))`). Clicking an individual
  sector also marks its track active, so the strip + geometry stay in sync.
  CSS added to both `index.css` (v1) and `workspace-panels.css` (v3).
- **Gate proving the fix:** `npm run smoke:bug017` 13/13 — adds checks 5a–5d
  (strip → showTrack, NOT D64-gated, selected-track highlight, non-D64 first
  sector) on top of the sector-click + real-D64 HTTP E2E. v1+v3 build green;
  ui typecheck 13 pre-existing / 0 new.
- **Regression risk:** low — additive UI; existing sector-click + D64 whole-track
  hex preserved; format-agnostic path reuses the existing endpoint.

## Follow-up — full track count + per-sector navigation (2026-05-30)

User feedback: the strip only showed tracks 1–35 (not 42) and a track click only
ever reached the first sector.

- **Track count cap:** the disk view-builder derived `trackCount` from the
  tracks that DIRECTORY FILES reference (`Math.max(35, …file chains)`). On a
  sparse-directory / copy-protected image the extended tracks (36–42) are not in
  any file chain, so the layout capped at 35 even though the image physically has
  42 tracks. Fix: `DiskImage.getTrackCount()` (already implemented on both
  parsers, now part of the interface) feeds the view-builder
  (`Math.max(35, parser.getTrackCount(), …files)`), so the layout exposes every
  physical track. The G64 parser's `getTrackCount()` no longer trusts the header
  byte alone (it **can be falsified by copy protection**) — it scans the real
  track-offset table for the highest track that actually has GCR data and takes
  the max with the header-derived count.
- **Only-first-sector:** selecting a track now reveals a **sector sub-strip**
  (every sector of that track as a clickable button → `inspectSector`), so all
  sectors are reachable, not just the first. The DiskPanel also derives the strip
  length from the real max track present (`diskMaxTrack`) as a belt-and-suspenders.
- **Gate:** `npm run smoke:bug017` 17/17 (adds 5e–5h: real-max-track strip,
  sector sub-strip, view-builder physical track count, G64 lying-header
  tolerance). MCP + pipeline + v1 + v3 builds green; ui typecheck 13/0.
