# Spec 425 — C64 VIC-II CLK_INC contract

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 400, 401, 404, 423
**Doctrine:** 1:1 VICE x64sc execution contract. This spec is not a
renderer task. It fixes the C64 machine clock boundary between CPU,
alarms, IRQ delay, VIC-II cycle execution, and BA bus stealing.

## Why this exists

The literal VIC-II port is now present and most rendering code is much
closer to VICE. The remaining risk is the surrounding scheduler:

- VICE couples every C64 CPU clock increment to `vicii_cycle()` through
  one macro, `CLK_INC()`.
- The current TS runtime still runs the literal VIC from
  `IntegratedSession.stepMicrocodedC64Instruction()` via
  `this.vic.tick(1)` before `cpu.executeCycle()`.
- CPU-internal multi-cycle work such as IRQ entry, branch extra cycles,
  page-cross cycles, and dummy reads can still advance CPU clocks inside
  `Cpu65xxVice.tick()` without `vicii_cycle()` being called at the same
  exact place.
- `vicii_cycle()` returns BA-low and the code ORs that into
  `maincpu_ba_low_flags`, but C64 CPU read accesses do not yet execute
  the VICE `check_ba()` / `maincpu_steal_cycles()` behavior.

That means the renderer can be "literal" while the machine timing is
still not. Raster splits, bad-lines, sprite DMA, and loaders that run
close to IRQ/raster boundaries can still diverge.

## Source of truth

Use the installed VICE source as the only source of truth:

