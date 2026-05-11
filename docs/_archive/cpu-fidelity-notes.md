# CPU Fidelity Notes (Spec 103 / M2.1)

## v1 status

| Sub-story | Status     | Where                                                                |
|-----------|------------|----------------------------------------------------------------------|
| M2.1a Lorenz suite       | **Substituted** | `scripts/cpu-equivalence.mjs` (1880 cases per opcode × 8 seeds, 0 fails) — Lorenz license-blocked, this self-built suite covers documented + common undocumented opcodes |
| M2.1b Undoc opcodes      | **Covered**     | `UNDOC_TABLE` + microcoded path (LAX/SAX/DCP/ISC/RLA/RRA/SLO/SRE/ANC/ALR/ARR/AXS plus NOP variants); equiv harness 0 fails |
| M2.1c IRQ/NMI cycles     | **Covered**     | `cpu-fidelity-tests.ts` 7-cycle entry, NMI > IRQ priority, NMI bypasses I-flag |
| M2.1d Stack ordering     | **Covered**     | BRK / RTI / JSR / RTS — byte-by-byte stack assertions plus PC ± n conventions |
| M2.1e RDY / stall        | **Deferred**    | Per spec fallback path: RDY moves to Spec 105 / M2.3 (VIC fidelity) under `accurateRdy` flag |
| M2.1f cpu_bus trace      | **Deferred**    | Existing `eof-trace.ts` covers the high-level need; per-cycle channel is a follow-up |
| M2.1g Documentation      | **This file**   | — |

`npm run smoke:cpu-fidelity` — 31/31 pass.
Existing `scripts/cpu-equivalence.mjs` — 1880 cases, 0 fails.

## Cycle-count contract

After Sprint 100 / Bug 41 fix, both legacy `Cpu6510.step` and
microcoded `Cpu6510Cycled.executeCycle` produce identical per-instruction
cycle totals for documented opcodes. Spec 103 closes the same gap on
the IRQ/NMI service path:

- **IRQ entry (level-triggered, gated by I)**: 7 cycles total. Pushes
  `[PCH, PCL, P-with-B-clear]`, sets I=1, jumps to `*$FFFE`.
- **NMI entry (edge-triggered, NOT gated by I)**: 7 cycles total.
  Pushes `[PCH, PCL, P-with-B-clear]`, sets I=1, jumps to `*$FFFA`.
- **NMI > IRQ**: when both pending, NMI wins; IRQ stays queued for
  the next instruction boundary post-NMI service.
- **BRK** (microcode path): 7 cycles. Pushes `PC+2` (skips the byte
  after the BRK opcode) and `P-with-B-set`. CPU register B is then
  cleared. Vector at `*$FFFE`.
- **RTI**: 6 cycles. Pops `[P, PCL, PCH]`. PC restored verbatim
  (no +1 like RTS). B + unused bits stay masked off in the CPU
  register.
- **JSR**: 6 cycles. Pushes `PC-1` (= last byte of JSR instruction
  itself, NOT the byte after it). SP -= 2.
- **RTS**: 6 cycles. Pops two bytes, jumps to popped + 1.

The microcoded `serviceInterrupt` adds 6 cycles directly because the
outer `executeCycle` wrapper adds the 7th cycle on return. Direct
callers (drive's legacy-CPU IRQ check at `cycle-wrappers.ts:101`,
`integrated-session.ts:620,625`) all use the legacy `Cpu6510.serviceInterrupt`
which still does +7 self-contained.

## RDY / stall (M2.1e) — why deferred

Per spec fallback path: "RDY integration breaks raster IRQ tests:
ship CPU fidelity without RDY tie-in; mark RDY work as M2.3
follow-up." VIC badline + sprite DMA RDY-low stalls require touching
the VIC pixel pipeline + cycle-lockstep scheduler simultaneously.
That refactor lives under Spec 105 / M2.3 (VIC-II per-cycle fidelity)
where the VIC-side state is already on the table.

The current emulator approximates badline cycle stealing within the
scheduler without dropping CPU clocks; software that observes raster
IRQ jitter to within a few cycles will see deviation. Standard LOAD
+ MM acceptance ladder do not depend on cycle-exact RDY behavior.

## Lorenz substitute (M2.1a)

Lorenz CPU test suite is not redistributable. The substitute is
`scripts/cpu-equivalence.mjs`: 235 documented + undocumented
opcodes × 8 seeds × full state diff (regs + flags + 64K RAM diff)
= 1880 cases, all green. This catches the same kind of cycle-count
+ flag-update bugs Lorenz targets, modulo the ones specific to BCD
decimal mode chip variance (M2.1 explicitly out-of-scope per spec).

If a local Lorenz copy becomes available, the harness can be
extended to load + execute its test PRGs; the equiv-harness scaffold
already supports this without code changes (just new fixture data).

## Open follow-ups

- M2.1e RDY/stall — moves into Spec 105 / M2.3.
- M2.1f cpu_bus trace channel — extend `eof-trace.ts` schema to
  emit `{ cycle, addr, data, rw }` per CPU cycle when opt-in flag
  set. Diff helper against a perfect6502 reference for selected
  instruction sequences.
- BCD decimal-mode edge cases on broken chip revs — out of scope
  per spec.
- C64 CPU IO port `$00/$01` direction quirks — covered in M2.4.

## Files

- `src/runtime/headless/cpu/cpu6510-cycled.ts` — `serviceInterrupt`
  +6 with wrapper-bump notation.
- `src/runtime/headless/c64/cpu-fidelity-tests.ts` — Spec 103 fixture
  suite (6 suites, 31 checks).
- `scripts/smoke-cpu-fidelity.mjs` + `npm run smoke:cpu-fidelity`.
- `scripts/cpu-equivalence.mjs` — Sprint 94 opcode equiv harness.
