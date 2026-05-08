# Spec 014: Audit / Repair Workspace UI Panel

## Problem

`project_audit` and `project_repair` exist as agent-side MCP tools, but
the workspace UI does not surface them. Humans using the UI cannot see
when the project is fragmented, has stale views, or is missing
imports — and cannot trigger repair without dropping into the agent.

The plan calls for an integrated UI where the same audit/repair signal
the agent uses is also a first-class affordance for the human.

## Goal

Add a dashboard panel that:

- shows the current `auditProjectCached` result (severity, counts,
  findings) without forcing the user to wait on a fresh audit
- offers an explicit "audit fresh" button that calls the uncached
  endpoint
- offers a "dry-run repair" button that previews planned operations
- offers a "safe repair" button (with confirm dialog) that runs the
  non-destructive repair and refreshes the snapshot

## Backend Endpoints

Add to `src/workspace-ui/server.ts`:

- `GET /api/audit?projectDir=<path>&fresh=1`
  - Default reads cache; `fresh=1` forces uncached audit.
  - Returns `{ audit: ProjectAuditResult, cacheStatus, cachedAt }`.

- `POST /api/repair`
  - Body: `{ projectDir, mode: "dry-run"|"safe", operations?: string[] }`.
  - Returns the same shape as `repairProject` plus `audit` after the
    run (re-uses existing logic).

Both endpoints reuse the existing project-dir resolution and project
service.

## UI Changes

In `ui/src/App.tsx`:

- Add an `AuditPanel` component shown in the dashboard.
- Render severity, counts, top findings (max 5) with their suggested
  fix lines.
- Buttons: `Refresh audit`, `Dry-run repair`, `Run safe repair`.
- Repair output: render `planned`, `executed`, `skipped` lists in a
  collapsible block.
- After a safe repair, refresh the workspace snapshot.

`ui/src/types.ts` mirrors the audit/repair return shapes used by the
panel.

## Acceptance Criteria

- Opening the dashboard on a project with stale views shows a
  "stale-views" finding without an explicit refresh.
- Clicking "Run safe repair" on the same project rebuilds views and
  the panel reports the new state (`severity`, `staleViews=0`).
- Auditing a clean project shows `severity: ok` and offers no repair.
- The audit endpoint defaults to the cached audit; `fresh=1` always
  recomputes.

## Tests

- UI typecheck.
- Manual browser verification: stale-views project, fragmented
  knowledge, clean project.
- Smoke (optional): a small script that hits `/api/audit` and
  `/api/repair` against a temp project.

## Out Of Scope

- Per-finding fix actions in the UI (handled by the agent for now).
- Inline merge-conflict resolution UI for `merge-fragments`.
