// Spec 271 — Distributed scenario runner: worker pool coordinator.
//
// WorkerPool manages N worker threads.  Each worker is a fresh node process
// running scenario-worker.ts.  Workers are re-spawned on crash.
//
// runBatch(ids) → Promise<Map<id, ReplayResult | Error>>
//
// Pool size = min(ids.length, os.cpus().length - 1), minimum 1.
// Progress callback fires after each scenario completes.

import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import type { ReplayResult } from "../v2/scenario.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchProgress = (completed: number, total: number, currentId?: string) => void;

export interface WorkerPoolOptions {
  /** Number of parallel workers.  Defaults to min(ids.length, cpus-1). */
  workerCount?: number;
  /** Called each time a scenario finishes (success or failure). */
  onProgress?: BatchProgress;
  /** projectDir to propagate to workers (sets C64RE_PROJECT_DIR). */
  projectDir?: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Resolve the compiled worker JS path from the dist tree. */
function workerScriptPath(): string {
  // __filename = dist/runtime/headless/parallel/scenario-pool.js at runtime.
  // worker = dist/runtime/headless/parallel/scenario-worker.js
  const here = fileURLToPath(import.meta.url);
  return resolvePath(here, "..", "scenario-worker.js");
}

interface PendingJob {
  scenarioId: string;
  resolve: (r: ReplayResult) => void;
  reject: (e: Error) => void;
}

// ---------------------------------------------------------------------------
// WorkerPool
// ---------------------------------------------------------------------------

export class WorkerPool {
  private workerCount: number;
  private onProgress: BatchProgress;
  private projectDir?: string;

  constructor(opts: WorkerPoolOptions = {}) {
    this.onProgress = opts.onProgress ?? (() => {});
    this.projectDir = opts.projectDir ?? process.env.C64RE_PROJECT_DIR;
    // workerCount resolved per-batch (depends on ids.length).
    this.workerCount = opts.workerCount ?? 0; // 0 = auto
  }

  /**
   * Run a batch of scenarios in parallel.
   * Returns a Map from scenarioId → ReplayResult or Error.
   */
  async runBatch(scenarioIds: string[]): Promise<Map<string, ReplayResult | Error>> {
    const total = scenarioIds.length;
    if (total === 0) return new Map();

    const n = this.workerCount > 0
      ? this.workerCount
      : Math.max(1, Math.min(total, Math.max(1, cpus().length - 1)));

    const results = new Map<string, ReplayResult | Error>();
    let completed = 0;
    const queue = [...scenarioIds];

    // One promise per slot; we'll run n slots concurrently.
    const runSlot = async (): Promise<void> => {
      while (queue.length > 0) {
        const id = queue.shift()!;
        try {
          const result = await this.runOne(id);
          results.set(id, result);
        } catch (e: unknown) {
          results.set(id, e instanceof Error ? e : new Error(String(e)));
        }
        completed++;
        this.onProgress(completed, total, id);
      }
    };

    const slots: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      slots.push(runSlot());
    }
    await Promise.all(slots);

    return results;
  }

  /** Run a single scenario in a fresh worker, resolve with ReplayResult. */
  private runOne(scenarioId: string): Promise<ReplayResult> {
    return new Promise<ReplayResult>((resolve, reject) => {
      const scriptPath = workerScriptPath();
      const worker = new Worker(scriptPath, {
        workerData: { projectDir: this.projectDir },
      });

      const cleanup = (): void => {
        worker.removeAllListeners();
      };

      worker.once("message", (msg: { result?: ReplayResult; error?: string }) => {
        cleanup();
        worker.terminate().catch(() => {});
        if (msg.error) {
          reject(new Error(msg.error));
        } else if (msg.result) {
          resolve(msg.result);
        } else {
          reject(new Error(`worker returned unexpected message for ${scenarioId}`));
        }
      });

      worker.once("error", (err: Error) => {
        cleanup();
        worker.terminate().catch(() => {});
        reject(new Error(`worker crashed (${scenarioId}): ${err.message}`));
      });

      worker.once("exit", (code: number) => {
        // If we got here without a message, the worker died unexpectedly.
        cleanup();
        if (code !== 0) {
          reject(new Error(`worker exited code ${code} (${scenarioId})`));
        }
      });

      worker.postMessage({ scenarioId });
    });
  }
}

// ---------------------------------------------------------------------------
// Convenience export — resolves pool size for a given list of ids.
// ---------------------------------------------------------------------------

export function resolveWorkerCount(scenarioCount: number, requested?: number): number {
  if (requested !== undefined && requested > 0) return requested;
  return Math.max(1, Math.min(scenarioCount, Math.max(1, cpus().length - 1)));
}
