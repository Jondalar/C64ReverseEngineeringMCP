# Spec 420 — IEC Phase E: Drive 6502 IRQ delivery

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** 419
**Doctrine:** 1:1 VICE IEC port.

## Goal

Implement drive-side IRQ delivery + INTERRUPT_DELAY=2 per
`docs/vice-iec-arc42.md §15 Phase E` (steps 13–14) and §5.10.

## Doc anchor

- §15 Phase E
- §5.10 interrupt_check_irq_delay semantics
- §8 cross-cutting timing model

## Canonical content (verbatim §15 Phase E)

13. Implement `INTERRUPT_DELAY = 2` (drive cycles). At each
    instruction boundary, `interrupt_check_irq_delay` checks
    `*drv->clk_ptr >= irq_clk + 2`. First boundary satisfying
    triggers IRQ entry.
14. IRQ entry = 7 drive cycles, vectored to drive `$FFFE/$FFFF`,
    which on DOS 1541 ROM points to `$FE67`. Handler JSRs to
    `$E853` (ATN responder), which sets `$7C := $01`.

## VICE source cite

- `INTERRUPT_DELAY`: `src/interrupt.h:61`.
- `interrupt_check_irq_delay`: `src/maincpu.c:484-505` and analog
  in drive context.

## Audit — current TS state

Status:

- INTERRUPT_DELAY=2 constant present in TS interrupt-cpu-status.
- IRQ entry 7-cycle path present (Phase C compat-ablation +
  Phase B serviceInterrupt).
- Drive IRQ delivery currently via session polling bridge in
  `drive-cpu.ts`. Spec 410 (Phase D) migrates to chip-side push
  via VIA1.

Deviations to verify:

1. **`interrupt_check_irq_delay` semantics on drive** (§5.10, §15
   step 13):
   - Required: at instruction boundary, `clk >= irq_clk + 2`
     before IRQ enters.
   - Current TS: Phase B dispatch uses `lastIFlagClearInstrLen`
     formula; spec 401 unifies with VICE pattern. Verify INTERRUPT_DELAY
     applied on drive specifically.

2. **IRQ entry = 7 drive cycles** (§15 step 14):
   - Required: 2 dummy reads + 3 pushes + 2 vector reads.
   - Current TS: `serviceInterrupt(0xFFFE, false)` path. Verify
     each cycle ticked individually.

## TS extras to DELETE

- Any drive-side IRQ short-circuit that skips INTERRUPT_DELAY (=
  fast-trap bypasses).

## NTSC stub

- Drive runs at 1 MHz; INTERRUPT_DELAY identical PAL/NTSC.

## Producer changes

1. Pin `INTERRUPT_DELAY = 2` on drive CPU per §5.10.
2. Verify IRQ entry tick count = 7 drive cycles.
3. Migrate to chip-side VIA1 push (per spec 410).

## Consumer changes

- VIA1 IRQ → drive cpuIntStatus.setIrq(intNumVia1, value, rclk).

## Acceptance

- Build clean.
- VICE drive testprogs 4/4.
- New smoke `scripts/smoke-420-drive-irq-delay.mjs`: assert VIA1
  CA1 IFR → 2-cycle delay → drive 6502 IRQ entry at correct clock.
- motm boots (= existing).

## Open Questions

- **OQ-420-1**: INTERRUPT_DELAY for C64 vs drive — both = 2? Doc
  §5.10 confirms; verify.
- **OQ-420-2**: 1541 ROM IRQ vector $FFFE/$FFFF = $FE67? Cite.

## Files touched

- `src/runtime/headless/cpu/cpu65xx-vice.ts` (verify delay on drive
  instance)
- `src/runtime/headless/drive/via1d1541.ts` (chip-side push)
- `src/runtime/headless/drive/drive-cpu.ts` (drop polling bridge)
- 1 new smoke
- `specs/420-iec-phase-e-drive-irq.md` (this)

## Next spec

Spec 421 — IEC Phase F: Drive-side bus access.
