# Spec 016: Open Questions Tab With Batch Operations

## Problem

Sprint 3 surfaced individual open questions in the dashboard "Current
Work" panel. On real projects (e.g. BWC Reverse with 1112 open
questions) that view collapses into noise: only the first three are
visible, there is no filter / sort / batch tool, and triaging is
impossible from the UI.

## Goal

A dedicated `Questions` tab that lets a human triage hundreds of open
questions efficiently:

- list all open questions with kind / priority / confidence / status
- text search on title and summary
- filter by status, priority, kind, and linked entity
- sort by confidence, priority, updatedAt
- multi-select rows
- batch actions: Defer N, Invalidate N, set priority, link to a chosen
  task, jump to inspector for single rows

The single-question detail view from Sprint 3 stays as the inspector
for one selection.

## Backend

Add a single batch endpoint:

```
POST /api/open-question/batch
{
  projectDir,
  ids: string[],
  patch: {
    status?: "open" | "researching" | "answered" | "invalidated" | "deferred";
    priority?: "low" | "medium" | "high" | "critical";
    answerSummary?: string;
  }
}
```

The endpoint resolves each id, applies the patch via
`saveOpenQuestion(id, ...)`, and returns the count of updated records
plus per-id errors.

`POST /api/open-question` (single) keeps its current shape.

## UI

- Add `questions` to the `TabId` enum and to the visible tab list.
- New `QuestionsPanel` component:
  - top toolbar: search input, status filter pills, priority filter
    pills, kind filter (free text), sort dropdown, count summary.
  - row list (virtualised list for >200 entries; flat list otherwise)
    with checkbox, title, kind, priority, confidence, updatedAt.
  - selection bar appears when ≥1 row checked: `Defer N`,
    `Invalidate N`, `Set priority`, `Open inspector`.
  - clicking a row title opens the existing `QuestionInspector`.
- Reload the workspace snapshot after a batch operation succeeds.

## Acceptance Criteria

- Switching to the `Questions` tab on a project with 1000+ open
  questions renders fast and stays responsive.
- Multi-select + Defer N marks all selected questions as `deferred`
  with one HTTP round-trip.
- Filters and search reduce the visible set without re-fetching.
- The batch endpoint reports per-id failures; the UI shows them in an
  error block but keeps the successful updates.

## Tests

- UI typecheck.
- Smoke (optional): post 5 ids to `/api/open-question/batch` against a
  temp project, assert 5 updates and a clean error list.
- Manual browser verification on BWC Reverse: filter to a kind,
  multi-select 20 rows, defer them, refresh, confirm count drop.

## Out Of Scope

- Bulk creation of new questions.
- Cross-project question search.
- Linking the same patch to questions belonging to different
  projects.
