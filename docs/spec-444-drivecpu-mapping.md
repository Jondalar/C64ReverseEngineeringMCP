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
| `drivecpu_setup_context` | 70-164 | DriveCpu constructor + DriveBus constructor | MATCH-DEVIATION (constructor pattern) |
| `cpu_reset` (static) | 165-184 | DriveCpu `reset()` (`:562` DriveBus + `:995` DriveCpu) | needs row check |
| `drivecpu_reset_clk` | 186-192 | — | needs row check (alarm-context clock reset) |
| `drivecpu_reset` | 194-212 | DriveCpu `reset()` | needs row check |
| `drivecpu_trigger_reset` | 214-217 | — | MISSING — needs port (reset request from outside) |
| `drivecpu_set_overflow` | 219-223 | `fireByteReady` (`:849-861`) | MATCH-DEVIATION (V flag set on cpu.regs.p) |
| `drivecpu_shutdown` | 225-247 | — | MISSING — bundled w/ viacore_shutdown |
| `drivecpu_init` | 249-290 | DriveCpu constructor body | MATCH-DEVIATION |
| `drive_generic_dma` (static) | 292-354 | — | OMIT-OK (DMA not in V1 1541) |
| `drivecpu_execute` | 356-448 | `Cpu6510Cycled.executeCycle` / `DriveCpuCycled.executeCycle` (cycle-wrappers.ts) | needs row check (alarm dispatch + step model differs) |
| `drivecpu_set_bank_base` (static) | 450-460 | TS uses readTab/storeTab dispatch | OMIT-OK |
| `drivecpu_jam` (static) | 462-566 | needs row check | needs row check |
| `drivecpu_snapshot_write_module` | 568-640 | needs row check | needs row check |
| `drivecpu_snapshot_read_module` | 642-end | needs row check | needs row check |
| `drivecpu_sleep` | (in .h:49) | — | MISSING — needs port |
| `drivecpu_wake_up` | (in .h:50) | `wakeUp(): void { this.sleeping = false; }` (`:747`) | MATCH (TS has wake-up, missing sleep counterpart) |
| `drivecpu_prevent_clk_overflow` | not in .c (in alarm or sysfile?) | — | OMIT-OK (long-session clock wrap; not load-bearing for V1 short runs) |

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