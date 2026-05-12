# Spec 283 — VIC-II BA pre-assert + AEC signal (3-cycle DMA warning)

**Sprint:** 144 (V3.1 VICE-parity series)
**Status:** RESOLVED 2026-05-09 — OQs answered, ready to implement
**Depends on:** Spec 280g (per-cycle bus stealing baseline)
**Sister specs:** 281, 282, 284..292

## Goal

Model the BA / AEC pin protocol the way real C64 hardware does it
+ VICE 3.7.1 emulates it: BA goes low 3 cycles BEFORE VIC takes
the bus (badline matrix DMA or per-sprite DMA), giving the CPU a
3-cycle warning window. CPU continues executing during the
warning, then AEC goes low and CPU stalls. RMW writes complete
even with BA low. Read instructions stall after 3 consecutive BA
cycles.

Today our `bus-owner-table` (Spec 280g) flips ownership instantly
at cycle 11 / 54 / per-sprite without the 3-cycle warning. CPU
stalls immediately. Wrong by 3 cycles per badline + per sprite.

## Why

Gap #2 in the parity audit. Custom loaders (cracker trainers,
fastloaders that run during badline) measure cycle-exact stall
patterns. With instant BA assertion vs VICE's 3-cycle warning, the
CPU stall window shifts by 3 cycles per DMA event → loader gets
out-of-sync data bytes from drive bus, fails to load.

Standard games (motm/MM/LNR/IM2) don't notice the difference
because their loaders use the KERNAL serial protocol (= no
cycle-exact bit-banging). Demos and cracker intros do.

## VICE source (canonical reference)

### Files

```
/Users/alex/Development/C64/Tools/vice/vice/src/
  dma.c                 ← dma_maincpu_steal_cycles(start_clk, num, sub)
                          where `sub` = 3-cycle BA pre-warning
  dma.h                 ← interface
  vicii/vicii-fetch.c   ← BA assertion timing (line 160 + 474)
                          calls dma_steal with sub=3 for badline
  vicii/vicii.c         ← per-cycle BA / AEC pin update
  6510core.c            ← CPU read/write stall on BA
```

### BA / AEC protocol (real-HW)

```
cycle N:    VIC sets BA low. CPU sees BA, continues.
cycle N+1:  CPU continues (read or write).
cycle N+2:  CPU continues. (3rd cycle of warning).
cycle N+3:  AEC goes low. CPU stalled. VIC has bus.
cycle N+3+M: VIC releases bus, CPU resumes.
```

Special cases:
- **RMW instruction in progress:** the W phase completes even if
  AEC is low (RMW = read-modify-write 3-cycle sequence). VICE
  handles via `maincpu_rmw_flag`.
- **Read while BA low + 3 cycles passed:** stall until BA high.
- **Write while BA low:** still executes (CPU drives bus during
  write — no contention with VIC).

### `dma_maincpu_steal_cycles(start_clk, num, sub)` signature

- `start_clk`: cycle when BA first goes low
- `num`: total DMA cycles VIC takes
- `sub`: 3-cycle BA-pre-assert warning (= grace period CPU still
  executes). For badline VIC calls with `sub=3`.

Net effect: CPU advances `num` cycles, but the "stall actually
starts" at `start_clk + sub`. Anything CPU did between `start_clk`
and `start_clk+sub` was the warning grace window.

## Our current state

### Where we are wrong

```ts
// src/runtime/headless/vic/bus-owner-table.ts (Spec 280g)
// Returns "vic" / "cpu" per cycle. Flips INSTANTLY at cycle 11
// for badline (= 0-cycle warning vs real-HW 3-cycle warning).
// No RMW special-case.
export function getBusOwner(
  cycleInLine: number, isBadline: boolean, spriteFetchMask: number,
): "cpu" | "vic" { ... }
```

```ts
// src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts
// Queries getBusOwner per cycle, stalls CPU on "vic". No grace
// window, no RMW protection.
```

### What works

- Per-cycle bus ownership lookup (Spec 280g)
- Total DMA-cycle accounting (matches VICE totals)
- Badline cycle range (11..54) identification
- Sprite p/s-access cycle stealing per slot

### What's missing

- 3-cycle BA pre-warning before each DMA event
- AEC pin model (= signal that actually pauses CPU)
- RMW write-phase exemption from BA stall
- Read-only stall after 3 consecutive BA cycles

