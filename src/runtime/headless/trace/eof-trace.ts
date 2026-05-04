// Spec 094 (M0.1) — EOF trace harness for Bug 40.
//
// Captures a structured JSONL window across the LOAD-completion moment so the
// post-EOI behaviour of the C64 KERNAL and the 1541 drive ROM can be diffed
// against a VICE capture (Spec 095) and used as the evidence base for the
// fix in Spec 096. Observation only — no emulator state mutated beyond
// driving the cycle-lockstep session forward.
//
// Schema version 1. See docs/eof-trace-schema.md.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { startIntegratedSession } from "../integrated-session-manager.js";

export const EOF_TRACE_SCHEMA_VERSION = 1 as const;

export interface EofTraceOptions {
  diskPath: string;
  loadName: string;            // e.g. "MM" or "*"
  budget?: number;             // C64 instructions overall; default 60_000_000
  postEoiCycles?: number;      // drive cycles after EOI before stop; default 6000
  coarseEvery?: number;        // drive-cycle decimation for coarse channel; default 100
  outPath?: string;
  preEoiKeepDriveCycles?: number; // window of drive cycles kept before EOI; default 50000
  stuckLoopCycles?: number;    // C64-cycle window for stuck-loop detection; default 50000
  bootInstructions?: number;   // C64 instructions to run before typing LOAD; default 800_000
  loadCommand?: string;        // override LOAD command; default 'LOAD"<name>",8,1\\r'
}

export interface EofTraceMoment {
  name:
    | "first_a5_ge1"
    | "first_eoi"
    | "last_talk_pc"
    | "untalk_send"
    | "drive_idle_return";
  c64Cyc: number;
  drvCyc: number;
  c64Pc: number;
  drvPc: number;
}

export interface EofTraceSummary {
  schemaVersion: typeof EOF_TRACE_SCHEMA_VERSION;
  diskPath: string;
  loadName: string;
  c64CycStart: number;
  c64CycEnd: number;
  drvCycStart: number;
  drvCycEnd: number;
  moments: EofTraceMoment[];
  c64PcHistogramTop: Array<{ pc: number; count: number }>;
  drvPcHistogramTop: Array<{ pc: number; count: number }>;
  flags: {
    eoiSeen: boolean;
    driveCompletedViaAtn: boolean;
    c64InRetryLoop: boolean;
    driveStuck: boolean;
    budgetExhausted: boolean;
  };
}

export interface EofTraceResult {
  schemaVersion: typeof EOF_TRACE_SCHEMA_VERSION;
  outPath: string;
  bytes: number;
  summary: EofTraceSummary;
}

interface FineRun {
  c64Pc: number;
  drvPc: number;
  c64CycStart: number;
  drvCycStart: number;
  c64CycLast: number;
  drvCycLast: number;
  count: number;
}

interface CoarseSample {
  c64Cyc: number;
  drvCyc: number;
  c64Pc: number;
  drvPc: number;
  iec: { atn: boolean; clk: boolean; data: boolean };
  c64Released: { atn: boolean; clk: boolean; data: boolean };
  driveReleased: { clk: boolean; data: boolean; atnAck: boolean };
  ram: { z90: number; zA4: number; zA5: number };
  drvRam: { z77: number; z79: number; z85: number };
  drvInTalk: boolean;
}

const DRIVE_TALK_LO = 0xe700;
const DRIVE_TALK_HI = 0xeb00;
const DRIVE_IDLE_LO = 0xebe7;
const DRIVE_IDLE_HI = 0xec2d;
const KERNAL_UNTALK_PC_LO = 0xed09; // KERNAL UNTLK send range; loose match.
const KERNAL_UNTALK_PC_HI = 0xed40;

function pushTopHistogram(
  table: Map<number, number>,
  pc: number,
): void {
  table.set(pc, (table.get(pc) ?? 0) + 1);
}

