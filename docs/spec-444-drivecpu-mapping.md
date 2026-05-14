# Spec 444 — drivecpu.c ↔ drive-cpu.ts mapping

**Status:** PROGRESS (Phase 1)
**VICE sources:**
- `drive/drivecpu.c` (737 LoC)
- `drive/drivecpu.h` (62 LoC)
- `drive/drivetypes.h` (`drivecpu_context_t` struct @ 59-110)
**TS target:** `src/runtime/headless/drive/drive-cpu.ts` (1321 LoC)
**Doctrine:** Claude-self, no subagents.

Verdict legend: MATCH / DEVIATION / BUG / MISSING / TS-EXTRA / OMIT-OK / OUT.

---

## A. `drivecpu_context_t` struct fields (drivetypes.h:59-110)

| VICE field | Init | TS counterpart | Verdict |
|---|---|---|---|
| `int traceflg` | 0 | — | OMIT-OK (debug-only) |
| `int rmw_flag` | 0 | `Cpu6510Cycled` / cpu.rmwFlag indirection via Via6522ViceOptions.rmwFlagRef/Set | MATCH-DEVIATION (callback indirection vs direct field) |
| `uint8_t cpu_last_data` | — | `lastBusValue: number = 0xff` (`:249` in DriveBus) | MATCH |
| `interrupt_cpu_status_s *int_status` | — | `cpu.intStatus` (Cpu65xxVice) / chip-side push via `Via6522Vice.setInt` (Spec 410) | MATCH-DEVIATION (split: chip pushes into intStatus directly) |
| `alarm_context_s *alarm_context` | — | `alarmContext: AlarmContext` (DriveBus + DriveCpu both expose) | MATCH |
| `monitor_interface_s *monitor_interface` | — | — | OMIT-OK (no monitor UI in V1) |
| `CLOCK last_clk` | — | `lastClk = 0` (`:699`) | MATCH (number vs CLOCK) |
| `CLOCK last_exc_cycles` | — | `last_exc_cycles: number = 0` (Phase 2b patch) — tracked at end of `executeToClock` as `max(0, consumed - target)` | PORTED (Spec 444 Phase 2b) |
| `CLOCK stop_clk` | — | `stop_clk: number = 0` (Phase 2b patch) — set at entry of `executeToClock` to `cpu.cycles + (cycleAccum >>> 16)` | PORTED (Spec 444 Phase 2b) |
| `CLOCK cycle_accum` | — | `cycleAccum = 0` (`:701`) | MATCH (semantic equivalent) |
| `uint8_t *d_bank_base` | NULL | — | OMIT-OK (TS uses readTab/storeTab dispatch instead of d_bank_*) |
| `unsigned int d_bank_start, d_bank_limit` | — | — | OMIT-OK (TS dispatch) |
| `unsigned int last_opcode_info` | — | — | MISSING (watchpoints, low-priority) |
| `unsigned int last_opcode_addr` | — | — | MISSING (watchpoints, low-priority) |
| `int is_jammed` | — | `is_jammed: number = 0` (Phase 2b patch) — field present, V1 has no dispatcher (stock 1541 DOS never executes JAM opcode) | PORTED-FIELD-ONLY (Spec 444 Phase 2b) — dispatcher deferred (drivecpu_jam OMIT-OK for V1; would need monitor hook + ROM trap, all OMIT-OK in current scope) |
| `mos6510_regs_t cpu_regs` | — | `cpu.regs` (Cpu6510 / Cpu65xxVice) | MATCH-DEVIATION (lives on cpu object) |
| `R65C02_regs_t cpu_R65C02_regs` | — | — | OUT (1541 only uses 6502 not 65C02) |
| `uint8_t *pageone` | NULL | implicit in cpu memory map / RAM[0x0100..0x01ff] | OMIT-OK |
| `int monspace` | — | — | OMIT-OK (monitor) |
| `char *snap_module_name` | — | passed via constructor options | MATCH-DEVIATION |
| `char *identification_string` | — | — | OMIT-OK |

