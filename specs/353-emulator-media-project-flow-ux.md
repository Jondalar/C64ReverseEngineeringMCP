# Spec 353 — Emulator media and project flow UX

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Depends:** 350, 351

## Goal

Make media selection explicit, project-aware, and safe. The UI should
mount disks/cartridges/snapshots from the active C64RE project folder or
from drag/drop without triggering hidden boot commands.

## Supported media

First pass:

- `.d64`
- `.g64`
- `.crt`
- runtime snapshot files

Tape is out of scope for this UX pass.

## Entry points

The user can mount media by:

- choosing from the active C64RE project media folder;
- choosing from recent media;
- drag/dropping a supported file onto the workbench;
- using explicit Drive 8/Drive 9 controls.

## Mount behavior

- Mounting only mounts.
- It must not type `LOAD"*",8,1`.
- It must not type `RUN`.
- It must not reset unless the user chooses a boot/power-cycle action.
- CRT mount may require a power cycle; the UI must make that explicit.

## UI placement

Media controls are part of Live, not a separate top-level tab.

```text
Media: Drive 8 [motm.g64 ▼] [Mount] [Eject] [Swap]
       Drive 9 [empty    ▼] [Mount] [Eject] [Swap]
       Drop .d64/.g64/.crt/snapshot here
```

Recent files can be a compact popover/list, not a full page.

## Project root policy

All media browsing starts from the active C64RE project root and its
known media folders. The UI must not expose arbitrary server cwd as the
default root.

When a file is selected or dropped:

- show media type;
- show resolved absolute path;
- show target slot/drive;
- show whether reset/power-cycle is recommended or required.

## Acceptance

- Selecting a `.g64` for Drive 8 mounts it without auto LOAD/RUN.
- Dragging a supported file onto Live opens a clear mount target choice.
- Mounting a `.crt` communicates that power cycle may be needed.
- Eject/swap update the drive status and inspector.
- Recent media remains available without a separate Media tab.
