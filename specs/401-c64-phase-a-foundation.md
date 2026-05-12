# Spec 401 — C64 Phase A: Foundation (no peripherals)

**Status:** RECURRING GATE PASSED (during spec 402 work).
`Cpu65xxVice.perCycleAlarmDrain = true` is now the default.
Dispatch-path collapse (OQ-401-3) deferred to a dedicated CPU-core
refactor sprint — keeps cpu65xx-vice.ts internals out of spec 402's
declared file scope.
**Branch:** `vice-arch-port`
**Depends on:** 400 (tick-order audit)
**Doctrine:** 1:1 VICE x64sc port. Never deviate.

## Recurring gate (post-2005494) — RESULT

The following two OQ resolutions are wired but were **gated** by
`Cpu65xxVice.perCycleAlarmDrain` (initially `false`, now `true`):

- **OQ-401-1 — PASSED during spec 402**: per-cycle alarm drain (=
  VICE 6510dtvcore.c per-cycle pattern). Initially blocked by
  Scramble Infinity LOAD (PC traps at $61d). After spec 402 memory/PLA
  port: MM s1 + Scramble Infinity both LOAD and run to expected
  game state with the flag enabled. Flag flipped to `true` permanently.
- **OQ-401-3 — DEFERRED**: single dispatch path via
  `doInterrupt(globalPendingInt)`. Both `serviceInterrupt` and
  `doInterrupt` still alive in `startInstructionCycle`. Collapse
  requires touching cpu65xx-vice.ts dispatch internals beyond spec
  402's declared file scope; will land in a dedicated CPU-core
  refactor sprint.

**Recurring acceptance result** at spec 402: with
`perCycleAlarmDrain=true` enabled, run on `vice-arch-port`:
- MM s1: t=120s PC=$65d (character select range).
- Scramble Infinity: t=120s PC=$ff58 (KERNAL NMI handler), t=180s
  PC=$96fd (title loop).
- `smoke:cpu-fidelity` 31/31, `smoke:cia-fidelity` 22/22.
- `smoke-402-pla-configs.mjs` 28/28, `smoke-402-cpuport-falloff.mjs`
  11/11.

## Goal

Bring the C64-side CPU + alarm queue + per-cycle macro + memory dispatch
in line with `docs/vice-c64-arch.md §12 Phase A` (steps 1–5).

## Doc anchor

- `docs/vice-c64-arch.md` §12 Phase A (steps 1–5)
- `docs/vice-c64-arch.md` §2.1 (`CLK_INC` macro)
- `docs/vice-c64-arch.md` §2.2 (alarm queue)
- `docs/vice-c64-arch.md` §3.2 (6510 cycle-exact)
- `docs/vice-c64-arch.md` §3.3 (instruction → bus cycles)
- `docs/vice-c64-arch.md` §4.1 (memory dispatch hot path)
- `docs/vice-c64-arch.md` §11 (tick order — already in spec 400)
- `docs/vice-c64-arch.md` §13 invariants 1, 4

## Canonical content (verbatim §12 Phase A)

1. Global 64-bit clock `clk`. Start at 0. Increment once per 6510 bus
   cycle. Never reset except on hard reset.
2. Alarm queue: min-heap keyed by clock. Operations: `set`, `unset`,
   `next_pending_clk`, `dispatch`. `dispatch` fires all alarms whose
   clock ≤ `clk`. **Must run before** clock increment.
3. Per-cycle macro: `tick()` = alarm-drain → `clk++` → `vic_tick()`.
   Use a macro / inline function; this is the hot path.
4. 6510 core: state machine with explicit per-cycle decomposition of
   every opcode (including undocumented). Each addressing-mode step
   is one `tick()`. Reset, IRQ, NMI entry sequences also ticked.
5. Memory dispatch: `mem_read[page]` and `mem_write[page][vbank]`
   tables, indexed by `(addr >> 8)`. Recomputed when processor port
   or cart lines change. Never bypass for "performance"; the per-page
   dispatch *is* the hot path.

## VICE source cite

- Global clock `maincpu_clk`: `src/maincpu.c` (declared `src/maincpu.h`).
- Main loop: `src/maincpu.c:526` `maincpu_mainloop()`.
- `CLK_INC()` macro: `src/c64/c64cpusc.c:47`.
- Alarm queue: `src/alarm.c`, `src/alarm.h`. Heap operations:
  `alarm_context_dispatch`, `alarm_context_next_pending_clk`,
  `alarm_set`, `alarm_unset`.