---

## B. `drivecpu.c` functions (737 LoC)

| VICE function | VICE lines | TS counterpart | Verdict |
|---|---|---|---|
| `drivecpu_setup_context` | 70-127 | `DriveCpu` ctor (`drive-cpu.ts:749-868`) + `DriveBus` ctor (`drive-cpu.ts:251-...`) | **PORTED-WRAPPER** — see B.1 below for sub-row breakdown |
| `cpu_reset` (static) | 165-184 | `DriveCpu.softReset()` (`:1022-1033`) + `DriveCpu.reset()` (`:995-1001`) | needs row check |
| `drivecpu_reset_clk` | 186-192 | — | needs row check (alarm-context clock reset) |
| `drivecpu_reset` | 194-212 | `DriveCpu.softReset()` (`:1022-1033`) | needs row check |
| `drivecpu_trigger_reset` | 214-217 | `DriveCpu.softReset()` (sync) vs VICE (async via int_status flag) | **DEVIATION-DOCUMENTED** — see B.2 below |
| `drivecpu_set_overflow` | 219-223 | `fireByteReady` (`drive-cpu.ts:849-861`, core: `:854` cpuMicro.reg_p \|= 0x40, `:856` cpuLegacy.flags \|= 0x40) | **PORTED-WRAPPER** — see B.3 below |
| `drivecpu_shutdown` | 225-246 | — | **OMIT-OK** — see B.4 below |
| `drivecpu_init` | 249-253 | DriveCpu ctor body (calls bus + cpu setup + cpu.reset by Cpu6510/Cpu65xxVice ctor) | **PORTED-IMPLICIT** — VICE body is 2 lines: `drivemem_init` + `drivecpu_reset`. TS ctor inlines both. |
| `drive_generic_dma` (static) | 292-354 | — | OMIT-OK (DMA not in V1 1541) |
| `drivecpu_execute` | 356-448 | `Cpu6510Cycled.executeCycle` / `DriveCpuCycled.executeCycle` (`cycle-wrappers.ts`) | needs row check (alarm dispatch + step model differs) |
| `drivecpu_set_bank_base` (static) | 450-460 | TS uses readTab/storeTab dispatch | OMIT-OK |
| `drivecpu_jam` (static) | 462-566 | needs row check | needs row check |
| `drivecpu_snapshot_write_module` | 568-640 | needs row check | DEFER → Spec 451 (VSF cross-load) |
| `drivecpu_snapshot_read_module` | 642-end | needs row check | DEFER → Spec 451 |
| `drivecpu_sleep` | 266-269 (empty: `/* Currently does nothing */`) | `DriveCpu.sleep` body sets `sleeping = true` (`:1084`) | **MATCH-VICE-NOP-PLUS-EXTRA** — VICE no-op; TS adds `sleeping=true` gate for runFor early-exit. Documented TS-EXTRA. |
| `drivecpu_wake_up` | 255-264 | `DriveCpu.wakeUp()` (`:747`) — only sets `sleeping=false` | **MINOR-DEVIATION** — VICE additionally skips stale cycles if `maincpu_clk - last_clk > 0xffffff`. TS doesn't. Not load-bearing for V1 short runs. |
| `drivecpu_prevent_clk_overflow` | not in .c (in maincpu / drivesync) | — | OMIT-OK (Spec 446 owns drivesync clock wraparound) |

### B.1 `drivecpu_setup_context` (VICE:70-127) sub-row breakdown