- `/Users/alex/Development/C64/Tools/vice/vice/src/c64/c64cpusc.c:47`
  `CLK_INC()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/mainc64cpu.c:97`
  `interrupt_delay()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/mainc64cpu.c:112`
  `maincpu_steal_cycles()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/mainc64cpu.c:194`
  `check_ba()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/mainc64cpu.c:273`
  `memmap_mem_read()` and `memmap_mem_read_dummy()` call `check_ba()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/mainc64cpu.c:317`
  `LOAD_CHECK_BA_LOW`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-cycle.c:374`
  `vicii_cycle()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/viciisc/vicii-cycle.c:628`
  `vicii_steal_cycles()`
- `/Users/alex/Development/C64/Tools/vice/vice/src/6510dtvcore.c`
  all `CLK_INC()` call sites inside instruction execution and interrupt
  entry.

Project docs:

- `docs/vice-c64-arch.md` §2.1, §2.2, §3.4, §5.6, §5.7, §11, §13
- `specs/400-tick-order-port.md`
- `specs/404-c64-phase-d-vic-ii.md`

If docs and VICE source disagree, VICE source wins. Update docs after
the code is verified.

## Current TS audit

Relevant current files:

- `src/runtime/headless/integrated-session.ts`
- `src/runtime/headless/cpu/cpu65xx-vice.ts`
- `src/runtime/headless/vic/literal/vicii-cycle.ts`
- `src/runtime/headless/vic/literal/vicii-irq.ts`
- `src/runtime/headless/vic/literal/vicii-mem.ts`

Current default literal path:

```ts
// IntegratedSession.stepMicrocodedC64Instruction()
do {
  this.updateMicrocodedInterruptLines(); // now mostly no-op
  this.vic.tick(1);                      // calls literal vicii_cycle()
  const before = this.c64Cpu.cycles;
  cpu.executeCycle();                    // may internally tick 1..N cycles
  const consumed = after - before;
  if (consumed > 1) this.vic.tick(consumed - 1);
} while (!cpu.isAtInstructionBoundary());
```

Current `Cpu65xxVice.tick()`:

```ts
if (Cpu65xxVice.perCycleAlarmDrain) this.drainAlarms();
this.cpuIntStatus.bumpDelays(this.clk);
this.clk = clkAdd(this.clk, 1);
this.maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII;
```

Deviation:

- `tick()` is the TS equivalent of VICE `CLK_INC()`, but it does not
  call `vicii_cycle()`.
- `vicii_cycle()` is called outside the CPU tick by the session.
- CPU-internal tick sites cannot be precisely interleaved with VIC.
- BA-low is produced, but CPU reads do not call a VICE-equivalent
  `check_ba()`.

## Target contract

After this spec, the active C64 path must have exactly one owner for
machine-clock advancement:

```ts
// Conceptual TS equivalent of VICE c64cpusc.c CLK_INC()
private clkInc(): void {
  interrupt_delay();                         // drain alarms + IRQ/NMI delay
  maincpu_clk++;
  maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII;
  maincpu_ba_low_flags |= vicii_cycle();     // literal port, direct
}
```

The TS implementation does not need to use these exact names, but the
observable order must match.

Important: do not reinterpret Phi1/Phi2 manually. `vicii_cycle()` is
already the VICE port. The task here is to call it from the same clock
increment place where VICE calls it.

## Implementation plan

### Step 1 — Add a C64-only VIC cycle hook to `Cpu65xxVice`

Add constructor options to `Cpu65xxVice`:

```ts
interface Cpu65xxViceOptions {
  ...
  c64ViciiCycle?: () => 0 | 1;
}
```

Rules:

- The hook is optional so the same CPU class can still be used by the
  1541 drive.
- If `c64ViciiCycle` is absent, `tick()` behaves exactly as it does now.
- If present, `tick()` must call it immediately after:
  1. alarm drain / interrupt delay bump,
  2. `clk++`,
  3. clearing `MAINCPU_BA_LOW_VICII`.
- The hook returns VICE `ba_low`.
- `tick()` ORs the return value into `maincpu_ba_low_flags`.
- No `IntegratedSession` code may separately OR BA into the CPU after
  this hook is active.

Expected shape:

```ts
private tick(): void {
  if (Cpu65xxVice.perCycleAlarmDrain) this.drainAlarms();
  this.cpuIntStatus.bumpDelays(this.clk);
  this.clk = clkAdd(this.clk, 1);
  this.maincpu_ba_low_flags &= ~Cpu65xxVice.MAINCPU_BA_LOW_VICII;

  const baLow = this.c64ViciiCycle?.() ?? 0;
  if (baLow) {
    this.maincpu_ba_low_flags |= Cpu65xxVice.MAINCPU_BA_LOW_VICII;
  }
}
```

Do not call `this.vic.tick(1)` to compensate for this later.

### Step 2 — Make `tickLitVic()` return BA and stop mutating CPU flags

Change `IntegratedSession.tickLitVic()` from a side-effect writer into
a narrow literal VIC call:

```ts
private tickLitVic(): 0 | 1 {
  const baLow = (LIT_CYCLE.vicii_cycle() & 1) as 0 | 1;
  this.lastLitBaLow = baLow;
  ... framebuffer/raster-line capture ...
  ... CIA2 bank phi update exactly as verified ...
  return baLow;
}
```

Rules:

- It may update literal VIC bookkeeping and framebuffer capture.
- It must not write `cpu.maincpu_ba_low_flags`.
- It must not advance CPU clocks.
- It must not call legacy `VicIIVice.tick()`.

### Step 3 — Pass the hook when constructing the C64 CPU

In `IntegratedSession`, when creating the C64 `Cpu65xxVice`, pass:

```ts
c64ViciiCycle: this.useLiteralPortRenderer
  ? () => this.tickLitVic()
  : undefined
