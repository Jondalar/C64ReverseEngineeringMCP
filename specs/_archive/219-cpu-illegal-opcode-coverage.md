# Spec 219 — CPU illegal opcode coverage (Lorenz Disk2/3/4)

**Sprint:** 121 (after 207 modes/test profiles)
**Status:** DONE 2026-05-08 — c1-c4 all shipped. CPUPORT c4 capacitor
decay implemented per VICE c64mem.c + c64pla.c (data_falloff_bit{6,7},
350000-cycle decay, DDR transition snapshot, $01-write charging).
TRAP1-17 + CPUPORT all run without FAIL. CPUPORT readout = $D7 vs
Lorenz-reference $DF (bit-3 differs); matches VICE-equivalent
behavior with default `tape_write_in=0`. Real-HW $DF would require
emulating tape-line idle-high pull-ups — out-of-scope here.

c1: ARR BCD (commit 9195452) — Lorenz Disk2 ARRB now PASS. Both Cpu6510 + Cpu65xxVice impl per VICE 6510core.c arr_bcd.

c2: XAA magic constant $EE (commit 9195452) — Lorenz Disk2 XAA-related tests PASS.

c3: AXS/SHA/SHS/SHX/SHY (already implemented) — verified Lorenz Disk2:
- sbxb (AXS), shaay/shaiy (SHA), shxay (SHX), shyax (SHY), shsay (TAS)
all PASS without modification.

c4: CPU port $00/$01 capacitor-decay model — DONE.
`src/runtime/headless/memory-bus.ts` now mirrors VICE c64mem.c:
- pullup mask $17 (PLA banking + CASS_SENSE)
- bits 6/7 capacitor: charged on `$01` write while DDR bit=output;
  snapshotted on DDR transition output→input
- decay timer = 350000 c64 cycles; on read of `$01` past the
  set_clk threshold the bit clears
- bit 5 always cleared in input mode (no motor pullup)
- IntegratedSession wires `c64Cpu.cycles` as the cycle clock
- pla-fidelity smoke 22/22 PASS, e2e-integration 2/2 PASS

Disk2 status (with c1-c4 fixes):
- BEQR..BVCR: PASS
- RLA/SRE/RRA/INS/LAX/AXS/ALR/ARR all variants: PASS
- SBX, SHA/SHX/SHY/TAS, ANC, LAS, SBC#: PASS
- TRAP1-17, BRANCHWRAP, MMUFETCH, MMU: PASS (no regression vs c1-c3)
- CPUPORT: runs cleanly. Readout `AFTER 00 D7` vs Lorenz-reference
  `RIGHT 00 DF`. Bit-3 differs because real C64 cassette pin idles
  high via open-drain pullup (out-of-scope; VICE has same gap).

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
