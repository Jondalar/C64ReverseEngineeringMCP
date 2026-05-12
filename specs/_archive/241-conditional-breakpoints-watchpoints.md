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

## VICE feature parity (mandatory baseline)

Reference: https://vice-emu.sourceforge.io/vice_12.html

Must support at minimum:

- `break addr` (exec) / `break load addr` / `break store addr`
- `break addr if <cond>` — conditional with C-like expression
  (registers a/x/y/sp/pc, `@addr` mem deref, arithmetic, &/|/^,
  comparison)
- `watch addr` (= break load|store)
- `tracepoint addr` — log without halt
- `delete <id>` / `disable <id>` / `enable <id>`
- `condition <id> <expr>` — attach condition to existing
- `command <id> <cmd>` — auto-execute on hit
- `ignore <id> <count>` — skip first N hits
- `until addr` — run-to

Beyond VICE: structured predicate AND/OR combinator, multi-criteria,
agent-shaped JSON output for hit events.

## Open questions

- **OQ1 [RESOLVED 2026-05-08]:** Multiple breakpoints same-cycle =
  all-fire. Each predicate evaluated, each hit recorded as
  `breakpoint_hit` event. Action `halt` fires after all evals.
- **OQ2:** Watchpoint scope — only c64 main bus, or also drive bus
  (= mem_write @ $1800 etc)?
- **OQ3:** Action `snapshot` saves where? (= /tmp / project dir /
  in-memory stack of N snapshots)?
- **OQ4 [RESOLVED 2026-05-08]:** **JS callback as primary**, plus
  structured JSON predicate tree + VICE-style expression string as
  convenience layers (both compile to callback internally).
  Reasoning: local dev tool, agent IS the user. Operational risks
  (infinite loop, throws) handled by per-eval timeout + try/catch.
  No prompt-injection threat model here.

  Callback signature:
  ```ts
  (ctx: BreakpointContext) => boolean;
  interface BreakpointContext {
    cycle: number;
    cpu: { pc, a, x, y, sp, flags };
    mem(addr: number): number;
    io(addr: number): number;
    irqPending: boolean;
    nmiPending: boolean;
    drive?: { pc, a, x, y };
  }
  ```

  Per-eval budget: 1ms default. Exceeding budget disables
  breakpoint with audit-log entry.
- **OQ5:** Hit-event surface — emit into trace as `breakpoint_hit`
  family, or separate channel?

## Acceptance (draft)

- 5+ structured predicate kinds working.
- AND/OR combinators verified.
- Hit limit auto-disables.
- E2E demo: agent sets `mem_write @ $0763 valueEq=$11` while running
  motm, breaks at right cycle.
