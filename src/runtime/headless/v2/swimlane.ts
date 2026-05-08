// Spec 234 — Transaction-level swimlane.
//
// Joins cpu_step + mem_read/write + drive_*_change events into one
// shared cycle timeline. Compact mode (default) emits only rows where
// at least one column changed since the previous row.

import { queryEvents, type QueryEventsBackend } from "./query-events.js";
import { OPCODE_TABLE } from "../../../exomizer-ts/generated-opcodes.js";
import { UNDOC_TABLE } from "../cpu/undoc-table.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface SwimlaneRow {
  cycle: number;
  c64Pc?: number;
  /** mnemonic + operand, e.g. "LDA $D011" */
  c64Op?: string;
  c64IoRw?: "r" | "w";
  c64IoAddr?: number;
  c64IoValue?: number;
  busAtn?: 0 | 1;
  busClk?: 0 | 1;
  busData?: 0 | 1;
  drvPc?: number;
  drvOp?: string;
  drvIoRw?: "r" | "w";
  drvIoAddr?: number;
  drvIoValue?: number;
}

export interface SwimlaneSlice {
  startCycle: number;
  endCycle: number;
  rows: SwimlaneRow[];
  compact: boolean;
}

export interface SwimlaneQuery {
  runId: string;
  cycleRange: [number, number];
  /** Default true. Full rows only on compact:false. */
  compact?: boolean;
  filterC64PcRange?: [number, number];
  filterDrvPcRange?: [number, number];
}

// ── Internal opcode → mnemonic helper ───────────────────────────────────────

function hex2(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, "0");
}
function hex4(v: number): string {
  return v.toString(16).toUpperCase().padStart(4, "0");
}

function opcodeToMnemonic(opcode: number): string {
  const info = OPCODE_TABLE[opcode];
  if (!info) {
    // Try undoc table — UndocSlot uses `kind` for the mnemonic string.
    const undoc = UNDOC_TABLE[opcode];
    if (undoc) return undoc.kind.toUpperCase();
    return `$${hex2(opcode)}`;
  }
  const mne = info.op.toUpperCase();
  switch (info.mode) {
    case "imp": case "acc": return mne;
    case "imm":  return `${mne} #imm`;
    case "zp":   return `${mne} zp`;
    case "zpx":  return `${mne} zp,X`;
    case "zpy":  return `${mne} zp,Y`;
    case "abs":  return `${mne} abs`;
    case "absx": return `${mne} abs,X`;
    case "absy": return `${mne} abs,Y`;
    case "ind":  return `${mne} (abs)`;
    case "indx": return `${mne} (zp,X)`;
    case "indy": return `${mne} (zp),Y`;
    case "rel":  return `${mne} rel`;
    default:     return mne;
  }
}

// ── IEC IO address ranges ────────────────────────────────────────────────────

/** $D000–$DFFF: C64 IO region (VIC/SID/CIA/...) */
function isC64IoAddr(addr: number): boolean {
  return addr >= 0xd000 && addr <= 0xdfff;
}

/** Drive IO: $1800–$1FFF (VIA1), $1C00–$1FFF (VIA2) — broadly $1000–$1FFF */
function isDrvIoAddr(addr: number): boolean {
  return addr >= 0x1000 && addr <= 0x1fff;
}

// ── swimlaneSlice ────────────────────────────────────────────────────────────