## Plan

### Phase 283a — BA pin state machine

New `src/runtime/headless/vic/ba-aec.ts`:

```ts
export interface BaAecState {
  baLow: boolean;           // VIC asserting BA
  baLowSince: number;       // cycle BA first went low
  aecLow: boolean;          // = baLow && (currentCycle >= baLowSince + 3)
  rmwActive: boolean;       // current instruction is RMW
}

export function updateBaAec(
  state: BaAecState,
  currentCycle: number,
  baAssertedThisCycle: boolean,
): { cpuStalled: boolean } {
  // BA transition tracking
  if (baAssertedThisCycle && !state.baLow) {
    state.baLow = true;
    state.baLowSince = currentCycle;
  } else if (!baAssertedThisCycle && state.baLow) {
    state.baLow = false;
    state.aecLow = false;
  }
  // AEC = BA + 3-cycle warning expired
  state.aecLow = state.baLow && (currentCycle >= state.baLowSince + 3);
  // CPU stalls only when AEC low AND not in RMW write phase
  const cpuStalled = state.aecLow && !state.rmwActive;
  return { cpuStalled };
}
```

### Phase 283b — Pre-assert BA before badline / sprite DMA

Modify `bus-owner-table.ts` (or add a parallel `ba-schedule.ts`):

```ts
// Returns whether BA should be asserted this cycle (3 cycles
// before VIC actually takes the bus).
export function isBaAsserted(
  cycleInLine: number, isBadline: boolean, spriteFetchMask: number,
): boolean {
  // Badline: BA asserted from cycle 8 (= 11 - 3) through cycle 54
  if (isBadline && cycleInLine >= 8 && cycleInLine <= 54) return true;
  // Sprite DMA: BA asserted from (sprite_first_cycle - 3) per active sprite
  // sprite N first cycle = 54 + N*2 (PAL); BA from cycle 51 + N*2
  for (let s = 0; s < 8; s++) {
    if (spriteFetchMask & (1 << s)) {
      const start = 54 + s * 2;
      if (cycleInLine >= start - 3 && cycleInLine <= start + 1) return true;
    }
  }
  return false;
}
```

### Phase 283c — Scheduler integration

`cycle-lockstep-scheduler.ts` (existing 280g):

```ts
// Replace plain getBusOwner check with BA/AEC state machine:
const baThisCycle = isBaAsserted(cycleInLine, isBadline, spriteMask);
const { cpuStalled } = updateBaAec(baState, cpu.cycles, baThisCycle);
if (cpuStalled) {
  // CPU does NOT step. Peripherals + drive still tick (wall clock).
  ...
} else {
  cpu.step();
}
```

Plus RMW-flag wiring: `baState.rmwActive` set true at start of RMW
instruction's read phase, cleared at end of write phase. Hook
into Cpu65xxVice's instruction state.

### Phase 283d — Tests

1. **BA timing smoke** (`scripts/smoke-ba-aec.mjs`):
   - Synthetic single-line scenario: badline at line 51
   - Verify isBaAsserted returns true cycles 8..54
   - Verify CPU stall actually starts at cycle 11 (BA + 3)
   - Verify CPU resumed at cycle 55 (after BA cleared)

2. **RMW protection smoke**:
   - PRG that runs `INC $D020` (RMW) timed to overlap badline
   - Verify the W phase completes during AEC-low window (= no
     stall extension)

3. **Regression**: motm/MM/LNR/IM2 must still boot identically.
   The 3-cycle shift may affect timing-sensitive code; if any game
   regresses, that surfaces a real bug.

## Open Questions — RESOLVED

### OQ1 — RMW exemption scope  ✅ (a) add getter

VICE exempts RMW writes from BA stall. Our microcoded CPU
(Cpu65xxVice) emits per-cycle bus events — does it expose an
"is in RMW write phase" flag we can hook? If not, we'd need to
add one.

- (a) Add `cpu.inRmwWritePhase` getter to Cpu65xxVice; wire to
  ba-aec state
- (b) Skip RMW exemption this spec (= slightly wrong for RMW
  during badline; rare in real code)
- (c) Defer RMW exemption to a follow-up spec

**Resolved:** (a) — add `Cpu65xxVice.inRmwWritePhase` getter,
wire to ba-aec state. RMW write-phase exempt from AEC stall =
1:1 VICE.

