// Spec 906 D6 — a call that can outlive the host's patience answers a job id instead.
//
// The MCP host drops the whole stdio connection when one tool call says nothing for ~3 minutes
// ("MCP disconnected"). A run of tens of millions of cycles with the drive-mechanism lane armed, or
// the index build of the capture it wrote, takes longer. Same shape as `analyze_prg` and
// `runtime_loader_lens` (analysis-jobs.ts): the work starts as a job, the call waits a grace window
// — a normal call settles inside it and answers exactly as before — and past the grace it returns
// `job_id`; `analysis_job_status` hands over the finished answer.
//
// The daemon is single-machine: while a job runs, other calls on that session queue behind it in the
// daemon. The answer says so. The job is accounted as activity by the sandbox's idle clock (a call in
// flight is not idleness) and ends with the sandbox, whose budget bounds it.

import { isSandboxId } from "../runtime/sandbox-parity.js";
import { startAnalysisJob, waitForJob } from "./analysis-jobs.js";

type ToolResult = { content: { type: "text"; text: string }[] };

/** How long a call may block before it becomes a job. Well under the host's ~180 s stall limit. */
export function jobGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.C64RE_JOB_GRACE_MS);
  return Number.isFinite(n) && n >= 0 && env.C64RE_JOB_GRACE_MS !== undefined && env.C64RE_JOB_GRACE_MS !== "" ? n : 100_000;
}

/** Run `work`; if it has not settled inside the grace window, answer with a job id and let it go on. */
export async function inlineOrJob(tool: string, sessionId: string, what: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  const job = startAnalysisJob(tool, what, work);
  if (await waitForJob(job, jobGraceMs())) {
    if (job.state === "failed") throw new Error(job.error?.split("\n")[0] ?? `${tool} failed`);
    return job.result as ToolResult;
  }
  return { content: [{ type: "text" as const, text: [
    `${tool} on ${sessionId} is still running — it switched to background job mode (a host drops a call that stays silent for ~3 minutes).`,
    `job_id: ${job.id}`,
    `Poll with analysis_job_status { job_id } every ~30s; it returns this tool's own answer when the work is done. Do NOT call ${tool} again for this run.`,
    `The machine is single: another call on ${sessionId} waits in the daemon until this one is finished.`,
  ].join("\n") }] };
}

/** A long-running call becomes a job on a sandbox session; on the shared session it stays one call, as before. */
export function jobOnSandbox(tool: string, sessionId: string, what: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  return isSandboxId(sessionId) ? inlineOrJob(tool, sessionId, what, work) : work();
}

/**
 * How long `trace/run/stop {wait_index: true}` may take. The client's default (60 s) is what killed the
 * shared session's finalize on a big capture; the index build grows with the events, so the allowance
 * does too — 2 minutes plus a quarter of a millisecond per event, at most an hour.
 */
export function finalizeTimeoutMs(eventCount: number | undefined): number {
  const events = typeof eventCount === "number" && eventCount > 0 ? eventCount : 0;
  return Math.min(3_600_000, Math.max(120_000, 120_000 + Math.round(events * 0.25)));
}

/** A call that gave up waiting: the shared client's "runtime daemon timeout: …" and the sandbox's "… did not answer within …". */
export function isCallTimeout(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /runtime daemon timeout|did not answer within/i.test(m);
}
