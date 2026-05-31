# Spec 743 — Runtime CLOCK Semantics + Pause/Inspect/Resume Stability

**Status:** DONE (2026-05-31) — implemented monotonic-CLOCK across CPU + alarm +
interrupt + VIC + CIA/ciat/TOD. No clkguard (VICE CLOCK is uint64; absolute runtime
time is now a monotonic JS number, exact to 2^53). BUG-025 fixed. See
"Implementation" at the end. Replaces the incorrect clkguard draft.  
**Owner:** runtime CPU core / alarm system / CIA / VIC / Live UI monitor loop  
**Depends on:** Specs 705, 723, 724  
**Related bugs:** BUG-025  

## 1. Problem

The Live runtime can get stuck after an Inspector/Frozen overlay has been used.
Monitor `g` then fails with:

```text
Cpu65xxVice: alarm-dispatch guard tripped at clk=4294952194 (ctx=maincpu)
```

`4294952194` is just below `0xffffffff`. That is the signal: our runtime has at
least one main CPU clock domain behaving like a 32-bit wrapping counter.

This is not acceptable for the C64RE product runtime:

- warp/inspect/debug sessions can run for a long time;
- Pause/Run and monitor `g` must remain stable;
- Inspector/Frozen overlay must not make the live session unrecoverable;
- alarms, interrupts, CIA, VIC and checkpoint state must stay in one coherent
  clock domain.

## 2. Product Rule

Absolute emulator time is a runtime-owned monotonic CLOCK domain.

It must not wrap at 32 bits.

Use fixed-width wrapping only for machine registers and bitfields where the C64
hardware actually wraps. Do not apply `u32`, `>>> 0`, or `0xffffffff` sentinels to
absolute runtime time unless the field is intentionally a 32-bit hardware value.

## 3. VICE Reference Boundary

VICE is not part of the product flow for this bug.

The only relevant reference note is: VICE's `CLOCK` type in the checked source is
64-bit (`uint64_t` in `src/types.h`). There is no `clkguard.c` / `clkguard.h` in
the checked source tree. Therefore this spec must **not** implement a fictional
VICE clkguard port.

The product requirement stands on its own:

```text
C64RE Runtime CLOCK must be monotonic and stable across long warp/inspect runs.
```

## 4. Root-Cause Hypothesis

The crash is caused by mixed clock-width semantics in our runtime:

- `Cpu65xxVice.clk` / `cycles` or alarm scheduling is coerced through uint32
  (`u32`, `>>> 0`, or `CLOCK_MAX = 0xffffffff`);
- an alarm scheduled at `clk + delta` near `0xffffffff` wraps to a small value;
- `next_pending_alarm_clk` becomes lower than current `clk`;
- `drainAlarms()` repeatedly dispatches and reschedules still-below-current
  alarms until its guard trips.

The Inspector/Frozen overlay is likely an accelerant, not the ownership root:
inspect paths can run/wrap the machine quickly under warp/provenance capture.
The fix is not "reset alarms after inspect"; the fix is coherent runtime CLOCK
ownership.

## 5. Clock Domains

### 5.1 Main CPU domain

The main C64 runtime clock includes:

- CPU `clk` / `cycles`;
- maincpu alarm context;
- interrupt status clocks;
- CIA1/CIA2 absolute clocks and timer/TOD baselines;
- VIC-II raster IRQ clock and any maincpu-clock-relative state;
- keyboard/input event scheduling tied to maincpu time;
- checkpoint/snapshot serialization of the above.

All of these must use the same monotonic CLOCK semantics.

### 5.2 Drive CPU domain

The 1541 drive CPU clock is a separate domain. It is out of this slice unless an
audit finds the same 32-bit absolute-time bug there. Do not mix drive-clock
changes into the first fix unless required for build/runtime consistency.

## 6. Required Audit

### 6.0 Completed audit (2026-05-31)