export async function swimlaneSlice(
  backend: QueryEventsBackend,
  query: SwimlaneQuery,
): Promise<SwimlaneSlice> {
  const { runId, cycleRange, compact = true } = query;
  const [startCycle, endCycle] = cycleRange;

  // Fetch all relevant event families in parallel.
  const [
    cpuSteps,
    memReads,
    memWrites,
    atnChanges,
    clkChanges,
    dataChanges,
  ] = await Promise.all([
    queryEvents(backend, {
      runId,
      family: "cpu_step",
      cycleRange,
      ...(query.filterC64PcRange ? { pcRange: query.filterC64PcRange } : {}),
      limit: 100_000,
    }),
    queryEvents(backend, {
      runId,
      family: "mem_read",
      cycleRange,
      limit: 100_000,
    }),
    queryEvents(backend, {
      runId,
      family: "mem_write",
      cycleRange,
      limit: 100_000,
    }),
    queryEvents(backend, { runId, family: "drive_atn_change", cycleRange, limit: 100_000 }),
    queryEvents(backend, { runId, family: "drive_clk_change", cycleRange, limit: 100_000 }),
    queryEvents(backend, { runId, family: "drive_data_change", cycleRange, limit: 100_000 }),
  ]);

  // Build a sorted cycle list from all event cycles.
  const cycleSet = new Set<number>();
  for (const e of cpuSteps) cycleSet.add(e.cycle);
  for (const e of memReads) cycleSet.add(e.cycle);
  for (const e of memWrites) cycleSet.add(e.cycle);
  for (const e of atnChanges) cycleSet.add(e.cycle);
  for (const e of clkChanges) cycleSet.add(e.cycle);
  for (const e of dataChanges) cycleSet.add(e.cycle);

  const cycles = Array.from(cycleSet).sort((a, b) => a - b);

  // Index events by cycle for O(1) lookup.
  type AnyEvent = typeof cpuSteps[number] | typeof memReads[number] | typeof memWrites[number] | typeof atnChanges[number] | typeof clkChanges[number] | typeof dataChanges[number];

  function indexByCycle<T extends { cycle: number }>(arr: T[]): Map<number, T[]> {
    const m = new Map<number, T[]>();
    for (const e of arr) {
      const list = m.get(e.cycle);
      if (list) list.push(e);
      else m.set(e.cycle, [e]);
    }
    return m;
  }

  const cpuIdx = indexByCycle(cpuSteps);
  const memReadIdx = indexByCycle(memReads);
  const memWriteIdx = indexByCycle(memWrites);
  const atnIdx = indexByCycle(atnChanges);
  const clkIdx = indexByCycle(clkChanges);
  const dataIdx = indexByCycle(dataChanges);

  // Track last bus line values to carry forward.
  let lastBusAtn: 0 | 1 | undefined;
  let lastBusClk: 0 | 1 | undefined;
  let lastBusData: 0 | 1 | undefined;

  // Build full row set.
  const rows: SwimlaneRow[] = [];

  for (const cycle of cycles) {
    const row: SwimlaneRow = { cycle };

    // C64 CPU step.
    const cpuEvs = cpuIdx.get(cycle);
    if (cpuEvs && cpuEvs.length > 0) {
      const ev = cpuEvs[0];
      if (ev.family === "cpu_step") {
        row.c64Pc = ev.pc;
        row.c64Op = opcodeToMnemonic(ev.opcode);
      }
    }

    // C64 IO reads (only IO-space).
    const reads = memReadIdx.get(cycle);
    if (reads) {
      for (const ev of reads) {
        if (ev.family === "mem_read" && isC64IoAddr(ev.addr)) {
          row.c64IoRw = "r";
          row.c64IoAddr = ev.addr;
          row.c64IoValue = ev.value;
          break; // first IO read per cycle
        }
      }
    }

    // C64 IO writes (only IO-space).
    const writes = memWriteIdx.get(cycle);
    if (writes) {
      for (const ev of writes) {
        if (ev.family === "mem_write" && isC64IoAddr(ev.addr)) {
          // Write takes precedence over read in same cycle.
          row.c64IoRw = "w";
          row.c64IoAddr = ev.addr;
          row.c64IoValue = ev.value;
          break;
        }
      }
    }

    // IEC bus lines — carry forward on change events.
    const atnEvs = atnIdx.get(cycle);
    if (atnEvs && atnEvs.length > 0) {
      const ev = atnEvs[0];
      if (ev.family === "drive_atn_change") {
        lastBusAtn = ev.level as 0 | 1;
      }
    }
    const clkEvs = clkIdx.get(cycle);
    if (clkEvs && clkEvs.length > 0) {
      const ev = clkEvs[0];
      if (ev.family === "drive_clk_change") {
        lastBusClk = ev.level as 0 | 1;
      }
    }
    const dataEvs = dataIdx.get(cycle);
    if (dataEvs && dataEvs.length > 0) {
      const ev = dataEvs[0];
      if (ev.family === "drive_data_change") {
        lastBusData = ev.level as 0 | 1;
      }
    }

    if (lastBusAtn !== undefined) row.busAtn = lastBusAtn;
    if (lastBusClk !== undefined) row.busClk = lastBusClk;
    if (lastBusData !== undefined) row.busData = lastBusData;

    rows.push(row);
  }

  // Compact: drop rows where nothing changed vs previous row.
  let finalRows = rows;
  if (compact) {
    finalRows = [];
    let prev: SwimlaneRow | undefined;
    for (const row of rows) {
      if (!prev || rowChanged(prev, row)) {
        finalRows.push(row);
        prev = row;
      }
    }
  }

  return { startCycle, endCycle, rows: finalRows, compact };
}

function rowChanged(prev: SwimlaneRow, cur: SwimlaneRow): boolean {
  return (
    cur.c64Pc !== prev.c64Pc ||
    cur.c64Op !== prev.c64Op ||
    cur.c64IoRw !== prev.c64IoRw ||
    cur.c64IoAddr !== prev.c64IoAddr ||
    cur.c64IoValue !== prev.c64IoValue ||
    cur.busAtn !== prev.busAtn ||
    cur.busClk !== prev.busClk ||
    cur.busData !== prev.busData ||
    cur.drvPc !== prev.drvPc ||
    cur.drvOp !== prev.drvOp ||
    cur.drvIoRw !== prev.drvIoRw ||
    cur.drvIoAddr !== prev.drvIoAddr ||
    cur.drvIoValue !== prev.drvIoValue
  );
}
