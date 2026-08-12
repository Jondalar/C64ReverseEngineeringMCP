// ════════════════════════════════════════════════════════════════════════════
//  DEPRECATED — TypeScript runtime.  THE PRODUCT RUNTIME IS TRX64.
//
//  This file is part of the in-process TS emulator. It is reachable ONLY with
//  C64RE_RUNTIME_TS=1 and is never on the default path: every runtime_* tool,
//  the workspace UI and the MCP surface route to the TRX64 daemon (Spec 771).
//
//  Do not extend it, do not fix forward in it, and do not cite it as current
//  behaviour — "how the runtime works" means TRX64, in ../TRX64.
//  Its remaining job is to be a parity oracle for the port; when that is no
//  longer needed it goes. See DOCTRINE.md.
// ════════════════════════════════════════════════════════════════════════════
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HeadlessSessionWorkspace } from "./types.js";

export function createHeadlessWorkspace(projectDir: string, sessionId = createSessionId()): HeadlessSessionWorkspace {
  const sessionDir = join(projectDir, "analysis", "headless-runtime", sessionId);
  const traceDir = join(sessionDir, "trace");
  const sessionPath = join(sessionDir, "session.json");
  const tracePath = join(traceDir, "runtime-trace.jsonl");
  const summaryPath = join(traceDir, "summary.json");
  const indexPath = join(traceDir, "trace-index.json");
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(tracePath, "", "utf8");
  writeFileSync(summaryPath, "{}\n", "utf8");
  return {
    sessionDir,
    traceDir,
    sessionPath,
    tracePath,
    summaryPath,
    indexPath,
  };
}

function createSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}
