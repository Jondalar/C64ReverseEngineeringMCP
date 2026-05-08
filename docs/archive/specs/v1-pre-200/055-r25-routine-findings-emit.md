# Spec 055 — R25: auto-emit routine-findings from `*_annotations.json`

## Problem

Per Bug 25 + R25: when annotations are consumed, routines/segment
reclassifications never become findings in `findings.json`. So
`archive_phase1_noise` (Spec 053) and `auto_resolve_questions`
(Spec 052) match against an empty set — agent does hours of
annotation work but the dashboard noise counters stay flat.

## Phase A — effective-segments overlay (prerequisite)

The current pipeline (`pipeline/src/lib/prg-disasm.ts:buildAnnotatedSegments`)
only honours annotations that are **fully contained** inside an
analysis segment. Cross-boundary reshape (annotation $0800-$091F
overrides part of analysis $0900-$09FF) is silently dropped.

R25 routine-end derivation needs to query the **effective** segment
layout (analysis ⊕ annotation, annotation wins on overlap) — not raw
analysis. So Phase A ships first.

### Design

New function in `pipeline/src/lib/effective-segments.ts`:

```ts
export function buildEffectiveSegments(
  analysisSegments: Segment[],
  annotationSegments: Array<{ start: number; end: number; kind: SegmentKind; label?: string; comment?: string }>,
): Segment[];
```

Algorithm:
1. Sort annotations by `start` ascending.
2. Walk address space [analysis.min .. analysis.max]. At each address
   resolve owner: annotation if any annotation covers it, else
   whichever analysis segment covers it.
3. Coalesce adjacent addresses sharing `(owner, kind, label)` into
   merged segments.
4. Annotation overlap rules:
   - If two annotations overlap, the LATER one (by sort order) wins
     for the overlap region — caller responsibility to write a clean
     annotation file.
   - Annotation extending past analysis bounds is allowed; new
     segment carries annotation kind.
5. Output sorted by `start`, with no overlaps and no gaps within the
   covered range.

Replaces `buildAnnotatedSegments` callsites with `buildEffectiveSegments`.
Old behaviour (contained-only) preserved for cases where annotation
file is well-behaved (nothing crosses) — output identical.

Sub-segments use case: `annotation.segments[]` carrying
`[{start:$1000, end:$1154, kind:code, label:"player"},
{start:$1155, end:$1FFF, kind:data, label:"music_data"}]` overrides
analysis `{start:$1000, end:$1FFF, kind:code+data}` cleanly — output
two effective segments.

## Phase B — routine + segment-reclass finding emit

### Trigger surfaces

1. **Auto** in `disasm_prg` after annotations consumed — happy path.
2. **Standalone** new MCP tool `import_annotations_as_findings({ artifact_id, annotations_path? })`:
   - For projects whose annotations were never run through `disasm_prg`.
   - For explicit re-emit after manual annotation editing.
   - For testing / debug.

Both call the same service helper `service.emitAnnotationFindings({...})`.

### Routine-end derivation (hybrid)

Given a routine entry at address `R.start` and the effective segments:
1. Find effective segment `S` containing `R.start` (`S.start <= R.start <= S.end`).
2. Find next routine `R'` with `R.start < R'.start <= S.end`.
3. `R.end = R' ? R'.start - 1 : S.end`.
4. If no segment contains `R.start` (annotation orphan), fallback:
   - Find next routine `R'` anywhere → `R.end = R'.start - 1`
   - Else: `R.end = R.start` (single-byte sentinel; flagged in summary).

### Segment-reclass emission

For each effective segment whose `kind` differs from the analysis
segment that originally covered the same range:
- Skip segments with confidence below 0.85 (annotation defaults are high
  trust; agents can override per-segment if needed).
- Emit one finding with `kind="classification"`,
  `tags=["segment-classification","annotation"]`,
  `addressRange={start:S.start, end:S.end}`,
  `summary="<originalKind> reclassified to <newKind>"`.

### Idempotency (clean slate per binaryStem)

Before emit:
1. Compute `binaryStem` = source PRG's relativePath without extension.
2. Find all existing findings whose `id` matches
   `^finding-routine-${binaryStem}-` OR `^finding-segclass-${binaryStem}-`.
3. Delete them via new service helper `service.removeFindingsById(ids[])`.

Then emit fresh:
- Routine ID format: `finding-routine-${binaryStem}-${startHex4}-${endHex4}`
- Segment-reclass ID format: `finding-segclass-${binaryStem}-${startHex4}-${endHex4}`

Re-running disasm_prg with same annotations → identical IDs → identical
findings. Re-running with edited annotations → old IDs deleted, new IDs
emitted. No stale.

### Linking

Each emitted finding:
- `artifactIds: [sourcePrgArtifactId, annotationsArtifactId]`
- If annotations file is not yet registered as artifact:
  `service.saveArtifact({ kind: "annotations", scope: "annotation", path: "<binaryStem>_annotations.json", ... })` first.
- Listing artifact (`<binaryStem>_disasm.asm`) NOT linked — UI inspector
  resolves that via stem-pairing (Bug 24 fix).

### Confidence

- Routine findings: `confidence: 0.95` (agent/human-curated).
- Segment-reclass: `confidence: 0.85` (annotation override of heuristic).

## API

### Service

```ts
service.emitAnnotationFindings({
  sourcePrgArtifactId: string;
  annotationsPath: string;    // absolute path to *_annotations.json
  analysisJsonPath?: string;  // optional, for effective-segments overlay
}): {
  routinesEmitted: number;
  segmentReclassesEmitted: number;
  staleRemoved: number;
  bindingArtifactIds: string[];
};
```

### MCP tool

```ts
"import_annotations_as_findings"
input: {
  project_dir?: string;
  artifact_id: string;       // source PRG
  annotations_path?: string; // defaults to <stem>_annotations.json next to PRG
}
```

### disasm_prg auto-call

After existing annotation consume + listing emit, before final return:

```ts
try {
  const result = service.emitAnnotationFindings({...});
  // append to response: "Findings emitted: N routines, M reclasses (K stale removed)"
} catch (error) {
  // soft fail — don't break disasm
}
```

## Out of scope

- **Phase C — closed loop sweep**: Spec 057 (R26).
- **Per-payload scope**: Spec 056 (R27); routine emit is always
  per-source-PRG so no scope param needed here.
- **Annotation conflict detection**: cross-boundary annotation overlap
  is caller's responsibility v1; later spec can add validation.
- **Routine ABI as finding**: `RoutineAnnotation.abi` not emitted as
  finding metadata in v1; could ride along in `summary` if useful.

## Cross-reference

- Bug 25: `save_finding.address_range` param (FIXED) — primitive this spec uses.
- Spec 052 (auto-resolution): consumers of routine findings.
- Spec 053 (phase-1 noise archive): consumers of routine findings.
- Bug 20 (parent): noise archive workflow.
- R26 (Spec 057): closed-loop sweep that auto-runs archive after this spec emits findings.
- R27 (Spec 056): per-payload scope filter for the consumer side.
