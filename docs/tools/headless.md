# Headless RE Runtime

WIP loader- and depacker-oriented C64 runtime. Faster than a full visible
VICE session, intentionally not cycle-exact. Targets workflows where you
want to:

- run loader and depacker stubs without spinning up the emulator window
- trace KERNAL `SETNAM` / `SETLFS` / `LOAD` / `SAVE` behaviour
- follow `$0001` banking-sensitive control flow
- iterate faster than VICE when VIC / SID accuracy is irrelevant

For everything beyond that scope, fall back to the [VICE runtime](vice.md).

## Sessions

| Tool | Description |
|---|---|
| `headless_session_start` | Start a session, optionally attaching a PRG and D64/G64. |
| `headless_session_status` | Report current state, inferred BASIC `SYS`, and recent loader activity. |
| `headless_session_run` | Run for a bounded number of instructions or until a stop PC. |
| `headless_session_step` | Execute a single instruction. |
| `headless_session_stop` | Stop the current session. |

## Breakpoints / watches / interrupts

| Tool | Description |
|---|---|
| `headless_breakpoint_add` | Execution or read / write / access breakpoints. Memory-access breakpoints fire on the effective address, so they catch indirect pointer-driven accesses too. |
| `headless_breakpoint_clear` | Clear all breakpoints / watchpoints. |
| `headless_watch_add` | Register watched memory ranges; their bytes are embedded directly into trace output when touched. |
| `headless_watch_clear` | Clear watched ranges. |
| `headless_interrupt_request` | Request a pending IRQ or NMI. |
| `headless_interrupt_clear` | Clear pending IRQ/NMI state. |
| `headless_io_interrupt_trigger` | Trigger simple VIC / CIA interrupt sources via emulated I/O status / mask registers. |

## Trace queries

Persisted trace lives at
`analysis/headless-runtime/<session>/trace/runtime-trace.jsonl`.

| Tool | Description |
|---|---|
| `headless_trace_tail` | Render recent trace events with accesses, stack, bank state, watch hits. |
| `headless_trace_find_pc` | Search the persisted trace for a specific PC. |
| `headless_trace_find_access` | Search for reads / writes to an effective address. |
| `headless_trace_slice` | Slice the trace around an event index. |
| `headless_trace_build_index` | Build a persistent PC / access hotspot index for the session. |

## Monitor

| Tool | Description |
|---|---|
| `headless_monitor_registers` | Read CPU registers. |
| `headless_monitor_memory` | Read a memory range. |

## Current first-slice scope

- 6510 CPU core with RAM / ROM windows and `$0001` banking
- KERNAL traps for `SETNAM`, `SETLFS`, `LOAD`, `SAVE`
- D64 / G64-backed disk provider for loader-following
- CRT-backed mappers: EasyFlash (with simple AMD-style flash writes),
  Magic Desk, Ocean, generic 8K / 16K, Ultimax
- Per-instruction memory access log + watched-range snapshots

## Out of scope (today)

- VIC / SID / CIA behaviour beyond simple memory / I/O stubs
- Cycle-exact IRQ / NMI timing and side effects
- Cartridge mappers beyond the EasyFlash / generic slice
- Protovision MegaByter and other writable mapper families
