# VIC-II Literal Port Migration Analysis Plan

Date: 2026-05-10

Audience: Claude / implementation agent.

Status: Analysis plan first. Do not start large code changes until the
questions in Phase 0 are answered in writing.

Related decision document:

- `docs/vic-ii-renderer-architecture-evaluation-2026-05-10.md`

## Goal

Turn the Headless Runtime VIC-II into one authoritative, VICE-faithful,
cycle-driven implementation.

This plan is intentionally split into two horizons:

1. Short term: complete the TypeScript literal VICE VIC-II path so the current
   C64RE UI and reverse-engineering workflows have a correct running emulator.
2. Long term: keep the runtime API stable so the deterministic C64+1541 core
   can later be ported to Rust without rewriting the TypeScript workbench.

Target implementation:

- authoritative VIC-II state comes from the literal VICE `viciisc` port
- raster cycle/line comes from literal VIC
- `$D000-$D3FF` reads/writes come from literal VIC
- raster IRQ comes from literal VIC
- badline / BA / AEC / CPU stall comes from literal VIC
- final framebuffer comes from literal VIC draw cycle
- `rasterized` remains debug/fallback only
- `cycle-pumped` remains temporary validation/support only

Quality target:

- 100% VIC-II semantic fidelity as far as VICE `x64sc` models it
- at least real-time PAL C64 performance in Node
- TypeScript is used where it adds value, but not by inventing new VIC
  semantics outside the literal port
- future Rust/native/WASM core can replace the TypeScript core behind the same
  host API

## Non-Goals

Do not do these during this work:

- Do not fix hard VIC-II bugs in `rasterized` as the main solution.
- Do not create a third renderer.
- Do not game-patch Maniac Mansion, Murder, Last Ninja, or IM2.
- Do not optimize before correctness gates exist.
- Do not use a screenshot alone as proof of cycle correctness.
- Do not keep `VicIIVice` and literal VIC as permanent parallel truth sources.
- Do not refactor the literal port into idiomatic TypeScript before parity is
  proven.
- Do not start the Rust port inside this VIC-II migration task.
- Do not design APIs that expose internal `VicIIVice` or literal-port structs
  directly to UI/MCP code.

## Runtime-Core Boundary Strategy

The TypeScript literal VIC path is the immediate correctness target. It is not
the final performance answer for every future use case.

Expected long-term split:

```text
Rust/native/WASM core, later:
  - CPU 6510
  - VIC-II
  - CIA1/CIA2
  - IEC bus
  - 1541 CPU/VIA/GCR
  - deterministic snapshots / restore / rewind
  - frame and cycle stepping

TypeScript workbench, remains:
  - MCP tools
  - UI and browser server
  - monitor UX and VICE syntax mapping
  - trace ingestion and DuckDB
  - swimlanes and visual analysis
  - project knowledge / artifacts / findings
  - LLM-facing orchestration
```

Therefore, while finishing the TS literal VIC, keep external consumers behind a
stable API shape. Do not let UI, monitor, trace, or MCP code depend on internal
literal-port fields directly.

Candidate API shape to refine later:

```text
RuntimeCore
  reset()
  powerCycle()
  mountDisk(path)
  mountCartridge(path)
  stepCycles(n)
  runUntilFrame()
  runUntilBreakpoint(...)
  readMem(addr)
  writeMem(addr, value)
  readIo(addr)
  writeIo(addr, value)
  getRegisters()
  getVicState()
  getFramebuffer()
  snapshot()
  restore(snapshot)
  traceWindow(...)
```

This API is not part of the first VIC-II implementation slice. It is a boundary
constraint: new code should move toward this shape instead of exposing emulator
internals upward.

## Phase 0: Required Analysis Before Code Changes

Produce a short analysis document before implementing. The document must answer
the questions below with file references.

### 0.1 Current Ownership Map

List every current consumer of `VicIIVice` state and classify it:

- UI display
- PNG/export
- trace/swimlane
- monitor/memory read
- IRQ
- raster line/cycle
- bus stealing / stall
- snapshot / VSF
- tests

For each consumer, say whether it should:

- move to literal VIC
- stay as debug/fallback
- become a facade over literal VIC
- be deleted later

Files to inspect first:

- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/vic/vic-ii-vice.ts`
- `src/runtime/headless/peripherals/vic-renderer-rasterized.ts`
- `src/runtime/headless/vic/literal/*.ts`
- `src/runtime/headless/kernel/*.ts`
- `src/runtime/headless/vsf/module-mapping.ts`

### 0.2 Phase Alignment

Determine the exact phase relationship between:

- CPU `executeCycle()`
- literal `vicii_cycle()`
- VIC Phi1 fetch
- VIC Phi2 fetch
- CPU writes to `$D000-$D3FF`
- IRQ line sampling
- BA/AEC stall application

This must compare:

- VICE `viciisc/vicii-cycle.c`
- VirtualC64 `C64::executeCycle`
- current `IntegratedSession.stepMicrocodedC64Instruction`

The result must state whether our current order:

```text
cpu.executeCycle()
vic.tick(consumed)
```

is correct, off by one phase, or only usable as a temporary bridge.

This is the most important analysis item. Do not proceed to implementation
without a written answer.

### 0.3 Literal Port Completeness

Create a checklist of VICE `viciisc` functionality already ported and missing:

- `vicii-cycle.c`
- `vicii-draw-cycle.c`
- `vicii-fetch.c`
- `vicii-mem.c`
- `vicii-irq.c`
- `vicii-lightpen.c`
- `vicii-chip-model.c`
- `viciitypes.h`

For each item:

- ported
- stubbed
- partially integrated
- not integrated

### 0.4 Dual-Truth Risk List

List every place where the same VIC concept exists in both `VicIIVice` and
literal VIC.

Examples:

- `regs`
- `raster_y` / `raster_line`
- `raster_cycle`
- IRQ status
- badline
- sprite DMA
- frame line logs
- framebuffer
- color RAM handling

For each duplicate, choose a final owner.

## Phase 1: Stop Further Semantic Drift

Purpose: stop adding more competing VIC logic.

Actions:

- Mark `rasterized` as debug/fallback in docs and comments.
- Mark `cycle-pumped` as temporary validation/support.
- Add a short comment in both paths saying final fidelity work must happen in
  the literal port.
- Do not remove anything yet.

Gate:

- No runtime behavior change.
- Tests still pass.

## Phase 2: Literal Register Read/Write Authority

Purpose: all VIC IO semantics move to literal `vicii-mem`.

Actions:

- Route `$D000-$D3FF` writes through literal `vicii_store`.
- Route `$D000-$D3FF` reads through literal `vicii_read`.
- Keep `VicIIVice` only as a comparison/facade during this phase.
- Preserve mirror behavior across `$D000-$D3FF`.
- Preserve unused read bits and read side effects.

Acceptance:

- `$D011/$D012` reads expose current raster line correctly.
- `$D019` read/write behavior matches VICE.
- `$D01E/$D01F` collision read-clear behavior matches VICE.
- `$D016`, `$D018`, color register upper bits match VICE.
- Existing register fidelity tests pass.

Required test shape:

- synthetic direct IO tests
- one minimal PRG that reads `$D011/$D012` around a raster split

## Phase 3: Literal Raster IRQ Authority

Purpose: raster IRQ comes from literal VIC only.

Actions:

- Wire `vicii-irq.ts` host to the real CPU IRQ collector.
- Remove raster IRQ decision-making from `VicIIVice` in fidelity mode.
- Ensure CPU samples IRQ at the same cycle phase as VICE-compatible behavior.

Acceptance:

- Minimal `$D012/$D019/$D01A` raster IRQ PRG matches VICE trace anchors.
- IRQ line state is visible in trace.
- No second raster IRQ source remains active in fidelity mode.

## Phase 4: Literal BA/AEC / CPU Stall Authority

Purpose: badlines and sprite DMA stall the CPU from literal VIC state.

Actions:

- Expose current BA/AEC or stall request from literal cycle execution.
- Machine kernel stalls CPU when literal VIC owns the bus.
- Remove block-accounting bus stealing from fidelity mode.
- Keep old block accounting only for legacy/fast mode if still needed.

Acceptance:

- Badline stall cycle counts match VICE.
- Sprite DMA stall cycle counts match VICE.
- `$D011` badline-sensitive test PRG matches VICE anchors.
- Trace can show `cycle, raster, BA/AEC/stall, CPU PC`.

## Phase 5: Literal Framebuffer Authority

Purpose: screen output comes from literal draw-cycle.

Actions:

- Make literal framebuffer the default for fidelity mode.
- UI C64 screen reads literal framebuffer.
- `renderToPng()` uses literal framebuffer by default in fidelity mode.
- Keep `rasterized` as selectable debug/fallback renderer.

Acceptance:

- BASIC ready screenshot matches VICE reference within agreed pixel tolerance.
- Synthetic `$D020` raster bars match VICE.
- Synthetic `$D018` screen/charset split matches VICE.
- Synthetic `$D016` x-scroll effect matches VICE.
- Synthetic `$D011` y-scroll/split effect matches VICE.

## Phase 6: Remove Dual Truth

Purpose: one VIC-II model remains authoritative.

Actions:

- Replace `VicIIVice` consumers with a literal-state facade.
- Stop mirroring writes to both models.
- Delete or quarantine obsolete semantic paths.
- Keep debug renderers behind explicit flags.

Acceptance:

- In fidelity mode, no code path outside literal VIC decides:
  - raster line
  - raster cycle
  - IRQ
  - badline
  - BA/AEC
  - sprite DMA
  - collision latch
  - final pixels

## Phase 7: Performance Pass

Only after Phase 2-6 correctness gates pass.

Rules:

- Keep hot path allocation-free.
- Use `Uint8Array`, `Uint16Array`, `Uint32Array`.
- Avoid callbacks inside pixel loops once integration is stable.
- Precompute cycle tables.
- Keep trace/debug hooks behind flags.
- Batch trace output outside emulation hot path.

Acceptance:

- At least real-time PAL C64 performance in Node.
- No correctness regression against VICE-backed tests.

If TypeScript remains slower than real-time after hot-path cleanup, do not
weaken emulation semantics. Record the bottlenecks and feed them into the Rust
core design.

## Phase 8: Runtime-Core API Stabilization

Purpose: prepare a future Rust core without blocking the TS literal VIC work.

Actions:

- Define a `RuntimeCore` interface used by UI, MCP tools, monitor, traces, and
  tests.
- Adapt the TypeScript runtime to implement that interface.
- Move direct references to `IntegratedSession`, `VicIIVice`, and literal VIC
  internals behind adapter methods.
- Keep trace/debug APIs explicit so they can be implemented by TS or Rust.

Acceptance:

- UI can render screen and inspect state through `RuntimeCore`.
- Monitor can read/write memory and IO through `RuntimeCore`.
- Trace tools can request cycle/frame windows through `RuntimeCore`.
- No high-level UI/MCP code needs to know whether the backend is TS or Rust.

## Phase 9: Rust Core Spike

This is a later follow-up, not part of the VIC-II TS migration.

Purpose: validate Rust/native/WASM as the deterministic high-performance core.

Spike scope:

- Minimal Rust crate with C64 machine skeleton.
- Node binding via N-API or WASM.
- Implement enough API to run:
  - `reset`
  - `stepCycles(n)`
  - `runUntilFrame`
  - `getFramebuffer`
  - `snapshot`
  - `restore`
- Measure:
  - realtime
  - warp factor
  - snapshot/restore cost
  - trace export overhead

Important:

- Do not run a permanent TS emulator and Rust emulator side by side as two
  semantic truths.
- The TS literal VIC is the correctness bridge and reference while Rust is
  being developed.
- Rust replaces the core behind `RuntimeCore`; it does not replace C64RE.

## Required Test Set

Smoke tests:

- BASIC boot / ready screen
- reset / power cycle
- load a simple PRG

Synthetic VIC tests:

- `$D020` raster bars
- `$D011` y-scroll and raster split
- `$D016` x-scroll timing
- `$D018` screen RAM / charset / bitmap split
- badline CPU stall
- sprite DMA
- sprite/background collision
- sprite/sprite collision

Real media integration tests:

- Maniac Mansion `.g64`
- Murder on the Mississippi `.g64`
- Last Ninja `.g64`
- IM2 `.g64`

Reference requirement:

- Each hard timing test needs a VICE reference frame or trace anchor.
- For difficult cases, compare by `(PC, raster line, raster cycle, register
  write, visible pixel result)`, not screenshot only.

## Deliverable From Claude Before Implementation

Claude should produce one analysis markdown file with:

1. Ownership map.
2. Phase alignment answer.
3. Literal completeness checklist.
4. Dual-truth risk list.
5. Recommended first implementation slice.
6. Explicit "do not investigate" list for the first slice.

The first implementation slice should be narrow. Recommended candidate:

- literal `$D000-$D3FF` reads/writes as authority, with `VicIIVice` kept only
  as comparison/facade.

Do not start with screenshots or game debugging.
