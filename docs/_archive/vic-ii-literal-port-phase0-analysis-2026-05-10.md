# VIC-II Literal Port Migration — Phase 0 Analysis

Date: 2026-05-10

Related:
- `docs/vic-ii-renderer-architecture-evaluation-2026-05-10.md` (decision)
- `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md` (plan)

This document is the Phase 0 deliverable required by the migration plan
before any code changes to the literal port may proceed. It synthesizes
four parallel sub-audits (0.1 ownership map, 0.2 phase alignment, 0.3
literal completeness, 0.4 dual-truth risk) and recommends the first
implementation slice plus an explicit do-not-investigate list.

## TL;DR

- Literal port is ~85% complete vs VICE viciisc source.
- Current scheduler (`cpu.executeCycle()` then `vic.tick(consumed)` in
  per-cycle mode) is CORRECT-WITH-CAVEATS. No scheduler restructure
  required before Phase 2.
- 24 duplicate concepts between `VicIIVice` and the literal port.
- Five things VicIIVice does that the literal port cannot do yet:
  alarm-driven raster IRQ, framebuffer pixel emission, per-scanline
  snapshot capture, block-mode bus stealing, register write log.
- Recommended first slice: **literal `$D000-$D3FF` reads + writes as
  authoritative**, with VicIIVice retained as comparison facade.
- Recommended do-not-investigate: game-level debugging, screenshot-only
  acceptance, rasterized renderer fixes, lightpen, REU, perf passes,
  literal port idiomatic refactor.

## 0.1 Ownership Map

Consumer sites of `VicIIVice` state, classified by category and
recommended fate.

| Category | Sites | Fate |
|---|---|---|
| Register read/write (regs, $D0xx writes) | 8 | move-to-literal |
| Raster line/cycle (raster_y, screen_height, cycles_per_line) | 5 | move-to-literal |
| IRQ source (irqAsserted, raster IRQ) | 4 | move-to-literal |
| BA/AEC/stall (getBusStallForCycle, bad_line) | 3 | move-to-literal |
| System cycle pump (tick, reset, init) | 3 | move-to-literal |
| Snapshot/VSF (regs, raster_irq_clk, vbank, ptrs) | 3 | move-to-literal |
| Trace/swimlane (onCycle hook) | 2 | move-to-literal |
| UI display renderers (vic-renderer*.ts) | 10 | become-facade-over-literal |
| Tests (vic-fidelity-tests.ts) | 1 | delete-later |

Patterns observed:

1. **All renderers go through `regs[]` + `scanlineSnapshots[]` + helper
   methods.** Facade only needs to expose those three surfaces; renderer
   code itself does not need to change.
2. **Collision flags ($D01E/$D01F) are written by renderers, not read.**
   Literal must preserve write-only-from-outside semantic.
3. **Memory pointer access goes through helper methods** (`screenRamOffset`,
   `charRomOffsetWithinBank`, `bitmapBaseWithinBank`), not raw struct
   fields. VSF is the only consumer that reads raw `screen_ptr`,
   `chargen_ptr`, `bitmap_ptr`.
4. **Hook-based observers (`onCycle`, `onRasterLine`, `onFrame`) drive
   downstream consumers.** Literal port must provide identical hook
   signatures.
5. **No external mutator writes to non-`regs` fields.** All state
   mutation flows through `vicii_store` / register writes.

Implication: facade can be thin. Renderers stay if facade exposes
`regs`, snapshots, helper methods, and hook signatures verbatim.

## 0.2 Phase Alignment

Three implementations compared:

- VICE viciisc: `vicii_cycle()` runs AFTER CPU each machine cycle. Phi1
  fetch happens early in `vicii_cycle()`; CPU $D0xx writes from the
  just-finished CPU cycle land in time for that fetch.
- VirtualC64: per-cycle order is `events → vic → cpu`. VIC runs first;
  CPU writes take effect next cycle.
- Headless legacy (`useLiteralPortVicPerCycle=false`): CPU runs full
  instruction, then `vic.tick(consumed)` advances all cycles at once.
- Headless per-cycle (`useLiteralPortVicPerCycle=true`): per CPU bus
  cycle, run `updateMicrocodedInterruptLines()` → `cpu.executeCycle()`
  → `vic.tick(1)`. Inside `vic.tick(1)` with `onCycle` hook, the literal
  port runs BEFORE `raster_cycle` advances.

### Verdict

**CORRECT WITH CAVEATS.** The headless per-cycle path matches VICE in
spirit:

