# Spec 091 — VICE-style cycle-stepped 6510 with sub-instruction bus access

## Source studied

- `/Users/alex/Development/C64/Tools/vice/vice/src/6510core.c` — instruction core with `CLK_ADD` after each cycle of access
- VICE 6510core.c uses `CLK_ADD(CLK, N)` between bus accesses within an instruction so each access is at the CORRECT cycle.

## Concept

VICE doesn't execute instruction in one Go and then update CLK. It
executes step-by-step within instruction, calling `CLK_ADD(CLK, n)`
between each bus cycle. So when STA $DD00 runs:

```c
// (paraphrased from 6510core.c STA absolute)
{
  // cycle 1: opcode fetch  (CLK already advanced by macro)
  fetch_addr_lo();   CLK_ADD(CLK, 1);  // cycle 2
  fetch_addr_hi();   CLK_ADD(CLK, 1);  // cycle 3
  store(addr, A);    CLK_ADD(CLK, 1);  // cycle 4 — bus write at THIS cycle
}
```

When `store(addr, A)` happens, CLK is already at cycle-3 of the
4-cycle instruction. VICE's I/O write callback sees the correct CLK.
Drive runs to that CLK before the write, then write happens, then
next instruction begins.

## Why we need this

Currently our `Cpu6510.step()` executes the WHOLE instruction in one
JS call, then increments `cycles` by total. So when `STA $DD00`
fires, we fire it BEFORE we've advanced cycles. Drive's
`executeToClock(c64Cpu.cycles)` catches drive up to a CLK that's
behind by `instruction_cycles - 1`.

For most instructions this works (1-3 cycle delay tolerable). But
for tight bit-bang protocols where DRIVE's response time matters
within a few cycles, this delay matters.

## Decision

Refactor `Cpu6510` to advance `cycles` AS bus accesses happen, not
all at end. Bus access callback sees correct CLK at moment of access.

## Scope

### Per-opcode cycle layout

Each opcode has a "bus access pattern":
- Opcode fetch (cycle 1): always 1 read at PC
- Operand fetch (cycle 2-3): 1-2 reads at PC+1, PC+2
- Effective-address read/write: 1-N reads/writes at EA, PHA cycle 4

For implementation: encode each opcode as an array of "actions" each
specifying (cycleOffset, busAccess).

Example STA $XXXX (4 cycles):
```ts
[
  { cycle: 0, action: 'fetch_opcode' },     // PC, increment cycles by 1
  { cycle: 1, action: 'fetch_operand_lo' }, // PC+1
  { cycle: 2, action: 'fetch_operand_hi' }, // PC+2
  { cycle: 3, action: 'write_addr' },       // EA = lo+(hi<<8); write A
]
```

### Bus access callbacks at correct cycle

When step executes the array, each action calls `bus.read` /
`bus.write` AFTER incrementing `this.cycles`. So when bus.write
($DD00, A) fires, `this.cycles` already equals the cycle of the
write within the instruction.

Bus's IO handler for $DD00 calls `iecBus.setC64Output` which calls
`beforeC64Read` which calls `drive.executeToClock(this.cpu.cycles)`.
Drive catches up to the EXACT cycle of the bus write. Then write
happens. Next bus access (next opcode) catches drive up further.

### Sub-instruction bus access table

Need 256 opcodes × cycle pattern. VICE source has this implicitly
in 6510core.c via inline macros per addr-mode + per op. We need
similar table. Could extract from VICE source via grep.

### Performance

Per-cycle bus access overhead: each instruction now does
`instruction_cycles` callback dispatches instead of 1. ~3× CPU
overhead for emulation. Acceptable for analysis use case.

### Migration path

1. Keep `Cpu6510.step()` as legacy "instruction-batched" mode.
2. Add `Cpu6510.stepCycle()` for per-cycle, OR add per-opcode handler
   that updates `cycles` as it runs.
3. Use cycle-stepped mode only when `cycle_perfect` flag set on
   session.

## Out of scope

- 6510 internal register file timing (e.g. ANE/LXA undefined behaviour).
- Decimal mode cycle differences.

## Acceptance

- STA $DD00 instruction: at moment of bus write, `cpu.cycles` is at
  the LAST cycle of the instruction (cycle 4 of 4-cycle STA).
- LDA $DD00: at moment of bus read, `cpu.cycles` is at cycle 4.
- Drive sees C64's bus state changes at the cycle they actually
  happen (not 0-7 cycles later).
- All existing instruction tests pass with new model.
- Cycle-budget test: known instruction sequences match VICE cycle
  count exactly.

## Refinement decisions (May 2026)

1. **Extract cycle pattern from VICE source** (C): one-time automation
   script parses `vice/src/6510core.c` macros (LOAD_ABS, STORE_ABS,
   RMW_ABS, etc.) + opcode dispatch table. Outputs TS const array of
   per-opcode bus-access patterns. Bit-perfect match to VICE timing.
   Script lives in `scripts/extract-vice-opcode-cycles.mjs`.
2. **Model dummy-write for RMW** (A): INC/DEC/ASL/ROL/LSR/ROR memory
   instructions emit dummy-write of old value at cycle N, real-write
   of new value at cycle N+1. Critical for VIC IRQ acknowledge trick
   (`INC $D019` clears IRQ on first write) and other RMW-aware games.
3. **Cycle-stepped mode default ON** (A): no opt-in flag. Cycle-perfect
   is MVP per user mandate. ~3× CPU emulation overhead acceptable for
   LLM-driven analysis use case. Instruction-batched mode removed.

## Combined with Specs 089+090

After all three:
- 089: peripherals (CIA, VIC, SID) tick on alarms not per cycle.
- 090: drive lazy-executes to current C64 CLK on bus access.
- 091: C64 CLK updated mid-instruction at correct bus cycle.

Result: cycle-perfect headless that matches VICE's behaviour and
runs MM custom fastloader correctly.
