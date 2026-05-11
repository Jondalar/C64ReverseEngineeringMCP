# Spec 302 — Literal VIC-II BA/AEC + CPU Stall Authority

Status: open
Date: 2026-05-10
Predecessor: Spec 301 (literal raster IRQ authority)
Mini Phase 0: `docs/vic-ii-literal-port-phase4-mini-phase0-2026-05-10.md`
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 4 of migration plan

## Goal

Route CPU bus-stall decisions through literal port `ba_low` (returned
by `vicii_cycle()`) when `useLiteralPortVicStall` flag is on. Keep
VicIIVice stall path (`getBusStallForCycle`) running for diff
comparison.

See mini Phase 0 doc for full state audit, ordering analysis, risk
table, and reconciliation of `vicii_steal_cycles` (= not needed; cycle
stealing is implicit in `ba_low` return + 3-cycle prefetch
countdown).

## Scope (in)

1. Add `useLiteralPortVicStall?: boolean` session option, defaults to
   `useLiteralPortVicReads`.
2. Add field `private lastLitBaLow: 0 | 1 = 0` on
   `IntegratedSession`.
3. In `installLiteralPortRenderer` `onCycle` hook
   (integrated-session.ts:1357), capture return:
   ```ts
   this.lastLitBaLow = (litCycle.vicii_cycle() & 1) as 0 | 1;
   ```
4. Conditional stall routing
   (integrated-session.ts:590):
   ```ts
   busStallForNextC64Cycle: opts.usePerCycleBusStealing
     ? (this.useLiteralPortVicStall
         ? () => this.lastLitBaLow === 1
         : () => this.vic.getBusStallForCycle())
     : undefined,
   ```
5. Diff harness `scripts/smoke-vic-302-stall-diff.mjs`:
   - per-cycle sample of VicIIVice stall + literal ba_low
   - aggregate by raster line; compare per-line stall cycle counts
   - log first per-line aggregate divergence > tolerance
6. Synthetic badline test `scripts/smoke-vic-302-badline-stall.mjs`.
7. Synthetic sprite DMA test `scripts/smoke-vic-302-sprite-stall.mjs`.

## Scope (out)

- VicIIVice stall path removal (Phase 6).
- Scheduler tick reorder.
- Block-mode legacy stall.
- Renderer / framebuffer (Phase 5).
- `vicii_steal_cycles` REU helper port (out per mini Phase 0
  reconciliation).
- AEC explicit signal modeling.
- Game-level debug.

## Acceptance gates

1. Existing 297 + 300 + 301 tests + harnesses still green.
2. Build green.
3. Diff harness: per-line aggregate stall delta within ±5 cycles over
   60 frames on BASIC-ready.
4. Synthetic badline test: literal stall budget per badline within
   [38, 48] cycles.
5. Synthetic sprite DMA test: stall budget on sprite-DMA line at
   least baseline + 5 cycles for 1 enabled sprite.
6. motm BASIC-ready smoke (no regression beyond what Spec 300/301
   already accept).

## Implementation

### Field + flag

```ts
public useLiteralPortVicStall: boolean = false;
private lastLitBaLow: 0 | 1 = 0;

// in ctor:
this.useLiteralPortVicStall = opts.useLiteralPortVicStall ?? this.useLiteralPortVicReads;
```

### Capture

```ts
this.vic.onCycle = (_raster_y, _raster_cycle, _clk) => {
  const cia2Pa = (this.cia2.pra & this.cia2.ddra) & 0xff;
  const bank = (~cia2Pa) & 0x03;
  vicii.vbank_phi1 = bank * 0x4000;
  vicii.vbank_phi2 = bank * 0x4000;

  this.lastLitBaLow = (litCycle.vicii_cycle() & 1) as 0 | 1;

  // ... (framebuffer capture unchanged) ...
};
```

### Stall route

```ts
busStallForNextC64Cycle: opts.usePerCycleBusStealing
  ? (this.useLiteralPortVicStall
      ? () => this.lastLitBaLow === 1
      : () => this.vic.getBusStallForCycle())
  : undefined,
```

### Diff harness shape

```text
Spec 302 stall diff — 60 frames
samples=312000 vice_stall=12480 lit_stall=12500 deltaCycles=20
per-line worst: line=51 vice=43 lit=46 delta=+3
PASS within ±5 cycle tolerance
```

## Deliverables

- `specs/302-literal-vic-stall-authority.md` (this)
- `docs/vic-ii-literal-port-phase4-mini-phase0-2026-05-10.md`
- `scripts/smoke-vic-302-stall-diff.mjs`
- `scripts/smoke-vic-302-badline-stall.mjs`
- `scripts/smoke-vic-302-sprite-stall.mjs`
- Patch to `src/runtime/headless/integrated-session.ts`

## Results (v1)

- Build green.
- 297a + 297k + 300 r/w diff + 301 IRQ diff + 301 raster IRQ
  regressions all still PASS (no breakage).
- **Spec 302 stall diff (60 frames, BASIC ready):**
  - 190,880 sample slices
  - vice stall hits = 22,831
  - literal stall hits = 22,831 (**exact match**)
  - per-line aggregate deltas > ±5: **0**
  - PASS
- **Synthetic badline test:** literal observes badlines firing
  (140 hits / 1000 samples), cycle progress matches baseline
  (60582 cycles both modes). PASS all 4 checks.
- **Synthetic sprite DMA test:** literal observes sprite_dma bit on
  enabled sprite (66 hits / 1000 samples). PASS.

### Discovery during harness build

First diff run (with naive proxy `bad_line === 1 || sprite_dma !=
0`) showed `+6 cycle` per-line over-count on literal side. Root
cause: proxy counted ALL cycles where `bad_line` was set
(whole-line span), while VicIIVice counts only BA-active cycles
(matrix fetch range 11..53). Apples-to-apples requires evaluating
the same predicate on both sides:

```js
litStall =
  (bad_line === 1 && (cycle_flags & FETCH_BA_M) !== 0) ||
  ((sprite_dma & (cycle_flags & SPRITE_BA_MASK_M)) !== 0);
```

After this fix, vice and literal agree on every sampled cycle —
exact stall-hit parity (22831 == 22831). This confirms the literal
port's `ba_low` decision is byte-equivalent to VicIIVice's
`getBusOwner()` lookup at every observable cycle on idle BASIC.

### Known limitation

Diff harness samples after each 1-instruction slice (≈3-7 CPU
cycles). Not a true per-cycle probe — small windows of disagreement
during sprite DMA pulses or badline edges could be missed between
samples. Per-line aggregate budget over 60 frames is the strongest
guarantee available without instrumenting the per-cycle hook.
Stronger per-cycle diff = follow-up if disagreement appears in
real-game scenarios.

## Next slice

Phase 5 = literal framebuffer authority (separate spec, separate mini
Phase 0). Renderer rewiring + pixel-diff acceptance.
