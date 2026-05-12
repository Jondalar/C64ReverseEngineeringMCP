# Spec 237 — Agent query API (KernelClient extension)

**Sprint:** 132
**Status:** DONE 2026-05-09 — `AgentQueryApi` class shipped in
src/runtime/headless/v2/agent-api.ts. Aggregates all V2.x modules
into single stable surface (~30 methods across trace/follow-path/
swimlane/taint/profile/disasm-link/vice-diff/replay/snapshot-diff/
fingerprint/breakpoints/bookmarks/monitor/rewind/regression/VSF +
status). Smoke `scripts/smoke-agent-api.mjs` exercises 12 ops
end-to-end — **12/12 PASS**. E2E ladder unchanged.
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
  // Core (231-238)
  inspectRoutine(artifactId: string, entryPc: number): RoutineRecord;
  evidenceForSegment(artifactId: string, range: [number, number]): SegmentEvidence;
  replayUntil(predicate: EventPredicate, timeoutCycles: number): ReplayUntilResult;
  queryEvents(query: EventQuery): EventRow[];
  compareRunAgainstVice(scenarioId: string): DivergenceRecord | null;
  followPath(query: PathQuery): PathChain;
  swimlaneSlice(query: SwimlaneQuery): SwimlaneSlice;
  resolvePc(artifactId: string, pc: number): ResolvedPc;

  // V2.x extensions (240-251)
  // Breakpoints (241)
  addBreakpoint(spec: BreakpointSpec): string;       // returns id
  listBreakpoints(): BreakpointSpec[];
  removeBreakpoint(id: string): void;
  enableBreakpoint(id: string, enabled: boolean): void;

  // Bookmarks (242)
  addBookmark(b: TraceBookmark): string;
  listBookmarks(runId: string, range?: [number, number]): TraceBookmark[];
  removeBookmark(id: string): void;

  // Rewind tree (243)
  beginRewindSession(scenarioId: string, opts?: { ringSize?: number }): RewindHandle;
  rewindTo(handle: RewindHandle, cycle: number): SnapshotId;
  applyPatch(snapshotId: SnapshotId, patches: PokePatch[]): SnapshotId;
  runForward(snapshotId: SnapshotId, budgetCycles: number): { endSnapshot: SnapshotId; trace: EventRow[] };
  diffBranches(a: SnapshotId, b: SnapshotId): SnapshotDiff;
  promoteBranch(branchId: string): string;            // returns new scenarioId

  // Taint (244)
  traceTaint(query: TaintQuery): TaintGraph;

  // Profiling (245)
  profileLoader(scenarioId: string, range: [number, number]): LoaderProfile;

  // Diff (246)
  diffSnapshots(a: SnapshotId, b: SnapshotId, opts?: { enrich?: boolean }): SnapshotDiff;
  formatDiff(diff: SnapshotDiff): string;

  // Fingerprinting (247)
  scanFingerprints(artifactId: string): FingerprintMatch[];

  // Monitor (248)
  monitorRegisters(memspace?: "main" | "drive8"): MonitorRegisters;
  monitorMemory(query: MonitorMemoryQuery): Uint8Array;
  monitorDisasm(addr: number, count: number): string[];
  stepInto(): void;
  stepOver(opts?: { cycleBudget?: number }): { reason: "return" | "stack" | "budget" };
  stepOut(): void;
  goto(addr: number): void;
  until(addr: number): void;

  // Tables (249)
  scanRuntimeTables(artifactId: string): DiscoveredTable[];

  // Regression (250)
  regressionCompare(scenarioId: string): RegressionResult;
  regressionCaptureBaseline(scenarioId: string): { path: string; hashes: Hashes };

  // VSF (251)
  saveVsf(): Uint8Array;
  loadVsf(bytes: Uint8Array): void;
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