```

Only the C64 CPU receives this hook. The 1541 drive CPU must not.

### Step 4 — Remove session-side per-cycle VIC pumping for the active path

In `stepMicrocodedC64Instruction()`:

- Remove `this.vic.tick(1)` from the `useLiteralPortVicPerCycle` path
  when the CPU has a `c64ViciiCycle` hook.
- Remove `if (consumed > 1) this.vic.tick(consumed - 1)` for that path.
- Keep the loop around `cpu.executeCycle()` until boundary.
- Keep legacy fallback paths only for explicitly non-literal or
  non-microcoded modes.

The active literal/microcoded path should become conceptually:

```ts
do {
  cpu.executeCycle(); // every internal CPU tick now also runs vicii_cycle()
} while (!cpu.isAtInstructionBoundary());
```

This is the key change. IRQ entry, BRK entry, page-cross dummy cycles,
branch-taken cycles, and illegal-opcode burn cycles must all call
`vicii_cycle()` from inside the CPU's own `tick()`.

### Step 5 — Port VICE BA read-stall behavior

Implement the read-side part of VICE `check_ba()`.

VICE behavior:

- `maincpu_ba_low_flags` is checked before CPU read-style accesses that
  use `LOAD_CHECK_BA_LOW` / `LOAD_CHECK_BA_LOW_DUMMY`.
- If VIC-II BA is low, VICE calls `vicii_steal_cycles()`.
- `vicii_steal_cycles()` loops:

```c
do {
    maincpu_clk++;
    ba_low = vicii_cycle();
} while (ba_low);
```

- After stealing, `maincpu_steal_cycles()` drains pending alarms.
- Writes pass. Do not stall writes.

TS target:

- Add a private `checkBaBeforeRead()` in `Cpu65xxVice`.
- Call it from `loadFetch`, `loadRead`, and `loadDummy`.
- Do not call it from `store` or `storeDummy`.
- If `MAINCPU_BA_LOW_VICII` is set and `c64ViciiCycle` exists:
  - emulate `vicii_steal_cycles()` by advancing `this.clk` and calling
    `c64ViciiCycle()` until it returns 0;
  - clear the VICII BA flag when done;
  - drain alarms after the steal, matching `maincpu_steal_cycles()`.
- Count stolen cycles in `this.clk` because VICE `maincpu_clk` advances.
- Emit a trace/debug counter if useful, but do not make tracing required
  for correctness.

Important: do not use the old `CycleLockstepScheduler` bus-stall path
as the implementation. That path is a historical approximation. The
active microcoded C64 CPU must own the read-stall behavior.

### Step 6 — Keep chip-side IRQ push as-is

Do not revert VIC IRQs back to session polling.

Expected current model:

- `vicii_irq_*` calls literal host callbacks.
- Host callback calls `cpuIntStatus.setIrq(...)`.
- `updateMicrocodedInterruptLines()` stays no-op for chip-side sources.
- CPU samples `cpuIntStatus` at instruction boundary.

The only intended IRQ change in this spec is timing: because
`vicii_cycle()` now runs from `Cpu65xxVice.tick()`, raster IRQ assertion
happens at the same clock increment site as VICE.

## DO

- Do cite the VICE source file and line in comments around the new hook
  and BA-stall code.
- Do keep the active path small: `Cpu65xxVice.tick()` owns
  `CLK_INC()` semantics.
- Do preserve the drive CPU path. The 1541 has no VIC-II hook.
- Do keep chip-side CIA/VIC IRQ push into `InterruptCpuStatus`.
- Do add focused smokes before broad game testing.
- Do compare traces at the first divergence when a smoke fails.
- Do update `specs/404-c64-phase-d-vic-ii.md` status notes after this
  spec lands, because its middle audit section still contains stale
  pre-404 statements.

## DON'T

- Do not patch Last Ninja, Maniac Mansion, Scramble, or any loader.
- Do not change G64/D64 parsing, GCR rotation, IEC, VIA, or mount logic.
- Do not change the literal VIC draw functions to hide timing bugs.
- Do not add another scheduler mode.
- Do not resurrect session-side IRQ polling.
- Do not use `this.vic.tick(consumed)` or `this.vic.tick(1)` in the
  active literal/microcoded path after the hook exists.
- Do not make `CycleLockstepScheduler` the fix for BA stealing.
- Do not touch SID/audio/export/UI in this spec.
- Do not "optimize" the clock loop before it is correct.

## Acceptance tests

Add these focused tests before relying on game screenshots.

### 1. CLK_INC hook placement smoke

Create `scripts/smoke-425-clk-inc-contract.mjs`.

Purpose:

- Run a tiny deterministic program with:
  - normal instruction,
  - page-cross read,
  - taken branch,
  - forced IRQ entry.
- Instrument the literal VIC hook count.
- Assert that `vicii_cycle()` is called once per CPU clock increment,
  including internal CPU ticks.
- Assert that `stepMicrocodedC64Instruction()` does not perform a
  post-hoc `consumed - 1` VIC catch-up.

Pass condition:

- For this smoke, disable/avoid BA stealing. Then
  `viciiCycleCalls === cpu.cycles - startCycles` after the controlled
  run.
- BA stealing is validated separately in the next smoke because stolen
  cycles advance `maincpu_clk` without executing CPU micro-ops.

### 2. BA read-stall smoke

Create `scripts/smoke-425-ba-read-stall.mjs`.

Purpose:

- Force or construct a known bad-line/sprite-DMA BA-low window.
- Execute a CPU read during BA-low.
- Assert:
  - CPU PC/register state does not advance through the read until BA
    releases;
  - `maincpu_clk` advances;
  - `vicii_cycle()` advances for each stolen cycle;
  - writes during BA-low still pass.

Use a small synthetic PRG if that is simpler than booting a game.

### 3. Existing VIC smokes

Run:

- `smoke-404-cycle-table-diff`
- `smoke-404-badline-trace`
- `smoke-404-sprite-dma`
- `smoke-404-raster-irq`

These must stay green.

### 4. Existing CPU/CIA/IEC smokes

Run:

- `smoke:cpu-fidelity`
- `smoke:cia-fidelity`
- `smoke-423-bare-boot`
- `smoke-423-load-directory`
- `smoke-423-motm-canary`
- `smoke-423-krill-loader`

These must stay green. If they fail, investigate first divergence in
the clock/IRQ trace. Do not change IEC/GCR as a first response.

### 5. Game canaries

Run the existing game scripts for:

- Murder on the Mississippi / MoTM
- Scramble Infinity / Krill
- Maniac Mansion, if current branch has an expected baseline
- Last Ninja, as the new stress canary

The purpose of Last Ninja is to expose remaining VIC/BA/raster timing
issues. Do not make Last Ninja-specific fixes.

## Trace expectations

For this spec, the DuckDB/swimlane trace should show:

- every C64 CPU clock increment has a paired literal `vicii_cycle()`;
- raster IRQ assertion appears from `vicii_irq_*` at the VIC cycle, not
  from session-side polling;
- BA-low appears as a VIC result first, then CPU read-stall follows;
- IRQ entry cycles each advance VIC individually, not as a post-hoc
  batch after the 7-cycle entry.

If the trace cannot show this, add the minimal trace fields needed:

- `cpu_clk`
- `cpu_phase` or `cpu_event`
- `vic_raster_line`
- `vic_raster_cycle`
- `vic_ba_low`
- `irq_global_pending`
- `irq_delay_cycles`
- `nmi_delay_cycles`
- `stolen_cycles`

## Out of scope

- VSP bug fidelity.
- Lightpen.
- SID.
- UI/monitor changes.
- Drive/IEC/GCR/mount behavior.
- New emulator architecture or Rust port.
- Performance optimization beyond removing duplicate VIC ticks.

## Completion criteria

This spec is DONE only when:

1. Active C64 microcoded/literal path has no session-side VIC catch-up.
2. `Cpu65xxVice.tick()` or its renamed equivalent is the only active
   owner of C64 `CLK_INC()` semantics.
3. `vicii_cycle()` is called from that clock increment path.
4. CPU read accesses honor VIC BA-low stealing.
5. Existing 404 and 423 smokes remain green.
6. At least one trace proves IRQ entry and BA stealing are interleaved,
   not batched.
7. No unrelated loader, drive, GCR, IEC, renderer, UI, or game-specific
   patch was made.
