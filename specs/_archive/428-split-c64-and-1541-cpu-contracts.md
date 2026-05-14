# Spec 428 — Split C64 and 1541 CPU execution contracts

**Status:** SUPERSEDED-BY-444-PHASE-4 (2026-05-14). The
"vice-whole-instruction" dispatch-mode kludge was a pre-rewrite
Fehlversuch. Spec 444 Phase 4 purged the kludge: drive CPU runs
cycle-stepped only (= 1:1 VICE drivecpu.c per-bus-cycle). Field
`driveDispatchMode`, threading through integrated-session.ts +
headless-machine-kernel.ts + start-v3-server.mjs, env var
`C64RE_DRIVE_DISPATCH`, and `scripts/smoke-428-drive-whole-instruction.mjs`
all deleted. This file lives in `specs/_archive/` as historical
record — read-only, not source of truth for new work.

**Original status (pre-supersede):** PLAN 2026-05-12 (rollout in small testable slices)
**Branch:** `vic_bugs` → individual phase branches as we go
**Rollout doctrine:** each phase is ONE commit, ONE test gate, ONE
optional revert. No phase touches more than its phase scope. No
phase ships without its gate green.
**Depends on:** 427 (IM2 regression evidence), 401 (failed shared-core
foundation), earlier CPU split attempt (Spec 358, not present in current
tree)
**Doctrine:** Do not force the C64 main CPU and the 1541 drive CPU through
one execution contract. They share ISA semantics, but not the VICE runtime
loop.

## Problem

The current runtime uses `Cpu65xxVice` as the shared implementation for:

- C64 6510 main CPU
- 1541 drive 6502 CPU

This was attractive because the opcode semantics overlap. It is also the
source of recurring loader regressions. Spec 401 changed `Cpu65xxVice`
toward the x64sc C64 execution contract and applied that behavior to the
drive as well. IM2 regressed exactly at that boundary.

VICE keeps these contracts separate:

| Machine side | VICE files | Runtime contract |
|---|---|---|
| C64 x64sc CPU | `src/c64/c64cpusc.c` + `src/6510dtvcore.c` | cycle-stepped C64 main loop; `CLK_INC`; VIC/CIA alarms; BA-low stalls; 6510 `$00/$01` port |
| 1541 drive CPU | `src/drive/drivecpu.c` + `src/6510core.c` | drive-local opcode-template loop; drive alarm context; VIA IRQs; GCR rotation hooks via `drivecpu_rotate()` |

The split is not optional if the goal is 1:1 VICE behavior. A single class
can still share generated opcode primitives internally, but the public
execution loops, timing hooks, interrupt sampling, and disk rotation hooks
must be separated.

## Goals

1. Keep the C64 CPU aligned with x64sc:
   - `c64cpusc.c`
   - `6510dtvcore.c`
   - `mainc64cpu.c` interrupt-delay behavior
   - VIC/CIA alarm timing
   - BA-low read stalls
   - 6510 I/O port behavior
2. Keep the 1541 drive CPU aligned with VICE drive:
   - `drivecpu.c`
   - `6510core.c`
   - drive-local `CLK`, `last_clk`, `stop_clk`, and `cycle_accum`
   - `PROCESS_ALARMS`
   - VIA1/VIA2 IRQ sampling at the same opcode-template points as VICE
   - `drivecpu_rotate()` and `byte_ready_edge` handling at the same
     template sites as VICE
3. Preserve a shared opcode-semantic test corpus where possible, but do
   not share execution-loop state machines when their VICE contracts
   differ.
4. Fix IM2 by returning the drive to the VICE drive contract, not by adding
   game-specific timing constants.

## Non-goals

- Do not rewrite the full CPU core in one step.
- Do not change VIC rendering, VIC bank selection, G64 parsing, media
  mount lifecycle, or IEC bus polarity for this spec unless the evidence
  from Spec 427 proves a direct dependency.
- Do not introduce per-game switches.
- Do not make the drive follow x64sc `CLK_INC`; VICE drive does not do
  that.

## VICE drive CPU mapping (= reference target)

VICE drive CPU is **not** one class. It is three explicit contexts +
two outer loops. Cite `src/drive/drivetypes.h` + `src/drive/drivecpu.c`
+ `src/6510core.c` + `src/c64/c64cpusc.c`:

| VICE C type / file | Purpose | Our equivalent (today) | Gap |
|---|---|---|---|
| `mos6510_regs_t` (drivetypes.h:99) | A/X/Y/SP/PC/P registers | inside `Cpu65xxVice` | shared with C64 — OK as ISA primitives |
| `drivecpu_context_t` (drivetypes.h:59) | per-drive CPU-internal state: `int_status`, `alarm_context`, `last_clk`, `last_exc_cycles`, `stop_clk`, `cycle_accum`, `cpu_regs`, `d_bank_base/start/limit`, `last_opcode_info`, `is_jammed`, `rmw_flag` | eingebettet in `Cpu65xxVice` + `DriveBus` + `DriveCpu` | **falsch geshared mit C64 main CPU** |
| `drivecpud_context_t` (drivetypes.h:119) | drive memory dispatch: `read_tab[1][0x101]`, `store_tab[1][0x101]`, `peek_tab`, `sync_factor` | `DriveBus.readTab/storeTab/peekTab` + `DriveCpu.syncFactor16dot16` | shape mostly OK (Spec 408 per-page dispatch landed) |
| `diskunit_context_t` (drivetypes.h:166) | top-level drive unit: `cpu`, `cpud`, `drives[]`, ROM, type, mynumber, clk_ptr | `DriveCpu implements Drive1541Unit` | shape OK |
| `mainc64cpu.c` (outer loop) | C64 main CPU execution: x64sc `CLK_INC` macro after every clock, VIC/CIA alarm dispatch, BA-low stall | `Cpu65xxVice.tick()` + `executeCycle()` | doctrinally correct for C64 |
| `drivecpu.c:drivecpu_execute()` (outer loop) | drive CPU execution: sync_factor → owed cycles → stop_clk → while-loop over `#include "6510core.c"` opcode templates with `drivecpu_rotate()` hooks | **missing** — drive uses the C64-shaped `Cpu65xxVice.executeCycle()` instead | **regression source** |
| `6510core.c` (shared) | generic 6510 ISA opcode templates with internal CLK accounting + LOCAL_SET_OVERFLOW / PHP / BVC / BVS rotate hooks | partial — we have ISA semantics but no rotate-hook insertion sites | rotation hook placement needed |
| `6510dtvcore.c` (C64 x64sc only) | DTV-style cycle-stepped extension to 6510core for x64sc CLK_INC | absorbed into `Cpu65xxVice.tick()` path | C64-only — fine |

The pattern: VICE uses **one ISA core file** (`6510core.c`) and **two outer
loops** (`mainc64cpu.c` for C64, `drivecpu.c` for drive). The outer loops
differ; the ISA primitives don't.

Our current code reverses that pattern: one outer-loop class
(`Cpu65xxVice.tick()` + `executeCycle()`) used for both, plus duplicated
ISA primitives inside. We must invert it: shared ISA primitives, two
outer-loop classes.

## Proposed Architecture

Introduce two explicit runtime-facing CPU contracts:

```ts
interface C64MainCpuContract {
  executeCycle(): void;
  isAtInstructionBoundary(): boolean;
  c64ViciiCycle?: (clk: number) => number;
  cpuIntStatus: InterruptCpuStatus;
  ioPortHook: IoPort6510Hook;
}

interface DriveCpuContract {
  executeUntilDriveClock(stopClk: number): void;
  executeOneDriveInstruction(): number;
  driveIntStatus: InterruptCpuStatus;
  onDriveRotateHook: () => void;
  onByteReadyHook: () => boolean;
}
```

Implementation shape:

- `C64CpuViceSc`:
  - owns the x64sc `6510dtvcore.c`-style cycle-stepped path.
  - may initially wrap or subclass current `Cpu65xxVice`, but the file
    must no longer claim to be the single source for both C64 and drive.
- `DriveCpuVice`:
  - owns the `drivecpu.c` + `6510core.c` path.
  - exposes whole-instruction dispatch to `DriveCpu.executeToClock`.
  - calls GCR rotation and byte-ready hooks at the VICE template sites,
    not generically once per CPU clock.
- Shared code is allowed only below the contract boundary:
  - flag helpers
  - addressing-mode helpers if timing-neutral
  - opcode semantics where the VICE templates are identical
  - Lorenz/functional opcode tests

## Implementation Phases (small slices)

