# Spec 243 — Rewind + interactive patch/poke + scenario iteration

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
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

- **OQ1:** Snapshot ring size — fixed 32, or auto-tune by scenario
  cycle budget?
- **OQ2:** Branch chains: tree (one root, many children, recursive)
  or just linear (parent → child only)?
- **OQ3:** Does patch persistence into "saved scenario" use case
  matter (save as new Scenario record), or are branches transient?
- **OQ4:** PC patch — does it bypass next instruction fetch or
  redirect at next fetch? (= cycle-accurate semantics)
- **OQ5:** Apply patch mid-instruction or only between instructions?
- **OQ6:** UI/MCP surface for "rewind to last bookmark" shortcut?

## Acceptance (draft)

- Run motm-stage-1 to cycle X, rewind to cycle X-10000, patch
  $0763 = $00 manually, run forward 50000 cycles, observe
  divergence in trace.
- Snapshot ring evicts oldest correctly without breaking pinned
  branches.
- `diffBranches` returns RAM + register + chip-state delta in
  semantic form.
