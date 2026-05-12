# Spec 403 — C64 Phase C: Peripherals (CIAs)

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 402
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Goal

Bring CIA1 + CIA2 in line with `docs/vice-c64-arch.md §12 Phase C`
(steps 9–12) and §6 (full CIA chapter).

## Doc anchor

- `docs/vice-c64-arch.md` §12 Phase C (steps 9–12)
- `docs/vice-c64-arch.md` §6.1 shared state
- `docs/vice-c64-arch.md` §6.2 T1/T2 timers
- `docs/vice-c64-arch.md` §6.3 SDR
- `docs/vice-c64-arch.md` §6.4 TOD
- `docs/vice-c64-arch.md` §6.5 ICR
- `docs/vice-c64-arch.md` §6.6 port A/B
- `docs/vice-c64-arch.md` §13 invariants 10, 13

## Canonical content (verbatim §12 Phase C)

9. CIA timers (T1, T2): alarm-driven. Continuous + one-shot.
   T1→T2 chain. SDR + ICR delay state machines per §6.5.
10. CIA TOD: 1/10s alarm, BCD counters, alarm-match IRQ.
11. CIA1 keyboard + joy2: PA row scan, PB column read. Joy2 shares
    PA bits 0..4 with keyboard rows — implement the shared lines,
    not separate "joystick override".
12. CIA2 IEC + VIC-bank: PA bits 3..5 = IEC output, 6..7 = IEC input.
    PA bits 0..1 = VIC-bank — write triggers
    `vicii_set_vbank(phi1 + phi2)`. CIA2 IRQ → NMI line.

## VICE source cite

- Core: `src/core/ciacore.c`.
- CIA1 specifics: `src/c64/c64cia1.c`.
- CIA2 specifics: `src/c64/c64cia2.c`.
- `cia1_set_int_clk`: `c64cia1.c:95-98`
  `interrupt_set_irq(maincpu_int_status, cia_context->int_num, value, clk)`.
- `cia2_set_int_clk`: `c64cia2.c:86-89`
  `interrupt_set_nmi(...)`.
- CIA2 PA store hook (VIC bank): `c64cia2.c:148-162`.
- ICR latch semantics: `ciacore.c` `cia_set_flag()` /
  `cia_ack_flag()` + `ICR delay register`.
- Keyboard/joy2 PA read: `c64cia1.c` `read_ciapa()` formula.

## Audit — current TS state

Source files to audit:

- `src/runtime/headless/cia/cia6526-vice.ts` (= ciacore.c port)
- `src/runtime/headless/peripherals/cia1.ts` (= c64cia1.c port)
- `src/runtime/headless/peripherals/cia2.ts` (= c64cia2.c port)
- `src/runtime/headless/peripherals/keyboard.ts`
- `src/runtime/headless/peripherals/iec.ts` (for CIA2 PA bits)

Known status (best effort):

1. **Smoke baseline strong**: `smoke:cia-fidelity` 22/22 PASS.
   Indicates timer / TOD / ICR mostly correct.
2. **Phase D' (= spec 309-D') applied**: CIA1 / CIA2 push to
   `cpuIntStatus` via `setIntClk` chokepoint. Matches §6.5 + VICE
   pattern.
3. **ICR 1-cycle delay** (§13 invariant 10): smoke test "M2.2c ICR
   latch semantics (v1 deviation pinned)" passes — verify it is
   actually 1:1 with VICE or just "behavior pinned to whatever we
   have".

Known deviations to verify:

1. **ICR delay state machine** (§6.5):
   - Required: write that sets a flag on the same cycle as read
     returns the new flag but doesn't clear it. Implemented via
     delay register that latches one cycle later.
   - Current TS: smoke "v1 deviation pinned" — re-read VICE
     `ciacore.c` ICR delay register handling and re-audit.
   - **TODO fresh session**: cite `ciacore.c` line numbers; verify TS
     matches 1:1.

2. **Timer one-shot vs continuous + T1→T2 chain** (§6.2):
   - Required: CR_A bit 3 = one-shot; CR_B bits 5-6 = T1-pulse-input.
   - Verify: alarm reschedule on continuous; alarm unset on one-shot
     underflow; T2 increment on T1 underflow when chained.
   - **TODO fresh session**: cite `ciacore.c` underflow handler.

3. **TOD BCD + alarm match** (§6.4 + §12 step 10):
   - Required: BCD counters HH:MM:SS.T, alarm match register, IRQ
     on match.
   - Verify: TOD freq = 50 Hz (PAL) / 60 Hz (NTSC) per CRA bit 7
     (`TOD_RATE` bit).
   - **TODO fresh session**: cite `ciacore.c` TOD alarm.

