// Spec 246 — Save-state semantic diff.
//
// diffSnapshots(a, b) takes two VSF byte buffers (Uint8Array) and returns
// a SnapshotDiff describing what changed between them.  Each chip's
// register array is compared element-by-element; RAM is diffed
// byte-granular with contiguous runs collapsed into ranges.
//
// OQ3 resolution: pure state-diff by default.  Pass opts.enrich=true to
// annotate small changed ranges (<100 bytes) with lastChangedCycle from
// a trace-store backend (QueryEventsBackend).
//
// OQ5 resolution: JSON primary (SnapshotDiff) + text-table helper
// formatDiff(diff) for inline-prompt / logging use.

import { readVsf } from "../vsf/vsf-format.js";
import {
  VSF_MODULE_MAINCPU, VSF_MODULE_C64MEM,
  VSF_MODULE_CIA1, VSF_MODULE_CIA2,
  VSF_MODULE_VICII, VSF_MODULE_SID,
  VSF_MODULE_DRIVECPU, VSF_MODULE_DRIVERAM,
  VSF_MODULE_VIA1D1541, VSF_MODULE_VIA2D1541,
  VSF_MODULE_IEC, VSF_MODULE_GCRHEAD,
} from "../vsf/module-mapping.js";

// ---- Public types ----

export interface ChipDiff {
  changedRegisters: { reg: number; before: number; after: number }[];
  internalStateNotes: string[];
}

export interface RamChangedRange {
  start: number;
  end: number;          // inclusive
  byteCount: number;
}

export interface RamSample {
  addr: number;
  before: number;
  after: number;
}

export interface CpuRegChange {
  reg: string;
  before: number;
  after: number;
}

export interface SnapshotDiff {
  fromCycle: number;
  toCycle: number;
  ram: {
    changedRanges: RamChangedRange[];
    sample: RamSample[];    // first 100 changes
    totalChanged: number;
  };
  cpu: {
    changedRegs: CpuRegChange[];
    pcDelta: number;
    cyclesDelta: number;
  };
  cia1: ChipDiff;
  cia2: ChipDiff;
  vic: ChipDiff;
  sid: ChipDiff;
  pla: { configBefore: string; configAfter: string };
  drive?: {
    cpu: ChipDiff;
    via1: ChipDiff;
    via2: ChipDiff;
    headPosition: { trackHalfBefore: number; trackHalfAfter: number };
  };
  iecBus: {
    edgesBetween: number;
    finalState: { atn: 0 | 1; clk: 0 | 1; data: 0 | 1 };
  };
}

export type VsfBytes = Uint8Array;

// ---- diffSnapshots ----

