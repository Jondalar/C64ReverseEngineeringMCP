# Spec 146 — 65xx CPU cycle-accuracy audit (1:1 VICE)

**Sprint**: 113 (chip-level 1:1 VICE)
**Status**: proposed
**Source**: VICE 3.7.1 src/6510core.c (~3000 LOC switch + macros)
**Depends on**: Spec 145 (CIA — needed for cycle-accurate IRQ
delivery testing)
**Refinement**: locked 2026-05-06

## Why

Sprint 112 commits established IEC bus formula 1:1 VICE. Spec 145
porting CIA. Drive RAM 99.4% match VICE at motm window. Remaining
divergence (6 stack bytes, 2 motm code bytes) traces to drive code
path BEFORE drive reaches $0300 — in ATN service / IRQ entry path.

Likely cause: 65xx cycle accounting differs from VICE in edge
cases (dummy reads on IRQ entry, abs,X page-cross, RMW
instruction sequencing, illegal opcode patterns, branch-delay
interrupt logic).

VICE 6510core.c is THE reference for cycle-accurate 65xx emulation.
Audit our cpu6510-cycled.ts vs that source line-by-line.

## Refinement decisions

1. **Audit-Methode**: hybrid bottom + top.
   - **Bottom**: per-opcode synthetic unit tests. Each of 256
     opcodes gets a deterministic input/output table derived
     from VICE 6510core.c FETCH/PEEK/STORE macros. Asserts:
     `cycles`, `bus access sequence`, `register deltas`.
   - **Top**: VICE-replay diff harness. Boot VICE drive, dump
     per-cycle bus trace, replay through ours, diff. Catches
     sequence-bugs (interrupt-during-RMW, branch-delay).
   - **Escalation**: if microcode-table shows behavioral
     divergence we cannot explain, spike a switch-based
     reimplementation in a branch and bisect.
2. **Scope**: single shared `cpu65xx-vice.ts` core, parametrized.
   - Drive instance: plain 6502 (no $00/$01 CPU port).
   - C64 instance: 6510 = 6502 + IO-port mixin handling $00/$01.
   - VICE pattern (one core file shared between drive and C64).
   - Replaces both existing `cpu6510-cycled.ts` and drive CPU.
3. **Illegal opcode coverage**: all 256 opcodes 1:1 VICE.
   - Stable illegal: LAX, SAX, DCP, ISB, RLA, RRA, SLO, SRE,
     ANC, ASR, ARR — full impl.
   - Unstable illegal: AHX, SHX, SHY, TAS, ATX, AXS, LAS — VICE
     magic-value behavior 1:1.
   - JAM/KIL ($02, $12, $22, $32, $42, $52, $62, $72, $92, $B2,
     $D2, $F2): CPU halt + log + emit trace event.
4. **Implementation style**: enriched microcode table.
   - Existing microcode pattern preserved.
   - Per-opcode entry extended with: `dummyReads[]`,
     `delaysInterrupt: boolean`, `pageCrossExtra: boolean`,
     `rmwDoubleWrite: boolean`, `cycleCount`.
   - Each VICE FETCH/PEEK/STORE/CLK_INC macro maps to a
     micro-op.
   - **Spike escape hatch**: if behavioral divergence persists
     and microcode-table is suspected, fork a `cpu65xx-switch.ts`
     branch with VICE-style giant switch + macro inlining,
     bisect against motm scenario. Promote whichever is correct.
5. **Interrupt-delay tracking**: cycle-stamp based, VICE-style.
   - `cpu.lastBranchTakeCycle: CLOCK` set on taken branch
     without page-cross.
   - `cpu.lastIFlagClearCycle: CLOCK` set on CLI / PLP-clearing-I
     / RTI-clearing-I.
   - IRQ dispatcher: `if (clk - lastBranchTakeCycle < 2) defer`,
     `if (clk - lastIFlagClearCycle < instructionLen) defer`.
   - Match VICE `interrupt_check_irq_delay()` semantics.
6. **Bus-trace format** (for VICE-replay diff harness):
   - JSON record per bus access:
     `{cycle, addr, value, kind}` where kind ∈
     `FETCH | READ | WRITE | DUMMY_READ | DUMMY_WRITE`.
   - One trace file per scenario (motm boot, MM-LOAD, CIA-only).
   - **Future migration**: once stable, swap to binary format
     (TOON / msgpack / jsonb). Add CLI parser for human-readable
     diff. Keep JSON harness during dev for greppability.

## Scope

In scope:

