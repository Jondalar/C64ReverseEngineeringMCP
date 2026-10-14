// Spec 906 — sandbox SESSIONS: a daemon of the LLM's own, started for a purpose, driven call after
// call by the same `runtime_*` tools that drive the shared session, and ended on reached / failed /
// budget / idle / owner gone.
//
// Why this exists next to `runtime_sandbox_run`: that tool is one call and then the machine is gone,
// so nothing could step it, breakpoint it, trace it or read it a second time. Two LLM sessions that
// both needed to do that had only the ONE shared machine, and competed for it. A session is the
// same private daemon (`SandboxSession`: own port, keeper, ledger, scratch) that stays until its
// purpose is done. The defect Spec 836 guarded against — debugging against a forgotten machine —
// is prevented by what a session is born with, not by refusing a second call: a stated purpose, a
// budget, an idle limit, and an end that does not depend on anybody remembering.
//
// Ownership. A session id (`sb-<slug>-<n>`) belongs to the MCP process that started it. Its record
// lives under the state directory, so ANOTHER process can tell "not yours" from "ended" from "never
// existed" — the keeper (a child of the owner, parent of the daemon) writes "budget" / "owner gone"
// into the record when the owner can no longer say so itself.
//
// This module is the registry in THIS process; `backend.ts` routes a tool call whose `session_id` is
// a sandbox's here. It never touches the shared endpoint.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { SandboxSession } from "../reel/sandbox-session.js";
import { assertNotShared } from "../reel/run-sandbox.js";
import { bootSandbox } from "../reel/session-boot.js";
import { describeMachine } from "./machine-model.js";
import { isSandboxId } from "./sandbox-parity.js";
import { readJson, removeFile, stateDir, writeJsonAtomic } from "./state-dir.js";
import type { DriveBoard } from "../reel/drive-board.js";

/** At most this many live sandbox sessions per MCP process (ports, cores). */
export const MAX_LIVE_SESSIONS = 4;
export const MAX_BUDGET_MINUTES = 240;
export const DEFAULT_IDLE_MINUTES = 10;
/** The most a routed call may wait for the daemon, however long the budget (a call outlives nothing). */
const MAX_CALL_MS = 4 * 60 * 60_000;
/** How long the SandboxSession's own reaper trails mine, so that mine — which can say WHY — wins. */
const REAPER_TRAIL_MS = 2_000;
/** Records of ended sessions are kept this long for the next process to ask about. */
const ENDED_RECORD_KEEP_MS = 7 * 24 * 3_600_000;

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

interface Live {
  id: string;
  box: SandboxSession;
  rec: SandboxRecord;
  recFile: string;
  startedMs: number;
  budgetMs: number;
  idleMs: number;
  lastActivity: number;
  inflight: number;
  budgetTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  captures: Set<string>;
  finishing?: Promise<EndInfo>;
  endingReason?: EndReason;
}

const live = new Map<string, Live>();
const ended = new Map<string, EndInfo>();

export function recordsDir(): string { return join(stateDir(), "sandbox-sessions"); }
const recordFile = (id: string): string => join(recordsDir(), `${id}.json`);

function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function slug(purpose: string): string {
  const s = purpose.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 14).replace(/-+$/g, "");
  return s || "work";
}

