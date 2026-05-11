# Spec 304 — Literal VIC-II Defaults On

Status: open
Date: 2026-05-10
Predecessor: Spec 303 (literal framebuffer authority)
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 6a of migration plan (= start of "remove dual truth" — flip
defaults so literal-port path is on out of the box; explicit
opt-out still possible).

## Goal

Make literal port the **default** VIC-II authority by flipping two
constructor option defaults:

- `useLiteralPortRenderer`: false → **true**
- `useLiteralPortVicPerCycle`: false → **true**

All cascade flags (`useLiteralPortVicReads`, `useLiteralPortVicIrq`,
`useLiteralPortVicStall`, `useLiteralPortVicFb`) already default to
inherited values, so they auto-flip on too.

## Pre-flip audit

User confirmation: "no consumer code besides me" — backward compat
not required. Phase 0 deliverable + Specs 300-303 cumulative diff
harnesses prove literal port is byte-equivalent or pixel-equivalent
to VicIIVice on:

- $D000-$D3FF reads (4248/4248 = 0 divergence — Spec 300)
- IRQ assertion (180/180 = 0 divergence — Spec 301)
- BA/CPU stall (22831/22831 = 0 divergence — Spec 302)
- Framebuffer 94.59% pixel match BASIC ready (Spec 303)

Re-validation of agent #2 audit findings (= claimed pixel holes in
literal port) found three false alarms:

1. **Sprite priority** ✅ correct — `for (s=7; s>=0)` with overwrite
   = sprite 0 wins (= matches VICE hardware).
2. **Y-expansion** ✅ implemented — `exp_flop` toggled per line in
   `check_exp` (vicii-cycle.ts:87-91); `sprite_mcbase_update` only
   advances mcbase when `exp_flop` set (vicii-cycle.ts:71-77) =
   correct half-rate DMA = 2x sprite height.
3. **Illegal modes 5/6/7** ✅ matches viciisc — both VICE x64sc
   `vicii-draw-cycle.c` and our literal port emit black (COL_NONE
   → cc=0). VicIIVice "chargen noise" was a heuristic going
   beyond x64sc baseline; will be removed alongside VicIIVice.

L/R border simplification (claim #4 in agent audit) is the only
remaining literal pixel difference vs VicIIVice — and it sits
within the 5.4% structural diff documented in Spec 303.

→ **Phase 5 follow-up specs (304-307 sprite/Y-exp/illegal/border) are
not needed.** Skip directly to Phase 6.

## Scope (in)

1. integrated-session.ts:506-507: flip both defaults to `true`.
2. Run all existing harnesses (297a/297k/300/301/302/303 + 302
   badline + 302 sprite + 303 fb-diff + 303 basic-ready) to confirm
   no regression now that they all default-on.
3. Run motm BASIC-ready smoke to confirm games still boot.
4. Update inline doc comments to reflect new defaults.

## Scope (out — follow-up specs)

- Phase 6b — delete snapshot renderers (`per-char-row` /
  `per-pixel` / `vice-rasterized` + their support files).
- Phase 6c — delete VicIIVice IRQ alarm + bus stealing + framebuffer
  emission code paths (= keep only the regs[] + facade methods).
- Phase 6d — delete VicIIVice itself + replace with thin literal
  state facade.
- Phase 7 — performance pass.
- Spec 296 — VIC real-game stress corpus.

## Acceptance gates

1. Build green.
2. All Spec 297a/297k/300/301/302/303 harnesses + sprite + badline +
   basic-ready tests still PASS without re-tuning (= literal-port
   defaults on instead of explicit opts).
3. motm BASIC-ready boot smoke: still reaches READY screen.
4. No snapshot-renderer regressions (= explicit
   `opts.renderer = "vice-rasterized"` still works for diff
   comparison).

## Implementation

```ts
// integrated-session.ts:506-507 (Spec 304: defaults on)
this.useLiteralPortRenderer = opts.useLiteralPortRenderer ?? true;
this.useLiteralPortVicPerCycle = opts.useLiteralPortVicPerCycle ?? true;
```

No other changes required — cascade flags inherit from
`useLiteralPortVicReads` which inherits from
`useLiteralPortVicPerCycle`.

## Deliverables

- `specs/304-literal-vic-default-on.md` (this)
- Patch to `src/runtime/headless/integrated-session.ts` (2 lines)

## Next slice

Phase 6b — Spec 305: delete snapshot renderers. After verifying that
literal-port is sole framebuffer source in default scenarios.
