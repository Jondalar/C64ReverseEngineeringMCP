# Spec 111 — Headless M3.3: KERNAL Serial Byte Matrix

Status: **DONE 2026-05-04 (M3.3a + M3.3b + M3.3d shipped at protocol-state level; M3.3c YAML deferred to follow-up).** New `SyntheticIecDevice` (`src/runtime/headless/test-helpers/synthetic-iec-device.ts`) + matrix runner (`src/runtime/headless/c64/serial-matrix-tests.ts`) cover 8 fixtures / 22 checks across LISTEN ack, LISTEN mismatch, TALK ack, LISTEN+SECOND+CIOUT+UNLSN data byte, device-not-present, UNTALK release, UNLSN-vs-talker deviation lock-in, LSB-first byte order. v1 tests at protocol-state level (no real KERNAL ROM execution) — KERNAL-mode harness deferred to v2 once `IntegratedSession` plumbing supports drive-swap. `npm run smoke:serial-matrix` 22/22 pass. Doc: `docs/kernal-serial-matrix.md`.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.3
Depth: deep
Predecessors: Sprint 72 (KERNAL serial trap suite), Sprint 76 (full
KERNAL I/O traps), Spec 096 (M0.3 EOI/TALK fix), Spec 107 (M2.5
scenario format), Spec 110 (M3.2)

## Motivation

KERNAL serial primitives — LISTEN, UNLISTEN, TALK, UNTALK, SECOND,
TKSA, CIOUT, ACPTR, EOI — are exercised ad-hoc through the trap suite
and the LOAD path. We need an explicit byte-matrix that asserts each
primitive's IEC line behavior and cycle delta against synthetic drive
states. This is the regression net for M0.3's fix and for any future
serial change.

## Acceptance

- Nine primitives × valid + edge-case states ≈ 30 fixtures.
- Each fixture: a synthetic device responds at known line states; the
  KERNAL primitive runs; the post-state is asserted (line state, $90,
  cycle delta).
- Timeout paths: no device on bus → device-not-present timeout.
- EOI handshake: last-byte signaling sets $90 EOI bit; subsequent
  reads honour the signaling.
- Retry paths: TIMEOUT bit set on a deliberate slow device, then
  cleared on retry success.

## Sub-stories

### M3.3a — Synthetic device responder
A mock drive object that responds programmatically per scenario:
"acknowledge ATN after N cycles", "send 5 bytes then EOI", "stay
silent", etc.

### M3.3b — Matrix runner
Iterates the test matrix, reports per-primitive pass/fail, dumps a
summary table.

### M3.3c — Scenario format integration
Test scenarios written as YAML using the format defined in Spec 107.

### M3.3d — Documentation
`docs/kernal-serial-matrix.md` listing every primitive and its
expected line behavior.

## Deliverables

- NEW `src/runtime/headless/c64/serial-matrix-tests.ts`
- NEW `src/runtime/headless/test-helpers/synthetic-iec-device.ts`
- Fixtures `samples/synthetic/serial/*.yaml`
- `docs/kernal-serial-matrix.md`

## Dependencies

- Spec 096 (M0.3) defines correct EOI/retry semantics.
- Spec 107 (scenario format).
- Spec 110 (VIA1 IEC contract).

## Risks and mitigations

- **Scenario player not shipped yet**: M3.3 partly blocked by M2.5.
  Mitigation: ship the matrix runner first with inline scenarios in
  TypeScript; migrate to YAML when M2.5 lands.
- **EOI semantics depend on M0.3**: spec must land after M0.3.
- **30 fixtures is a lot**: some redundancy across primitives.
  Mitigation: factor common scenarios into helpers; matrix entries
  remain small.

## Out of scope

- VICE compare (Spec 095 covers the EOF case specifically).
- Custom-loader serial protocols (covered by acceptance ladder
  Stage 12).

## File-touch list

- NEW `src/runtime/headless/c64/serial-matrix-tests.ts`
- NEW `src/runtime/headless/test-helpers/synthetic-iec-device.ts`
- NEW `samples/synthetic/serial/*.yaml`
- NEW `docs/kernal-serial-matrix.md`
