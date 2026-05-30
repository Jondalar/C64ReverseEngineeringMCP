# Bug: Disk file list scrolls the whole page instead of the list panel

- **ID:** BUG-009
- **Date:** 2026-05-30
- **Reporter:** human
- **Area:** ui-v3
- **Severity:** medium
- **Status:** open

## Environment

- Branch / commit: b65943c
- Surface: ui-v3
- Project dir: `/Users/alex/Development/C64/Cracking/Die Dunkle Dimension`
- Tool / endpoint / tab: Disk tab, `http://127.0.0.1:4310/`

## What happened

In the Disk view, the file list is long. Scrolling over the file list scrolls the whole page / UI instead of scrolling only the list panel. This makes the Disk view hard to use because the header/tabs and surrounding layout move while trying to inspect disk entries.

## Expected

The disk file list should be its own scroll container. Scrolling inside the list should keep the surrounding UI stable and only move the entries inside the list panel.

Expected layout behavior:

- The Disk view panel remains stable.
- The file list has a bounded height.
- The file list uses local vertical scrolling.
- The page/body should not scroll when the pointer is over the file list unless the list is already at its boundary and deliberate overscroll behavior is desired.

## Repro steps

1. Open the v3 UI for the DDD project.
2. Go to the Disk tab.
3. Place the pointer over the left disk file list.
4. Scroll down.
5. Observe that the whole page scrolls instead of only the file list.

Minimal command / call:

```text
UI action: mouse-wheel / trackpad scroll over the disk file list in the Disk view.
```

## Evidence

- Error / output (verbatim):

```text
die File liste scroll das ganze UI mit, das soll aber nur in der Liste scrollen.
```

- Browser evidence:

```text
Current URL: http://127.0.0.1:4310/
Visible tab: Disk
Visible file list: DDD disk directory entries on the left
Observed behavior: scrolling the file list moves the entire UI/page.
```

- Artifacts: user-provided browser screenshot in Codex thread, 2026-05-30.

## Scope guess (optional)

Disk tab CSS/layout. The file list container likely lacks fixed/max height + `overflow-y: auto`, or a parent layout allows body/page scrolling instead of contained panel scrolling.

## Notes / follow-up

- Fix should be covered by a UI smoke or CSS/layout assertion if practical.
- Related to usability of multi-entry disk inspection, but separate from BUG-008 tab selection.

---

## Resolution (fill on fix)

- **Root cause:**
- **Fix commit:**
- **Gate proving the fix:**
- **Regression risk:**
