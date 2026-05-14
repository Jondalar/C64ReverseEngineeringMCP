# Spec 444 — `drivecpu.c` true literal port + bundled cleanups

**Status:** DONE (2026-05-14 — 6 commits, mapping + bundled cleanups + struct port + 6 conformance tests)
**Priority:** HIGH
**Parent:** Epic 440
**Depends on:** Spec 441 (rotation), Spec 442 (viacore), Spec 443 (devices)
**Doctrine:** Claude-self literal audit. No subagents.

**Anchors:**
- `docs/vice-1541-arch.md` §13 (Drive CPU + IRQ + alarm)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.c` (737 LoC)
- `/Users/alex/Development/C64/Tools/vice/vice/src/drive/drivecpu.h`

## Klartext

Sprint 430 hat drivecpu-Felder umbenannt (math-equivalent) ohne literal
port. Sprint 113 hat einen microcoded 6502-core (`Cpu65xxVice`) hinzu-
gefügt, aber `drive-cpu.ts` ist immer noch ein hybrid aus VICE-Strukturen
+ TS-Eigenheiten. Spec 444 portiert `drivecpu.c` 1:1.

Zusätzlich bündelt Spec 444 die in Spec 442/443 ticketed-out cleanups:

| Ticketed item | Origin |
|---|---|
| `viacore_disable` + `enabled` flag + `disable()` method | Spec 442 |
| `viacore_shutdown` (alarms unset + module names free) | Spec 442 |
| `via2d.c reset led_status=1` mirror to shadowDrive | Spec 443 |
| `ViaBackend.storePcr` signature `void` tightening | Spec 442/443 |

## VICE source of truth

| File | LoC | Function family |
|---|---|---|
| `drive/drivecpu.c` | 737 | `drive_cpu_init`, `_shutdown`, `_reset`, `_reset_clk`, `_execute`, `_set_overflow`, `_trigger_reset`, `_setup_context`, `_sleep`, `_wake_up`, `_prevent_clk_overflow`, snapshot read/write, alarm hooks, watchpoint hooks |
| `drive/drivecpu.h` | – | `drivecpu_context_t` struct shape (clk_ptr, cpu_ptr, cycle_accum, stop_clk, last_clk, last_cpu_clk, alarm_context, monspace, etc.) |

## Headless target

`src/runtime/headless/drive/drive-cpu.ts` (1321 LoC). Includes:
- DriveCpu class wrapping Cpu6510 + Cpu65xxVice (legacy + microcoded)
- DriveBus (VIA1 + VIA2)
- Scheduler wiring (cycle-wrappers)
- Snapshot save/load
- IRQ line attachment (Spec 410 chip-side push)
- fireByteReady (V flag + onSoEdge consumer)
- ROM loader integration

Many of these are TS-only conveniences. Spec 444 audit determines what
maps 1:1 to drivecpu.c and what is TS-extra (wrapper/orchestration).

## Audit procedure (7-step)

1. **Mapping** — `docs/spec-444-drivecpu-mapping.md` row-per-function +
   row-per-struct-field (drivecpu_context_t).
2. **Port** — fix BUG / MISSING rows literally vs VICE.
3. **Purge** — remove TS-only methods that don't have drivecpu.c equiv
   (or mark `@internal` for wrapper-only).
4. **Proof** — `docs/spec-444-production-proof.md`.
5. **Tests** — `tests/unit/drive/drivecpu-conformance.test.ts`.
6. **No subagent verdicts.**
7. **No arch decisions without ask.**

## Scope

In scope (drivecpu.c primitives):
- `drivecpu_context_t` struct shape (literal field-mirror)
- `drive_cpu_init` / `drive_cpu_setup_context` (constructor analog)
- `drive_cpu_reset` (zero-state + IRQ clear)
- `drive_cpu_reset_clk` (alarm-context clock reset)
- `drive_cpu_execute` (main run loop — alarm dispatch + CPU step)
- `drive_cpu_set_overflow` (V flag set on byte-ready edge)
- `drive_cpu_trigger_reset` (reset request)
- `drive_cpu_sleep` / `drive_cpu_wake_up` (suspend semantics)
- `drive_cpu_prevent_clk_overflow` (clock wraparound)
- `stop_clk` field
- Snapshot write/read literal
- Watchpoint hooks (optional, mark MINOR if missing)

Bundled cleanups (from Spec 442/443):
- `viacore_disable` + `enabled` flag + `Via6522Vice.disable()`
- `viacore_shutdown` (alarm unset)
- `via2d.c reset led_status=1` mirror (low-priority MINOR)
- `ViaBackend.storePcr` signature tightening to `void`

Out of scope (other specs):
- gcr.c write-path (Spec 445)
- drivesync.c PAL/NTSC (Spec 446)
- memiec.c + driverom.c (Spec 447)
- alarm.c literal port (Spec 448)
- fdc.c (Spec 449)

## Acceptance

1. `docs/spec-444-drivecpu-mapping.md` row-per-function + struct-field
   verdict matrix.
2. Each BUG → fix patch.
3. Each MISSING → port-patch OR ticket-out reason.
4. drivecpu_context_t struct mirrored 1:1 in TS (literal field names).
5. Snapshot module name matches VICE for VSF compat (V1 best-effort;
   full cross-load = Spec 451).
6. `npm run canary:spec-430` 5/5 PASS.
7. `tests/unit/drive/drivecpu-conformance.test.ts` PASS (cite VICE
   lines for every assertion).
8. `docs/spec-444-production-proof.md` committed with final verdict.
9. Bundled cleanups applied (Via6522Vice.disable, ViaBackend.storePcr
   void, VIA2 reset LED mirror).
10. No subagent verdicts.

## Do Not

- Do not delegate audit to subagent.
- Do not change rotation hooks (Spec 441 owned).
- Do not change viacore semantics (Spec 442 closed) — only ADD
  `disable()` + `shutdown()` per VICE.
- Do not touch via1d1541 / via2d1541 device backends (Spec 443 closed)
  — only the storePcr signature.
- Do not start Spec 445 before 444 DONE.

## Workflow gates

7-step per [[feedback_1541_port_workflow]].
