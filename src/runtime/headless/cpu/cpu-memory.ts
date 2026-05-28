// Spec 723.4a — neutral CPU memory-bus interface.
//
// Moved out of cpu6510.ts (the legacy interpreter, slated for deletion in
// 723.4c) so the microcoded product CPU (cpu65xx-vice) and the CPU contracts
// do not depend on the legacy module for this type.

/** Minimal memory bus a 6502/6510 CPU core reads/writes through. */
export interface CpuMemory {
  read(address: number): number;
  write(address: number, value: number): void;
}
