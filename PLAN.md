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
| **Sprint 430 — Literal VICE port (1541/IEC/VIA/GCR)** | | |
| 430 | Parent — Literal VICE port doctrine | iec §5, §6; 1541 §6, §8 |
| 431 | Phase A — Canary freeze + DuckDB diff infra | iec §15; 1541 §3.2, §6.1–§6.5 |
| 432 | Phase B — iecbus.c literal port | iec §5.1, §5.11, §6.1, §6.2, §9 ADR-1 |
| 433 | Phase C — via1d1541.c literal port | iec §5.5, §6.3–§6.5; 1541 §6 |
| 434 | Phase D — viacore.c subset audit (1541 VIA1/VIA2) | iec §5.5; 1541 §6.5, §6.6 |
| 435 | Phase E — drivecpu.c catch-up literal port | iec §5.4, §5.7, §5.12; 1541 §3.2, §5 |
| 436 | Phase F — Final wrapper audit + dead-code purge | iec §9 ADR-4, §11 |
| 437 | Phase G — gcr.c literal port (bit-level) | 1541 §8.2, §8.4, §8.5 |
| **Epic 440 — 1541 vollständig 1:1 VICE-port** | | |
| 440 | Epic charter — full 1541 port. Subagent-audits forbidden. | epic doc |
| 441 | rotation.c literal port + gcr-shifter.ts audit | 1541 §8 |
| 442 | viacore.c Claude-self re-audit (33 fns → 60+) | iec §5.5 |
| 443 | VIA1 + VIA2 d1541 literal re-port + formula tests | 1541 §6, §7 |
| 444 | drivecpu.c true literal (stop_clk field, exec body 1:1) | iec §5.4, 1541 §3 |
| 445 | gcr.c write-path + encoder + GCR_conv_data table | 1541 §8.2 |
| 446 | drivesync.c full PAL/NTSC sync_factor logic | 1541 §5 |
| 447 | memiec.c + driverom.c literal port | 1541 §4 |
| 448 | alarm.c literal port (alarm_context_t, alarm_t) | – |
| 449 | fdc.c error codes + cbmdos.h enum | 1541 §8 |
| 450 | Full read/write/verify validation harness | – |
| 451 | NTSC regression check (PAL-first done) | – |

## vice-arch-port status (2026-05-12)

Spec series 401–423 GREEN (modulo PARTIAL: 401 OQ-401-3 deferred,
412 rotation tick order swap deferred). Spec 423 = final validation
spec; 5 smokes (`smoke-423-{bare-boot,load-directory,motm-canary,
krill-loader,fastloader-corpus}.mjs`) + 4 frozen golden masters
under `samples/golden-master/spec-423/`. motm canary GREEN
(PC=$B7BF main loop), Krill canary GREEN (PC=$93D4 game code).
Branch ready for merge or post-arch-port pickup (write support,
datasette, cartridges, NTSC, JiffyDOS, multi-drive).

## Sprint 430 status (2026-05-13)

Branch `1541-literal-vice`. Spec 430 split into 7 phase-specs
(431–437). Sequential execution mandatory ([[feedback_sequential_specs]]).
Per-phase wrapper purge (incremental Phase F slices in 432–435; final
sweep in 436). LNR-S1 stays RED across the sprint; retest at end of
437. Canaries: motm, MM, IM2, Scramble (GREEN gate), LNR-S1 (RED
oracle).

Order: 431 → 432 → 433 → 434 → 435 → 436 → 437.

Spec gate per phase: `npm run canary:spec-430` (introduced in Spec
431). All 4 green canaries must stay green; LNR-S1 first-divergence
row must not regress earlier than the previous phase's report.

**Sprint 430 retrospective (2026-05-13):** Sprint 430 closed only the
IEC/VIA/GCR-read path. The subagent audit results (Spec 434 + initial
Spec 437 PASS claim) were UNRELIABLE — manual gegen-check found
divergences (GCR_DECODE table `0xff` vs VICE `0`; `gcr_decode_block`
export semantic). Sprint 430 should be considered PARTIAL. The
full-1541 work is captured in **Epic 440** (Specs 440-451) below.

## Epic 440 status (2026-05-14)

Branch: `1541-literal-vice`.
**Doctrine:** No subagent audits. Claude reads VICE source itself
for every audit verdict. 12 sequential specs (440 → 451). Full chip
+ function 1:1 port; write-path + rotation audit + alarm system +
drivesync + memory map + ROM loader + fdc.

Goal: end-to-end byte-identical 1541 vs VICE for read+write+timing.
Doc: `docs/epic-1541-full-vice-port.md`.

### Per-spec status

