// Spec 899 D2 — the same steps, K times, with the input at K places in the frame.
//
// Each run is its own sandbox daemon (a fresh machine, its own port, its own budget), so a
// sweep keeps every rule of `runSandbox`: nothing here can reach the shared session, and
// every machine ends itself. Offsets are spread evenly across ONE FRAME OF THE MACHINE'S
// MODEL — the frame length is read from the first machine, never assumed.

import { runSandbox, type SandboxCheckResult, type SandboxRunOptions, type SandboxRunResult } from "./run-sandbox.js";
import { sweepOffsets } from "./input-offset.js";
import { PROBE_RUNTIME_NEED } from "./frame-probe.js";

export const MAX_SWEEP = 64;

export interface SweepRun {
  readonly offset: number;
  /** FAIL: a check did not hold. ERROR: the run itself did not finish (or a probe stopped on a breakpoint). */
  readonly verdict: "PASS" | "FAIL" | "ERROR";
  readonly checks: readonly SandboxCheckResult[];
  readonly error?: string;
  readonly result?: SandboxRunResult;
}

export interface SweepResult {
  readonly count: number;
  readonly machine: SandboxRunResult["machine"];
  readonly cyclesPerFrame: number;
  /** In offset order. */
  readonly runs: readonly SweepRun[];
  /** The lowest offset that FAILED; run again with `input_offset_cycles` set to it. */
  readonly firstFailing?: number;
  readonly pass: number;
  readonly fail: number;
  readonly error: number;
}

const verdictOf = (checks: readonly SandboxCheckResult[]): "PASS" | "FAIL" | "ERROR" =>
  checks.some((c) => c.stopped) ? "ERROR" : checks.some((c) => !c.pass) ? "FAIL" : "PASS";

export function sweepRefusal(opts: SandboxRunOptions, count: number): string | undefined {
  if (!Number.isInteger(count) || count < 2 || count > MAX_SWEEP) return `sweep is a number of runs, 2 to ${MAX_SWEEP} (got ${count})`;
  if (opts.inputOffsetCycles !== undefined || opts.jitterSeed !== undefined) {
    return "a sweep chooses the offsets itself — give sweep, or input_offset_cycles, or jitter_seed";
  }
  if (!(opts.checks?.length)) return "a sweep needs at least one `Then` to decide each offset by";
  if (!opts.steps.some((s) => s.kind === "key" || s.kind === "joystick" || s.kind === "keyDown" || s.kind === "keyUp" || s.kind === "joystickDown" || s.kind === "joystickUp" || s.kind === "type")) {
    return "a sweep moves input inside the frame, and these steps press nothing";
  }
  return undefined;
}

/**
 * Run `opts` `count` times, offset i = floor(i * frame / count). The first run (offset 0)
 * goes alone because it tells the frame length; the rest run side by side, `jobs` at a time —
 * a machine's result does not depend on what else is running.
 */
export async function runSweep(opts: SandboxRunOptions, count: number, jobs = 4): Promise<SweepResult> {
  const why = sweepRefusal(opts, count);
  if (why) throw new Error(why);

  const one = async (offset: number): Promise<SweepRun> => {
    try {
      const result = await runSandbox({ ...opts, inputOffsetCycles: offset });
      return { offset, verdict: verdictOf(result.checks), checks: result.checks, result };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // A runtime that cannot place input is not an offset that failed: say so once, loudly.
      if (error.includes(PROBE_RUNTIME_NEED) || /runtime is not available|no runtime binary/i.test(error)) throw e;
      return { offset, verdict: "ERROR", checks: [], error };
    }
  };

  const first = await one(0);
  if (!first.result) throw new Error(`the first run of the sweep (offset 0) did not finish: ${first.error}`);
  const F = first.result.machine.cyclesPerFrame;
  const offsets = sweepOffsets(count, F);
  const runs: SweepRun[] = new Array(count);
  runs[0] = first;
  let next = 1;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      runs[i] = await one(offsets[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, count - 1) }, worker));

  const failing = runs.find((r) => r.verdict === "FAIL");
  return {
    count, machine: first.result.machine, cyclesPerFrame: F, runs,
    ...(failing ? { firstFailing: failing.offset } : {}),
    pass: runs.filter((r) => r.verdict === "PASS").length,
    fail: runs.filter((r) => r.verdict === "FAIL").length,
    error: runs.filter((r) => r.verdict === "ERROR").length,
  };
}
