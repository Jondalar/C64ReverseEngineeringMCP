# Bug: `extract_disk` manifest import fails on empty CBM directory filename

- **ID:** BUG-003
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** mcp-tool
- **Severity:** high
- **Status:** fixed

## Environment

- Branch / commit: 951cb2b
- Surface: mcp default
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: `extract_disk`

## What happened

`extract_disk` / manifest import fails when a CBM directory contains a label / pseudo-entry with an empty filename. In the DDD disks, CBM directory label entries (`À` / shifted-space, `USR`, `0 Blocks`) produce `name: ""`. Zod rejects this with `items[0].name too_small (min 1)`, and the whole disk manifest import fails.

## Expected

One empty or label-like CBM directory name must not kill the complete disk manifest import. The importer should either skip non-file label/pseudo entries or assign a stable fallback label while preserving the raw directory evidence.

## Repro steps

1. In the DDD project, run `extract_disk` on the DDD `.d64` media.
2. Observe manifest import failure.
3. Check artifact/audit state; manifest artifacts remain unimported.

Minimal command / call:

```text
extract_disk on Die Dunkle Dimension .d64 with CBM directory entries that decode to empty filename.
```

## Evidence

- Error / output (verbatim):

```text
CBM-Verzeichnis-Label-Einträge (À/shifted-space, USR, 0 Blocks) haben Namen "".
Zod: items[0].name too_small (min 1).
Ganzer Manifest-Import des Disks fällt aus → unimportedManifestArtifacts=3.
Ein leerer Name killt alle Files.
```

- Artifacts: DDD project disk manifests / extract_disk run.

## Scope guess (optional)

Disk manifest import schema / CBM directory item normalization. Likely shared root with BUG-004.

## Notes / follow-up

- Fix should preserve raw CBM directory bytes/name evidence.
- Do not hide valid weird CBM directory entries; make the product model tolerant.

---

## Resolution

- **Root cause:** `manifest-import.ts` set the disk-file entity `name: file.name ?? file.relativePath ?? …`. `??` only catches `undefined`, so an empty CBM name `""` produced an empty entity name → `EntityRecordSchema.name min(1)` ZodError → the whole disk manifest import aborted. Same `??`-vs-empty-string root as BUG-004 (second site).
- **Fix commit:** `17bad20` — treat empty/whitespace-only as "no name", fall back to `disk_file_<n>`, keep the raw-empty fact in the entity summary.
- **Gate proving the fix:** `node scripts/smoke-bug003-004-empty-cbm-filename.mjs` 6/6 — manifest with empty + whitespace + normal filenames imports all 3 disk-file entities, every name non-empty.
- **Regression risk:** low — import-side normalization only; normal-named files unchanged; raw evidence preserved.
