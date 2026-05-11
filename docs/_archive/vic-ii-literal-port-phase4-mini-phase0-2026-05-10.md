# Phase 4 Mini Phase 0 — Literal BA/AEC + CPU Stall Authority

Date: 2026-05-10
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Predecessor: Spec 301 (literal raster IRQ authority).
Successor spec: Spec 302.

## Goal

Make the literal VICE port the authoritative source for the
"CPU stall this cycle" decision (= BA pin lowering driven by
badline DMA + sprite DMA).

## Current state (post-Spec 301)

### VicIIVice path (current authority)

- `vic-ii-vice.ts:713` — `getBusStallForCycle(cycleInLine?: number): boolean`.
- State: `bad_line` + `sprite_fetch_msk`, primed once-per-line by
  `computeLineSteal()` (vic-ii-vice.ts:636).
- Lookup: `getBusOwner(cycle, badLine, spriteMask)` in
  `bus-owner-table.ts` (pure table).
- Sprite DMA: counts enabled sprites whose Y matches current raster
  (per-line burst, not per-cycle decode).
- AEC: not modeled. Stall = boolean → CPU step skipped.

### Literal port path

- `vicii-cycle.ts:480` — `vicii_cycle()` returns `ba_low` (0/1).
- BA decision (vicii-cycle.ts:443-449):
  ```
  if (bad_line && cycle_is_fetch_ba(cycle_flags)) ba_low = 1;
  ba_low |= vicii_check_sprite_ba(cycle_flags);
  ```
- Bad_line: `(raster_line & 7) == ysmooth` gated by `allow_bad_lines`
  (DEN read at `first_dma_line`).
- Sprite DMA: per-cycle decode via `cycle_table[]` BA bits + active
  `sprite_dma` mask.
- Prefetch_cycles: 3-cycle countdown (= AEC equivalent, gates Φ2
  fetch in `if (!prefetch_cycles)` checks).

### Scheduler wiring

- `cycle-lockstep-scheduler.ts:120-129`: query
  `busStallForNextC64Cycle()` → if true, skip `cpu.executeCycle()` +
  bump `cpu.cycles`.
- `integrated-session.ts:590` wires query to
  `() => this.vic.getBusStallForCycle()` (VicIIVice).
- `litCycle.vicii_cycle()` called at integrated-session.ts:1357
  inside `this.vic.onCycle` hook → return value (`ba_low`) currently
  **discarded**.

### Phase ordering per CPU bus cycle

```
T0  scheduler queries busStallForNextC64Cycle()      (VicIIVice)
T1  if !stalled: cpu.executeCycle()
T2  vic.tick(1) → onCycle hook → litCycle.vicii_cycle()
```

So at T0 of cycle N, VicIIVice has its `raster_cycle` already pointing
at the upcoming cycle (advanced inside its own per-cycle tick); literal
last advanced at T2 of cycle N-1. Off-by-one alignment between the two
authorities is therefore **already present** and matches the VICE
semantic that "ba_low computed in cycle N gates Φ2 of cycle N+1"
(prefetch counter pattern in vicii-cycle.c).

Mitigation: capture `ba_low` returned from `vicii_cycle()` at T2 of
cycle N → use as stall answer at T0 of cycle N+1. No scheduler reorder
required.

## `vicii_steal_cycles` reconciliation