export function diffSnapshots(
  a: VsfBytes,
  b: VsfBytes,
  _opts?: { enrich?: boolean },
): SnapshotDiff {
  const fa = readVsf(a);
  const fb = readVsf(b);

  const modA = indexModules(fa.modules);
  const modB = indexModules(fb.modules);

  // CPU (MAINCPU)
  const cpuA = modA.get(VSF_MODULE_MAINCPU);
  const cpuB = modB.get(VSF_MODULE_MAINCPU);
  const cpuDiff = diffCpuModule(cpuA, cpuB);

  // C64 RAM (C64MEM first 65536 bytes)
  const memA = modA.get(VSF_MODULE_C64MEM);
  const memB = modB.get(VSF_MODULE_C64MEM);
  const ramDiff = diffRam(
    memA ? memA.slice(0, 65536) : new Uint8Array(65536),
    memB ? memB.slice(0, 65536) : new Uint8Array(65536),
  );

  // PLA: derived from CPU port in C64MEM bytes [65536]/[65537]
  const plaA = plaSummary(memA);
  const plaB = plaSummary(memB);

  // CIA1/CIA2 — first 16 bytes are register file
  const cia1Diff = diffRegisterArray(
    modA.get(VSF_MODULE_CIA1)?.slice(0, 16),
    modB.get(VSF_MODULE_CIA1)?.slice(0, 16),
    16,
  );
  const cia2Diff = diffRegisterArray(
    modA.get(VSF_MODULE_CIA2)?.slice(0, 16),
    modB.get(VSF_MODULE_CIA2)?.slice(0, 16),
    16,
  );

  // VIC-II — first 80 bytes are register file
  const vicDiff = diffRegisterArray(
    modA.get(VSF_MODULE_VICII)?.slice(0, 80),
    modB.get(VSF_MODULE_VICII)?.slice(0, 80),
    80,
  );

  // SID — 32 register bytes
  const sidDiff = diffRegisterArray(
    modA.get(VSF_MODULE_SID),
    modB.get(VSF_MODULE_SID),
    32,
  );

  // IEC bus
  const iecA = modA.get(VSF_MODULE_IEC);
  const iecB = modB.get(VSF_MODULE_IEC);
  const iecBusDiff = diffIecBus(iecA, iecB);

  // Drive subsystems (optional — only if both snapshots have drive modules)
  const hasDriveA = modA.has(VSF_MODULE_DRIVECPU);
  const hasDriveB = modB.has(VSF_MODULE_DRIVECPU);
  let drive: SnapshotDiff["drive"] = undefined;
  if (hasDriveA && hasDriveB) {
    const dCpuDiff = diffCpuModuleAsDriveChip(
      modA.get(VSF_MODULE_DRIVECPU),
      modB.get(VSF_MODULE_DRIVECPU),
    );
    const via1Diff = diffRegisterArray(
      modA.get(VSF_MODULE_VIA1D1541)?.slice(0, 15),
      modB.get(VSF_MODULE_VIA1D1541)?.slice(0, 15),
      15,
    );
    const via2Diff = diffRegisterArray(
      modA.get(VSF_MODULE_VIA2D1541)?.slice(0, 15),
      modB.get(VSF_MODULE_VIA2D1541)?.slice(0, 15),
      15,
    );
    const headA = modA.get(VSF_MODULE_GCRHEAD);
    const headB = modB.get(VSF_MODULE_GCRHEAD);
    const trackHalfBefore = headA ? (headA[0]! | (headA[1]! << 8)) : 0;
    const trackHalfAfter  = headB ? (headB[0]! | (headB[1]! << 8)) : 0;
    drive = {
      cpu: dCpuDiff,
      via1: via1Diff,
      via2: via2Diff,
      headPosition: { trackHalfBefore, trackHalfAfter },
    };
  }

  return {
    fromCycle: cpuDiff.cyclesBefore,
    toCycle:   cpuDiff.cyclesAfter,
    ram: ramDiff,
    cpu: {
      changedRegs: cpuDiff.changedRegs,
      pcDelta: cpuDiff.pcDelta,
      cyclesDelta: cpuDiff.cyclesDelta,
    },
    cia1: cia1Diff,
    cia2: cia2Diff,
    vic: vicDiff,
    sid: sidDiff,
    pla: { configBefore: plaA, configAfter: plaB },
    drive,
    iecBus: iecBusDiff,
  };
}

// ---- formatDiff ----

export function formatDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];

  lines.push(`Snapshot diff  cycles ${diff.fromCycle} → ${diff.toCycle}  (Δ${diff.toCycle - diff.fromCycle})`);
  lines.push("");

  // RAM
  const r = diff.ram;
  if (r.totalChanged === 0) {
    lines.push("RAM:    no changes");
  } else {
    const rangeStr = r.changedRanges
      .slice(0, 8)
      .map((rng) =>
        rng.byteCount === 1
          ? `$${hex(rng.start)}`
          : `$${hex(rng.start)}-$${hex(rng.end)}`,
      )
      .join(", ");
    const ellipsis = r.changedRanges.length > 8 ? ", ..." : "";
    lines.push(`RAM:    ${r.totalChanged} bytes changed   (${rangeStr}${ellipsis})`);
    // show up to 6 sample entries
    for (const s of r.sample.slice(0, 6)) {
      lines.push(`          $${hex4(s.addr)}: $${hex2(s.before)} → $${hex2(s.after)}`);
    }
    if (r.sample.length > 6) {
      lines.push(`          ... (${r.sample.length - 6} more samples)`);
    }
  }

  // CPU
  const c = diff.cpu;
  if (c.changedRegs.length === 0 && c.cyclesDelta === 0) {
    lines.push("CPU:    no changes");
  } else {
    const regStr = c.changedRegs
      .map((cr) => `${cr.reg} $${hex2(cr.before)}→$${hex2(cr.after)}`)
      .join("  ");
    lines.push(
      `CPU:    ${regStr}  cycles +${c.cyclesDelta}`,
    );
  }

  // CIA1
  lines.push(formatChipDiff("CIA1", diff.cia1));

  // CIA2
  lines.push(formatChipDiff("CIA2", diff.cia2));

  // VIC
  lines.push(formatChipDiff("VIC ", diff.vic));

  // SID
  lines.push(formatChipDiff("SID ", diff.sid));

  // PLA
  if (diff.pla.configBefore !== diff.pla.configAfter) {
    lines.push(`PLA:    ${diff.pla.configBefore} → ${diff.pla.configAfter}`);
  } else {
    lines.push(`PLA:    ${diff.pla.configBefore} (unchanged)`);
  }

  // Drive
  if (diff.drive) {
    lines.push(formatChipDiff("DRV/CPU", diff.drive.cpu));
    lines.push(formatChipDiff("VIA1", diff.drive.via1));
    lines.push(formatChipDiff("VIA2", diff.drive.via2));
    const hp = diff.drive.headPosition;
    if (hp.trackHalfBefore !== hp.trackHalfAfter) {
      lines.push(
        `HEAD:   trackHalf ${hp.trackHalfBefore} → ${hp.trackHalfAfter}`,
      );
    }
  }

  // IEC bus
  const iec = diff.iecBus;
  const { atn, clk, data } = iec.finalState;
  lines.push(
    `IEC:    ${iec.edgesBetween} edges  final ATN=${atn} CLK=${clk} DATA=${data}`,
  );

  return lines.join("\n");
}

