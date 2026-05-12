# Spec 352 — Emulator monitor VICE compatibility UX

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Depends:** 350, 351

## Goal

The monitor is a real console, not a form. First pass must prioritize
VICE monitor compatibility so existing muscle memory works.
C64RE-specific commands may be added later, but must not replace or
conflict with VICE syntax.

## Placement

Normal mode:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Monitor                                                       [max]         │
│ output/history                                                               │
│ > input                                                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

- Monitor sits below the C64 screen/inspector in Live.
- It has a useful fixed/min height and scrollback.
- Input line remains visible at the bottom.

Maximized mode:

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Monitor                                                [restore] [close]    │
├────────────────────────────────────────────────────────────────────────────┤
│ large scrollback / command output                                           │
│ > input                                                                      │
└────────────────────────────────────────────────────────────────────────────┘
```

- `[max]` opens a large overlay suitable for longer debugging sessions.
- `[restore]` returns to embedded mode without losing scrollback/input.

## Required VICE syntax groups

Execution:

- `g`
- `step`
- `next`
- `finish` / `ret`
- `until`
- `reset`

Registers:

- `r`
- `registers`
- `cpu`

Memory inspect/edit:

- `m`
- `mem`
- `d`
- `disass`
- `>`
- `fill`
- `compare`
- `hunt`

Breakpoints/watchpoints:

- `bk`
- `break`
- `watch`
- `trace`
- `delete`
- `enable`
- `disable`
- `condition`

File / memory transfer:

- `dump`
- `undump`
- `load`
- `save`
- `bload`
- `bsave`

Address spaces / devices:

- `c:`
- `8:`
- `9:`
- `io:`
- `ram:`
- `rom:`

## File command policy

All file commands resolve paths through the active C64RE project root,
not through server process cwd.

- `dump` / `undump` handle monitor/runtime state as VICE-compatible as
  the runtime allows.
- `load` / `save` operate on C64 memory ranges and files.
- `bload` / `bsave` are binary and must preserve explicit load/start
  addresses.
- After any write (`dump`, `save`, `bsave`) the UI shows the resolved
  absolute path.
- No silent overwrite unless the command syntax explicitly requests
  force/replace.

## Output

- Output should be VICE-like where possible.
- Errors should identify the command, bad argument, and accepted syntax.
- Command history supports arrow up/down.
- Copying selected monitor output should work as normal browser text.

## Acceptance

- `m c000 c0ff` renders a memory dump.
- `d 4000` renders disassembly.
- `r` renders registers.
- `bk e5cf` creates a breakpoint and inspector reflects it.
- `dump`, `undump`, `load`, `save`, `bload`, and `bsave` are accepted
  commands with project-root path resolution.
- Maximizing/restoring monitor preserves scrollback and input history.