- Per-cycle granularity present.
- Hook fires before raster cycle advances → literal Phi1 sees register
  state from prior CPU cycle, matching VICE behavior.

Caveat: CPU writes to `$D000-$D3FF` mid-instruction land on the bus
1-3 cycles before the literal hook sees them, because the write happens
at the current bus cycle but the literal hook fires AFTER `cpu.executeCycle()`
returns. Effect: split-raster effects (mid-line `$D020`, `$D018`,
`$D016`, `$D011` writes) may show ±1-2 raster-cycle drift vs VICE.

### Implication for migration

Phase 2 (literal reads/writes authoritative) can land on the current
scheduler without restructuring. Recommended mitigations during Phase 2:

- Add ±1-2 raster-cycle tolerance to split-raster acceptance tests.
- Optional: add a write-cache buffer in `integrated-session.ts` that
  stages CPU `$D000-$D3FF` writes and injects them into the literal
  hook before raster advances, simulating VICE same-cycle observation.

Phase 3 (raster IRQ) and Phase 4 (BA/AEC stall) WILL require a
clock-source decision: either keep `VicIIVice` as alarm-driver bridge
or port VICE's alarm dispatch. Defer the decision to Phase 0.5 of the
NEXT phase block — not this slice.

## 0.3 Literal Port Completeness

| File | Completeness | Status |
|---|---|---|
| vicii-fetch.c | 100% | complete |
| vicii-irq.c | 100% | complete |
| vicii-chip-model.c | 100% | complete |
| viciitypes.h | 100% | complete |
| vicii-draw-cycle.c | 90% | snapshot routines deferred |
| vicii-cycle.c | 78% | `vicii_cycle_reu`, `vicii_steal_cycles` missing |
| vicii-mem.c | 78% | vbank dispatch, colorram init missing |
| vicii-lightpen.c | 0% | dedicated file not ported; stub-only |
| **Overall** | **85%** | 68/80 top-level functions ported |

### Top 5 holes blocking "literal authoritative" status

1. **`vicii_cycle_reu`** — REU variant cycle loop. Diverges on
   REU-aware emulation. Acceptable defer for first slice (no REU games
   in corpus).
2. **vicii-lightpen.c** — Light pen timing + external setter. Only
   `vicii_trigger_light_pen_internal` stubbed. Defer (no light-pen
   games in corpus).
3. **vbank dispatch (`vicii_mem_vbank_*_store`)** — Cartridge bank
   write paths. Default CIA2 PA bit-bang path works; deferred functions
   are edge cases. Defer.
4. **Snapshot routines (`vicii_draw_cycle_snapshot_{read,write}`)** —
   VICE state save/restore. Non-load-bearing for fidelity. Defer.
5. **`vicii_steal_cycles`** — DMA cycle theft accounting. Affects
   cycle-exact CPU/VIC alignment for badline/sprite DMA stall. Required
   for Phase 4, NOT for Phase 2.

### Extra TS items beyond VICE

- `setFetchHost` / `setIrqHost` / `setMaincpuClk` — host integration
  hooks. Justified, accept.
- `vicii_bind_ram` — headless RAM binding. Justified, accept.

## 0.4 Dual-Truth Risk List

24 concepts duplicated between `VicIIVice` and literal port.

### Top 5 highest-risk duplicates

| # | Concept | Risk | Reason |
|---|---|---|---|
| 1 | raster_irq_clk (alarm) | HIGH | VicIIVice = alarm-driven; literal = per-cycle polling. Cannot remove alarm until Phase 3. |
| 2 | BA / AEC bus stalling | HIGH | VicIIVice = block-charge per line; literal = per-cycle decode. AEC currently no-op in literal. |
| 3 | framebuffer / pixel emission | HIGH | VicIIVice → onCycle → vic-renderer.ts; literal defers to `raster` struct (not wired). |
| 4 | irq_status (D019 state) | MEDIUM | Same register, different dispatch models. Collision bits never set in VicIIVice (B-level). |
| 5 | sprite_dma + cycle_flags | MEDIUM | VicIIVice = line-entry mask; literal = per-cycle update. |

### Things VicIIVice has that literal lacks (cannot remove yet)

1. Raster IRQ alarm scheduling (Spec 149 alarm dispatch).
2. Framebuffer pixel emission to external renderer.
3. Per-scanline snapshot buffer (`ScanlineState[]`) — needed by
   rasterized renderer.
4. Block-mode bus stealing accounting (`computeLineSteal`).
5. Per-cycle register write log (`ScanlineRegLog`) — needed by trace
   and rasterized renderer.

These five are the gating items for VicIIVice removal. None block
Phase 2.

