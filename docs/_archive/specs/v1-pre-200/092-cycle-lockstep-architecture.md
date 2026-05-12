# Spec 092 — Cycle-lockstep architecture (clean C64+1541 emulation)

## Problem

Current architecture batches at instruction granularity. Drive lazy-
executes via `executeToClock`. Per-bus-access cycle precision (Sprint 91
v1) helps but still relies on instruction-boundary sync.

Real C64 + 1541 are TWO independent CPUs running concurrently at slightly
different clocks (985.248kHz / 1MHz). Real custom fastloaders synchronise
via shared bus state at single-cycle granularity. ANY emulator that can
boot custom-loader games must run **cycle-by-cycle in lockstep**.

References:
- **virtualc64** (Dirk W. Hoffmann, MIT-style, github.com/dirkwhoffmann/virtualc64) — C++. Each chip = class with `executeOneCycle()`. Main loop ticks all chips per cycle. Bit-accurate by construction.
- **VICE** — alarm-context scheduling for efficiency but CPU has CLK_ADD per bus access. Effectively cycle-precise.
- **CCS64** — cycle-by-cycle, closed source.
- **Gideon's 1541-Ultimate** — FPGA. Real silicon at real clock. Reference for what behaviour is required, not for software architecture.
- **Hoxs64** — cycle-perfect, closed source, considered most accurate.

## Decision

Adopt the **virtualc64 cycle-lockstep model**. Every component (CPU,
CIA, VIC, SID, drive CPU, drive VIA1/VIA2) implements `executeCycle()`
that advances exactly 1 cycle of its own clock. Main loop ticks all
components per "wall clock" cycle. C64 components tick at 985.248kHz;
drive components tick at ~1.0149× to match drive's 1MHz.

This replaces the current instruction-batched model entirely. Drive lazy
execute (Spec 090) and per-bus-access cycle counting (Spec 091) become
unnecessary — they were workarounds for not having lockstep.

## Architecture

### Component interface

```ts
export interface CycleSteppable {
  // Advance one cycle of this component's clock.
  executeCycle(): void;
  // Optional: report this component's current internal cycle counter.
  cycle(): number;
}
```

### Components implementing CycleSteppable

C64 side (985.248kHz):
- `Cpu6510` — 6510 CPU. Tracks current instruction's remaining cycles + sub-cycle bus access pattern.
- `Cia6526` × 2 — CIA1 + CIA2. Timer A/B decrement per cycle; ICR set on underflow.
- `VicII` — VIC raster + IRQ + sprite DMA + bad-line stealing.
- `Sid6581` — SID register file (Sprint 82) + ADSR engine.

Drive side (1MHz, but ticked at 1.0149× via fixed-point):
- `DriveCpu6502` — drive 6502.
- `Via6522` × 2 — VIA1 (IEC) + VIA2 (GCR).
- `HeadPosition` + `TrackBuffer` — disk I/O state.

Bus state (instantaneous propagation):
- `IecBus` — wired-AND OR of all line drivers. Updated whenever ANY driver changes its output. Both CPUs read current state on every bus read.
- `HeadlessMemoryBus` — C64 memory map (PLA + I/O + RAM/ROM banking).
- `DriveBus` — drive memory map (RAM/VIA/ROM).

### Main scheduler

```ts
export class CycleLockstepScheduler {
  private c64Cycle = 0;
  private driveCycle16dot16 = 0;
  // Drive ticks per C64 tick. PAL: 1.01477 (16.16 = 0x1_03C5).
  private driveTickRate = 0;

  constructor(private session: IntegratedSession) {
    this.driveTickRate = Math.round(1.01477 * 0x10000);  // PAL
  }

  executeC64Cycle(): void {
    // Tick all C64 chips by 1 cycle.
    this.session.cpu.executeCycle();
    this.session.cia1.executeCycle();
    this.session.cia2.executeCycle();
    this.session.vic.executeCycle();
    this.session.sid.executeCycle();
    this.c64Cycle++;
    // Tick drive components by their share. ratio is 1.0149 so most
    // C64 cycles tick drive 1× but every ~70 cycles tick drive 2×.
    this.driveCycle16dot16 += this.driveTickRate;
    while (this.driveCycle16dot16 >= 0x10000) {
      this.session.drive.executeCycle();
      this.driveCycle16dot16 -= 0x10000;
    }
  }

  // Run for N C64 cycles (precise wall-clock).
  runCycles(n: number): void {
    for (let i = 0; i < n; i++) this.executeC64Cycle();
  }

  // Run for N C64 instructions (variable wall-clock).
  runInstructions(n: number): void {
    let executed = 0;
    while (executed < n) {
      const wasInstrStart = this.session.cpu.isAtInstructionBoundary();
      this.executeC64Cycle();
      if (wasInstrStart) executed++;
    }
  }
}
```

### Cpu6510 cycle-stepped

`Cpu6510` becomes a state machine. Current state:
- `currentOpcode: number | null` — null = at instruction boundary, ready to fetch
- `currentMicrocode: MicroOp[]` — per-cycle bus access pattern of current opcode
- `currentMicroIdx: number` — which micro-op runs this cycle

`executeCycle()`:
1. If at instruction boundary: fetch opcode at PC, look up microcode pattern, set currentMicroIdx=0.
2. Execute current micro-op (read PC, read addr, write addr, internal compute, etc.).
3. Increment currentMicroIdx. If past end of microcode, mark instruction boundary done.

Microcode patterns extracted from VICE source (per Spec 091 decision —
script `scripts/extract-vice-opcode-cycles.mjs`).

Bus access via `executeCycle` happens at the EXACT cycle of access. Drive
sees bus state changes immediately because BOTH cpus tick in same loop.

