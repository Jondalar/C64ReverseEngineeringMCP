# Bug: Live Drive insert menu mixes project media with C64RE dev samples

- **ID:** BUG-013
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** medium
- **Status:** fixed

## Environment

- Branch / commit: b65943c
- Surface: ui-v3 / runtime WS media list
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Live tab, Drive 8 insert menu

## What happened

In the Live tab's Drive 8 insert dropdown, project media from the DDD project is present, but the same list also includes C64RE development repo sample disks such as `motm.g64`, `last_ninja_remix_s1[system3_1991].g64`, `the_pawn_s1.g64`, etc.

This makes the normal project workflow confusing: the user is in a concrete project, but the insert menu mixes project-local media with dev/sample fixtures from the C64RE repository.

## Expected

The Drive 8 insert menu must show **only media from the active project** in normal product mode.

- Project media only.
- No C64RE development repo `samples/` entries.
- No bundled fixture disks.
- No mixed source list.
- Dev samples may exist only behind an explicit dev-only mode and must never appear in the normal project UI.

## Repro steps

1. Open the v3 UI for the DDD project.
2. Go to the Live tab.
3. Open the Drive 8 insert dropdown.
4. Observe that both DDD disks and repo sample disks appear in one mixed list.

Minimal command / call:

```text
UI action: Live tab → Drive 8 → insert dropdown.
```

## Evidence

- Error / output (verbatim):

```text
da sollte jetzt auch stehen, was im Poject Ordner ist und NICHT was im samples/ Ordner des C64RE developements ist
Er nutzt beides
die DDD Disks sind auch da
In der disk Picker liste sind nachwie vor die samples und die Files aus dem project dir .. da sollen NUR ie aus dem Projekt dir sein
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Target: DRIVE 8 insert menu
Visible entries include project DDD disks and C64RE repo samples/dev fixtures.
Repo sample examples visible:
motm.g64
last_ninja_remix_s1[system3_1991].g64
the_pawn_s1.g64
POLARBEAR.d64
scramble_infinity.d64
impossible_mission_ii_epyx_1987(!).g64
maniac_mansion_s1[activision_1987]
```

- Artifacts: user-provided marked browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

`src/workspace-ui/v3-ws-server.ts` media listing / Live inspector media source. Possibly `--dev-samples` is enabled unintentionally, or project media and dev samples are merged without source labeling.

## Notes / follow-up

- This is not a missing-project-media bug; project disks are present.
- The problem is source mixing. Normal project mode must not show repo/dev samples at all.
- Fix should include a UI/API smoke proving normal project mode shows only active-project media and excludes known repo sample names such as `motm.g64`, `POLARBEAR.d64`, and `the_pawn_s1.g64`.

---

## Resolution

- **Root cause:** NOT the `--dev-samples` switch (it was off, and its `samples/` scan was correctly gated). The leak was the `media/recent` WS handler's first source, `getRecent()` — a GLOBAL recents store at `~/.config/c64re/recent-media.json`. Earlier dev/gate runs mounted the repo corpus (motm.g64, POLARBEAR.d64, the_pawn_s1.g64, …), which got persisted there; those absolute paths then surfaced in every project's picker regardless of the active project dir. The project-dir walk (source 3) was already correct.
- **Fix:** in `src/workspace-ui/v3-ws-server.ts` `media/recent`, gate the recents source to entries whose path resolves INSIDE the active `this.projectDir` (via `path.relative`, rejecting `..`/absolute escapes). In product mode any recents path outside the project is dropped; under `--dev-samples` recents from anywhere are still allowed (dev convenience). Added a `C64RE_RECENT_FILE` env override to `recent-files.ts` so tests can isolate the global store.
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug013` (`scripts/smoke-bug013-drive-picker-project-only.mjs`) 5/5 — seeds the recents store with a project disk AND an external `motm.g64`, starts the workspace pointed at the project (no `--dev-samples`), calls `media/recent` over WS, and asserts the project disk is present, the external sample is excluded, no known gate-corpus name leaks, and every picker entry is inside the project dir.
- **Regression risk:** low — product-mode picker is now strictly project-scoped (the intended behavior); `--dev-samples` dev mode is unchanged; no runtime/emulator change.
