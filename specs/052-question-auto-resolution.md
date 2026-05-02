# Spec 052: Auto-Resolution Of Open Questions

## Problem

Sprint 36 added `OpenQuestion.autoResolvable` and a free-form
`autoResolveHint`. Sprint 38 (propose_annotations) emits
`source: "static-analysis"` questions with `autoResolvable: true`.
But nothing actually resolves them — they stay open until a human
manually marks them answered, even when the answering finding /
annotation has already been written.

## Goal

Three resolution paths run automatically:

- **A — Finding answers Question:** `save_finding(entityIds: [X])`
  triggers a check: are there open auto-resolvable questions whose
  `entityIds` overlap? High-confidence match → auto-close, low →
  propose pending-resolution.
- **B — Phase-Reached resolves Question:**
  `agent_advance_phase(artifactId, toPhase)` triggers: any
  question whose `autoResolveHint = { kind: "phase-reached",
  artifactId, phase }` with `phase ≤ toPhase` → auto-close.
- **C — Annotation-Applied resolves Question:** Spec 051 save
  endpoint (or `disasm_prg` with annotations as catch-up) triggers:
  questions whose hint targets the annotated address range → close.

## Schema

`OpenQuestion.autoResolveHint` becomes structured (was free-form):

```ts
autoResolveHint?: 
  | { kind: "phase-reached"; artifactId: string; phase: 1|2|3|4|5|6|7 }
  | { kind: "finding-with-entity"; entityId: string }
  | { kind: "annotation-applied"; artifactId: string; address?: number }
  | { kind: "free-form"; note: string };  // legacy migration
```

Existing string `autoResolveHint` field stays for backwards
compatibility — wrapped as `free-form` kind during read.

`OpenQuestion.status` enum adds `resolution-pending` value.

## Resolution Logic

### Pfad A — Finding answers Question

In `service.saveFinding(input)` (after the save persists):

1. Walk open questions where `autoResolvable === true` AND
   `entityIds` shares at least one id with the new finding.
2. For each match, compute confidence:
   - finding.confidence ≥ 0.85 AND finding.entityIds.length === 1
     AND question.entityIds.length === 1 → auto
   - Otherwise → propose
3. Auto: status `answered`, `answeredByFindingId`, `answerSummary
   = finding.summary`.
4. Propose: status `resolution-pending`, attach evidence note
   referencing the proposing finding.

### Pfad B — Phase-Reached resolves Question

In `service.advanceArtifactPhase(artifactId, toPhase)` (after the
phase update persists):

1. Walk questions with `autoResolveHint = { kind: "phase-reached",
   artifactId, phase ≤ toPhase }`.
2. Auto-close all matches (no propose step — phase reaching is
   unambiguous).

### Pfad C — Annotation-Applied resolves Question

In Spec 051 save endpoint (or after `disasm_prg` runs with
annotations as catch-up sweep):

1. Walk questions with `autoResolveHint = { kind:
   "annotation-applied", artifactId }` matching the annotated
   artifact.
2. If hint specifies an `address`, only close when an annotation
   covers that address. Otherwise close all matching.

### Periodic sweep

`agent_onboard` runs `service.sweepQuestionResolutions()` —
re-checks all auto-resolvable questions across the three paths.
Catches any that were missed (e.g. tool called outside the in-band
hooks).

## Project profile flag

`projectProfile.questionAutoResolveMode?: "auto" | "propose-only"`
(default `"auto"`). When `propose-only`, every match becomes
`resolution-pending` regardless of confidence — user always
confirms.

## MCP Tools

- `propose_question_resolutions(scope?)` — read-only; lists what
  the resolver would do without writing. Useful before flipping
  `auto`.
- `auto_resolve_questions(threshold?)` — runs the sweep and
  applies; threshold overrides the default 0.85.
- `confirm_question_resolution(question_id, accept)` — for
  resolution-pending questions; `accept=true` → `answered`,
  `accept=false` → back to `open` with rejection note.

## Acceptance Criteria

- A finding saved against an entity whose only open question is
  high-confidence auto-resolvable → question closes with
  `answeredByFindingId` set.
- Same finding but confidence 0.5 → question gets `resolution-pending`.
- Advancing artifact to phase 5 closes all `phase-reached` hints
  with `phase ≤ 5`.
- `confirm_question_resolution(id, false)` flips the question
  back to `open`.

## Tests

- Smoke: 3 questions (one for each pfad) + matching trigger,
  assert correct status transitions.
- Smoke: `propose-only` mode forces every match to pending.

## Out Of Scope

- Cross-project resolution (project-local only).
- LLM-driven resolution suggestions (heuristic match only in v1).

## Dependencies

- Spec 036 OpenQuestion source/autoResolvable.
- Spec 022 phase model (autoResolve via phase-reached).
- Spec 051 annotation save endpoint (autoResolve via
  annotation-applied) — graceful no-op if Spec 051 not yet built.
