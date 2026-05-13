# Spec 435 — Phase E: Literal port of `drivecpu.c` catch-up

**Status:** OPEN  
**Priority:** HIGH  
**Parent:** [Spec 430](430-1541-iec-via-literal-vice-port.md) — Phase E  
**Depends on:** [Spec 434](434-1541-port-phase-d-viacore-subset.md)  
**Doctrine:** Literal VICE port. State names, fixed-point math, and
call order. The TS CPU core stays TS (own opcode dispatch); only the
**execution wrapper** (catch-up + sleep/wake + alarms surface) is
VICE-shaped.
**Anchors:**
- `docs/vice-iec-arc42.md` §5.4 (drivecpu)
- `docs/vice-iec-arc42.md` §5.7 (maincpu_clk and drive clk_ptr)
- `docs/vice-iec-arc42.md` §5.12 (sync_factor init)
- `docs/vice-1541-arch.md` §3.2 (execution loop)
- `docs/vice-1541-arch.md` §5 (drive sync 16.16 fixed-point)

## VICE source of truth

- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c` (737 LOC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drive.c`
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.h`

Functions to port literally (the wrapper, not the inner core):

- `drivecpu_init`
- `drivecpu_reset`
- `drivecpu_wake_up`
- `drivecpu_sleep` (effectively no-op in current VICE; keep as
  explicit no-op stub for parity)
- `drivecpu_execute(drv, clk_value)` — the catch-up entry
- `drive_cpu_execute_one(unit, clk_value)`
- `drive_cpu_execute_all(clk_value)`
- alarm-context wiring used by VIA1/VIA2 timers (Spec 434 IRQ
  stamping needs this)

## Required state (literal struct fields)

`drivecpu_context_t` equivalent fields — TS field names may use
camelCase but must map 1:1 to VICE struct fields, NOT to the current
ad-hoc names:

| VICE field | TS field (current → required) | Type |
|---|---|---|
| `last_clk` | `lastSyncC64Clk` → `lastClk` | uint64 |
| `stop_clk` | (new) `stopClk` | uint64 |
| `cycle_accum` | `cycleAccumulator16dot16` → `cycleAccum` | uint32 (16.16) |
| `sync_factor` | constant on PAL → `syncFactor` field | uint32 (16.16) |
| `int_status` | drive CPU int-status object | object |
| `clk_ptr` | (already routed) `driveClkPtr` | uint64 ref |

Rename existing TS fields to match (one commit). Do not keep two
field aliases.

## Required call order

### `drivecpu_execute(drv, clk_value)`

```text
drivecpu_wake_up(drv)
cycles = max(0, clk_value - cpu.last_clk)
cpu.cycle_accum += sync_factor * cycles
cpu.stop_clk    += cpu.cycle_accum >> 16
cpu.cycle_accum &= 0xFFFF
while drive_clk < stop_clk:
    execute one 6502 cycle through the TS core
    // alarms (VIA1 T1/T2, VIA2 T1/T2, rotation BYTE-READY) fire
    // INSIDE this loop at their scheduled drive_clk
cpu.last_clk = clk_value
drivecpu_sleep(drv)
```

`sync_factor` is loaded once from PAL config (Spec 434 already
keeps the VIA inside the same alarm context). NTSC is deferred per
[[feedback_pal_first_ntsc_later]].

### `drive_cpu_execute_one(unit, clk_value)`

VICE-style: calls `drivecpu_execute(unit->drive, clk_value)` for
unit 8 (1541 only in our milestone).

### `drive_cpu_execute_all(clk_value)`

Iterates over registered units. With only unit 8 active, identical
to `drive_cpu_execute_one(8, ...)` but the function name must exist
to match Spec 432 call sites.

## Headless files in scope

- `src/runtime/headless/drive/drive-cpu.ts` (1248 LOC) — rewrite the
  catch-up wrapper portion; keep the inner per-cycle 6502 dispatch
- `src/runtime/headless/kernel/headless-machine-kernel.ts` — only
  the field-name rename and call-site update
- `src/runtime/headless/kernel/headless-kernel-bus.ts` — kill
  `computeCycleStepped()` and any `_cycleStepped` consumers

## Wrapper purge (this phase's slice of Phase F)

- Delete `computeCycleStepped()` and `_cycleStepped` field
- Delete `vice-whole-instruction` fallback branch in
  `DriveCpu.executeToClock` (already dead per analysis doc Risk 4)
- Delete `pc < 0xa000` heuristic and its comments
- Delete the `C64RE_USE_WHOLE_INSTRUCTION_DRIVE` env-flag handling
- Rename `lastSyncC64Clk` → `lastClk`, `cycleAccumulator16dot16` →
  `cycleAccum` consistently across the codebase (one commit)

## Acceptance

1. `drive-cpu.ts` execution wrapper mirrors `drivecpu_execute`
   pseudocode above. File header lists VICE source lines.
2. Field names match the table above. Grep returns zero remaining
   `cycleAccumulator16dot16` / `lastSyncC64Clk` references in
   production code.
3. `drive_cpu_execute_one` and `drive_cpu_execute_all` exist as
   exported functions and are the only entry points used by
   `iecbus.ts` (Spec 432) and the C64 main-loop tick scheduler.
4. Hybrid sync vocabulary (`cycleStepped`, `whole-instruction`)
   does not appear in production code grep.
5. All 4 green canaries from Spec 431 remain green.
6. LNR-S1 divergence-row report updated; first-divergence at
   `$DD00`/`$1800` events must be at same drive-clock ±1 as VICE
   baseline (this is the key Phase E acceptance — drive clock
   alignment at IEC events).

## Do Not

- Do not rewrite the inner 6502 opcode dispatch (Spec 428 territory).
- Do not change drive ROM loading or memory map.
- Do not introduce a new alarm system; reuse the one already wired
  in Spec 434.
- Do not change PAL/NTSC mode handling beyond what is needed for
  PAL-only.

## Agent Instruction

```text
Implement Spec 435. Rewrite only the catch-up wrapper portion of
drive-cpu.ts to match VICE drivecpu.c — drivecpu_execute,
drive_cpu_execute_one/all, drivecpu_wake_up/sleep — with literal
state (last_clk, stop_clk, cycle_accum, sync_factor). Rename TS
fields to the table in the spec. Delete every hybrid/cycleStepped/
whole-instruction artifact. Keep canaries green per Spec 431. The
LNR-S1 drive-clock-at-$DD00 mismatch must close to ±1 cycle of VICE
baseline.
```