### OQ2 — Sprite BA timing  ✅ (a) single block

Sprite DMA uses 2 cycles per active sprite (s-access). When does
BA pre-assert relative to those? VICE asserts BA 3 cycles before
each sprite's first s-access. With multiple active sprites, BA
stays low across the whole sprite-DMA window. Match this:

- (a) BA asserted continuously from `(first_active_sprite_first_cycle - 3)`
  through `(last_active_sprite_last_cycle)` — single block
- (b) Per-sprite assert/release cycles (= matches sprite_fetch_msk
  per slot)

**Resolved:** (a) — BA continuously asserted from
`(first_active_sprite_first_cycle - 3)` through
`(last_active_sprite_last_cycle)`. Single block matches VICE.

### OQ3 — Test corpus for gate  ✅ (a) + (b) + (c)

What proves BA timing correctness?

- (a) Synthetic single-line micro-benchmark (BA assertion timing
  verified against expected cycle window)
- (b) Lorenz cycle-exact testsuite (already in repo? may have
  BA-timing tests)
- (c) Regression on motm/MM/LNR/IM2 (= these don't exercise BA
  timing in user-visible way; pure regression check)
- (d) Real cracker-trainer demo (= what's in the corpus?)

**Resolved:** (a) + (b) + (c).
- (a) Synthetic single-line micro-benchmark in scripts/smoke-ba-aec.mjs
- (b) Lorenz testsuite (samples/vice-testprogs/lorenz-2.15/Disk1-4.d64)
  is already in repo. Disk1 100% PASS already established for V1
  silikon-equivalent gate; Disk2-4 cover deeper cycle-exact tests
  including BA/AEC timing — re-run those with new BA/AEC after
  implementation.
- (c) Spec 281 + 282 regression smokes must remain green
  (motm/MM/LNR/IM2 baseline + palette anchors).
- (d) cracker-trainer corpus skipped — separate ingestion spec.

### OQ4 — Fix scope  ✅ (a) full implementation

The 3-cycle shift may already be effectively handled by
`computeLineSteal` totals — we steal the right NUMBER of cycles,
just at the wrong sub-cycle position. The visual effect (= which
char of mid-line code path is on bus when CPU reads CIA2) might
be pixel-equal in 99% of cases.

- (a) Implement full BA/AEC state machine (= 1:1 VICE)
- (b) Skip — current 0-warning model close enough for non-loader
  games
- (c) Implement only when a real test fails

**Resolved:** (a) — full BA/AEC state machine = 1:1 VICE per
"ALLES" parity goal. Imperceptible for static games but required
for custom-loader timing.

### OQ5 — Performance impact  ✅ (a) naive per-cycle

Per-cycle BA check + AEC update + RMW check = ~3 extra ops per
CPU cycle × 1M cycles/sec ≈ 3M extra ops. Negligible (<1%
renderer overhead). No batching needed.

- (a) Naive per-cycle implementation (cleanest)
- (b) Pre-compute BA-active cycle ranges per line, fast lookup

**Resolved:** (a) — naive per-cycle BA + AEC + RMW check. <1%
overhead, no batching needed. Optimize on signal.

## Acceptance criteria (gate)

- [ ] `isBaAsserted` returns true 3 cycles before badline + each
  sprite DMA, false otherwise
- [ ] BA/AEC state machine: CPU stalls at AEC-low (= BA + 3),
  resumes at BA-clear
- [ ] RMW write phase exempt from stall
- [ ] Spec 281 + 282 smokes still pass
- [ ] motm/MM/LNR/IM2 regression smoke still 4/4 pass
- [ ] Lorenz testsuite Disk1 100% remains green; Disk2-4 BA/AEC
  cycle-exact tests pass after BA/AEC implementation

## Files touched

- `src/runtime/headless/vic/ba-aec.ts` — new (state machine)
- `src/runtime/headless/vic/bus-owner-table.ts` — extend with
  `isBaAsserted` (or split into ba-schedule.ts)
- `src/runtime/headless/scheduler/cycle-lockstep-scheduler.ts` —
  integrate BA/AEC check
- `src/runtime/headless/cpu/cpu65xx-vice.ts` — expose
  `inRmwWritePhase` getter (OQ1)
- `scripts/smoke-ba-aec.mjs` — new