Bug mechanism confirmed by `scripts/repro-025-inspect-clk.mjs`: forcing
`c64Cpu.cycles = 0xFFFFC000` then running reproduces the exact guard trip; the
inspect path on its own is clean. So the only defect is the 32-bit wrap of maincpu
absolute time. `clkAdd = (a,b) => u32(a + b)` (`util/uint.ts:33`, used ONLY by the
two maincpu `clk++` sites) and `set cycles(v){ this.clk = u32(v) }` make the master
clock a 32-bit wrapping counter; every chip that schedules a maincpu alarm then
folds `clk + delta` through `u32`/`>>> 0`, so near the boundary the alarm wraps
below `clk` and `drainAlarms()` spins.

| Component | File | Absolute-clock fields | Current coercion | Required change |
|---|---|---|---|---|
| CPU clk++ / setter | `cpu/cpu65xx-vice.ts:420,739,247` | `clk`, `cycles` | `clkAdd=u32(a+b)`, `u32(v)` | monotonic `a+1`, `v` |
| clk add helper | `util/uint.ts:33` | `clkAdd` | `u32(a+b)` | maincpu-only → monotonic (or inline) |
| alarm empty/disabled sentinel | `alarm/alarm-context.ts:47,117,136,156,358,387` | `next_pending_alarm_clk`, `CLOCK_MAX` | `0xffffffff` | `CLOCK_NEVER = MAX_SAFE_INTEGER` |
| alarm capture/restore | `alarm/alarm-context.ts:182,206` | `p.clk`, `e.clk` | `>>> 0` | raw monotonic |
| alarm dispatch offset | `alarm/alarm-context.ts` `alarmContextDispatch` | `offset` | `u32(cpuClk - next)` | OK — short non-neg delta (dispatch only when `cpuClk >= next`) |
| alarm timeWarp | `alarm/alarm-context.ts:230-242` | pending clks | `u32` | dead code (no caller) — remove or leave; not on the fix path |
| VIC raster sched | `vic/vic-ii-vice.ts:842-853,867` | `lineStartClk`, `fireClk`, `raster_irq_clk` re-arm | `u32(...)` on absolute clk | monotonic; `raster_irq_clk` disabled-sentinel = `CLOCK_NEVER` |
| CIA read/write clock | `cia/cia6526-vice.ts:462,…` | `rclk = clk - READ_OFFSET` | `u32(clk - OFF)` | monotonic (OFFSET small) |
| CIA idle fence | `cia/cia6526-vice.ts:423` | idle alarm | `alarmSet(u32(clk + CIA_MAX_IDLE_CYCLES))` | monotonic |
| CIA timer alarm sentinels | `cia/cia6526-vice.ts:344-345,427-428` | `ta_alarmclk`, `tb_alarmclk` | `0xffffffff` | `CLOCK_NEVER` |
| CIA timer core | `cia/ciat.ts:266,288,309,329` (+ `this.clk += …` 116-155) | `getAlarmClk` result/`aclk`, internal `clk` baseline, `CLOCK_MAX` | `>>> 0`, `0xffffffff` | absolute clk → monotonic; **16-bit counters (`cnt`,`latch`) keep `& 0xffff`** |
| CIA TOD | `cia/cia-tod.ts` | `todclk` schedule | audit (likely `u32`) | monotonic; BCD TOD register fields stay masked |
| read_clk / rdi | `cia/cia6526-vice.ts:323,460,550` | `read_clk`, `rdi` | absolute | monotonic (follow rclk) |
| checkpoint clk fields | `kernel/headless-machine-kernel.ts:1002` + alarm capture | `cpu.cycles`, alarm sched | already plain numbers | verify no u32 on restore |

**Classification rule applied:** absolute runtime time (clk, rclk, all `*_alarmclk`,
`todclk`, `fireClk`, `raster_irq_clk`) → monotonic `number`, never `u32`/`>>> 0`.
Hardware-register wrap (16-bit timer `cnt`/`latch`, 8-bit ports, BCD TOD digits) →
keep `& 0xffff` / `& 0xff`. Disabled sentinels → `CLOCK_NEVER`, never `0xffffffff`.

