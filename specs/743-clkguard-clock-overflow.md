# Spec 743 — clkguard: maincpu CLOCK Overflow Guard (VICE-faithful)

**Status:** PROPOSED (2026-05-31) — created after BUG-025 proved the headless
runtime has no `maincpu_clk` overflow guard, so the master clock wraps at 2^32 and
the alarm dispatcher spins.  
**Owner:** runtime CPU core / alarm system / CIA / VIC clk-relative state  
**Depends on:** Specs 149 (alarm system), 401 (CLK_INC tick), 723 (single-path runtime)  
**Related bugs:** BUG-025  
**VICE source:** `src/clkguard.c` + `src/clkguard.h`; `src/interrupt.c:171`
(`interrupt_cpu_status_time_warp`); `src/alarm.c:79-101`
(`alarm_context_time_warp`); per-chip `*_prevent_clk_overflow` callbacks
(`cia-tmpl.c`, `vicii.c`).

## 1. Problem (proven)

`Cpu65xxVice.clk` (= `maincpu_clk`, a uint32 `CLOCK`) grows unbounded and is folded
through `u32()` on every increment. There is **no clkguard**: nothing ever rebases
`maincpu_clk` down before it reaches `CLOCK_MAX` (0xFFFFFFFF).

When `clk` enters the wrap zone (just below 2^32), any alarm armed at
`u32(clk + delta)` wraps to a *small* value. The maincpu alarm context's
`next_pending_alarm_clk` then sits **below** `clk`, so the CPU's `drainAlarms()`
loop

```ts
while (this.clk >= alarmContextNextPendingClk(ctx)) {
  alarmContextDispatch(ctx, this.clk);   // reschedules the alarm at small+period
  if (++guard > 0x1000) throw ...         // <-- trips here
}
```

never terminates (each dispatch reschedules the alarm to another small clk, still
≪ `clk`). After 0x1000 spins the guard throws:

```
Cpu65xxVice: alarm-dispatch guard tripped at clk=4294952194 (ctx=maincpu)
```

`4294952194 = 0xFFFFC8C2`, i.e. `2^32 − 14142` — squarely in the wrap zone.

### 1.1 Proof

`scripts/repro-025-inspect-clk.mjs` (separate backend, not the live UI):

- The Inspector/Frozen-overlay path on its own — `freezeWithProvenance` +
  `captureCheckpoint` + `restoreCheckpoint` + 3× freeze/capture/resume cycles —
  is **clean**: `clk` stays healthy and the maincpu alarms re-arm correctly. So
  inspect does **not** mutate `clk`.
- Forcing `c64Cpu.cycles = 0xFFFFC000` then running reproduces the **exact** error:
  `alarm-dispatch guard tripped at clk=4294950911 (ctx=maincpu)`.

### 1.2 Why BUG-025 blamed the Inspector

The Inspector is an **accelerant, not the cause**. Debug/inspect work commonly runs
under **warp pacing**, and `runFrameWithProvenance` advances up to 100k cycles per
freeze. So an inspect-heavy session reaches the 2^32 zone far faster than the ~72
minutes of realtime @ ~985 kHz PAL it would otherwise take. A power-cycle resets
`clk` to 0, which is why "Power off/on fixes it". No inspector-specific clk jump
exists (1.1); the only proven mechanism is the wrap.

## 2. VICE model (what we must port)

VICE keeps `maincpu_clk` from overflowing with `clkguard` (clkguard.c):

1. A guard owns the clock pointer and a `clk_base`/sub period. When `maincpu_clk`
   would cross the guard threshold, it **subtracts a fixed amount `sub`** from
   `maincpu_clk`.
2. Every subsystem that stores an **absolute** clk registers a callback
   (`clk_guard_add_callback`) that subtracts the same `sub` from its clk-relative
   fields, so all clocks stay in the same (now-lower) domain. Disabled/idle clks
   sentinel'd at `CLOCK_MAX` are left untouched.

Two warp helpers are **already ported but never wired** — Spec 743 wires them:

- `alarm-context.ts:218` `alarmContextTimeWarp(ctx, amount, direction)` — shifts
  every pending alarm clk + `next_pending_alarm_clk` (direction −1 = subtract).
- `interrupt-cpu-status.ts:264` `timeWarp(delta)` — shifts `irqClk`, `nmiClk`,
  `irqPendingClk`, `lastStolenCyclesClk` (CLOCK_MAX-guarded). Comment already says
  *"used when the CPU clock counter wraps."*

## 3. clk-relative field inventory (maincpu domain)

Everything below must be warped DOWN by `sub` in one atomic guard step. Audited
from the current port:

| Component | File | Absolute-clk fields | Warp mechanism |
|---|---|---|---|
| CPU | `cpu/cpu65xx-vice.ts` | `clk` | `clk = u32(clk - sub)` |
| maincpu alarm ctx | `alarm/alarm-context.ts` | `pending_alarms[].clk`, `next_pending_alarm_clk` | `alarmContextTimeWarp(ctx, sub, -1)` ✅ exists |
| interrupt status | `cpu/interrupt-cpu-status.ts` | `irqClk`, `nmiClk`, `irqPendingClk`, `lastStolenCyclesClk` | `timeWarp(-sub)` ✅ exists (note: see §3.1 CLOCK_MAX mismatch) |
| CIA1 + CIA2 | `cia/cia6526-vice.ts` | `rdi`, `read_clk`, `ta.clk`, `tb.clk`, `tod.todclk` | new `prevent_clk_overflow(sub)` |
| VIC-II | `vic/vic-ii-vice.ts` | `raster_irq_clk` (CLOCK_MAX-guarded) | new `prevent_clk_overflow(sub)` |