### IRQ / NMI handling

After each C64 cycle: check IRQ pin (CIA1 OR VIC IRQ). If asserted AND
CPU at instruction boundary AND I-flag clear → service interrupt (push
PC + flags, jump to IRQ vector, set I-flag). Standard 6502 behaviour:
IRQ takes 7 cycles, can only happen at instruction boundary.

Drive IRQ similarly per drive cycle.

### Bus state propagation (CRITICAL)

When CPU writes $DD00:
- Cpu6510 micro-op fires bus.write
- HeadlessMemoryBus dispatches to CIA2 PA write
- CIA2 PA latch updated
- CIA2 calls `iecBus.setC64Output(pra, ddra)`
- IecBus recomputes effective line state
- ANY component reading bus state on next cycle sees new value

Drive next cycle reads $1800 → drive's VIA1 PB read returns
`iecBus.buildDrivePbInputBits()` which reflects current line state.

NO LAZY EXECUTION. NO BATCHING. State propagates at the cycle of write.

### Trade-offs

Performance: ~10 components × 1 method call per cycle × 985_248 cycles/sec = 10M JS calls/sec for real-time. Modern V8 handles this. For headless analysis we don't need real-time anyway.

Code size: every chip rewritten as state machine. Significant refactor (~2000 LOC new + ~1500 LOC removed).

Correctness: every cycle-tick game/demo should work. Worst-case = same as VICE.

## Scope

### Sprint plan

- **Sprint 92.1** — `CycleSteppable` interface. `CycleLockstepScheduler` skeleton. `Cpu6510` micro-coded state machine (microcode table from VICE script).
- **Sprint 92.2** — `Cia6526` cycle-stepped (timer A/B per cycle decrement).
- **Sprint 92.3** — `VicII` cycle-stepped (raster counter per cycle, sprite/bad-line stealing per cycle).
- **Sprint 92.4** — Drive `Cpu6502` + VIA1 + VIA2 cycle-stepped.
- **Sprint 92.5** — `IecBus` instantaneous state propagation (no `beforeC64Read` hook needed).
- **Sprint 92.6** — Remove obsolete instruction-batch code paths. Update all tests.
- **Sprint 92.7** — MM acceptance: boot reaches title screen via real cycle-lockstep. Other custom-loader smoke (Murder, Last Ninja, Impossible Mission II).

### Migration

Old API kept temporarily:
- `stepC64Instruction()` becomes `runInstructions(1)`.
- `runFor(n)` becomes `runInstructions(n)` with same breakpoint semantics.
- `flushDriveCycles()` removed (drive ticks lockstep, no flushing needed).
- Sprint 89 alarm-context kept for VIC raster IRQ scheduling (efficient lookup of "next compare line"). Other alarms refactored away as components self-tick.

### Microcode extraction

Script `scripts/extract-vice-opcode-cycles.mjs`:
- Parses `vice/src/6510core.c` opcode dispatch + addr-mode macros.
- Outputs `src/runtime/headless/cpu/microcode-table.ts` with per-opcode cycle access pattern.
- Re-runnable to incorporate VICE updates.

Microcode entry shape:
```ts
type MicroOp =
  | { kind: 'fetch_opcode' }
  | { kind: 'fetch_operand_lo' }
  | { kind: 'fetch_operand_hi' }
  | { kind: 'dummy_read', source: 'pc' | 'ea' | 'sp' }
  | { kind: 'read_ea' }
  | { kind: 'write_ea' }
  | { kind: 'dummy_write_ea' }   // RMW instructions
  | { kind: 'push' }
  | { kind: 'pop' }
  | { kind: 'internal' };        // ALU compute, no bus access

type MicrocodeEntry = {
  opcode: number;
  ops: MicroOp[];
  // Final-cycle action (where ALU result is written, branch decided, etc.).
  finalize: (cpu: Cpu6510, args: ResolvedArg) => void;
};
```

## Out of scope

- Full sub-cycle bus phasing (φ1/φ2 of 6502 bus). VIC accesses bus on φ1, CPU on φ2. We treat as single cycle.
- VIC sprite-DMA exact placement within scanline (already approximated in Sprint 84).
- Drive-side stepper motor cycle exactness.
- Audio synthesis (SID stays mock per Sprint 82).

## Acceptance

- MM reaches title screen with character select via real custom-loader bit-bang.
- Murder on the Mississippi reaches game start.
- Last Ninja Remix loads + reaches main menu.
- Impossible Mission II reaches title screen.
- All existing tests pass with `runInstructions(N)` migration.
- Per-instruction cycle counts match VICE for randomly-sampled opcode sequences.

## Refinement decisions (May 2026)

1. **Microcode via script** (A): `scripts/extract-vice-opcode-cycles.mjs`
   parses VICE source (or applies per-addr-mode templates derived from
   VICE) → generates `src/runtime/headless/cpu/microcode-table.ts`.
   Re-runnable. Bit-perfect VICE parity goal.
2. **Own scheduler class** (A): `CycleLockstepScheduler` in
   `src/runtime/headless/scheduler/`. IntegratedSession instantiates +
   delegates to it. Testable in isolation.
3. **Sprint order 92.1 → 92.7** (A): foundation first (microcode + CPU
   state machine), then chips, then drive, then bus, then cleanup,
   then game acceptance. No shortcuts.
4. **Old API removed** (A): all tests migrated to `runInstructions(N)`.
   `stepC64Instruction()` removed. Single code path.
5. **Accept perf hit** (A): cycle-lockstep is ~3× slower than batch.
   Tests adjust cycle budget. Optimisation only if it becomes practical
   blocker for analysis throughput.
