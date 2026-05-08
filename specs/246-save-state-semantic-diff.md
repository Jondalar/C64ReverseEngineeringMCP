# Spec 246 — Save-state semantic diff

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 251 c64-main VSF, 134 snapshot
**Master:** 230 / 240

## Goal

Diff two snapshots and return semantic delta, not raw bytes. Primary
use-case: **C64RE-internal debugging** ("our emu drifts here, what
changed between cycle X and cycle Y"). Secondary: agent root-cause
analysis when followPath is too narrow.

User note (2026-05-08): more for debugging the emu itself than for
crack/RE work. Kept in V2.x scope as agent-debug primitive.

## Diff schema

```ts
interface SnapshotDiff {
  fromCycle: number;
  toCycle: number;
  ram: {
    changedRanges: { start: number; end: number; byteCount: number }[];
    sample: { addr: number; before: number; after: number }[];   // first 100 changes
  };
  cpu: {
    changedRegs: { reg: string; before: number; after: number }[];
    pcDelta: number;
    cyclesDelta: number;
  };
  cia1: ChipDiff;
  cia2: ChipDiff;
  vic: ChipDiff;
  sid: ChipDiff;
  pla: { configBefore: string; configAfter: string };
  drive?: {
    cpu: ChipDiff;
    via1: ChipDiff;
    via2: ChipDiff;
    headPosition: { trackHalfBefore: number; trackHalfAfter: number };
  };
  iecBus: {
    edgesBetween: number;
    finalState: { atn: 0|1; clk: 0|1; data: 0|1 };
  };
}

interface ChipDiff {
  changedRegisters: { reg: number; before: number; after: number }[];
  internalStateNotes: string[];     // free-form for non-register state
}

diffSnapshots(snapshotA: unknown, snapshotB: unknown): SnapshotDiff;
```

## Open questions

- **OQ1:** RAM changed-ranges: byte-granular or page-granular
  (256-byte chunks)?
- **OQ2:** Sample cap (100) — configurable, or always full diff
  if user requests?
- **OQ3:** Should diff include "cycle range" of when each RAM byte
  last changed (= mini-trace integration)?
- **OQ4:** Drive present iff scenario has true-drive mode?
- **OQ5:** Output format — JSON only, or also human-readable
  text-table for inline LLM consumption?

## Acceptance (draft)

- Diff between c64-ready and motm-dir-load snapshots produces
  semantic summary: BASIC pointers changed, READY screen → DIR
  output, no drive activity.
- Diff for two cycles 10000 apart in motm-stage-1 highlights $0763
  flip + IEC line edges.
- <100ms diff between two ~10KB-modified-state snapshots.