Phase 0.3 deliverable listed `vicii_steal_cycles` as missing and
"required for Phase 4". Audit (Agent #3) confirms: viciisc has no
function literally named `vicii_steal_cycles` doing badline accounting
in the cycle loop — cycle stealing IS the `ba_low` return + 3-cycle
prefetch countdown, both already ported.

The `vicii_steal_cycles` symbol in VICE is a REU-side helper
(memory.c calls it on extended VIC-II RAM stretches) and is **not
needed** for badline / sprite DMA stall correctness in our corpus.

→ Phase 4 does not block on porting it. Marking this as resolved in
the Phase 0.3 hole list.

## Risks for the slice

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | One-cycle lag between VicIIVice + literal stall decisions | Diff harness measures actual lag; expected non-zero on transitions but cumulative cycle counts should match per line |
| 2 | sprite_fetch_msk in VicIIVice vs sprite_dma in literal differ in update timing | Per-line aggregate counts (badline 43 cycles + 3 + 2N for sprites) must match; pulse alignment may differ |
| 3 | `prefetch_cycles` countdown not present in VicIIVice → BA→stall mapping is sharper in literal | Acceptable; literal is the eventual authority. Diff will show transition mismatches around DMA start/end |
| 4 | Existing motm/MM boots that rely on VicIIVice timing may regress under literal stall | Slice is gated behind `useLiteralPortVicStall` flag; defaults to per-cycle flag value; diff harness must be silent on synthetic badline test before flipping default |

## Slice scope (Spec 302)

In:
1. Capture `ba_low` returned from `litCycle.vicii_cycle()` at
   integrated-session.ts:1357. Store as field
   `this.lastLitBaLow: 0 | 1`.
2. Add session option `useLiteralPortVicStall?: boolean`, defaulting
   to `useLiteralPortVicReads` (which itself defaults to
   `useLiteralPortVicPerCycle`).
3. When flag on: route `busStallForNextC64Cycle` to
   `() => this.lastLitBaLow !== 0` instead of
   `this.vic.getBusStallForCycle()`. Keep VicIIVice's path running
   for diff comparison.
4. Diff harness `scripts/smoke-vic-302-stall-diff.mjs`:
   - boot BASIC ready scenario
   - per CPU bus cycle, sample VicIIVice-stall vs literal-ba-low
   - track per-line cycle counts on each side; compare badline cycle
     budgets (= 43 ±2 tolerance per line for badlines)
5. Synthetic badline test
   `scripts/smoke-vic-302-badline-stall.mjs`:
   - inject `regs[$D011] = 0x1B` (DEN=1, ysmooth=3)
   - run frames; sample stall counts at lines where
     `raster_y >= 0x33 && (raster_y & 7) == 3`
   - assert literal sees ~43 BA cycles per badline (40 char fetch +
     3 prefetch countdown)
6. Synthetic sprite DMA test
   `scripts/smoke-vic-302-sprite-stall.mjs`:
   - enable sprite 0 (regs[$D015] = 0x01) at known Y matching current
     raster
   - assert literal sees +5 BA cycles on the matching line
     (3 fixed p-access + 2 per s-access)

## Slice scope (out)

- Removal of VicIIVice stall path.
- Reorder of CPU/VIC tick sequence.
- Block-mode legacy stall code path
  (`!opts.usePerCycleBusStealing`).
- Renderer changes.
- Framebuffer migration (Phase 5).
- Light pen, REU.
- `vicii_steal_cycles` REU helper port.

## Acceptance gates

1. Existing 297 + 300 + 301 tests + diff harnesses green.
2. **Diff harness**: per-line aggregate stall cycle deltas within ±5
   cycles per line over 60 frames on BASIC-ready (some pulse
   misalignment expected; macro budget should match closely).
3. Synthetic badline test: literal stall budget per badline within
   [38, 48] cycles (= ~43 ±5).
4. Synthetic sprite DMA test: literal stall budget on sprite-DMA line
   ≥ baseline + 5 cycles for 1 enabled sprite.
5. TS build green.
6. motm/MM boot still reaches BASIC READY when flag enabled (smoke;
   no regression in trivial scenario).

## Deliverables

- `docs/vic-ii-literal-port-phase4-mini-phase0-2026-05-10.md` (this)
- `specs/302-literal-vic-stall-authority.md`
- `scripts/smoke-vic-302-stall-diff.mjs`
- `scripts/smoke-vic-302-badline-stall.mjs`
- `scripts/smoke-vic-302-sprite-stall.mjs`
- Patch to `src/runtime/headless/integrated-session.ts`:
  - new `useLiteralPortVicStall` option + field
  - `lastLitBaLow` field
  - capture in `onCycle` hook
  - conditional `busStallForNextC64Cycle` routing

## Do-not-investigate (this slice)

1. Game-level debugging (motm beyond BASIC-ready smoke).
2. Block-mode legacy stall accounting cleanup.
3. Reorder of scheduler tick sequence.
4. VicIIVice removal.
5. AEC explicit signal modeling (literal already has prefetch countdown
   = AEC equivalent).
6. Framebuffer / renderer authority (Phase 5).
7. `vicii_steal_cycles` REU helper port.
8. Performance optimization.
9. Literal port idiomatic refactor.
