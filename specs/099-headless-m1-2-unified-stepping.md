# Spec 099 — Headless M1.2: Unified Stepping

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 1, story M1.2
Depth: light
Predecessors: Spec 098 (M1.1 session modes)

## Motivation

Stepping APIs are scattered: `runFor(cycles)`, `runForInstructions`, and
ad-hoc breakpoint loops in scripts. Agents need clear, named primitives
for the most common cases (until PC, until raster, until IEC edge,
until stable screen).

## Acceptance

- `session.stepCycles(n)` — exact C64 cycles, drive co-stepped per
  scheduler mode.
- `session.stepInstructions(n)` — n C64 CPU instructions.
- `session.runUntilPc(pc, opts)` — opts: `side: "c64" | "drive"`,
  `budget`, `count` (number of hits to wait for).
- `session.runUntilRaster(line)` — VIC raster line edge.
- `session.runUntilIecEvent(edge)` — `atn-fall`, `atn-rise`, `clk-fall`,
  `clk-rise`, `data-fall`, `data-rise`.
- `session.runUntilStableScreen(opts)` — screen RAM unchanged for N
  frames (default 3).
- All return `{ exitReason, cyclesElapsed, hit? }` where
  `exitReason` is one of `hit | budget | error`.
- MCP tool `headless_session_run` extended with `until` parameter
  accepting any of the above shapes.

## Deliverables

- `src/runtime/headless/stepping.ts`
- EDIT `src/server-tools/headless.ts` (extend `headless_session_run`)
- Smoke: each step API hits expected exit cycle on synthetic fixtures.

## Dependencies

- Spec 098 (mode-aware budgets).

## Risks

- Budget exhaustion handling: `runUntilPc` with no hit must not hang
  or crash. Mitigation: explicit `exitReason: "budget"` and bounded
  budgets.
- Mid-instruction exits break invariants. Mitigation: `stepCycles`
  rounds to instruction boundary in modes where mid-instruction state
  is not snapshot-safe; document per mode.

## Out of scope

- Adding new emulator behavior.
- Trace channels (Milestone 5).
