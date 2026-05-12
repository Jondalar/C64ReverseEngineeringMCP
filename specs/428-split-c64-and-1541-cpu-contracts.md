# Spec 428 — Split C64 and 1541 CPU execution contracts

**Status:** DRAFT 2026-05-12
**Branch:** `vic_bugs`
**Depends on:** 427 (IM2 regression evidence), 401 (failed shared-core
foundation), earlier CPU split attempt (Spec 358, not present in current
tree)
**Doctrine:** Do not force the C64 main CPU and the 1541 drive CPU through
one execution contract. They share ISA semantics, but not the VICE runtime
loop.

## Problem

The current runtime uses `Cpu65xxVice` as the shared implementation for:

- C64 6510 main CPU
- 1541 drive 6502 CPU

This was attractive because the opcode semantics overlap. It is also the
source of recurring loader regressions. Spec 401 changed `Cpu65xxVice`
toward the x64sc C64 execution contract and applied that behavior to the
drive as well. IM2 regressed exactly at that boundary.

VICE keeps these contracts separate:

| Machine side | VICE files | Runtime contract |
|---|---|---|
| C64 x64sc CPU | `src/c64/c64cpusc.c` + `src/6510dtvcore.c` | cycle-stepped C64 main loop; `CLK_INC`; VIC/CIA alarms; BA-low stalls; 6510 `$00/$01` port |
| 1541 drive CPU | `src/drive/drivecpu.c` + `src/6510core.c` | drive-local opcode-template loop; drive alarm context; VIA IRQs; GCR rotation hooks via `drivecpu_rotate()` |

The split is not optional if the goal is 1:1 VICE behavior. A single class
can still share generated opcode primitives internally, but the public
execution loops, timing hooks, interrupt sampling, and disk rotation hooks
must be separated.

## Goals

1. Keep the C64 CPU aligned with x64sc:
   - `c64cpusc.c`
   - `6510dtvcore.c`
   - `mainc64cpu.c` interrupt-delay behavior
   - VIC/CIA alarm timing
   - BA-low read stalls
   - 6510 I/O port behavior
2. Keep the 1541 drive CPU aligned with VICE drive:
   - `drivecpu.c`
   - `6510core.c`
   - drive-local `CLK`, `last_clk`, `stop_clk`, and `cycle_accum`
   - `PROCESS_ALARMS`
   - VIA1/VIA2 IRQ sampling at the same opcode-template points as VICE
   - `drivecpu_rotate()` and `byte_ready_edge` handling at the same
     template sites as VICE
3. Preserve a shared opcode-semantic test corpus where possible, but do
   not share execution-loop state machines when their VICE contracts
   differ.
4. Fix IM2 by returning the drive to the VICE drive contract, not by adding
   game-specific timing constants.

## Non-goals

- Do not rewrite the full CPU core in one step.
- Do not change VIC rendering, VIC bank selection, G64 parsing, media
  mount lifecycle, or IEC bus polarity for this spec unless the evidence
  from Spec 427 proves a direct dependency.
- Do not introduce per-game switches.
- Do not make the drive follow x64sc `CLK_INC`; VICE drive does not do
  that.

## VICE drive CPU mapping (= reference target)

VICE drive CPU is **not** one class. It is three explicit contexts +
two outer loops. Cite `src/drive/drivetypes.h` + `src/drive/drivecpu.c`
+ `src/6510core.c` + `src/c64/c64cpusc.c`:

| VICE C type / file | Purpose | Our equivalent (today) | Gap |
|---|---|---|---|
| `mos6510_regs_t` (drivetypes.h:99) | A/X/Y/SP/PC/P registers | inside `Cpu65xxVice` | shared with C64 — OK as ISA primitives |
| `drivecpu_context_t` (drivetypes.h:59) | per-drive CPU-internal state: `int_status`, `alarm_context`, `last_clk`, `last_exc_cycles`, `stop_clk`, `cycle_accum`, `cpu_regs`, `d_bank_base/start/limit`, `last_opcode_info`, `is_jammed`, `rmw_flag` | eingebettet in `Cpu65xxVice` + `DriveBus` + `DriveCpu` | **falsch geshared mit C64 main CPU** |
| `drivecpud_context_t` (drivetypes.h:119) | drive memory dispatch: `read_tab[1][0x101]`, `store_tab[1][0x101]`, `peek_tab`, `sync_factor` | `DriveBus.readTab/storeTab/peekTab` + `DriveCpu.syncFactor16dot16` | shape mostly OK (Spec 408 per-page dispatch landed) |
| `diskunit_context_t` (drivetypes.h:166) | top-level drive unit: `cpu`, `cpud`, `drives[]`, ROM, type, mynumber, clk_ptr | `DriveCpu implements Drive1541Unit` | shape OK |
| `mainc64cpu.c` (outer loop) | C64 main CPU execution: x64sc `CLK_INC` macro after every clock, VIC/CIA alarm dispatch, BA-low stall | `Cpu65xxVice.tick()` + `executeCycle()` | doctrinally correct for C64 |
| `drivecpu.c:drivecpu_execute()` (outer loop) | drive CPU execution: sync_factor → owed cycles → stop_clk → while-loop over `#include "6510core.c"` opcode templates with `drivecpu_rotate()` hooks | **missing** — drive uses the C64-shaped `Cpu65xxVice.executeCycle()` instead | **regression source** |
| `6510core.c` (shared) | generic 6510 ISA opcode templates with internal CLK accounting + LOCAL_SET_OVERFLOW / PHP / BVC / BVS rotate hooks | partial — we have ISA semantics but no rotate-hook insertion sites | rotation hook placement needed |
| `6510dtvcore.c` (C64 x64sc only) | DTV-style cycle-stepped extension to 6510core for x64sc CLK_INC | absorbed into `Cpu65xxVice.tick()` path | C64-only — fine |

