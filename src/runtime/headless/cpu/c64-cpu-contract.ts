// Spec 428 Phase B — C64 main CPU runtime contract (TS interface only).
//
// VICE equivalent: src/c64/c64cpusc.c + src/mainc64cpu.c. The C64 main CPU
// owns the x64sc CLK_INC cycle-stepped execution model:
//   - alarm-drain → bumpDelays → clk++ → clear BA-low → vicii_cycle()
//   - VIC-II BA-low read-stall (vicii_steal_cycles)
//   - 6510 $00/$01 I/O port
//   - shared InterruptCpuStatus (CIA1 IRQ → C64 IRQ; CIA2 IRQ → C64 NMI)
//
// This file declares only the runtime surface that IntegratedSession +
// kernel touch. It does NOT prescribe implementation. Current
// `Cpu65xxVice` satisfies it structurally.
//
// Spec 428 doctrine: C64 CPU stays cycle-stepped (= 1:1 VICE x64sc).
// Drive CPU contract is separate (= see drive-cpu-contract.ts).

import type { InterruptCpuStatus } from "./interrupt-cpu-status.js";
import type { IoPort6510Hook } from "./io-port-6510.js";
import type { CpuMemory } from "../cpu6510.js";

/**
 * Runtime-facing C64 main CPU contract.
 *
 * Cite: docs/vice-c64-arch.md §11 (tick order), §13 invariants 1, 4, 12.
 * VICE: src/c64/c64cpusc.c:47 (CLK_INC), src/mainc64cpu.c:97-208.
 */
export interface C64MainCpuContract {
  // ─── Register state ─────────────────────────────────────────────
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;

  // ─── Execution ──────────────────────────────────────────────────
  /** Run one CPU clock (= one VICE CLK_INC tick). */
  executeCycle(): void;
  /** True when the next CLK_INC will start a new opcode fetch. */
  isAtInstructionBoundary(): boolean;
  /** Cold-reset CPU state + clear pending interrupts. */
  reset(): void;

  // ─── Interrupt + bus state ──────────────────────────────────────
  /** Shared per-machine interrupt status (VICE maincpu_int_status). */
  cpuIntStatus: InterruptCpuStatus;
  /** BA-low bitfield (= VICE maincpu_ba_low_flags, c64cpusc.c:45). */
  maincpu_ba_low_flags: number;
  /** Returns true iff VICE MAINCPU_BA_LOW_VICII bit is set. */
  baLowVicii(): boolean;

  // ─── Memory + I/O ───────────────────────────────────────────────
  /** Memory bus for CPU reads/writes. */
  readonly memory: CpuMemory;
  /** 6510 $00/$01 CPU port handler — C64-specific (drive has none). */
  readonly ioPortHook?: IoPort6510Hook;
}