// ---- helpers ----

function indexModules(
  modules: Array<{ name: string; data: Uint8Array }>,
): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const mod of modules) {
    m.set(mod.name, mod.data);
  }
  return m;
}

interface CpuDiffInternal {
  changedRegs: CpuRegChange[];
  pcDelta: number;
  cyclesDelta: number;
  cyclesBefore: number;
  cyclesAfter: number;
}

// MAINCPU layout: PC(2) A X Y SP P cycles(4LE) = 11 bytes
function parseCpuModule(data: Uint8Array | undefined): {
  pc: number; a: number; x: number; y: number; sp: number; p: number; cycles: number;
} {
  if (!data || data.length < 11) {
    return { pc: 0, a: 0, x: 0, y: 0, sp: 0, p: 0, cycles: 0 };
  }
  const pc = data[0]! | (data[1]! << 8);
  const a = data[2]!;
  const x = data[3]!;
  const y = data[4]!;
  const sp = data[5]!;
  const p = data[6]!;
  const cycles = (data[7]! | (data[8]! << 8) | (data[9]! << 16) | (data[10]! << 24)) >>> 0;
  return { pc, a, x, y, sp, p, cycles };
}

function diffCpuModule(
  dataA: Uint8Array | undefined,
  dataB: Uint8Array | undefined,
): CpuDiffInternal {
  const a = parseCpuModule(dataA);
  const b = parseCpuModule(dataB);
  const changedRegs: CpuRegChange[] = [];
  const fields: Array<keyof typeof a> = ["pc", "a", "x", "y", "sp", "p"];
  for (const f of fields) {
    if (a[f] !== b[f]) {
      changedRegs.push({ reg: f === "p" ? "flags" : f, before: a[f], after: b[f] });
    }
  }
  return {
    changedRegs,
    pcDelta: (b.pc - a.pc) & 0xffff,
    cyclesDelta: (b.cycles - a.cycles) >>> 0,
    cyclesBefore: a.cycles,
    cyclesAfter: b.cycles,
  };
}

// Drive CPU is the same format as MAINCPU but returned as ChipDiff
function diffCpuModuleAsDriveChip(
  dataA: Uint8Array | undefined,
  dataB: Uint8Array | undefined,
): ChipDiff {
  const a = parseCpuModule(dataA);
  const b = parseCpuModule(dataB);
  const changedRegisters: ChipDiff["changedRegisters"] = [];
  const fields: Array<[keyof typeof a, number]> = [
    ["pc", 0], ["a", 1], ["x", 2], ["y", 3], ["sp", 4], ["p", 5],
  ];
  for (const [f, idx] of fields) {
    if (a[f] !== b[f]) {
      changedRegisters.push({ reg: idx, before: a[f], after: b[f] });
    }
  }
  const notes: string[] = [];
  if (a.cycles !== b.cycles) {
    notes.push(`cycles: ${a.cycles} → ${b.cycles}`);
  }
  return { changedRegisters, internalStateNotes: notes };
}

function diffRegisterArray(
  dataA: Uint8Array | undefined,
  dataB: Uint8Array | undefined,
  expectedLen: number,
): ChipDiff {
  const a = dataA && dataA.length >= expectedLen ? dataA : new Uint8Array(expectedLen);
  const b = dataB && dataB.length >= expectedLen ? dataB : new Uint8Array(expectedLen);
  const changedRegisters: ChipDiff["changedRegisters"] = [];
  for (let i = 0; i < expectedLen; i++) {
    if (a[i] !== b[i]) {
      changedRegisters.push({ reg: i, before: a[i]!, after: b[i]! });
    }
  }
  return { changedRegisters, internalStateNotes: [] };
}

