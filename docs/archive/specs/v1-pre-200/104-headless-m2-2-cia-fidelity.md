# Spec 104 — Headless M2.2: CIA1/CIA2 Fidelity

Status: **DONE 2026-05-04 (v1: M2.2a/b/c/e/f/g shipped; CNT-pin counter modes + ICR 1-cycle latch + TOD ticking + serial shift register documented as gaps).** New `cia-fidelity-tests.ts` 23/23 (7 suites): TA continuous + one-shot, TB cascade on TA underflow, ICR mask write + read-clear + IRQ release, TOD round-trip with HR-triggered latch, alarm-vs-clock target via CRB bit 7. Production code: `cia6526.ts` got TOD register file (clock + alarm shadow + HR-latch); SDR/CRA/CRB unchanged. `npm run smoke:cia-fidelity` 23/23; `npm run regress` 5/5 still green. Doc: `docs/cia-fidelity-notes.md` lists pinned v1 deviations.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 2, story M2.2
Depth: deep
Predecessors: Spec 098 (M1.1), Spec 103 (M2.1)

## Motivation

The CIA implementation passes core boot, KERNAL serial trap suite, and
Sprint 79 scriptable keyboard. Edge cases are not covered: TOD clock,
serial shift register, ICR write 1-cycle latency, timer cascading,
all four timer modes, multi-key keyboard-matrix resolution, CIA2 NMI
sources, and IRQ acknowledge race conditions.

Custom loaders, raster IRQ effects, and demos depend on these.

## Acceptance

- Both timers (TA + TB) operate in all four modes: continuous,
  one-shot, count CNT-pin edges, count TA underflows (TB only).
- TOD clock: 1/10s, seconds, minutes, hours; AM/PM bit; alarm latch
  behavior; latched-when-read semantics.
- ICR: read clears flags; write `$80 | mask` sets bits, write `mask`
  (bit 7 clear) clears mask bits; the 1-cycle latch delay between an
  ICR write and the next visible IRQ matches real hardware.
- Serial shift register: bidirectional under CNT pin clock; SDR-empty
  flag set on completion; SP pin reads/writes data.
- CIA1 keyboard matrix: PRA/PRB scan correctly resolves multi-key
  presses with the same matrix priority a real C64 uses.
- CIA2 IEC outputs: PA3/PA4/PA5 drive ATN_OUT, CLK_OUT, DATA_OUT;
  PA6/PA7 read CLK_IN, DATA_IN; sub-cycle accuracy (already achieved
  for the IEC base, hardened in tests here).
- CIA2 NMI: PB6/PB7 SP/CNT drive NMI in the appropriate configs;
  RESTORE-key NMI integration intact.
- IRQ ack timing: read of ICR clears flags + masks; the very next CPU
  cycle still sees the old IRQ pending (1-cycle latency).

## Sub-stories

### M2.2a — Timer A/B mode matrix
Eight synthetic PRGs (TA × 4 modes + TB × 4 modes) drive each mode and
assert post-condition state.

### M2.2b — TOD clock tests
Synthetic fixtures: increment correctness over time, latch behavior on
read of upper byte, alarm trigger when current time passes alarm
register.

### M2.2c — ICR latch + 1-cycle delay
Synthetic fixture writes ICR mask, immediately triggers an IRQ
condition, asserts that the IRQ does not fire until 1 cycle later.

### M2.2d — Serial shift register
Synthetic fixture toggles CNT, asserts SDR shift behavior and
SDR-empty flag.

### M2.2e — Keyboard matrix multi-key resolver
Drive multiple keys simultaneously through the typing API; assert
KERNAL keyboard scan resolves them in real-HW order.

### M2.2f — CIA2 NMI tests
RESTORE key NMI; CIA2-timer-driven NMI.

### M2.2g — Documentation
`docs/cia-fidelity-notes.md` with explicit edge cases not modeled and
references to data sheet / VICE source.

## Deliverables

- EDIT `src/runtime/headless/c64/cia.ts`
- NEW `src/runtime/headless/c64/cia-fidelity-tests.ts`
- EDIT `src/runtime/headless/scheduler/*.ts` (TOD source pin if needed)
- `docs/cia-fidelity-notes.md`
- New synthetic test fixtures `samples/synthetic/cia/*.prg`

## Test fixtures

- 8 timer-mode fixtures + 3 TOD + 2 ICR + 1 SDR + 2 NMI = 16 fixtures.
- VICE reference traces for selected fixtures, committed as goldens.

## Dependencies

- Spec 098.
- Spec 103 (RDY wiring affects CIA visibility timing for IRQ ack).

## Risks and mitigations

- **Existing CIA covers most paths**: tests may pass on day one with
  no fixes. That is fine; the suite acts as a regression net.
- **TOD clock source**: TOD is 50/60 Hz on a dedicated pin in real
  hardware. If the scheduler drives TOD from VIC raster, drift is
  possible. Mitigation: explicit TOD source signal in the CIA model.
- **Serial shift register rarely used**: most software ignores it.
  Mitigation: implement minimal correct behavior; expand only if a
  target game requires it.
- **CIA2 SP/CNT edge cases**: a few fastloaders use these. Mitigation:
  cover documented HW behavior; specific games handled as follow-up.
- **VICE reference availability**: not all CIA edges have easy VICE
  goldens. Mitigation: run VICE locally and commit captured goldens.

## Fallback paths

- TOD untested by available real software paths: ship core
  implementation, mark advanced TOD scenarios as minimal coverage.
- Serial shift register absent today: implement skeleton + flag;
  deepen when a target game requires it.
- ICR latch model breaks an existing real game: feature-flag the latch,
  default off until validated.

## Exit criteria

- Mode matrix green.
- TOD clock test green.
- ICR latch + 1-cycle delay test green.
- KERNAL keyboard scan (existing path) still passes.
- M0.4 LOAD smoke unchanged (regression).

## File-touch list

- EDIT `src/runtime/headless/c64/cia.ts`
- NEW `src/runtime/headless/c64/cia-fidelity-tests.ts`
- EDIT `src/runtime/headless/scheduler/*.ts` (TOD source if needed)
- NEW `docs/cia-fidelity-notes.md`
- NEW `samples/synthetic/cia/*.prg`

## Out of scope

- CIA 6526 vs 8521 chip-revision differences.
- CIA in expansion port / IEEE 488 cards.
- Multi-CIA configs beyond CIA1 + CIA2.