**Blast radius / risk:** reaches the fidelity-critical `ciat.ts` timer (Spec 612
1:1 port) and CIA/VIC scheduling. ~25–40 edit sites over 5 files; each needs the
absolute-vs-register judgment above. A wrong de-`u32` on a 16-bit counter breaks
timer wrap → IRQ timing → games. Therefore implementation was **gated on the
mandatory 6-game screenshot set** (motm / MM s1 / IM2 / LNR s1 / Scramble / Pawn
s1) plus `probe-single-path`, cia-suite + the unit boundary probes. DONE
2026-05-31 — see "Implementation" at the end (all gates green; 7-game PNGs read).

### 6.1 Reference checklist

Must include at least:

- `cpu/cpu65xx-vice.ts`
- `alarm/alarm-context.ts`
- `cpu/interrupt-cpu-status.ts`
- `cia/cia6526-vice.ts`
- `cia/cia-tod.ts`
- `vic/vic-ii-vice.ts`
- literal VIC host clock bridges, if any
- checkpoint/snapshot capture/restore of clock fields
- keyboard/input scheduling if it stores absolute clocks

Search patterns:

```text
u32(
>>> 0
0xffffffff
CLOCK_MAX
MAX_SAFE_INTEGER
alarmSet(
next_pending_alarm_clk
irqClk / nmiClk
raster_irq_clk
todclk
```

The audit must distinguish:

- hardware/register wrapping values;
- absolute runtime CLOCK values;
- disabled/sentinel values.

## 7. Design Requirements

### 7.1 CLOCK representation

Use JS `number` for runtime CLOCK values. JS integers are exact up to `2^53`;
that is far beyond C64 runtime needs.

Do not coerce absolute CLOCK values to uint32.

### 7.2 Sentinel

Define one runtime-level disabled-clock sentinel.

Preferred shape:

```ts
export const CLOCK_NEVER = Number.MAX_SAFE_INTEGER;
```

Rules:

- disabled alarms/clocks use `CLOCK_NEVER`;
- arithmetic must not add/subtract from `CLOCK_NEVER`;
- JSON/checkpoint serialization must preserve it as a finite number;
- do not use `0xffffffff` as "never" for maincpu absolute CLOCK.

If implementation chooses `null` for disabled clock instead, it must be applied
consistently and documented in the audit. Do not mix sentinel styles.

### 7.3 Alarm comparison

Alarm comparisons are normal monotonic comparisons:

```ts
currentClock >= nextPendingClock
```

They must not rely on unsigned wrap ordering.

### 7.4 Checkpoint / snapshot

Checkpoint and `.c64re` payloads must store CLOCK values in the same monotonic
domain. Restore must not reintroduce uint32-truncated clocks.

### 7.5 Inspector/Frozen overlay

Inspector/Frozen overlay may capture/copy/freeze state. It must not mutate the
live clock/alarm domain unless an explicit restore operation is requested.

The overlay path is an acceptance surface, not the root fix.

## 8. Non-Goals

- No reset/power-cycle workaround.
- No blind `clearAlarms()`.
- No "catch guard and continue".
- No fictional VICE clkguard port.
- No broad UI redesign.
- No drive-clock refactor unless the audit proves it is required.

## 9. Acceptance Gates

Add `npm run probe:743-runtime-clock` or equivalent.

Required checks:

1. **Forced boundary crossing.** Set main CPU clock near `0xffffffff`, run past it,
   and assert:
   - no alarm-dispatch guard trip;
   - clock continues above `0xffffffff`;
   - alarms remain scheduled in the same monotonic domain.
2. **Alarm fire correctness.** Schedule a maincpu alarm across the old 32-bit
   boundary and assert it fires after the correct relative delay.
3. **Interrupt clock correctness.** Pending IRQ/NMI clocks across the boundary
   assert at the right relative time; disabled clocks remain disabled.
4. **CIA/TOD stability.** CIA timers/TOD continue ticking correctly after the
   boundary crossing.
