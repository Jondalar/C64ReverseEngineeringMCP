# PLAN — vice-arch-port branch

> **Runtime-Proof-Gate Reset 2026-05-16.**
>
> Tag `runtime-green-2026-05-16` at master HEAD commit `87b4957`
> ("Merge vic_bugs: Specs 425-429 = CLK_INC + VIC bank + IM2 fix +
> LED VICE 1:1") is the frozen runtime baseline.
> Branch `codex/1541-runtime-gates`
> is the active gate-work branch. Branch `quarantine/1541-literal-vice`
> holds the burned 440-series implementation attempt as research /
> material lager only — **not** a merge candidate.
>
> **Specs 440-452 are superseded as implementation plan.** They
> remain research notes only. No DONE status from 440-452 is
> accepted unless re-validated by Runtime Proof Gates from
> `samples/screenshots/proof/`. See:
>
> - `specs/600-runtime-proof-gates.md` — gate doctrine.
> - `specs/601-baseline-truth-table.md` — game-by-game baseline.
> - `specs/610-1541-parity-rebuild-charter.md` — replacement plan
>   (Specs 611-615).
>
> **Unit green != runtime green. Mapping green != runtime green.**
> Smoke without screenshot / state assertion is not a gate.

> **440-series status table below is HISTORICAL — quarantine /
> research material only, not the current roadmap.**

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

## Gate per step (tiered per spec)

Every step must end with:

- `npm run build` (= `tsc -p tsconfig.json && tsc -p pipeline/tsconfig.json && fix-pipeline-ext`) green.
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- Per-spec gate (tiered, refinement Q4):

  | Tier | Specs | Test | Cycle budget |
  |---|---|---|---|
  | **Core / structural** | 402, 403, 405, 407, 408, 409, 413, 414, 416, 417, 418 | smokes only + per-spec new smoke | 100k diff-trace where applicable |
  | **Game-affecting** | 404, 411, 412, 419, 420, 421 | smokes + MM + Scramble | 1M diff-trace |
  | **Validation** | 406, 415, 423 | full corpus (MM, Scramble, motm, fastloader corpus, boot-ladder) | 10M diff-trace |

  Rationale: agents otherwise burn ~6 min on game tests every spec,
  including specs that cannot break gameplay (PLA, CIA fidelity,
  SID, image format). Tiered budget saves ~2h across 20 remaining
  autopilot specs.

- No step lands red. If gate fails: revert step, write findings into
  the step's spec under "Open Questions", do not proceed.

## Refinement decisions (locked 2026-05-11)

| Q | Decision |
|---|---|
| 1 | Doc clone-checklists wörtlich (= 23 phases + 1 meta = 24 specs) |
| 2 | Doc-natural order: C64 → 1541 → IEC |
| 3 | Delta-align (audit + minimal change) |
| 4 | Phase-specific gate |
| 5 | File:line specific audit |
| 6 | Citations: doc §X.Y + VICE source file:line |
| 7 | Strict 1-zu-1 mit doc phases |
| 8 | Doc-first OQ resolution |
| 9 | Specs may add new smokes |
| 10 | PAL priority + NTSC stub (`// TODO NTSC`) |
| 11 | Specs flag TS extras for DELETE |
| 12 | Fresh Claude session (self-contained specs); Opus agents later |

## Spec map

| Spec | Title | Doc anchor |
|---|---|---|
| 400 | Tick-order port — audit + skeleton | c64 §11, 1541 §12, iec §6 |
| **C64 §12** | | |
| 401 | C64 Phase A: Foundation | c64 §12 A (steps 1–5) |
| 402 | C64 Phase B: Memory and PLA | c64 §12 B (6–8) |
| 403 | C64 Phase C: Peripherals (CIAs) | c64 §12 C (9–12) |
| 404 | C64 Phase D: VIC-II | c64 §12 D (13–20) |
| 405 | C64 Phase E: Sound and the rest | c64 §12 E (21–25) |
| 406 | C64 Phase F: Validation | c64 §12 F (26–28) |
| **1541 §13** | | |
| 407 | 1541 Phase A: Per-drive context | 1541 §13 A (1–2) |
| 408 | 1541 Phase B: CPU and memory | 1541 §13 B (3–6) |
| 409 | 1541 Phase C: Sync model | 1541 §13 C (7–10) |
| 410 | 1541 Phase D: VIA1 (IEC interface) | 1541 §13 D (11–15) |
| 411 | 1541 Phase E: VIA2 (disk controller) | 1541 §13 E (16–21) |
| 412 | 1541 Phase F: Rotation | 1541 §13 F (22–26) |
| 413 | 1541 Phase G: Image formats | 1541 §13 G (27–30) |
| 414 | 1541 Phase H: Lifecycle and integration | 1541 §13 H (31–34) |
| 415 | 1541 Phase I: Validation | 1541 §13 I (35–40) |
| **IEC §15** | | |
| 416 | IEC Phase A: IEC bus shared state | iec §15 A (1–3) |
| 417 | IEC Phase B: CIA2 wiring | iec §15 B (4–6) |
| 418 | IEC Phase C: Push-flush model | iec §15 C (7–9) |
| 419 | IEC Phase D: ATN edge + CA1 | iec §15 D (10–12) |
| 420 | IEC Phase E: Drive 6502 IRQ delivery | iec §15 E (13–14) |
| 421 | IEC Phase F: Drive-side bus access | iec §15 F (15–16) |
| 422 | IEC Phase G: Burst mode (optional) | iec §15 G (17) |
| 423 | IEC Phase H: Validation | iec §15 H (18–21) |

## vice-arch-port status (2026-05-12) — HISTORICAL

> Snapshot as of 2026-05-12. Superseded by the Runtime-Proof-Gate
> reset 2026-05-16. The status below stays for historical record
> and is **not** the current roadmap.

Spec series 401–423 GREEN (modulo PARTIAL: 401 OQ-401-3 deferred,
412 rotation tick order swap deferred). Spec 423 = final validation
spec; 5 smokes (`smoke-423-{bare-boot,load-directory,motm-canary,
krill-loader,fastloader-corpus}.mjs`) + 4 frozen golden masters
under `samples/golden-master/spec-423/`. motm canary GREEN
(PC=$B7BF main loop), Krill canary GREEN (PC=$93D4 game code).
Branch ready for merge or post-arch-port pickup (write support,
datasette, cartridges, NTSC, JiffyDOS, multi-drive).

## Epic 440 status (2026-05-16) — SUPERSEDED / QUARANTINE

Specs 440-452 are superseded as implementation plan. They remain
research notes only. No DONE status from 440-452 is accepted unless
revalidated by runtime proof gates from `samples/screenshots/proof/`.

The `1541-literal-vice` branch (tip `8d8346e`) has been moved to
`quarantine/1541-literal-vice` and is **closed for further work**.
Commits there may be cherry-picked with `-n` into
`codex/1541-runtime-gates`, one at a time, and each cherry-pick
must pass the full 7-game Runtime Proof Gate run before it lands.

The replacement plan is `specs/610-1541-parity-rebuild-charter.md`
(Specs 611-615). All 440-452 DONE/PARTIAL tables remain in the spec
files for historical context; they are no longer the roadmap.

## Step order (legacy 6-step view — for historical context)

### Step 1 — Tick-order audit & rewire

Spec: `specs/400-tick-order-port.md` (committed)

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
