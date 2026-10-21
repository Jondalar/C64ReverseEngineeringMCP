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

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SandboxSession } from "../reel/sandbox-session.js";
import { assertNotShared } from "../reel/shared-port.js";
import { bootSandbox, mountMedium, ejectDisk, type BootOptions } from "../reel/session-boot.js";
import { describeMachine, type MachineIdentity } from "./machine-model.js";
import { isSandboxId } from "./sandbox-parity.js";
import { readJson, removeFile, writeJsonAtomic } from "./state-dir.js";
import {
  endSandbox, existingFiles, iso, recordFile, recordsDir, recordOutcome, reconcileRecord,
  type EndInfo, type EndReason, type SandboxRecord,
} from "./sandbox-end.js";
import type { DriveBoard } from "../reel/drive-board.js";

export type { EndInfo, EndReason, SandboxRecord };
export { recordsDir };

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
  /** A script over this lifecycle (a one-shot run, a reel, a search): not listed, not counted against the limit, not ended by a tool. */
  script: boolean;
  finishing?: Promise<EndInfo>;
  endingReason?: EndReason;
}

const live = new Map<string, Live>();
const ended = new Map<string, EndInfo>();
/** Ids of the sandboxes that were scripts over the lifecycle: they are not listed. */
const scripts = new Set<string>();

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
  /** Where the daemon keeps its project (default: the sandbox's own temp dir). */
  daemonProjectDir?: string;
  /**
   * A script over this lifecycle — a one-shot run, a reel, a state-map search, a cost capture: the same daemon, boot,
   * calls and end as a session, but not listed, not counted against the limit, and ended by the script, not by a tool.
   */
  script?: boolean;
  /** How the machine is brought up; see `BootOptions`. The medium, the run address and the drive come from the fields above. */
  boot?: Pick<BootOptions, "mode" | "mountVia" | "startExactly" | "needs" | "verifyMachine">;
}

export interface StartedSandbox {
  id: string;
  port: number;
  deadline: string;
  idleMinutes: number;
  machine: string;
  /** The machine as the boot left it. */
  identity: MachineIdentity;
  log: string[];
  cycle: number;
  pc: number;
  projectDir: string;
  /** The medium the sandbox was started with: it is mounted from a copy the daemon made in its scratch. */
  media?: string;
  /** Set when the runtime latched the machine as an instruction exerciser (no VIC, no CIAs, no drive). */
  coreOnly?: string;
}

/** The refusal for the 5th live session: names the four and their purposes. */
function tooMany(): Error {
  const rows = [...live.values()].filter((e) => !e.script).map((e) => `  ${e.id} — ${e.rec.purpose} (until ${e.rec.deadline})`);
  return new Error(
    `runtime_sandbox_start: this MCP process already holds ${MAX_LIVE_SESSIONS} sandbox sessions (a port and a core each):\n${rows.join("\n")}\n` +
    `End one with runtime_sandbox_end { session_id, outcome, summary } when its purpose is reached or failed. Nothing was started.`);
}

