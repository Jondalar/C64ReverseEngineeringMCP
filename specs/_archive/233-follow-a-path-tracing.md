# Spec 233 — Follow-a-path tracing

**Sprint:** 126
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 (trace store)
**Master:** 230
**Parallel-eligible with:** 234

## Goal

Given an end-event (e.g. "mem_write @ $0763 by PC=$05B7"), return
the causal chain of preceding events that led to it. Agent uses
this to explain "why did X happen" without re-running.

## Causal chain definition

A chain is a sequence of events ordered by cycle, ending in the
target event. Causality follows these rules:

1. **PC predecessor**: previous `cpu_step` on same PC chain (= last
   instruction before the target's PC fetched).
2. **Stack frame**: any `mem_write` to stack ($0100-$01FF) by the
   same call frame, walked back to the originating `JSR`.
3. **Memory dependency**: most recent `mem_write` to addresses
   the target's instruction reads (operand resolution via Spec 235
   enriched event).
4. **Interrupt origin**: if target's PC is in IRQ handler, walk back
   to the `irq_assert` that woke it.
5. **IO state dependency**: if target reads a register ($D0xx /
   $DCxx / $DDxx), walk to the most recent `*_register_write` or
   `*_change` for that register.

Chain depth bounded by `maxDepth` (default 50) and `cycleWindow`
(default 100_000 cycles back).

## Surface

```ts
export interface PathQuery {
  runId: string;
  endEventCycle: number;
  endEventFamily: EventFamily;
  endEventKey: Record<string, unknown>;   // family-specific predicate
  maxDepth?: number;
  cycleWindow?: number;
}
export interface PathStep {
  rule: "pc_predecessor" | "stack_frame" | "mem_dep" | "irq_origin" | "io_dep";
  event: EventRow;
  reason: string;
}
export interface PathChain {
  steps: PathStep[];     // ordered earliest → end event
  truncated: boolean;
}
export function followPath(q: PathQuery): PathChain;
```

## Acceptance

- For motm stage-1 bug: `followPath` from `mem_write @ $0763 = $11`
  returns chain ending at the originating IEC handshake byte
  arrival, with all intermediate JSR/RTS frames + IO reads.
- Result has ≤50 steps when default depth is used.
- Query completes in ≤1s for 1M-event run.
- Includes `reason` text suitable for direct LLM prompt.

## Resolved decisions

- **B2 (2026-05-08):** Cross-domain causality with toggle. Default
  `crossDomain: true` → recursion follows c64↔drive across IEC
  events. `crossDomain: false` stops at drive_*_change boundary
  marker.

## Out-of-scope

- Cross-run chains.
- Speculative paths (e.g. "what would have happened if branch
  taken differently").
