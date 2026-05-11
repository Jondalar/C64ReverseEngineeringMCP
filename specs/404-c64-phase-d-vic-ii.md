# Spec 404 — C64 Phase D: VIC-II

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 401, 402, 403
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Goal

Bring VIC-II in line with `docs/vice-c64-arch.md §12 Phase D` (steps
13–20) and §5 (full VIC-II deep dive). This is the largest spec on
the C64 side because VIC drives the whole pixel pipeline + bad-line
+ sprite DMA + raster IRQ + BA-low.

## Doc anchor

- `docs/vice-c64-arch.md` §12 Phase D (steps 13–20)
- `docs/vice-c64-arch.md` §5.1 cycle model
- `docs/vice-c64-arch.md` §5.2 Phi1/Phi2 dual-phase bus
- `docs/vice-c64-arch.md` §5.3 bad-line condition
- `docs/vice-c64-arch.md` §5.4 internal counters
- `docs/vice-c64-arch.md` §5.5 cycle table
- `docs/vice-c64-arch.md` §5.6 per-cycle dispatcher
- `docs/vice-c64-arch.md` §5.7 bad-line BA-low timing
- `docs/vice-c64-arch.md` §5.8 sprites state machine
- `docs/vice-c64-arch.md` §5.9 drawing
- `docs/vice-c64-arch.md` §5.10 memory access (VIC bank + chargen)
- `docs/vice-c64-arch.md` §5.11 IRQ
- `docs/vice-c64-arch.md` §5.12 snapshot
- `docs/vice-c64-arch.md` §5.13 full struct field reference
- `docs/vice-c64-arch.md` §13 invariants 2, 6, 7, 8, 9, 14

## Canonical content (verbatim §12 Phase D)

13. Cycle table (`cycle_table[63/64/65]`): copy from
    `src/viciisc/vicii-chip-model.c`. Don't try to derive.
14. Raster line / cycle counters: increment in `vic_tick()`. Frame
    wrap at line 312 / 263 / 262.
15. Phi1 fetch dispatcher: by `cycle_flags`, fetch from VIC-bank /
    chargen / sprite-pointer / sprite-data / refresh. Refresh
    fetches return open-bus but VICE still emits them
    (DRAM-refresh model cycles 11..15 fetch from
    `$3FFF - (refresh_counter & 0xFF)`).
16. Bad-line condition: see §5.3. Trigger BA-low for 40 matrix
    cycles + AEC-low at cycle 12+3.
17. Sprite DMA: 8 independent state machines per §5.8. Y-expand,
    M-expand, multicolor, priority, collisions.
18. Draw: 8 pixels per cycle into dbuf. Implement all 6 valid
    modes + 2 invalid (black) modes. Border state machines (H + V).
19. VIC-II IRQ: $D019 set bits, $D01A mask, OR-fold into bit 7,
    `interrupt_set_irq(maincpu_int_status, vicii.int_num, on, clk)`.
20. BA-low / AEC-low: 3 cycles before fetch, drop. CPU stalls on
    read; writes pass. Update `maincpu_ba_low_flags`.

## VICE source cite

- Main: `src/viciisc/vicii-cycle.c:374` `vicii_cycle()`.
- Cycle table: `src/viciisc/vicii-chip-model.c` (PAL `cycle_tab_pal`,
  NTSC `cycle_tab_ntsc`).
- Bad-line check: `src/viciisc/vicii-cycle.c:51` `check_badline()`.
- Phi1 fetch: `src/viciisc/vicii-fetch.c`.
- Draw: `src/viciisc/vicii-draw.c`, `src/viciisc/vicii-draw-cycle.c`.
- IRQ: `src/viciisc/vicii-irq.c`.
- Mem: `src/viciisc/vicii-mem.c`.
- State: `src/viciisc/viciitypes.h:94` `struct vicii_s`.
- Raster IRQ: `viciisc/vicii-cycle.c:467-474` + vicii-irq.c.

## Audit — current TS state

Source files:

- `src/runtime/headless/vic/vic-ii-vice.ts` (VicIIVice = active driver)
- `src/runtime/headless/vic/literal/vicii.ts`
- `src/runtime/headless/vic/literal/vicii-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-fetch.ts`
- `src/runtime/headless/vic/literal/vicii-draw-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-irq.ts`
- `src/runtime/headless/vic/literal/vicii-mem.ts`
- `src/runtime/headless/vic/literal/vicii-chip-model.ts`
- `src/runtime/headless/vic/literal/vicii-types.ts`
- `src/runtime/headless/peripherals/vic-renderer.ts`

Known status:

- "Literal VICE x64sc port" largely shipped (Spec 298 family, now in
  archive). Most §5 sections have a TS counterpart in `literal/`.
