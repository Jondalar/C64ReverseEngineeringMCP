// Spec 836 D3 — one command on a machine of your own.
//
// `sandbox-session.ts` already builds the private machine doctrine rule 2
// describes: its own port, a CHILD daemon, a budget, and an end of its own when
// the budget runs out. Until now the only way to reach it was to write a
// `.feature` file and ask for a GIF (Spec 812). This drives the same machine for
// one COMMAND instead: put a medium in, do these steps, say what happened.
//
// THE LINE THIS FILE DRAWS, and it is the whole design decision:
//
//   This sandbox exists for the duration of one call. So the call may express
//   anything that is COMPLETE IN ITSELF — a bounded advance, a wait on a state
//   the machine can reach on its own, a look at the screen, the registers, some
//   memory. What it may not express is anything whose value depends on a LATER
//   call: a breakpoint you stop at and then decide from, a step you take and
//   then repeat, a monitor prompt. Those need a machine that is still there
//   afterwards, and that is the sandbox SESSION (`runtime/sandbox-sessions.ts`,
//   Spec 906): the same daemon, started for a purpose, with a session id, ended
//   on reached / failed / budget / idle. This one returns no session id, and
//   there is nothing to attach to: the machine is gone before the answer is read.
//
// Deliberately NOT a second `run-scenario.ts`: no regions (a region is a project
// -store concept a scenario resolves against), no captures, no reel. The step
// NOTATION is shared — `parseStep` from the scenario parser — because a repo
// with two ways to say "wait 170 frames" ends up with two of everything.
//
// A SCRIPT over the one sandbox lifecycle (Spec 910 D3, `runtime/sandbox-sessions.ts`). It has no boot, no
// medium door and no end of its own: it starts a sandbox through `startSandboxSession`, translates its step
// language into the same runtime calls a session is driven with (`runUntil` for every advance), mounts through
// `mountSandboxMedium`, and ends through `endSandboxSession`. A one-shot run is a session whose caller never sees
// the id.
//
// Nothing here may reach the shared machine: the sandbox lifecycle never addresses the shared port, and
// `assertNotShared` (re-exported below) makes the one remaining coincidence, a free port that happens to BE the
// shared one, a refusal rather than a surprise.

import { existsSync } from "node:fs";
import type { Step, Predicate, Check, SeriesRead } from "../project-knowledge/scenario-gherkin.js";
import { waitCycles } from "../project-knowledge/scenario-gherkin.js";
import {
  joinChunks, screenShows, screenCodesToRows, SCREEN_COLS, SCREEN_ROWS,
  type RegionLens, type RegionRange,
} from "../project-knowledge/region.js";
import { machineIdentity, type MachineIdentity } from "../runtime/machine-model.js";
import { runUntil } from "../runtime/run-until.js";
import {
  ejectSandboxDisk, endSandboxSession, mountSandboxMedium, sandboxCall, sandboxEndedBecause, startSandboxSession,
} from "../runtime/sandbox-sessions.js";
import type { DriveBoard } from "./drive-board.js";
export { assertNotShared, sharedRuntimePort } from "./shared-port.js";
import {
  inputOffsetFor, offsetRefusal, offsetsRequested, type InputOffsetOptions, type InputRecord,
} from "./input-offset.js";
import {
  defaultProbeLine, describeAssertFailure, describeRowViolation, describeStop, everyNth, firstViolation,
  probeAssert, probeSeries, requireProbeRuntime, type ProbeRow, type ProbeStop,
} from "./frame-probe.js";

// A bounded run is split a frame at a time so a JAM still stops where it happens. How
// long a frame is comes from the machine (Spec 863): 19 656 cycles PAL, 17 095 NTSC.

/** What one typed key costs: session/type presses each key for 80 000 cycles and waits 80 000 before the next
 *  (the daemon's defaults, which this runner does not override). */
const KEY_CYCLES = 160_000;
const hex4 = (n: number): string => `$${n.toString(16).padStart(4, "0").toUpperCase()}`;

export interface MemoryRead {
  readonly label: string;
  readonly addr: number;
  readonly len: number;
  readonly lens: RegionLens;
}

/** Spec 910 — what a script over the sandbox lifecycle takes of the sandbox itself. */
export interface SandboxScriptOptions {
  /** Wall-clock ceiling; the sandbox ends itself at this age. Default 10 minutes. */
  budgetMs?: number;
  /** The project the outcome is recorded in; also where the daemon keeps its project. Absent: a temp dir, and no step log. */
  projectDir?: string;
  /** Spec 863 — which C64 the machine is (a row of the runtime's model table, e.g. `c64-ntsc`). Omitted: the runtime's default. */
  model?: string;
  /** What the sandbox is for, as the step log records it. */
  purpose?: string;
}