Each phase is **ONE commit, ONE branch, ONE gate**. Phases run
sequentially; do not start phase N+1 before phase N's gate is
green. If a phase regresses ANY existing canary, revert before
proceeding.

### Phase A — Evidence Gate (no production code change)

**Goal:** prove which Spec 401 file is the regression source
before splitting anything.

**Scope:**
- throwaway worktree only, NOT vic_bugs branch
- 3 builds, 3 IM2 boot tests
- write findings into spec; commit nothing else

**Steps:**
1. Worktree at `2005494` baseline. Confirm IM2 stuck $1xxx.
2. Variant A: same worktree, `git checkout 0a47f50 -- src/runtime/headless/drive/drive-cpu.ts`. Build, IM2 test.
3. Variant B: reset, then `git checkout 0a47f50 -- src/runtime/headless/cpu/cpu65xx-vice.ts`. Build, IM2 test.

**Gate (= must hold to proceed to Phase B):**
- One of A or B reaches PC=$48D3-$48EE within 200M C64 cycles.
- Result recorded in Spec 427 with PC + cycle number.
- Worktree removed; vic_bugs untouched.

**Stop condition:** if NEITHER variant fixes IM2, Spec 428
hypothesis is wrong. Halt + reopen Spec 427 root-cause hunt.

---

### Phase B — Behavior-neutral contract surface

**Goal:** make the architectural intent visible in types. Zero
runtime behavior change.

**Scope:**
- new file `src/runtime/headless/cpu/c64-cpu-contract.ts`
- new file `src/runtime/headless/cpu/drive-cpu-contract.ts`
- both export TS interfaces only, no implementations
- update `IntegratedSession.c64Cpu` typed against `C64MainCpuContract`
- update `DriveCpu.cpu` typed against `DriveCpuContract`
- both contracts are satisfied by current `Cpu65xxVice` instance
  (= structural typing, no code change to that class)

**Gate:**
- `npm run build:mcp` clean
- `npm run smoke:cpu-fidelity` 31/31
- `npm run smoke:cia-fidelity` 22/22
- MM s1 PC=$65f
- Scramble in game code
- motm PC=$B7BF

**Revert recipe:** delete the two new files + revert the type
annotations. Zero side effects.

---

### Phase C — Drive whole-instruction dispatch as OPT-IN

**Goal:** introduce VICE-shaped drive outer loop, gated by flag.
Default = OFF. Existing behavior preserved.

**Scope:**
- `DriveCpu`: new option `driveDispatchMode: "cycle-stepped" | "vice-whole-instruction"` (default `"cycle-stepped"`)
- `vice-whole-instruction` path mirrors VICE `drivecpu.c:drivecpu_execute()`:
  - sync_factor → owed cycles → stop_clk
  - while `CLK < stop_clk`: call `cpu.executeOneInstruction()` (returns consumed cycles)
  - `gcrShifter.tick(N)` ONCE per instruction with N = consumed
- `cycle-stepped` path unchanged

**Gate (= default OFF):**
- all Phase B gates
- IM2 still stuck (= proves default unchanged)

**Phase C test gate (= opt-in flag ON):**
- new smoke `smoke-428-drive-whole-instruction.mjs`:
  - IM2 with flag ON reaches $48D3 within 200M cycles ✓
  - MM s1 with flag ON reaches $65f ✓
  - Scramble with flag ON reaches game code ✓
  - motm with flag ON reaches $B7BF ✓
  - Krill loader (Scramble) ✓

**Stop condition:** if flag-ON breaks any baseline game, the
whole-instruction implementation is buggy. Fix before Phase D.

---

### Phase D — Flip drive default to VICE whole-instruction

**Goal:** make the VICE-faithful path the default. Cycle-stepped
becomes opt-in for motm AB-fastloader probe only.

**Scope:**
- `DriveCpu`: default `driveDispatchMode = "vice-whole-instruction"`
- motm AB-fastloader probe (if still used in any harness) explicitly
  opts back to `"cycle-stepped"`
- update CLAUDE.md / PLAN.md if doctrine needs to reflect

**Gate:**
- all Phase C flag-ON gate items, BUT with no flag (= default)
- IM2 reaches $48D3 default ✓
- Lorenz CPU corpus stays green
- VICE drive test programs stay green
- Full game canary: MM s1 + Scramble + motm + IM2 all pass

**Revert recipe:** flip default back to `"cycle-stepped"`. Single
line change.

