# Spec 103 — Headless M2.1: CPU Cycle and Interrupt Fidelity

Status: refined, not started
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 2, story M2.1
Depth: deep
Predecessors: Sprint 94 (CPU equivalence harness), Spec 098 (M1.1),
Spec 101 (M1.4)

## Motivation

The microcoded `Cpu6510Cycled` exists and passes the equivalence harness
against the legacy CPU for documented opcodes. Coverage of undocumented
opcodes is incomplete, IRQ/NMI cycle timing is not pinned to real
hardware, BRK/RTI stack ordering and B-flag behavior are not asserted
against a reference, RDY/stall (badlines, sprite DMA) is approximated,
and per-cycle bus accesses have not been validated.

Custom loaders, raster IRQs, and copy-protection routines depend on
exact cycle counts. M2.1 hardens these against an external reference
(Lorenz CPU test suite or equivalent) and a perfect6502/Visual6502
reference for selected sequences.

## Acceptance

- All 256 opcodes execute correctly: documented + the commonly-used
  undocumented set (LAX, SAX, DCP, ISC, RLA, RRA, SLO, SRE, ANC, ALR,
  ARR, AXS, KIL, NOP variants, undocumented immediates).
- Lorenz CPU test suite (or an equivalent locally-runnable substitute)
  runs to completion and passes.
- IRQ entry cycle delta matches reference within 0 cycles for IRQ,
  RTI, BRK, NMI, NMI-during-IRQ.
- BRK pushes flags with B set + PC+2; RTI pops flags + PC; in-CPU B
  flag behavior matches HW (set on push, cleared in CPU register).
- JSR pushes PC-1; RTS pops and adds 1.
- RDY/stall integration: when VIC asserts RDY low (badline) or sprite
  DMA bursts, CPU stalls cycle-exact and resumes correctly.
- Per-cycle bus access trace can be captured as an opt-in trace
  channel (`cpu_bus`) and diffed against a perfect6502 reference for
  a chosen instruction sequence.

## Sub-stories

### M2.1a — External test suite integration
Run Lorenz CPU test suite (or substitute) against `Cpu6510Cycled`.
Catalog every failing test and store as a baseline for the next
sub-stories.

### M2.1b — Undocumented opcode coverage
Implement remaining undocumented opcodes that Lorenz exercises. Update
existing 6510 tests to assert their behavior.

### M2.1c — IRQ/NMI cycle fixtures
Synthetic PRGs that trigger IRQ and NMI at known cycle counts. Assert
exit cycle delta. Cover NMI during IRQ.

### M2.1d — Stack ordering fixtures
Synthetic fixtures for BRK, RTI, JSR, RTS that read back the stack
after the operation and assert byte-by-byte ordering.

### M2.1e — RDY/stall integration
Wire VIC badline and sprite DMA to assert RDY low on the C64 bus. CPU
stalls until RDY release. Feature-flagged per session mode (`accurateRdy`)
to keep performance regressions opt-in.

### M2.1f — Per-cycle bus trace channel
Extend the EOF trace harness (Spec 094) with an optional `cpu_bus`
channel that records `{ cycle, addr, data, rw }` per CPU cycle. Diff
helper compares to a perfect6502 reference for a selected instruction
sequence.

### M2.1g — Documentation
`docs/cpu-fidelity-notes.md` lists intentional divergences from real
hardware (e.g. specific chip-revision quirks not modeled), references
to Visual6502/perfect6502, and the test-suite licensing situation.

## Deliverables

- `src/runtime/headless/c64/cpu-fidelity-tests.ts`
- EDIT `src/runtime/headless/c64/cpu-6510-cycled.ts` (undocumented
  opcodes, RDY pin)
- EDIT `src/runtime/headless/scheduler/cycle-wrappers.ts` (RDY drive)
- EDIT `src/runtime/headless/c64/vic.ts` (badline RDY assertion)
- `docs/cpu-fidelity-notes.md`
- New synthetic test fixtures under `samples/synthetic/cpu/`
- Optional: EDIT `src/runtime/headless/trace/eof-trace.ts` to add the
  `cpu_bus` channel

## Test fixtures

- Lorenz CPU test ROMs (license-checked; if not redistributable, ship
  a download script + manifest of expected hashes; CI runs only when
  local copy is present).
- Synthetic PRGs for IRQ/NMI/BRK/RTI/JSR/RTS edges (committed).
- perfect6502 / Visual6502 reference traces for a small set of
  instructions (committed reference data).

## Dependencies

- Spec 098 (mode-aware enabling of `accurateRdy`).
- Spec 101 (snapshot for state hashing in tests).
- Spec 094 (trace channel extension for `cpu_bus`).
- Existing CPU equivalence harness (Sprint 94).

## Risks and mitigations

- **Lorenz license**: not redistributable. Mitigation: download script
  + manifest with hashes; CI conditional on local presence.
- **RDY integration scope**: VIC and scheduler both approximate
  badlines today. Touching both at once is high-risk. Mitigation:
  feature-flag `accurateRdy` per mode; default off, on for
  `debug-vice-compare` and `true-drive`.
- **Undocumented opcode chip variance**: NMOS 6510 has chip-rev
  quirks. Mitigation: target the common post-1985 spec; document
  divergences explicitly.
- **Equivalence harness drift**: legacy CPU may diverge from
  microcoded after RDY changes. Mitigation: Lorenz is canonical;
  legacy CPU equivalence is a soft check not a gate.
- **Per-cycle bus trace performance**: tanks runtime. Mitigation:
  opt-in channel only; never default on.

## Fallback paths

- Lorenz blocked by license: ship a self-built equivalence set
  covering ~20 critical opcodes + the synthetic IRQ/stack fixtures.
  Document the coverage gap.
- RDY integration breaks raster IRQ tests: ship CPU fidelity without
  RDY tie-in; mark RDY work as M2.3 follow-up.
- perfect6502 reference cumbersome to integrate: diff `cpu_bus` trace
  against VICE chis log instead.

## Exit criteria

- Lorenz (or equivalent) suite green.
- IRQ/NMI cycle tests green.
- Stack ordering tests green.
- RDY wiring lands at least feature-flagged in `true-drive` mode.
- `cpu-fidelity-notes.md` documents intentional divergences.

## File-touch list

- NEW `src/runtime/headless/c64/cpu-fidelity-tests.ts`
- EDIT `src/runtime/headless/c64/cpu-6510-cycled.ts`
- EDIT `src/runtime/headless/scheduler/cycle-wrappers.ts`
- EDIT `src/runtime/headless/c64/vic.ts`
- NEW `docs/cpu-fidelity-notes.md`
- NEW `samples/synthetic/cpu/*.prg`
- Optional: EDIT `src/runtime/headless/trace/eof-trace.ts`

## Out of scope

- CMOS 65C02 / 65816.
- Chip-revision-specific quirks beyond the mainstream NMOS 6510.
- BCD edge cases on broken chip revs.
- C64 CPU IO port `$00/$01` direction quirks (covered in M2.4).