export interface SandboxRunOptions extends SandboxScriptOptions, InputOffsetOptions {
  /** The medium for YOUR machine — .crt / .d64 / .g64 / .d81 / .prg / .c64re. */
  mediaPath?: string;
  /** A PRG's entry: start there after the load instead of typing RUN. */
  run?: number;
  /** #33 — drive 8's board from the start. Omitted: a 1541, unless the medium asks for another. */
  driveType?: DriveBoard;
  /** Spec 900 — checks, each decided right after `afterSteps` steps (0: once the medium is in). */
  checks?: readonly SandboxCheck[];
  /** The schedule. Parsed by the caller so a bad line is reported before a daemon starts. */
  steps: readonly Step[];
  /** Memory to dump once the steps are done. */
  reads?: readonly MemoryRead[];
  /**
   * Code to write into the machine after the origin is loaded and before the first step: RAM, or a
   * window of one cartridge bank. Given (even empty) the run takes the same capture-and-patch
   * round trip, so a run without a fix and a run with one start from the same kind of machine.
   */
  patches?: readonly SandboxPatch[];
  /**
   * Where `I set the anchor "<name>"` writes. Absent: the step is an error — a run with no project
   * has nowhere to keep it. `replace`: an anchor of that name already there is overwritten.
   */
  anchors?: { readonly pathFor: (name: string) => string; readonly replace: boolean };
  /**
   * The medium is a state dump (an anchor) and the run starts AT it: the machine is left exactly where the
   * dump had it, not advanced to the next frame boundary to find out whether the VIC is sweeping.
   */
  startExactly?: boolean;
  /** A `wait until` that does not happen ends the run as a FAILURE of that wait (`failedWait`), not as an error. */
  waitTimeoutIsFailure?: boolean;
  /** Read the text screen at the end (default true). */
  screen?: boolean;
  /** Encode the final frame as a single-frame GIF. */
  wantFrame?: boolean;
  /** Resolve a medium NAMED in an `I insert the ... "x.d64"` step to a path. */
  resolveMedium?: (named: string) => string;
  /**
   * Spec 861 §4.5 — record this run into a trace store.
   *
   * The capture starts once the machine is warmed and the medium is in: advance
   * to a frame boundary, mark that boundary (the anchor every raster position
   * is counted from), record for the whole schedule, and finalize into the
   * store. No new runtime operation — `trace/start_domains`, `trace/run/mark`
   * and `trace/run/stop` are the ones the live session already uses.
   */
  trace?: {
    /** absolute path of the `.duckdb` index to write (its `.c64retrace` lands beside it) */
    output: string;
    /** default: the cpu and mem channels, which is what §4.1's arithmetic reads */
    domains?: readonly string[];
    /**
     * Start recording only after this many steps have run. The window is the
     * caller's choice (§4.5): a capture that begins at the medium records the
     * whole load, and what is being measured is usually what happens after it.
     */
    afterSteps?: number;
  };
}

/** Bytes to put into the machine: RAM, or a window ("roml" $8000-$9FFF, "romh" $A000-$BFFF) of one cartridge bank. */
export interface SandboxPatch {
  readonly space: "ram" | "roml" | "romh";
  readonly bank?: number;
  readonly addr: number;
  readonly bytes: readonly number[];
}

/** A `wait until` that ran out of frames. */
export class WaitNotReached extends Error {
  constructor(readonly what: string, readonly frames: number, message: string) {
    super(message);
    this.name = "WaitNotReached";
  }
}

/** Spec 900 — a check to decide during the run, and where in it. */
export interface SandboxCheck {
  readonly check: Check;
  readonly afterSteps: number;
  /** As written, for the report. */
  readonly text: string;
  /** The `.feature` line, when there is one. */
  readonly line?: number;
}

/** Spec 900 — how a check came out. `actual` is what the machine had, in the check's own terms. */
export interface SandboxCheckResult extends SandboxCheck {
  readonly pass: boolean;
  readonly actual: string;
  /** Cycle it was decided on. */
  readonly cycle: number;
  /**
   * Spec 899 D3 — a window check that did not hold: the frame (counted from the start of the
   * window) and the cycle of the first sample where it failed.
   */
  readonly failedAt?: { readonly frame: number; readonly cycle: number; readonly line: number; readonly rasterCycle: number };
  /**
   * Spec 899 — the probe was stopped by an armed breakpoint or watchpoint before the window
   * ended. The check is undecided: `pass` is false, but this is neither a pass nor a fail of
   * the value, and the machine stays where it stopped.
   */
  readonly stopped?: ProbeStop;
}

/** Spec 899 D4 — one `I read the series …` step, as it came back. */
export interface SeriesResult {
  readonly step: number;
  readonly text: string;
  readonly reads: readonly SeriesRead[];
  readonly everyFrames: number;
  readonly frames: number;
  /** The raster line each sample was aimed at. */
  readonly line: number;
  readonly startCycle: number;
  readonly endCycle: number;
  /** Only the rows where a sampled value changed. `seenFrame` is set when `everyFrames` > 1. */
  readonly rows: readonly (ProbeRow & { seenFrame?: number })[];
  /** Samples the probe took, and how many of them differed from the one before. */
  readonly samples: number;
  readonly changes: number;
  readonly stopped?: ProbeStop;
}

export interface SandboxRunResult {
  /** The port the private machine held — reported so nobody watches the wrong one. */
  readonly port: number;
  /** Spec 863 — which C64 it was, as the machine reported itself at the end. */
  readonly machine: MachineIdentity;
  readonly log: readonly string[];
  readonly waits: readonly { text: string; frames: number; budget: number; cycle: number }[];
  readonly endCycle: number;
  readonly pc: number;
  readonly cpu: { a: number; x: number; y: number; sp: number; flags: number };
  readonly runState?: string;
  /** The 25 text rows, when the VIC is in a character mode. */
  readonly screenRows?: readonly string[];
  /** Why the screen could not be read, when it could not. */
  readonly screenUnreadable?: string;
  readonly reads: readonly { read: MemoryRead; bytes: Uint8Array }[];
  /** A single-frame GIF of the last frame, when asked for. */
  readonly frame?: { bytes: Uint8Array; width: number; height: number };
  /** Why this machine is not a whole C64, when the runtime made it one. */
  readonly coreOnly?: string;
  /** Spec 900 — every check asked for, in the order decided. */
  readonly checks: readonly SandboxCheckResult[];
  /** Spec 899 D1 — the offset every input step used, when an offset option was set. */
  readonly inputs: readonly InputRecord[];
  /** Spec 899 D4 — every series read. */
  readonly series: readonly SeriesResult[];
  /** `I set the anchor` steps, as they were written. */
  readonly anchorsSet: readonly { name: string; path: string; cycle: number; pc: number; step: number }[];
  /** The `wait until` that did not happen, when the run was asked to report that as a failure. The steps after it did not run. */
  readonly failedWait?: { step: number; what: string; frames: number; detail: string };
  /** Set when the sandbox ended ITSELF — the budget, or the daemon dying. */
  readonly endedBecause: string | null;
  readonly elapsedMs: number;
  /** Spec 861 §4.5 — the capture, when one was asked for. */
  readonly trace?: {
    readonly storePath: string;
    readonly runId: string;
    readonly events: number;
    readonly anchor: { clock: number; line: number; cycle: number; cyclesPerLine: number; linesPerFrame: number };
  };
}