---

### Phase E — Rotate hooks at VICE template sites (precision pass)

**Goal:** `drivecpu_rotate()` cycle-exact placement. Replace
`gcrShifter.tick(N)`-per-instruction with hook calls at the four
VICE sites:
- `LOCAL_SET_OVERFLOW(0)` (in 6510core.c)
- 3 main opcode-loop sites (vicii-cycle.c:2527, 2815, 2934)

**Scope:**
- `Cpu65xxVice` (or split drive variant): emit `onRotateHook`
  callback at the 4 sites
- `DriveCpu` consumer wires `onRotateHook → gcrShifter.tick(1)`
- `byte_ready_edge` consumption moves to `LOCAL_SET_OVERFLOW(0)`
  + `PHP` + `BVC` + `BVS` sites

**Gate:**
- all Phase D gates
- new smoke `smoke-428-byte-ready-cycle-exact.mjs` — synthetic
  test PRG that BIT-tests $1C00 PB7 SYNC across known cycle
  offsets; expected pattern matches VICE byte-by-byte

**Stop condition:** if precision pass regresses anything, revert
to Phase D's per-instruction `tick(N)`. Phase D output is already
production-acceptable; Phase E is precision polish.

---

### Phase F — Rename + collapse shared class (optional cleanup)

**Goal:** finalize the architectural split per Spec 358 intent.

**Scope:**
- extract shared opcode templates into `Isa65xxCore` (= shared
  ISA primitives only — no execution loop)
- `Cpu6510ViceSc` (C64) and `Cpu6502DriveVice` (drive) each
  contain their own outer loop, delegate ISA to `Isa65xxCore`
- delete `Cpu65xxVice`

**Gate:**
- all Phase E gates
- file-by-file diff review against VICE source files (cite each
  line)

**Stop condition:** Phase F is **optional**. Phase D + E already
fix IM2 and ship the working architecture. Phase F is the
clean-room finish — defer if time-constrained.

---

## Per-phase test inventory

| Phase | Smokes | Games | Lorenz | VICE-testprogs |
|---|---|---|---|---|
| A | none (worktree) | IM2 only | — | — |
| B | cpu + cia | MM + Scramble + motm | — | — |
| C (flag OFF) | cpu + cia | MM + Scramble + motm | — | — |
| C (flag ON) | + 428-whole-instr | MM + Scramble + motm + IM2 + Krill | — | — |
| D | cpu + cia | MM + Scramble + motm + IM2 + Krill | full | 4/4 |
| E | + 428-byte-ready | + cycle-exact diff trace | full | 4/4 |
| F | all | all | full | 4/4 + manual review |

## Risk profile per phase

- **Phase A**: zero risk (no production code touched).
- **Phase B**: zero behavior risk (type annotations only).
- **Phase C** (flag OFF): zero risk (new path inactive).
- **Phase C** (flag ON): isolated to IM2 + manual flag testing.
- **Phase D**: HIGH — flips default. This is the gate where
  motm + Krill smokes most likely shift. Keep Phase D commit
  small + standalone so revert is trivial.
- **Phase E**: medium — precision pass, may shift cycle counts.
- **Phase F**: low — pure refactor, all tests must already pass.

## Phase ordering rationale

A before B: must prove the drive path matters before touching code.
B before C: type surface lets Phase C add new path without ambiguity.
C before D: flag-gated path proves new dispatch works on real games
before flipping default.
D before E: ship the fix with per-instruction tick first; precision
polish layered after.
F last: cleanup only after correctness is locked in.

## Do Not Do

- Do not keep editing `Cpu65xxVice` until it can satisfy both C64 x64sc
  and 1541 drive timing. That is the architectural trap.
- Do not remove whole-instruction drive dispatch because it sounds less
  cycle-accurate. In VICE, the drive path is opcode-template based and
  still cycle-accounted internally.
- Do not treat IM2 as a special case.
- Do not apply later Spec 408-414 drive rewrites until the Spec 401
  regression split is proven and fixed.

## Acceptance

- The codebase has separate, named C64 and drive CPU runtime contracts.
- Drive CPU no longer depends on C64 x64sc-only `CLK_INC` behavior.
- IM2 regression from Spec 401 is fixed without weakening MM, Scramble,
  motm, or drive test programs.
- Documentation cites the exact VICE source files for both contracts.
