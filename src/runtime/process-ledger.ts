// Spec 902 D1 — one ledger of everything C64RE starts.
//
// Every process C64RE starts adds <state dir>/processes/<pid>.json when it starts and removes it
// when it ends: the runtime daemon, a sandbox daemon, a C64U bridge, each process of the workspace
// UI, a server a smoke started. The record holds the pid, the OS's start time and the command line
// exactly as the OS reports it — so a pid the OS has handed to something else is never taken for
// the process that was recorded. A record whose pid is gone, or whose pid now belongs to a
// different command, is stale; whoever reads the ledger removes it.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { platformProc, type PlatformProc } from "./platform-proc.js";
import { readJson, removeFile, stateDir, writeJsonAtomic } from "./state-dir.js";

export type ProcessKind = "daemon" | "sandbox" | "bridge" | "ui" | "ui-server" | "ui-dev";
export type StartedBy = "mcp" | "ui" | "cli" | "smoke" | "sandbox";

export interface ProcessRecord {
  v: 1;
  pid: number;
  /** The OS's start time of the process (an equality token, not a date to compute with). */
  start: string;
  /** The command line, as the OS reports it. */
  command: string;
  kind: ProcessKind;
  port?: number;
  project?: string;
  startedBy: StartedBy;
  /** ISO time the record was written. */
  startedAt: string;
  /** A C64U bridge: the device it serves. */
  device?: string;
  /** Set when startedBy is "smoke": the gate step (or npm script) that was running. */
  smoke?: string;
}

export function processesDir(): string { return join(stateDir(), "processes"); }
export function recordFile(pid: number): string { return join(processesDir(), `${pid}.json`); }

/** "smoke" when the gate (or a test) says the whole tree below it is a smoke, else what the caller is. */
export function effectiveStartedBy(declared: StartedBy, env: NodeJS.ProcessEnv = process.env): StartedBy {
  return env.C64RE_STARTED_BY === "smoke" ? "smoke" : declared;
}

/** The environment a child inherits so that ITS records say who started it (a smoke stays a smoke all the way down). */
export function childEnv(declared: StartedBy, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, C64RE_STARTED_BY: effectiveStartedBy(declared, base) };
}

function smokeName(env: NodeJS.ProcessEnv): string | undefined {
  return env.C64RE_GATE_STEP?.trim() || env.npm_lifecycle_event?.trim() || undefined;
}

export interface RegisterInput {
  pid: number;
  kind: ProcessKind;
  port?: number;
  project?: string;
  startedBy: StartedBy;
  device?: string;
}

/**
 * Write the record of a running process. Returns it, or undefined when the OS cannot say who the
 * pid is (then there is nothing safe to record: a record that cannot be matched later would only
 * ever be dropped as stale).
 */
export async function registerProcess(input: RegisterInput, proc: PlatformProc = platformProc, env: NodeJS.ProcessEnv = process.env): Promise<ProcessRecord | undefined> {
  const info = await proc.info(input.pid);
  if (!info) return undefined;
  const startedBy = effectiveStartedBy(input.startedBy, env);
  const rec: ProcessRecord = {
    v: 1, pid: input.pid, start: info.start, command: info.command,
    kind: input.kind, port: input.port, project: input.project, startedBy,
    startedAt: new Date().toISOString(), device: input.device,
    smoke: startedBy === "smoke" ? smokeName(env) : undefined,
  };
  writeJsonAtomic(recordFile(input.pid), JSON.parse(JSON.stringify(rec)));
  return rec;
}

export function unregisterProcess(pid: number): void { removeFile(recordFile(pid)); }

/** Register THIS process and remove the record when it ends. */
export async function registerSelf(input: Omit<RegisterInput, "pid" | "startedBy"> & { startedBy?: StartedBy }): Promise<ProcessRecord | undefined> {
  const declared = input.startedBy ?? ((process.env.C64RE_STARTED_BY as StartedBy | undefined) ?? "cli");
  const rec = await registerProcess({ ...input, pid: process.pid, startedBy: declared });
  if (rec) process.once("exit", () => { try { rmSync(recordFile(process.pid), { force: true }); } catch { /* gone */ } });
  return rec;
}

export type RecordState = "ours" | "gone" | "other";

function readRecord(file: string): ProcessRecord | undefined {
  const r = readJson<ProcessRecord>(file);
  return r && r.v === 1 && Number.isInteger(r.pid) && typeof r.start === "string" && typeof r.command === "string" ? r : undefined;
}

export interface LedgerEntry { record: ProcessRecord; state: RecordState }

/** Every record in the ledger, each checked against the OS (pid, start time, command line). Nothing is removed. */
export async function checkLedger(proc: PlatformProc = platformProc): Promise<LedgerEntry[]> {
  let names: string[] = [];
  try { names = readdirSync(processesDir()).filter((n) => n.endsWith(".json")); } catch { return []; }
  const recs: ProcessRecord[] = [];
  for (const n of names) {
    const r = readRecord(join(processesDir(), n));
    if (r) recs.push(r); else removeFile(join(processesDir(), n)); // not a record: garbage in the ledger
  }
  const infos = await proc.infoMany(recs.map((r) => r.pid));
  return recs.map((record) => {
    const info = infos.get(record.pid);
    const state: RecordState = !info ? "gone" : info.start === record.start && info.command === record.command ? "ours" : "other";
    return { record, state };
  }).sort((a, b) => a.record.pid - b.record.pid);
}

/** The live records; whoever reads the ledger removes the stale ones. */
export async function listProcesses(proc: PlatformProc = platformProc): Promise<ProcessRecord[]> {
  const live: ProcessRecord[] = [];
  for (const e of await checkLedger(proc)) {
    if (e.state === "ours") live.push(e.record);
    else unregisterProcess(e.record.pid);
  }
  return live;
}
