# Spec 110 — Headless M3.2: VIA1 IEC Contract

Status: **DONE 2026-05-04 (M3.2a-e shipped).** New fixture suite `src/runtime/headless/drive/via1-iec-tests.ts` covers polarity (5 checks), ATN edge IRQ (8 checks incl. either-edge Sprint-66 deviation lock-in), device-ID jumper (all four IDs 8-11), PB write propagation (synchronous OR + DDR cases). `npm run smoke:via1-iec` 24/24 pass. Doc: `docs/via1-iec-contract.md`. No production code changed — VIA1 + IecBus already correct from Sprint 96, this spec adds the regression net.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.2
Depth: deep
Predecessors: Sprint 96 (IEC bit-bang), Spec 098 (M1.1), Spec 109 (M3.1)

## Motivation

Drive VIA1 carries the IEC interface:
- PB0 = DATA_IN, PB2 = CLK_IN, PB7 = ATN_IN
- PB1 = DATA_OUT, PB3 = CLK_OUT, PB4 = ATN_ACK
- CA1 = ATN edge IRQ
- PB5 + PB6 = device ID jumpers

Sprint 96 wired all of this for bit-bang LOAD. We need explicit
synthetic tests that lock down line polarity, ATN edge timing, IRQ
assertion, device ID configurability, and per-cycle read/write side
effects so future regressions surface immediately.

## Acceptance

- Line polarity matches HW: 0 = asserted (low), 1 = released. ATN
  inverted via PB7 input.
- ATN falling edge triggers CA1 IRQ on the drive within 1 drive
  cycle.
- Device ID jumpers (PB5 + PB6) configurable per drive instance;
  default ID = 8.
- PB1 (DATA_OUT) write propagates to the IEC bus within 1 drive
  cycle.
- PB4 (ATN_ACK) write propagates sub-cycle via the existing
  microcoded wiring.
- All asserted via synthetic fixtures.

## Sub-stories

### M3.2a — Polarity test
Drive bit-bang sets PB1/PB3 to known values; assert IEC bus state.

### M3.2b — ATN edge IRQ test
Drive disabled IRQ on CA1, C64 pulls ATN low, drive resumes IRQ;
assert IRQ vector entered within 1 cycle.

### M3.2c — Device ID jumper
Configure ID = 9 via jumper; LISTEN to 9 succeeds, LISTEN to 8
times out.

### M3.2d — PB write propagation
Write PB1, sample IEC bus on next drive cycle.

### M3.2e — Documentation
`docs/via1-iec-contract.md`.

## Deliverables

- EDIT `src/runtime/headless/drive/via1.ts` if any gap surfaces
- NEW `src/runtime/headless/drive/via1-iec-tests.ts`
- New synthetic M-W payload fixtures
- `docs/via1-iec-contract.md`

## Dependencies

- Spec 109 (drive CPU equivalence).

## Risks and mitigations

- **VIA1 may already be correct**: tests confirm and act as regression
  net.
- **Device ID rarely changed in software**: most software targets
  drive 8. Mitigation: minimal jumper interface; default 8.

## Out of scope

- Multi-drive bus contention (M3.7).
- Parallel cable mods.

## File-touch list

- EDIT `src/runtime/headless/drive/via1.ts`
- NEW `src/runtime/headless/drive/via1-iec-tests.ts`
- NEW `samples/synthetic/drive/via1/*.bin`
- NEW `docs/via1-iec-contract.md`