| VICE step | VICE line | TS counterpart | Verdict |
|---|---|---|---|
| `lib_calloc` context structs | 76, 81-82 | GC — implicit via `new DriveCpu()` / `new DriveBus()` | OMIT-OK |
| `interrupt_cpu_status_new` + `_init` | 84-85 | `Cpu65xxVice.cpuIntStatus` (owned per drive CPU); init implicit | PORTED-WRAPPER |
| `drivecpu_int_status_ptr[mynumber] = ...` | 87 | not needed — TS doesn't use static array; chip pushes directly via `Via1d1541.attachIrqLine(cpuIntStatus)` (`drive-cpu.ts:794`) | DEVIATION-OK (Spec 410 chip-side push replaces lookup) |
| `cpu->rmw_flag = 0` | 89 | Cpu6510/Cpu65xxVice ctor inits rmwFlag = 0 | PORTED-IMPLICIT |
| `d_bank_limit = 0; d_bank_start = 0; pageone = NULL` | 90-92 | — | OMIT-OK (TS uses `readTab`/`storeTab` dispatch arrays, not bank-base pointers) |
| `snap_module_name = "DRIVECPU%u"` | 94 | — | DEFER → Spec 451 (VSF module names) |
| `identification_string = "DRIVE#%u"` | 95 | — | OMIT-OK (logging only) |
| `monitor_interface_new` + field init | 96-122 | — | OMIT-OK (no monitor UI in V1) |
| `alarm_context_new` | 125 | `AlarmContext` passed via `opts.alarmContext` (single context shared) | PORTED-WRAPPER |

**Verdict: PORTED-WRAPPER.** All load-bearing sub-steps mirrored. Monitor + identification-string OMIT-OK for V1.

### B.2 `drivecpu_trigger_reset` (VICE:214-217) — DEVIATION

VICE:
```c
void drivecpu_trigger_reset(unsigned int dnr) {
    interrupt_trigger_reset(drivecpu_int_status_ptr[dnr], diskunit_clk[dnr] + 1);
}
```
Sets `IK_RESET` flag in intStatus. CPU processes the flag on its next
instruction boundary (DEFERRED reset).

TS: `DriveCpu.softReset(pc)` (`:1022-1033`) calls `cpu.reset(pc)`
immediately (SYNCHRONOUS reset to PC).

**Behavioural diff:** VICE allows the current instruction to complete
before the reset takes effect. TS resets atomically. For V1 (no
in-flight RMW concurrency between trigger and dispatch) this is
indistinguishable. Mark DEVIATION-DOCUMENTED; not load-bearing.

If a future spec needs cycle-accurate reset-trigger timing, the path
is to push `IK_RESET` into `cpuIntStatus` and let the per-cycle wrapper
pick it up on the next instruction boundary.

### B.3 `drivecpu_set_overflow` (VICE:219-223) — PORTED-WRAPPER

VICE body:
```c
void drivecpu_set_overflow(diskunit_context_t *drv) {
    drivecpu_context_t *cpu = drv->cpu;
    cpu->cpu_regs.p |= P_OVERFLOW;
}
```
Just sets V flag on CPU regs.

TS `fireByteReady` (`drive-cpu.ts:849-861`) wraps the literal core in
extra plumbing:
```ts
if ((pcr & 0x02) === 0) return;          // Spec 411 PCR gate
via2.via.signal("ca1", "fall");          // Spec 411 CA1 falling edge
if (cpuMicro) cpuMicro.reg_p = (cpuMicro.reg_p | 0x40) & 0xff;  // V flag (LITERAL VICE)
else if (cpuLegacy) cpuLegacy.flags |= 0x40;                    // V flag (LITERAL VICE)
onSoEdge?.(true, cpuClk());              // trace ring hook
```

The `| 0x40` is `P_OVERFLOW` (= V flag bit 6, VICE 6510/types.h
`P_OVERFLOW = 0x40`). LITERAL MATCH with VICE.

Extras (CA1 falling edge + PCR gate + trace) are NOT in VICE
`drivecpu_set_overflow` — they live in VICE's BYTE-READY hardware
chain (PLA → VIA2 CA1, the SO pin gating happens on the BYTE-READY
line not in drivecpu_set_overflow). Spec 411 owns the CA1 edge port;
PCR gate is Spec 441. Both correctly cite their VICE sources.

