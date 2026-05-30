# Bug: Live Drive insert menu mixes project media with C64RE dev samples

- **ID:** BUG-013
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** medium
- **Status:** open

## Environment

- Branch / commit: b65943c
- Surface: ui-v3 / runtime WS media list
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Live tab, Drive 8 insert menu

## What happened

In the Live tab's Drive 8 insert dropdown, project media from the DDD project is present, but the same list also includes C64RE development repo sample disks such as `motm.g64`, `last_ninja_remix_s1[system3_1991].g64`, `the_pawn_s1.g64`, etc.

This makes the normal project workflow confusing: the user is in a concrete project, but the insert menu mixes project-local media with dev/sample fixtures from the C64RE repository.

## Expected

The Drive 8 insert menu should default to project media only, or clearly separate sources:

- Project media first and visibly labeled as project media.
- Dev samples hidden by default unless explicit `--dev-samples` mode is active.
- If dev samples are enabled, they must be separated/labeled as dev samples, not mixed into the same undifferentiated list.

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
- The problem is source mixing and unclear project-vs-dev fixture separation.
- Fix should include a UI/API smoke proving normal project mode does not show repo samples unless dev-samples is explicitly enabled.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
