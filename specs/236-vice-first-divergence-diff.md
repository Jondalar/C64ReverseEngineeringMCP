# Spec 236 — VICE first-divergence diff

**Sprint:** 127
**Status:** PROPOSED 2026-05-08 (extends Spec 205-B prototype)
**Depends on:** 232 (trace store), 205-B (existing diff CLI)
**Master:** 230
**Parallel-eligible with:** 235

## Goal

Given a scenario, run VICE and headless under the same starting
state and inputs, locate the first cycle where the canonical event
streams diverge, and return a structured `DivergenceRecord`. Agents
use this as primary debug input when "headless wrong, VICE right".

VICE remains the compatibility oracle (per ADR §15 + memory rule
"ALWAYS read VICE first").

## DivergenceRecord schema

```ts
export interface DivergenceRecord {
  scenarioId: string;
  firstDivergeCycle: number;
  divergenceFamily: EventFamily;        // which event-family diverged first
  vice: EventRow;
  headless: EventRow;
  context: {
    viceWindow: EventRow[];     // ±20 events around vice side
    headlessWindow: EventRow[]; // ±20 events around headless side
    sharedPrefix: number;       // cycle-equal events before divergence
  };
  classification:
    | "cpu_register"
    | "memory_io"
    | "interrupt_timing"
    | "iec_line"
    | "cia_register"
    | "via_register"
    | "vic_register"
    | "drive_pc"
    | "unknown";
}
```

## VICE side capture

Two paths:

- **Live** (V2 polish): VICE binary monitor MCP tools (already
  present, see `vice_trace_*` family). Capture trace.jsonl from VICE
  runtime via existing infrastructure.
- **Replay** (V2 fast-path): consume vendored baseline traces from
  `samples/traces/v2-baseline/<scenario>/trace.jsonl`. These are
  immutable per memory `reference_vice_baseline_traces.md`.

Default: replay path. Live capture only when scenario isn't in
baseline corpus.

## Diff algorithm

1. Stream both event streams ordered by `cycle`.
2. Group into "epochs" by canonical event family.
3. Walk pairs by cycle; first mismatch → divergence point.
4. Classify using `divergenceFamily` + payload diff heuristic.

## Surface

```ts
export interface DiffQuery {
  scenarioId: string;
  vicePath?: string;        // override default baseline path
  cycleRange?: [number, number];
}
export function diffAgainstVice(q: DiffQuery): DivergenceRecord | null;
// null = no divergence in window
```

## Acceptance

- For motm-full-boot (currently passing), `diffAgainstVice` returns
  `null` (no divergence) using v2-baseline traces.
- Synthetic regression: introduce a deliberate cpu bug in a branch,
  rerun → divergence detected at correct cycle, classification =
  `cpu_register`, context window includes 20 events on each side.
- VICE re-capture not invoked unless scenario absent from baseline.

## Out-of-scope

- Repair suggestions (= V3 / agent task).
- Multi-divergence reporting (V2 returns first only).
