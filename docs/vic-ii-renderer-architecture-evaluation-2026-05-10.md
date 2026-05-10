# VIC-II Renderer Architecture Evaluation

Date: 2026-05-10

Scope: Compare the current Headless Runtime VIC rendering paths against VICE
and VirtualC64, then define the target architecture for 100% VIC-II fidelity
with at least real-time C64 performance.

## Executive Summary

The `rasterized` renderer is useful as a transitional renderer and debugging
view. It should not become the final VIC-II architecture because it rebuilds
VIC behavior after the fact from register-change logs.

The `literal` VICE port is the correct candidate for the final VIC-II core.
It ports the VICE `viciisc` cycle/fetch/draw/memory logic into TypeScript and
can become cycle-faithful if it is made the single source of truth.

The current main risk is not TypeScript. The risk is hybrid architecture:
`VicIIVice`, `rasterized`, `cycle-pumped`, and `literal` still overlap. As long
as reads, writes, IRQ, raster position, bus stealing, and framebuffer emission
come from different partial models, hard raster effects will keep failing.

Runtime strategy:

- Short term: finish the TypeScript literal VICE VIC-II path so the current
  UI, screenshots, monitor, and reverse-engineering workflows have a correct
  running state.
- Medium term: define and enforce a stable runtime-core API boundary. UI, MCP,
  trace, monitor, and project knowledge must talk to this API, not to internal
  emulator classes.
- Long term: port the deterministic C64+1541 core behind the same API to Rust
  for native/WASM performance, warp, rewind, and long-running trace workloads.

## Source Baseline

### VICE

Primary local reference:

- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-cycle.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-draw-cycle.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-fetch.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-mem.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-irq.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-chip-model.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/viciitypes.h`

Architectural shape:

- VIC-II is cycle-driven.
- Register writes go through `vicii_store` and update derived state immediately.
- `vicii_cycle()` owns raster cycle, fetch phases, draw cycle, badline state,
  sprite DMA, collisions, raster IRQ, and line/frame progression.
- Rendering is not reconstructed at frame end. Pixels are emitted from the
  current cycle state.

### VirtualC64

Reference repo: `https://github.com/vc64web/virtualc64web`

Important files:

- `Emulator/Components/C64.cpp`
- `Emulator/Components/VICII/VICIICycles.cpp`
- `Emulator/Components/VICII/VICIIMemory.cpp`
- `Emulator/Components/VICII/VICIIDraw.cpp`
- `Emulator/Components/VICII/VICIISprites.cpp`

Architectural shape:

- Own C++ emulator core, not VICE.
- Browser version compiles VirtualC64 to WebAssembly via Emscripten.
- C64 execution is per-cycle. Each cycle executes events/VIC/CPU/drive in a
  fixed phase order.
- VIC-II has explicit cycle functions and register side effects.

The relevant lesson is the same as VICE: the video chip is a timed hardware
component in the machine loop, not a post-processing renderer.

## Implementation Comparison

| Area | VICE | VirtualC64 | Headless Runtime: rasterized | Headless Runtime: literal port | Delta / Decision |
|---|---|---|---|---|---|
| Core model | `viciisc` cycle core | Own cycle core | Frame/line replay from logs | VICE `viciisc` port | Literal should be target |
| CPU/VIC timing | Shared clock / alarms | Per-cycle machine loop | Depends on prior logs | Can run per cycle via hook | Per-cycle literal must be default |
| Register writes | `vicii_store` | `VICII::poke` | Logged and replayed | `vicii_store` ported | Writes should only hit literal source of truth |
| Register reads | `vicii_read` | `VICII::peek` | Reads still from `VicIIVice` | Not fully authoritative yet | Move reads to literal |
| `$D011` | Immediate side effects | Immediate side effects | Often normalized into next-line changes | Port has `d011_store` | Literal only; no generic replay rule |
| `$D016` | Immediate side effects | Immediate side effects | Replay/lane state | Port has `d016_store` | Literal only |
| `$D018` | Fetch-time memory pointer source | VIC memory select | Recomputed from state | Port has `d018_store` and fetch logic | Fetch must come from literal |
| Raster IRQ | VIC-owned IRQ state | VIC-owned IRQ state | `VicIIVice` owns it | IRQ host currently not final | Move IRQ source to literal |
| Badlines | VIC-owned, affects BA/AEC | VIC-owned | Approx/replay/block model | Port has cycle logic | Literal must drive CPU stall |
| BA/AEC | Cycle-owned bus ownership | Cycle-owned BA logic | Partial / optional per-cycle | Cycle table has BA data | Literal must own bus stealing |
| Display pipeline | Cycle draw | Cycle draw | Per-line emit from reconstructed state | VICE draw-cycle port | Literal framebuffer must replace rasterized |
| Sprites | DMA, shifters, collisions | DMA, shifters, collisions | Partial per-line sprite render | VICE sprite/draw-cycle state | Literal required for multiplex tricks |
| Collisions | Pixel-time latch | Pixel-time logic | Frame-end OR approximation | Draw-cycle collision path ported | Literal must be authoritative |
| Chip revisions | Tables | Traits | Mostly PAL assumptions | PAL 6569R3 hardwired for now | OK short-term, generalize later |
| Performance | C | C++ | Good line performance | Unknown but likely viable | Optimize literal after correctness |

## Evaluation: Rasterized Renderer

Current files:

