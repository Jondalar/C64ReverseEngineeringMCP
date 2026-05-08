# Spec 230 — V2 LLM workbench (master spec)

**Sprint:** 124 (V2 epic kickoff)
**Status:** PROPOSED 2026-05-08
**Depends on:** 200-220 (V1 core complete)
**Companion:** EPIC_ROADMAP.md §V2.0

## Goal

Make the headless emulator queryable by an LLM agent. V1 made the
emulator silicon-equivalent against VICE; V2 turns that runtime into
structured evidence for reverse-engineering work.

The LLM does not drive emulation. It asks `KernelClient` (Spec 206)
to advance, snapshot, trace, diff, and project the resulting state
into reasoning. The agent's goal: explain why a routine behaves a
specific way, locate divergences from VICE, link runtime events to
disassembly, and propose annotations.

## Workbench primitives (refined V1 → V2)

V1 already ships the emulator and its raw API. V2 layers structured
abstractions on top:

| Primitive | V1 status | V2 work |
|-----------|-----------|---------|
| Run / step / pause | KernelClient (206) | run-budget contract + breakpoint events |
| Snapshot | session.snapshot (134, 206) | content-addressed, diff-friendly, agent-readable |
| Trace | TraceRegistry (205) | event-indexed store + canonical event families |
| Diff vs VICE | first-divergence CLI (205-B) | structured divergence record + agent reportable |
| Memory query | KernelClient.readMemory | annotated by segment / symbol |
| Disassembly | pipeline disasm | linked to runtime PC events |
| Annotation | propose_annotations (042) | accepts runtime evidence as justification |

## Sub-spec lineup (V2 backlog)

Each becomes its own spec under 231..238. Order is dependency-driven.

### 231 — Deterministic replay & rerun

Re-running the same scenario from snapshot must produce the
byte-identical trace. Same CPU/CIA/VIC/SID alarm ordering, same RAM
end-state, same screenshot hash. Acceptance: `npm run test:replay`
runs scenario X twice, produces identical trace.jsonl + RAM diff = 0.

**Depends on:** 134 (snapshot), 205 (trace).

### 232 — Event-indexed trace store schema

Canonical event families (cpu_step, mem_access, irq_assert, irq_ack,
nmi_assert, vic_badline, vic_raster_irq, cia_timer_underflow,
sid_register_write, drive_atn_change, drive_data_change, gcr_byte,
keyboard_press). Each event has fixed schema columns; trace store is
DuckDB (Spec 217) with bounded ring per channel.

Agent queries: `find_events(family, predicate, range)`,
`event_chain(start_event, depth)`, `events_at_pc(pc, n)`.

**Depends on:** 205 (trace contract), 217 (duckdb store).

### 233 — Follow-a-path tracing

Given a starting event (e.g. `mem_write @ $0763 by PC=$05B7`),
return the chain of preceding causal events that led to it,
projected onto disassembly. Bounded by depth + cycle window.

**Depends on:** 232.

### 234 — Transaction-level swimlane

Single shared timeline: c64 CPU instruction, c64 IO read/write,
resolved bus line state (ATN/CLK/DATA), drive IO read/write, drive
CPU instruction. One row per c64 cycle (or per bus event). Already
prototyped in 205-B; promote to first-class agent surface.

**Depends on:** 232, 205-B.

### 235 — Runtime evidence ↔ disassembly link

Every PC sample in trace resolves to:
- nearest label / routine annotation
- segment classification (code / data / pointer-table / unknown)
- source disassembly line if the artifact is registered

Agent receives `enriched_event` rows: cycle, PC, opcode mnemonic,
operand resolution, segment label, calling context.

**Depends on:** 232, pipeline disasm output.

### 236 — First-divergence comparison vs VICE

Extend 205-B. Given a scenario, run both VICE and headless,
compare canonical event streams, locate first divergence in:
- cpu register state at instruction N
- IO write at cycle K
- VIA/CIA register read
- IEC line state

Output structured `DivergenceRecord` with what diverged, where, by
how many cycles, what each side held. Agent uses this as primary
debug input.

**Depends on:** 232, 205, 205-B.

### 237 — Agent query API (KernelClient extension)

Higher-level methods consumed by V2 MCP tools:
- `inspect_routine(addr) → routine_record` (entry_pc, exits, length, called_from, calls_to, register_use)
- `evidence_for_segment(addr_range) → execution_count, write_set, read_set, ref_count`
- `replay_until(predicate) → trace_slice`
- `query_events(filter) → event_rows`
- `compare_run_against(scenario_id) → DivergenceRecord`

Stable surface separate from raw KernelClient.

**Depends on:** 231-236, 206 KernelClient.

### 238 — V2 MCP tool layer

Replace ad-hoc `headless_*` tools with V2 agent surface:
- `runtime_inspect_routine`
- `runtime_evidence_for_segment`
- `runtime_query_events`
- `runtime_compare_with_vice`
- `runtime_follow_path`
- `runtime_swimlane_slice`

Each tool returns structured rows that fit `save_finding` /
`save_open_question` directly. Old `headless_*` tools deprecated
but kept until 240+ migration.

**Depends on:** 237.

## Sequencing

| Sprint | Sub-spec | Parallelizable |
|--------|----------|----------------|
| 124    | 231 (replay) | sequential |
| 125    | 232 (trace store) | sequential |
| 126    | 233 + 234 | parallel (independent on 232) |
| 127    | 235 + 236 | parallel |
| 128    | 237 (query API) | sequential |
| 129    | 238 (MCP tools) | sequential |

## Acceptance gate (V2)

- Agent can answer "why does PC stall at $05B7?" with structured
  evidence: list of events leading to stall, divergence point vs
  VICE, register state, segment classification of involved bytes.
- Replay byte-identical from snapshot.
- Trace store handles ≥10M events without OOM.
- MCP tool calls round-trip in <500ms for typical queries (slice of
  ~1000 events).

## Out-of-scope (V3)

- Pixel-perfect VIC renderer
- Audio playback
- UI consumer of these primitives

V3 sits on top of V2; V2 is the data layer, V3 is the human view.
