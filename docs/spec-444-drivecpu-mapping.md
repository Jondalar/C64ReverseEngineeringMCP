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
| `CLOCK last_exc_cycles` | — | — | MISSING — needs row check |
| `CLOCK stop_clk` | — | — | **MISSING** — Spec 430 left out; key field for `drive_cpu_execute` early-exit |
| `CLOCK cycle_accum` | — | `cycleAccum = 0` (`:701`) | MATCH (semantic equivalent) |
| `uint8_t *d_bank_base` | NULL | — | OMIT-OK (TS uses readTab/storeTab dispatch instead of d_bank_*) |
| `unsigned int d_bank_start, d_bank_limit` | — | — | OMIT-OK (TS dispatch) |
| `unsigned int last_opcode_info` | — | — | MISSING (watchpoints, low-priority) |
| `unsigned int last_opcode_addr` | — | — | MISSING (watchpoints, low-priority) |
| `int is_jammed` | — | — | MISSING — needs row check (drivecpu_jam at line 462) |
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

## E. Summary

Phase 1 mapping: 20 struct rows + 17 function rows = **37 rows**.

Open deep-dive (Phase 2): 8 high-priority rows + 4 bundled cleanups.

Will commit in incremental phases per [[feedback_1541_port_workflow]]
7-step.