- `interrupt_delay()`: `src/mainc64cpu.c:97-110`.
- 6510 template: `src/6510core.c` (included as macro by
  `src/c64/c64cpusc.c`).
- `FETCH_OPCODE()`: `src/c64/c64cpusc.c:124`.
- Memory tables: `src/c64/c64mem.c` (≈L70+, `_mem_read_tab[]` /
  `_mem_write_tab[]`).

## Audit — current TS state (best effort; fresh session verifies)

Source files to audit:

- `src/runtime/headless/cpu/cpu65xx-vice.ts`
- `src/runtime/headless/alarm/alarm-context.ts`
- `src/runtime/headless/scheduler/*.ts`
- `src/runtime/headless/integrated-session.ts` (per-cycle macro site)
- `src/runtime/headless/memory-bus.ts`

Known deviations to verify:

1. **Alarm-drain placement** (§12 step 2 + §11 step 1.a vs §13
   invariant 1):
   - Required: alarm-drain runs **before** `clk++` (= inside CPU's
     `interrupt_delay()`, vice-c64-arch §11 step 1.a; mainc64cpu.c:97).
   - Current TS: `cpu65xx-vice.ts` has alarm-drain inside
     `drainAlarms()` called at instruction boundary in
     `startInstructionCycle()`. Verify whether this fires per-cycle
     (= matches §11) or per-instruction (= deviates).
   - **TODO fresh session**: file:line for current `drainAlarms()`
     call site; confirm whether `CYCLE_EXACT_ALARM` analog is per
     cycle.

2. **`tick()` macro absent** (§12 step 3):
   - Required: a single inline function combining
     `interrupt_delay() → clk++ → vicii_cycle()`.
   - Current TS: per-cycle work is spread between
     `IntegratedSession.stepMicrocodedC64Instruction` (calls
     `updateMicrocodedInterruptLines`, `vic.tick(1)`,
     `cpu.executeCycle`) and `Cpu65xxVice.executeCycle`.
   - **TODO fresh session**: identify the canonical per-cycle entry
     and consolidate into one function with doc cite.

3. **6510 entry sequences** (§12 step 4 + §3.3):
   - Required: reset, IRQ, NMI entries each ticked one cycle at a time.
   - Current TS: `serviceInterrupt(vectorAddress, breakFlag)` (Phase B
     compat path) and `doInterrupt(pending)` (Phase C path). Both
     advance `clk` via `clkAdd`. Verify each push / vector-load step
     is one tick **and** matches VICE 6510core.c DO_INTERRUPT macro
     ordering (push PCH, PCL, P, vector lo, vector hi).
   - **TODO fresh session**: cite `src/6510core.c:436-530` line-by-line
     vs current TS doInterrupt body.

4. **Memory dispatch tables** (§12 step 5 + §13 invariant 3):
   - Required: per-page `read[256]` / `write[256][num_vbanks]` arrays.
   - Current TS: `HeadlessMemoryBus` uses per-page I/O handlers
     (`registerIoHandler`) plus a flat RAM array. Verify whether
     read/write paths go through the per-page dispatch consistently
     **and** whether the table indexing is by `(addr >> 8)` and
     re-built on `c64pla_config_changed` analog (= spec 402).
   - **TODO fresh session**: file:line for read/write entry points.

5. **`maincpu_clk` monotonicity** (§13 invariant 12):
   - Required: clk never decreases except at hard reset.
   - Current TS: `clk` is a public field on `Cpu65xxVice` and a
     `cycles` getter/setter. Verify no code path writes a smaller
     value mid-session.
   - **TODO fresh session**: grep `cpu.cycles =` and `cpu.clk =`.

## TS extras to DELETE (per refinement Q11)

- None expected in Phase A. The foundation layer should already be
  thin. If audit finds extras (e.g. duplicate clock variables, manual
  cycle counters bypassing the alarm queue), the spec adds them here.

## NTSC stub (per refinement Q10)

- §3 / §11 are clock-rate-agnostic. No NTSC-specific paths in this
  phase.
- Memory dispatch in §4 / §12 step 5 is identical for PAL/NTSC. No
  stub needed.

## Producer changes

1. Consolidate per-cycle entry into a single `tick()` function
   following §11 step 1–3 + §12 step 3 ordering.
2. Move alarm-drain to before `clk++` (verify `CYCLE_EXACT_ALARM`
   analog applied per cycle, not per instruction).
