// Spec 249 — Runtime table discovery.
//
// analyzeRuntimeTables: consumes a flat list of mem_read / cpu_step trace
// events and applies the indexed-access heuristic described in the spec to
// discover data / jump / pointer tables that static analysis cannot see.
//
// Output:  DiscoveredTable[]  (written to <artifact>_runtime_tables.json
//          by the caller; this module is pure logic / no I/O).

import { SegmentKind } from "./types.js";

// ---- Public types -------------------------------------------------------

export interface DiscoveredTable {
  artifactId: string;
  range: [number, number];
  stride: number;
  entries: number;
  accessPattern: "indexed_read" | "indexed_write" | "indexed_jump";
  candidateKind: DiscoveredTableKind;
  sampleEntries: SampleEntry[];
  evidence: TableEvidence;
}

export type DiscoveredTableKind =
  | "jump_table"
  | "pointer_table"
  | "data_table"
  | "char_data"
  | "sprite_pointers"
  | "unknown";

export interface SampleEntry {
  idx: number;
  bytes: number[];
  resolved?: number;  // resolved address for pointer / jump entries
}

export interface TableEvidence {
  firstSeenCycle: number;
  accessCount: number;
  consumerPcs: number[];
}

// ---- Lightweight event shapes (subset of Spec 232 rows) ----------------

export interface MemReadEvent {
  cycle: number;
  pc: number;
  addr: number;
  value: number;
  y?: number;           // Y register at access time (optional, from cpu_step)
}

export interface CpuStepEvent {
  cycle: number;
  pc: number;
  opcode: number;
  y: number;
}

export interface TraceInput {
  memReads: MemReadEvent[];
  cpuSteps?: CpuStepEvent[];
}

// ---- Constants ----------------------------------------------------------

// Opcodes that use Y-indexed addressing (abs,Y or zp,Y)
// abs,Y: $19 $39 $59 $79 $99 $B9 $D9 $F9 $BE $39…
// zp,Y:  $B6 $96
// indirect,Y: $11 $31 $51 $71 $91 $B1 $D1 $F1
const Y_INDEXED_OPCODES = new Set<number>([
  0x11, 0x19, 0x31, 0x39, 0x51, 0x59, 0x71, 0x79,
  0x91, 0x99, 0xb1, 0xb6, 0xb9, 0xbe, 0xd1, 0xd9,
  0xf1, 0xf9,
  0x96,
]);

// JMP (ind) / JSR-table consumer opcodes
const JMP_IND_OPCODE = 0x6c;

// Minimum Y-range span to flag a table candidate
const MIN_Y_SPAN = 3;
// Minimum unique addresses accessed per cluster
const MIN_CLUSTER_ADDRS = 3;
// Maximum gap (in bytes) between consecutive accessed addresses to group
// into same cluster
const MAX_CLUSTER_GAP = 4;

// ---- Internal helpers ---------------------------------------------------

interface AccessRecord {
  addr: number;
  yValues: Set<number>;
  pcs: Set<number>;
  cycles: number[];
  values: number[];
}

function gcd(a: number, b: number): number {
  while (b) { const t = b; b = a % b; a = t; }
  return a;
}

function detectStride(sortedAddrs: number[]): number {
  if (sortedAddrs.length < 2) return 1;
  const deltas: number[] = [];
  for (let i = 1; i < sortedAddrs.length; i++) {
    deltas.push(sortedAddrs[i] - sortedAddrs[i - 1]);
  }
  // Compute GCD of all deltas — that's the stride
  let g = deltas[0];
  for (let i = 1; i < deltas.length; i++) g = gcd(g, deltas[i]);
  return Math.max(1, g);
}

function classifyTable(
  addrs: number[],
  stride: number,
  consumerPcs: number[],
  cpuSteps: Map<number, CpuStepEvent>,
): DiscoveredTableKind {
  // Check if any consumer PC executed JMP(ind) / is a known indirect-jump site
  for (const pc of consumerPcs) {
    const step = cpuSteps.get(pc);
    if (step?.opcode === JMP_IND_OPCODE) return "jump_table";
  }
  // stride-2 with ordered values that look like addresses → pointer_table
  if (stride === 2) return "pointer_table";
  // sprite pointer tables are typically 8 bytes at $07F8 or nearby
  const start = addrs[0];
  const len = addrs[addrs.length - 1] - start + stride;
  if (len <= 16 && stride === 1) return "sprite_pointers";
  // charset data: multiples of 8 bytes
  if (stride === 8 || (len > 256 && len % 8 === 0)) return "char_data";
  if (stride === 1) return "data_table";
  return "unknown";
}

// ---- Main exported function ---------------------------------------------

/**
 * Analyse a flat list of trace events and return discovered tables.
 *
 * @param artifactId  Artifact identifier (embedded in each DiscoveredTable).
 * @param trace       Lightweight event lists from the Spec 232 trace store.
 * @param imageBytes  Optional raw PRG/binary bytes for sample-entry extraction.
 * @param loadAddress Load address of the binary (default 0).
 */