## 0.5 First Implementation Slice

### Recommended slice

**Literal `$D000-$D3FF` reads + writes become authoritative. VicIIVice
mirrors writes for comparison only. No other behavior changes.**

Justification:

- Plan recommends this slice explicitly.
- 0.2 confirms scheduler does not need restructuring first.
- 0.4 confirms framebuffer, IRQ, BA cannot move first (literal lacks
  pieces).
- 0.3 confirms `vicii-mem.c` is 78% ported; remaining 22% (vbank
  dispatch, colorram init) is not on the read/write hot path.

### Slice scope

In:

- Wire `$D000-$D3FF` reads through literal `vicii_read`.
- Wire `$D000-$D3FF` writes through literal `vicii_store` (already
  partially done — verify mirror behavior across `$D000-$D3FF`).
- Verify read side effects: `$D019` ack, `$D01E`/`$D01F` collision
  read-clear, `$D011`/`$D012` raster line read.
- Keep VicIIVice receiving the same writes for state comparison.
- Add a comparison harness that diffs VicIIVice.regs vs literal.regs
  every N cycles and logs first divergence.

Out:

- No removal of VicIIVice.
- No clock changes.
- No IRQ source migration.
- No framebuffer changes.
- No renderer changes.

### Acceptance gate

- All existing register fidelity unit tests green.
- New synthetic PRG test: read `$D011`/`$D012` around a raster split,
  compare against VICE trace anchor (±2 cycle tolerance per 0.2
  caveat).
- Comparison harness silent (zero divergence) over 60 emulated frames
  on BASIC-ready scenario.
- `cmp -l` byte-identical PRG rebuilds still pass on canonical corpus.

### Slice estimate

Small. Most plumbing is already in place from Spec 298k Step 1+2.
Effort = comparison harness + acceptance PRG + verification of edge
register reads.

## 0.6 Do-Not-Investigate List (First Slice)

Out of scope for the read/write authority slice. Defer all of the
following to later slices or other specs:

1. **Game-level debugging.** No motm, MM, IM2, LNR investigations.
   Synthetic PRGs only.
2. **Screenshot-only acceptance.** Pixel diff is not proof of
   register/cycle correctness. Use unit tests + trace anchors.
3. **Rasterized renderer fixes.** Path is debug/fallback only. Do not
   add semantic fixes there.
4. **Cycle-pumped renderer extensions.** Frozen as validation aid.
5. **Light pen** (`vicii-lightpen.c` port).
6. **REU variant** (`vicii_cycle_reu`).
7. **Snapshot save/restore** (`vicii_draw_cycle_snapshot_*`).
8. **Performance optimization** of the literal port hot path.
9. **Literal port idiomatic TypeScript refactor.** Keep C-shape until
   parity proven.
10. **Rust port discussion.** Not a current concern.
11. **VicIIVice removal.** Stays in place through this slice.
12. **Raster IRQ migration.** Phase 3 work, not this slice.
13. **BA/AEC migration.** Phase 4 work, not this slice.
14. **Framebuffer migration.** Phase 5 work, not this slice.

## Summary Table — Phase 2 Readiness

| Question | Answer |
|---|---|
| Is the literal port complete enough for read/write authority? | Yes (vicii-mem.c at 78%, hot path covered) |
| Does the scheduler need restructuring first? | No (per 0.2 verdict) |
| Are there gating gaps in IRQ / BA / framebuffer? | Yes — but not for read/write slice |
| Can VicIIVice be removed in this slice? | No (5 unported capabilities) |
| Is the comparison harness needed now? | Yes — gate Phase 2 acceptance on it |
| Is per-cycle interleave required for this slice? | No (read/write authority is independent of cycle granularity) |

## Next Steps After Sign-Off

1. Open Spec 300 (or successor): "Literal VIC-II `$D000-$D3FF`
   read/write authority + dual-mode comparison harness".
2. Build comparison harness: per-cycle (or per-line) diff of VicIIVice
   vs literal register state, log first divergence.
3. Implement read path: route `$D000-$D3FF` reads through literal
   `vicii_read`. Keep VicIIVice in place for write mirror.
4. Verify all existing register tests still pass.
5. Add synthetic raster-split PRG to acceptance set.
6. When harness is silent for 60 frames: declare slice done. Open
   Phase 3 spec.

This document supersedes prior ad-hoc planning for the VIC-II literal
port migration. Future slices (IRQ, BA, framebuffer, removal) get their
own Phase 0 sub-analysis at the time, with the same six-section
deliverable shape.
