# Headless C64 Runtime Plan

## Objective

Build a headless, non-cycle-exact C64 runtime for reverse engineering and debugging that complements the existing VICE integration.

Primary goals:

- run loaders and depackers without launching VICE
- reconstruct program flow quickly and deterministically
- inspect banking, memory writes, and loader behavior
- expose trace/debug hooks directly to MCP tools
- preserve VICE as the fallback for timing-sensitive or hardware-accurate cases

This runtime is **not** intended to be a full demo-grade or cycle-exact emulator.

## Non-Goals

Out of scope for the first useful delivery:

- cycle-exact VIC/SID/CIA timing
- raster-accurate demo compatibility
- full game-playable C64 emulation
- full IEC bus or analog 1541 behavior
- perfect compatibility with arbitrary undocumented hardware tricks

## Design Principles

1. Prefer **instrumentability** over fidelity.
2. Prefer **loader/depacker success** over complete machine coverage.
3. Keep the **raw execution trace structured and searchable**.
4. Treat VICE as the **validation and hard-case backend**, not the primary path.
5. Design the runtime so that **semantic annotations** can be linked directly to execution.

## Target Capabilities

### First-Class Use Cases

- execute Exomizer/ByteBoozer/custom self-extracting stubs
- emulate BASIC `SYS` loaders and KERNAL `LOAD`/`SAVE` workflows
- run cartridge boot code for common banking schemes
- stop at breakpoints and inspect memory/register state
- trace execution windows around bugs or transitions
- save reconstructed/depacked memory ranges to PRG or raw binary

### Typical RE Questions This Runtime Should Answer

- what file does this loader try to load next?
- which routine writes the depacked payload into memory?
- which bank is active when this code runs?
- where does the program switch from boot code to main logic?
- what memory range changed during this decrunch step?

## Architecture

### 1. CPU Core

Module:

- `src/runtime/headless/cpu6510.ts`

Responsibilities:

- execute legal 6510 opcodes
- optionally support illegal opcodes later
- expose registers (`PC`, `A`, `X`, `Y`, `SP`, flags)
- support reset, IRQ, NMI entry
- count approximate cycles for ordering and trace continuity

Notes:

- cycle accuracy is not required
- instruction ordering and visible side effects are required

### 2. Memory Bus

Module:

- `src/runtime/headless/memory-bus.ts`

Responsibilities:

- central read/write dispatch
- RAM/ROM/I/O/window mapping
- read/write/execute hooks
- banked cartridge and ROM visibility

Proposed hooks:

- `onExecute(pc)`
- `onRead(addr, value)`
- `onWrite(addr, value)`
- `onCall(target, source)`

### 3. Banking Model

Modules:

- `src/runtime/headless/c64-banking.ts`
- `src/runtime/headless/cartridge-mapper.ts`

Responsibilities:

- `$0001` CPU port banking
- BASIC/KERNAL/CHAR/I/O visibility
- ROML/ROMH mapping
- cartridge-specific banking state

Initial mapper targets:

- EasyFlash
- Magic Desk
- Ocean

### 4. ROM and Trap Layer

Modules:

- `src/runtime/headless/kernal-traps.ts`
- `src/runtime/headless/rom-images.ts`

Responsibilities:

- provide ROM images when needed
- intercept high-value KERNAL calls
- emulate side effects without requiring a full ROM implementation

Initial trap set:

- `SETNAM`
- `SETLFS`
- `LOAD`
- `SAVE`

Likely next:

- `OPEN`
- `CLOSE`
- `CHKIN`
- `CHKOUT`
- `CHRIN`
- `CHROUT`

Key idea:

- for RE, a semantic implementation of `LOAD` is far more valuable than a perfect IEC bus simulation

### 5. Media Providers

Modules:

- `src/runtime/headless/providers/prg-provider.ts`
- `src/runtime/headless/providers/disk-provider.ts`
- `src/runtime/headless/providers/cartridge-provider.ts`

Responsibilities:

- load PRGs directly into memory
- resolve D64/G64 file names to contents
- provide cartridge ROM content/banks to mappers

Initial disk requirements:

- read directory
- resolve file by PETSCII-ish name/pattern
- deliver PRG bytes and load address

