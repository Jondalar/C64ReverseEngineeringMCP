# Bug: Disk tab selection jumps back to first disk

- **ID:** BUG-008
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** high
- **Status:** open

## Environment

- Branch / commit: b65943c
- Surface: ui-v3
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Disk tab, `http://127.0.0.1:4310/`

## What happened

In the v3 Disk view, clicking the second disk tab (`Die_Dunkle_Dimension_Golden Disk 64 (05) (Side 2).d64`) briefly selects or focuses it, then the UI immediately jumps back to the first disk tab.

## Expected

Selecting a disk tab must be stable. Clicking Side 2 should keep Side 2 selected and show Side 2's file list, disk geometry, and inspector details until the user selects another disk.

## Repro steps

1. Open the v3 UI for the DDD project.
2. Go to the Disk tab.
3. Click `Die_Dunkle_Dimension_Golden Disk 64 (05) (Side 2).d64`.
4. Observe that selection jumps back to Side 1.

Minimal command / call:

```text
UI action: click the Side 2 disk tab in the Disk view.
```

## Evidence

- Error / output (verbatim):

```text
wenn ich hier hin klicke, springt er sofort zurück auf die 1. Disk
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Target: "Die_Dunkle_Dimension_Golden Disk 64 (05) (Side 2).d64"
Target selector: section.workspace-main > section.panel-card > div.disk-tab-strip:nth-of-type(2) > button.tab-button:nth-of-type(2)
Visible selected tab after interaction appears to be Side 1 again.
```

- Artifacts: user-provided marked browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

Likely v3 Disk tab local state / selected disk key instability, or view refresh resetting selection to the first disk after render/data reload.

## Notes / follow-up

- This blocks multi-disk project inspection.
- Fix should be covered by a UI smoke that selects Side 2 and verifies selected disk remains Side 2 after the next render/data refresh.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
