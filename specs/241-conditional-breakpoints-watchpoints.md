# Spec 241 — Conditional breakpoints + watchpoints

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 206 KernelClient
**Master:** 230 / 240

## Goal

Multi-criteria breakpoints expressible by agent without re-running
to inspect. Replaces single-PC `headless_breakpoint_*` with
predicate-based stops.

## Surface (sketch)

```ts
interface BreakpointSpec {
  id: string;
  predicate: BreakpointPredicate;
  action: "halt" | "log" | "snapshot" | "trace_burst";
  enabled: boolean;
  hitLimit?: number;     // disable after N hits
}

type BreakpointPredicate =
  | { kind: "pc"; pc: number | [number, number] }
  | { kind: "mem_read"; addr: number | [number, number]; valueEq?: number }
  | { kind: "mem_write"; addr: number | [number, number]; valueEq?: number; valueChanged?: boolean }
  | { kind: "register"; reg: "a"|"x"|"y"|"sp"; valueEq: number }
  | { kind: "irq_pending"; source?: "cia1"|"cia2"|"vic" }
  | { kind: "and"; left: BreakpointPredicate; right: BreakpointPredicate }
  | { kind: "or"; left: BreakpointPredicate; right: BreakpointPredicate };
```

## Open questions

- **OQ1:** Halt semantics when multiple breakpoints hit on same
  cycle — first registered wins, or all fire (collect events)?
- **OQ2:** Watchpoint scope — only c64 main bus, or also drive bus
  (= mem_write @ $1800 etc)?
- **OQ3:** Action `snapshot` saves where? (= /tmp / project dir /
  in-memory stack of N snapshots)?
- **OQ4:** Should predicate language support custom JS callback or
  stay pure structured? (JS = flexible, structured = sandboxable)
- **OQ5:** Hit-event surface — emit into trace as `breakpoint_hit`
  family, or separate channel?

## Acceptance (draft)

- 5+ structured predicate kinds working.
- AND/OR combinators verified.
- Hit limit auto-disables.
- E2E demo: agent sets `mem_write @ $0763 valueEq=$11` while running
  motm, breaks at right cycle.
