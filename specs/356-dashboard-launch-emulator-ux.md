# Spec 356 — Dashboard launches Emulator Workbench

**Sprint:** UX V3 refresh
**Status:** PROPOSED 2026-05-09
**Depends:** 350

## Goal

Connect the existing C64RE Analysis Dashboard to the dedicated Emulator
Workbench without merging both products into one page.

The dashboard answers: what do we know about this project?
The emulator answers: what is the machine doing right now?

## Dashboard action

Add one visible action to the project/dashboard header:

```text
[C64 Emulator]
```

It opens the Emulator Workbench in a new browser tab/window.

## Routing

Preferred route:

```text
/emulator?projectId=<id>
```

Temporary route allowed while routing is simple:

```text
/v3.html?project=<absolute-or-encoded-project-path>
```

The emulator must resolve the active C64RE project root from the route
or backend session, not from server cwd.

## Context handoff

The dashboard passes:

- project root/id;
- known media folders;
- current project name;
- optional preferred session id;
- optional selected artifact/finding context for future use.

The emulator initializes:

- media browse roots from the project;
- project-aware monitor file command roots;
- Explore artifact writes into the same project store.

## Non-goals

- Do not embed the emulator inside the dashboard card layout.
- Do not move Knowledge/Findings/Memory Map into the emulator.
- Do not expose scenario/export workflows through this launch action.

## Acceptance

- Dashboard exposes `C64 Emulator`.
- Clicking it opens the emulator with the current project context.
- Emulator media selection starts in the project media roots.
- Monitor file commands and Explore artifact writes use the same project
  root.
