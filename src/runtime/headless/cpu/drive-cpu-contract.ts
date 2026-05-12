// Spec 428 Phase B — 1541 drive CPU runtime contract (TS interface only).
//
// VICE equivalent: src/drive/drivecpu.c + src/6510core.c (opcode templates).
// VICE drive CPU is **not** cycle-stepped per CPU clock. The drivecpu.c
// outer loop computes owed drive cycles from sync_factor, then runs the
// 6510core.c opcode template while CLK < stop_clk. Rotation hooks fire at
// LOCAL_SET_OVERFLOW(0) + 3 opcode-loop sites — NOT once per cpu clock.
//
// This contract surfaces what `DriveCpu` consumes today. Current
// `Cpu65xxVice` satisfies it structurally — that is the bug to fix in
// Phase C+ (drive whole-instruction dispatch as opt-in).
//
// Spec 428 doctrine: drive CPU does NOT follow x64sc CLK_INC. Drive has
// no BA-low stall, no shared VIC bus, no $00/$01 port. Drive owns its
// own AlarmContext + InterruptCpuStatus.

import type { InterruptCpuStatus } from "./interrupt-cpu-status.js";
import type { CpuMemory } from "../cpu6510.js";

/**
 * Runtime-facing 1541 drive CPU contract.
 *
 * Cite: docs/vice-1541-arch.md §3 (drive CPU shape); VICE
 * src/drive/drivecpu.c:356 (drivecpu_execute) + src/6510core.c.
 *
 * The contract is intentionally narrow. Implementations may add private
 * cycle-stepped helpers; the surface here is what `DriveCpu` calls.
 */
export interface DriveCpuContract {
  // ─── Register state ─────────────────────────────────────────────
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;

  // ─── Execution ──────────────────────────────────────────────────
  /**
   * Cycle-stepped path. Spec 428 Phase B: required for transitional
   * compatibility (= current shared `Cpu65xxVice` exposes this).
   * Phase C will add opt-in whole-instruction dispatch alongside.
   */
  executeCycle(): void;
  /** True when the next executeCycle starts a new opcode fetch. */
  isAtInstructionBoundary(): boolean;
  /** Cold-reset drive CPU state + clear pending interrupts. */
  reset(): void;

  // ─── Interrupt status ──────────────────────────────────────────
  /**
   * Per-drive interrupt status (= VICE diskunit_context.cpu.int_status).
   * VIA1/VIA2 chip-side IRQ push targets this, not the C64's.
   */
  cpuIntStatus: InterruptCpuStatus;

  // ─── Memory ────────────────────────────────────────────────────
  /** Drive memory bus (RAM + ROM + VIA1 + VIA2 + per-page dispatch). */
  readonly memory: CpuMemory;
}