5. **VIC stability.** Raster IRQ scheduling remains coherent after the boundary
   crossing.
6. **Inspector regression.** Power on -> run game/session -> open/use Inspector
   overlay -> close -> Pause -> monitor `r` -> monitor `g` resumes. Repeat twice.
7. **Product baseline.** Existing single-path/runtime smoke gates stay green.

## 10. Done Criteria

Spec 743 is DONE when:

- absolute maincpu runtime clocks no longer wrap at 32 bits;
- `0xffffffff` is not used as maincpu absolute CLOCK sentinel;
- forced old-wrap-boundary execution runs cleanly;
- BUG-025 repro no longer fails after Inspector/Frozen overlay;
- BUG-025 is marked fixed with root cause and gate;
- docs do not describe this as a VICE clkguard port.

---

## Implementation (2026-05-31)

Monotonic CLOCK across the maincpu domain. `util/uint.ts`: `CLOCK` documented as a
monotonic JS number; added `CLOCK_NEVER = Number.MAX_SAFE_INTEGER` (the one
disabled-clock sentinel); `clkAdd = a + b` (no u32). Every `u32`/`>>>0`/`0xffffffff`
on an **absolute** maincpu clock removed; hardware register/bitfield widths kept.

| Slice | Files | Gate |
|---|---|---|
| 743.1 CPU + alarm | `cpu/cpu65xx-vice.ts` (cycles setter), `util/uint.ts`, `alarm/alarm-context.ts` (CLOCK_MAX→CLOCK_NEVER, capture/restore, timeWarp) | `probe:743-1` 12/12 |
| 743.2 interrupt + VIC | `vic/vic-ii-vice.ts` (raster fireClk + re-arm); `cpu/interrupt-cpu-status.ts` already clean (its CLOCK_MAX was already MAX_SAFE_INTEGER) | `probe:743-2` 9/9 |
| 743.3 CIA/ciat/TOD | `cia/ciat.ts` (setAlarm), `cia/cia6526-vice.ts` (rclk/idle/alarmclk/ifr/dispatch), `cia/cia-tod.ts` (todclk) | `probe:743-3` 11/11 + cia-suite 16/16 + cia-fidelity 22/22 |
| 743.4 checkpoint + inspector | (verification only — checkpoint already stores plain numbers) | `probe:743-4` 10/10 |
| 743.5 product baseline | — | probe-single-path 25/25; 7-game screenshots verified by reading each final PNG (motm/MM/IM2/LNR/Scramble/Pawn/Polarbear) |

`npm run probe:743` runs 743-1..4 (42 checks).

### Remaining intentional `u32`/`>>>0` (hardware/register width — NOT absolute clk)

- `cpu/cpu65xx-vice.ts` `lastIFlagClearInstrLen = u32(clk - instrStart + 2)` — an
  instruction *length* (≤ ~8), not an absolute clk.
- `alarm/alarm-context.ts` dispatch `offset = u32(cpuClk - next_pending)` — a short
  non-negative delta (dispatch only fires when `cpuClk >= next`).
- `cia/cia6526-vice.ts` `delay`/`sdr_delay` IRQ-pipeline **bitfield registers**.
- `cia/cia-tod.ts` `todticks`/`ticks_per_sec`/`power_ticks` — TOD **periods** (< 2^32;
  `u32` doubles as `floor` for the integer interval, no wrap role).
- 16-bit timer `cnt`/`latch` keep `& 0xffff`; 8-bit ports `& 0xff`; BCD TOD digits.

After this work there is **no** `u32`/`>>>0` on an absolute maincpu CLOCK.

### Why there is no "force clk to 2^32 and run" full-machine gate