The pattern: VICE uses **one ISA core file** (`6510core.c`) and **two outer
loops** (`mainc64cpu.c` for C64, `drivecpu.c` for drive). The outer loops
differ; the ISA primitives don't.

Our current code reverses that pattern: one outer-loop class
(`Cpu65xxVice.tick()` + `executeCycle()`) used for both, plus duplicated
ISA primitives inside. We must invert it: shared ISA primitives, two
outer-loop classes.

## Proposed Architecture

Introduce two explicit runtime-facing CPU contracts:

```ts
interface C64MainCpuContract {
  executeCycle(): void;
  isAtInstructionBoundary(): boolean;
  c64ViciiCycle?: (clk: number) => number;
  cpuIntStatus: InterruptCpuStatus;
  ioPortHook: IoPort6510Hook;
}

interface DriveCpuContract {
  executeUntilDriveClock(stopClk: number): void;
  executeOneDriveInstruction(): number;
  driveIntStatus: InterruptCpuStatus;
  onDriveRotateHook: () => void;
  onByteReadyHook: () => boolean;
}
```

Implementation shape:

- `C64CpuViceSc`:
  - owns the x64sc `6510dtvcore.c`-style cycle-stepped path.
  - may initially wrap or subclass current `Cpu65xxVice`, but the file
    must no longer claim to be the single source for both C64 and drive.
- `DriveCpuVice`:
  - owns the `drivecpu.c` + `6510core.c` path.
  - exposes whole-instruction dispatch to `DriveCpu.executeToClock`.
  - calls GCR rotation and byte-ready hooks at the VICE template sites,
    not generically once per CPU clock.
- Shared code is allowed only below the contract boundary:
  - flag helpers
  - addressing-mode helpers if timing-neutral
  - opcode semantics where the VICE templates are identical
  - Lorenz/functional opcode tests

## Implementation Phases

### Phase A — Evidence Gate

Before code changes:

1. Run Spec 427 Variant A:
   - base `2005494`
   - restore only `src/runtime/headless/drive/drive-cpu.ts` from
     `0a47f50`
   - IM2 must reach `$48D3-$48EE` to prove the drive path is sufficient.
2. Run Spec 427 Variant B:
   - base `2005494`
   - restore only `src/runtime/headless/cpu/cpu65xx-vice.ts` from
     `0a47f50`
   - record result.
3. Do not implement this spec if Variant A does not implicate the drive
   path.

### Phase B — Rename the Contracts

Make the architecture visible without changing behavior:

- Add `C64CpuViceSc` wrapper or alias for current C64 main CPU usage.
- Add `DriveCpuVice` wrapper or alias for current drive CPU usage.
- `IntegratedSession` and `DriveCpu` should type against the explicit
  contracts, not against `Cpu65xxVice` directly.
- This phase must be behavior-neutral.

### Phase C — Restore Drive Whole-Instruction Dispatch

Restore the VICE drive shape:

- `DriveCpu.executeToClock(c64Clk)` computes owed drive cycles via
  `sync_factor`, `cycle_accum`, and `stop_clk`.
- While drive `CLK < stop_clk`, execute one drive opcode template.
- Return consumed drive cycles per opcode.
- Tick GCR/rotation according to VICE drive hooks, not blindly once per
  external cycle.

Important: `gcrShifter.tick(N)` once per instruction is only a temporary
compatibility fallback. The correct target is VICE hook placement:

- `LOCAL_SET_OVERFLOW(0)` calls `drivecpu_rotate()` then clears
  `byte_ready_edge`.
- `PHP`, `BVC`, and `BVS` call `drivecpu_rotate()` and then consume
  `byte_ready_edge` if set.

### Phase D — Drive IRQ and Alarm Parity

Align drive IRQ timing with VICE drive CPU:

- drive alarm context belongs to drive CPU.
- VIA1/VIA2 IRQ levels feed the drive CPU interrupt status.
- IRQ sampling happens at the same instruction-template boundary as
  `6510core.c`, not at arbitrary C64-side cycle points.

### Phase E — Regression Gate

Required pass list:

- IM2 reaches `$48D3-$48EE` title idle within 200M C64 cycles.
- MM s1 reaches character select (`$65x` loop).
- Scramble Infinity reaches title/game code.
- motm canary reaches expected fastloader/game loop.
- Krill loader smoke stays green.
- Lorenz CPU corpus stays green.
- VICE drive test programs stay green.
- `npm run smoke:cpu-fidelity`
- `npm run smoke:cia-fidelity`

## Do Not Do

- Do not keep editing `Cpu65xxVice` until it can satisfy both C64 x64sc
  and 1541 drive timing. That is the architectural trap.
- Do not remove whole-instruction drive dispatch because it sounds less
  cycle-accurate. In VICE, the drive path is opcode-template based and
  still cycle-accounted internally.
- Do not treat IM2 as a special case.
- Do not apply later Spec 408-414 drive rewrites until the Spec 401
  regression split is proven and fixed.

## Acceptance

- The codebase has separate, named C64 and drive CPU runtime contracts.
- Drive CPU no longer depends on C64 x64sc-only `CLK_INC` behavior.
- IM2 regression from Spec 401 is fixed without weakening MM, Scramble,
  motm, or drive test programs.
- Documentation cites the exact VICE source files for both contracts.
