import { resolve } from "node:path";
import { ViceSessionManager } from "./session-manager.js";

const managers = new Map<string, ViceSessionManager>();

export function getViceSessionManager(projectDir: string): ViceSessionManager {
  const key = resolve(projectDir);
  let manager = managers.get(key);
  if (!manager) {
    manager = new ViceSessionManager(key);
    managers.set(key, manager);
  }
  return manager;
}

export async function getPreferredViceSessionManager(): Promise<ViceSessionManager | undefined> {
  let fallback: { manager: ViceSessionManager; stamp: number } | undefined;
  for (const manager of managers.values()) {
    try {
      const status = await manager.getStatus();
      if (!status) {
        continue;
      }
      if (status.state === "running" || status.state === "starting" || status.state === "stopping") {
        return manager;
      }
      const stampSource = status.stoppedAt ?? status.startedAt ?? status.createdAt;
      const stamp = stampSource ? Date.parse(stampSource) : 0;
      if (!fallback || stamp > fallback.stamp) {
        fallback = { manager, stamp };
      }
    } catch {
      // Ignore broken managers and keep looking for a usable session handle.
    }
  }
  return fallback?.manager;
}
