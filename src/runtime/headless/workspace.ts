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
