// Spec 889 §11/§12 — the machine-wide state the C64U bridge and its clients share.
//
// Two small files under one directory (`C64RE_STATE_DIR`, else `~/.c64re`), nothing else:
//
//   runtime-selection.json            which runtime this machine's C64RE processes (MCP servers, the
//                                     workbench) reach: the emulator, or a C64U bridge's endpoint.
//   c64u-bridges/<host>_<rest>.json   the bridge that serves one device: port, pid. The registry a
//                                     second start finds the running bridge by.
//
// No secret ever goes in either file (the REST password lives in memory only).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.C64RE_STATE_DIR?.trim();
  return d ? d : join(homedir(), ".c64re");
}

export function selectionFile(): string { return join(stateDir(), "runtime-selection.json"); }
export function bridgeRegistryDir(): string { return join(stateDir(), "c64u-bridges"); }
export const deviceKey = (host: string, restPort: number): string => `${host}_${restPort}`;
export function bridgeRegistryFile(host: string, restPort: number): string {
  return join(bridgeRegistryDir(), `${deviceKey(host, restPort).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}
export function bridgeLogFile(host: string, restPort: number): string {
  return join(bridgeRegistryDir(), `${deviceKey(host, restPort).replace(/[^A-Za-z0-9._-]/g, "_")}.log`);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined; }
  catch { return undefined; }
}

export function removeFile(path: string): void { try { rmSync(path, { force: true }); } catch { /* gone */ } }

/** Is a process with this pid alive on this machine (a signal-0 probe; EPERM = alive, not ours)? */
export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// ---- the registry entry of a running bridge -----------------------------------------------------

export interface BridgeRegistryEntry {
  host: string;
  restPort: number;
  port: number;
  endpoint: string;
  pid: number;
  startedAt: string;
}

export function readBridgeEntry(host: string, restPort: number): BridgeRegistryEntry | undefined {
  const e = readJson<BridgeRegistryEntry>(bridgeRegistryFile(host, restPort));
  return e && typeof e.port === "number" && typeof e.pid === "number" ? e : undefined;
}

// ---- the shared selection -------------------------------------------------------------------------

export interface SelectionRecord {
  v: 1;
  /** Strictly increasing: a reader that sees a higher number than its own knows a switch happened. */
  seq: number;
  kind: "emulator" | "c64u";
  at: string;
  /** Who switched: "<role>:<pid>". */
  by: string;
  /** C64U only. */
  device?: { host: string; restPort: number };
  endpoint?: string;
  bridgePid?: number;
  /** What a respawn of the bridge needs; never a secret. */
  config?: { rpcPort?: number; trxmonPath?: string; paused?: boolean };
}

export function readSelection(): SelectionRecord | undefined {
  const r = readJson<SelectionRecord>(selectionFile());
  if (!r || (r.kind !== "emulator" && r.kind !== "c64u")) return undefined;
  if (r.kind === "c64u" && (!r.endpoint || !r.device)) return undefined;
  return r;
}

export function writeSelection(rec: Omit<SelectionRecord, "v" | "seq" | "at"> & { seq?: number }): SelectionRecord {
  const prev = readSelection();
  const full: SelectionRecord = { ...rec, v: 1, seq: Math.max(prev?.seq ?? 0, rec.seq ?? 0) + 1, at: new Date().toISOString() };
  writeJsonAtomic(selectionFile(), full);
  return full;
}
