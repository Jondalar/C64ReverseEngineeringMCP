# Spec 243 — Rewind + interactive patch/poke + scenario iteration

**Sprint:** 127
**Status:** DONE 2026-05-08 — RewindManager shipped in
src/runtime/headless/v2/rewind.ts. Surface: beginRewindSession,
rewindTo, applyPatch, runForward, diffBranches, promoteBranch.
Tree branches with leaf-only pinning so chain depth doesn't blow
up ring (ringSize=32 default + override). Snapshots stored as VSF
bytes via Spec 251 saveSessionVsf/loadSessionVsf. Patches applied
strict between-instructions (A5). Smoke `scripts/smoke-rewind.mjs`
exercises 10 scenarios — **10/10 PASS**. E2E ladder unchanged.
**Depends on:** 231 deterministic replay, 251 c64-main VSF, 241 breakpoints
**Master:** 230 / 240

## Goal

Time-travel debugging primitive. Agent runs scenario, hits an
interesting cycle, rewinds, patches RAM / pokes register, re-runs
forward to compare alt-timeline against baseline. Iterate
hypothesis-by-hypothesis without rebuilding from cold start.

## Surface (sketch)

```ts
interface RewindHandle {
  scenarioId: string;
  rootSnapshotId: string;
  branches: SnapshotBranch[];
}

interface SnapshotBranch {
  id: string;
  parentId?: string;
  atCycle: number;
  patches: PokePatch[];        // applied at branch point
  endCycle: number;
  endSnapshotId: string;
  resultHash: string;
}

interface PokePatch {
  kind: "mem_byte" | "mem_range" | "register" | "io_register";
  addr?: number;
  bytes?: number[];
  reg?: "a"|"x"|"y"|"sp"|"pc"|"flags";
  value?: number;
}

beginRewindSession(scenarioId: string): RewindHandle;
rewindTo(handle, cycle: number): SnapshotId;
applyPatch(snapshotId, patches: PokePatch[]): SnapshotId;
runForward(snapshotId, budgetCycles: number): { endSnapshot, trace };
diffBranches(branchA, branchB): SnapshotDiff;
```

## Storage model

In-memory ring of N (default 32) recent snapshots per scenario.
Snapshot eviction: oldest first, except branch points are pinned
until their branch chain GC'd.

Uses Spec 251 c64-main VSF as snapshot serialization.

## Open questions

- **OQ1 [RESOLVED 2026-05-08]:** fixed 32 default + per-session
  `ringSize` override on `beginRewindSession`. ~5MB RAM footprint.
  Auto-tune deferred.
- **OQ2 [RESOLVED 2026-05-08]:** Tree. Multiple hypothesis branches
  at same rewind point allowed; each branch can spawn sub-branches.
  Snapshot cache bounded by ring size, not branch count.
- **OQ3 [RESOLVED 2026-05-08]:** Transient by default. Opt-in
  `promoteBranch(branchId) → newScenarioId` creates persistent
  Scenario record (start-snapshot + patches embedded). Throwaway
  experiments don't pollute project history.
- **OQ4+5 [RESOLVED 2026-05-08]:** Strict between-instructions only.
  Patches apply before next instruction fetch. PC-patch redirects
  at next fetch. Mid-cycle patching deferred to V3+ (one-percent
  use-case, cycle-accurate complexity not justified yet).
- **OQ6:** UI/MCP surface for "rewind to last bookmark" shortcut?

## Acceptance (draft)

- Run motm-stage-1 to cycle X, rewind to cycle X-10000, patch
  $0763 = $00 manually, run forward 50000 cycles, observe
  divergence in trace.
- Snapshot ring evicts oldest correctly without breaking pinned
  branches.
- `diffBranches` returns RAM + register + chip-state delta in
  semantic form.
