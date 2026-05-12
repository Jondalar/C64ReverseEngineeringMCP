# Spec 420 — IEC Phase E: Drive 6502 IRQ delivery

**Status:** DONE 2026-05-12
**Branch:** `vice-arch-port`
**Depends on:** 419
**Doctrine:** 1:1 VICE IEC port.

## Completion notes (2026-05-12)

Verification-only landing — no Producer/Consumer code change required.
All §15 Phase E (steps 13–14) primitives were already in place from
prior specs:

- INTERRUPT_DELAY=2 (= shared C64 + drive constant per OQ-420-1) lives
  in `src/runtime/headless/cpu/interrupt-cpu-status.ts:29` and is used
  by `checkIrqDelay`/`checkNmiDelay` (= 1:1 with VICE
  `interrupt_check_irq_delay`, `vice/src/maincpu.c:484` +
  byte-identical `vice/src/drive/drivecpu.c:330-351`,
  `vice/src/interrupt.h:39`).
- 7-cycle drive 6502 IRQ entry = `cpu65xx-vice.ts:516 doInterrupt`
  (microcoded path) + `cpu65xx-vice.ts:1239 serviceInterrupt` (legacy
  call site). Both honour DO_INTERRUPT layout: 2 dummy reads + 3
  pushes (PCH/PCL/P) + 2 vector reads at $FFFE/$FFFF
  (= `vice/src/6510core.c:436` DO_INTERRUPT macro).
- 1541 DOS ROM IRQ vector = $FE67 (= OQ-420-2 byte-level verify on
  vendored `resources/roms/dos1541-325302-01+901229-05.bin` offset
  0x3FFE/0x3FFF = `0x67 0xFE`).
- VIA1 chip-side IRQ push from spec 410 already routes
  `viacore_signal` → `set_int` → `cpuIntStatus.setIrq` with `rclk =
  drive_clk`, eliminating any drive-side polling bridge for VIA1
  (per `Via1d1541.attachIrqLine` at `via1d1541.ts:198` —
  cite `vice/src/drive/iec/via1d1541.c:92`).
- Per-cycle `bumpDelays` happens inside the cycled CPU's CLK_INC
  analogue, so the gate `*drv->clk_ptr >= irq_clk + INTERRUPT_DELAY`
  fires at the first instruction boundary satisfying the rule.

New smoke `scripts/smoke-420-drive-irq-delay.mjs` (8 sub-tests):
1. INTERRUPT_DELAY constant pinned to 2.
2. ATN edge → drive `cpuIntStatus.irqClk` stamped at `drive_clk`.
3. `checkIrqDelay` false at +1 cycle, true at +2 cycles.
4. Drive 6502 IRQ entry consumes exactly 7 drive cycles
   (DO_INTERRUPT) and lands inside the handler at $FE67/$FE68.
5. Vendored 1541 DOS ROM offset 0x3FFE/0x3FFF = `0x67 0xFE` (= $FE67).

Acceptance gate (game-affecting tier per PLAN.md):

- `npm run build` zero TS errors.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- `smoke:fidelity-backlog` 6/6.
- VICE drive testprogs 4/4 (`run-cia-suite.mjs --group drive`).
- New `smoke:420-drive-irq-delay` 8/8.
- MM s1 — boot reaches PC=$65f (character select) from t=60s onward
  (= existing baseline preserved).
- Scramble Infinity — LOAD complete, game loop visible (PC oscillates
  $9003 / $9062 / $9715 / $9721, well within title-bitmap region per
  baseline $9709).

Files touched:

- `specs/420-iec-phase-e-drive-irq.md` (this — DONE marker + notes).
- `scripts/smoke-420-drive-irq-delay.mjs` (new).
- `package.json` (register `smoke:420-drive-irq-delay`).

`cpu65xx-vice.ts`, `via1d1541.ts`, and `drive-cpu.ts` were NOT
modified — verification-only per spec wording ("DO NOT touch
cpu65xx-vice.ts (= deferred CPU-core sprint)").

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

- **OQ-420-1**: RESOLVED 2026-05-11 — see
  `docs/vice-iec-arc42.md §17.5`. Both C64 and drive use the same
  compile-time `#define INTERRUPT_DELAY 2`
  (`vice/src/interrupt.h:39`); drive copy of
  `interrupt_check_irq_delay`
  (`vice/src/drive/drivecpu.c:330-351`) is byte-identical to
  main-CPU copy (`vice/src/maincpu.c:484`). Both apply branch +
  CLI corrections via `OPINFO_DELAYS_INTERRUPT` /
  `OPINFO_ENABLES_IRQ`.
- **OQ-420-2**: RESOLVED 2026-05-11 — see
  `docs/vice-iec-arc42.md §17.5`. Verified at byte level on
  vendored `vice/data/DRIVES/dos1541-325302-01+901229-05.bin`
  (16 KiB, loaded at $C000): offset 0x3FFE/0x3FFF = `0x67 0xFE`
  → IRQ vector $FE67.

## Files touched

- `src/runtime/headless/cpu/cpu65xx-vice.ts` (verify delay on drive
  instance)
- `src/runtime/headless/drive/via1d1541.ts` (chip-side push)
- `src/runtime/headless/drive/drive-cpu.ts` (drop polling bridge)
- 1 new smoke
- `specs/420-iec-phase-e-drive-irq.md` (this)

## Next spec

Spec 421 — IEC Phase F: Drive-side bus access.