/** Start a sandbox session: daemon, boot, medium in, record written, timers armed. */
export async function startSandboxSession(o: StartSandboxOptions): Promise<StartedSandbox> {
  const script = o.script === true;
  if (!script && [...live.values()].filter((e) => !e.script).length >= MAX_LIVE_SESSIONS) throw tooMany();
  if (!script) { pruneOldRecords(); await sweepUnlogged(); }
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
      budgetMs: budgetMs + REAPER_TRAIL_MS, model: o.model, recordFile: recFile, projectDir: o.daemonProjectDir,
      onExit: (why) => { if (entry) void finish(entry, "runtime exited", why); },
    });
  } catch (e) {
    removeFile(recFile);
    throw e;
  }
  entry = {
    id, box, rec: { ...rec, port: box.port }, recFile, startedMs, budgetMs, idleMs,
    lastActivity: Date.now(), inflight: 0, captures: new Set(), script,
  };
  writeJsonAtomic(recFile, entry.rec);
  live.set(id, entry);
  if (script) scripts.add(id);
  try {
    assertNotShared(box.port);
    // The medium is handed to the daemon by its own path: the daemon was started with `--scratch`, opens it from a
    // copy in its scratch dir and writes only the copy (Spec 910 D1/D2), through whatever door a medium later takes.
    if (o.mediaPath) {
      // the image hash names the cartridge a later trace import files its nodes under
      entry.rec.mediaSha256 = createHash("sha256").update(readFileSync(o.mediaPath)).digest("hex");
      writeJsonAtomic(recFile, entry.rec);
    }
    const booted = await bootSandbox(box.call.bind(box) as Parameters<typeof bootSandbox>[0], {
      ...o.boot, mediaPath: o.mediaPath, run: o.run, driveType: o.driveType,
    });
    armTimers(entry);
    return {
      id, port: box.port, deadline: entry.rec.deadline, idleMinutes: idleMs / 60_000,
      machine: describeMachine(booted.machine), identity: booted.machine, log: booted.log, cycle: booted.cycle, pc: booted.pc,
      projectDir: o.projectDir, media: o.mediaPath, ...(booted.coreOnly ? { coreOnly: booted.coreOnly } : {}),
    };
  } catch (e) {
    await finish(entry, "failed", `could not start: ${e instanceof Error ? e.message : String(e)}`, !script);
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

/**
 * End a session — the one end (Spec 910 D5, `endSandbox` of `sandbox-end.ts`): finalize a trace, record the outcome,
 * stop the daemon, remove the scratch. Every reason and every caller takes these steps in this order; the keeper's
 * owner-gone and budget ends run the same function.
 */
async function finish(e: Live, reason: EndReason, summary?: string, record = true): Promise<EndInfo> {
  if (e.finishing) return e.finishing;
  e.endingReason = reason;
  e.finishing = (async () => {
    if (e.budgetTimer) clearTimeout(e.budgetTimer);
    if (e.idleTimer) clearTimeout(e.idleTimer);
    let info!: EndInfo;
    const steps = await endSandbox({
      // A daemon that exited by itself cannot be asked anything; for every other reason it is up.
      call: reason === "runtime exited" ? undefined : (m, p, t) => e.box.call(m, p, t),
      captures: e.captures,
      scratchDir: null,
      record: async () => {
        const now = Date.now();
        const durationSec = Math.round((now - e.startedMs) / 1000);
        const artefacts = existingFiles(e.captures);
        info = {
          id: e.id, reason, outcome: reason, summary, endedAt: iso(now), durationSec, purpose: e.rec.purpose, artefacts, recorded: "not recorded",
        };
        e.rec = { ...e.rec, state: "ended", reason, outcome: reason, summary, endedAt: info.endedAt, durationSec, artefacts };
        try { writeJsonAtomic(e.recFile, e.rec); } catch { /* the in-process answer stands */ }
        if (record) {
          info.recorded = await recordOutcome(e.rec.projectDir, info);
          if (info.recorded.startsWith("recorded")) {
            e.rec = { ...e.rec, logged: true };
            try { writeJsonAtomic(e.recFile, e.rec); } catch { /* the answer stands */ }
          }
        }
      },
      stop: async () => {
        if (reason !== "runtime exited") { try { await e.box.call("daemon/shutdown", {}, 5_000); } catch { /* it closes the socket as it answers */ } }
        await e.box.stop();
      },
    });
    // The scratch goes after the daemon is down (see sandbox-end.ts), with the temp dir that holds `--scratch`.
    e.box.removeScratch();
    info ??= {
      id: e.id, reason, outcome: reason, summary, endedAt: iso(Date.now()), durationSec: Math.round((Date.now() - e.startedMs) / 1000),
      purpose: e.rec.purpose, artefacts: existingFiles(e.captures), recorded: "not recorded",
    };
    const failedSteps = steps.failed.map((f) => `${f.step}: ${f.error}`);
    if (failedSteps.length) info.recorded += ` (end steps that failed: ${failedSteps.join("; ")})`;
    live.delete(e.id);
    ended.set(e.id, info);
    return info;
  })();
  return e.finishing;
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
  return [...live.values()].filter((e) => !e.script).map((e) => ({
    id: e.id, purpose: e.rec.purpose, port: e.rec.port, deadline: e.rec.deadline,
    idleSeconds: e.inflight > 0 ? 0 : Math.round((Date.now() - e.lastActivity) / 1000),
    idleLimitMinutes: e.idleMs / 60_000, projectDir: e.rec.projectDir,
  }));
}

export function endedSandboxes(): EndInfo[] { return [...ended.values()].filter((i) => !scripts.has(i.id)); }

/** The live session of this process, or undefined (does not throw; for a tool that wants the binding). */
export function sandboxBinding(id: string): { projectDir: string; port: number; purpose: string; deadline: string; media?: string; mediaSha256?: string } | undefined {
  const e = live.get(id);
  return e ? { projectDir: e.rec.projectDir, port: e.rec.port, purpose: e.rec.purpose, deadline: e.rec.deadline, media: e.rec.media, mediaSha256: e.rec.mediaSha256 } : undefined;
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

// ── what a script over the lifecycle needs besides `callSandbox` ──────────────────────────────────

/** A call bound to one sandbox: the shape every client of a daemon in this repo takes. */
export function sandboxCall(id: string): <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T> {
  return <T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => callSandbox<T>(id, method, params, timeoutMs);
}

/**
 * Put a medium into a running sandbox — the one door a script mounts through (a reel's or a run's `insert` step). The
 * daemon copies it into its scratch; the machine is left stopped (a door that runs it is passed with a stop armed).
 */
export async function mountSandboxMedium(id: string, path: string, via: "open" | "mount", log: string[]): Promise<{ parked: boolean }> {
  const e = live.get(id);
  if (!e) throw await lookupError(id);
  const call = sandboxCall(id) as Parameters<typeof mountMedium>[0];
  const r = await mountMedium(call, path, via, log);
  if (!r.parked) log.push("NOTE: the machine ran on past the stops armed for the medium, so the clock after this is not reproducible");
  return r;
}

/** Take the disk out of drive 8. */
export async function ejectSandboxDisk(id: string): Promise<void> {
  await ejectDisk(sandboxCall(id) as Parameters<typeof ejectDisk>[0]);
}

/** Why a sandbox ended on its own (its budget, its daemon exiting), or null while it lives or when a caller ended it. */
export function sandboxEndedBecause(id: string): string | null {
  const i = ended.get(id);
  return i && (i.reason === "budget" || i.reason === "runtime exited" || i.reason === "idle" || i.reason === "owner gone")
    ? `${i.reason}${i.summary ? `: ${i.summary}` : ""}` : null;
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