**Verdict: PORTED-WRAPPER.** Literal core present; richer wrapper
owned by Spec 411/441.

### B.4 `drivecpu_shutdown` (VICE:225-246) — OMIT-OK

VICE body:
- `alarm_context_destroy(cpu->alarm_context)` — free C alloc
- `monitor_interface_destroy(cpu->monitor_interface)` — free monitor (omitted in V1)
- `interrupt_cpu_status_destroy(cpu->int_status)` — free C alloc
- `lib_free(cpu->snap_module_name)` — free C string
- `lib_free(cpu->identification_string)` — free C string
- `machine_drive_shutdown(drv)` — generic VICE hook
- `lib_free(drv->func / drv->cpud / cpu)` — free C structs

Every operation is C-memory-free. TS has GC. No load-bearing
side-effect that must run at shutdown for emulation correctness.

**Verdict: OMIT-OK.** No port needed in V1 (process exits, GC
handles). If Spec 451 VSF dump-and-reload requires explicit
alarm-context teardown, add a `shutdown()` method then.

### B.5 IRQ propagation (`drivecpu_set_irq` analog)

VICE does NOT have a public `drivecpu_set_irq` function. IRQ
propagation goes from chip → `cpu->int_status` via VICE's generic
`interrupt_set_irq` (in interrupt.c), called from each VIA's
`set_int` callback (e.g. `via1d1541.c:92`).

TS equivalent: `Via1d1541.attachIrqLine(cpuIntStatus, "via1-irq")`
(`drive-cpu.ts:794`) registers the VIA's IRQ line with the drive
CPU's `InterruptCpuStatus`. The chip's `set_int` callback
(`via1d1541.ts:163-178`) pushes level changes directly into that
status object — Spec 410 chip-side push (= analog of VICE
`interrupt_set_irq`).

| VICE | TS | Verdict |
|---|---|---|
| `via1d1541.c:99` `interrupt_set_irq(cpu->int_status, num, value, rclk)` | `via1d1541.ts:170` `chipIntStatus.setIrq(chipIntNum, asserted, clk)` | MATCH (Spec 410 + Spec 443 audited) |
| `drivecpu_int_status_ptr[dnr]` static array | per-drive `cpuIntStatus` field on `Cpu65xxVice` | DEVIATION-OK (per-instance vs static array; single-drive V1 makes them equivalent) |

**Verdict: PORTED-LITERAL** for the load-bearing setIrq call;
DEVIATION-OK for the static-array → per-instance refactor.

---

## C. Open audit rows (Phase 2 priority)

1. **stop_clk field + drive_cpu_execute early-exit** — HIGH priority,
   currently MISSING. Affects drive-cpu run-loop semantics.
2. **drivecpu_reset / cpu_reset / drivecpu_reset_clk** — verify
   alarm-context clock reset + zero-state literal.
3. **drivecpu_trigger_reset** — port reset-request entry.
4. **drivecpu_shutdown** — bundled w/ Spec 442 viacore_shutdown.
5. **drivecpu_snapshot_write/read_module** — VSF compat (Spec 451
   owned; Phase 2 mark MISSING for now).
6. **drivecpu_jam** — needs row check (CPU-jam handling).
7. **drivecpu_execute** — TS uses cycle-step model; verify
   semantics equivalent to VICE's alarm-driven loop.
8. **drivecpu_sleep** — current TS only has `wakeUp`; sleep counterpart
   missing.

## D. Bundled cleanups (from Spec 442/443)

1. **`Via6522Vice.disable()` + `enabled: boolean` field** + literal
   `viacore_disable()` port. Spec 442 ticketed. VICE viacore.c:364-372:
   alarm_unset × 5 + `enabled = false`. Small port.

