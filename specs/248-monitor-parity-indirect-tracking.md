# Spec 248 — VICE monitor parity + indirect r/w/jump tracking

**Sprint:** 124+
**Status:** PROPOSED 2026-05-08
**Depends on:** 206 KernelClient, 232 trace store
**Master:** 230 / 240

## Goal

Match VICE binary monitor surface (`vice_monitor_*` tools) for
headless. Plus: track indirect addressing operations
(`LDA ($zp),Y`, `JMP ($abs)`, `JSR (abs)`) so traces capture the
**resolved** address, not just the indirect operand.

VICE monitor is the de-facto C64-debug language. Headless should
speak it for parity.

## Monitor command surface

| VICE command | Headless equivalent | Status |
|--------------|---------------------|--------|
| `r`          | `runtime_monitor_registers` | exists (`headless_monitor_registers`) |
| `m <range>`  | `runtime_monitor_memory` | exists |
| `d <range>`  | `runtime_monitor_disasm` | partial |
| `g <addr>`   | `runtime_monitor_goto` | new |
| `z`          | `runtime_monitor_step_into` | exists (step) |
| `n`          | `runtime_monitor_step_over` | new |
| `ret`        | `runtime_monitor_step_out` | new |
| `bk <addr>`  | `runtime_monitor_break` | exists (breakpoint) |
| `watch <addr>` | `runtime_monitor_watch` | new (= conditional watchpoint, Spec 241) |
| `bank <name>` | `runtime_monitor_bank` | new (read through current PLA config) |
| `dump <file>` | `runtime_monitor_save` | partial (binary save) |
| `f <range> <pat>` | `runtime_monitor_find` | new |

## Indirect tracking

For every executed instruction with indirect addressing:

```ts
interface IndirectResolution {
  cycle: number;
  pc: number;
  opcode: number;
  mode: "ind" | "izx" | "izy" | "ind_jmp";
  operandAddr: number;        // the indirection pointer
  resolvedAddr: number;       // final target after pointer dereference
  pointerHigh: number;        // page-cross trap edge case
  pointerLow: number;
}
```

Emitted as new event family `mem_indirect_resolve` (extends Spec 232).

## Integration

- Disasm rendering: indirect operands annotated with resolved-target
  addr at trace time.
- Swimlane (Spec 234): adds `c64_resolved_addr` column when row's
  instruction is indirect.
- Routine fingerprinting (Spec 247): can use indirect-jump targets
  for vector-table inference.

## Open questions

- **OQ1:** Should indirect resolution emit per-execution or
  per-distinct-resolution (= dedupe)?
- **OQ2:** Drive-side indirect tracking — same channel or separate?
- **OQ3:** Page-cross bug emulation: indirect JMP at $XXFF reads
  $XX00 instead of $(XX+1)00. Trace this anomaly explicitly?
- **OQ4:** Monitor surface — keep as MCP tool only, or also expose
  as direct REPL command via CLI?
- **OQ5:** `step_over` semantics with self-modifying code — how to
  recover if return address modified?

## Acceptance (draft)

- All 12 monitor commands implemented or explicitly out-of-scope.
- `mem_indirect_resolve` family populates with correct resolved
  addresses for all 6 indirect addressing modes.
- Page-cross JMP $XXFF anomaly visible in trace.
- VICE-binary-monitor MCP tools ↔ headless monitor MCP tools
  produce structurally equivalent output for same scenario step.
