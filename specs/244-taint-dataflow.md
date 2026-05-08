# Spec 244 — Taint analysis / dataflow tracking

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 232 trace store, 233 follow-a-path
**Master:** 230 / 240

## Goal

For a target byte at (cycle, addr), enumerate every prior write
that contributed to its current value, recursively. "Where did this
$11 in $0763 come from? Which IEC byte? Which CIA register?"

Pure forensic analysis on existing trace — no re-execution needed.

## Surface (sketch)

```ts
interface TaintQuery {
  runId: string;
  startCycle: number;
  startAddr: number;          // byte to taint
  maxDepth?: number;          // default 100
  cycleWindow?: number;       // default 1_000_000
}

interface TaintNode {
  cycle: number;
  pc: number;
  addr: number;
  value: number;
  contribution:
    | "direct_write"          // STA/STX/STY/STZ
    | "rmw_modify"            // INC/DEC/ASL/etc
    | "io_register_read"      // value sourced from $DC0D etc
    | "stack_push"
    | "transfer";             // TAX/TAY/TYA etc
  inputs: { addr?: number; reg?: string }[];
}

interface TaintGraph {
  root: TaintNode;
  edges: { from: string; to: string }[];   // node IDs
  nodes: Record<string, TaintNode>;
  truncated: boolean;
}

traceTaint(q: TaintQuery): TaintGraph;
```

## Algorithm

1. From (cycle, addr), find most recent `mem_write` at addr ≤ cycle.
2. For that write's PC, look up instruction:
   - direct STA/STX/STY → predecessor = register at instruction
     start; recurse on register's last load.
   - RMW → input = same addr's prior value + register if needed.
   - From-IO → terminate (mark `io_register_read`).
3. Follow registers back via cpu_step trace until next "load from
   memory" then recurse on the loaded addr.
4. Bound by depth + cycle window; mark `truncated` if exhausted.

## Open questions

- **OQ1:** Does taint follow IRQ boundaries? I.e. if the target was
  set by IRQ handler, do we follow into the IRQ-source events
  (cia_timer_underflow → ICR read)?
- **OQ2:** Cross-domain taint: c64 RAM byte sourced from drive RAM
  via IEC handshake — recurse into drive trace or terminate at
  IEC_byte event?
- **OQ3:** Symbolic naming: report taint as raw addrs or
  resolve via Spec 235 to label/segment?
- **OQ4:** Aggregation — show full graph or collapse identical
  load-from-zp chains?
- **OQ5:** Performance budget: 100-deep graph in <2s acceptable?

## Acceptance (draft)

- For motm $0763 = $11 case, taint chain ends at IEC bit-shift
  routine reading from drive (or terminates at IEC boundary).
- Graph rendered as DOT for visualization + structured for agent.
- 100-depth query <2s on motm-full-boot trace.
