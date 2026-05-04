# Spec 057 — R26: closed-loop noise sweep after annotation/finding save

## Problem

Per R26: agent has to remember to run `archive_phase1_noise` and
`auto_resolve_questions` manually after writing annotations or
routine-findings. Easy to forget. The user feedback request was
"after annotation/semantic conclusion, the file's open-questions
should be re-evaluated automatically."

## Trigger surfaces (v1)

Two tools auto-run the closed-loop sweep on success:

1. **`disasm_prg`** — when an annotations file is consumed, after
   Spec 055 emits routine + segment-reclass findings. Scope = source
   PRG artifact.
2. **`save_finding`** — when the saved finding has any of the tags
   `["routine", "annotation"]` AND a top-level `addressRange`. Scope
   = `finding.artifactIds[0]` (or project-wide if no artifact link).

Deferred per refinement:
- **`propose_annotations`** — writes draft only, no truth landed → skip.
- **`mark_segment_confirmed/rejected`** — would require widening
  `archivePhase1Noise` matcher to read segment flags; separate spec.

## Sweep helper

`service.runClosedLoopSweep({ artifactId? })` composes:
- `archivePhase1Noise({ artifactId })` — when scoped, scope-restricted.
- `sweepQuestionResolutions({ artifactId })`.
- Always also calls both project-wide so the response can show both
  numbers (refinement decision: hybrid C — caller can scope, but
  output shows both scope and project totals).

Catches its own exceptions and returns `{ error }` instead of
throwing — parent op never fails because the closed loop hit a snag.

## Output footer

One line, machine-parseable, brief:

- Scoped: `Auto-archive: archived X findings, answered Y questions [scope=artifact:<id>, project=A/B]`
- Project: `Auto-archive: archived X findings, answered Y questions [scope=project]`
- Failure: `Auto-archive: FAILED — <reason>`

Centralised in `src/server-tools/closed-loop-sweep.ts:runAndFormatClosedLoopSweep(service, opts)`.

## Smoke

- Save routine finding with addressRange + artifact link → footer shows
  `archived 1 findings, answered 1 questions [scope=artifact:..., project=0/0]`
  and the pre-existing hypothesis is `status=archived`.
- Project-wide footer label `[scope=project]`.

## Cross-reference

- Spec 052: question auto-resolution.
- Spec 053: noise archive.
- Spec 055 (R25): emits the routine findings the closed loop matches.
- Spec 056 (R27): scope filter that the closed loop forwards.
- Bug 25: primitive (save_finding.address_range) the routine-tag
  branch depends on.
