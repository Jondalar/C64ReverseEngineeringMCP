# Spec 061 — UX3: Questions tab bulk re-evaluation via task queue

## Problem

Questions tab on Murder shows 570 open questions, of which 66
match the user's filter (open + static-analysis). The user wants
to ask the LLM agent to re-evaluate that selection against the
current state of findings + annotations and auto-close the
unambiguous ones — as a single bulk action from the UI.

The current UI offers Defer / Invalidate / Reopen / Set priority as
bulk actions but no "re-evaluate" path. The LLM Task button exists
only per single question.

## Decision

Bulk re-evaluation runs in two combined phases:

1. **Deterministic sweep first** — `archivePhase1Noise` +
   `sweepQuestionResolutions` scoped to the selection's linked
   artifacts. Cheap, fast, picks up everything the matchers can
   already prove. (Mode "a".)
2. **LLM prüfung per remaining question** — for everything the
   sweep didn't close, the agent reads the question + linked
   finding + relevant ASM section + decides one of four outcomes.
   (Mode "b".)

The user does NOT trigger the LLM phase from the UI directly.
The UI POSTs a task into the project task queue; the agent picks
it up via the existing `c64re_whats_next` polling pattern. This
matches the user's broader workflow vision:

> "Claude initialisere das Projekt" → "Starte das UI" → "Polle alle
> 30 Sekunden ob es ein Todo gibt aus dem UI"

## Granularity

One bulk action = one task, regardless of selection size. The
agent decides internally whether to split across worker subagents
(Spec 035) for parallelism. Prevents task-queue flooding.

Task fields:
- `title`: `Re-evaluate N open questions`
- `description`: structured prompt (see "Task description template")
- `artifactIds`: union of linked artifacts across the selection
- `priority`: medium (UI dropdown can override before submit)
- `tags`: `["bulk-revaluate", "ui-triggered"]`
- `kind`: `"automation"` (new task kind to distinguish from human TODOs)

## Per-question outcome state machine

Four outcomes, mapped to existing `OpenQuestionRecord` statuses:

| Outcome | Status | Extra |
|---|---|---|
| `answered` | `answered` | `answeredByFindingId` + `answerSummary` |
| `invalidated` | `invalidated` | `answerSummary` (why bullshit) |
| `researching` | `researching` | extend `description` with what to look at next |
| `still-open` | `open` (no change) | — |

`defer` is intentionally NOT an automated outcome — it's a user
lifecycle action for "irrelevant for current workflow".

The agent calls `agent_record_step` at the end with the bilanz
("12 answered, 4 invalidated, 18 researching, 32 still-open") so
the timeline + Dashboard reflect what the bulk-eval achieved.

## Task description template

```
Bulk re-evaluation of <N> open questions.

Phase 1 (already executed by the deterministic sweep):
  - archive_phase1_noise(artifact_id=<scoped>)
  - auto_resolve_questions(artifact_id=<scoped>)
  After phase 1, <K> questions remain open. Continue with phase 2.

Phase 2 (your work):
  For each of these question IDs:
    [<id-1>, <id-2>, ..., <id-K>]

  1. list_open_questions(filter to id) and read its title +
     description + linked findings + linked artifacts.
  2. Read the relevant ASM section (read_artifact on the linked
     listing) + the linked annotations file (when present).
  3. Decide ONE outcome:
       - "answered" — covered by a finding / annotation; close it
         via save_open_question(status="answered",
                                answeredByFindingId=<finding-id>,
                                answerSummary="<one sentence>")
       - "invalidated" — was bullshit / hallucination;
         save_open_question(status="invalidated",
                            answerSummary="<why>")
       - "researching" — needs deeper analysis; save_open_question
         (status="researching") and append a brief next-step note
         to its description.
       - "still-open" — leave unchanged.

  4. After all K processed, call agent_record_step with the bilanz:
       "Bulk re-eval done: X answered, Y invalidated,
        Z researching, W still-open."
       Include the original task id in the step description so
       the UI can mark the task complete.

Constraints:
  - Use only the four outcomes above. Do not change priority,
    tags, or other fields.
  - If a question's linked finding is itself ambiguous, prefer
    "researching" over guessing "answered".
  - If a question has no addressRange + no linked finding +
    no clear context, "invalidated" is appropriate.
```

## UI surfacing

Four overlapping affordances:

1. **Toast on submit**: "Re-evaluation queued for N questions"
   (5s auto-dismiss).
2. **Dashboard task tile**: persistent card showing active bulk
   re-eval tasks with question count, kicked-off time, and a
   `Cancel` action that flips task status to `blocked`.
3. **Per-question pending badge**: each question whose id appears
   in any active bulk-revaluate task renders a subtle `re-eval
   pending` icon. Disappears when the question's `updatedAt`
   becomes newer than the task's `createdAt` (i.e. the agent
   touched it).
4. **Auto-poll**: when at least one bulk-revaluate task is active,
   the UI polls `/api/tasks/active-bulk` every 30s + refreshes
   `/api/open-questions`. No polling when no bulk task is active.

Server endpoints:
- `POST /api/tasks/bulk-revaluate` — creates the task; body
  carries `{ questionIds: string[], priority?: string, scopeArtifactIds?: string[] }`.
- `GET /api/tasks/active-bulk` — returns all tasks with
  `tags.includes("bulk-revaluate")` AND `status in ("open",
  "in_progress")`.

## Schema add

`TaskRecord`:
- `kind: "human" | "automation"` (default `"human"`). Existing tasks
  default `human`; the bulk action saves `automation`.

`OpenQuestionRecord`: no schema change — uses existing `status`
transitions.

## Out of scope

- Cost-tracking / token budgets for the agent's LLM phase. The
  agent runs in the user's existing MCP host with their own context
  budget. UI shows progress, not cost.
- "Deep re-evaluate" mode where the agent is allowed to also
  emit new annotations / findings beyond the four outcomes.
  Refinement: that is a separate workflow ("deep analyse
  selection") with its own task kind.
- Cross-project bulk re-eval. Scope stays per-project.

## Cross-reference

- Spec 035: Master/Worker pattern. Agent may spawn workers from
  inside the bulk task if it chooses to parallelise.
- Spec 052: question auto-resolution. Phase 1 of this spec calls
  the same sweep helper.
- Spec 053: noise archive — same.
- Spec 057 (R26): closed-loop sweep — phase 1 reuses the
  scope-restricted sweep.
- Spec 044 (codemcp pattern): `c64re_whats_next` permanent nudger.
  This spec relies on that polling cycle.
- UX1 (Spec 059): view-centric tabs — Questions tab survives. The
  bulk action button lands inside that tab.
