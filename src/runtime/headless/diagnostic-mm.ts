// Spec 093 — Maniac Mansion G64 1541 lockstep debug helper.
//
// Boots an integrated session and runs until one of:
//  - title screen reached (heuristic: drive read N bytes from data tracks +
//    C64 PC moved into game RAM range)
//  - C64 stalls in a tight loop (heuristic: same PC repeats > N times)
//  - drive PC repeats inside small window (loader stuck)
//  - cycle budget exhausted
//
// Produces a structured JSON report describing the stall reason + a small
// blame attribution (which IEC line owner held the bus + what the drive was
// doing). Soft-failure design: never throws on stall, always returns report.

import type { IntegratedSession } from "./integrated-session.js";

export interface DiagnoseMmOptions {
  cycleBudget?: number;          // C64 cycles. Default 50_000_000 (~50s).
  stallPcRepeat?: number;        // Same C64 PC repeated this many cycles → stall.
  driveLoopWindow?: number;      // Drive PC trace window for stuck-loop detection.
  driveLoopMaxUnique?: number;   // Loop = window has ≤ this many unique PCs.
  watchPc?: number;              // C64 PC to flag (default $46A7 — known MM stall).
  watchPcDwellCycles?: number;   // Treat sustained dwell at watchPc as stall.
}

export type StallVerdict =
  | "title-or-progress"
  | "tool-config-no-microcoded-cpu"
  | "c64-stuck-at-watch-pc"
  | "c64-stuck-tight-loop"
  | "drive-stuck-tight-loop"
  | "cycle-budget-exhausted"
  | "exception"
  | "unknown";

export interface DiagnoseMmReport {
  spec: "093";
  generatedAt: string;
  diskPath: string;
  imageFormat: string;
  config: {
    driveClockRatio: number;
    enableKernalFileIoTraps: boolean;
    enableKernalSerialTraps: boolean;
    enableKernalIoTraps: boolean;
  };
  run: {
    cyclesExecuted: number;
    instructionsExecuted: number;
    durationMs: number;
    cycleBudget: number;
    stalled: boolean;
    verdict: StallVerdict;
    blame: {
      // Who is holding each line low at the moment of report.
      atnHolder: "c64" | "released";
      clkHolder: "c64" | "drive" | "both" | "released";
      dataHolder: "c64" | "drive" | "atn-ack" | "both" | "released";
    };
    summary: string;
  };
  finalState: {
    c64: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number };
    drive: { pc: number; a: number; x: number; y: number; sp: number; flags: number; cycles: number; track: number };
    iecLine: { atn: 0 | 1; clk: 0 | 1; data: 0 | 1 };
    iecRaw: {
      c64Atn: 0 | 1; c64Clk: 0 | 1; c64Data: 0 | 1;
      drvClk: 0 | 1; drvData: 0 | 1; drvAtnAck: 0 | 1;
    };
  };
  iecTrace: ReturnType<IntegratedSession["getIecTrace"]>;
  drivePcTrace: ReturnType<IntegratedSession["getDrivePcTrace"]>;
  questions: Array<{ q: string; a: string }>;
  exception?: string;
}

const DEFAULTS = {
  cycleBudget: 50_000_000,
  stallPcRepeat: 200_000,
  driveLoopWindow: 64,
  driveLoopMaxUnique: 6,
  watchPc: 0x46a7,
  watchPcDwellCycles: 200_000,
  // Spec 093: warmup before any stall verdict — cold-reset BASIC sits in
  // idle loop and drive ROM sits in $EBFF-area idle. Both look like
  // "stalled" but are healthy. Require sustained inactivity past warmup.
  warmupCycles: 2_000_000,
};

