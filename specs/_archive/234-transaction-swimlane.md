# Spec 234 — Transaction-level swimlane

**Sprint:** 126
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 (trace store), 205-B (existing swimlane prototype)
**Master:** 230
**Parallel-eligible with:** 233

## Goal

One unified timeline aligning c64 CPU, c64 IO, bus state, drive IO,
drive CPU on a shared cycle clock. Agent and human eye both consume
the same view. Replaces ad-hoc swimlane scripts (build-ab-swimlane,
swimlane-full-diff) with first-class API.

## Row schema

One row per c64 cycle (or per bus event in compact mode):

```
cycle | c64_pc | c64_op  | c64_io_rw | c64_io_addr=val | bus_atn | bus_clk | bus_data | drv_pc | drv_op | drv_io_rw | drv_io_addr=val
```

`c64_io_addr=val` example: `D020=02` (border red write) or
`DD0D r=01` (CIA2 ICR read returned 1).

Compact mode = only rows where any column changed since previous
row.

**Default:** compact (B3 RESOLVED 2026-05-08). Full-row only on
explicit request, intended for tight cycle windows around divergence.

## Surface

```ts
export interface SwimlaneSlice {
  startCycle: number;
  endCycle: number;
  rows: SwimlaneRow[];
  compact: boolean;
}
export interface SwimlaneRow {
  cycle: number;
  c64Pc?: number;
  c64Op?: string;        // mnemonic+operand
  c64IoRw?: "r" | "w";
  c64IoAddr?: number;
  c64IoValue?: number;
  busAtn?: 0 | 1;
  busClk?: 0 | 1;
  busData?: 0 | 1;
  drvPc?: number;
  drvOp?: string;
  drvIoRw?: "r" | "w";
  drvIoAddr?: number;
  drvIoValue?: number;
}
export interface SwimlaneQuery {
  runId: string;
  cycleRange: [number, number];
  compact?: boolean;     // default true
  filterC64PcRange?: [number, number];
  filterDrvPcRange?: [number, number];
}
export function swimlaneSlice(q: SwimlaneQuery): SwimlaneSlice;
```

## Renderer

`scripts/render-swimlane.mjs` consumes a `SwimlaneSlice` and emits:

- **Markdown** table for inline LLM consumption (≤200 rows). Primary.
- **JSONL** for programmatic diff / storage / any size. Primary.
- ANSI / HTML deferred (V3 UI consumer territory).

LLM/API first per B4 RESOLVED 2026-05-08.

## Acceptance

- `swimlaneSlice({runId, cycleRange:[100000, 110000], compact:true})`
  for motm-full-boot returns ≤500 rows covering 10000 cycles.
- All 5 tracks (c64Pc, c64Io, bus, drvIo, drvPc) populated whenever
  data exists.
- Round-trip via JSONL byte-stable across replay (Spec 231).

## Migration

Deprecate `scripts/build-ab-swimlane.mjs`, `swimlane-full-diff.mjs`,
`swimlane-diff-v2.mjs` once V2 surface lands. Keep them as
historical until 240+.
