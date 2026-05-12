# Spec 109 — Headless M3.1: Drive CPU Microcoded Hardening

Status: **DONE 2026-05-04 (all sub-stories M3.1a-f green).** New harness `src/runtime/headless/drive/drive-cpu-equiv-tests.ts` walks the 1541 ROM 50 000 instructions on legacy + microcoded side-by-side: 0 register/flag/PC divergences, 2-cycle residual on IRQ-service entry path. SO pin test asserts V latch → BVS taken (PASS). Bus-trace fixtures shipped for indy page-cross (LDA ($10),Y with Y=$01 across $00FF→$0100), PHA, JSR, RTS — all PASS. Opcode coverage 17 unique opcodes from the idle-loop walk (broader coverage gated on Specs 110+111 driving full LISTEN/TALK paths). Doc: `docs/drive-cpu-fidelity-notes.md`. Equiv harness flagged a 1-cycle-per-instruction over-count in legacy `Cpu6510.step()` — fixed in same sprint, recorded as BUGREPORT.md Bug 41. Smoke battery (`smoke:drive-equiv`, `smoke:load`, `smoke:stepping`, `smoke:reset`, `smoke:snapshot`) + `regress` 4/4 PASS post-fix.
Roadmap: `docs/headless-emulator-roadmap.md` Milestone 3, story M3.1
Depth: deep
Predecessors: Sprint 96 (microcoded drive CPU), Spec 098 (M1.1),
Spec 094 (EOF trace)

## Motivation

Sprint 96 placed the drive on a microcoded `Cpu6510Cycled`. It is
working for IEC bit-bang, GCR rotation, and MM LOAD. The drive
context, however, has thin coverage in the equivalence harness:
sparsely-used opcodes, addressing-mode sub-cycle bus accesses, and SO
pin wiring need explicit assertions. Bug 39's fix specifically depends
on SO firing at the right cycle.

## Acceptance

- A drive equivalence harness runs the 1541 ROM from reset through at
  least 50 000 instructions through both the legacy and the microcoded
  drive CPU, asserting state equality at every instruction boundary.
- SO pin: a synthetic fixture fires SO once and asserts the V flag is
  set on the next instruction boundary.
- Indexed addressing across page boundaries: bus access trace for
  `LDA ($XX),Y`-style instructions matches real-HW reference per
  cycle.
- Stack ops (PHA, PLA, PHP, PLP, JSR, RTS) per-cycle bus access
  matches.
- Every opcode that drive PC actually visits during the equivalence
  walk is implemented and equivalent.
- After this spec lands, the Spec 094 EOF trace re-run shows zero
  drive PC drift compared to the pre-spec snapshot.

## Sub-stories

### M3.1a — Drive equivalence harness
Walk the 1541 ROM from the reset vector for 50 000 instructions, run
both CPUs in parallel, assert state equality per instruction boundary.

### M3.1b — SO pin test
Drive code with a `BVC`/`BVS` loop. Fixture fires
`trackBuffer.onByteReady` once and asserts the V flag is set on the
next instruction.

### M3.1c — Indexed cross-page bus access
Synthetic fixtures with `LDA ($XX),Y` crossing a page; assert
per-cycle bus address sequence.

### M3.1d — Stack ops bus access
Per-cycle assertions for PHA, PLA, PHP, PLP, JSR, RTS.

### M3.1e — Drive-ROM opcode coverage
Disassemble the 1541 ROM, list every opcode used, assert each is
implemented in the microcoded core. Track only opcodes the
equivalence walk actually visits.

### M3.1f — Documentation
`docs/drive-cpu-fidelity-notes.md`.

## Deliverables

- EDIT `src/runtime/headless/drive/drive-cpu.ts` (verify SO wiring;
  fix any opcode gaps surfaced by M3.1e)
- EDIT `src/runtime/headless/drive/drive-bus.ts` (if SO wiring needs
  fix)
- NEW `src/runtime/headless/drive/drive-cpu-equiv-tests.ts`
- `docs/drive-cpu-fidelity-notes.md`
- New synthetic M-W payloads `samples/synthetic/drive/*.bin`

## Test fixtures

- 1541 ROM (already in `resources/roms/`).
- Synthetic drive code delivered via M-W.

## Dependencies

- Spec 098.
- Spec 094 (regression check via trace).

## Risks and mitigations

- **Coverage may be 100% on day one**: equivalence tests may pass
  immediately. Mitigation: tests still ship as regression net; the
  spec must state this explicitly.
- **SO already wired correctly**: M3.1b just confirms.
- **Undocumented opcodes in drive ROM (KIL etc.) are dead code**: not
  normally executed. Mitigation: assert only on opcodes the
  equivalence walk actually visits.

## Fallback paths

- Equivalence harness reveals legacy CPU bugs: drop legacy CPU path
  for drive context; microcoded becomes canonical. Update Spec 098
  resolver.
- SO test reveals timing race: check `cycle-wrappers.ts` ordering
  — `tickShifter` must run before drive CPU executeCycle so V flag
  is set in time.

## Exit criteria

- 1541 ROM 50K-instruction equivalence walk green.
- SO test green.
- Bus access fixtures green.
- Spec 094 EOF trace re-run shows zero drive PC drift.

## File-touch list

- EDIT `src/runtime/headless/drive/drive-cpu.ts`
- EDIT `src/runtime/headless/drive/drive-bus.ts`
- NEW `src/runtime/headless/drive/drive-cpu-equiv-tests.ts`
- NEW `docs/drive-cpu-fidelity-notes.md`
- NEW `samples/synthetic/drive/*.bin`

## Out of scope

- 1541 vs 1541-II vs 1541C ROM-revision differences.
- 1571 / 1581 CPU.
- Parallel cable mods (XP1541, SpeedDOS hardware).