3. Confirm DO_INTERRUPT 7-cycle sequence matches `6510core.c:436-530`
   verbatim and remove any duplicate dispatch path (Phase B compat
   `serviceInterrupt` + Phase C `doInterrupt` must collapse to one
   path matching VICE).
4. Confirm memory tables are per-page-dispatched and rebuilt on PLA
   config change (interface stays; spec 402 fills in PLA config).
5. **Add `maincpu_ba_low_flags` bitfield** (per resolved OQ-400-Q3):
   field lives in the C64 cycle state alongside `maincpu_clk`. Set
   via OR from `vicii_cycle()` return value (= spec 404's job to
   write the bit); read by CPU stall path (this spec writes the
   reader, VIC writes the writer). Cite `mainc64cpu.c:97-110` + §11
   step 3 + §5.7.
6. **Delete legacy `runOneInstruction` whole-instruction drive path**
   (per resolved OQ-400-Q4): VICE has no equivalent — strict 1:1
   forbids it. Remove from `drive-cpu.ts`. Acceptance gate proves
   removal safe: smokes + MM s1 + Scramble Infinity stay green.

## Consumer changes

- None outside `cpu65xx-vice.ts` and `integrated-session.ts`'s
  per-cycle call. CIA / VIC / drive callers stay as-is.

## Acceptance (phase-spec gate per refinement Q4)

- `npm run build` zero TS errors.
- `npm run smoke:cpu-fidelity` 31/31 PASS.
- `npm run smoke:cia-fidelity` 22/22 PASS.
- New smoke (per refinement Q9):
  `scripts/smoke-401-tick-order.mjs` — synthetic program that
  programs a CIA1 timer alarm, runs a known N cycles, asserts the
  alarm fires at the exact `clk` value VICE would (cross-check
  against canned VICE trace if available).
- MM s1 PC=$65f at t=120s, character select rendered (unchanged).
- Scramble Infinity title rendered at t=120s.
- File diff scope: `cpu65xx-vice.ts`, `alarm-context.ts`,
  `integrated-session.ts` (one orchestrator call site), one new
  smoke. No CIA / VIC / drive source touched.

## Open Questions (resolve doc-first per refinement Q8)

- **OQ-401-1 — RESOLVED** → `docs/vice-c64-arch.md §2.2`. The macro
  `CYCLE_EXACT_ALARM` is **not** defined for x64sc. x64sc uses
  `6510dtvcore.c` (not `6510core.c`) and drains alarms both per-cycle
  (via `CLK_INC` → `interrupt_delay` at `mainc64cpu.c:97`) and at
  opcode boundary (`6510dtvcore.c:1734, 1768`). Only `scpu64cpu.c:65`
  defines the macro.
- **OQ-401-2 — RESOLVED** → `docs/vice-c64-arch.md §3.5`. Both NMI
  and IRQ are 7 cycles, identical shape: 2 dummy reads at PC, push
  PCH, push PCL, push P, fetch vec_lo, fetch vec_hi
  (`src/6510dtvcore.c:354-405` for NMI prologue;
  `src/6510dtvcore.c:314-349` `DO_IRQBRK` for IRQ tail). The doc now
  carries a per-cycle table with file:line cites and the IRQ-to-NMI
  promotion mechanism after step 5.
- **OQ-401-3 — RESOLVED** → `docs/vice-c64-arch.md §3.5`. VICE has
  exactly *one* `DO_INTERRUPT(int_kind)` macro
  (`6510dtvcore.c:354`); NMI is handled inline, IRQ falls through to
  `DO_IRQBRK`. The clone should mirror this: one entry point, two
  branches. The TS-side `serviceInterrupt` path should be removed in
  favor of a single dispatch with `int_kind` discriminator —
  otherwise the cycle-5 IRQ-to-NMI promotion (which depends on a
  shared alarm-drain in between) cannot be implemented faithfully.

## Files touched (planned)

- `src/runtime/headless/cpu/cpu65xx-vice.ts` (modify)
- `src/runtime/headless/alarm/alarm-context.ts` (audit, possibly
  modify)
- `src/runtime/headless/integrated-session.ts` (orchestrator call
  site)
- `src/runtime/headless/memory-bus.ts` (audit only; PLA rebuild
  hook stays for spec 402)
- `scripts/smoke-401-tick-order.mjs` (new)
- `specs/401-c64-phase-a-foundation.md` (this file)

## Next spec

Spec 402 — C64 Phase B: Memory and PLA.