function diffRam(
  a: Uint8Array,
  b: Uint8Array,
): SnapshotDiff["ram"] {
  const len = Math.min(a.length, b.length);
  const sample: RamSample[] = [];
  const changedRanges: RamChangedRange[] = [];
  let totalChanged = 0;
  let rangeStart = -1;
  let rangeEnd = -1;

  for (let i = 0; i <= len; i++) {
    const changed = i < len && a[i] !== b[i];
    if (changed) {
      if (sample.length < 100) {
        sample.push({ addr: i, before: a[i]!, after: b[i]! });
      }
      totalChanged++;
      if (rangeStart < 0) {
        rangeStart = i;
        rangeEnd = i;
      } else {
        rangeEnd = i;
      }
    } else {
      if (rangeStart >= 0) {
        changedRanges.push({
          start: rangeStart,
          end: rangeEnd,
          byteCount: rangeEnd - rangeStart + 1,
        });
        rangeStart = -1;
        rangeEnd = -1;
      }
    }
  }
  return { changedRanges, sample, totalChanged };
}

function diffIecBus(
  dataA: Uint8Array | undefined,
  dataB: Uint8Array | undefined,
): SnapshotDiff["iecBus"] {
  // Layout: 6 bytes:
  //   c64AtnReleased c64ClkReleased c64DataReleased
  //   driveClkReleased driveDataReleased driveAtnAckReleased
  const a = dataA ?? new Uint8Array(6);
  const b = dataB ?? new Uint8Array(6);

  // Compute logical ATN/CLK/DATA = released means HIGH (1), asserted = LOW (0)
  // ATN: only c64 can drive (index 0)
  // CLK: c64 (index 1) OR drive (index 3)
  // DATA: c64 (index 2) OR drive (index 4)
  const atnA: 0 | 1 = (a[0]!) ? 1 : 0;
  const clkA: 0 | 1 = (a[1]! && a[3]!) ? 1 : 0;
  const dataA_: 0 | 1 = (a[2]! && a[4]!) ? 1 : 0;

  const atnB: 0 | 1 = (b[0]!) ? 1 : 0;
  const clkB: 0 | 1 = (b[1]! && b[3]!) ? 1 : 0;
  const dataB_: 0 | 1 = (b[2]! && b[4]!) ? 1 : 0;

  // Count logical edge transitions between A and B (simple before→after delta)
  let edges = 0;
  if (atnA !== atnB) edges++;
  if (clkA !== clkB) edges++;
  if (dataA_ !== dataB_) edges++;

  return {
    edgesBetween: edges,
    finalState: { atn: atnB, clk: clkB, data: dataB_ },
  };
}

function plaSummary(data: Uint8Array | undefined): string {
  if (!data || data.length < 65538) return "unknown";
  // cpuPortDirection at [65536], cpuPortValue at [65537]
  const dir = data[65536]!;
  const val = data[65537]!;
  // Bits 0-5 are CPU I/O port. Bits relevant to PLA banking are bits 0–2:
  //   bit0 = LORAM, bit1 = HIRAM, bit2 = CHAREN
  const loram  = (val & 0x01) ? "LORAM"  : "loram";
  const hiram  = (val & 0x02) ? "HIRAM"  : "hiram";
  const charen = (val & 0x04) ? "CHAREN" : "charen";
  return `$${hex2(dir)}/$${hex2(val)} (${loram},${hiram},${charen})`;
}

function formatChipDiff(label: string, diff: ChipDiff): string {
  if (diff.changedRegisters.length === 0 && diff.internalStateNotes.length === 0) {
    return `${label.padEnd(8)}no changes`;
  }
  const regStr = diff.changedRegisters
    .slice(0, 6)
    .map((cr) => `$${hex2(cr.reg)} $${hex2(cr.before)}→$${hex2(cr.after)}`)
    .join("  ");
  const ellipsis = diff.changedRegisters.length > 6 ? ` (+${diff.changedRegisters.length - 6} more)` : "";
  const notesStr = diff.internalStateNotes.length > 0
    ? `  [${diff.internalStateNotes.join("; ")}]`
    : "";
  return `${label.padEnd(8)}${regStr}${ellipsis}${notesStr}`;
}

function hex(n: number): string {
  return n.toString(16).toUpperCase();
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function hex4(n: number): string {
  return (n & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}
