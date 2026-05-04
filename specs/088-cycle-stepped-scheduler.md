# Spec 088 — Cycle-stepped scheduler (cycle-perfect MVP)

## Problem

Current `IntegratedSession.stepC64Instruction()` runs ONE C64
instruction (2-7 cycles), then batches CIA / VIC / SID / drive ticks
for that batch. Drive accumulates fractional cycles and runs whole
drive instructions when accumulator >= 1.

Effects:
- Drive sees C64 bus state changes only AFTER the C64 instruction
  completes — drive cannot react cycle-precisely to e.g. `STA $DD00`
  followed by tight loop sampling.
- ATN edge detection on drive CA1 is delayed by a full instruction.
- Custom fastloader bit-bang protocols (MM stage-2 M-W install via
  raw $DD00 writes — NOT via KERNAL CIOUT) need drive to ACK each
  bit within microseconds. Drive's response loop polls $1800 every
  3-4 cycles. With instruction-batch granularity drive misses the
  short-lived bus states.

User mandate (May 2026): cycle-perfect is MVP, not long-term. Every
game must boot in headless without manual intervention.

## Decision

Refactor scheduler to **cycle-stepped** model. Drive runs cycle-by-
cycle interleaved with C64 (drive 1.0149× C64 cycle ratio handled
via fractional accumulator). CIA / VIC / SID tick per cycle. IEC bus
state changes propagate within the same cycle to drive's read.

This is the VICE model (per `src/iecbus/iecbus.c` + `src/maincpu.c`
mainloop pattern: every $DD00 access calls
`drive_cpu_execute_one(unit, clock)` to align drive cycles).

## Scope

### New scheduler in `IntegratedSession`

Replace `stepC64Instruction` with two-tier interface:

```ts
// Per-instruction batched API (existing, kept for back-compat tests).
stepC64Instruction(): void;

// Per-cycle API (NEW for cycle-perfect mode).
stepCycle(): void;
```

`stepCycle()` advances ONE C64 cycle. Internally:

1. If C64 has cycle budget left for current instruction: continue
   instruction. Else: fetch + decode next instruction → set cycle
   budget.
2. Bus access happens at correct cycle within instruction (per 6502
   memory access pattern table).
3. Tick CIA1, CIA2, VIC, SID by 1 cycle.
4. Advance drive cycle accumulator by `driveCyclesPerC64Cycle`.
5. While drive accumulator >= 1: execute next drive cycle (drive
   instruction continues if mid-instr, or fetch next opcode).
6. Check IRQ / NMI lines — service before next C64 instruction begin.

`stepC64Instruction()` becomes: loop `stepCycle()` until current
C64 instruction completes.

### CPU 6510 cycle-stepped state

`Cpu6510` gains:
- `currentInstruction?: { opcode: number; remainingCycles: number; ... }`
- `stepCycle()` method that advances one cycle, completing current
  instruction or starting next.

Bus accesses dispatched per cycle per opcode access pattern. For
most ops, write happens on last cycle of instruction. For RMW
(INC/DEC/ASL/ROL etc.), write on cycle 4 or 5 of 6-7 cycle inst.

For Sprint 88 v1: simplification — execute whole instruction on
first cycle, then "consume" remaining cycles as no-ops (so other
peripherals get correct cycle count). Bus-cycle-exactness deferred
to Sprint 89.

### Drive runs in lockstep

Replace current `runOneDriveStep` (full drive instruction) with
`stepDriveCycle` that advances drive ONE cycle. Drive instruction
spans multiple cycles. Drive bus access (read/write VIA1/2) at
correct cycle within drive instruction.

For Sprint 88 v1: same simplification — execute whole drive
instruction on first cycle, then "consume" remaining cycles.

### IEC bus per-cycle propagation

Current `IecBus.beforeC64Read` callback (added in late Sprint 83)
already flushes drive cycles before each $DD00 access. Keep for
back-compat batched mode.

In cycle-stepped mode: drive sees current bus state on every cycle,
since drive runs interleaved.

### Step loop reorganisation

Current:
```ts
stepC64Instruction(): void {
  this.checkC64Interrupts();
  const before = c64.cycles;
  c64.step();
  const consumed = c64.cycles - before;
  cia1.tick(consumed); cia2.tick(consumed); vic.tick(consumed); sid.tick(consumed);
  driveAccumulator += consumed * ratio;
  while (driveAccumulator >= 1) runOneDriveStep();
}
```

New:
```ts
stepCycle(): void {
  this.checkC64InterruptsIfStartOfInstruction();
  c64.stepCycle();
  cia1.tick(1); cia2.tick(1); vic.tick(1); sid.tick(1);
  driveAccumulator += driveCyclesPerC64Cycle;
  while (driveAccumulator >= 1) {
    drive.stepCycle();
    driveAccumulator -= 1;
  }
}

stepC64Instruction(): void {
  do { this.stepCycle(); } while (!c64.isInstructionComplete());
}
```

### Instrumentation

- `headless_session_step` MCP tool gets `granularity: "instruction" | "cycle"` option.
- Trace events optionally per-cycle (large data — gated).
- `headless_monitor_registers` snapshot now includes `cycleInInstruction`.

### Performance

Cycle-stepping is ~3× more overhead vs instruction-batching (3-cycle
average instructions × per-cycle hooks). Acceptable for headless
analysis use case where wall-clock speed isn't critical. Production
runs of long traces may opt back into instruction-batched mode.

## Out of scope (Sprint 89+)

- Bus access at exact cycle within instruction (Sprint 89).
- VIC bad-line + sprite-DMA at exact cycle within scanline (Sprint 90).
- 6510 internal pipelining quirks.

## Acceptance

- `stepCycle` advances exactly 1 cycle of wall-clock time.
- MM stage-2 custom fastloader: drive RAM $0500-$07FF gets non-zero
  MM custom code installed via raw $DD00 bit-bang.
- Drive's `$E83E` M-W handler hits at least once with valid command.
- After successful install: MM reaches title screen with character
  select (sprites visible).
- Existing instruction-batched tests pass without changes.
- Headless smoke vs VICE trace: drive PC sequence within first 100
  drive instructions matches VICE for same scenario.