- Phase 309-E (chip-side VIC IRQ push) was reverted on this branch
  (= back to session bridge). VIC graphics rendered when tested via
  `vicRenderer: "literal-port"` for MM + Scramble.
- Phase E re-port is in scope of this spec.

Known deviations to verify:

1. **Cycle table source-of-truth** (§5.5, §12 step 13):
   - Required: cycle_tab_pal copied verbatim from
     `viciisc/vicii-chip-model.c`.
   - Current TS: `vic/literal/vicii-chip-model.ts`. Diff byte-for-byte.
   - **TODO fresh session**: line-by-line comparison; flag any entry
     that differs.

2. **Phi1/Phi2 dual-phase** (§5.2, §13 invariant 6):
   - Required: VIC reads in Phi1 (cycle start); CPU writes in Phi2
     (cycle end). New VIC reg values apply at next Phi1.
   - Current TS: `stepMicrocodedC64Instruction` ticks VIC FIRST then
     CPU per cycle. Matches §5.2.
   - **TODO fresh session**: verify register-write deferral semantics
     in vic-ii-vice.ts ($D000-$D02E write handler).

3. **Bad-line condition** (§5.3, §13 invariant 7):
   - Required: bad-line iff `raster_y >= 0x30 && raster_y <= 0xf7 &&
     (raster_y & 7) == yscroll && DEN at cycle 14 of line 0x30`.
   - Current TS: `vicii_cycle.ts` `check_badline`. Verify formula
     1:1.

4. **Sprite DMA state machines** (§5.8, §13 invariant 8):
   - Required: setting `$D015` bit takes effect at cycle 55-56
     Y-compare; display starts at next sprite slot.
   - Current TS: `vic-ii-vice.ts` has sprite handling but smoke 291
     (Sprite quirks) was "completed" pre-archive — re-audit against
     §5.8.

5. **Draw modes** (§5.9):
   - Required: all 6 valid + 2 invalid black modes.
   - Current TS: literal port supports all modes per Spec 295
     (archived) + Spec 284 illegal modes (archived).

6. **Raster IRQ edge-latch** (§5.11, §13 invariant 9):
   - Required: fires once per matching line.
   - Current TS: implementation in `vicii-irq.ts`. Verify edge
     semantics.

7. **VIC IRQ push to cpuIntStatus** (§5.11, §12 step 19):
   - Required: `interrupt_set_irq(maincpu_int_status, vicii.int_num,
     on, clk)`.
   - Current state: session-side bridge in
     `updateMicrocodedInterruptLines` calls
     `cpu.cpuIntStatus.setIrq(intNumVicIrq, vicIrqAsserted, clk)`.
   - Deviation: VICE pushes at the cycle the raster compare matches
     (= chip-side); session bridge samples mid-orchestration.
   - Resolution: depends on tick-order port (spec 400 + 401). If §11
     step 4i (raster IRQ inside vicii_cycle) is honored in the
     unified tick(), chip-side push works without timing artifacts
     (the issue seen in 309-E was tick-order, not push site).
   - **TODO fresh session**: re-attempt chip-side push after spec
     401 lands tick-order. If MM + Scramble graphics still corrupt,
     drop back to session bridge **and update §5.11** to document
     the divergence + fix.

8. **BA-low / AEC-low** (§5.6 / §5.7, §13 invariant 4, §12 step 20):
   - Required: `maincpu_ba_low_flags` bitfield; CPU reads stall,
     writes pass; BA-low asserted 3 cycles before matrix/sprite
     fetch.
   - Current TS: VIC `stealCpuCycles` advances clock but no
     `maincpu_ba_low_flags` mirror. Stall path different from VICE.
   - **TODO fresh session**: implement BA flag mirror per §11 step 3
     + §5.7 timing.

9. **VIC mem fetch + chargen mirror** (§5.10, §13 invariant 14):
   - Required: VIC bank determines fetch source; chargen at $1000-
     $1FFF only in banks 0+2.
   - Current TS: `vicii-mem.ts` + `vicii-fetch.ts`. Verify.

## TS extras to DELETE

- Legacy `vicRenderer: "vice-rasterized"` path: not in VICE x64sc.
  Per refinement Q11, mark for deletion. Tests already pinned to
  `literal-port`.
- Legacy `vicRenderer: "per-char-row"`: not in VICE. Delete.
- `vic-renderer.ts` (older renderer driver): obsolete once
  literal-port is sole path. Delete.
- Spec 297 cycle-pumped renderer abstractions if any remain.

## NTSC stub

- Cycle table: `cycle_tab_ntsc` separate from `cycle_tab_pal`. Add
  `// TODO NTSC` for ntsc table import; ship PAL only this spec.