Notes:
- The CIA's **alarms** (`CIA1_TOD`, `CIA1_IDLE`, …) live in the maincpu alarm
  context, so they ride the `alarmContextTimeWarp`. Only the CIA's **internal
  baselines** (table above) need the explicit subtract.
- The literal VIC port (`vic/literal/vicii.ts`) tracks raster line/cycle
  explicitly (not as a maincpu-clk offset), so it needs **no** warp — but this must
  be re-verified during implementation (RFL §3 check), not assumed.
- The 1541 drive CPU is a **separate clk domain** (`drivecpu.ts`) with its own
  alarm context. Out of scope for Spec 743 (its own guard if/when it can wrap).

### 3.1 CLOCK_MAX inconsistency (fix as part of this spec)

`alarm-context.ts` uses `CLOCK_MAX = 0xFFFFFFFF` (correct uint32) but
`interrupt-cpu-status.ts:34` uses `CLOCK_MAX = Number.MAX_SAFE_INTEGER` (2^53).
The guard's "leave sentinels alone" check must compare against the **same** uint32
sentinel in both, or a disabled irqClk gets warped. Reconcile to 0xFFFFFFFF in the
maincpu domain.

## 4. Design

1. New `cpu/clkguard.ts` — faithful `clkguard.c`: a guard holding the sub period
   and a callback list; `clkGuardPreventOverflow(guard)` subtracts `sub` from the
   clock and invokes every callback with `sub`.
2. `Cpu65xxVice` owns one maincpu `clkguard`. The CLK_INC tick path checks the
   threshold (VICE checks at the guard alarm / at clk++ boundary) and calls
   `clkGuardPreventOverflow` when `clk >= CLK_GUARD_THRESHOLD`.
3. `sub` (= `CLKGUARD_SUB`) is a large constant **aligned** to the PAL frame length
   (`screen_height * cycles_per_line`) and the CIA/TOD period so raster + TOD phase
   are preserved across the rebase (VICE picks a sub that is a clean multiple of the
   relevant periods). Threshold = `CLOCK_MAX − headroom` (headroom ≥ one max
   inter-tick advance + max alarm delta).
4. Register callbacks: CIA1, CIA2, VIC-II `prevent_clk_overflow(sub)`; warp the
   maincpu alarm context + interrupt status inline in the guard step.
5. Snapshot/.c64re: the guard holds no independent persistent state beyond `clk`
   (already captured). The rebase is transparent to capture/restore (all stored
   clks are already in-domain). Verify a capture taken just before a rebase and
   restored just after still resumes (no cross-domain mix).

## 5. Acceptance gates

`npm run probe:743-clkguard` (promote `scripts/repro-025-inspect-clk.mjs` into a
gate):

1. **G1 wrap no longer trips.** Force `c64Cpu.cycles = 0xFFFFC000`, run ≥1 frame:
   no guard error; `clk` ends in the low domain (a rebase occurred).
2. **G2 alarms survive the rebase.** After the rebase, CIA TOD/IDLE + VIC raster
   alarms fire at the correct phase (raster line cadence unchanged; TOD ticks at
   the same wall rate) for ≥3 frames.
3. **G3 interrupt clks warped.** A pending IRQ scheduled across the rebase still
   asserts at the right relative time; a disabled (CLOCK_MAX) irqClk is left alone.
4. **G4 inspect path still clean.** The full BUG-025 inspect sequence (freeze +
   capture + restore + 3 cycles) stays clean (regression guard for §1.1).
5. **G5 long-run soak.** Run past one full rebase cycle (`clk` crosses the
   threshold during normal `runFor`, not forced) and keep running ≥2 more frames
   without a trip — proves the threshold/headroom is correct.
6. **G6 product baseline.** `npm run probe:single-path` 10/10 and the existing
   runtime smoke set stay green (no fidelity regression from the rebase).

## 6. Risks

- **Phase drift.** If `sub` is not aligned to the frame/TOD period, raster splits or
  TOD drift by a few cycles after each rebase. Mitigation: align `sub`; G2/G5 assert
  phase.
- **Missed clk-relative field.** Any absolute clk not in §3 stays in the old domain
  → its own spin/incorrect fire. Mitigation: the §3 inventory is derived from the
  CIA/VIC snapshot field lists; re-audit each chip's snapshot writer during
  implementation and add a debug assertion that no pending alarm clk exceeds
  `clk + maxDelta` after a rebase.
- **CLOCK_MAX mismatch (§3.1)** silently warping a disabled clk. Mitigation:
  reconcile sentinel first, unit-test the guard with disabled irq/nmi.
- This touches the CPU core + CIA + VIC under Spec 723 single-path. No new
  flag/mode; the guard is unconditional (VICE-faithful).

## 7. Out of scope

- Drive-CPU (drivecpu) clk-overflow guard — separate clk domain, separate spec if
  it can wrap in practice.
- Any change to the alarm dispatch guard threshold (0x1000) — it stays as a
  last-resort backstop; Spec 743 removes the condition that trips it.