- `src/runtime/headless/peripherals/vic-renderer-rasterized.ts`
- `src/runtime/headless/vic/raster-changes-builder.ts`
- `src/runtime/headless/vic/raster-state.ts`

### What It Does Well

- Gives a useful visual result for many normal screens.
- Makes register-change effects easy to inspect.
- Is simpler to debug than a cycle pipeline.
- Can remain useful as a debug/legacy renderer.
- Can produce readable diffs while the literal port matures.

### Hard Limit

It is a reconstruction layer. It walks recorded writes and mutates a synthetic
`RasterState`. This cannot reliably model all C64 effects that depend on the
exact interaction between:

- CPU write cycle
- VIC fetch phase
- shift registers
- badline state
- border flip-flops
- sprite DMA
- collision latches
- BA/AEC bus ownership

Example risk: routing `$D011` / `$D016` changes through generic next-line lane
logic loses the precise chip behavior for mid-line and split-screen effects.
Some effects will work by coincidence, others will fail.

### Verdict

`rasterized` is not the final renderer. Freeze it as:

- fallback renderer
- debug visualization
- regression comparison mode
- temporary UI renderer until literal is stable

Do not keep fixing deep VIC-II fidelity bugs in this path unless the fix is
also needed for debug output.

## Evaluation: Literal VICE Port

Current files:

- `src/runtime/headless/vic/literal/vicii-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-draw-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-fetch.ts`
- `src/runtime/headless/vic/literal/vicii-mem.ts`
- `src/runtime/headless/vic/literal/vicii-irq.ts`
- `src/runtime/headless/vic/literal/vicii-chip-model.ts`
- `src/runtime/headless/vic/literal/vicii-types.ts`
- `src/runtime/headless/vic/literal/vicii.ts`

Integration:

- `src/runtime/headless/integrated-session.ts`
- `useLiteralPortRenderer`
- `useLiteralPortVicPerCycle`

### What It Does Well

- Preserves VICE function names and control flow.
- Ports fetch, draw-cycle, register store side effects, cycle table, sprite
  state, and collision logic in the right architectural shape.
- Can become the one true VIC-II state machine.
- Is compatible with TypeScript performance if kept C-like and allocation-free
  in the hot path.

### Current Risk

The literal port is still integrated beside `VicIIVice`, not instead of it.
Current integration mirrors writes into both models:

- literal `vicii_store`
- then `VicIIVice.write`

Reads, IRQ, raster state, bus stealing, and UI state are not all sourced from
literal yet. This creates two VIC truths. That is acceptable during migration
but cannot be the final architecture.

### Verdict

Literal port is the target architecture. Continue it, but shift effort from
"more renderers" to "make literal authoritative".

## Evaluation: Cycle-Pumped Renderer

Current files:

- `src/runtime/headless/vic/cycle-pumped-renderer.ts`
- `src/runtime/headless/vic/cycle-driven-line-renderer.ts`
- `src/runtime/headless/vic/display-pipe.ts`
- `src/runtime/headless/vic/fetch-phi1.ts`

This path is a custom TypeScript reimplementation of VICE-like cycle behavior.
It was useful as a learning and stepping stone, but it now competes with the
literal port.

Verdict: do not evolve this into the final renderer. Keep only as test/support
code if it helps verify the literal port. The final semantics should come from
the literal VICE port.

## Target Architecture

### Principle

There must be exactly one authoritative VIC-II model.

Target:

```text
Machine Kernel
  -> CPU cycle
  -> VIC literal cycle
  -> CIA cycle
  -> SID cycle
  -> Drive catch-up / drive cycle domain
  -> Trace/export hooks
```

The exact phase order must be validated against VICE/VirtualC64 behavior and
gold-master traces. The important rule is: no instruction-batched VIC updates
for fidelity mode.

### Responsibilities

Literal VIC owns:

- `$D000-$D3FF` reads/writes
- raster line/cycle
- raster IRQ state and CPU IRQ line contribution
- badline state
- BA/AEC / CPU stall requests
- VIC bank and fetch addressing
- screen/char/bitmap/color fetch
- display pipeline
- border state
- sprite DMA and sprite shift registers
- sprite/background and sprite/sprite collisions
- final framebuffer color indices

Adapters own:

- exposing VIC state to UI
- trace events
- monitor reads/writes
- PNG/video export
- RE annotations
- debug lanes/swimlanes

`VicIIVice` should become:

1. a compatibility facade over literal state, then
2. removable.

`rasterized` should become:

1. fallback/debug renderer, then
2. optional comparison tool.

## Follow-up Plan

The implementation and analysis plan is intentionally split into a separate
document:

- `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`

This evaluation document states the architectural decision. The follow-up plan
defines how Claude should analyze the current code and turn the literal port
into the only authoritative VIC-II implementation.

## Decision

Use the literal VICE port as the final TypeScript VIC-II architecture.

Keep `rasterized` as a debug and fallback renderer. Do not use it as the target
for 100% VIC-II fidelity.

Keep custom cycle-pumped renderer code only as a temporary validation aid. Do
not let it become a second implementation path.

The main architecture work is now integration, not more rendering fixes:

1. literal reads
2. literal IRQ
3. literal BA/AEC
4. literal framebuffer as default
5. removal of dual VIC truth

After the TypeScript literal VIC path is correct, the broader runtime should
move toward a stable `RuntimeCore` API so a later Rust C64+1541 core can replace
the TypeScript core without rewriting C64RE UI, MCP tools, traces, or
reverse-engineering workflows.