- Raster line counts: PAL 312, NTSC 263 / 262. Same stub.

## Producer changes

1. Re-port cycle table verbatim from `vicii-chip-model.c` (if any
   drift since Spec 298).
2. Implement `maincpu_ba_low_flags` mirror per §11 step 3.
3. Pin Phi1/Phi2 ordering in tick() per §5.2.
4. Restore chip-side VIC IRQ push via `cpuIntStatus.setIrq` from
   inside vicii_cycle's raster compare (§5.11 step 4i) — gated on
   spec 400/401 tick-order landing first.
5. Verify all sprite state machine paths per §5.8 against VICE.

## Consumer changes

- Drop session-side VIC IRQ bridge in
  `updateMicrocodedInterruptLines` (= function becomes empty stub
  for C64; drive still has its own).
- `IntegratedSession` orchestrator removes legacy renderer dispatch;
  literal-port is sole VIC.

## Acceptance

- Build clean.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- New smoke `scripts/smoke-404-cycle-table-diff.mjs`: byte-diff TS
  `cycle_tab_pal` vs VICE source — zero diff.
- New smoke `scripts/smoke-404-badline-trace.mjs`: known program
  with bad-line at line 0x33, diff TS vs VICE trace cycle-by-cycle.
- New smoke `scripts/smoke-404-sprite-dma.mjs`: sprite-DMA enable
  at cycle 55 → display next line.
- New smoke `scripts/smoke-404-raster-irq.mjs`: D012 compare → IRQ
  fires once per matching line, even after D012 rewrite to same
  value.
- MM s1 PC=$65f at t=120s, character select pixel-clean (no D018
  raster misalignment).
- Scramble Infinity title + "Loader music: ..." at t=60s pixel-clean.

## Open Questions

- **OQ-404-1 — RESOLVED** → `docs/vice-c64-arch.md §5.1`.
  Constants live in `src/c64/c64.h:36-51`. PAL = 63 × 312 (6569).
  NTSC = 65 × 263 (6567R8 — VICE's default NTSC variant). NTSCOLD =
  64 × 262 (6567R56A — selectable via `VICII_MODEL_*` resource).
  Headless scope is PAL-only.
- **OQ-404-2 — RESOLVED** → `docs/vice-c64-arch.md §5.7`. Implementation
  at `src/viciisc/vicii-cycle.c:582-591`: `prefetch_cycles` resets
  to `3 + 1 = 4` while BA is high, counts down 4→0 once BA goes low.
  CPU may read while `prefetch_cycles > 0`, stalls at 0.
  Reconciles with §11 step 3 because `vicii_cycle()` *returns* the
  next CPU cycle's ba_low (step 4k); CPU's bus access (step 5) is
  gated by the *previous* `vicii_cycle()` return value — i.e. BA
  latches one cycle ahead of when VIC asserts it internally.
- **OQ-404-3 — RESOLVED** → `docs/vice-c64-arch.md §5.11`. Chip-side
  push, **not** alarm. Raster compare in `vicii_cycle()` calls
  `vicii_irq_raster_set(mclk)` → `vicii_irq_set_line_clk(mclk)` →
  `maincpu_set_irq_clk(int_num, 1, mclk)` (`src/viciisc/vicii-irq.c:36-67`).
  Synchronous, same-cycle, with explicit `mclk` so the
  `INTERRUPT_DELAY = 2` accounting is anchored to this cycle. Sprite
  / collision / lightpen sources use the implicit
  `maincpu_set_irq` form which reads `maincpu_clk` directly.
- **OQ-404-4 — RESOLVED** → `docs/vice-c64-arch.md §5.9`. There are
  **5 valid modes (0–4)** and **3 illegal modes (5, 6, 7)** — all
  three illegal modes output `COL_NONE` (black) per the `colors[]`
  table at `src/viciisc/vicii-draw-cycle.c:133-142` (last 12 entries
  = `ECM=1` × any BMM × any MCM that lands in 5/6/7). Sprites still
  render in illegal modes. Doc previously said "2 invalid" — wrong;
  corrected. Spec 284 (3 illegal modes) was right.

## Files touched

- `src/runtime/headless/vic/vic-ii-vice.ts` (modify)
- `src/runtime/headless/vic/literal/*.ts` (audit + small fixes)
- `src/runtime/headless/integrated-session.ts` (drop legacy renderer
  dispatch + session-side VIC bridge)
- `src/runtime/headless/peripherals/vic-renderer.ts` (DELETE if
  legacy)
- 4 new smokes under `scripts/smoke-404-*.mjs`
- `specs/404-c64-phase-d-vic-ii.md` (this)

## Next spec

Spec 405 — C64 Phase E: Sound and the rest.
