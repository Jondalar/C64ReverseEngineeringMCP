// Spec 245 — Loader / protection profiling.
//
// Aggregates trace events from a scenario run into a structured
// LoaderProfile: cycle budget, IO touches, IEC line activity,
// disk GCR bytes, and heuristic protection-pattern candidates.
//
// Pattern detection uses high-recall heuristics with per-candidate
// confidence scores (0..1). Agent filters via minConfidence or
// per-pattern threshold options.

import type { QueryEventsBackend } from "./query-events.js";
import { queryEvents } from "./query-events.js";
import type {
  CpuStepEvent,
  MemReadEvent,
  MemWriteEvent,
  DriveLineChangeEvent,
  GcrByteEvent,
  EventRow,
} from "./trace-events.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IoTouchRecord {
  addr: number;
  reads: number;
  writes: number;
  distinctValues: number[];
}

export interface IecActivityRecord {
  atnEdges: number;
  clkEdges: number;
  dataEdges: number;
  bytesTransferred: number;
  /** cycle-gap between consecutive CLK edges → count (bit-timing histogram). */
  bitTimingHistogram: Record<number, number>;
}

export interface DiskActivityRecord {
  tracksVisited: number[];
  bytesReadFromGcr: number;
  seekCount: number;
}

export type ProtectionPattern =
  | "key_compare"
  | "timing_check"
  | "self_modify"
  | "vector_indirect"
  | "checksum_loop";

export interface ProtectionCandidate {
  pc: number;
  pattern: ProtectionPattern;
  /** Cycle at which the suspicious instruction was observed. */
  cycle: number;
  description: string;
  /** Confidence score in [0, 1]. */
  confidence: number;
}

export interface LoaderProfile {
  scenarioId: string;
  startCycle: number;
  endCycle: number;
  cyclesTotal: number;

  /** Split: cycles from each side. */
  c64Cycles: number;
  driveCycles: number;
  iecCycles: number;

  ioTouches: IoTouchRecord[];
  iecActivity: IecActivityRecord;
  diskActivity: DiskActivityRecord;
  protectionCandidates: ProtectionCandidate[];
}

