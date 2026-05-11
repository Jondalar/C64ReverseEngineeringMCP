# PLAN — vice-arch-port branch

Branch `vice-arch-port` reboots the headless runtime port against three
new VICE source-of-truth deep-dives. All prior specs (220–360 series)
are archived under `specs/_archive/`. This file is the live roadmap.

## Source of truth

1. **`docs/vice-c64-arch.md`** — x64sc machine: 6510 CLK_INC, PLA,
   CIA1/2, VIC-II (Phi1/Phi2, BA, IRQ), SID, I/O, tick order,
   invariants, clone checklist.
2. **`docs/vice-1541-arch.md`** — TDE: drive 6502 push-mode, VIA1
   IEC, VIA2 disk-controller (BYTE-READY → SO), rotation/GCR,
   D64/G64/P64, tick order, invariants, clone checklist.
3. **`docs/vice-iec-arc42.md`** — IEC + drive-sync arc42 incl. burst,
   non-1541 drv_bus formulas, interrupt_check_irq_delay,
   sync_factor init, IEC-interplay checklist.

All TS work on this branch must cite a §-anchor in one of these docs
or be rejected.

## Working baseline (= what is green today)

Inherited from `vic-fix` @ `0a47f50`:

- C64 IRQ pipeline functional via Phase 309-C ablation
  (`cpuIntStatus.globalPendingInt` level source, Phase B dispatch).
- CIA1/CIA2 chip-side push (Phase 309-D').
- VIC raster IRQ still via session bridge (Phase 309-E reverted —
  chip-side push misaligned D018 by ~1–2 cycles, root cause to be
  resolved by tick-order port below).
- Drive 6502 IRQ pipeline via session-side polling bridge in
  `drive-cpu.ts` (Phase 309-H equivalent pending arch-port pass).
- Smokes: `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- Game gate: MM s1 (PC=$65f, character select) + Scramble Infinity
  (PC=$9709, title bitmap) green via
  `scripts/test-mm-screenshots.mjs` /
  `scripts/test-scramble-screenshots.mjs` with
  `vicRenderer: "literal-port"`.

## Gate per step

Every step must end with:

- `npm run build` (= `tsc -p tsconfig.json && tsc -p pipeline/tsconfig.json && fix-pipeline-ext`) green.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- MM s1 + Scramble Infinity `vicRenderer: "literal-port"` both render
  expected title.
- No step lands red. If gate fails: revert step, write findings into
  the step's spec under "Open Questions", do not proceed.

## Step order

### Step 1 — Tick-order audit & rewire

Spec: `specs/400-tick-order-port.md` (TBD)

- Audit current per-cycle sequence in `IntegratedSession` against
  `vice-c64-arch.md` §11 (synthesized tick order) and `vice-1541-arch.md`
  §12.
- Lock the canonical sequence per cycle: alarm dispatch → CPU step →
  VIC tick → CIA tick → IEC sample → drive catch-up → snapshot of
  irq line states.
- Move all per-cycle wiring into one orchestrator function backed by
  doc cite comments.

### Step 2 — Interrupt model port (full)

Spec: `specs/401-interrupt-model-port.md` (TBD)

- Port complete `InterruptCpuStatus` semantics from `vice-c64-arch.md`
  §3 + §6 + §11 + IEC §5.10 (`interrupt_check_irq_delay`).
- `bumpDelays` driven by `CLK_INC` per the doc; `irqDelayCycles` /
  `nmiDelayCycles` consulted by dispatch.
- Opcode-boundary sample matching `6510dtvcore.c:1734-1812`.
- Phase B compat-ablation removed once doc-exact path is green.

### Step 3 — VIC chip-side push (Phase E redo)

Spec: `specs/402-vic-chip-side-irq.md` (TBD)

- With Step 1 tick order locked, VIC raster IRQ pushes directly via
  `cpuIntStatus.setIrq` from `viciisc/vicii-cycle.c:467-474` analog.
- Session-side VIC bridge removed.
- Gate: D018 raster splits in MM + Scramble pixel-clean.

### Step 4 — Drive arch alignment

Spec: `specs/403-drive-arch-align.md` (TBD)

- Re-port `drive-cpu.ts` against `diskunit_context_t` /
  `drive_t` shape per `vice-1541-arch.md` §3–§7.
- VIA1 IEC contract from §6, VIA2 disk-controller from §7
  (BYTE-READY → SO trick).
- Drive-side `InterruptCpuStatus` shares the same class as the C64;
  per-source IntNums per the doc.

### Step 5 — IEC handshake parity

Spec: `specs/404-iec-handshake.md` (TBD)

- Port `iec-c64.c` / `serial-iec-bus.c` sequence from
  `vice-iec-arc42.md` §5–§6 (ATN/CLK/DATA edges, drv_bus formulas).
- Verify §5.10 `interrupt_check_irq_delay` semantics applied across
  the bus.

### Step 6 — GCR / rotation parity

Spec: `specs/405-gcr-rotation-parity.md` (TBD)

- Drive §8: zones, SYNC, wobble, BYTE-READY pulse.
- GCR shifter alignment with `rotation.c` 16.16 fixed-point sync.

## Spec template

Each step:

- One markdown spec under `specs/4XX-*.md`.
- Sections: Goal, Doc §-anchor, Producer change, Consumer change,
  Acceptance (smokes + games), Open Questions.
- No new spec without doc citation.

## Out of scope (this branch)

- VICE-fidelity beyond what the three deep-dive docs already
  describe. New VICE source readings are a new doc revision, not a
  spec.
- UI work (V3 cockpit, monitor, scenarios).
- D64 write paths, multi-drive, datasette (per `vice-c64-arch.md` §9
  and `vice-1541-arch.md` deferred sections).

## Status

- 2026-05-11: branch created, archive cleanup committed (`7e6c739`).
  Three arch deep-dives in place. Spec 400 = next.
