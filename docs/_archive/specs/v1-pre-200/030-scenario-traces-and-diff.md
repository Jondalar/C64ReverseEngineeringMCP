# Spec 030: Runtime Scenario Traces With Original-Vs-Port Diff

## Problem

Static analysis produced false orphan-file conclusions in the
Accolade Comics port. The decisive evidence was scenario-specific
runtime trace: original disk vs EF port, breakpoints on loader
entries, compare which file keys / load destinations occurred before
a gameplay milestone. C64RE has VICE trace tools but no concept of
"named, repeatable scenario" or "diff between two runs".
REQUIREMENTS R20.

## Goal

Define a scenario once. Run it against multiple targets (original
disk, port build N-1, port build N). Capture normalised loader
events. Produce a compact diff that tells the user what changed.

## Approach

### Schema

```ts
interface RuntimeScenario {
  id: string;
  title: string;
  description?: string;
  target: { kind: "disk" | "crt" | "prg"; artifactId: string };
  startMedia?: string[];            // additional artifacts to attach
  breakpoints: Array<{ pc: number; label?: string; bank?: number }>;
  stopCondition: { kind: "frame-count" | "pc-hit" | "timeout-seconds"; value: number | string };
  expectedMilestone?: string;
  tags: string[];
}

interface RuntimeEvent {
  capturedAt: string;
  pc: number;
  bank?: number;
  caller?: number;
  fileKey?: string;
  trackSector?: { track: number; sector: number };
  destinationStart?: number;
  destinationEnd?: number;
  sideIndex?: number;
  containerSubKey?: string;
  success: boolean;
  notes?: string;
}

interface RuntimeEventSummary {
  scenarioId: string;
  runId: string;
  capturedAt: string;
  target: { kind: string; artifactId: string };
  events: RuntimeEvent[];
  hashes: Record<string, string>;   // payload hash per fileKey
  reachedMilestone: boolean;
}

interface RuntimeDiff {
  baselineRunId: string;
  candidateRunId: string;
  missingLoads: RuntimeEvent[];     // present in baseline, absent in candidate
  extraLoads: RuntimeEvent[];       // candidate-only
  diffSource: Array<{ key: string; baselineSource: string; candidateSource: string }>;
  diffPayloadHash: Array<{ key: string; baselineHash: string; candidateHash: string }>;
  diffDestination: Array<{ key: string; baselineDest: number; candidateDest: number }>;
  divergentPc: Array<{ index: number; baselinePc: number; candidatePc: number }>;
}
```

Storage: `knowledge/scenarios/<id>.json`,
`knowledge/runtime-events/<runId>.json`,
`knowledge/runtime-diffs/<id>.json`.

### MCP tools (separate from existing vice_trace_*)

- `define_runtime_scenario(...)` — create / update.
- `run_runtime_scenario(scenario_id, target_artifact_id?, build_label?)`
  — drives a VICE session, attaches breakpoints, records normalised
  events. Re-uses existing vice_session_* / vice_monitor_* primitives
  but emits the new event shape.
- `list_scenario_runs(scenario_id?)`.
- `diff_scenario_runs(baseline_run_id, candidate_run_id)` — emit
  the structured diff.
- `summarise_scenario_run(run_id)` — short rendering for chat.

These live alongside the existing vice tools but operate at a
higher abstraction. Naming TBD; user is fine with either prefix.

### Loader event normalisation

When `vice_trace_runtime_start` hits a loader entry declared via
Spec 028, the event recorder uses `decode_loader_call` to populate
`fileKey`, `trackSector`, `destinationStart`, etc. Without Spec 028
declarations, events fall back to raw PC + register snapshot.

### UI

Scenario tab:

- Table of scenarios + recent runs per scenario.
- Click run → events table with milestone hit/miss.
- "Compare with…" button → diff view (missing / extra / divergent
  panes).

## Acceptance Criteria

- "Story 2 after Robots win" can be defined as a scenario, run
  against the original disk, and saved as a baseline.
- Same scenario re-run against a port build produces a diff that
  highlights any missing `WT` / `/1` subentry loads.
- A scenario where the candidate fails to reach the milestone is
  reported as `reachedMilestone: false` with the divergent PC.

## Tests

- Smoke: synthetic scenario with two recorded runs (canned event
  files), assert `diff_scenario_runs` returns expected
  missing/extra/diff lists.
- Manual: full VICE-attached run deferred until throughput sprint
  (Sprint 8) lands.

## Out Of Scope

- Auto-discovering scenarios from gameplay (no AI playtester).
- Replaying scenarios deterministically across VICE versions
  (best-effort frame-count match).

## Dependencies

- Sprint 8 (trace throughput) — pulled forward before this sprint
  so runs do not bottleneck on trace I/O.
- Sprint 28 (Spec 028 loader ABI) — semantic event decoding.
- Sprint 22 (Spec 025) — payload lineage for hash comparison.