2. **`viacore_shutdown`**. Spec 442 ticketed. VICE viacore.c:1895-1903
   only does `lib_free` calls (releases C-allocated strings). TS has
   GC + the strings live as JS string options, no manual free needed.
   **Resolution: OMIT-OK** (documented; no port needed).

3. ~~`ViaBackend.storePcr` signature `void` tightening~~. **CORRECTION:**
   VICE viacore.h:211 actually declares
   `uint8_t (*store_pcr)(struct via_context_s *, uint8_t, uint16_t);`
   — VICE returns `uint8_t`. TS returns `BYTE`. **MATCH.** Spec 442
   mapping incorrectly flagged this as DEVIATION. **Resolution: NO PATCH
   NEEDED** (already MATCH).

4. **VIA2 backend `reset` mirror `drv->led_status = 1`**. Spec 443
   MINOR. VICE via2d.c:423-431 sets `drv->led_status = 1; drive_update_ui_status();`.
   TS backend reset is `() => undefined`. Apply: TS backend reset
   sets `shadowDrive.led_status = 1` when attached. Low-priority but
   cheap fix.

## E. Phase 2b deep-dive results

### E.1 `drive_cpu_execute` (VICE:356-445) ↔ `executeToClock` (`:1152-1245`)

VICE structure:
1. `drivecpu_wake_up(drv)` — clock-skip if stale (255-264)
2. `cycles = clk_value - cpu->last_clk` (377-381)
3. Chunk into 10000-cycle batches; `cycle_accum += sync_factor*tcycles;
   stop_clk += accum >> 16; accum &= 0xffff` (383-390)
4. Inner loop `while (*drv->clk_ptr < cpu->stop_clk)` runs one
   `6510core` instruction per iteration (393-441)
5. `cpu->last_clk = clk_value` (443)
6. `drivecpu_sleep(drv)` (444 — empty in VICE)

TS structure:
1. enabled gate (`:1159-1162`) — Spec 414 extension
2. `c64Delta = c64Clk - lastClk; lastClk = c64Clk` (`:1163-1165`)
3. sleeping path: accumulate but skip run (`:1166-1171`) — TS-EXTRA
4. `cycleAccum += syncFactor16dot16 * c64Delta` (`:1173`)
5. **stop_clk = cpu.cycles + (cycleAccum >>> 16)** (Phase 2b new)
6. Inner loop `while (cycleAccum >= 0x10000)` consumes one drive cycle
   per iteration (`:1221-1244`)
7. **last_exc_cycles = max(0, consumed - target)** (Phase 2b new)

**Verdict: PORTED-WRAPPER** — TS uses cycleAccum-based loop condition
instead of stop_clk-based; equivalent end-state. stop_clk + last_exc_cycles
now mirror VICE field semantics for snapshot/diagnostic.

**Sub-deviations** (documented, not load-bearing):
- VICE chunks main delta into 10000-cycle batches; TS feeds whole
  delta in one pass. No observable behavioural diff.
- TS sleeping branch (TS-EXTRA) accumulates but doesn't run; VICE
  has no sleeping (always runs); canary 5/5 PASS under TS-EXTRA.
- TS `vice-whole-instruction` mode is a Spec 428 fallback path,
  retained for non-microcoded back-compat; default = cycle-stepped
  matches VICE 6510core per-bus-cycle semantics.

### E.2 `cpu_reset` + `drivecpu_reset` + `drivecpu_reset_clk`

VICE:
- `cpu_reset` (drivecpu.c:165): preserve_monitor + `clk_ptr=6`
  + `rotation_reset(both)` + `machine_drive_reset` + restore monitor.
- `drivecpu_reset_clk` (186-191): `last_clk=maincpu_clk;
  last_exc_cycles=0; stop_clk=0`.
- `drivecpu_reset` (194-211): `clk_ptr=0; drivecpu_reset_clk;
  interrupt_cpu_status_reset; interrupt_trigger_reset(clk_ptr)`.

