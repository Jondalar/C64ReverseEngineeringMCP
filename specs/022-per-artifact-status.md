# Spec 022: Per-Artifact Workflow Status

## Problem

Workflow phases (`structural-enrichment`, `semantic-enrichment`, …)
are project-global. A phase flips to `completed` as soon as any
single artifact has been processed, hiding the long tail of
unfinished work. Users have no per-PRG view of what is done. The
audit warns about unimported analysis-runs but does not auto-fix
them. REQUIREMENTS R1, R5, R13. BUGREPORT Bug 16. Process P1.

## Goal

Define an explicit per-artifact "done" checklist, surface it in the
UI as a status badge per PRG, sortable on the dashboard. Auto-import
analysis-runs on `agent_onboard` so the dashboard never trails the
disk state.

## Approach

### Done checklist

For PRG / payload artifacts:

| Step | Tool | Done when |
|------|------|-----------|
| 1. analyze | `analyze_prg` | `*_analysis.json` exists, run imported |
| 2. disasm pass 1 | `disasm_prg` (no annotations) | listing artifact registered |
| 3. annotations | LLM-authored `*_annotations.json` | file exists on disk |
| 4. disasm pass 2 | `disasm_prg` with annotations | listing rebuilt |
| 5. rebuild byte-identical | `assemble_source --compare_to` | rebuild verification ok |
| 6. linked finding | `save_finding(artifactIds: [...])` | ≥1 finding references the artifact |

Other artifact kinds (cart chunks, raw blobs) reuse steps 1-6 with
the payload-centric workflow.

### Endpoint

`GET /api/per-artifact-status?projectDir=...` returns:

```ts
{
  items: Array<{
    artifactId: string;
    title: string;
    platform?: string;
    steps: Array<{ name: string; status: "done" | "pending" | "blocked"; reason?: string }>;
    completionPct: number;
    qualityMetrics?: {
      bytesByKind: Record<SegmentKind, number>;
      avgConfidence: number;
      namedLabelRatio: number;
    };
  }>
}
```

### Auto-import on onboard

In `agent_onboard`:

1. Walk artifacts of role `prg-analysis` (or any `analysis-run`).
2. For each with `imported: false` (or no corresponding entities in
   the knowledge store), run `bulk_import_analysis_reports` once.
3. Stop `disasm_prg` from re-registering the analysis-run artifact —
   it is a consumer, not a producer.

### UI

- Dashboard: per-PRG row gets a step badge (✓✓✓⨯⨯⨯), completion %,
  and quality score columns. Sortable.
- Click badge → artifact detail with the step list and the next
  required action button.
- Disk-layout / payloads tabs reuse the badge.

### Quality metrics (R13)

Computed at view-build time from the analysis JSON: bytes per
SegmentKind, average segment confidence, ratio of named labels
(annotated) to raw `Wxxxx` labels.

## Acceptance Criteria

- The fixture project shows 6/6 steps complete after the bootstrap
  script runs.
- The Murder project shows 4/6 or 5/6 per PRG (no annotations
  authored yet) and is sortable by completion.
- After `agent_onboard`, the audit no longer reports "N analysis-run
  artifacts registered but never imported".

## Tests

- Smoke: bootstrap fixture, assert per-artifact status endpoint
  returns exactly one row with `completionPct = 100`.
- Smoke: stage a project with a fresh analysis-run and `imported:
  false`, run `agent_onboard`, assert `imported: true` afterwards.

## Out Of Scope

- Cracker-vs-analyst role-specific checklists (P2/P3, backlog).
- Auto-generating annotation drafts (R15, backlog).

## Dependencies

- Sprint 18 (knowledge tabs) for the evidence cross-link path
  reused in the artifact detail view.
