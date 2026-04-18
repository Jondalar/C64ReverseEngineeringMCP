import { resolve } from "node:path";
import { HeadlessSessionManager } from "./session-manager.js";

const managers = new Map<string, HeadlessSessionManager>();

export function getHeadlessSessionManager(projectDir: string): HeadlessSessionManager {
  const key = resolve(projectDir);
  let manager = managers.get(key);
  if (!manager) {
    manager = new HeadlessSessionManager(key);
    managers.set(key, manager);
  }
  return manager;
}

export function getPreferredHeadlessSessionManager(): HeadlessSessionManager | undefined {
  let fallback: { manager: HeadlessSessionManager; stamp: number } | undefined;
  for (const manager of managers.values()) {
    const status = manager.getStatus();
    if (!status) {
      continue;
    }
    if (status.state === "running") {
      return manager;
    }
    const stampSource = status.startedAt ?? status.createdAt;
    const stamp = stampSource ? Date.parse(stampSource) : 0;
    if (!fallback || stamp > fallback.stamp) {
      fallback = { manager, stamp };
    }
  }
  return fallback?.manager;
}