TS `softReset(pc)` (`:1022-1033`):
- `bus.via1.reset() + bus.via2.reset()` — clears VIAs (= viacore_reset)
- `cpu.reset(pc)` — interrupt status reset + jump to PC vector
- `lastClk = 0; cycleAccum = 0; sleeping = false`

| VICE step | TS step | Verdict |
|---|---|---|
| `clk_ptr = 0` | `cpu.reset` sets cycles=0 | MATCH |
| `last_clk = maincpu_clk` | `lastClk = 0` | DEVIATION — VICE pegs to maincpu_clk so next executeToClock delta is from-now; TS pegs to 0 so first executeToClock(c64Clk) sees delta=c64Clk. In integrated session this is fine because softReset is called at session start (c64 cycles=0). For mid-run softReset, would over-run drive once. Documented, not currently load-bearing. |
| `last_exc_cycles = 0` | Phase 2b: implicit (field starts 0; updated by inner loop) | MATCH-IMPLICIT |
| `stop_clk = 0` | Phase 2b: implicit (field starts 0; updated at executeToClock entry) | MATCH-IMPLICIT |
| `interrupt_cpu_status_reset` | `cpu.reset(pc)` clears intStatus | MATCH-WRAPPER |
| `interrupt_trigger_reset` | `cpu.reset(pc)` jumps to PC directly (or $FFFC if pc undefined) | DEVIATION (sync vs async — see B.2) |
| (none) | `cycleAccum = 0` | TS-EXTRA — VICE preserves cycle_accum across reset; documented MINOR. |

### E.3 `drivecpu_jam` (VICE:462-539)

VICE body: prints message, calls `drive_jam()` for user prompt, then
dispatches one of: JAM_RESET_CPU (reg_pc=0xeaa0 + machine reset),
JAM_POWER_CYCLE, JAM_MONITOR (monitor startup), or default (CLK++ stall).

TS: no JAM dispatcher. `is_jammed` field added for snapshot compat.

**Verdict: OMIT-OK** — stock 1541 DOS code never executes JAM opcodes
($02/$12/$22/$32/$42/$52/$62/$72/$92/$B2/$D2/$F2). If a future spec
needs JAM dispatcher: hook into `Cpu65xxVice.executeCycle` at opcode
decode + set `is_jammed = 1` + stall (= VICE default branch CLK++).

## F. Summary

Phase 1 mapping: 20 struct rows + 17 function rows = 37 rows.
Phase 1b expanded: 4 ticketed items resolved (B.1-B.5 sub-row matrices).
Phase 2a bundled cleanups: 3 of 4 actioned (disable, LED, storePcr=already-MATCH);
shutdown OMIT-OK.
Phase 2b deep-dive: stop_clk + last_exc_cycles + is_jammed PORTED;
drive_cpu_execute and drivecpu_reset audited line-by-line.

| Verdict | Count |
|---|---|
| MATCH / MATCH-WRAPPER / PORTED | 22 |
| MATCH-DEVIATION (constructor pattern + struct shape) | 6 |
| DEVIATION-DOCUMENTED (sync vs async reset, lastClk peg) | 3 |
| MINOR-DEVIATION (wake_up stale-skip, cycle_accum reset, JAM dispatcher) | 3 |
| OMIT-OK (monitor, DMA, banking, debug, identification, JAM, shutdown) | 9 |
| DEFER → Spec 451 (snapshot R/W, snap_module_name) | 3 |
| BUG / load-bearing MISSING | **0** |

Tests:
- Existing VIA suite 91/91 PASS (no regression)
- New `tests/unit/drive/drivecpu-conformance.test.ts` 6/6 PASS
  (stop_clk + last_exc_cycles + is_jammed + softReset roundtrip)
- Drive suite total: rotation 15/15 + gcr-shifter 13/13 +
  drivecpu-conformance 6/6 = 34/34
- Canary 5/5 PASS (post-Phase-2b)

No load-bearing BUG / MISSING.