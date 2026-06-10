// BUG-039 — in-process job registry for long-running analysis tools.
//
// The MCP host enforces a per-tool stall limit (~180s). analyze_prg on a large
// PRG exceeds it; the host then declares the call "stalled" and DROPS the whole
// stdio connection ("MCP disconnected"). Pattern: the tool starts its work as a
// job, waits a grace window (small inputs return synchronously, identical UX),
// and past the grace returns { job_id } immediately — the work continues and
// `analysis_job_status` polls for the finished result.
//
// Jobs live in THIS process only. If the MCP server restarts, the registry is
// gone — but the pipeline writes its output to disk regardless, so the status
// tool points the caller at the output file as the fallback.

export interface AnalysisJob {
  id: string;
  tool: string;
  /** Human pointer to the on-disk output (survives an MCP restart). */
  outputPath: string;
  startedAtMs: number;
  state: "running" | "done" | "failed";
  /** The tool's full content result, stored verbatim for the status poll. */
  result?: unknown;
  error?: string;
}

const jobs = new Map<string, AnalysisJob>();
let seq = 0;

/** Start `work` immediately; never throws (failures land in job.state). */
export function startAnalysisJob(tool: string, outputPath: string, work: () => Promise<unknown>): AnalysisJob {
  const job: AnalysisJob = {
    id: `${tool}-${Date.now().toString(36)}-${++seq}`,
    tool, outputPath, startedAtMs: Date.now(), state: "running",
  };
  jobs.set(job.id, job);
  void work().then(
    (result) => { job.state = "done"; job.result = result; },
    (e) => { job.state = "failed"; job.error = e instanceof Error ? (e.stack ?? e.message) : String(e); },
  );
  // Bound the registry: drop finished jobs after an hour (poll long done by then).
  const t = setTimeout(() => { if (jobs.get(job.id)?.state !== "running") jobs.delete(job.id); }, 3_600_000);
  (t as { unref?: () => void }).unref?.();
  return job;
}

/** Wait up to `graceMs` for the job to settle. True = settled (done OR failed). */
export async function waitForJob(job: AnalysisJob, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (job.state === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return job.state !== "running";
}

export function getAnalysisJob(id: string): AnalysisJob | undefined {
  return jobs.get(id);
}
