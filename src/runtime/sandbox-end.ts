// Spec 910 D5 — one end for every sandbox: finalize a recording trace, record the outcome, stop the daemon,
// remove the scratch. The same steps in the same order for every reason a sandbox ends (reached, failed, budget,
// idle, owner gone, the runtime exiting) and for every caller:
//   - the owning process (`sandbox-sessions.ts` `finish`), and
//   - the KEEPER (`reel/sandbox-session.ts`), the few lines of node that stand between the owner and the daemon and
//     end it when the owner cannot — on the budget, or because the owner is gone. The keeper loads THIS module and
//     runs the same function; it does not carry an end of its own.
//
// Order. The scratch is removed after the daemon is down, not before: the daemon's exit work writes into it (a mounted
// disk's copy, a recording trace) and a directory removed under a live daemon is recreated by it or fails its write.
// Everything before "stop" can fail without keeping the later steps from running; a failed step is reported, not hidden.
//
// This module imports nothing heavy at load time (the step log is loaded when it is written), so a keeper can load it
// in well under a second.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, stateDir, writeJsonAtomic } from "./state-dir.js";

export type EndReason = "reached" | "failed" | "budget" | "idle" | "owner gone" | "runtime exited";

export interface SandboxRecord {
  v: 1;
  id: string;
  ownerPid: number;
  port: number;
  purpose: string;
  projectDir: string;
  model?: string;
  media?: string;
  /** Spec 909 — sha256 of the bytes of the medium the sandbox was started with: which image a capture of this session ran */
  mediaSha256?: string;
  startedAt: string;
  deadline: string;
  budgetMinutes: number;
  idleMinutes: number;
  state: "running" | "ended";
  reason?: string;
  outcome?: string;
  summary?: string;
  endedAt?: string;
  durationSec?: number;
  artefacts?: string[];
  /** The outcome is in the project's step log. An owner that died could not write it; the next process to look does. */
  logged?: boolean;
}

export interface EndInfo {
  id: string;
  reason: EndReason;
  outcome: string;
  summary?: string;
  endedAt: string;
  durationSec: number;
  purpose: string;
  artefacts: string[];
  /** Whether the outcome reached the project's step log, and if not why. */
  recorded: string;
}

export function recordsDir(): string { return join(stateDir(), "sandbox-sessions"); }
export const recordFile = (id: string): string => join(recordsDir(), `${id}.json`);

export const iso = (ms: number): string => new Date(ms).toISOString();

export function existingFiles(paths: Iterable<string>): string[] {
  return [...paths].filter((p) => { try { return existsSync(p); } catch { return false; } });
}

