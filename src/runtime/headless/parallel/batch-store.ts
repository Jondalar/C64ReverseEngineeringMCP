// Spec 271 — In-process batch state store.
//
// Tracks running / completed parallel batches for the poll-based MCP API.
// Batches are identified by a short batchId (random hex).

import { randomBytes } from "node:crypto";
import type { ReplayResult } from "../v2/scenario.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchStatus = "running" | "done" | "error";

export interface BatchEntry {
  batchId: string;
  scenarioIds: string[];
  workerCount: number;
  status: BatchStatus;
  completed: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  results?: Map<string, ReplayResult | Error>;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const store = new Map<string, BatchEntry>();

export function createBatch(scenarioIds: string[], workerCount: number): BatchEntry {
  const batchId = randomBytes(6).toString("hex");
  const entry: BatchEntry = {
    batchId,
    scenarioIds: [...scenarioIds],
    workerCount,
    status: "running",
    completed: 0,
    total: scenarioIds.length,
    startedAt: new Date().toISOString(),
  };
  store.set(batchId, entry);
  return entry;
}

export function getBatch(batchId: string): BatchEntry | undefined {
  return store.get(batchId);
}

export function updateProgress(batchId: string, completed: number): void {
  const entry = store.get(batchId);
  if (entry) entry.completed = completed;
}

export function completeBatch(
  batchId: string,
  results: Map<string, ReplayResult | Error>,
): void {
  const entry = store.get(batchId);
  if (!entry) return;
  entry.status = "done";
  entry.completed = entry.total;
  entry.finishedAt = new Date().toISOString();
  entry.results = results;
}

export function failBatch(batchId: string, error: string): void {
  const entry = store.get(batchId);
  if (!entry) return;
  entry.status = "error";
  entry.finishedAt = new Date().toISOString();
  entry.lastError = error;
}

/** Serialise BatchEntry for JSON output (no Map). */
export function serialiseBatch(entry: BatchEntry): object {
  return {
    batchId: entry.batchId,
    status: entry.status,
    completed: entry.completed,
    total: entry.total,
    workerCount: entry.workerCount,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    lastError: entry.lastError,
  };
}

/** Serialise results Map for JSON (ReplayResult or error). */
export function serialiseResults(entry: BatchEntry): object {
  if (!entry.results) return {};
  const out: Record<string, object> = {};
  for (const [id, v] of entry.results) {
    if (v instanceof Error) {
      out[id] = { error: v.message };
    } else {
      out[id] = v;
    }
  }
  return out;
}
