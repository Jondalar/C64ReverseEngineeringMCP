// Shared sandbox type contract.
//
// Spec 788 tail, piece C (2026-07-15): these type declarations formerly lived
// in the flat-64K TS `Cpu6502` shadow (`cpu6502.ts`) and its driver
// (`sandbox-runner.ts`). Both were deleted when the sandbox tools were rerouted
// onto the TRX64 real 6502 core. The types survive here because the real-core
// engine (`sandbox-runner-realcore.ts`) and the `sandbox_6502_run` tool keep the
// SAME options-in / result-out contract — the ENGINE changed, the shape did not.

export interface SandboxCpuState {
  pc: number;
  a: number;
  x: number;
  y: number;
  sp: number;
  flags: number;
  cycles: number;
}

export interface CpuWrite {
  address: number;
  value: number;
}

export type StopReason =
  | "stop_pc"
  | "sentinel_rts"
  | "max_steps"
  | "brk"
  | "jam"
  | "stream_exhausted"
  | "unimplemented_opcode";

// Mapping mode for a single load:
//   - "ram"     (default): writable RAM.
//   - "ef_roml" / "ef_romh": map this load's bytes as a read-only ROM overlay
//     at the given address (reads return the ROM byte; writes pass through to a
//     parallel RAM array under the window). Models the EasyFlash split.
//   - "rom":  generic read-only overlay (same effect, no cart connotation).
// The real-core engine currently reproduces only "ram"; the other mappings are
// retained in the contract (the tool schema still accepts them) and rejected
// with an actionable error at run time.
export type LoadMapping = "ram" | "rom" | "ef_roml" | "ef_romh";

export interface MemBlock {
  // Hex byte sequence; loaded at `address`. Use this for inline patches.
  bytes: number[] | Uint8Array;
  address: number;
  mapping?: LoadMapping;
}

export interface PrgBlock {
  // Path to a PRG file. First two bytes are the load address.
  prgPath: string;
  // Optional override of the PRG load address (rarely needed).
  loadAddressOverride?: number;
  mapping?: LoadMapping;
}

export interface RawBlock {
  // Path to a raw blob loaded at `address`.
  rawPath: string;
  address: number;
  mapping?: LoadMapping;
}

export type SandboxLoad = MemBlock | PrgBlock | RawBlock;

export interface SandboxRunOptions {
  loads: SandboxLoad[];
  initialPc: number;
  initialZp?: Record<number, number>;
  initialSp?: number;        // default 0xfd, sentinel pre-staged on stack
  initialA?: number;
  initialX?: number;
  initialY?: number;
  initialFlags?: number;
  inputStream?: number[] | Uint8Array;
  streamHookPcs?: number[];
  stopPc?: number;
  maxSteps?: number;         // default 10_000_000
  // Restrict the returned writes to this range (inclusive).
  returnWritesRange?: { start: number; end: number };
  // If provided, returnedMemory will include a snapshot of these ranges.
  returnMemoryRanges?: { start: number; end: number }[];
}

export interface SandboxRunResult {
  stopReason: StopReason | "stop_pc";
  steps: number;
  finalState: SandboxCpuState;
  // Writes filtered by returnWritesRange (or all writes if no range).
  writes: CpuWrite[];
  // Last write per address within range — convenient for "decoded output".
  writtenMap: Record<number, number>;
  // Smallest contiguous span covering all writtenMap addresses, or null.
  writtenSpan: { start: number; end: number; bytes: number[] } | null;
  // Optional snapshot of explicitly requested memory ranges.
  memorySnapshots: Array<{ start: number; end: number; bytes: number[] }>;
  streamPos: number;
  // Never set by the real core (full ISA); retained for contract completeness.
  unimplementedOpcode?: { pc: number; opcode: number };
}