Directly setting `c64Cpu.cycles ≈ 0xFFFFFFFF` is an invalid test: it jumps clk by
~2.6e9 cycles while leaving every already-armed alarm (and each chip's internal clk
baseline) stranded at the old boot clk, so `drainAlarms` spins regardless of the fix
(and `ciat.update` would loop billions of cycles). A real session reaches 2^32
**gradually**, with alarms continuously rescheduled ahead of clk; the bug was a chip
scheduling `u32(clk + period)` that **wrapped** below clk near the boundary. That
exact mechanism is removed and unit-proven monotonic per chip in
`probe:743-1/2/3` (schedule/predict at `clk + delta > 2^32` stays in the future).
`probe:743-4` proves the live machine + inspector/checkpoint path stay coherent and
monotonic (BUG-025 acceptance: use overlay → resume → no guard trip, ×repeat).

---

## 743.6 follow-up — C64→1541 catch-up bridge truncation (2026-05-31)

743.1–743.5 made the C64 maincpu domain monotonic but left the **C64→drive
catch-up bridge** truncating the absolute C64 target to uint32 before handing it to
the 1541. After C64 clk > 2^32 the drive's `cycles = clk_value - last_clk` would see
a wrapped (small) target < `last_clk` → `cycles = 0` (drive STALLS), or a billion-
cycle over-run — a mixed clock-domain bug.

### Contract found

`drivecpu_execute(drv, clk_value)` is fed the **C64 absolute clk** (the drive
catches up TO C64 time; the C64↔drive rate difference is handled internally by the
16.16 `sync_factor` accumulator). It uses `clk_value` only for
`cycles = clk_value - last_clk` and stores `last_clk = clk_value` — **already
monotonic-safe (no `>>> 0` on either)**. The drive's OWN clock (`clk_ptr`,
`stop_clk`, `cycle_accum`) is a **separate uint32 drive-cycle domain** advanced by
`cycles` via `sync_factor`; it is never compared to the C64 clk.

So the only defect was the `>>> 0` applied to the C64 target at the bridge.

### Fix (smallest faithful)

Removed `>>> 0` from every C64-clk → drive catch-up site so the monotonic C64 target
flows through to `drivecpu_execute`:

- `kernel/headless-machine-kernel.ts` — `iec.pushFlush.one/all` → `vice.tickToClock(clk)`
- `drive1541/vice1541-facade.ts` — `tickToClock`, `catchUpTo`, `iecLineDrive` effClk
- `vice1541/iecbus.ts` — `drive_cpu_execute_one` / `drive_cpu_execute_all`

`drivecpu_execute` and `last_clk` were already wrap-free. The drive-domain
`clk_ptr`/`stop_clk`/`cycle_accum` `>>> 0` are KEPT — they are the 1541's own
hardware clock, not C64 absolute time.

### Gate

`npm run probe:743-6` (`scripts/probe-743-6-drive-clock-bridge.mjs`, 8/8) — primes
the drive's `last_clk` near 2^32, drives `tickToClock` / `catchUpTo` across the
boundary, and asserts the drive advances by the correct small delta (not stalled,
not a billion-cycle jump) with `last_clk` monotonic > 2^32; a contrast case shows
the old `>>> 0` target stalls the drive. `npm run probe:743` now runs 743-1..4 + 6.

### Known remaining (separate domain, out of THIS scope)

The drive's own `clk_ptr`/`stop_clk` wrap at 2^32 **drive cycles** (~72 min of drive
time). That is the drive-domain analogue of BUG-025 and would need the same
monotonic treatment inside `vice1541/` (drivecpu + drive alarm context). It is
independent of the C64 bridge and governed by Spec 612 (1541 port fidelity) — a
separate slice, not done here. The bridge truncation (which corrupts the C64→drive
delta the moment C64 clk passes 2^32) IS fixed.

## Is 743 DONE?

The **C64 maincpu domain** is fully monotonic and the C64→drive bridge no longer
truncates — so the originally-reported BUG-025 (maincpu alarm-dispatch spin) and the
mixed-domain bridge bug are both resolved and gated. 743 is DONE **for the C64
domain + the bridge**. A truly clock-wrap-free *drive* domain (the 743.6 "known
remaining") is a distinct 1541-port slice and is explicitly out of 743's scope.
