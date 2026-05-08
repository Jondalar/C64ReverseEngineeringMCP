# Spec 249 — Disasm-time annotation suggestions + table discovery

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 trace store, pipeline disasm, 247 fingerprinting
**Master:** 230 / 240

## Goal

Pipeline post-pass that uses runtime evidence (trace events,
fingerprint matches, indirect-jump targets) to:

1. Auto-emit annotation suggestions for `propose_annotations`.
2. Discover data tables (jump tables, sprite pointer tables,
   character maps, music score tables).

Tables are a chronic pain in static-only RE — runtime disambiguates.

## Annotation suggestions emitted

| Trigger | Suggestion |
|---------|------------|
| Fingerprint match (Spec 247) | `RoutineAnnotation` with library name |
| Indirect-JMP target consistently == addr X | `LabelAnnotation` at X + segment=`code` |
| Indirect-LDA pointer-table scan pattern | `SegmentAnnotation` of pointer-table type |
| `mem_read` from same region without writes after init | `SegmentAnnotation` of read-only data |
| RTS-target self-consistent (same return-addr each call) | `RoutineAnnotation` extends |
| Repeated PC = X with monotonic Y register | sprite/charset rendering loop hint |

## Table discovery

Heuristic: addresses in [start, end] where:

- All accessed via indirect mode (zp,Y or abs,Y).
- Y range = [0, length-1] consistently.
- Every byte read at least once.

Classification:

```ts
interface DiscoveredTable {
  artifactId: string;
  range: [number, number];
  stride: number;             // byte / word / triple
  entries: number;
  accessPattern: "indexed_read" | "indexed_write" | "indexed_jump";
  candidateKind: "jump_table" | "pointer_table" | "data_table" | "char_data" | "sprite_pointers" | "unknown";
  sampleEntries: { idx: number; bytes: number[]; resolved?: number }[];
  evidence: { firstSeenCycle: number; accessCount: number; consumerPcs: number[] };
}
```

## Pipeline integration

- New analyzer in pipeline: `analyzeRuntimeTables` runs after
  `pipeline/src/analysis/pipeline.ts` core analyzers if a runtime
  trace is attached to the artifact.
- Output written to `<artifact>_runtime_tables.json`.
- `propose_annotations` consumes both static + runtime suggestions.

## Open questions

- **OQ1 [RESOLVED 2026-05-08]:** 2-tier:
  - **≥0.9** → auto-write to draft annotation file (proposed
    section in `<artifact>_annotations.json`).
  - **0.5-0.9** → emit as `OpenQuestion` for review.
  - **<0.5** → log only.
  Per-trigger thresholds allowed (e.g. fingerprint-match strict
  ≥0.95, table-discovery softer ≥0.7).
- **OQ2:** Runtime evidence required: full scenario trace, or single
  scenario-window slice sufficient?
- **OQ3:** Cross-scenario table-discovery: aggregate evidence across
  multiple runs (= jump-table hit by different code paths)?
- **OQ4:** Table-stride detection — fixed 1/2/3, or arbitrary?
- **OQ5 [RESOLVED 2026-05-08]:** Auto-name with `_auto_` prefix.
  Patterns: `_auto_table_XXXX`, `_auto_routine_XXXX`, `_auto_label_XXXX`.
  Prefix marks pipeline-generated. Human/agent review renames →
  drops `_auto_` → label becomes "official". Disasm output renders
  auto-labels with `(auto)` suffix.

  **Plus: bidirectional disasm sync.**

  - **Ingest:** Pipeline parses existing `<artifact>_disasm.asm` /
    `_disasm.tass` (when present) for human-authored labels +
    comments. Existing labels are ground-truth: not re-suggested,
    not overridden by auto-suggestions.

  - **Emit:** New findings (= confirmed annotation, table discovery)
    write back into the .asm file as:
    - Label declarations at correct addresses (sorted in section).
    - Inline comments at the cited PC.
    - Routine description block above entry-PC.

    Incremental edit (= preserves human-authored spacing/comments
    elsewhere in the file). No full regenerate. Diff-friendly.

  Tooling: `pipeline/src/disasm/asm-sync.ts` (new) handles read +
  patch. Backed by AST-style parse, not regex.

## Acceptance (draft)

- For motm: discovers stage-1 jump table, copy-protection
  decision-tree table, sprite pointer table at $07F8.
- Suggestions land as draft entries in `_annotations.json` via
  `propose_annotations` flow.
- Table discovery <2s on a 30000-event trace.
- Precision ≥80% on annotated reference corpus.
