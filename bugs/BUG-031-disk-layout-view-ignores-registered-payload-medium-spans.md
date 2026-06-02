# Bug: Disk-layout view ignores registered-payload medium_spans (shows only CBM manifest + BAM)

- **ID:** BUG-031
- **Date:** 2026-06-02
- **Reporter:** llm
- **Area:** knowledge / ui-v3 (disk-layout view + builder)
- **Severity:** medium
- **Status:** fixed <!-- open | investigating | fixed | wontfix | duplicate -->

## Environment

- Branch / commit: master (post BUG-024 `register_payload`, post runtime-daemon)
- Surface: mcp full + workspace UI (Disk Layout tab)
- Project dir: `/Users/alex/Development/C64/Cracking/Wasteland_EF`
- Tool / view: `register_payload` (medium_spans) → `build_all_views` → `views/disk-layout.json` → UI Disk Layout

## What happened

A game whose payloads are **code-derived raw disk regions** (no CBM directory entry — the
custom loader reads them by track/sector; common in cracks/protections). I registered 6
real payloads with `register_payload`, several carrying disk `medium_spans`
(sector `{track,sector,length}`), e.g. `utils_overlay_7E00` at T8, `01_prodos` T18/S2,
`02_2.0` T18/S3. They show correctly in `list_payloads`, the memory map, and the annotated
listing (load addr + ASM linked).

But the **Disk Layout view is unchanged** — the file panel still lists only the 2 CBM-dir
files (`01_prodos`, `02_2.0`), and the disk-geometry wheel shows only the BAM allocation
(almost entirely "free"/red, because the game data is BAM-unclaimed by design) + the T18
dir arc. None of the registered payloads' `medium_spans` are drawn on the geometry or
listed.

Root cause (confirmed from the built view): `views/disk-layout.json` `disks[].files` has
**length 2** — the disk-layout builder populates it **only from the image's CBM manifest**
(`extract_disk` output) + BAM occupancy. It does **not** consume knowledge-store payloads
or their `medium_spans`. So `register_payload` with disk spans has no effect on the disk view.

This is the disk-view analogue of BUG-024: code-derived/raw disk regions can be registered
as rich payloads everywhere EXCEPT the disk-geometry, which stays manifest-bound. For a
game like Wasteland (only 2 CBM files; the entire world/engine/maps are BAM-unclaimed raw
T/S reads) the disk view is therefore permanently "empty" and cannot reflect the reversed
cartography.

## Expected

The disk-layout view (and `views/disk-layout.json`) should overlay **registered payloads
whose `medium_spans` are sector-kind for that image** — drawn on the geometry wheel at their
T/S and listed in the file/region panel alongside the CBM-dir files (e.g. with an
`origin=custom`/`code-derived` tag and the payload's name/load-addr/class). So the reversed
map (code, maps, gfx, save-state, empty bands) colours the disk, not just the BAM.

## Repro steps

1. In a project with raw/code-derived disk regions, `register_payload name=... load_address=...
   format=... source_prg_path=... medium_spans=[{kind:sector,track:T,sector:S,length:L}]`.
2. `build_all_views`.
3. Open Disk Layout in the UI (or read `views/disk-layout.json`).
4. Observe: the payload is in `list_payloads` + memory map + annotated listing, but NOT on
   the disk geometry / file panel; `disks[].files` still only has the CBM-manifest entries.

## Evidence

```text
list_payloads → 6 rich payloads (load/fmt/asm/src) incl. utils_overlay_7E00 (T8 span),
                01_prodos (T18/S2), 02_2.0 (T18/S3), block2_engine_0200, ...

views/disk-layout.json:
  top keys: id, kind, title, projectId, generatedAt, disks
  disks[].files: list len = 2        ← only 01_prodos + 02_2.0 (CBM manifest)
  grep payload names → only 01_prodos, 02_2 found; block2/block3/utils/engine_0500 absent
```

UI: Disk Layout tab shows "ORIGIN all 2 / unknown 2"; geometry wheel almost all red
(BAM-free) + T18 arc; left panel lists only the 2 .prg dir files.

## Scope guess (optional)

Disk-layout view builder (the `build_*` that emits `disk-layout.json`): it sources
`disks[].files` from the per-image `manifest.json` (CBM extract) + BAM only. Add a pass that
pulls knowledge-store payloads with `medium_spans.kind=sector` matching the image and emits
them as additional file/region entries (origin=custom) + geometry segments. `extract_disk_custom_lut`
already does a manifest-merge for fixed-LUT disks; this is the same need for
`register_payload`-sourced spans (no on-disk LUT).

## Notes / follow-up

- Related: BUG-024 (rich `register_payload` — fixed) covered payload-list/memory-map/listing
  but not the disk-geometry. This bug closes that last gap.
- Practical impact: Wasteland's whole reversed disk cartography (per `docs/GAMEDISK_CARTOGRAPHY.md`)
  can't be shown on the disk view; the disk looks empty save the 2 CBM files.
- Workaround (not done): hand-inject `origin=custom` entries with T/S into the image's
  `manifest.json`.

---

## Resolution

- **Root cause:** the disk-layout view builder (`buildDiskLayoutView`,
  `src/project-knowledge/view-builders.ts`) sourced `disks[].files` ONLY from the
  per-image CBM manifest + BAM. It never consumed knowledge-store payloads or their
  sector `mediumSpans`, so a `register_payload(medium_spans=[{kind:sector,...}])`
  had no effect on the disk view — code-derived raw regions (no dir entry) were
  invisible.
- **Fix:** after building the manifest files, the builder now adds a payload-overlay
  pass: every `context.entities` entry with a sector-kind `mediumSpans`, matched to
  this image (explicit `artifactIds` link, or the single-disk default), is emitted as
  an `origin=custom` file with a synthesized sector chain (so it's listed AND drawn
  on the geometry wheel). Spans whose start T/S is already claimed by a CBM-manifest
  file are deduped (e.g. a payload registered over `01_prodos` is not double-listed).
  `trackCount` already widens to cover added chains, so payloads on extended tracks
  show too. (The UI already renders `origin=custom` files via the custom-LUT path.)
- **Fix commit:** (this change)
- **Gate proving the fix:** `npm run e2e:bug031` (`scripts/e2e-bug031-disk-payload-spans.mjs`)
  8/8 — registers 2 unclaimed sector-span payloads (T8, T12) + 1 over a CBM file;
  asserts the unclaimed ones appear (origin=custom, on the geometry as 'file' cells),
  the CBM-overlap one is deduped, and `disks[].files` grows 2→4.
- **Regression risk:** low — manifest files are unchanged (the pass only ADDS custom
  entries + dedups overlaps); same builder as BUG-003/004 (`smoke-bug003-004` 6/6,
  `project-knowledge-smoke` green).