export function diagnoseMm(session: IntegratedSession, opts: DiagnoseMmOptions = {}): DiagnoseMmReport {
  const o = { ...DEFAULTS, ...opts };
  const startTime = Date.now(); // audit-ok: wall-clock timing for durationMs diagnostic reporting only; does not affect emulator state
  const startCycles = session.c64Cpu.cycles;
  const startInstr = session.status().c64.instructions;
  let exception: string | undefined;
  let stalled = false;
  let verdict: StallVerdict = "unknown";

  // Track repeated C64 PC for tight-loop detection (cheap: sample per chunk).
  let lastPc = -1;
  let lastPcSinceCycles = startCycles;
  let watchPcSinceCycles = -1;
  const CHUNK = 4096; // C64 instructions per polling chunk.

  // Spec 723.7b: the runtime is single-path (event-catchup + microcoded CPU +
  // vice1541). No lockstep pre-flight check — the diagnostic runs the product
  // path directly.

  try {
    while (session.c64Cpu.cycles - startCycles < o.cycleBudget) {
      session.runFor(CHUNK);
      const pc = session.c64Cpu.pc;
      const cyc = session.c64Cpu.cycles;
      const sinceStart = cyc - startCycles;
      const warmedUp = sinceStart >= o.warmupCycles;
      // Tight-loop: same PC sampled across windows. Warmup gate.
      if (pc === lastPc) {
        if (warmedUp && cyc - lastPcSinceCycles >= o.stallPcRepeat) {
          stalled = true;
          verdict = pc === o.watchPc ? "c64-stuck-at-watch-pc" : "c64-stuck-tight-loop";
          break;
        }
      } else {
        lastPc = pc;
        lastPcSinceCycles = cyc;
      }
      // Watch PC sustained dwell.
      if (pc === o.watchPc) {
        if (watchPcSinceCycles < 0) watchPcSinceCycles = cyc;
        if (warmedUp && cyc - watchPcSinceCycles >= o.watchPcDwellCycles) {
          stalled = true;
          verdict = "c64-stuck-at-watch-pc";
          break;
        }
      } else {
        watchPcSinceCycles = -1;
      }
      // Drive stuck-loop: only meaningful when C64 is also stuck (mutual
      // handshake wait). Drive idle loop alone is a normal state.
      if (warmedUp && pc === lastPc && cyc - lastPcSinceCycles >= o.stallPcRepeat / 4) {
        const dt = session.getDrivePcTrace();
        if (dt.length >= o.driveLoopWindow) {
          const tail = dt.slice(-o.driveLoopWindow);
          const uniq = new Set(tail.map((e) => e.pc)).size;
          if (uniq <= o.driveLoopMaxUnique) {
            stalled = true;
            verdict = "drive-stuck-tight-loop";
            break;
          }
        }
      }
    }
    if (!stalled && session.c64Cpu.cycles - startCycles >= o.cycleBudget) {
      verdict = "cycle-budget-exhausted";
      stalled = true;
    } else if (!stalled) {
      verdict = "title-or-progress";
    }
  } catch (e: any) {
    exception = e?.stack ?? String(e);
    verdict = "exception";
    stalled = true;
  }
  return finalize(verdict, summaryFor(verdict));

  function finalize(v: StallVerdict, summary: string): DiagnoseMmReport {
    const s = session.status();
    const iec = s.iecBus;
    return {
      spec: "093",
      generatedAt: new Date().toISOString(),
      diskPath: s.runtime.diskPath,
      imageFormat: s.runtime.imageFormat,
      config: {
        driveClockRatio: s.runtime.driveClockRatio,
        enableKernalFileIoTraps: s.runtime.enableKernalFileIoTraps,
        enableKernalSerialTraps: s.runtime.enableKernalSerialTraps,
        enableKernalIoTraps: s.runtime.enableKernalIoTraps,
      },
      run: {
        cyclesExecuted: session.c64Cpu.cycles - startCycles,
        instructionsExecuted: s.c64.instructions - startInstr,
        durationMs: Date.now() - startTime, // audit-ok: wall-clock timing for durationMs diagnostic reporting only; does not affect emulator state
        cycleBudget: o.cycleBudget,
        stalled,
        verdict: v,
        blame: blameLines(iec),
        summary,
      },
      finalState: {
        c64: {
          pc: s.c64.pc, a: s.c64.a, x: s.c64.x, y: s.c64.y,
          sp: s.c64.sp, flags: s.c64.flags, cycles: s.c64.cycles,
        },
        drive: {
          pc: s.drive.pc, a: s.drive.a, x: s.drive.x, y: s.drive.y,
          sp: s.drive.sp, flags: s.drive.flags, cycles: s.drive.cycles,
          track: s.drive.track,
        },
        iecLine: {
          atn: iec.line.atn ? 1 : 0,
          clk: iec.line.clk ? 1 : 0,
          data: iec.line.data ? 1 : 0,
        },
        iecRaw: {
          c64Atn: iec.c64.atnReleased ? 1 : 0,
          c64Clk: iec.c64.clkReleased ? 1 : 0,
          c64Data: iec.c64.dataReleased ? 1 : 0,
          drvClk: iec.drive.clkReleased ? 1 : 0,
          drvData: iec.drive.dataReleased ? 1 : 0,
          drvAtnAck: iec.drive.atnAckReleased ? 1 : 0,
        },
      },
      iecTrace: session.getIecTrace(),
      drivePcTrace: session.getDrivePcTrace(),
      questions: questionnaire(session, v),
      exception,
    };
  }
}

