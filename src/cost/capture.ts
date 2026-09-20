// Spec 861 §4.5 — the capture.
//
// A sandbox run on a machine of its own (788/836), from a frame boundary, with
// the cpu and mem channels, for the window the caller names, finalized into the
// trace store. No new runtime operation: `trace/start_domains`,
// `trace/run/mark` and `trace/run/stop` are the ones the live session uses, and
// the sandbox is the one `runtime_sandbox_run` already drives.
//
// The window is the caller's choice; the capture records ALL of it and the
// evaluation filters on query (doctrine rule 4) — never a capture narrowed to
// what somebody expected to find.

import { runSandbox } from "../reel/run-sandbox.js";
import type { Anchor } from "./trace-cost.js";

export interface CaptureOptions {
  projectDir: string;
  mediaPath: string;
  /** the `.duckdb` to write (absolute) */
  output: string;
  /** the schedule, in the capture-scenario notation; replaces `frames` */
  steps?: readonly string[];
  frames?: number;
  model?: string;
  budgetSeconds?: number;
  domains?: readonly string[];
  /** record only from after this many steps — the load is rarely what is measured */
  afterSteps?: number;
}

export interface CaptureResult {
  storePath: string;
  anchor: Anchor;
  runId: string;
  events: number;
  log: string[];
}

export async function captureRun(options: CaptureOptions): Promise<CaptureResult> {
  const { parseStep } = await import("../project-knowledge/scenario-gherkin.js");
  const lines = options.steps?.length ? [...options.steps] : [`I wait ${Math.max(1, options.frames ?? 2)} frames`];
  const steps = [];
  for (const line of lines) {
    const parsed = parseStep(line);
    if (!parsed?.step || parsed.error) throw new Error(`the capture schedule does not parse: "${line}"${parsed?.error ? ` — ${parsed.error}` : ""}`);
    if (parsed.step.kind === "capture") throw new Error(`"${line}": a cost capture records a trace, it does not assemble a reel`);
    steps.push(parsed.step);
  }

  const run = await runSandbox({
    projectDir: options.projectDir,
    mediaPath: options.mediaPath,
    steps,
    screen: false,
    budgetMs: Math.min(Math.max(options.budgetSeconds ?? 120, 1), 600) * 1000,
    ...(options.model ? { model: options.model } : {}),
    trace: {
      output: options.output,
      ...(options.domains ? { domains: options.domains } : {}),
      ...(options.afterSteps ? { afterSteps: options.afterSteps } : {}),
    },
  });

  if (!run.trace) {
    throw new Error(
      `the run finished without a capture${run.coreOnly ? ` — ${run.coreOnly}` : ""}${run.endedBecause ? ` (${run.endedBecause})` : ""}`,
    );
  }
  return {
    storePath: run.trace.storePath,
    anchor: run.trace.anchor,
    runId: run.trace.runId,
    events: run.trace.events,
    log: [...run.log, ...(run.coreOnly ? [`NOT A WHOLE MACHINE: ${run.coreOnly}`] : [])],
  };
}
