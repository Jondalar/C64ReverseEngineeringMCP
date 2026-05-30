# Bug: Disk tab selection jumps back to first disk

- **ID:** BUG-008
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** high
- **Status:** fixed

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

## Resolution

- **Root cause:** in `DiskPanel` (`ui/src/components/workspace-panels.tsx`), the effect that syncs the active disk to the GLOBAL selection (`selectedDiskFile` prop) kept `activeDiskId` in its dependency array and unconditionally ran `if (activeDiskId !== disk.artifactId) setActiveDiskId(disk.artifactId)`. Clicking a different disk tab updates the LOCAL `activeDiskId` first; the global prop still pointed at the previous disk, so the effect re-ran and forced `activeDiskId` back to the prop's (old) disk — the jump-back. The local click could never win.
- **Fix:** the sync effect now guards on a `lastSyncedSelectionRef` (the `diskArtifactId:fileId` key it last applied) and depends only on `[disks, selectedDiskFile]` — not `activeDiskId`. It applies an external selection exactly once when that selection genuinely changes, and never fights a local tab click. The disk-tab `onClick` additionally routes the new disk's first file via `onSelectDiskFile`, so the inspector follows the switch (the ref-guard prevents that global update from bouncing the active disk back).
- **Fix commit:** _this commit_.
- **Gate proving the fix:** `npm run smoke:bug008-009` checks 1-4 — the ref-guard exists, the sync effect does NOT depend on `activeDiskId` (regression guard), it still follows external `selectedDiskFile` changes, and the tab click routes the selection. v1 + v3 build green; ui typecheck 13 pre-existing / 0 new.
- **Regression risk:** low — selection logic only; external-selection following preserved; component shared by v1 + v3.
