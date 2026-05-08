# Spec 219 — CPU illegal opcode coverage (Lorenz Disk2/3/4)

**Sprint:** 121 (after 207 modes/test profiles)
**Status:** IN PROGRESS 2026-05-08 — c1-c3 DONE, c4 (CPUPORT) deferred.

c1: ARR BCD (commit 9195452) — Lorenz Disk2 ARRB now PASS. Both Cpu6510 + Cpu65xxVice impl per VICE 6510core.c arr_bcd.

c2: XAA magic constant $EE (commit 9195452) — Lorenz Disk2 XAA-related tests PASS.

c3: AXS/SHA/SHS/SHX/SHY (already implemented) — verified Lorenz Disk2:
- sbxb (AXS), shaay/shaiy (SHA), shxay (SHX), shyax (SHY), shsay (TAS)
all PASS without modification.

c4: CPU port $00/$01 capacitor-decay model — DEFERRED. Static pullup
mask $17 vs $DF tradeoff: $17 passes TRAP1-17 but fails CPUPORT;
$DF passes CPUPORT direction but breaks TRAP16. Need VICE-style
pport.data_falloff_bit{6,7} dynamic decay (= timer-based bit-flip
toward default after capacitive hold). Significant work; not
gating any game boot.

Disk2 status (with c1-c3 fixes):
- BEQR..BVCR: PASS
- RLA/SRE/RRA/INS/LAX/AXS/ALR/ARR all variants: PASS
- SBX, SHA/SHX/SHY/TAS, ANC, LAS, SBC#: PASS
- TRAP1-17, BRANCHWRAP, MMUFETCH, MMU: PASS
- **CPUPORT: FAIL** (c4 deferred)

Disk3+4 not yet tested with c1-c3 fixes.
**Depends on:** 200 (kernel), 212 (drive 6502 cycle audit DONE)
**Write scope:** `src/runtime/headless/cpu/cpu65xx-vice.ts`,
`src/runtime/headless/cpu6510.ts`

## Goal

Close remaining illegal-opcode coverage gaps caught by Wolfgang
Lorenz C64 Emulator Test Suite (vendored 2026-05-08 under
`samples/vice-testprogs/lorenz-2.15/`).

Lorenz Disk1 = 100% PASS after BCD ADC/SBC fix (commit f250645).
Disk2/3/4 still have failures in NMOS-specific illegal-opcode
behaviors that depend on:
- ALU / BCD interaction quirks (ARR)
- Magic-AND constants (XAA)
- A & X subtraction (AXS)
- High-byte AND for indexed stores (SHA / SHS / SHX / SHY)

These opcodes are rarely used in stock games but appear in:
- Some demos (= timing/protection)
- Some fastloaders (= obfuscation)
- LNR / IM2 / future sprite multiplexers possibly

## Scope

### Disk2 — illegal-opcode arith

| Opcode | Mnemonic | Status | Note |
|--------|----------|--------|------|
| $6B | ARR # | FAIL | NMOS: BCD-mode quirky behavior. C/V flag from bit 6/5 of result |
| $8B | XAA # | FAIL | NMOS: A = (A \| magic) & X & imm. magic = $EE / $EF / $FE on real chips |
| $CB | AXS # | FAIL | A & X - imm → X, set C/N/Z |

### Disk3 — illegal-opcode store + trap1-trap17

| Opcode | Mnemonic | Status | Note |
|--------|----------|--------|------|
| $93 | SHA (zp),Y | FAIL | A & X & ((addr_hi+1) if no page-cross else random) → ((zp),Y) |
| $9B | SHS abs,Y | FAIL | (A & X) → SP, A & X & (addr_hi+1) → (abs,Y) |
| $9C | SHY abs,X | FAIL | Y & (addr_hi+1) → (abs,X), unstable on page-cross |
| $9E | SHX abs,Y | FAIL | X & (addr_hi+1) → (abs,Y), unstable on page-cross |
| $9F | SHA abs,Y | FAIL | A & X & (addr_hi+1) → (abs,Y) |

### Disk4 — trap variants

Various trap conditions for invalid opcodes / NMI/IRQ edge cases.

## Acceptance

- `npm run test:lorenz:disk2` reaches "nextdisk" prompt without FAIL
- `npm run test:lorenz:disk3` reaches "nextdisk" prompt without FAIL
- `npm run test:lorenz:disk4` reaches "FINISHED" without FAIL
- No regression on Disk1 (100% PASS preserved)
- Existing CPU unit tests (illegal-opcodes 7/7, opcodes-by-mode
  23/23, interrupt-delay 5/5, interrupt-entry 5/5, so-pin 7/7)
  stay green

## Reference

- VICE source: `vice/src/6510core.c` — production-quality NMOS
  illegal opcode implementation
- Wolfgang Lorenz suite source: `samples/vice-testprogs/lorenz-2.15/`
- Per-opcode test PRG: e.g., `arrb` for ARR immediate

## Notes

ARR BCD quirk (NMOS): `arr_bcd` in VICE 6510core.c. Result byte =
ROR of (A & imm + C). C/V derive from bit 6/5 of result EXCEPT in
BCD mode where high nybble decimal-corrected and N/V/C have specific
formulas.

XAA / SHA / SHS / SHX / SHY are unstable on real NMOS — test suite
expects specific magic values that VICE matches and we should match
too (= bug-for-bug compatibility).

Estimate: 1-2 days for all 8 opcodes. ARR + XAA most complex.
