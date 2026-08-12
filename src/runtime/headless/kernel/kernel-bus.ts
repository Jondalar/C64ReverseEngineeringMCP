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
// Spec 200 — KernelBus + BusAccessContext shapes.
//
// Spec 201 wires the C64 $DD00 and drive $1800 access paths through
// these entry points. Until then this file only declares the contract.

export type BusAccessKind =
  | "read"
  | "write"
  | "rmw"
  | "dummy-read"
  | "dummy-write";

export type BusAccessSide = "c64" | "drive";

export type CpuPhase = "phi1" | "phi2";

export interface BusAccessContext {
  side: BusAccessSide;
  device?: number;
  clock: number;
  pc: number;
  opcode: number;
  phase: CpuPhase;
  addr: number;
  access: BusAccessKind;
  /**
   * Spec 201-c2: optional DDR mask alongside `value` for ports that
   * carry both an output latch and a direction register (CIA PA/PB,
   * VIA PA/PB). For non-port writes this stays undefined and bus
   * implementations treat the byte as fully driven.
   */
  ddrMask?: number;
}

export interface KernelBus {
  c64Read(addr: number, ctx: BusAccessContext): number;
  c64Write(addr: number, value: number, ctx: BusAccessContext): void;
  driveRead(device: number, addr: number, ctx: BusAccessContext): number;
  driveWrite(
    device: number,
    addr: number,
    value: number,
    ctx: BusAccessContext,
  ): void;
}
