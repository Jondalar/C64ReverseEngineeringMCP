# Bug: Project init leaves media unsorted instead of placing it under typed `input/` folders

- **ID:** BUG-015
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** mcp-tool
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: 6809cef
- Surface: mcp default / project initialization
- Project dir: any freshly initialized project
- Tool / endpoint / tab: `project_init` / project setup flow

## What happened

After project initialization, media files can remain loose in the project root instead of being organized under typed `input/` folders. For real projects this makes later inventory, media selection, and human navigation messy.

Expected examples:

- `.d64` / `.g64` → `input/disk/`
- `.crt` → `input/crt/`
- `.prg` → `input/prg/`
- docs/manuals such as `.pdf` / `.md` → suitable input/docs location

## Expected

The init/import flow should establish and use a predictable input layout. When media is provided or discovered during initialization, it should be copied/moved/registered into the proper typed `input/` subfolder, with project knowledge/artifact records pointing at that canonical path.

The LLM/human should not have to manually sort basic C64 media types after `project_init`.

## Repro steps

1. Create or initialize a new C64RE project with C64 media files present.
2. Run the normal project init/import/onboard flow.
3. Observe whether `.d64`, `.g64`, `.crt`, `.prg`, and docs remain loose in the project root instead of typed `input/` subfolders.

Minimal command / call:

```text
project_init on a folder containing .d64/.g64/.crt/.prg media.
```

## Evidence

- Error / output (verbatim):

```text
im Projekt Init sollte der Init job die Medien alle in den input ordner legen, also d64/g64 nach disk, crt nach crt, usw
```

- Artifacts: DDD project setup during UI/MCP acceptance, 2026-05-30.

## Scope guess (optional)

Project initialization / media ingress / inventory sync. Likely related to future Spec 730 project inventory sync façade.

## Notes / follow-up

- This may belong in the same conceptual area as BUG-005 / Spec 730, but it is concrete enough to track as a project-init/media-ingress bug.
- Clarify move vs copy policy before implementation. The product probably wants canonical copied project inputs while preserving source provenance.

---

## Resolution

- **Root cause:** `project_init` → `initProject()` only created the empty `input/{prg,crt,disk,raw}` skeleton (via `ensureProjectStructure`); it never scanned the project root for loose media or sorted it. So media dropped in the root stayed loose, and there was no `input/docs` folder at all.
- **Fix:**
  - Added `input/docs` to the canonical layout (`storage.ts`: `ProjectKnowledgePaths.inputDocs` + `paths` factory + `ensureProjectStructure`).
  - New `ProjectKnowledgeService.sortLooseInputMedia()` (`service.ts`): scans ONLY the project root's top-level files, routes by extension — `.d64`/`.g64` → `input/disk/`, `.crt` → `input/crt/`, `.prg` → `input/prg/`, `.pdf`/`.md`/`.txt` → `input/docs/` — **moves** the file (root stays clean), and registers an artifact at the canonical path via `saveArtifact` with the original root-relative name preserved in the description (provenance) + tags `["input","auto-sorted"]`. Unknown extensions and dotfiles are left in place. Never clobbers an existing canonical file (records a skip). Emits a `project.media-sorted` timeline event. Idempotent — a second run finds nothing loose. No repo-samples fallback (only the project's own root is scanned).
  - Wired into the `project_init` handler (`mcp-tools.ts`): runs after `initProject`, and the report lists each `from → to (kind)` plus any skips.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug015` (`scripts/smoke-bug015-init-media-sort.mjs`) 11/11 — fresh project + mixed media (`.d64/.g64/.crt/.prg/.md/.txt/.pdf` + an unknown `.xyz`): asserts canonical placement, root cleaned of sorted media, unknown type left in root, artifact registered at the canonical path with `kind=d64` + provenance, result reports 7 sorted, and idempotency (second run sorts 0). `npm run build:mcp` clean.
- **Regression risk:** low — init now MOVES matching root files into `input/`; this only affects files a user dropped in the root for ingestion, runs on the project's own dir only, never clobbers, and is idempotent. Existing projects are unaffected unless they have loose root media (which is the intended target).
