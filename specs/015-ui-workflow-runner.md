# Spec 015: UI-Driven PRG Reverse Workflow

## Problem

`run_prg_reverse_workflow` (Sprint 2) is callable from the agent but
not from the workspace UI. The user has to drop into the agent to
disassemble a PRG, even when they are already viewing the project in
the UI. The "integrated UI" goal is undercut.

## Goal

A user looking at a PRG artifact in the workspace UI can launch the
full reverse-engineering workflow with one click and watch the result
roll into the same dashboard counts, audit, and views.

## Scope

### Backend

- Extract the workflow body from
  `src/server-tools/analysis-workflow.ts` into a reusable function in
  `src/lib/prg-workflow.ts`:
  ```ts
  runPrgReverseWorkflow(opts: {
    projectRoot: string;
    prgPath: string;
    mode?: "quick" | "full";
    outputDir?: string;
    rebuildViews?: boolean;
    entryPoints?: string[];
  }): Promise<PrgReverseWorkflowResult>
  ```
- Both the MCP tool and the workspace UI server consume the function;
  they only handle parameter parsing, knowledge registration callbacks,
  and presentation.
- Add `POST /api/run-prg-workflow` to the workspace UI server.
  Body matches the function options. Returns the result envelope.

### UI

- Add a `Run reverse workflow` button to the PRG file inspector and
  to PRG-typed entries in the disk file inspector.
- While running, show a busy state.
- When done, show a result summary card (status, imported counts,
  artifacts written, next required step) and refresh the workspace
  snapshot so dashboard counts and audit reflect the new state.

## Acceptance Criteria

- Clicking `Run reverse workflow` on a PRG produces analysis JSON,
  ASM, optional reports, registers them, and rebuilds views — same
  side effects as the MCP tool.
- Workflow failures show the structured error envelope from
  `safeHandler` rather than a generic alert.
- The button is hidden / disabled for non-PRG artifacts.

## Tests

- UI typecheck.
- Smoke (optional): a small script that POSTs to
  `/api/run-prg-workflow` against a temp project with a synthetic
  PRG and asserts the response envelope.

## Out Of Scope

- Streaming progress updates over websocket.
- Annotation editing in the UI.
