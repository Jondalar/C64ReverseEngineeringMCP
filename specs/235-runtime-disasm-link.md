# Spec 235 — Runtime evidence ↔ disassembly link

**Sprint:** 127
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 (trace store), pipeline disasm output
**Master:** 230
**Parallel-eligible with:** 236

## Goal

Every PC sample in the trace resolves to its position in the
project's disassembly: nearest label, segment kind, source line.
Agents can answer "what is PC=$05B7" without re-running the
analysis pipeline.

## Resolution layers

For a given (artifactId, pc):

1. **Routine annotation** (Spec 042 / 055): PC inside a
   `RoutineAnnotation` range → returns `{ name, description, entry,
   exit }`.
2. **Label annotation**: nearest `LabelAnnotation` ≤ PC → returns
   `{ name, isExact: pc === label.address }`.
3. **Segment classification** (Spec 047 / 055): PC inside which
   `SegmentRecord` → returns `{ kind, confidence }`.
4. **Disasm source line**: line number in `<artifact>_disasm.asm` /
   `_disasm.tass` (cached from pipeline output).

## Surface

```ts
export interface ResolvedPc {
  artifactId: string;
  pc: number;
  routine?: { name: string; description?: string; entry: number; exit?: number };
  label?: { name: string; isExact: boolean };
  segment?: { kind: SegmentKind; confidence: number };
  source?: { file: string; line: number };
}
export function resolvePc(artifactId: string, pc: number): ResolvedPc;
export function resolvePcs(artifactId: string, pcs: number[]): ResolvedPc[];
```

## Enriched event row

`queryEvents()` (Spec 232) gains optional `enrich: true` flag:
appends `_resolved` field with `ResolvedPc` per cpu_step / mem_*
event. Cached per (artifactId, pc) lookup.

## Acceptance

- For motm artifact with `_annotations.json` consumed, every PC in
  trace resolves to either routine or segment.
- ≤2ms median resolve per PC after warm cache.
- Trace slice of 1000 events with `enrich:true` returns in <1s.

## Out-of-scope

- Cross-artifact resolution (PC in cartridge vs RAM-loaded code).
- Speculative resolution (= "if this byte is interpreted as op").
