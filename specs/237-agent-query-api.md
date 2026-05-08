# Spec 237 — Agent query API (KernelClient extension)

**Sprint:** 128
**Status:** PROPOSED 2026-05-08
**Depends on:** 231-236, 206 (KernelClient)
**Master:** 230

## Goal

Higher-level methods consumed by V2 MCP tools and direct agent
calls. Stable surface separate from raw `KernelClient`. Aggregates
trace queries, snapshot, replay, divergence, and disasm linkage
into agent-shaped operations.

## Surface

```ts
// src/runtime/headless/v2/agent-api.ts (new)
export interface RoutineRecord {
  artifactId: string;
  entryPc: number;
  exitPcs: number[];
  length: number;
  calledFrom: number[];        // distinct caller PCs in trace
  callsTo: number[];           // distinct target PCs
  registerUse: { reads: ("a"|"x"|"y"|"sp")[]; writes: ("a"|"x"|"y"|"sp")[] };
  executionCount: number;      // times entered in current run
}

export interface SegmentEvidence {
  artifactId: string;
  range: [number, number];
  executionCount: number;       // cpu_step events in range
  writeSet: { addr: number; cyclesWritten: number[] }[];
  readSet: { addr: number; cyclesRead: number[] }[];
  refCount: number;             // labels + routines pointing in
}

export interface ReplayUntilResult {
  hit: boolean;
  cycleAtHit?: number;
  state: MachineSnapshot;
  trace: EventRow[];
}

export interface AgentQueryApi {
  inspectRoutine(artifactId: string, entryPc: number): RoutineRecord;
  evidenceForSegment(artifactId: string, range: [number, number]): SegmentEvidence;
  replayUntil(predicate: EventPredicate, timeoutCycles: number): ReplayUntilResult;
  queryEvents(query: EventQuery): EventRow[];
  compareRunAgainstVice(scenarioId: string): DivergenceRecord | null;
  followPath(query: PathQuery): PathChain;
  swimlaneSlice(query: SwimlaneQuery): SwimlaneSlice;
  resolvePc(artifactId: string, pc: number): ResolvedPc;
}
```

`EventPredicate` is a structured filter:
```ts
type EventPredicate = {
  family: EventFamily;
  pc?: number | [number, number];
  addr?: number | [number, number];
  value?: number;
  source?: string;
};
```

## Acceptance

- All 8 methods implemented + return shapes typed.
- Backed by Specs 231-236; no method requires re-running emulation
  unless explicitly `replayUntil`.
- `inspectRoutine` for a routine in motm returns full record in
  <300ms.
- `evidenceForSegment` for a 256-byte range returns in <500ms.

## Migration path

V1 tools (`headless_*`) keep working. V2 tools (Spec 238) wrap
this API. After 240+, V1 tools deprecated → removed.