### Point 13: dummy reads
- IRQ/NMI entry: 2 dummy reads at PC + PC+1 BEFORE pushing PC.
  VICE 6510core.c DO_INTERRUPT macro sequence.
- abs,X / abs,Y / (zp),Y page-cross: extra dummy read at base+
  index without high-byte fixup before fetching corrected addr.
- RMW abs,X: always extra dummy read (no page-cross requirement).
- (zp,X) / (zp),Y: zero-page wrap-around read at $00FF/$0000.
- BRK/PHP push P with B=1; IRQ/NMI push P with B=0.
- RMW double-write: ASL/LSR/ROL/ROR/INC/DEC/SLO/SRE/RLA/RRA/DCP/
  ISB write OLD value, then NEW value. Two stores.

### Point 14: branch-delay interrupt
- Branch instructions delay IRQ/NMI by 1 cycle if branch is taken
  with NO page-boundary crossing (= +1 to irq_clk).
- I-flag-clearing instructions (CLI, PLP, RTI) delay IRQ by 1
  full instruction (= the next opcode after CLI/PLP runs before
  IRQ services).
- Implementation: cycle-stamp pattern (decision 5).

### Point 15: illegal opcodes
- All 256 opcodes (decision 3).
- Stable illegal: full functional 1:1 VICE.
- Unstable illegal: VICE magic-value 1:1 (typically $EE for AHX/
  SHX/SHY/TAS bus-capacitance).
- JAM/KIL: halt CPU + emit trace.

## Deliverables

1. `src/runtime/headless/cpu/cpu65xx-vice.ts` — single core,
   shared between drive + C64 (replaces cpu6510-cycled.ts +
   drive CPU).
2. `src/runtime/headless/cpu/microcode-table.ts` — enriched
   per-opcode table with dummy-reads + delay flags.
3. `src/runtime/headless/cpu/io-port-6510.ts` — $00/$01 CPU port
   mixin, only attached to C64 instance.
4. `tests/unit/cpu/opcode-*.test.ts` — per-opcode unit tests
   (256 cases or grouped by addressing mode).
5. `scripts/cpu-replay-diff.mjs` — VICE bus-trace replay diff
   harness.
6. `tests/fixtures/vice-bus-traces/` — captured VICE bus traces
   for motm-boot, MM-LOAD, CIA-only scenarios.
7. Bus-trace event schema (JSON).

## Acceptance

- Every of 256 opcodes matches VICE cycle count + memory-access
  pattern (dummy reads, RMW double-write, page-cross extra cycle).
- Per-opcode unit tests 256/256 PASS.
- IRQ entry: 2 dummy reads (PC, PC+1) + 3 pushes (PCH, PCL, P) +
  2 vector reads ($FFFE, $FFFF) = 7 cycles total, with correct
  read addresses.
- Branch-delay interrupt: BNE/BEQ/etc taken w/o page-cross delays
  IRQ by 1 cycle.
- I-flag-clear (CLI / PLP / RTI) delays IRQ by 1 instruction.
- All illegal opcodes implemented per VICE behavior including
  unstable magic-value.
- JAM/KIL halts CPU + emits trace event.
- VICE bus-trace replay diff: zero divergence at motm-boot scenario
  through first 1M drive cycles.
- motm RAM diff at $07A1 reduces to 0 bytes (eliminates the
  divergence we observed at stack $012b-$0143 + motm code
  $0763, $07b9).
- smoke:cpu-fidelity passes 100%.

## Process

1. uint helpers (`u8`, `u16`, `u32`) — shared with Spec 145.
2. Read VICE 6510core.c systematically, table per opcode of
   `(cycles, bus accesses, side effects)`.
3. Build enriched microcode table.
4. Port shared `cpu65xx-vice.ts` core.
5. Add IO-port-6510 mixin for C64 instance.
6. Per-opcode unit tests (test-first per VICE source).
7. Cycle-stamp interrupt-delay logic (lastBranchTakeCycle,
   lastIFlagClearCycle).
8. Bus-trace JSON event schema + emit hooks.
9. VICE bus-trace capture: VICE binary monitor + extractor.
10. Replay-diff harness.
11. Run motm-boot + MM-LOAD scenarios, fix per first divergence.
12. **Spike fallback**: if microcode-table shows unexplainable
    divergence, fork switch-based variant in branch, bisect.

## Estimated effort

2-3 sessions for full audit + port. Heavy reading of VICE source,
heavy unit-testing. Spike-fallback adds 1 session if triggered.
