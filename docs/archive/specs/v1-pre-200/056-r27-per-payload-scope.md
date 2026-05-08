# Spec 056 — R27: per-payload scope filter for noise sweep tools

## Problem

`archive_phase1_noise` and `auto_resolve_questions` (Spec 053 + 052)
walk the entire project. Output ("47 archived, 51 answered") mixes
contributions from every artifact and gives the agent no per-file
feedback signal. After annotating one PRG, the agent can't tell which
of the closed items came from THIS file's work versus pre-existing
spillover.

## Rule

Both tools accept an optional `artifact_id` parameter. When set, the
sweep restricts to:
- Routines: only routine-tagged findings linked via `artifactIds`.
- Hypothesis candidates: only hypothesis findings linked via
  `artifactIds`.
- Open questions: only questions linked via `artifactIds`.

Routines source is also scoped (per refinement: "scope BOTH"). A
project-wide sweep without `artifact_id` keeps the existing behaviour.

The decision intentionally stays simple — `artifactIds.includes(id)`
only. Address-range overlap with `loadContexts` is a followup; many
projects have sparse loadContexts and the strict check is deterministic.

## API

### Service

```ts
service.archivePhase1Noise({
  dryRun?: boolean;
  artifactId?: string;
}): {
  findingsArchived: number;
  questionsAnswered: number;
  routinesScanned: number;
  preview: Array<{ findingId; title; supersededBy }>;
  scope: "project" | "artifact";
  scopeArtifactId?: string;
};

service.sweepQuestionResolutions({
  artifactId?: string;
}): {
  autoResolved: number;
  pending: number;
  phaseClosed: number;
  scope: "project" | "artifact";
  scopeArtifactId?: string;
};
```

`resolveQuestionsForFinding(findingId, { artifactId? })` gains the
same opt for downstream callers (sweepQuestionResolutions iterates
findings and forwards).

### MCP tools

```
archive_phase1_noise({ project_dir?, dry_run?, artifact_id? })
auto_resolve_questions({ project_dir?, artifact_id? })
```

Output footer surfaces scope: `[scope=artifact:<id>]` line when
scoped; absent for project-wide.

## Smoke

`scripts/sprint46-smoke.mjs` style:
- Two PRGs A + B, each with own routine + hypothesis at $1010.
- Project sweep dry-run: archives 2.
- Artifact-scoped sweep dry-run on A: archives 1, routinesScanned=1,
  scope=artifact.

## Out of scope

- AddressRange ⊂ loadContext fallback for unlinked findings — followup.
- Payload-id resolution (entity → artifact). Caller resolves; tool
  takes only artifact_id (per refinement decision (a)).
- Auto-deriving scope from "last-touched" history — Spec 057 (R26)
  closed-loop sweep handles that automatically.

## Cross-reference

- Spec 052: question auto-resolution — sweepQuestionResolutions consumer.
- Spec 053: noise archive — archivePhase1Noise consumer.
- Spec 055 (R25): emits routine findings that this scope filter
  selects from.
- Spec 057 (R26): closed-loop sweep that auto-passes the just-touched
  artifact_id to these scoped tools.
