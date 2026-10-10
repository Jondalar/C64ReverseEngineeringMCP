// The machine-wide state directory (`C64RE_STATE_DIR`, else `~/.c64re`) and the small file helpers
// everything under it uses: the runtime selection and the bridge registry (c64u-bridge/state.ts),
// the process ledger and the hold (Spec 902).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.C64RE_STATE_DIR?.trim();
  return d ? d : join(homedir(), ".c64re");
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined; }
  catch { return undefined; }
}

export function removeFile(path: string): void { try { rmSync(path, { force: true }); } catch { /* gone */ } }
