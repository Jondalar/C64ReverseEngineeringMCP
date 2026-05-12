# Spec 307 — Literal Driver Direct + Perf Strip (Phase 6c + 7)

Status: open
Date: 2026-05-10
Predecessor: Spec 306 (delete snapshot renderer files)
Plan: `docs/vic-ii-literal-port-migration-analysis-plan-2026-05-10.md`
Phase: 6c (driver inversion) + 7 (perf strip).

## Goal

1. Invert literal-driver direction. Currently `vic.tick(N)` fires
   `vic.onCycle` hook which calls `litCycle.vicii_cycle()`. Replace
   with direct per-cycle call from
   `stepMicrocodedC64Instruction` — drop the callback indirection +
   stop calling `vic.tick()` in fidelity mode at all.
2. Strip VicIIVice's now-redundant per-line work in fidelity mode
   (`computeLineSteal`, scanline snapshot, raster IRQ alarm). Each
   becomes early-return when `usePerCycleBusStealing=true`.
3. Bench script: measure cycles/sec literal-only vs prior dual-truth.

VicIIVice file stays alive — it remains the driver for fast-trap
mode (= no microcoded CPU). Phase 6 acceptance per plan = "in
fidelity mode no path outside literal decides X" — fast-trap is
not fidelity.

## Scope (in)

1. integrated-session.ts:
   - Extract `onCycle` body → private `tickLitVic()` method.
   - In `stepMicrocodedC64Instruction` per-cycle branch: replace
     `this.vic.tick(consumed)` with `for (i=0; i<consumed; i++) this.tickLitVic()`.
   - Set `this.vic.onCycle = null` (or no-op) in fidelity-mode init.
2. vic-ii-vice.ts:
   - `computeLineSteal()`: early-return when `usePerCycleBusStealing`
     (= literal has stall authority).
   - Snapshot capture path: gate behind `!usePerCycleBusStealing`
     (snapshot consumers all deleted in Spec 306; redundant work).
   - Raster IRQ alarm: gate behind `!usePerCycleBusStealing`
     (= literal has IRQ authority via Spec 301).
3. New bench script `scripts/bench-vic-307-perf.mjs`:
   - Boot BASIC ready
   - Measure cycles/sec over 5 PAL frames (= ~98K c64 cycles)
   - Compare against PAL realtime (985248 cycles/sec)
   - Report multiplier

## Scope (out)

- VicIIVice file deletion (= stays for fast-trap fallback).
- VSF migration (read fields from literal — separate spec when fast-trap deprecated).
- UI v3-ws-server raster_y display update (cosmetic; VicIIVice raster_y becomes stale in fidelity mode but UI rarely reads it).
- Headless monitor display (border/bg color reads regs which IS shared, still OK).

## Acceptance gates

1. Build green.
2. All Spec 297a/297k/300/301/302/303 + 298k smokes still PASS.
3. Bench: cycles/sec measured + reported. No hard threshold gate
   yet (informational; baseline for future perf work).
4. motm BASIC ready boot still works (smoke = `test-motm-direct.mjs`
   reaches BASIC line N).

## Implementation

### Driver inversion

```ts
private tickLitVic(): void {
  const cia2Pa = (this.cia2.pra & this.cia2.ddra) & 0xff;
  const bank = (~cia2Pa) & 0x03;
  vicii.vbank_phi1 = bank * 0x4000;
  vicii.vbank_phi2 = bank * 0x4000;
  this.lastLitBaLow = (litCycle.vicii_cycle() & 1) as 0 | 1;
  // dbuf line capture
  if (vicii.raster_line !== this.litLastRasterLine) {
    if (this.litLastRasterLine >= 0 && this.litLastRasterLine < FB_H) {
      const off = this.litLastRasterLine * FB_W;
      for (let x = 0; x < FB_W; x++) {
        this.literalPortFb![off + x] = vicii.dbuf[x]!;
      }
    }
    this.litLastRasterLine = vicii.raster_line;
  }
}

// stepMicrocodedC64Instruction per-cycle branch:
for (let k = 0; k < consumed; k++) this.tickLitVic();
// instead of: this.vic.tick(consumed)
```

### VicIIVice strip

```ts
// vic-ii-vice.ts: computeLineSteal()
private computeLineSteal(): { stolen: number } {
  if (this.usePerCycleBusStealing) return { stolen: 0 };
  // ... existing block-charge code ...
}

// scanline snapshot push:
if (!this.usePerCycleBusStealing) {
  this.scanlineSnapshots.push(snap);
  this.frameLineLogs.push(this.currentLineLog);
}
```

## Deliverables

- `specs/307-literal-driver-direct.md` (this)
- `scripts/bench-vic-307-perf.mjs`
- Patches to `src/runtime/headless/integrated-session.ts` +
  `src/runtime/headless/vic/vic-ii-vice.ts`

## Results (v1)

**Driver-inversion attempt reverted.** The plan to skip
`vic.tick(consumed)` in stepMicrocodedC64Instruction broke two
test paths:
- `s.vic.read(0x11)` returns regs[0x11] OR'd with `(raster_y >> 1)`
  bit 7. With vic.tick skipped, raster_y stays at 0, so bit 7 of
  D011 reads as 0, diverging from literal port's
  `(raster_line >> 1)` OR which DOES advance. Spec 300 r/w diff
  harness shows divergence at D011/D012 reads.
- VicIIVice's bad_line + sprite_fetch_msk used by
  `s.vic.getBusStallForCycle()` in Spec 302 stall-diff harness
  also stop updating without vic.tick.

**What landed instead = pure refactor:**
1. `tickLitVic()` private method extracted from inline onCycle
   closure (= reusable entry point for future Phase 7 work).
2. `vic.onCycle = () => this.tickLitVic()` (= same body, cleaner
   call site).
3. `runUntilFrameReady()` reads `LIT_TYPES.vicii.raster_line`
   directly instead of `vic.raster_y` (= literal port is the
   raster authority).
4. State fields `litLastRasterLine`, `litFbW`, `litFbH` lifted to
   class scope.

No perf gain in Spec 307. Real strip work deferred to Spec 308
(Phase 7) where VicIIVice's redundant per-cycle work
(scanlineSnapshots.push, frameLineLogs.push, raster IRQ alarm
setup) gets gated behind `!usePerCycleBusStealing`.

**Verification:**
- 297a/297k/300/301/302/303 + 298k all PASS unchanged.

## Next slice

Spec 308 = Phase 7 perf bench + selective strip. Then Spec 309 =
forward-fix D016/D018 split bug for motm.
