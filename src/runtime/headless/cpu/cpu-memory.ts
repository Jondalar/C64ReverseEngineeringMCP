// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
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
