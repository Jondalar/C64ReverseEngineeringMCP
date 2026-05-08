# Spec 032: Build Pipeline As Registered Workflow Artifact

## Problem

Port and crack projects often have a meaningful build pipeline:
assemble sources, patch extracted files, pack payloads, build CRT,
verify byte-exactness, compare hashes, reserve banks. Accolade
Comics' EF port runs `ef_build.sh`, `ef_pack.py`, `ef_build_crt.py`.
C64RE registers outputs but the pipeline itself is opaque: stale
outputs go unnoticed, step provenance is implicit. REQUIREMENTS R24.

## Goal

Express the build pipeline as ordered structured steps with explicit
inputs, outputs, expected hashes, and verification. Detect stale
outputs when inputs change. Optionally orchestrate the pipeline
through a single MCP tool that records each step.

## Approach

### Schema

```ts
interface BuildPipeline {
  id: string;
  title: string;
  description?: string;
  steps: BuildStep[];
  tags: string[];
}

interface BuildStep {
  id: string;
  title: string;
  command: string;             // shell or MCP tool reference
  cwd?: string;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  expectedOutputHashes?: Record<string, string>;
  byteIdentityCheck?: { artifactId: string; against: string };
  sideEffects?: string[];      // free-form notes
  evidence?: EvidenceRef[];
}

interface BuildRun {
  id: string;
  pipelineId: string;
  startedAt: string;
  completedAt?: string;
  steps: Array<{
    stepId: string;
    status: "pending" | "running" | "ok" | "failed" | "skipped";
    exitCode?: number;
    stdoutTail?: string;
    stderrTail?: string;
    actualOutputHashes?: Record<string, string>;
    durationMs?: number;
  }>;
  status: "running" | "ok" | "partial" | "failed";
}
```

Storage: `knowledge/pipelines/<id>.json`,
`knowledge/build-runs/<runId>.json`.

### MCP tools

- `save_build_pipeline(...)` / `list_build_pipelines(...)`.
- `run_build_pipeline(pipeline_id, dry_run?, only_steps?: string[])`
  — execute steps in order, capture hashes, register output
  artifacts, persist a `BuildRun`.
- `compare_build_runs(baseline_run_id, candidate_run_id)` — diff
  hashes, exit codes, durations.
- `mark_step_skipped(run_id, step_id, reason)` — manual override.

### Stale detection

`project_audit`:

- For each pipeline, compare current input artifact hashes to the
  hashes recorded in the latest successful run. If any differ,
  surface `stale-output` warnings on the affected output artifacts.
- Detect orphan outputs (artifact no input still references) and
  suggest re-running the responsible step.

### Output registration

Every produced output is registered as an artifact via Spec 025
lineage (`derivedFrom: <step.inputArtifactIds[0]>` when applicable).
The pipeline is itself an artifact (`kind: "report"`,
`role: "build-pipeline"`).

### UI

Pipelines tab:

- Pipeline list with last-run status.
- Pipeline detail: ordered steps with input/output artifact links,
  hashes, last-run status.
- Run detail: per-step exit code, stdout/stderr tail, duration.

## Acceptance Criteria

- Accolade's EF build can be represented as a 5-step pipeline with
  inputs, outputs, and expected hashes.
- `run_build_pipeline` end-to-end produces a `BuildRun` with all
  steps recorded; output artifacts appear in the lineage view.
- Modifying an input artifact and re-running the audit reports
  affected output artifacts as stale.

## Tests

- Smoke: define a 2-step pipeline against the fixture project
  (assemble + verify), run it, assert outputs registered with the
  expected hashes.
- Smoke: change input bytes and assert audit reports stale.

## Out Of Scope

- Parallel step execution.
- Distributed builds.
- DAG scheduling beyond linear ordering (good enough for
  C64-scale projects).

## Dependencies

- Sprint 22 (Spec 025) — lineage for output registration.
- Sprint 27 (Spec 027) — patches as a step kind.
- Sprint 29 (Spec 029) — constraint checker can run as a verify
  step.