4. **CIA1 PA/PB keyboard + joy2 sharing** (§6.6, §12 step 11):
   - Required: joy2 active-low bits on PA 0..4 ANDed with keyboard
     column scan readback on PB.
   - Current TS: `cia1.ts` has `joystickActiveLowMask` ANDed with
     `kbRows`. Verify the AND order matches `c64cia1.c read_ciapa`.
   - **TODO fresh session**: file:line vs VICE.

5. **CIA2 PA IEC + VIC-bank** (§6.6, §12 step 12, §4.5):
   - Required: PA bits 3=ATN_OUT, 4=CLK_OUT, 5=DATA_OUT;
     6=CLK_IN, 7=DATA_IN; 0..1=VIC bank inverse.
   - Current TS: `cia2.ts` has IEC bit layout in `readPa` /
     `iecWrite`. Verify byte-for-byte vs `c64cia2.c`.
   - **TODO fresh session**: cite `c64cia2.c` bit positions.

6. **CIA1 IRQ → IRQ, CIA2 IRQ → NMI** (§13 invariant 13):
   - Phase D' done. Verify intNum allocation order + set_irq vs
     set_nmi targets.

## TS extras to DELETE

- Any session-side IRQ polling for CIA (removed in Phase D', verify
  none re-introduced).
- Mode-aware CIA behavior switches (`fast-trap` etc.) that bypass
  ciacore — must go through standard read/write paths.

## NTSC stub

- TOD rate: `// TODO NTSC` for 60 Hz path; PAL 50 Hz hard-coded.
- Other CIA behavior is clock-rate-agnostic; the alarm queue handles
  rate via `cycles_per_second` upstream.

## Producer changes

- This phase mostly verifies + cites; CIA infrastructure is largely
  correct. Patch only where audit finds deviation.
- Pin ICR delay semantics to VICE exact (currently "v1 deviation
  pinned") if audit confirms divergence.

## Consumer changes

- None outside CIA files. Phase D' already wired chip-side push.

## Acceptance

- Build clean.
- `smoke:cia-fidelity` 22/22 PASS (= current baseline).
- New smoke `scripts/smoke-403-cia-vice-trace.mjs`: diff a known CIA
  program (e.g. raster IRQ setup) against canned VICE trace cycle by
  cycle for first 100k cycles. Zero divergence.
- MM s1 + Scramble unchanged.
- **Recurring gate (Spec 401 inheritance)**: after impl, set
  `Cpu65xxVice.perCycleAlarmDrain = true` and re-run MM + Scramble.
  If both green → CIA was the latent bug source; enable flag
  permanently in spec 401 + collapse `serviceInterrupt` /
  `doInterrupt` to one path; mark Spec 401 DONE. If Scramble still
  regresses → spec 404 inherits the gate.

## Open Questions

- **OQ-403-1 — PARTIALLY RESOLVED** → `docs/vice-c64-arch.md §6.5`.
  VICE side documented: `ifr_delay` is a 32-bit pipeline register
  with named flag positions at `src/core/ciacore.c:126-143`; the
  1-cycle ICR read-clear / write-set is implemented at
  `ciacore.c:402-433, 961-996`. The clone must reach `ifr_delay`
  shift-register equality, not just IRQ-line equality. **The
  TS-side "v1 deviation table"** (what *current TS* does differently
  vs VICE) **is UNRESOLVED — need user / TS audit** — not derivable
  from VICE source alone; produced by Spec 403 implementation phase.
- **OQ-403-2 — RESOLVED** → `docs/vice-c64-arch.md §6.4`. The TOD
  alarm rate is the **power-supply tick rate**, not 1/10 s.
  `todticks = ticks_per_sec / power_freq` (`ciacore.c:1879`) ≈ 19705
  cycles (PAL@50Hz). CRA bit 7 does **not** change the alarm rate;
  it changes the ring-counter match value (`ciacore.c:1920-1921`,
  match=4 for 50Hz, match=5 for 60Hz). BCD counter advances 10 Hz
  for the matching power frequency.
- **OQ-403-3 — RESOLVED** → `docs/vice-c64-arch.md §6.6`. Exact
  VICE formula at `src/c64/c64cia1.c:425-431`:
  `byte = val & (PRB | ~DDRB); byte |= val_outhi; byte &= read_joyport_dig(JOYPORT_1)`.
  Joystick pulls bits low via the final AND, *regardless* of DDR/PRB —
  not "joystick override", but a digital pull-down ANDed with the
  post-DDR latch value. PA / joy2 mirror at `c64cia1.c:337`.

## Files touched

- `src/runtime/headless/cia/cia6526-vice.ts` (audit)
- `src/runtime/headless/peripherals/cia1.ts` (verify)
- `src/runtime/headless/peripherals/cia2.ts` (verify)
- `scripts/smoke-403-cia-vice-trace.mjs` (new)
- `specs/403-c64-phase-c-peripherals.md` (this)

## Next spec

Spec 404 — C64 Phase D: VIC-II.