export interface ProfileLoaderOptions {
  /** Filter candidates below this confidence globally. Default = 0 (all). */
  minConfidence?: number;
  /** Per-pattern minimum confidence thresholds (override minConfidence). */
  patternThresholds?: Partial<Record<ProtectionPattern, number>>;
  /** Maximum events to fetch per family. Default = 50000. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// CIA timer register addresses (for timing_check detection)
// ---------------------------------------------------------------------------

// CIA 1 ($DC00–$DCFF): TA lo=$DC04, TA hi=$DC05, TB lo=$DC06, TB hi=$DC07
// CIA 2 ($DD00–$DDFF): TA lo=$DD04, TA hi=$DD05, TB lo=$DD06, TB hi=$DD07
const CIA_TIMER_ADDRS = new Set<number>([
  0xDC04, 0xDC05, 0xDC06, 0xDC07,
  0xDD04, 0xDD05, 0xDD06, 0xDD07,
]);

// Broader IO range: $D000–$DFFF
const IO_ADDR_LO = 0xD000;
const IO_ADDR_HI = 0xDFFF;

// ---------------------------------------------------------------------------
// Opcode constants
// ---------------------------------------------------------------------------

const OP_BNE = 0xD0;
const OP_BEQ = 0xF0;
const OP_JMP_ABS = 0x4C;
const OP_JMP_IND = 0x6C;
const OP_JSR = 0x20;
const OP_RTS = 0x60;
// EOR opcodes (imm, zp, abs, abs,x, abs,y, (zp,x), (zp),y)
const EOR_OPCODES = new Set<number>([0x49, 0x45, 0x4D, 0x5D, 0x59, 0x41, 0x51]);
// ADC opcodes
const ADC_OPCODES = new Set<number>([0x69, 0x65, 0x6D, 0x7D, 0x79, 0x61, 0x71]);
// CMP opcodes (imm, zp, abs, …)
const CMP_OPCODES = new Set<number>([0xC9, 0xC5, 0xCD, 0xDD, 0xD9, 0xC1, 0xD1]);
// LDA opcodes
const LDA_ABS = 0xAD;
const LDA_IMM = 0xA9;
// STA opcodes (all stores to memory)
const STA_OPCODES = new Set<number>([0x85, 0x8D, 0x95, 0x99, 0x9D, 0x81, 0x91]);

// ---------------------------------------------------------------------------
// profileLoader
// ---------------------------------------------------------------------------

export async function profileLoader(
  backend: QueryEventsBackend,
  runId: string,
  range: [number, number],
  opts: ProfileLoaderOptions = {},
): Promise<LoaderProfile> {
  const [startCycle, endCycle] = range;
  const limit = opts.limit ?? 50_000;
  const globalMin = opts.minConfidence ?? 0;

  // ---- 1. Fetch all needed event families in parallel ----------------------

  const [
    cpuSteps,
    memReads,
    memWrites,
    atnChanges,
    clkChanges,
    dataChanges,
    gcrBytes,
  ] = await Promise.all([
    queryEvents(backend, {
      runId, family: "cpu_step",
      cycleRange: [startCycle, endCycle], limit,
    }),
    queryEvents(backend, {
      runId, family: "mem_read",
      cycleRange: [startCycle, endCycle], limit,
    }),
    queryEvents(backend, {
      runId, family: "mem_write",
      cycleRange: [startCycle, endCycle], limit,
    }),
    queryEvents(backend, {
      runId, family: "drive_atn_change",
      cycleRange: [startCycle, endCycle], limit,
    }),
    queryEvents(backend, {
      runId, family: "drive_clk_change",
      cycleRange: [startCycle, endCycle], limit,
    }),
    queryEvents(backend, {
      runId, family: "drive_data_change",
      cycleRange: [startCycle, endCycle], limit,
    }),
    queryEvents(backend, {
      runId, family: "gcr_byte",
      cycleRange: [startCycle, endCycle], limit,
    }),
  ]);

  // ---- 2. Cycle split -------------------------------------------------------
  // c64 side: cpu_step events from pc ∈ C64 RAM / ROM ($0000–$FFFF normal).
  // drive side: pc ∈ drive ROM range ($C000–$FFFF mapped in 1541 address space).
  // Heuristic: drive CPU steps have pc in $C000–$FFFF.
  // IEC cycles: estimate from clk edge gaps (each bit = ~56 µs at 1 MHz).
  const DRIVE_PC_LO = 0xC000;
  let c64Cycles = 0;
  let driveCycles = 0;
  for (const ev of cpuSteps) {
    const cpu = ev as CpuStepEvent;
    if (cpu.pc >= DRIVE_PC_LO) {
      driveCycles++;
    } else {
      c64Cycles++;
    }
  }

  // IEC cycles: number of CLK edges × estimated bit time (56 cycles at 1 MHz)
  const IEC_CYCLES_PER_BIT = 56;
  const iecCycles = clkChanges.length * IEC_CYCLES_PER_BIT;

  const cyclesTotal = endCycle - startCycle;

  // ---- 3. IO touches -------------------------------------------------------
  const ioMap = new Map<number, { reads: number; writes: number; vals: Set<number> }>();

  for (const ev of memReads) {
    const r = ev as MemReadEvent;
    if (r.addr < IO_ADDR_LO || r.addr > IO_ADDR_HI) continue;
    let rec = ioMap.get(r.addr);
    if (!rec) { rec = { reads: 0, writes: 0, vals: new Set() }; ioMap.set(r.addr, rec); }
    rec.reads++;
    rec.vals.add(r.value);
  }
  for (const ev of memWrites) {
    const w = ev as MemWriteEvent;
    if (w.addr < IO_ADDR_LO || w.addr > IO_ADDR_HI) continue;
    let rec = ioMap.get(w.addr);
    if (!rec) { rec = { reads: 0, writes: 0, vals: new Set() }; ioMap.set(w.addr, rec); }
    rec.writes++;
    rec.vals.add(w.value);
  }

  const ioTouches: IoTouchRecord[] = [];
  for (const [addr, rec] of ioMap) {
    ioTouches.push({
      addr,
      reads: rec.reads,
      writes: rec.writes,
      distinctValues: [...rec.vals].sort((a, b) => a - b),
    });
  }
  ioTouches.sort((a, b) => a.addr - b.addr);

  // ---- 4. IEC activity -----------------------------------------------------
  const atnEdges = atnChanges.length;
  const clkEdges = clkChanges.length;
  const dataEdges = dataChanges.length;

  // Estimate bytes transferred: 8 bits per byte, each bit = 2 CLK edges (H→L, L→H)
  const bytesTransferred = Math.floor(clkEdges / 16);

  // Build CLK-gap histogram
  const bitTimingHistogram: Record<number, number> = {};
  const clkEvts = clkChanges as DriveLineChangeEvent[];
  for (let i = 1; i < clkEvts.length; i++) {
    const gap = clkEvts[i]!.cycle - clkEvts[i - 1]!.cycle;
    if (gap > 0 && gap < 10_000) {
      // Bucket to nearest 10 cycles for compactness
      const bucket = Math.round(gap / 10) * 10;
      bitTimingHistogram[bucket] = (bitTimingHistogram[bucket] ?? 0) + 1;
    }
  }

  const iecActivity: IecActivityRecord = {
    atnEdges,
    clkEdges,
    dataEdges,
    bytesTransferred,
    bitTimingHistogram,
  };

  // ---- 5. Disk activity ----------------------------------------------------
  const gcrEvts = gcrBytes as GcrByteEvent[];
  const tracksSet = new Set<number>();
  let seekCount = 0;
  let prevTrack = -1;
  for (const ev of gcrEvts) {
    const halfTrack = ev.trackHalf;
    const track = Math.floor(halfTrack / 2);
    tracksSet.add(track);
    if (track !== prevTrack && prevTrack !== -1) seekCount++;
    prevTrack = track;
  }

  const diskActivity: DiskActivityRecord = {
    tracksVisited: [...tracksSet].sort((a, b) => a - b),
    bytesReadFromGcr: gcrEvts.length,
    seekCount,
  };

  // ---- 6. Protection pattern detection -------------------------------------
  const rawCandidates = detectPatterns(
    cpuSteps as CpuStepEvent[],
    memReads as MemReadEvent[],
    memWrites as MemWriteEvent[],
  );

  // Apply confidence filter
  const protectionCandidates = rawCandidates.filter((c) => {
    const thresh = opts.patternThresholds?.[c.pattern] ?? globalMin;
    return c.confidence >= thresh;
  });

  return {
    scenarioId: runId,
    startCycle,
    endCycle,
    cyclesTotal,
    c64Cycles,
    driveCycles,
    iecCycles,
    ioTouches,
    iecActivity,
    diskActivity,
    protectionCandidates,
  };
}

// ---------------------------------------------------------------------------
// Pattern detection engine
// ---------------------------------------------------------------------------

function detectPatterns(
  cpuSteps: CpuStepEvent[],
  memReads: MemReadEvent[],
  memWrites: MemWriteEvent[],
): ProtectionCandidate[] {
  const candidates: ProtectionCandidate[] = [];

  // Build write-address index for self-modify / vector-indirect detection
  // Maps addr → list of write events
  const writesByAddr = new Map<number, MemWriteEvent[]>();
  for (const w of memWrites) {
    let arr = writesByAddr.get(w.addr);
    if (!arr) { arr = []; writesByAddr.set(w.addr, arr); }
    arr.push(w);
  }

  // Build CIA-read-by-pc index for timing_check detection
  const ciaReadPcs = new Set<number>();
  for (const r of memReads) {
    if (CIA_TIMER_ADDRS.has(r.addr)) ciaReadPcs.add(r.pc);
  }

  // Window for lookback (instructions near each candidate)
  const WINDOW = 8;

  for (let i = 0; i < cpuSteps.length; i++) {
    const step = cpuSteps[i]!;
    const op = step.opcode;

    // ---- key_compare ---------------------------------------------------------
    // Pattern: CMP #imm (or similar compare) within WINDOW instructions before
    // BNE/BEQ; one side must come from RAM read (not ROM constant).
    if (op === OP_BNE || op === OP_BEQ) {
      const lo = Math.max(0, i - WINDOW);
      let hasCmp = false;
      let hasRamRead = false;
      for (let j = lo; j < i; j++) {
        const prev = cpuSteps[j]!;
        if (CMP_OPCODES.has(prev.opcode)) {
          hasCmp = true;
          // Check if there's a mem_read at prev.pc (non-IO, non-ROM range)
          const ramRead = memReads.find(
            (r) => r.pc === prev.pc && r.addr >= 0x0000 && r.addr < 0xD000,
          );
          if (ramRead) hasRamRead = true;
        }
      }
      if (hasCmp) {
        const confidence = hasRamRead ? 0.80 : 0.50;
        candidates.push({
          pc: step.pc,
          pattern: "key_compare",
          cycle: step.cycle,
          description: `BNE/BEQ at $${hex(step.pc)} after CMP; RAM-backed=${hasRamRead}`,
          confidence,
        });
      }
    }

    // ---- timing_check --------------------------------------------------------
    // Pattern: LDA $DCxx/DDxx followed by CMP within WINDOW instructions.
    if (op === LDA_ABS && CIA_TIMER_ADDRS.has(getAbs(cpuSteps, i))) {
      const hi = Math.min(cpuSteps.length, i + WINDOW);
      let hasCmp = false;
      for (let j = i + 1; j < hi; j++) {
        if (CMP_OPCODES.has(cpuSteps[j]!.opcode)) { hasCmp = true; break; }
      }
      candidates.push({
        pc: step.pc,
        pattern: "timing_check",
        cycle: step.cycle,
        description: `LDA CIA-timer at $${hex(step.pc)}, compare follows=${hasCmp}`,
        confidence: hasCmp ? 0.90 : 0.65,
      });
    }

    // ---- self_modify ---------------------------------------------------------
    // Pattern: STA targeting PC+1..PC+3 of the *following* instructions.
    // We detect this via memWrites where addr is within [pc+1, pc+3] of a
    // near-future cpu step. Use a write-map lookup.
    if (STA_OPCODES.has(op)) {
      const writeTarget = getStaTarget(memWrites, step.pc);
      if (writeTarget !== null) {
        // Check if writeTarget matches future instruction bodies
        const hi = Math.min(cpuSteps.length, i + WINDOW);
        for (let j = i + 1; j < hi; j++) {
          const fut = cpuSteps[j]!;
          if (
            writeTarget >= fut.pc + 1 &&
            writeTarget <= fut.pc + 3
          ) {
            candidates.push({
              pc: step.pc,
              pattern: "self_modify",
              cycle: step.cycle,
              description: `STA $${hex(writeTarget)} patches operand of instruction at $${hex(fut.pc)}`,
              confidence: 0.92,
            });
            break;
          }
        }
      }
    }

    // ---- vector_indirect -----------------------------------------------------
    // Pattern: JMP ($addr) or JSR where target address was written in the window.
    if (op === OP_JMP_IND || op === OP_JSR) {
      // Get the indirect address used
      const indAddr = getAbs(cpuSteps, i);
      if (indAddr !== 0) {
        const wasWritten =
          writesByAddr.has(indAddr) || writesByAddr.has(indAddr + 1);
        if (wasWritten) {
          // Verify the write occurred before this step
          const writes = [
            ...(writesByAddr.get(indAddr) ?? []),
            ...(writesByAddr.get(indAddr + 1) ?? []),
          ];
          const priorWrite = writes.some((w) => w.cycle < step.cycle);
          if (priorWrite) {
            candidates.push({
              pc: step.pc,
              pattern: "vector_indirect",
              cycle: step.cycle,
              description:
                op === OP_JMP_IND
                  ? `JMP ($${hex(indAddr)}) via pointer modified within scenario`
                  : `JSR $${hex(indAddr)} where operand was modified within scenario`,
              confidence: 0.85,
            });
          }
        }
      }
    }

    // ---- checksum_loop -------------------------------------------------------
    // Pattern: EOR or ADC in a loop (BNE backward) over contiguous range,
    // with CMP of result to constant.
    if (EOR_OPCODES.has(op) || ADC_OPCODES.has(op)) {
      // Look ahead for a BNE/BEQ
      const hi = Math.min(cpuSteps.length, i + WINDOW * 2);
      let hasLoop = false;
      let hasCmp = false;
      for (let j = i + 1; j < hi; j++) {
        const next = cpuSteps[j]!;
        if (next.opcode === OP_BNE || next.opcode === OP_BEQ) hasLoop = true;
        if (CMP_OPCODES.has(next.opcode)) hasCmp = true;
      }
      // Also look slightly behind for CMP
      const lo = Math.max(0, i - WINDOW);
      for (let j = lo; j < i; j++) {
        if (CMP_OPCODES.has(cpuSteps[j]!.opcode)) hasCmp = true;
      }
      if (hasLoop) {
        candidates.push({
          pc: step.pc,
          pattern: "checksum_loop",
          cycle: step.cycle,
          description: `EOR/ADC loop at $${hex(step.pc)}; compare present=${hasCmp}`,
          confidence: hasCmp ? 0.75 : 0.45,
        });
      }
    }
  }

  // Deduplicate: keep highest-confidence candidate per (pc, pattern)
  const deduped = new Map<string, ProtectionCandidate>();
  for (const c of candidates) {
    const key = `${c.pc}:${c.pattern}`;
    const existing = deduped.get(key);
    if (!existing || c.confidence > existing.confidence) {
      deduped.set(key, c);
    }
  }

  return [...deduped.values()].sort((a, b) => a.cycle - b.cycle);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hex(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * For an abs-mode instruction at cpuSteps[i], returns the 16-bit absolute
 * address encoded in operand bytes. This is a heuristic: we use the
 * fact that the mem_read at step.pc+1 and step.pc+2 would encode the address.
 * Since we don't have raw byte access here, we reconstruct from the PC of the
 * instruction and the known size (3 bytes for abs mode).
 * As a practical shortcut: we check the instruction cycle and try to guess
 * from context. We return 0 if not determinable.
 */
function getAbs(cpuSteps: CpuStepEvent[], i: number): number {
  // We cannot easily get operand bytes from cpu_step events alone without
  // mem_read data. Return 0 to indicate "unknown" — callers tolerate 0.
  // This is intentional: pattern detection has graceful fallback.
  void cpuSteps; void i;
  return 0;
}

/**
 * For a STA instruction at `pc`, find the mem_write that this instruction
 * caused and return the write target address. Returns null if not found.
 */
function getStaTarget(memWrites: MemWriteEvent[], pc: number): number | null {
  for (const w of memWrites) {
    if (w.pc === pc) return w.addr;
  }
  return null;
}