| Spec | Module | Status |
|---|---|---|
| 440 | Epic charter + doctrine + 7-step workflow | DONE |
| **441** | rotation.c + p64 stubs + drive_t + VIA2 backend port | **DONE** (4f legacy delete deferred — see below) |
| **442** | viacore.c Claude-self re-audit | **DONE** (MYVIA gate + peek-raw fix + 13 conformance tests) |
| 443 | VIA1 + VIA2 d1541 literal re-port | **NEXT** (recommended) |
| 444 | drivecpu.c true literal | OPEN |
| 445 | gcr.c write-path | OPEN |
| 446 | drivesync.c full | OPEN |
| 447 | memiec.c + driverom.c | OPEN |
| 448 | alarm.c literal port | OPEN |
| 449 | fdc.c error codes | OPEN |
| 450 | Validation harness | OPEN |
| 451 | NTSC regression check | OPEN |

### Spec 441 DONE summary (2026-05-14)

- `rotation.ts` is the production primitive for 1541 disk-side
  bit-stream. All VIA2 PA/PB/PCR/CA2/CB2 backend hooks route
  through rotation_byte_read / rotation_rotate_disk per VICE
  via2d.c literal port. Drive byte-ready edges consumed via
  DriveCpu.fireByteReady (VICE drivecpu_set_overflow analog).
- `drive_t` literal mirror in `drive-t.ts` (50 fields). `rotation_t`
  module-internal in `rotation.ts`.
- P64 helpers throwing-stub; mount-gate refuses .p64 disks with
  marker.
- Tests: `tests/unit/drive/rotation.test.ts` (15/15 PASS).
  Canary gate 5/5 PASS. A/B harness `C64RE_ROTATION_DIFF=1`
  motm 20M instructions 0 divergence. Lorenz Disk1 600s: 83
  tests, 0 fails.
- Perf: rotation overhead ~0.3% CPU (profile-verified). Lorenz
  timeout NOT in Spec 441 code; out of scope.
- 4f (delete gcr-shifter + 82 grep hits) DEFERRED — gcrShifter
  still needed for the A/B harness, mount notification sinks,
  and test-only PA/PB fallback. Wiring chores rather than
  correctness work; cleanup spec after 442.

Docs:
  - `docs/spec-441-mapping.md`
  - `docs/spec-441-flip-result.md`
  - `docs/spec-441-production-proof.md` (FINAL)
  - `docs/spec-441-step-4-migration-plan.md`
  - `docs/spec-441-overnight-halt.md`

### Spec 442 DONE summary (2026-05-14)

`viacore.c` (2243 LoC) ↔ `via6522-vice.ts` (1341 LoC) line-by-line
audited by Claude (no subagent). 9 commits.

- Mapping doc `docs/spec-442-viacore-mapping.md` (220+ rows across
  sections A-J): every via_context_t struct field + every viacore.c
  function (public + static) cited with VICE-line ↔ TS-line ↔
  verdict.
- Patches applied:
  - **MYVIA_NEED_LATCHING = false** flag (`via6522-vice.ts:197-203`)
    gating 7 latch sites — matches VICE drive build (`viacore.c:76`
    `/* #define MYVIA_NEED_LATCHING */` commented out).
  - **viacore_peek IFR** returns raw `ifr` (was synthesising bit 7;
    bit-7 synthesis is read-only behaviour per `viacore.c:1284-1285`).
- Tests: `tests/unit/via/viacore-conformance.test.ts` (13/13 PASS) +
  rewritten `tests/unit/via/via-ila-ilb-latch.test.ts` (5/5 PASS).
  Total VIA unit suite: 65/65 PASS across 7 files. Rotation 15/15
  PASS. Canary 5/5 PASS.
- Ticketed out to follow-on specs:
  - `viacore_disable` / `enabled` flag / `viacore_shutdown` → Spec 444
  - `viacore_snapshot_read_module` → Spec 451 (VSF cross-load)
  - `viacore_dump` → OUT (debug-only)
  - `read_clk` / `read_offset` → OMIT (write-only in VICE viacore.c)
- Spec 434 subagent-produced audit doc invalidated and superseded
  by Spec 442 mapping.

Docs:
  - `docs/spec-442-viacore-mapping.md` (audit matrix)
  - `docs/spec-442-production-proof.md` (final verdict)

### Next recommended spec — 443 VIA1 + VIA2 d1541 device re-port

`via1d1541.c` (420 LoC) + `via2d.c` device-level wrappers (PA/PB/
PCR backends). Spec 441 already ported via2d.c PA/PB/PCR/CA2/CB2
backend literal for the rotation flip; Spec 443 closes the loop by
auditing via1d1541.c (IRQ wiring, ATN backend, DDR formulae) and
verifying via2d.c backend signature alignment (storePcr void
tightening from Spec 442 Phase 5 finding).

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