export function analyzeRuntimeTables(
  artifactId: string,
  trace: TraceInput,
  imageBytes?: Uint8Array | Buffer,
  loadAddress = 0,
): DiscoveredTable[] {
  if (trace.memReads.length === 0) return [];

  // Build cpu_step map: pc → CpuStepEvent (latest occurrence)
  const cpuStepMap = new Map<number, CpuStepEvent>();
  for (const step of trace.cpuSteps ?? []) {
    cpuStepMap.set(step.pc, step);
  }

  // Filter to Y-indexed reads (or all if we don't have opcode info)
  // Group by consumer PC → accessed addresses → y values
  const byAddr = new Map<number, AccessRecord>();

  for (const ev of trace.memReads) {
    const step = cpuStepMap.get(ev.pc);
    const isYIndexed = step ? Y_INDEXED_OPCODES.has(step.opcode) : true; // optimistic
    if (!isYIndexed) continue;

    let rec = byAddr.get(ev.addr);
    if (!rec) {
      rec = { addr: ev.addr, yValues: new Set(), pcs: new Set(), cycles: [], values: [] };
      byAddr.set(ev.addr, rec);
    }
    const y = ev.y ?? step?.y ?? 0;
    rec.yValues.add(y);
    rec.pcs.add(ev.pc);
    rec.cycles.push(ev.cycle);
    rec.values.push(ev.value);
  }

  if (byAddr.size === 0) return [];

  // Sort addresses and cluster into contiguous groups
  const sortedAddrs = Array.from(byAddr.keys()).sort((a, b) => a - b);
  const clusters: number[][] = [];
  let cluster: number[] = [sortedAddrs[0]];

  for (let i = 1; i < sortedAddrs.length; i++) {
    if (sortedAddrs[i] - sortedAddrs[i - 1] <= MAX_CLUSTER_GAP) {
      cluster.push(sortedAddrs[i]);
    } else {
      clusters.push(cluster);
      cluster = [sortedAddrs[i]];
    }
  }
  clusters.push(cluster);

  const results: DiscoveredTable[] = [];

  for (const cl of clusters) {
    if (cl.length < MIN_CLUSTER_ADDRS) continue;

    // Aggregate Y span
    let minY = 255, maxY = 0;
    const consumerPcSet = new Set<number>();
    let firstCycle = Number.MAX_SAFE_INTEGER;
    let totalAccesses = 0;

    for (const addr of cl) {
      const rec = byAddr.get(addr)!;
      for (const y of rec.yValues) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      for (const pc of rec.pcs) consumerPcSet.add(pc);
      for (const c of rec.cycles) if (c < firstCycle) firstCycle = c;
      totalAccesses += rec.cycles.length;
    }

    const ySpan = maxY - minY;
    if (ySpan < MIN_Y_SPAN) continue;

    const stride = detectStride(cl);
    const rangeStart = cl[0];
    const rangeEnd = cl[cl.length - 1] + stride - 1;
    const entries = Math.round((rangeEnd - rangeStart + 1) / stride);
    const consumerPcs = Array.from(consumerPcSet);

    const candidateKind = classifyTable(cl, stride, consumerPcs, cpuStepMap);

    // Build sample entries (up to 8)
    const sampleEntries: SampleEntry[] = [];
    for (let idx = 0; idx < Math.min(8, entries); idx++) {
      const base = rangeStart + idx * stride;
      const bytesOut: number[] = [];
      for (let b = 0; b < stride; b++) {
        if (imageBytes) {
          const offset = base + b - loadAddress;
          bytesOut.push(offset >= 0 && offset < imageBytes.length ? imageBytes[offset] : 0);
        } else {
          const rec = byAddr.get(base + b);
          bytesOut.push(rec?.values[0] ?? 0);
        }
      }
      let resolved: number | undefined;
      if (stride === 2 && bytesOut.length === 2) {
        resolved = bytesOut[0] | (bytesOut[1] << 8);
      }
      sampleEntries.push({ idx, bytes: bytesOut, resolved });
    }

    // Determine access pattern
    let accessPattern: DiscoveredTable["accessPattern"] = "indexed_read";
    for (const pc of consumerPcs) {
      const step = cpuStepMap.get(pc);
      if (step?.opcode === JMP_IND_OPCODE) {
        accessPattern = "indexed_jump";
        break;
      }
    }

    results.push({
      artifactId,
      range: [rangeStart, rangeEnd],
      stride,
      entries,
      accessPattern,
      candidateKind,
      sampleEntries,
      evidence: {
        firstSeenCycle: firstCycle === Number.MAX_SAFE_INTEGER ? 0 : firstCycle,
        accessCount: totalAccesses,
        consumerPcs,
      },
    });
  }

  return results;
}

/** Map DiscoveredTableKind to SegmentKind for annotation emission */
export function tableKindToSegmentKind(kind: DiscoveredTableKind): SegmentKind {
  switch (kind) {
    case "jump_table": return "pointer_table";
    case "pointer_table": return "pointer_table";
    case "sprite_pointers": return "sprite";
    case "char_data": return "charset";
    case "data_table": return "unknown";
    default: return "unknown";
  }
}