function topN(table: Map<number, number>, n: number): Array<{ pc: number; count: number }> {
  return Array.from(table.entries())
    .map(([pc, count]) => ({ pc, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export async function runEofTrace(opts: EofTraceOptions): Promise<EofTraceResult> {
  const budget = opts.budget ?? 60_000_000;
  const postEoiCycles = opts.postEoiCycles ?? 6_000;
  const coarseEvery = opts.coarseEvery ?? 100;
  const preEoiKeep = opts.preEoiKeepDriveCycles ?? 50_000;
  const stuckLoopCycles = opts.stuckLoopCycles ?? 50_000;
  const bootInstructions = opts.bootInstructions ?? 800_000;

  if (!existsSync(opts.diskPath)) {
    throw new Error(`disk not found: ${opts.diskPath}`);
  }

  const outPath =
    opts.outPath ??
    `samples/traces/${diskBasename(opts.diskPath)}-eof.jsonl`;
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const { session } = startIntegratedSession({
    diskPath: opts.diskPath,
    mode: "true-drive",
  });
  session.resetCold();
  // Boot to BASIC ready.
  session.runFor(bootInstructions);
  const loadCmd = opts.loadCommand ?? `LOAD"${opts.loadName}",8,1\r`;
  session.typeText(loadCmd, 80_000, 80_000);

  const c64CycStart = session.c64Cpu.cycles;
  const drvCycStart = session.drive.cpu.cycles;

  const fineRing: FineRun[] = [];
  const coarseRing: CoarseSample[] = [];
  const moments: EofTraceMoment[] = [];

  let lastFine: FineRun | undefined;
  let lastCoarseDrvCyc = -1;

  // End-trigger state machine.
  let eoiSeenDrvCyc = -1;
  let postEoiCount = 0;
  let firstA5GE1Recorded = false;
  let firstEoiRecorded = false;
  let untalkSendRecorded = false;
  let driveIdleReturnRecorded = false;
  let lastTalkRecorded: EofTraceMoment | undefined;

  // Drive idle detection — drive PC inside idle band continuously for
  // 500 drive cycles after EOI seen.
  let inDriveIdleStartDrvCyc = -1;

  // Stuck-loop detection on C64 PC: if top-1 PC concentration > 80% in last
  // 50k C64 cycles after EOI, mark c64InRetryLoop.
  const stuckWindow = new Map<number, number>();
  let stuckWindowStartC64Cyc = -1;
  let c64InRetryLoop = false;

  // PC histograms for summary (post-EOI window).
  const c64Hist = new Map<number, number>();
  const drvHist = new Map<number, number>();

  let driveCompletedViaAtn = false;
  let driveStuck = false;
  let budgetExhausted = false;

  // Helper closures with captured session state.
  const recordFine = (drvPc: number, c64Pc: number, drvCyc: number, c64Cyc: number) => {
    if (lastFine && lastFine.drvPc === drvPc && lastFine.c64Pc === c64Pc) {
      lastFine.count += 1;
      lastFine.drvCycLast = drvCyc;
      lastFine.c64CycLast = c64Cyc;
      return;
    }
    lastFine = {
      drvPc, c64Pc,
      c64CycStart: c64Cyc, drvCycStart: drvCyc,
      c64CycLast: c64Cyc, drvCycLast: drvCyc,
      count: 1,
    };
    fineRing.push(lastFine);
    // Trim pre-EOI fine ring once we know EOI moment + how far back to keep.
    if (eoiSeenDrvCyc >= 0) return;
    while (fineRing.length > 0 && drvCyc - fineRing[0]!.drvCycLast > preEoiKeep) {
      fineRing.shift();
      if (fineRing.length === 0) lastFine = undefined;
    }
  };

  const recordCoarse = () => {
    const c64Cyc = session.c64Cpu.cycles;
    const drvCyc = session.drive.cpu.cycles;
    if (drvCyc - lastCoarseDrvCyc < coarseEvery) return;
    lastCoarseDrvCyc = drvCyc;
    const iec = session.iecBus.snapshot();
    const c64Bus = session.c64Bus;
    const drvBus = session.drive.bus;
    const drvPc = session.drive.cpu.pc;
    const sample: CoarseSample = {
      c64Cyc, drvCyc,
      c64Pc: session.c64Cpu.pc,
      drvPc,
      iec: { atn: iec.line.atn, clk: iec.line.clk, data: iec.line.data },
      c64Released: {
        atn: iec.c64.atnReleased,
        clk: iec.c64.clkReleased,
        data: iec.c64.dataReleased,
      },
      driveReleased: {
        clk: iec.drive.clkReleased,
        data: iec.drive.dataReleased,
        atnAck: iec.drive.atnAckReleased,
      },
      ram: {
        z90: c64Bus.ram[0x90]!,
        zA4: c64Bus.ram[0xa4]!,
        zA5: c64Bus.ram[0xa5]!,
      },
      drvRam: {
        z77: drvBus.ram[0x77]!,
        z79: drvBus.ram[0x79]!,
        z85: drvBus.ram[0x85]!,
      },
      drvInTalk: drvPc >= DRIVE_TALK_LO && drvPc <= DRIVE_TALK_HI,
    };
    coarseRing.push(sample);
    // Trim pre-EOI coarse ring.
    if (eoiSeenDrvCyc >= 0) return;
    while (coarseRing.length > 0 && drvCyc - coarseRing[0]!.drvCyc > preEoiKeep) {
      coarseRing.shift();
    }
  };

  for (let i = 0; i < budget; i++) {
    session.runFor(1);
    const c64Cyc = session.c64Cpu.cycles;
    const drvCyc = session.drive.cpu.cycles;
    const drvPc = session.drive.cpu.pc;
    const c64Pc = session.c64Cpu.pc;

    recordFine(drvPc, c64Pc, drvCyc, c64Cyc);
    recordCoarse();

    // Moment: first $A5 ≥ 1.
    if (!firstA5GE1Recorded && session.c64Bus.ram[0xa5]! >= 1) {
      moments.push({ name: "first_a5_ge1", c64Cyc, drvCyc, c64Pc, drvPc });
      firstA5GE1Recorded = true;
    }

    // Moment: first EOI ($90 & 0x40).
    const eoiBitSet = (session.c64Bus.ram[0x90]! & 0x40) !== 0;
    if (!firstEoiRecorded && eoiBitSet) {
      moments.push({ name: "first_eoi", c64Cyc, drvCyc, c64Pc, drvPc });
      firstEoiRecorded = true;
      eoiSeenDrvCyc = drvCyc;
      stuckWindowStartC64Cyc = c64Cyc;
    }

    // Track last drive TALK-area PC up to + slightly past EOI.
    if (drvPc >= DRIVE_TALK_LO && drvPc <= DRIVE_TALK_HI) {
      lastTalkRecorded = { name: "last_talk_pc", c64Cyc, drvCyc, c64Pc, drvPc };
    }

    // Moment: UNTALK send (loose KERNAL range match).
    if (
      !untalkSendRecorded
      && c64Pc >= KERNAL_UNTALK_PC_LO
      && c64Pc <= KERNAL_UNTALK_PC_HI
    ) {
      moments.push({ name: "untalk_send", c64Cyc, drvCyc, c64Pc, drvPc });
      untalkSendRecorded = true;
    }

    // Drive idle return — sustained presence in idle band post-EOI.
    if (eoiSeenDrvCyc >= 0) {
      if (drvPc >= DRIVE_IDLE_LO && drvPc <= DRIVE_IDLE_HI) {
        if (inDriveIdleStartDrvCyc < 0) inDriveIdleStartDrvCyc = drvCyc;
        if (
          !driveIdleReturnRecorded
          && drvCyc - inDriveIdleStartDrvCyc >= 500
        ) {
          moments.push({ name: "drive_idle_return", c64Cyc, drvCyc, c64Pc, drvPc });
          driveIdleReturnRecorded = true;
          driveCompletedViaAtn = true;
        }
      } else {
        inDriveIdleStartDrvCyc = -1;
      }
      pushTopHistogram(c64Hist, c64Pc);
      pushTopHistogram(drvHist, drvPc);
      pushTopHistogram(stuckWindow, c64Pc);
      // Stuck-loop window: roll over after stuckLoopCycles C64 cyc.
      if (c64Cyc - stuckWindowStartC64Cyc >= stuckLoopCycles) {
        const total = Array.from(stuckWindow.values()).reduce((a, b) => a + b, 0);
        const top = Math.max(...Array.from(stuckWindow.values()));
        if (total > 0 && top / total > 0.8) c64InRetryLoop = true;
        stuckWindow.clear();
        stuckWindowStartC64Cyc = c64Cyc;
      }
      postEoiCount = drvCyc - eoiSeenDrvCyc;
      if (postEoiCount >= postEoiCycles) break;
    }

    if (i === budget - 1) budgetExhausted = true;
  }

  if (lastTalkRecorded) moments.push(lastTalkRecorded);
  if (!firstEoiRecorded) {
    // Fallback: never saw EOI. Histogram covers full collected window.
    for (const r of fineRing) {
      drvHist.set(r.drvPc, (drvHist.get(r.drvPc) ?? 0) + r.count);
      c64Hist.set(r.c64Pc, (c64Hist.get(r.c64Pc) ?? 0) + r.count);
    }
    // Drive-stuck heuristic: top-1 drive PC outside TALK ∪ idle bands.
    const drvTop = topN(drvHist, 1)[0];
    if (drvTop) {
      const inTalk = drvTop.pc >= DRIVE_TALK_LO && drvTop.pc <= DRIVE_TALK_HI;
      const inIdle = drvTop.pc >= DRIVE_IDLE_LO && drvTop.pc <= DRIVE_IDLE_HI;
      if (!inTalk && !inIdle) driveStuck = true;
    }
  }

  const summary: EofTraceSummary = {
    schemaVersion: EOF_TRACE_SCHEMA_VERSION,
    diskPath: opts.diskPath,
    loadName: opts.loadName,
    c64CycStart,
    c64CycEnd: session.c64Cpu.cycles,
    drvCycStart,
    drvCycEnd: session.drive.cpu.cycles,
    moments,
    c64PcHistogramTop: topN(c64Hist, 10),
    drvPcHistogramTop: topN(drvHist, 10),
    flags: {
      eoiSeen: firstEoiRecorded,
      driveCompletedViaAtn,
      c64InRetryLoop,
      driveStuck,
      budgetExhausted,
    },
  };

  const lines: string[] = [];
  lines.push(JSON.stringify({
    type: "header",
    schemaVersion: EOF_TRACE_SCHEMA_VERSION,
    diskPath: opts.diskPath,
    loadName: opts.loadName,
    bootInstructions,
    coarseEvery,
    postEoiCycles,
    preEoiKeepDriveCycles: preEoiKeep,
    c64CycStart, drvCycStart,
  }));
  for (const r of fineRing) {
    lines.push(JSON.stringify({
      type: "fine",
      c64Pc: r.c64Pc, drvPc: r.drvPc,
      c64CycStart: r.c64CycStart, drvCycStart: r.drvCycStart,
      c64CycLast: r.c64CycLast, drvCycLast: r.drvCycLast,
      count: r.count,
    }));
  }
  for (const c of coarseRing) {
    lines.push(JSON.stringify({ type: "coarse", ...c }));
  }
  for (const m of moments) {
    lines.push(JSON.stringify({ type: "moment", ...m }));
  }
  lines.push(JSON.stringify({ type: "summary", ...summary }));

  const body = lines.join("\n") + "\n";
  writeFileSync(outPath, body);

  return {
    schemaVersion: EOF_TRACE_SCHEMA_VERSION,
    outPath,
    bytes: Buffer.byteLength(body, "utf8"),
    summary,
  };
}

function diskBasename(p: string): string {
  const slash = p.lastIndexOf("/");
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