interface MachineState {
  c64Cycles: number;
  runState?: string;
  cpu: { pc: number; a?: number; x?: number; y?: number; sp?: number; flags?: number };
  device?: { drive8?: { ledOn?: boolean } };
  vic?: { mode?: number; screenBase?: number; colorBase?: number };
}

interface ReadMemoryResult {
  chunks: { addr: number; len: number; lens: string; bytes: string }[];
}

interface FrameIndices {
  width: number; height: number; palette: string; indices: string;
  c64Cycles: number; rasterLine: number;
}

function fnv1a(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of bytes) h = ((h ^ BigInt(b)) * prime) & mask;
  return h;
}

/**
 * Run one schedule on a private machine and report what it did. The machine is
 * started, driven and ENDED by this call; it does not exist afterwards, and its
 * failure mode is a report, not a half-open session.
 */
export async function runSandbox(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const startedAt = Date.now();
  // Refused before a daemon starts: a contradiction in the offset options costs no machine.
  const refusal = offsetRefusal(opts);
  if (refusal) throw new Error(refusal);
  // The sandbox: the one lifecycle starts it, boots it (switched on, warmed to the BASIC prompt, the medium in), and
  // ends it. This function is the script that runs between the two.
  const offsetsNeed = offsetsRequested(opts) ? "an input offset"
    : (opts.checks ?? []).some((c) => c.check.kind === "memory" && c.check.window) ? "a `throughout` check"
    : opts.steps.some((s) => s.kind === "series") ? "a series read" : undefined;
  const sb = await startSandboxSession({
    purpose: opts.purpose ?? "one-shot run", budgetMinutes: (opts.budgetMs ?? 10 * 60_000) / 60_000,
    projectDir: opts.projectDir ?? "", daemonProjectDir: opts.projectDir, mediaPath: opts.mediaPath, model: opts.model,
    driveType: opts.driveType, run: opts.run, script: true,
    boot: { mode: "basic", startExactly: opts.startExactly, ...(offsetsNeed ? { needs: offsetsNeed } : {}) },
  });
  const call = sandboxCall(sb.id);
  let outcome: "reached" | "failed" = "failed";
  let summary = "the run did not finish";
  const log: string[] = [];
  const waits: { text: string; frames: number; budget: number; cycle: number }[] = [];
  const reads: { read: MemoryRead; bytes: Uint8Array }[] = [];
  const checks: SandboxCheckResult[] = [];
  const inputs: InputRecord[] = [];
  const series: SeriesResult[] = [];
  const anchorsSet: { name: string; path: string; cycle: number; pc: number; step: number }[] = [];
  let failedWait: SandboxRunResult["failedWait"];
  /** Set when the runtime dropped this machine onto its isolated CPU core. */
  const coreOnly: string | undefined = sb.coreOnly;

  const state = (): Promise<MachineState> => call<MachineState>("session/state");
  const frameIndices = (): Promise<FrameIndices> => call<FrameIndices>("session/frame_indices");
  /** The machine as it says it is, and its frame length — re-read after anything that can
   *  replace the machine (a `.c64re` opened into it carries its own model). */
  let machine: MachineIdentity;
  let F = 0;
  // The schedule's clock, as in the reel runner: every advance runs to an absolute `due`,
  // so the few cycles each bounded run overshoots by never add up across a long wait.
  let due = 0;
  let at = 0;
  const readMachine = async (): Promise<void> => {
    const st = await state();
    machine = machineIdentity(st);
    F = machine.cyclesPerFrame;
    at = st.c64Cycles;
  };
  /** Something other than a wait moved the machine (an open, a switch): continue from it. */
  const resync = (): void => { due = at; };
  const runCycles = async (total: number): Promise<void> => {
    due += total;
    while (at < due) {
      // One run with a stop on the exact cycle (Spec 910 D10). A machine that cannot move (a JAM) does not hold the
      // schedule: its time passes, as it did when a run answered with the cycle it started at.
      const stop = await runUntil(call, undefined, { cycles: due - at, pace: "warp", wait: true, source: "sandbox" });
      at = stop.cycles > at ? stop.cycles : due;
    }
  };
  /**
   * Spec 899 D1 — the cycle an input step presses at: the point it always pressed at, plus its
   * offset. Undefined when no offset option is set, and the call then carries no `at_cycle`
   * at all — the bytes of such a run do not change. What was used is logged for the result.
   */
  const pressAt = (i: number, text: string, holdFrames?: number): number | undefined => {
    const off = inputOffsetFor(opts, i, F);
    if (off === undefined) return undefined;
    const press = at + off;
    inputs.push({ step: i, text, offset: off, pressAt: press, ...(holdFrames === undefined ? {} : { releaseAt: press + holdFrames * F }) });
    return press;
  };
  const at_ = (cycle: number | undefined, params: Record<string, unknown>): Record<string, unknown> =>
    cycle === undefined ? params : { ...params, at_cycle: cycle };
  const offsetNote = (press: number | undefined): string => (press === undefined ? "" : `, at cycle ${press}`);

  /** Moves the schedule to where a probe left the machine. */
  const landedAt = async (c64Cycles: unknown): Promise<void> => {
    if (typeof c64Cycles === "number") { at = c64Cycles; resync(); } else { await readMachine(); resync(); }
  };
  /** The line a window is sampled at: the one asked for, else the line after the visible area. */
  const probeLine = async (asked: number | undefined): Promise<number> => {
    if (asked !== undefined) {
      if (asked >= machine!.linesPerFrame) {
        throw new Error(`raster line ${asked} does not exist on ${machine!.model}, which has ${machine!.linesPerFrame} lines (0 to ${machine!.linesPerFrame - 1})`);
      }
      return asked;
    }
    return defaultProbeLine(call as Parameters<typeof defaultProbeLine>[0], machine!.model, machine!.linesPerFrame);
  };
  const probeCall = call as Parameters<typeof probeSeries>[0];
  /** `I read the series …`: one probe call over the window, the changes only. */
  const readSeries = async (i: number, step: Extract<Step, { kind: "series" }>): Promise<SeriesResult> => {
    const line = await probeLine(step.line);
    const startCycle = at;
    const r = await probeSeries(probeCall, { frames: step.frames, line, reads: step.reads });
    await landedAt(r.c64Cycles);
    return {
      step: i, text: step.text, reads: step.reads, everyFrames: step.everyFrames, frames: step.frames, line,
      startCycle, endCycle: r.c64Cycles,
      rows: step.everyFrames > 1 ? everyNth(r.rows, step.everyFrames, step.frames) : r.rows,
      samples: step.everyFrames > 1 ? Math.ceil(step.frames / step.everyFrames) : r.samples,
      changes: step.everyFrames > 1 ? Math.max(0, everyNth(r.rows, step.everyFrames, step.frames).length - 1) : r.changes,
      ...(r.stopped ? { stopped: r.stopped } : {}),
    };
  };
  const readRanges = async (ranges: RegionRange[]): Promise<Uint8Array> => {
    const r = await call<ReadMemoryResult>("session/read_memory", { ranges });
    return joinChunks(r.chunks.map((c) => new Uint8Array(Buffer.from(c.bytes, "base64"))));
  };
  /**
   * The character matrix as the VIC is addressing it — or WHY there is none.
   *
   * Two ways there is none, and they are different answers. In a bitmap mode
   * there is no character matrix at all. And on a machine that has not booted
   * the VIC's registers are still zero, so `screenBase` is $0000: reading it
   * returns the zero page rendered as screen codes, which looks like a screen
   * full of garbage and is the most convincing wrong answer this tool could
   * give. Both say so instead.
   */
  const screenCodes = async (): Promise<{ codes?: Uint8Array; why?: string }> => {
    const st = await state();
    const base = st.vic?.screenBase;
    if (base === undefined) return { why: "the machine reports no VIC screen base" };
    if (st.vic?.mode !== undefined && (st.vic.mode & 0x03) === 0x02) {
      return { why: "the VIC is in a bitmap mode, so there is no character matrix to read — ask for a frame instead" };
    }
    if (base === 0) {
      return {
        why:
          "the VIC's registers are still zero, so the machine has not finished booting — " +
          "there is no screen matrix yet, only the zero page at $0000",
      };
    }
    return { codes: await readRanges([{ addr: base & 0xffff, len: SCREEN_COLS * SCREEN_ROWS, lens: "ram" }]) };
  };

  try {
    // The lifecycle booted the machine and left it stopped at a cycle of its own making; the schedule starts there.
    await readMachine();
    resync();
    log.push(...sb.log);

    if (opts.patches) {
      // The runtime writes into a running machine through its overlay door, which restores a
      // checkpoint first. The checkpoint is taken here, a moment before, so the restore puts
      // the machine back exactly where it stands and only the patch differs.
      const cp = await call<{ ref?: { id?: string } }>("checkpoint/capture");
      const anchorId = cp?.ref?.id;
      if (!anchorId) throw new Error("the runtime took no checkpoint to write the code in against");
      const wire = opts.patches.map((p) => ({
        space: p.space, addr: p.addr & 0xffff, bytes: [...p.bytes],
        ...(p.space === "ram" ? {} : { bank: p.bank ?? 0 }),
      }));
      const wrote = await call<{ applied?: unknown[] }>("runtime/overlay_run", { anchor_id: anchorId, patches: wire, run_cycles: 0 });
      await readMachine();
      resync();
      log.push(opts.patches.length === 0
        ? "no code written (the run without a fix)"
        : `code written: ${opts.patches.map((p) => `${p.space === "ram" ? "ram" : `${p.space} bank ${p.bank ?? 0}`} ${hex4(p.addr)} (${p.bytes.length} bytes)`).join(", ")}${Array.isArray(wrote?.applied) && wrote.applied.length === opts.patches.length ? "" : " — the runtime did not confirm every write"}`);
    }

    // Spec 861 §4.5 — the capture. It opens HERE: the machine is warmed and the
    // medium is in, so the window is the schedule and nothing else. The frame
    // boundary is taken first and marked, because every raster position in the
    // evaluation is counted from it — a capture with no anchor can still be
    // evaluated for cycles, but not for lines.
    let trace: SandboxRunResult["trace"] | undefined;
    const startRecordingBefore = Math.max(0, Math.min(opts.trace?.afterSteps ?? 0, opts.steps.length));
    const startRecording = async (): Promise<void> => {
      if (!opts.trace) return;
      const boundary = await call<{ c64Cycles?: number; rasterLine?: number; rasterCycle?: number }>("session/advance_to_frame");
      await readMachine();
      resync();
      const started = await call<{ run?: { runId?: string }; outputPath?: string }>("trace/start_domains", {
        domains: [...(opts.trace.domains ?? ["c64-cpu", "memory"])],
        output: opts.trace.output,
      });
      const anchor = {
        clock: boundary.c64Cycles ?? at,
        line: boundary.rasterLine ?? 0,
        cycle: boundary.rasterCycle ?? 0,
        cyclesPerLine: machine!.cyclesPerLine,
        linesPerFrame: machine!.linesPerFrame,
      };
      const { anchorLabel } = await import("../cost/trace-cost.js");
      await call("trace/run/mark", { label: anchorLabel(anchor) });
      trace = { storePath: started.outputPath ?? opts.trace.output, runId: started.run?.runId ?? "", events: 0, anchor };
      log.push(`recording into ${trace.storePath} from the frame boundary at cycle ${anchor.clock} (line ${anchor.line}, cycle ${anchor.cycle})`);
    };
    if (startRecordingBefore === 0) await startRecording();

    await decideChecksAfter(0);
    steps: for (const [i, step] of opts.steps.entries()) {
      if (i === startRecordingBefore && i > 0) await startRecording();
      switch (step.kind) {
        case "wait":
          await runCycles(waitCycles(step, F));
          log.push(`${i}: ${step.text}`);
          break;

        case "type": {
          // `session/type` has no cycle of its own: the keys start playing when the call
          // arrives. An offset therefore runs the machine that far first, and the step's own
          // duration gives it back, so the steps after it keep their place in the schedule.
          const off = inputOffsetFor(opts, i, F);
          if (off !== undefined) {
            await runCycles(off);
            inputs.push({ step: i, text: step.text, offset: off, pressAt: at });
          }
          await call("session/type", { text: step.keys });
          // The type buffer drains as the machine runs, so a `type` with nothing
          // after it would return before a single key was pressed.
          await runCycles(Math.max(0, Math.max(F * 4, step.keys.length * KEY_CYCLES + F * 2) - (off ?? 0)));
          log.push(`${i}: ${step.text}${off === undefined ? "" : ` (pressed ${off} cycles into the frame)`}`);
          break;
        }

        case "key": {
          const press = pressAt(i, step.text, step.frames);
          for (const k of step.keys) await call("session/key_down", at_(press, { key: k, source: "sandbox" }));
          // With an offset the release is scheduled too, BEFORE the run: its cycle is a fixed
          // distance from the press, and a call made after the run could find the clock past it.
          if (press !== undefined) for (const k of step.keys) await call("session/key_up", at_(press + step.frames * F, { key: k, source: "sandbox" }));
          await runCycles(step.frames * F);
          if (press === undefined) for (const k of step.keys) await call("session/key_up", { key: k, source: "sandbox" });
          log.push(`${i}: ${step.text} (held, then released${offsetNote(press)})`);
          break;
        }

        // A hold in two halves: neither moves the clock; the steps between them happen
        // while it is held.
        case "keyDown": {
          const press = pressAt(i, step.text);
          for (const k of step.keys) await call("session/key_down", at_(press, { key: k, source: "sandbox" }));
          log.push(`${i}: ${step.text} (held until its release${offsetNote(press)})`);
          break;
        }

        case "keyUp": {
          const press = pressAt(i, step.text);
          for (const k of step.keys) await call("session/key_up", at_(press, { key: k, source: "sandbox" }));
          log.push(`${i}: ${step.text}${offsetNote(press)}`);
          break;
        }

        case "joystickDown": {
          const press = pressAt(i, step.text);
          const set: Record<string, unknown> = { port: step.port, source: "sandbox" };
          for (const d of step.directions) set[d] = true;
          await call("session/joystick_set", at_(press, set));
          log.push(`${i}: ${step.text} (held until its release${offsetNote(press)})`);
          break;
        }

        case "joystickUp": {
          const press = pressAt(i, step.text);
          await call("session/joystick_clear", at_(press, { port: step.port }));
          log.push(`${i}: ${step.text}${offsetNote(press)}`);
          break;
        }

        case "joystick": {
          const press = pressAt(i, step.text, step.frames);
          const set: Record<string, unknown> = { port: step.port, source: "sandbox" };
          for (const d of step.directions) set[d] = true;
          await call("session/joystick_set", at_(press, set));
          if (press !== undefined) await call("session/joystick_clear", at_(press + step.frames * F, { port: step.port }));
          await runCycles(step.frames * F);
          if (press === undefined) await call("session/joystick_clear", { port: step.port });
          log.push(`${i}: ${step.text} (held, then released${offsetNote(press)})`);
          break;
        }

        case "series": {
          const r = await readSeries(i, step);
          series.push(r);
          log.push(
            `${i}: ${step.text} — ${r.samples} samples, ${r.rows.length} rows (cycle ${r.startCycle} to ${r.endCycle})` +
              (r.stopped ? ` — ${describeStop(r.stopped)}` : ""),
          );
          break;
        }

        case "waitUntil": {
          let frames: number;
          try {
            frames = await waitUntil(step.predicate, step.timeoutFrames);
          } catch (e) {
            if (!(opts.waitTimeoutIsFailure && e instanceof WaitNotReached)) throw e;
            failedWait = { step: i, what: e.what, frames: e.frames, detail: e.message };
            log.push(`${i}: ${step.text} — not within ${e.frames} frames; the steps after it did not run`);
            break steps;
          }
          const at = (await state()).c64Cycles;
          waits.push({ text: step.text, frames, budget: step.timeoutFrames, cycle: at });
          log.push(`${i}: ${step.text} — after ${frames} frames (cycle ${at})`);
          break;
        }

        case "insert": {
          const path = opts.resolveMedium ? opts.resolveMedium(step.path) : step.path;
          await ejectSandboxDisk(sb.id);
          await runCycles(F * 30);
          await mountSandboxMedium(sb.id, path, "open", log);
          await readMachine();
          resync();
          await runCycles(F * 30);
          log.push(`${i}: ${step.text} -> ${path}`);
          break;
        }

        // Spec 863 — a model switch at the next frame boundary, as the live switch makes it;
        // the frames counted after it are the new model's.
        case "model": {
          const from = machine!.model;
          const r = await call<{ switchedAt?: { c64Cycles?: number } }>("session/model", { name: step.model, source: "sandbox" });
          await readMachine();
          resync();
          log.push(`${i}: ${step.text} — ${from} → ${machine!.model} at cycle ${r?.switchedAt?.c64Cycles ?? "?"}`);
          break;
        }

        case "anchor": {
          if (!opts.anchors) {
            throw new Error(`"${step.text}": this run has no project to keep an anchor in — run it from inside a project (or give --project)`);
          }
          const path = opts.anchors.pathFor(step.name);
          if (existsSync(path) && !opts.anchors.replace) {
            throw new Error(`"${step.text}": the anchor "${step.name}" already exists (${path}). Run with --replace-anchors to replace it, or give this one another name`);
          }
          const dumped = await call<{ cycle?: number; pc?: number }>("snapshot/dump", { path });
          const where = await state();
          anchorsSet.push({ name: step.name, path, cycle: dumped?.cycle ?? where.c64Cycles, pc: dumped?.pc ?? where.cpu.pc, step: i });
          log.push(`${i}: ${step.text} -> ${path} (cycle ${dumped?.cycle ?? where.c64Cycles}, PC ${hex4(dumped?.pc ?? where.cpu.pc)})`);
          break;
        }

        case "capture":
          // Refused rather than ignored: a caller who asked for a picture and got
          // a report with no picture in it would read that as a broken tool.
          throw new Error(
            `"${step.text}": a sandbox run reports, it does not assemble a reel. For a GIF ` +
              `of a playthrough use runtime_scene_reel; for one picture of THIS run set ` +
              `frame_path.`,
          );
      }
      await decideChecksAfter(i + 1);
    }

    // Spec 861 §4.5 — close the capture and build its index NOW. `wait_index`
    // is the difference between a store and a store somebody can query: without
    // it the index builds in the background and the evaluation that follows this
    // call reads an empty one.
    if (opts.trace && trace) {
      const stopped = await call<{ run?: { eventCount?: number }; status?: unknown }>("trace/run/stop", { wait_index: true });
      trace = { ...trace, events: Number(stopped.run?.eventCount ?? 0) };
      log.push(`capture finalized: ${trace.events} events in ${trace.storePath}`);
    }

    // ── the report ────────────────────────────────────────────────────────────
    let frame: { bytes: Uint8Array; width: number; height: number } | undefined;
    if (opts.wantFrame && coreOnly) {
      // Encoding the last thing the VIC drew and calling it a picture of this run
      // would be the most convincing wrong answer available.
      log.push("no frame was taken: there is no VIC sweeping to take one from");
    } else if (opts.wantFrame) {
      // A whole frame: `displayed` is the frozen previous one, so a mid-frame
      // grab returns the picture before the interesting one.
      await call("session/advance_to_frame");
      const f = await frameIndices();
      const { encodeWithin } = await import("./gif89a.js");
      const encoded = encodeWithin(
        f.width, f.height,
        new Uint8Array(Buffer.from(f.palette, "base64")),
        [{ indices: new Uint8Array(Buffer.from(f.indices, "base64")) }],
        70, 4_000_000,
      );
      frame = { bytes: encoded.bytes, width: f.width, height: f.height };
    }

    let screenRows: string[] | undefined;
    let screenUnreadable: string | undefined;
    if (opts.screen !== false) {
      const { codes, why } = await screenCodes();
      if (codes) screenRows = screenCodesToRows(codes, SCREEN_COLS).slice(0, SCREEN_ROWS);
      else screenUnreadable = why;
    }

    for (const r of opts.reads ?? []) {
      const bytes = await readRanges([{ addr: r.addr, len: r.len, lens: r.lens }]);
      reads.push({ read: r, bytes });
    }

    const end = await state();
    outcome = "reached";
    summary = `${opts.steps.length} step(s) done at cycle ${end.c64Cycles}`;
    return {
      port: sb.port,
      machine: machineIdentity(end),
      log, waits, reads, frame, screenRows, screenUnreadable, trace, checks, inputs, series, anchorsSet, failedWait,
      endCycle: end.c64Cycles,
      pc: end.cpu.pc,
      cpu: {
        a: end.cpu.a ?? 0, x: end.cpu.x ?? 0, y: end.cpu.y ?? 0,
        sp: end.cpu.sp ?? 0, flags: end.cpu.flags ?? 0,
      },
      runState: end.runState,
      coreOnly,
      endedBecause: sandboxEndedBecause(sb.id),
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    // The one end (Spec 910 D5). The budget already guarantees it; ending here is what makes the COMMON
    // case leave nothing behind rather than a daemon idling out its ten minutes.
    await endSandboxSession(sb.id, outcome, summary).catch(() => undefined);
  }

  /** Spec 900 — decide every check written after exactly `n` steps, where the run is now. */
  async function decideChecksAfter(n: number): Promise<void> {
    for (const c of opts.checks ?? []) {
      if (c.afterSteps !== n) continue;
      if (c.check.kind === "memory" && c.check.window) {
        checks.push({ ...c, ...(await decideWindow(c.check, c.check.window)) });
        continue;
      }
      const { pass, actual } = await decide(c.check);
      checks.push({ ...c, pass, actual, cycle: (await state()).c64Cycles });
    }
  }

  /**
   * Spec 899 D3 — a memory check that must hold at every frame of a window. The runtime's
   * frame probe walks the window; an `is` check runs it in assert mode, which stops at the
   * first failing frame and leaves the machine there. `is not` and `is one of` are not
   * something assert mode can say, so they read the series — which holds every change, and
   * between changes the value does not move — and fail on the first row that breaks them.
   * The window advances the machine; the schedule continues from where it ends.
   */
  async function decideWindow(
    check: Extract<Check, { kind: "memory" }>, win: { frames: number; line?: number },
  ): Promise<Pick<SandboxCheckResult, "pass" | "actual" | "cycle" | "failedAt" | "stopped">> {
    const line = await probeLine(win.line);
    const probeCall = call as Parameters<typeof probeAssert>[0];
    const stop = async (s: ProbeStop) => {
      await landedAt(s.c64Cycles);
      return { pass: false, actual: `UNDECIDED — ${describeStop(s)}`, cycle: s.c64Cycles, stopped: s };
    };
    const fail = (frame: number, cycle: number, l: number, c: number, actual: string) =>
      ({ pass: false, actual, cycle, failedAt: { frame, cycle, line: l, rasterCycle: c } });
    if (check.op === "is") {
      const r = await probeAssert(probeCall, { frames: win.frames, line, addr: check.address, lens: check.lens, expect: check.values });
      if ("stopped" in r) return stop(r.stopped);
      await landedAt(r.c64Cycles);
      if (r.held) return { pass: true, actual: `held for ${win.frames} frames`, cycle: r.c64Cycles };
      return fail(r.frame, r.c64Cycles, r.line, r.cycle, describeAssertFailure(r));
    }
    const r = await probeSeries(probeCall, { frames: win.frames, line, reads: [{ addr: check.address, len: 1, lens: check.lens, label: "" }] });
    if (r.stopped) return stop(r.stopped);
    await landedAt(r.c64Cycles);
    const bad = firstViolation(check, r.rows);
    if (bad) return fail(bad.frame, bad.c64Cycles, bad.line, bad.cycle, describeRowViolation(check, bad));
    return { pass: true, actual: `held for ${win.frames} frames`, cycle: r.c64Cycles };
  }

  async function decide(check: Check): Promise<{ pass: boolean; actual: string }> {
    const byte = (v: number): string => `$${v.toString(16).padStart(2, "0").toUpperCase()}`;
    if (check.kind === "pc") {
      const pc = (await state()).cpu.pc;
      return { pass: pc === check.address, actual: `PC ${hex4(pc)}` };
    }
    if (check.kind === "screenShows") {
      const { codes, why } = await screenCodes();
      // Unanswerable is not a pass: say why instead of reading a bitmap as text.
      if (!codes) return { pass: false, actual: `the screen cannot be read as text — ${why}` };
      const rows = screenCodesToRows(codes, SCREEN_COLS).map((r) => r.trimEnd()).filter(Boolean);
      return { pass: screenShows(codes, check.needle, SCREEN_COLS), actual: rows.slice(0, 6).join(" / ") || "a blank screen" };
    }
    const len = check.op === "is" ? check.values.length : 1;
    const got = await readRanges([{ addr: check.address, len, lens: check.lens }]);
    const actual = [...got].map(byte).join(" ");
    const pass =
      check.op === "is" ? check.values.every((v, i) => got[i] === v)
      : check.op === "isNot" ? got[0] !== check.values[0]
      : check.values.includes(got[0]);
    return { pass, actual };
  }

  /**
   * Run until the CPU FETCHES `address`, within `timeoutFrames` frames; returns the whole
   * frames that passed. The daemon's PC breakpoint matches the fetch address whatever the
   * banking (KERNAL ROM included) and a bounded run (`runUntil`) stops on it. The breakpoint is
   * removed again on every exit, so later steps run as if it had never been there.
   */
  async function waitForPc(address: number, timeoutFrames: number): Promise<number> {
    const id = "__sandbox_wait_pc__";
    if ((await state()).cpu.pc === address) return 0;
    await call("api/call", { method: "addPcBreakpoint", args: [id, address, "halt"] });
    try {
      const from = at;
      const budget = timeoutFrames * F;
      // One run with two stops: the breakpoint, and the cap at the end of the window (Spec 910 D10).
      const stop = await runUntil(call, undefined, { cycles: budget, pace: "warp", wait: true, source: "sandbox" });
      at = stop.cycles > at ? stop.cycles : at + budget;
      if ((stop.reason === "breakpoint" || stop.reason === "observer") && stop.pc === address) {
        resync();
        return Math.floor((at - from) / F);
      }
      resync();
      const st = await state();
      throw new WaitNotReached(
        describe({ kind: "pc", address }), timeoutFrames,
        `"${describe({ kind: "pc", address })}" did not happen within ${timeoutFrames} frames ` +
          `(PC now $${st.cpu.pc.toString(16).padStart(4, "0").toUpperCase()}) — no instruction ` +
          `was fetched from that address in the whole window`,
      );
    } finally {
      await call("api/call", { method: "removeBreakpoint", args: [id] });
    }
  }

  /** Advance a frame at a time until the predicate holds; returns the frame count. */
  async function waitUntil(pred: Predicate, timeoutFrames: number): Promise<number> {
    let stableFor = 0;
    let longestStable = 0;
    let lastHash: bigint | undefined;
    let everBusy = false;

    for (let elapsed = 0; elapsed < timeoutFrames; elapsed++) {
      if (pred.kind === "pc") {
        // An execution breakpoint, not a sample: code that runs for a few cycles between
        // two frame boundaries (an IRQ handler) is never the PC at one.
        return waitForPc(pred.address, timeoutFrames);
      } else if (pred.kind === "screenShows") {
        const { codes, why } = await screenCodes();
        if (codes === undefined) {
          // Unanswerable, not false. Saying so now beats timing out over a
          // thousand frames on a question the machine cannot answer at all.
          throw new Error(
            `"${describe(pred)}": ${why}. Anchor on "the drive is idle", "the screen is ` +
              `still", or a memory value.`,
          );
        }
        if (screenShows(codes, pred.needle, SCREEN_COLS)) return elapsed;
      } else if (pred.kind === "memoryIs") {
        const b = await readRanges([{ addr: pred.address, len: 1, lens: "cpu" }]);
        if (b[0] === pred.value) return elapsed;
      } else if (pred.kind === "screenStill") {
        const h = fnv1a(new Uint8Array(Buffer.from((await frameIndices()).indices, "base64")));
        if (lastHash !== undefined && h === lastHash) {
          stableFor += 1;
          longestStable = Math.max(longestStable, stableFor);
          if (stableFor >= pred.frames) return elapsed;
        } else {
          stableFor = 0;
          lastHash = h;
        }
      } else if (pred.kind === "driveIdle") {
        // "Idle" means WORKED AND STOPPED. Right after a LOAD the C64 is still
        // printing SEARCHING and the drive has not spun up, so a bare is-it-idle
        // test passes instantly. And the busy signal is the activity LED, never
        // the motor: a 1541 keeps spinning after a load finishes.
        const busy = (await state()).device?.drive8?.ledOn;
        if (busy === undefined) {
          throw new Error(
            'the machine reports no drive activity LED, so "the drive is idle" cannot be ' +
              "answered — it fails rather than guessing",
          );
        }
        if (busy) everBusy = true;
        else if (everBusy) return elapsed;
      } else {
        // regionShows / regionChanges — a region is defined by a scenario or the
        // project store, and a sandbox run has neither. Named, not ignored.
        throw new Error(
          `"${describe(pred)}": regions are defined by a capture scenario or the project ` +
            `store, and a sandbox run has neither. Use "the screen shows ...", a memory ` +
            `value, or runtime_scene_reel, which resolves regions.`,
        );
      }
      await runCycles(F);
    }

    const st = await state();
    let extra = "";
    if (pred.kind === "screenStill") {
      extra =
        `; the longest still stretch was ${longestStable} frames, short of the ${pred.frames} ` +
        `asked for — a blinking cursor or an animated screen never settles, so use ` +
        `"the drive is idle", "the CPU reaches $XXXX", or a plain wait there`;
    } else if (pred.kind === "screenShows") {
      const { codes } = await screenCodes();
      const shown = (codes ? screenCodesToRows(codes, SCREEN_COLS) : [])
        .map((r) => r.trimEnd()).filter(Boolean).slice(0, 4).join(" / ");
      extra = shown ? `; what it showed instead: ${shown}` : "; the screen was blank throughout";
    } else if (pred.kind === "driveIdle" && !everBusy) {
      extra =
        "; the drive never became busy at all, so there was no load to wait for — the " +
        "command may not have been accepted, or the keys arrived before the editor was reading";
    }
    throw new WaitNotReached(
      describe(pred), timeoutFrames,
      `"${describe(pred)}" did not happen within ${timeoutFrames} frames ` +
        `(PC now $${st.cpu.pc.toString(16).padStart(4, "0").toUpperCase()})${extra}`,
    );
  }
}

function describe(p: Predicate): string {
  switch (p.kind) {
    case "driveIdle": return "the drive is idle";
    case "screenStill": return `the screen is still for ${p.frames} frames`;
    case "pc": return `the CPU reaches $${p.address.toString(16).padStart(4, "0").toUpperCase()}`;
    case "screenShows": return `the screen shows "${p.needle}"`;
    case "regionShows": return `"${p.region}" shows "${p.needle}"`;
    case "regionChanges": return `"${p.region}" changes`;
    case "memoryIs": return `$${p.address.toString(16).padStart(4, "0").toUpperCase()} is $${p.value.toString(16).padStart(2, "0").toUpperCase()}`;
  }
}

const LENSES: readonly RegionLens[] = ["cpu", "ram", "io", "rom", "cart"];

/**
 * `$0400:1000`, `$d020:2@io`, `49152:16` — an address, a length, and which view
 * of the bus to read it through. `cpu` (the default) is what the PROGRAM sees;
 * `ram` is the bytes under the ROM and the I/O window, which is where a loader
 * hides its buffer.
 */
export function parseMemoryRead(spec: string): { read?: MemoryRead; error?: string } {
  const t = spec.trim();
  const m = /^(\$?[0-9a-f]+)\s*[:+]\s*(\$?[0-9a-f]+)\s*(?:@\s*([a-z]+))?$/i.exec(t);
  if (!m) {
    return { error: `"${spec}": a memory read is ADDRESS:LENGTH, e.g. "$0400:1000" or "$d020:2@io"` };
  }
  const num = (s: string): number => (s.startsWith("$") ? parseInt(s.slice(1), 16) : parseInt(s, 16));
  const addr = num(m[1]);
  const len = num(m[2]);
  const lens = (m[3]?.toLowerCase() ?? "cpu") as RegionLens;
  if (!Number.isFinite(addr) || addr < 0 || addr > 0xffff) return { error: `"${spec}": ${m[1]} is not a 16-bit address` };
  if (!Number.isFinite(len) || len < 1) return { error: `"${spec}": ${m[2]} is not a length` };
  if (addr + len > 0x10000) return { error: `"${spec}": reads past $FFFF (${len} bytes from $${addr.toString(16)})` };
  if (!LENSES.includes(lens)) return { error: `"${spec}": ${m[3]} is not a lens (${LENSES.join(", ")})` };
  return { read: { label: t, addr, len, lens } };
}

/** Hex dump, 16 bytes to the line, addressed from `addr`. */
export function hexDump(addr: number, bytes: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const row = bytes.subarray(i, i + 16);
    const hex = Array.from(row).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const chars = Array.from(row).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    out.push(`  $${(addr + i).toString(16).padStart(4, "0").toUpperCase()}  ${hex.padEnd(47)}  ${chars}`);
  }
  return out;
}
