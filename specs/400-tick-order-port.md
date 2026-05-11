# Spec 400 — Tick-order port (C64 + drive)

**Status:** PROPOSED
**Branch:** `vice-arch-port`
**Depends on:** PLAN.md baseline (`vic-fix` @ `0a47f50`)
**Doctrine:** 1:1 VICE x64sc port. No abstractions, no shortcuts, no
"close enough". Each producer / consumer / order decision cites a
§-anchor in the deep-dive docs and is implemented as written there.

## Goal

Lock the per-cycle execution order for the headless runtime so that
every subsequent spec on this branch (interrupt model, VIC chip-side
push, drive-cpu alignment, IEC, GCR) builds against a single canonical
sequence that matches VICE x64sc literally.

After this spec, `IntegratedSession` exposes one orchestrator function
per machine — C64 and 1541 — and every step inside it carries a comment
naming the file + line in VICE source it is porting.

## Source of truth

| Concern | Doc | Section |
|---|---|---|
| C64 per-cycle order | `docs/vice-c64-arch.md` | §11 Tick order per cycle |
| `CLK_INC` macro | `docs/vice-c64-arch.md` | §2.1 |
| Alarm queue + drain | `docs/vice-c64-arch.md` | §2.2 |
| Interrupt delivery model | `docs/vice-c64-arch.md` | §2.3 |
| Main loop | `docs/vice-c64-arch.md` | §2.4 |
| 6510 cycle-exact | `docs/vice-c64-arch.md` | §3.2, §3.3, §3.4 |
| VIC cycle | `docs/vice-c64-arch.md` | §5.1, §5.5, §5.6 |
| Drive per-cycle order | `docs/vice-1541-arch.md` | §12 |
| `drivecpu_execute` | `docs/vice-1541-arch.md` | §3.2 |
| Drive interrupt model | `docs/vice-1541-arch.md` | §3.5 |
| Drive sync (16.16) | `docs/vice-1541-arch.md` | §5 |
| Rotation per-cycle | `docs/vice-1541-arch.md` | §8.3 |
| Drive-sync inside loop | `docs/vice-iec-arc42.md` | §6 (sequence diagrams), §15 |

If any of these citations is wrong or insufficient, **stop and revise
the docs first**. Code does not deviate.

## Canonical C64 cycle — target sequence (vice-c64-arch §11)

```
ONE CYCLE of x64sc:

  enter from CPU's CLK_INC() macro:

  1. interrupt_delay()
       a. while (maincpu_clk >= next_pending_alarm_clk):
            dispatch one alarm (heap re-sift on reschedule)
       b. if (irq_clk <= maincpu_clk):  irq_delay_cycles++
       c. if (nmi_clk <= maincpu_clk):  nmi_delay_cycles++

  2. maincpu_clk++

  3. maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII

  4. vicii_cycle():
       a. complete previous cycle's Phi2 sprite fetch (if any)
       b. raster_cycle++, possibly raster_line++, possibly frame wrap
       c. cycle_flags = cycle_table[raster_cycle]
       d. Phi1 fetch (matrix / graphics / sprite / refresh / idle)
       e. check_hborder()
       f. vicii_draw_cycle()
       g. sprite-DMA flag updates
       h. collision register updates
       i. raster IRQ compare (edge-latched)
       j. update_vborder()
       k. compute and return ba_low for next cycle
            (OR into maincpu_ba_low_flags)

  5. CPU bus cycle:
       if maincpu_ba_low_flags && (this is a READ access):
           maincpu_steal_cycles()
       else:
           CPU read/write
```

**Non-obvious points (§11 doc)**:

- Step 4 emits all Phi1 work for **this** cycle and readies BA for
  the **next** cycle. The CPU read for *this* cycle happens after
  step 4, gated by the **previous** cycle's `ba_low`. BA latches one
  cycle ahead.
- Step 4g (sprite-DMA flag changes) happens **after** the draw. A
  sprite enable visible "now" changes rendering at the next sprite
  slot.

## Canonical 1541 cycle — target sequence (vice-1541-arch §12)