function blameLines(iec: any) {
  const atnHolder: "c64" | "released" = iec.c64.atnReleased ? "released" : "c64";
  let clkHolder: "c64" | "drive" | "both" | "released";
  if (!iec.c64.clkReleased && !iec.drive.clkReleased) clkHolder = "both";
  else if (!iec.c64.clkReleased) clkHolder = "c64";
  else if (!iec.drive.clkReleased) clkHolder = "drive";
  else clkHolder = "released";
  let dataHolder: "c64" | "drive" | "atn-ack" | "both" | "released";
  const atnAckPulling = !iec.line.atn && !iec.drive.atnAckReleased;
  if (atnAckPulling && !iec.c64.dataReleased) dataHolder = "both";
  else if (atnAckPulling) dataHolder = "atn-ack";
  else if (!iec.c64.dataReleased && !iec.drive.dataReleased) dataHolder = "both";
  else if (!iec.c64.dataReleased) dataHolder = "c64";
  else if (!iec.drive.dataReleased) dataHolder = "drive";
  else dataHolder = "released";
  return { atnHolder, clkHolder, dataHolder };
}

function summaryFor(v: StallVerdict): string {
  switch (v) {
    case "title-or-progress": return "Run completed within budget without detecting a stall.";
    case "tool-config-no-microcoded-cpu": return "Session lacked microcoded CPU.";
    case "c64-stuck-at-watch-pc": return "C64 stuck at watch PC (default $46A7) — IEC handshake wait. See blame.";
    case "c64-stuck-tight-loop": return "C64 stuck in a tight loop. See finalState.c64.pc.";
    case "drive-stuck-tight-loop": return "Drive CPU stuck inside a small loop. See drivePcTrace tail + blame.";
    case "cycle-budget-exhausted": return "Cycle budget exhausted before any stall heuristic fired.";
    case "exception": return "Emulator threw — see report.exception.";
    case "unknown": return "No verdict reached.";
  }
}

function questionnaire(session: IntegratedSession, _v: StallVerdict): Array<{ q: string; a: string }> {
  const s = session.status();
  const iec = s.iecBus;
  const trace = session.getIecTrace();
  const propagationOk = trace.some((e) => e.side === "c64") && trace.some((e) => e.side === "drive");
  return [
    { q: "IEC trace captured at least one C64 + one drive edge?", a: String(propagationOk) },
    { q: "ATN line state at end (1=released, 0=pulled)", a: String(iec.line.atn ? 1 : 0) },
    { q: "CLK line state at end (1=released, 0=pulled)", a: String(iec.line.clk ? 1 : 0) },
    { q: "DATA line state at end (1=released, 0=pulled)", a: String(iec.line.data ? 1 : 0) },
    { q: "Drive ATN_ACK released?", a: String(iec.drive.atnAckReleased) },
  ];
}
