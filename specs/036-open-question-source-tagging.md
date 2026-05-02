# Spec 036: Open-Question Source Tagging + Auto-Resolvable Status

## Problem

`OpenQuestionRecord` has no provenance field. BWC has 1112 open
questions; ~90% are heuristic Phase-1 noise ("ranges $XXXX-$YYYY
classification uncertain"), ~10% are real human / runtime
observations. Users cannot triage without manually reading each
title. REQUIREMENTS R6.

## Goal

Every open question carries a `source` tag and an optional
`autoResolvable` flag. The Questions tab sorts by source and shows a
banner when noise is hidden below the fold. A `project_repair`
backfill operation tags existing untagged questions.

## Approach

### Schema

Extend `OpenQuestionRecordSchema`:

```ts
source: z.enum([
  "heuristic-phase1",
  "human-review",
  "runtime-observation",
  "static-analysis",
  "other",
  "untagged",     // legacy / not yet backfilled
]).default("untagged"),
autoResolvable: z.boolean().optional(),
autoResolveHint: z.string().optional(),  // free-form ("answered when phase 5 reached")
```

`autoResolvable: true` marks a question that the next disasm pass /
phase advance should answer; surfaced separately so the agent
revisits during annotation.

### Auto-tagging by source tool

| Tool | Sets `source` |
|------|---------------|
| `analyze_prg` (heuristic Phase-1 questions) | `heuristic-phase1` |
| `propose_annotations` (Spec 042) | `static-analysis` |
| `headless_*` / `vice_*` trace tools | `runtime-observation` |
| `save_open_question` (default) | `human-review` |

Implementation: each producer passes `source` explicitly when calling
`save_open_question`. The MCP tool description carries the current
default and asks the agent to override.

### UI — Questions tab Option C

The Questions tab default view:

1. Show all questions, sorted by source (human first, runtime,
   static, heuristic-phase1 last).
2. Each row carries a colored badge naming its source.
3. Above the row list, a banner: `847 heuristic-phase1 questions
   shown below the fold. [Filter to focus]` — clicking the link
   pre-fills the existing source filter.

Auto-resolvable rows get a second badge `[auto?]` so the agent
knows to revisit them after the next phase advance.

### `project_repair` backfill operation

New safe-repair operation `backfill-question-source`:

1. Read all questions with `source === "untagged"`.
2. Apply heuristic mapping based on `producedByTool` field if
   present, otherwise on title regex:
   - title contains "classification uncertain" → `heuristic-phase1`
   - title contains "trace" or "observed" → `runtime-observation`
   - title contains "draft" or "auto-suggest" → `static-analysis`
   - rest → `other`
3. Write back with the new source.

Idempotent. Counts surfaced in repair output.

## Acceptance Criteria

- A new question saved by `analyze_prg` carries
  `source: "heuristic-phase1"`.
- A question saved manually via `save_open_question` defaults to
  `source: "human-review"`.
- Existing questions without `source` show as `untagged` in the UI
  until repair is run.
- `project_repair --operation=backfill-question-source` against a
  project with N untagged questions tags all of them and reports
  the per-source counts.
- The Questions tab default view sorts human → runtime → static →
  heuristic-phase1 with the noise banner.

## Tests

- Smoke: write three questions with different sources, assert the
  list endpoint returns them ordered by source priority.
- Smoke: register an untagged legacy question, run the backfill
  repair, assert source is set.

## Out Of Scope

- Auto-promotion of heuristic-phase1 questions to human-review when
  the agent confirms them (manual edit is fine).

## Dependencies

- Spec 006 `project_repair` — extend with new safe-repair op.
- Spec 016 Questions tab — extend filter / sort / banner.
