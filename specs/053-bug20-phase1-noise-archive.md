# Spec 053: Phase-1 Noise Archive (Bug 20 fix)

## Problem

Murder project after a full Phase-1+2 run: 1203 active findings,
570 open questions, 126 sprite segments still "unconfirmed". The
Phase-1 heuristic produces hundreds of `hypothesis` findings + paired
"Validate: ..." questions. Phase-2 routine annotations describe
the same RAM regions properly, but the originals stay alive
forever. `render_graphics_preview` proves a sprite block visually
but does not write back into the source segment classification.

## Goal

Three propagation paths so confirmation work flows back to the
sources of truth and superseded heuristic noise gets archived.

## Pfade

### Pfad A — Render confirms segment

`render_graphics_preview` (and `scan_graphics_candidates`) accepts
optional `segment_id` arg. When provided OR when the (path,
address, length) tuple uniquely matches one segment in the
artifact's `*_analysis.json`, mark that segment as
`confirmed: true` with `confirmedBy: { kind: "render",
artifactId: <png>, capturedAt }`.

Writeback target: the analysis JSON (mutate in place) AND mirror
into a finding record `kind: "confirmation"` so the UI can surface
it in the Findings tab.

### Pfad B — Routine annotation supersedes hypothesis findings

When a `routine` annotation lands at address $XXXX (via Phase-2
disasm or via save_finding(kind: "routine")), find every
`hypothesis`-kind finding whose `addressRange` is fully inside the
routine. Mark those `status: "archived"`,
`archivedBy: <routine-finding-id>`, evidence note "superseded by
routine annotation".

### Pfad C — Same as Pfad B for open questions

Walk open `heuristic-phase1` source questions whose mentioned
address range is now covered by the routine annotation. Close
with `status: "answered"`, `answeredBy: <routine-finding-id>`,
answerSummary "covered by routine annotation".

(Spec 052 Pfad B was phase-reached + autoResolveHint — different
trigger; Spec 053 Pfad C is annotation-coverage based.)

## Schema

`Segment` (in pipeline analysis JSON):

```ts
confirmed?: boolean;
confirmedBy?: { kind: "render" | "annotation" | "human"; artifactId?: string; findingId?: string; capturedAt: string };
```

`Finding`:

```ts
archivedBy?: string;       // id of finding that superseded
status enum gains "archived" if not already
```

`OpenQuestion`:

```ts
// answeredByFindingId already exists
```

## MCP tools

- `mark_segment_confirmed(prg_path, address, kind, evidence_artifact_id?)`
- `mark_segment_rejected(prg_path, address, reason)`
- `archive_phase1_noise(project_dir, dry_run?)` — sweep heuristic
  findings + questions for routine-annotation coverage. Returns
  per-route counts.

`render_graphics_preview` extension: optional `confirm_segment` flag
(default false). When true, attempts auto-match by (path, address,
length) and writes back if unique.

## Acceptance Criteria

- Calling `mark_segment_confirmed` writes `confirmed: true` into
  the matching `*_analysis.json` segment AND creates a confirmation
  finding.
- Adding a routine annotation covering address $1000-$10FF and
  running `archive_phase1_noise` archives every hypothesis finding
  whose addressRange falls inside that range.
- Same for paired open questions — they close with
  `answeredBy = <routine-finding-id>`.
- `dry_run=true` prints the would-archive list without writing.

## Tests

- Smoke: stage a fixture with 3 hypothesis findings + 2 questions
  spanning $1000-$1FFF; add routine annotation at $1000-$10FF; run
  archive; assert 2 of 3 findings archived (the third sits outside
  the range), 1 question answered.
- Smoke: render_graphics_preview with confirm_segment=true marks
  segment in canned analysis JSON.

## Out Of Scope

- UI Graphics tab refactor to show confirmed/unconfirmed/rejected
  buckets (Sprint 43 follow-up).
- Bulk-confirm UI for graphics tab.

## Dependencies

- Spec 052 question auto-resolution (similar pattern, reused).
- Spec 042 propose_annotations (extension point for future
  segment confirmation via static-analysis).