Track/sector-level access is optional at first, but should remain possible for advanced loaders.

### 6. Trace and Debug Layer

Modules:

- `src/runtime/headless/runtime-session.ts`
- `src/runtime/headless/trace-collector.ts`
- `src/runtime/headless/trace-index.ts`

Responsibilities:

- breakpoints
- watchpoints
- run-until
- execution slices
- memory access logging
- call-path reconstruction
- continuity metrics

Important output principles:

- keep raw trace as structured ground truth
- emit indexable summaries for LLM queries
- keep bookmarks/notes separate from the raw trace

### 7. Semantic Link Layer

Modules:

- `src/runtime/headless/semantic-link.ts`

Responsibilities:

- map executed PCs back to:
  - labels
  - routine names
  - segment kinds
  - annotation comments
- map operands to known symbols where possible

Expected result shape:

- `pcHex: "$63A1"`
- `label: "decrement_life_stock_triplet"`
- `routineName: "Decrement Life Stock Triplet"`
- `segmentKind: "code"`
- `operandHex: "$DC01"`
- `operandSymbol: "CIA1_PRA"`

## MCP Surface

The headless runtime should mirror the VICE mental model where possible.

Suggested tools:

- `runtime_session_start`
- `runtime_session_status`
- `runtime_session_stop`
- `runtime_run`
- `runtime_breakpoint_add`
- `runtime_breakpoint_list`
- `runtime_breakpoint_delete`
- `runtime_registers`
- `runtime_memory`
- `runtime_write_memory`
- `runtime_set_registers`
- `runtime_save`
- `runtime_binary_save`
- `runtime_trace_start`
- `runtime_trace_stop`
- `runtime_trace_status`
- `runtime_trace_find_pc`
- `runtime_trace_find_memory_access`
- `runtime_trace_slice`
- `runtime_trace_call_path`

Suggested prompts:

- `headless_debug_workflow`
- `loader_runtime_workflow`

## Milestones

### Milestone 1: CPU + Bus + Banking

Deliver:

- CPU core extracted from current Exomizer SFX runtime
- generic memory bus
- `$0001` banking
- RAM + ROM windows

Acceptance:

- small hand-written loader snippets run correctly
- simple PRGs can execute to a chosen breakpoint

### Milestone 2: KERNAL Loader Traps

Deliver:

- trap implementations for `SETNAM`, `SETLFS`, `LOAD`, `SAVE`
- PRG provider
- D64 file lookup provider

Acceptance:

- BASIC `SYS` loader stubs can load the next stage without VICE
- static and runtime evidence agree on loaded file names

### Milestone 3: Cartridge Mappers

Deliver:

- EasyFlash mapper
- Magic Desk mapper
- Ocean mapper

Acceptance:

- boot code can bank-switch and reach main entry
- mapper state is visible in trace/debug tools

### Milestone 4: Debug/Trace API

Deliver:

- breakpoints/watchpoints
- execution slices
- memory access search
- call path
- bookmarks/notes

Acceptance:

- an LLM can debug a loader/depacker path iteratively without raw-trace overload

### Milestone 5: Semantic Integration

Deliver:

- PC and operand symbol linking
- index artifacts tied to `_annotations.json`

Acceptance:

- trace slices are directly readable in semantic terms, not just raw addresses

## Validation Cases

Required test corpus:

1. Exomizer raw
2. Exomizer SFX
3. ByteBoozer2 raw/executable
4. `crystian` stage-1 disk loader
5. D64/G64 file-loading path
6. EasyFlash startup path
7. one Ocean or Magic Desk sample

Validation strategy:

- first match functional output
- then compare selected states/traces with VICE
- only use VICE parity where it adds real confidence

## Recommended Build Order

1. CPU core hardening
2. memory bus
3. `$0001` banking
4. KERNAL traps
5. PRG + D64 providers
6. trace/debug API
7. cartridge mappers
8. semantic link layer

## Practical Summary

Build a **loader-oriented analysis runtime**, not a perfect C64.

Success means:

- loaders run
- depackers run
- banks can be observed
- traces can be searched
- memory outputs can be captured
- the LLM can reason over short, linked slices instead of millions of raw events

If a case exceeds the headless runtime's scope, fall back to VICE.
