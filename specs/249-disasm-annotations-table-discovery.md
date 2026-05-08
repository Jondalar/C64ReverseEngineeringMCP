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

- **OQ1:** Confidence threshold for promoting suggestion to
  draft annotation (vs flagging as open-question)?
- **OQ2:** Runtime evidence required: full scenario trace, or single
  scenario-window slice sufficient?
- **OQ3:** Cross-scenario table-discovery: aggregate evidence across
  multiple runs (= jump-table hit by different code paths)?
- **OQ4:** Table-stride detection — fixed 1/2/3, or arbitrary?
- **OQ5:** Suggested labels — auto-name (`_table_$XXXX`) or leave
  unnamed for human review?

## Acceptance (draft)

- For motm: discovers stage-1 jump table, copy-protection
  decision-tree table, sprite pointer table at $07F8.
- Suggestions land as draft entries in `_annotations.json` via
  `propose_annotations` flow.
- Table discovery <2s on a 30000-event trace.
- Precision ≥80% on annotated reference corpus.
