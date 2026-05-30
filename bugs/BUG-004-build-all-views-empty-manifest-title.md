# Bug: `build_all_views` crashes on empty manifest item title/name

- **ID:** BUG-004
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** knowledge
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: 951cb2b
- Surface: mcp default / workspace views
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `build_all_views`

## What happened

`build_all_views` crashes on the same empty-name condition as BUG-003. An empty disk filename becomes an empty title/name in the manifest/view model, Zod rejects it, and the complete view build fails. The DDD session had to manually patch `manifest.json` to proceed.

## Expected

View building must tolerate imported disk entries with empty or label-like names. It should render a stable fallback label or skip non-file pseudo entries, not crash the whole project view build.

## Repro steps

1. Produce or import a disk manifest containing an item with empty name/title.
2. Run `build_all_views`.
3. Observe the Zod error and failed view build.

Minimal command / call:

```text
build_all_views after extract/import of DDD disk manifest with empty CBM filename.
```

## Evidence

- Error / output (verbatim):

```text
Leerer title aus leerem Filenamen → ZodError, kompletter View-Build scheitert.
Musste manifest.json manuell patchen.
Gleiche Wurzel wie Bug 1, zweite Codestelle.
Validierung tolerantes Minimum oder Fallback-Label fehlt.
```

- Artifacts: DDD `manifest.json` before manual patch, workspace view build.

## Scope guess (optional)

Project knowledge view builders / manifest artifact schema normalization. Shared root with BUG-003.

## Notes / follow-up

- Prefer one normalization fix if possible, then verify both `extract_disk` and `build_all_views`.

---

## Resolution

- **Root cause:** `view-builders.ts buildDiskLayoutView` set `const title = file.name ?? \`File ${i+1}\``. `??` only catches `undefined`, so an empty CBM name `""` became an empty title → `DiskLayoutFileSchema.title` / `MediumFileSchema.name` `min(1)` ZodError → the whole `build_all_views` crashed. Same root as BUG-003 (the import site).
- **Fix commit:** `17bad20` — treat empty/whitespace-only as "no name", use the stable fallback `<unnamed dir entry t/s #n>`, keep the raw-empty fact in the file notes.
- **Gate proving the fix:** `node scripts/smoke-bug003-004-empty-cbm-filename.mjs` 6/6 — `build_all_views` succeeds; the disk layout shows the fallback label for the empty entry.
- **Regression risk:** low — view-build normalization only; normal-named files unchanged; no entry dropped.
