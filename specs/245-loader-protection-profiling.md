# Spec 245 — Loader / protection profiling

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 trace store, 233 follow-a-path
**Master:** 230 / 240

## Goal

Game-RE-specific analytics. Quantify what a fastloader / protection
routine does: cycle budget, IO touch profile, decision branches,
disk-image bytes consumed, key-checks, anti-debug tricks.

## Metrics

```ts
interface LoaderProfile {
  scenarioId: string;
  startCycle: number;
  endCycle: number;
  cyclesTotal: number;

  ioTouches: {
    addr: number;
    reads: number;
    writes: number;
    distinctValues: number[];
  }[];

  iecActivity: {
    atnEdges: number;
    clkEdges: number;
    dataEdges: number;
    bytesTransferred: number;
    bitTimingHistogram: Record<number, number>;  // cycle gap → count
  };

  diskActivity: {
    tracksVisited: number[];
    bytesReadFromGcr: number;
    seekCount: number;
  };

  protectionCandidates: {
    pc: number;
    pattern: "key_compare" | "timing_check" | "self_modify" | "vector_indirect" | "checksum_loop";
    cycle: number;
    description: string;
  }[];
}

profileLoader(scenarioId: string, range: [number, number]): LoaderProfile;
```

## Pattern detection heuristics

- **key_compare:** branch instruction (BNE/BEQ) where one side is
  data immediately loaded from RAM; mismatch leads to RTS / endless
  loop.
- **timing_check:** `LDA $DC04`-style read with subsequent compare to
  a constant.
- **self_modify:** `STA imm-of-future-instruction` (= byte-write to
  PC+N where N ∈ [1,3]).
- **vector_indirect:** JMP/JSR via pointer in RAM modified within
  scenario window.
- **checksum_loop:** EOR/ADD-loop over contiguous range, result
  compared to constant.

## Open questions

- **OQ1 [RESOLVED 2026-05-08]:** Both c64 + drive PC. Profile
  emits `c64Cycles`, `driveCycles`, `iecCycles` columns. Drive-PC
  trace channel already populated; aggregator joins both sides.
- **OQ2:** Protection candidates — auto-emit `save_finding` or
  agent decides?
- **OQ3:** GCR byte counter: track-half granularity sufficient or
  per-sector breakdown?
- **OQ4 [RESOLVED 2026-05-08]:** High-recall with `confidence` score
  (0..1). Default output = all candidates. Agent filters via
  `minConfidence` global or per-pattern threshold (e.g.
  `key_compare ≥0.7`, `self_modify ≥0.95`).
- **OQ5:** Profiling vs trace ring — does profile run at end-of-
  scenario only, or live during execution?

## Acceptance (draft)

- For motm AB-fastloader: profile shows IEC bit-timing histogram,
  key_compare candidates, exact cycle budget for stage-1 handshake.
- Drive-PC traffic shown alongside c64 traffic.
- Profile completes in <3s for 10M-cycle window.
