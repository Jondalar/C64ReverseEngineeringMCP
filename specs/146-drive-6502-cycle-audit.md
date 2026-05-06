# Spec 146 — Drive 6502 cycle-accuracy audit (1:1 VICE)

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/6510core.c + 6510dtvcore.c (drive uses
plain 6502, no DTV opcodes)
**Depends on**: Spec 145 (CIA — needed for cycle-accurate IRQ
delivery testing)

## Why

Sprint 112 commits established IEC bus formula 1:1 VICE. Spec 145
porting CIA. Drive RAM 99.4% match VICE at motm window. Remaining
divergence (6 stack bytes, 2 motm code bytes) traces to drive code
path BEFORE drive reaches \$0300 — in ATN service / IRQ entry path.

Likely cause: drive 6502 cycle accounting differs from VICE in
edge cases (dummy reads on IRQ entry, abs,X page-cross, RMW
instruction sequencing, illegal opcode patterns, branch-delay
interrupt logic).

VICE 6510core.c is THE reference for cycle-accurate 6510 emulation.
Audit our cpu6510-cycled.ts vs that source line-by-line.

## Scope

### Point 13: dummy reads
- IRQ/NMI entry: 2 dummy reads at PC + PC+1 BEFORE pushing PC.
  VICE 6510core.c DO_INTERRUPT macro shows the sequence.
- abs,X / abs,Y / (zp),Y page-cross: extra dummy read at base+
  index without high-byte fixup before fetching corrected addr.
- RMW abs,X: always extra dummy read (no page-cross requirement).
- (zp,X) / (zp),Y: zero-page wrap-around read at \$00FF/\$0000.
- BRK/PHP push P with B=1; IRQ/NMI push P with B=0.

### Point 14: branch-delay interrupt
VICE 6510core.c interrupt_check_irq_delay:
- Branch instructions delay IRQ/NMI by 1 cycle if branch is taken
  with NO page-boundary crossing (= +1 to irq_clk).
- OPINFO_DELAYS_INTERRUPT flag tracks this.
- I-flag-clearing instructions delay IRQ by 1 instruction (= the
  next opcode after CLI/PLP runs before IRQ services).

### Point 15: illegal opcodes
VICE 6510core.c handles all 256 opcodes including illegal/unstable.
Our impl has partial. Audit:
- LAX, SAX, DCP, ISB, RLA, RRA, SLO, SRE: stable illegal opcodes.
- ANC, ASR, ARR, ATX, AXS: stable but A-modifying.
- AHX, SHX, SHY, TAS: unstable illegal (depend on bus capacitance).
- KIL/JAM (HLT): drive ROM might trigger if RAM corrupted.

## Process

1. Read VICE 6510core.c systematically — table of opcodes per cycle.
2. Compare to our cpu6510-cycled.ts microcode tables.
3. List per-opcode discrepancies in cycles + dummy reads.
4. Port missing dummy reads + cycle counts 1:1.
5. Add OPINFO_DELAYS_INTERRUPT flag + branch-delay logic.
6. Verify with cpu equivalence harness (compare per-instr cycle
   counts vs VICE).

## Acceptance

- Every of 256 opcodes matches VICE cycle count + memory-access
  pattern (dummy reads, RMW double-write, page-cross extra cycle).
- Drive 6502 IRQ entry: 2 dummy reads + 3 pushes + 2 vector reads
  = 7 cycles total, with correct read addresses.
- Branch-delay interrupt: BNE/BEQ/etc taken w/o page-cross delays
  IRQ by 1 cycle.
- I-flag-clear delays IRQ by 1 instruction.
- All illegal opcodes implemented per VICE behavior.
- smoke:cpu-fidelity passes 100%.
- motm RAM diff at \$07A1 reduces to 0 bytes (eliminates the
  divergence we observed at stack \$012b-\$0143 + motm code
  \$0763, \$07b9).

## Estimated effort

1-2 sessions for full audit + port. Heavy reading of VICE source.
