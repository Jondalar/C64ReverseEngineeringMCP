# Spec 005: Open Questions UI

Status: dashboard click-through and question inspector fallback are
implemented. Status-changing actions are pending.

## Problem

The dashboard shows open questions in the "Current Work" panel, but
clicking them currently does not change context. That makes the UI feel
broken because tasks beside them are actionable.

## Current Behavior

Tasks are rendered as buttons and select a linked entity. Open questions
are rendered as static cards. They look like work items but do not offer
inspection, navigation, or resolution.

## Desired Behavior

Open questions should become first-class work items.

Clicking a question should:

- select its linked entity if one exists
- otherwise select its linked finding if one exists
- otherwise open a question detail panel in the inspector
- highlight related artifacts when available

The inspector should show:

- title
- status
- priority
- confidence
- summary
- linked entities/findings/artifacts
- created/updated timestamps
- available actions: answer, invalidate, defer, create task

## View Model Needs

The dashboard question refs currently carry too little context. Add or
expose enough data for selection:

- `question.id`
- `entityIds[]`
- `findingIds[]`
- `artifactIds[]`
- `status`
- `priority`
- `summary`

If the dashboard view should stay compact, the UI can resolve details
from `snapshot.openQuestions`.

## Acceptance Criteria

- Every visible open-question card is clickable.
- Clicking a question always changes visible UI state.
- A question without links still opens a detail view.
- Questions with answered/invalidated status do not appear in the open
  dashboard list unless explicitly filtered.
- The cursor and card styling communicate actionability.

## Tests

- UI typecheck.
- Add a browser or component smoke test for:
  - question linked to entity
  - question linked only to finding
  - question with no links