function freeId(purpose: string): string {
  const base = `sb-${slug(purpose)}`;
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`;
    if (!live.has(id) && !ended.has(id) && !existsSync(recordFile(id))) return id;
  }
}

function pruneOldRecords(): void {
  try {
    for (const n of readdirSync(recordsDir())) {
      if (!n.endsWith(".json")) continue;
      const f = join(recordsDir(), n);
      const r = readJson<SandboxRecord>(f);
      const old = Date.now() - statSync(f).mtimeMs > ENDED_RECORD_KEEP_MS;
      if (!r || (r.state === "ended" && old) || (r.state === "running" && !ownerAlive(r.ownerPid) && old)) removeFile(f);
    }
  } catch { /* no directory yet */ }
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Log the outcome of every session that ended without its owner (see `reconcileRecord`). */
async function sweepUnlogged(): Promise<void> {
  try {
    for (const n of readdirSync(recordsDir())) {
      if (!n.endsWith(".json")) continue;
      const rec = readJson<SandboxRecord>(join(recordsDir(), n));
      if (rec && rec.state === "ended" && !rec.logged) await reconcileRecord(rec);
    }
  } catch { /* no directory yet */ }
}

export interface StartSandboxOptions {
  purpose: string;
  budgetMinutes: number;
  projectDir: string;
  mediaPath?: string;
  model?: string;
  driveType?: DriveBoard;
  run?: number;
  idleMinutes?: number;
}

export interface StartedSandbox {
  id: string;
  port: number;
  deadline: string;
  idleMinutes: number;
  machine: string;
  log: string[];
  cycle: number;
  pc: number;
  projectDir: string;
  mediaCopy?: string;
}

/** The refusal for the 5th live session: names the four and their purposes. */
function tooMany(): Error {
  const rows = [...live.values()].map((e) => `  ${e.id} — ${e.rec.purpose} (until ${e.rec.deadline})`);
  return new Error(
    `runtime_sandbox_start: this MCP process already holds ${MAX_LIVE_SESSIONS} sandbox sessions (a port and a core each):\n${rows.join("\n")}\n` +
    `End one with runtime_sandbox_end { session_id, outcome, summary } when its purpose is reached or failed. Nothing was started.`);
}

/** Start a sandbox session: daemon, boot, medium in, record written, timers armed. */
export async function startSandboxSession(o: StartSandboxOptions): Promise<StartedSandbox> {
  if (live.size >= MAX_LIVE_SESSIONS) throw tooMany();
  pruneOldRecords();
  await sweepUnlogged();
  const budgetMs = Math.round(o.budgetMinutes * 60_000);
  const idleMs = Math.round((o.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000);
  const id = freeId(o.purpose);
  const startedMs = Date.now();
  const rec: SandboxRecord = {
    v: 1, id, ownerPid: process.pid, port: 0, purpose: o.purpose, projectDir: o.projectDir,
    model: o.model, media: o.mediaPath, startedAt: iso(startedMs), deadline: iso(startedMs + budgetMs),
    budgetMinutes: o.budgetMinutes, idleMinutes: idleMs / 60_000, state: "running",
  };
  const recFile = recordFile(id);
  // The record exists BEFORE the daemon does: the keeper that will end it reads this file.
  writeJsonAtomic(recFile, rec);

  let entry: Live | undefined;
  let box: SandboxSession;
  try {
    box = await SandboxSession.start({
      budgetMs: budgetMs + REAPER_TRAIL_MS, model: o.model, recordFile: recFile,
      onExit: (why) => { if (entry) void finish(entry, "runtime exited", why); },
    });
  } catch (e) {
    removeFile(recFile);
    throw e;
  }
  entry = {
    id, box, rec: { ...rec, port: box.port }, recFile, startedMs, budgetMs, idleMs,
    lastActivity: Date.now(), inflight: 0, captures: new Set(),
  };
  writeJsonAtomic(recFile, entry.rec);
  live.set(id, entry);
  try {
    assertNotShared(box.port);
    // A medium is mounted as a COPY in the session's scratch: the runtime writes a mounted disk or
    // cartridge back to the file it was opened from when the machine ends, and a session that
    // debugs a copy protection (or just a LOAD that saves) must not change the project's image.
    let mediaCopy: string | undefined;
    if (o.mediaPath) {
      const scratch = box.scratchDir;
      if (!scratch) throw new Error("the sandbox has no scratch directory to hold its copy of the medium");
      const dir = join(scratch, "media");
      mkdirSync(dir, { recursive: true });
      mediaCopy = join(dir, basename(o.mediaPath));
      copyFileSync(o.mediaPath, mediaCopy);
    }
    const booted = await bootSandbox(box.call.bind(box) as Parameters<typeof bootSandbox>[0], {
      mediaPath: mediaCopy, run: o.run, driveType: o.driveType,
    });
    armTimers(entry);
    return {
      id, port: box.port, deadline: entry.rec.deadline, idleMinutes: idleMs / 60_000,
      machine: describeMachine(booted.machine), log: booted.log, cycle: booted.cycle, pc: booted.pc,
      projectDir: o.projectDir, mediaCopy,
    };
  } catch (e) {
    await finish(entry, "failed", `could not start: ${e instanceof Error ? e.message : String(e)}`, false);
    throw e;
  }
}

function armTimers(e: Live): void {
  const left = e.startedMs + e.budgetMs - Date.now();
  e.budgetTimer = setTimeout(() => { void finish(e, "budget"); }, Math.max(0, left));
  e.budgetTimer.unref?.();
  scheduleIdle(e);
}

function scheduleIdle(e: Live): void {
  if (e.idleTimer) clearTimeout(e.idleTimer);
  const wait = Math.max(50, e.lastActivity + e.idleMs - Date.now());
  e.idleTimer = setTimeout(() => {
    // A call in flight is activity — a run of minutes is not idleness.
    if (e.inflight > 0 || Date.now() - e.lastActivity < e.idleMs) { scheduleIdle(e); return; }
    void finish(e, "idle");
  }, wait);
  e.idleTimer.unref?.();
}

function existingFiles(paths: Iterable<string>): string[] {
  return [...paths].filter((p) => { try { return existsSync(p); } catch { return false; } });
}

/** End a session: finish a trace, shut the daemon down, remove its scratch, close the record, log the outcome. */
async function finish(e: Live, reason: EndReason, summary?: string, record = true): Promise<EndInfo> {
  if (e.finishing) return e.finishing;
  e.endingReason = reason;
  e.finishing = (async () => {
    if (e.budgetTimer) clearTimeout(e.budgetTimer);
    if (e.idleTimer) clearTimeout(e.idleTimer);
    // A trace in progress is finished, not lost: the .c64retrace is the authority and its index is
    // built on the first read, so stopping without waiting for the index is enough — and quick.
    if (reason !== "runtime exited") {
      try {
        const st = await e.box.call<{ active?: boolean; retracePath?: string }>("trace/run/status", {}, 5_000);
        if (st?.active) {
          if (st.retracePath) e.captures.add(st.retracePath);
          const stopped = await e.box.call<{ index?: { duckdbPath?: string; retracePath?: string } }>("trace/run/stop", { wait_index: false }, 120_000);
          for (const p of [stopped?.index?.retracePath, stopped?.index?.duckdbPath]) if (p) e.captures.add(p);
        }
      } catch { /* the daemon may already be going; shutdown below finishes a recording trace too */ }
      try { await e.box.call("daemon/shutdown", {}, 5_000); } catch { /* it closes the socket as it answers */ }
    }
    await e.box.close();
    const now = Date.now();
    const durationSec = Math.round((now - e.startedMs) / 1000);
    const artefacts = existingFiles(e.captures);
    const info: EndInfo = {
      id: e.id, reason, outcome: reason, summary, endedAt: iso(now), durationSec, purpose: e.rec.purpose, artefacts, recorded: "not recorded",
    };
    e.rec = { ...e.rec, state: "ended", reason, outcome: reason, summary, endedAt: info.endedAt, durationSec, artefacts };
    try { writeJsonAtomic(e.recFile, e.rec); } catch { /* the in-process answer stands */ }
    live.delete(e.id);
    ended.set(e.id, info);
    if (record) {
      info.recorded = await recordOutcome(e.rec.projectDir, info);
      if (info.recorded.startsWith("recorded")) {
        e.rec = { ...e.rec, logged: true };
        try { writeJsonAtomic(e.recFile, e.rec); } catch { /* the answer stands */ }
      }
    }
    return info;
  })();
  return e.finishing;
}

async function recordOutcome(projectDir: string, i: EndInfo): Promise<string> {
  try {
    const { recordAgentStepFromCode } = await import("../server-tools/agent-workflow.js");
    const line = `Sandbox session ${i.id} ended (${i.outcome}) after ${i.durationSec}s — purpose: ${i.purpose}` +
      (i.summary ? ` — ${i.summary}` : "") + (i.artefacts.length ? ` — kept: ${i.artefacts.join(", ")}` : "");
    recordAgentStepFromCode(projectDir, line);
    return `recorded in the step log of ${projectDir}`;
  } catch (e) {
    return `not recorded in a step log (${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * A session that ended without its owner saying so (the keeper ended it on the budget, or because the owner
 * died) has its outcome in the record but not in the project's step log: the keeper is a few lines of node
 * and the log is the product's. The next process that looks at the record writes it, once. Returns the
 * record as it stands afterwards.
 */
async function reconcileRecord(rec: SandboxRecord): Promise<SandboxRecord> {
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

/** What the ledger holds for an id, after any outcome the owner could not log is logged. */
async function readRecord(id: string): Promise<SandboxRecord | undefined> {
  const rec = readJson<SandboxRecord>(recordFile(id));
  return rec ? reconcileRecord(rec) : undefined;
}

/** `runtime_sandbox_end`: the owner says the purpose was reached or failed. Idempotent for an ended id. */
export async function endSandboxSession(id: string, outcome: "reached" | "failed", summary: string): Promise<EndInfo> {
  const e = live.get(id);
  if (!e) {
    const prior = ended.get(id);
    if (prior) return prior;
    throw await lookupError(id);
  }
  return finish(e, outcome, summary);
}

export interface SandboxRow {
  id: string;
  purpose: string;
  port: number;
  deadline: string;
  idleSeconds: number;
  idleLimitMinutes: number;
  projectDir: string;
}

/** This process's own live sessions — a sandbox is invisible to every other. */
export function listSandboxSessions(): SandboxRow[] {
  return [...live.values()].map((e) => ({
    id: e.id, purpose: e.rec.purpose, port: e.rec.port, deadline: e.rec.deadline,
    idleSeconds: e.inflight > 0 ? 0 : Math.round((Date.now() - e.lastActivity) / 1000),
    idleLimitMinutes: e.idleMs / 60_000, projectDir: e.rec.projectDir,
  }));
}

export function endedSandboxes(): EndInfo[] { return [...ended.values()]; }

/** The live session of this process, or undefined (does not throw; for a tool that wants the binding). */
export function sandboxBinding(id: string): { projectDir: string; port: number; purpose: string; deadline: string } | undefined {
  const e = live.get(id);
  return e ? { projectDir: e.rec.projectDir, port: e.rec.port, purpose: e.rec.purpose, deadline: e.rec.deadline } : undefined;
}

/** Why an id is not callable: ended (with the reason and the time), not yours, or never was. */
export async function lookupError(id: string): Promise<Error> {
  const prior = ended.get(id);
  if (prior) return new Error(endedMessage(id, prior.reason, prior.endedAt, prior.purpose, prior.summary));
  const rec = await readRecord(id);
  if (!rec) {
    return new Error(`no sandbox session "${id}" — ids come from runtime_sandbox_start, and runtime_sandbox_list shows the ones this MCP process holds.`);
  }
  if (rec.state === "ended") return new Error(endedMessage(id, rec.reason ?? rec.outcome ?? "ended", rec.endedAt ?? "an unknown time", rec.purpose, rec.summary));
  if (rec.ownerPid !== process.pid) {
    if (ownerAlive(rec.ownerPid)) {
      return new Error(
        `not yours: sandbox session ${id} belongs to another MCP process (pid ${rec.ownerPid}, project ${rec.projectDir}, purpose "${rec.purpose}"). ` +
        `A sandbox is private to the process that started it; start one of your own with runtime_sandbox_start.`);
    }
    return new Error(endedMessage(id, "owner gone", rec.endedAt ?? "a time the record does not know (its owner process is gone)", rec.purpose, rec.summary));
  }
  return new Error(endedMessage(id, "runtime exited", rec.endedAt ?? "an unknown time", rec.purpose, rec.summary));
}

function endedMessage(id: string, reason: string, at: string, purpose: string, summary?: string): string {
  return `sandbox session ${id} has ended: ${reason} at ${at} (purpose: ${purpose}${summary ? `; ${summary}` : ""}). ` +
    `What it wrote to the project (captures, snapshots) is kept; start another with runtime_sandbox_start.`;
}

/** Wire methods whose answer names a file the session produced — kept and listed when it ends. */
function noteArtefacts(e: Live, method: string, result: unknown): void {
  const r = result as { outputPath?: string; path?: string; index?: { duckdbPath?: string; retracePath?: string }; retracePath?: string } | null | undefined;
  if (!r || typeof r !== "object") return;
  if (method === "trace/start_domains" && r.outputPath) {
    e.captures.add(r.outputPath);
    if (r.outputPath.endsWith(".duckdb")) e.captures.add(`${r.outputPath.slice(0, -".duckdb".length)}.c64retrace`);
  }
  if (method === "trace/run/stop") for (const p of [r.index?.retracePath, r.index?.duckdbPath]) if (p) e.captures.add(p);
  if ((method === "vsf/save" || method === "snapshot/dump") && r.path) e.captures.add(r.path);
}

/**
 * Route one wire call to a sandbox session. `timeoutMs` defaults to what is left of the budget: a
 * call never gives up before the session itself would have ended.
 */
export async function callSandbox<T = unknown>(
  id: string, method: string, params: Record<string, unknown> = {}, timeoutMs?: number,
): Promise<T> {
  const e = live.get(id);
  if (!e) throw await lookupError(id);
  if (e.finishing) {
    // It is on its way out: the call waits for the end (a second or two) and is answered with it — "ended: <reason> at <time>".
    await e.finishing.catch(() => undefined);
    throw await lookupError(id);
  }
  e.lastActivity = Date.now();
  e.inflight++;
  try {
    const left = Math.min(MAX_CALL_MS, Math.max(5_000, e.startedMs + e.budgetMs - Date.now()));
    const result = await e.box.call<T>(method, params, timeoutMs ?? left);
    noteArtefacts(e, method, result);
    return result;
  } finally {
    e.inflight--;
    e.lastActivity = Date.now();
  }
}

/** A capture path a tool chose for this session (the daemon was told to write it): kept and listed on end. */
export function noteSandboxArtefact(id: string, path: string): void {
  live.get(id)?.captures.add(path);
}

// ── a reader for trace stores while a C64 Ultimate is the selected backend ───────────────────────────
//
// The device has no trace store, so the C64U backend refuses every `trace/*`. Reading a FILE a
// sandbox wrote is not a question for the device. It is served by an emulator of its own: a private
// daemon started on first use, kept for a while, reaped by its keeper like any sandbox.

let reader: { box: SandboxSession; until: number } | undefined;

export async function callTraceReader<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  if (!reader || reader.box.ended || Date.now() > reader.until) {
    if (reader) await reader.box.close().catch(() => undefined);
    const budgetMs = 15 * 60_000;
    const box = await SandboxSession.start({ budgetMs });
    assertNotShared(box.port);
    reader = { box, until: Date.now() + budgetMs - 30_000 };
  }
  return reader.box.call<T>(method, params, timeoutMs ?? 300_000);
}

/** Test seam and process-exit hook: end every live session of this process without waiting for a timer. */
export async function endAllSandboxSessions(reason: EndReason = "owner gone"): Promise<void> {
  await Promise.all([...live.values()].map((e) => finish(e, reason)));
  if (reader) { await reader.box.close().catch(() => undefined); reader = undefined; }
}

export { isSandboxId };
