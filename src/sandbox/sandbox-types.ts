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

// ── The harvest is authoritative about what the RUN wrote (issue #17) ───────
//
// A sandbox harvest used to be a contiguous RAM window and nothing else. The
// bytes the routine never wrote came back as whatever the machine happened to
// hold there — power-on RAM pattern, a KERNAL RAM-test leftover, screen RAM,
// or bytes the CALLER loaded — and that is indistinguishable from real payload.
// A multi-block depacker writes DISJOINT runs, so the gaps between them are
// exactly where it bites.
//
// The rule the GCR decoder already learned: tolerant does not mean inventing.
// An unreadable thing yields NO bytes rather than plausible ones. So:
//
//   * `WrittenRun` is the authoritative unit — a contiguous stretch the run
//     itself stored to, plus the bytes it left there. Nothing else is payload.
//   * A window a caller asks for is a `MemoryWindow`: `bytes[i]` is a number
//     where the run wrote and `null` where it did not. `null` is not a byte —
//     $00..$ff is the whole domain — so a gap cannot be mistaken for data by a
//     formatter, a comparison, or a JSON consumer. The raw window survives
//     under the name `observed`, which a caller has to type on purpose.

/** A contiguous stretch of addresses the run STORED to, and the bytes it left. */
export interface WrittenRun {
  lo: number;
  hi: number;
  /** `hi - lo + 1` bytes, all of them written by this run. */
  bytes: number[];
}

/** A window the caller asked to see, with the un-written bytes marked. */
export interface MemoryWindow {
  start: number;
  end: number;
  /**
   * The written-only view: a byte where THIS run stored one, `null` where it
   * never did. Never gap-filled — a gap is a hole, not a zero.
   */
  bytes: (number | null)[];
  /**
   * The raw window as the sandbox held it at stop. Whatever is not covered by
   * `writtenRuns` here is machine residue or caller-loaded input, NOT output of
   * the run. Named so that reading it is a decision.
   */
  observed: number[];
  /** How many of `bytes` are `null` (i.e. how much of this window is not payload). */
  unwritten: number;
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
  // THE authoritative answer to "what did this run produce": every contiguous
  // run of addresses it stored to, in address order, with their bytes. Disjoint
  // runs stay disjoint — the space between two runs is not in this list, and
  // nothing fills it. Clipped to returnWritesRange when the caller set one.
  writtenRuns: WrittenRun[];
  // Smallest contiguous span covering all writtenMap addresses, or null. The
  // span is a convenience over `writtenRuns`, so its holes are `null` — it does
  // NOT gap-fill with zeroes (that was invented data) and never with residue.
  writtenSpan: { start: number; end: number; bytes: (number | null)[] } | null;
  // Optional snapshot of explicitly requested memory ranges. Each carries the
  // written-only view AND the raw window — see MemoryWindow. The written mask
  // is the run's FULL write set, never narrowed by returnWritesRange: whether
  // the CPU stored to an address is a fact about the run, not about the
  // caller's writes filter.
  memorySnapshots: MemoryWindow[];
  streamPos: number;
  // Never set by the real core (full ISA); retained for contract completeness.
  unimplementedOpcode?: { pc: number; opcode: number };
}