```
ONE DRIVE CYCLE inside drivecpu_execute() loop:

  precondition: cpu->stop_clk set; *clk_ptr < stop_clk

  1. drivecpu_rotate()  → rotation_rotate_disk(drives[0])
       a. delta = *clk_ptr - rotation_last_clk; rotation_last_clk = *clk_ptr
       b. if motor_on:
            accum += delta * bits_per_cycle[zone] * wobble
            while accum >= BIT_CELL_WIDTH:
              accum -= BIT_CELL_WIDTH
              read_or_write_one_bit() — see §8.3
                - update zero_count (SYNC detect)
                - shift byte register
                - at byte boundary:
                    update VIA2 PA (read) or read VIA2 PA (write)
                    pulse CA1 (BYTE-READY)
                    set drive->byte_ready_edge → SO pulse next instr boundary
                - SYNC pattern → set PB.7 SYNC line (active low)

  2. alarm_drain (opcode-boundary only — CYCLE_EXACT_ALARM NOT defined
     for drivecpu, see §3.5):
     while drive_clk >= next_alarm_clk: dispatch
     (VIA1/VIA2 T1 underflow, T2 underflow, SDR shift, TOD)

  3. one 6502 cycle (LOAD/STORE via per-page dispatch tables, §4.2)

  4. *clk_ptr++ (implicit in 6510core macros, §3.3)

  5. at instruction boundary:
       a. interrupt_check_irq_delay (§3.5): if any VIA IFR & IER & 0x7F
          nonzero AND drive_clk >= irq_clk + 2 → enter 7-cycle IRQ entry
       b. SO check: if drive->byte_ready_edge: set V flag in P; clear edge
```

**Non-obvious points (§12 doc)**:

- Step 1 (rotation) runs **before** the cycle's opcode work. A `BIT
  $1C01` reads the **post-pulse** VIA2 PA in the same cycle.
- Drive does NOT call `vic_cycle()` — drive has no VIC. Drive's
  per-cycle work is `rotation_rotate_disk()`.
- Alarm drain is opcode-boundary, not per-cycle. **Do not** copy the
  C64's per-cycle alarm drain into the drive loop.

## C64 ↔ 1541 outer interaction (vice-iec-arc42 §6, §15)

- Drive is **not** stepped per host cycle. The C64 main loop calls
  `drive_cpu_execute_all(maincpu_clk)` at well-defined points
  (per-instruction boundary or every N CPU cycles via configurable
  batch size — see arc42 §6 sequence diagrams).
- IEC line state is sampled by both sides through `iec_*_read_*`
  callbacks; transitions happen only when a side **writes** (drive
  VIA1 PB write, C64 CIA2 PA write).
- `interrupt_check_irq_delay` semantics (§5.10 arc42) apply
  identically on both CPUs.

## Audit — current state on this branch

Source: `src/runtime/headless/integrated-session.ts`,
`src/runtime/headless/drive/drive-cpu.ts`,
`src/runtime/headless/cpu/cpu65xx-vice.ts`.

### C64 cycle path: `stepMicrocodedC64Instruction()`
(integrated-session.ts:1187)

Current order (`useLiteralPortVicPerCycle` branch, default):

```
do {
  updateMicrocodedInterruptLines();   // session-side bridge, VIC only
  vic.tick(1);                        // VIC-II 1 cycle
  before = cpu.cycles;
  cpu.executeCycle();                 // CPU 1 cycle (or whole instr at boundary)
  consumed = cpu.cycles - before;
  if (consumed > 1) vic.tick(consumed - 1);
} while (!cpu.isAtInstructionBoundary())
```

Deviations from §11:

1. **Alarm drain timing** — `updateMicrocodedInterruptLines()` runs
   *before* both VIC and CPU. §11 step 1 says alarm drain runs inside
   `interrupt_delay()` *before* `maincpu_clk++` and *before*
   `vicii_cycle()`. Current code's alarm drain is hidden inside
   `Cpu65xxVice.executeCycle()`'s `drainAlarms()` at the **instruction
   boundary**. This is wrong for C64 — the C64's `CYCLE_EXACT_ALARM` is
   defined (§2.2). Per-cycle alarm drain is required.
2. **`bumpDelays` ordering** — §11 step 1.b/1.c says
   `irq_delay_cycles++` runs *before* `maincpu_clk++`. Current code
   bumps inside `executeCycle()` *after* the clk advance.
3. **BA model** — §11 step 3 + step 5 require
   `maincpu_ba_low_flags &= ~MAINCPU_BA_LOW_VICII` *before*
   `vicii_cycle()`, and `vicii_cycle()` writes the *next* cycle's
   ba_low. Current code has no `maincpu_ba_low_flags` mirror; VIC
   stall path uses a different model.
4. **VIC tick vs CPU step ordering** — current code runs `vic.tick(1)`
   *before* `cpu.executeCycle()`. §11 has the CPU bus cycle (step 5)
   *after* `vicii_cycle()` (step 4). This part is correct.
5. **`updateMicrocodedInterruptLines` placement** — the session-side
   VIC bridge runs per CPU cycle iteration but pushes
   `vic.irqAsserted()`, which reflects the **previous** `vic.tick`
   call's state. This is incidentally correct for current behavior
   (= 1-cycle delay vs literal §11 step 4i) but is not 1:1 with VICE.
   §11 has raster IRQ compare *inside* `vicii_cycle()` (step 4i);
   chip-side push is the canonical path (Spec 402).

### Drive cycle path: `drive-cpu.ts:runOneInstruction()`
(drive-cpu.ts:447) + `cycleSteppedExecute` (drive-cpu.ts:380)

Current order (cycle-stepped path, microcoded):

```
while (cycleAccumulator16dot16 >= 0x10000) {
  if (cycled.isAtInstructionBoundary() && intNumVia1Irq) {
    cpuIntStatus.setIrq(intNumVia1Irq, via1.irqAsserted(), cycles);
    cpuIntStatus.setIrq(intNumVia2Irq, via2.irqAsserted(), cycles);
  }
  cycled.executeCycle();
  cycleAccumulator16dot16 -= 0x10000;
}
```

Deviations from §12:

1. **Rotation step missing inside the cycle loop** — §12 step 1 says
   `rotation_rotate_disk()` runs **before** opcode work *every drive
   cycle*. Current code ticks the GCR shifter outside this loop (via
   `gcrShifter.tick(...)` called from session) which decouples
   rotation from drive clk. This is a fundamental 1:1 deviation.
2. **Alarm drain placement** — §12 step 2 + §3.5 + §2.2 say drive
   alarms drain at **opcode boundary only** (CYCLE_EXACT_ALARM **not**
   defined for drivecpu). Current code calls `drainAlarms` per cycle
   inside `Cpu65xxVice.executeCycle()`. Wrong for drive — must move
   to instruction boundary on the drive CPU specifically.
3. **IRQ push timing** — §12 step 5.a says
   `interrupt_check_irq_delay` runs at the **instruction boundary**,
   and the source is each VIA's `irqAsserted` *at that moment*.
   Current code's per-boundary push of `via1.irqAsserted()` /
   `via2.irqAsserted()` to `cpuIntStatus` is correct in placement
   but bypasses the VIA's own `set_int_clk` chokepoint (Spec 403 will
   migrate to chip-side push, like Phase D' did for C64 CIAs).
4. **SO line (BYTE-READY) handling** — §12 step 5.b says SO check
   happens at instruction boundary: if `drive->byte_ready_edge` →
   set V flag in P. Current code has SO handling but its placement
   vs. instruction boundary is not audit-verified.
5. **Whole-instruction batched path** (`runOneInstruction`,
   non-cycle-stepped) violates §12 outright — it skips rotation +
   alarm drain interleaving entirely. This path stays for KERNAL
   serial-loader timing (per current comment) but is incompatible
   with arch-port. Resolution: delete it once cycle-stepped path is
   proven on full game corpus.

### Drive-sync (host C64 ↔ drive)

Current: `cycleAccumulator16dot16` += `syncFactor16dot16 * c64Delta`,
then while-loop ticks drive cycles. This matches §5 (16.16 fixed-point)
in shape; specific sync points and `sync_factor` init paths (vice-iec
§5.12) need verification per Spec 403.

## Producer changes (this spec)

This spec is **audit + skeleton**. No behavior changes ship in 400.
What ships:

1. **One orchestrator file per machine** with the exact §11 / §12
   sequence laid out as code comments, no implementation yet:
   - `src/runtime/headless/orchestrator/c64-cycle.ts` (new)
   - `src/runtime/headless/orchestrator/drive-cycle.ts` (new)
   Each function is a stub that throws "not implemented yet —
   covered by Spec 401/402/403". Each step has a `// §X.Y` cite.