export async function recordOutcome(projectDir: string, i: EndInfo): Promise<string> {
  try {
    const { recordAgentStepFromCode } = await import("../project-knowledge/agent-state.js");
    const line = `Sandbox session ${i.id} ended (${i.outcome}) after ${i.durationSec}s — purpose: ${i.purpose}` +
      (i.summary ? ` — ${i.summary}` : "") + (i.artefacts.length ? ` — kept: ${i.artefacts.join(", ")}` : "");
    recordAgentStepFromCode(projectDir, line);
    return `recorded in the step log of ${projectDir}`;
  } catch (e) {
    return `not recorded in a step log (${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * A session whose outcome is in its record but not in the project's step log (the owner died before it could write
 * it, or the keeper ended it) has it written once, by whoever looks next. Returns the record as it stands afterwards.
 */
export async function reconcileRecord(rec: SandboxRecord): Promise<SandboxRecord> {
  if (rec.state !== "ended" || rec.logged) return rec;
  const endedMs = rec.endedAt ? Date.parse(rec.endedAt) : Date.now();
  const info: EndInfo = {
    id: rec.id, reason: (rec.reason ?? "runtime exited") as EndReason, outcome: rec.outcome ?? rec.reason ?? "ended",
    summary: rec.summary, endedAt: rec.endedAt ?? iso(endedMs), purpose: rec.purpose,
    durationSec: rec.durationSec ?? Math.max(0, Math.round((endedMs - Date.parse(rec.startedAt)) / 1000)),
    artefacts: existingFiles(rec.artefacts ?? []), recorded: "not recorded",
  };
  // Claim it first: two processes looking at once write one entry, not two.
  const claimed: SandboxRecord = { ...rec, logged: true, durationSec: info.durationSec, artefacts: info.artefacts };
  try { writeJsonAtomic(recordFile(rec.id), claimed); } catch { return rec; }
  const r = await recordOutcome(rec.projectDir, info);
  if (!r.startsWith("recorded")) {
    try { writeJsonAtomic(recordFile(rec.id), { ...claimed, logged: false }); } catch { /* best effort */ }
    return rec;
  }
  return claimed;
}

/** A daemon call, while the daemon is up. */
export type DaemonCall = (method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

export interface EndSteps {
  /** Talks to the daemon while it is up. Absent when the daemon is already gone (the runtime exited). */
  call?: DaemonCall;
  /** Files the session produced that outlive it (a trace); finalizing adds the trace it stopped. */
  captures: Set<string>;
  /** Writes the outcome: the record file and the project's step log. */
  record: () => Promise<void>;
  /** The daemon goes away (and its keeper with it). */
  stop: () => Promise<void>;
  /** The temp dir holding the scratch and the copies of every medium. */
  scratchDir: string | null;
}

export const END_ORDER = ["finalize", "record", "stop", "scratch"] as const;
export type EndStep = typeof END_ORDER[number];

/** Finish a trace in progress, not lose it: the .c64retrace is the authority and its index is built on first read. */
export async function finalizeTrace(call: DaemonCall, captures: Set<string>): Promise<void> {
  const st = await call("trace/run/status", {}, 5_000) as { active?: boolean; retracePath?: string } | undefined;
  if (!st?.active) return;
  if (st.retracePath) captures.add(st.retracePath);
  const stopped = await call("trace/run/stop", { wait_index: false }, 120_000) as { index?: { duckdbPath?: string; retracePath?: string } } | undefined;
  for (const p of [stopped?.index?.retracePath, stopped?.index?.duckdbPath]) if (p) captures.add(p);
}

/**
 * The one end. Runs finalize → record → stop → scratch, each step on its own: a step that fails is returned in
 * `failed` and does not keep the daemon from being stopped or the scratch from being removed.
 */
export async function endSandbox(s: EndSteps): Promise<{ done: EndStep[]; failed: { step: EndStep; error: string }[] }> {
  const done: EndStep[] = [];
  const failed: { step: EndStep; error: string }[] = [];
  const run = async (step: EndStep, fn: () => Promise<void> | void): Promise<void> => {
    try { await fn(); done.push(step); } catch (e) { failed.push({ step, error: e instanceof Error ? e.message : String(e) }); }
  };
  await run("finalize", async () => { if (s.call) await finalizeTrace(s.call, s.captures); });
  await run("record", s.record);
  await run("stop", s.stop);
  await run("scratch", () => { if (s.scratchDir) rmSync(s.scratchDir, { recursive: true, force: true }); });
  return { done, failed };
}

/** A JSON-RPC client over the platform's own WebSocket, for a process that holds no connection (the keeper). */
export async function wsCall(port: number): Promise<{ call: DaemonCall; close: () => void }> {
  const W = (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
  const ws = new W(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not connect to the daemon"));
  });
  let n = 1;
  const pending = new Map<number, (v: { result?: unknown; error?: { message?: string } }) => void>();
  ws.onmessage = (m: MessageEvent) => {
    if (typeof m.data !== "string") return;
    try {
      const j = JSON.parse(m.data) as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof j.id === "number" && pending.has(j.id)) { pending.get(j.id)!(j); pending.delete(j.id); }
    } catch { /* an A/V frame */ }
  };
  const call: DaemonCall = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = n++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer within ${timeoutMs} ms`)); }, timeoutMs);
    pending.set(id, (j) => { clearTimeout(timer); if (j.error) reject(new Error(j.error.message ?? "error")); else resolve(j.result); });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: { session_id: "integrated-1", ...params } }));
  });
  return { call, close: () => { try { ws.close(); } catch { /* going away */ } } };
}

/**
 * The end as the KEEPER takes it, when the owner cannot: the record names the session, the keeper knows the port, the
 * reason and the scratch. The same `endSandbox`, with the steps' bodies made from the record.
 */
export async function endFromKeeper(o: {
  recordPath: string; port: number; reason: EndReason; scratchDir: string; stopDaemon: () => Promise<void>;
}): Promise<void> {
  const rec = readJson<SandboxRecord>(o.recordPath);
  const captures = new Set<string>(rec?.artefacts ?? []);
  let conn: Awaited<ReturnType<typeof wsCall>> | undefined;
  try { conn = await wsCall(o.port); } catch { conn = undefined; }
  await endSandbox({
    call: conn?.call,
    captures,
    scratchDir: o.scratchDir || null,
    record: async () => {
      // The owner may have ended it already; then there is nothing to say twice.
      const cur = readJson<SandboxRecord>(o.recordPath);
      if (!cur || cur.state !== "running") return;
      const now = Date.now();
      const ended: SandboxRecord = {
        ...cur, state: "ended", reason: o.reason, outcome: o.reason, endedAt: iso(now),
        durationSec: Math.round((now - Date.parse(cur.startedAt)) / 1000), artefacts: existingFiles(captures),
      };
      writeJsonAtomic(o.recordPath, ended);
      await reconcileRecord(ended);
    },
    stop: async () => {
      try { await conn?.call("daemon/shutdown", {}, 3_000); } catch { /* it closes the socket as it answers */ }
      conn?.close();
      await o.stopDaemon();
    },
  });
}