2. **Inventory comment block** at top of
   `src/runtime/headless/integrated-session.ts` listing every cite
   in current code (existing `Spec 309`, `Spec 297`, etc.) marking
   each as either "matches §X.Y" or "deviates from §X.Y — Spec 4NN
   fixes".

3. **No removal** of working code. Current Phase B compat + Phase D'
   CIA push + session-side VIC bridge stays. Smokes + game gate must
   stay green.

## Consumer changes (this spec)

None. Orchestrator stubs are unwired.

## Acceptance

- `npm run build` zero TS errors.
- `npm run smoke:cpu-fidelity` 31/31 PASS.
- `npm run smoke:cia-fidelity` 22/22 PASS.
- `scripts/test-mm-screenshots.mjs` renders MM character select at
  t=120s, PC=$65f.
- `scripts/test-scramble-screenshots.mjs` renders Scramble title at
  t=120s, PC in $9700-$910x range.
- `git diff --stat` shows only new orchestrator stub files + audit
  comment block. No existing line of dispatch code changed.

## Open Questions

- **Q1 — RESOLVED** → `docs/vice-c64-arch.md §2.2`. VICE does **not**
  `#define CYCLE_EXACT_ALARM` for x64sc; the macro only gates
  `PROCESS_ALARMS` inside `src/6510core.c:138-146`. x64sc uses
  `6510dtvcore.c` (included via `mainc64cpu.c:809`) which drains
  alarms both per-cycle (via `CLK_INC` → `interrupt_delay`,
  `mainc64cpu.c:97-110`) **and** at opcode boundary
  (`6510dtvcore.c:1734-1736, 1768-1770`). Only `scpu64cpu.c:65` ever
  defines the macro. Drive CPU uses `drive6510core.c` style with
  opcode-boundary drain — that distinction stands.
- **Q2 — RESOLVED** → `docs/vice-c64-arch.md §10.3`. `drive_cpu_execute_all`
  is **not** batched per N cycles. It is called from CIA1 PB read
  (`c64cia1.c:439, 446`), CIA2 PA r/w (`c64cia2.c:248, 256`), IEC bus
  state changes (`iecbus.c:229, 241, 292, 304, 355, 368`), snapshot,
  fast-IEC byte (`c64fastiec.c:78`), parallel cable, and monitor stop.
  Pattern is *lazy catchup on bus observation*, drive absorbs varying
  Δclk per call.
- **Q3 — UNRESOLVED — need user decision:** BA-line model — where to
  track `maincpu_ba_low_flags` bitfield migration (extend Spec 401 to
  include it, or split to a dedicated spec). Doc §3.4 + §5.7 describe
  the VICE-side semantics; the *project-management* choice of which
  spec owns it is not derivable from VICE source.
- **Q4 — UNRESOLVED — need user investigation:** how the legacy
  whole-instruction drive path (`runOneInstruction`) interacts with
  KERNAL serial-loader timing. VICE itself has **no** whole-instruction
  drive path — `drivecpu_execute` always cycle-steps. The current TS
  `runOneInstruction` is a TS-side compatibility shim and the question
  "is it still needed" can only be answered by running a smoke without
  it (which is what the spec already proposes). Not a VICE-source
  question.

## Files touched

- NEW: `src/runtime/headless/orchestrator/c64-cycle.ts`
- NEW: `src/runtime/headless/orchestrator/drive-cycle.ts`
- MODIFIED (audit comment only):
  `src/runtime/headless/integrated-session.ts`
- NEW: `specs/400-tick-order-port.md` (this file)

## Next spec

Spec 401 — Interrupt model port (full).
